mod hub;
mod names;
mod protocol;

use axum::{
    Router,
    extract::{
        ConnectInfo, State, WebSocketUpgrade,
        ws::{CloseFrame, Message as Frame, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use hub::{Hub, Outbox, Peer};
use ipnet::IpNet;
use std::{
    env,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, mpsc, watch};
use uuid::Uuid;

struct Config {
    bind: SocketAddr,
    trusted_proxies: Vec<IpNet>,
    max_connections: usize,
    max_room: usize,
}
impl Config {
    fn from_env() -> Result<Self, String> {
        fn number(key: &str, default: usize, max: usize) -> Result<usize, String> {
            let value = env::var(key)
                .unwrap_or_else(|_| default.to_string())
                .parse::<usize>()
                .map_err(|_| format!("invalid {key}"))?;
            if value == 0 || value > max {
                return Err(format!("{key} must be between 1 and {max}"));
            }
            Ok(value)
        }
        let host = env::var("HOST")
            .unwrap_or_else(|_| "127.0.0.1".into())
            .parse::<IpAddr>()
            .map_err(|_| "HOST must be an IP address")?;
        let port = env::var("PORT")
            .unwrap_or_else(|_| "3000".into())
            .parse::<u16>()
            .map_err(|_| "invalid PORT")?;
        let proxies = env::var("TRUSTED_PROXIES").unwrap_or_else(|_| "127.0.0.1/32,::1/128".into());
        let trusted_proxies = proxies
            .split(',')
            .filter(|s| !s.trim().is_empty())
            .map(|s| {
                s.trim()
                    .parse::<IpNet>()
                    .map_err(|_| "invalid TRUSTED_PROXIES CIDR".to_string())
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            bind: SocketAddr::new(host, port),
            trusted_proxies,
            max_connections: number("MAX_CONNECTIONS", 10000, 100000)?,
            max_room: number("MAX_ROOM_CONNECTIONS", 256, 512)?,
        })
    }
}

struct App {
    hub: Hub,
    config: Config,
    slots: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
}

fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        other => other,
    }
}

fn room_ip(remote: IpAddr, headers: &HeaderMap, trusted: &[IpNet]) -> Result<IpAddr, StatusCode> {
    let remote = normalize(remote);
    if trusted.iter().any(|net| net.contains(&remote)) {
        if let Some(value) = headers.get("x-forwarded-for") {
            let value = value.to_str().map_err(|_| StatusCode::BAD_REQUEST)?;
            return value
                .split(',')
                .next()
                .unwrap_or("")
                .trim()
                .parse::<IpAddr>()
                .map(normalize)
                .map_err(|_| StatusCode::BAD_REQUEST);
        }
    }
    Ok(remote)
}

fn cookie_id(headers: &HeaderMap) -> Option<Uuid> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|cookie| {
            let (name, value) = cookie.trim().split_once('=')?;
            if name != "peerid" || value.len() != 36 {
                return None;
            }
            Uuid::parse_str(value).ok().filter(|id| !id.is_nil())
        })
}

