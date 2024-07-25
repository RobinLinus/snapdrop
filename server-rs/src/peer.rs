use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use futures_util::stream::SplitSink;
use lazy_static::lazy_static;
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use uaparser::{Parser, UserAgentParser};

type Socket = SplitSink<WebSocketStream<TcpStream>, Message>;

lazy_static! {
    static ref UA_PARSER: UserAgentParser =
        // TODO download at compile time?
        UserAgentParser::from_bytes(include_bytes!("../regexes.yaml")).expect("Parser creation failed");
}

pub(crate) struct Peer {
    socket: Socket,

    name: Name,
    ip: SocketAddr,

    rtc_supported: bool,
    // timer_task: tokio::task::JoinHandle<_> ,

    // last_beat: ,
}

struct Name {
    model: Option<String>,
    os: String,
    browser: String,
    type_: String,
    device_name: String,
    display_name: String,
}

impl Peer {
    pub(crate) fn new(
        socket: Socket,
        peer_addr: SocketAddr,
        x_forwarded_for: Option<String>,
        user_agent: String,
        webrtc: bool,
    ) -> Peer {
        let mut ip = x_forwarded_for.and_then(|s| s.parse().ok()).unwrap_or(peer_addr);

        // TODO check ip addresses for differently represented localhost addresses
        if ip.is_ipv6() && ip.ip().eq(&IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1))) {
            ip.set_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)));
        }

        Peer {
            socket,
            name: Name::new(user_agent),
            ip,
            rtc_supported: webrtc,
        }
    }

    pub(crate) async fn keep_alive_timer(&self) {}
}

impl Name {
    pub(crate) fn new(user_agent: String) -> Name {
        let ua = UA_PARSER.parse(&user_agent);

        let mut device_name = ua.os.family.replace("Mac Os", "Mac");
        device_name.push(' ');

        if let Some(model) = ua.device.model.clone() {
            device_name.push_str(&model);
        } else {
            device_name.push_str(ua.user_agent.family.as_ref());
        }

        Name {
            model: ua.device.model.map(|m| m.to_string()),
            os: ua.os.family.to_string(),
            browser: ua.user_agent.family.to_string(),
            type_: ua.device.family.to_string(),

            device_name,
            display_name: "".to_string(), // TODO search for random name generator
        }
    }
}