async fn upgrade(
    State(app): State<Arc<App>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    let room = match room_ip(remote.ip(), &headers, &app.config.trusted_proxies) {
        Ok(ip) => ip,
        Err(code) => return code.into_response(),
    };
    let permit = match app.slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    if *app.shutdown.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let existing_id = cookie_id(&headers);
    let id = existing_id.unwrap_or_else(Uuid::new_v4);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ua.len() > 2048 {
        return StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE.into_response();
    }
    let ua = ua.to_owned();
    let rtc = uri.path().ends_with("/webrtc");
    let secure = app
        .config
        .trusted_proxies
        .iter()
        .any(|net| net.contains(&normalize(remote.ip())))
        && headers
            .get("x-forwarded-proto")
            .is_some_and(|v| v == "https");
    let ws = ws
        .read_buffer_size(4096)
        .write_buffer_size(0)
        .max_write_buffer_size(protocol::MAX_MESSAGE * 2)
        .max_frame_size(protocol::MAX_MESSAGE)
        .max_message_size(protocol::MAX_MESSAGE);
    let mut response = ws.on_upgrade(move |socket| async move {
        let _permit = permit;
        connection(socket, app, room, id, rtc, ua).await;
    });
    if existing_id.is_none() {
        // UUID formatting is safe for an HTTP header. Path applies to every app route.
        let cookie = format!(
            "peerid={id}; Path=/; SameSite=Strict; HttpOnly{}",
            if secure { "; Secure" } else { "" }
        );
        response
            .headers_mut()
            .append(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    }
    response
}

async fn connection(
    mut socket: WebSocket,
    app: Arc<App>,
    ip: IpAddr,
    id: Uuid,
    rtc: bool,
    ua: String,
) {
    let (tx, mut rx) = mpsc::channel(32);
    let (close, mut closed) = watch::channel(false);
    let queued = Arc::new(AtomicUsize::new(0));
    let out = Outbox {
        tx,
        close,
        queued: queued.clone(),
    };
    let (peer, label) = Peer::new(id, rtc, &ua, out.clone());
    let connection_id = peer.connection;
    let room = match app.hub.join(ip, peer, label, app.config.max_room) {
        Ok(room) => room,
        Err(_) => {
            close_socket(&mut socket, 1008, "Room connection limit").await;
            return;
        }
    };
    let mut shutdown = app.shutdown.subscribe();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_beat = Instant::now();
    let mut last_ping = Instant::now();
    let mut rate_time = Instant::now();
    let mut tokens = 200.0_f64;
    let mut close_code = 1001;
    loop {
        if *closed.borrow() || *shutdown.borrow() {
            break;
        }
        tokio::select! {
            _ = closed.changed() => break,
            _ = shutdown.changed() => break,
            Some(outgoing) = rx.recv() => {
                queued.fetch_sub(outgoing.bytes,Ordering::Relaxed);
                if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(outgoing.frame)).await,Ok(Ok(()))) { break; }
            },
            _ = tick.tick() => {
                if last_beat.elapsed() >= Duration::from_secs(60) { break; }
                if last_ping.elapsed() >= Duration::from_secs(30) {
                    if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Frame::Ping(Vec::new().into()))).await,Ok(Ok(()))) { break; }
                    last_ping = Instant::now();
                }
            },
            incoming = socket.recv() => {
                let Some(Ok(frame)) = incoming else { break; };
                tokens = (tokens + rate_time.elapsed().as_secs_f64() * 100.0).min(200.0);
                rate_time = Instant::now();
                if tokens < 1.0 { close_code = 1008; break; }
                tokens -= 1.0;
                let message = match frame {
                    Frame::Binary(bytes) => protocol::decode(&bytes),
                    Frame::Close(_) => break,
                    Frame::Pong(_) => { last_beat = Instant::now(); continue; },
                    Frame::Ping(bytes) => {
                        if !matches!(tokio::time::timeout(Duration::from_secs(5),socket.send(Frame::Pong(bytes))).await,Ok(Ok(()))) { break; }
                        continue;
                    },
                    _ => Err("unexpected frame format"),
                };
                let message = match message { Ok(message) => message, Err(_) => { close_code = 1008; break; } };
                room.lock().unwrap().relay(connection_id,message);
            }
        }
    }
    out.stop();
    app.hub.leave(ip, connection_id);
    close_socket(
        &mut socket,
        close_code,
        if close_code == 1008 {
            "Invalid message or resource limit"
        } else {
            "Connection closed"
        },
    )
    .await;
}

async fn close_socket(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        socket
            .send(Frame::Close(Some(CloseFrame {
                code,
                reason: reason.into(),
            })))
            .await?;
        // Drain the close handshake so unread frames do not reset the TCP socket.
        while let Some(Ok(frame)) = socket.recv().await {
            if matches!(frame, Frame::Close(_)) {
                break;
            }
        }
        Ok::<(), axum::Error>(())
    })
    .await;
}

async fn ready(State(app): State<Arc<App>>) -> StatusCode {
    if *app.shutdown.borrow() || app.slots.available_permits() == 0 {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env().map_err(std::io::Error::other)?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    let (shutdown, _) = watch::channel(false);
    let slots = Arc::new(Semaphore::new(config.max_connections));
    let app = Arc::new(App {
        hub: Hub::default(),
        config,
        slots,
        shutdown,
    });
    let router = Router::new()
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/readyz", get(ready))
        .route("/server", get(upgrade))
        .route("/server/webrtc", get(upgrade))
        .route("/server/fallback", get(upgrade))
        .route("/webrtc", get(upgrade))
        .route("/fallback", get(upgrade))
        .with_state(app.clone());
    println!("Snapdrop listening on {}", listener.local_addr()?);
    let shutting_down = app.clone();
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        shutting_down.shutdown.send_replace(true);
    })
    .await?;
    let _ = tokio::time::timeout(
        Duration::from_secs(6),
        app.slots
            .clone()
            .acquire_many_owned(app.config.max_connections as u32),
    )
    .await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_trusted_proxies_can_assign_rooms() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static("192.0.2.1"));
        let proxies = vec!["127.0.0.1/32".parse().unwrap()];
        assert_eq!(
            room_ip("127.0.0.1".parse().unwrap(), &h, &proxies)
                .unwrap()
                .to_string(),
            "192.0.2.1"
        );
        assert_eq!(
            room_ip("192.0.2.2".parse().unwrap(), &h, &proxies)
                .unwrap()
                .to_string(),
            "192.0.2.2"
        );
        h.insert("x-forwarded-for", HeaderValue::from_static("not an IP"));
        assert!(room_ip("127.0.0.1".parse().unwrap(), &h, &proxies).is_err());
    }
    #[test]
    fn cookie_parsing_ignores_other_cookies_and_invalid_ids() {
        let mut h = HeaderMap::new();
        let id = Uuid::new_v4();
        h.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("other=value; peerid={id}; more=yes")).unwrap(),
        );
        assert_eq!(cookie_id(&h), Some(id));
        h.insert(header::COOKIE, HeaderValue::from_static("peerid=invalid"));
        assert!(cookie_id(&h).is_none());
    }
}
