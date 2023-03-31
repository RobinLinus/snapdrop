mod error;
mod headers;
mod peer;

use std::{
    collections::BTreeMap,
    env,
    io::Error,
    net::SocketAddr,
    sync::{Arc, RwLock},
};

use futures_util::StreamExt;
use lazy_static::lazy_static;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::{client::Request, server::Response};
use tracing::info;

use crate::peer::Peer;

lazy_static! {
    static ref ROOMS: Arc<RwLock<BTreeMap<SocketAddr, BTreeMap<SocketAddr, Peer>>>> =
        Arc::new(RwLock::new(BTreeMap::new()));
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let addr = env::args().nth(1).unwrap_or_else(|| "127.0.0.1:8080".to_string());

    let try_socket = TcpListener::bind(&addr).await;
    let listener = try_socket.expect("Failed to bind");
    info!("Listening on: {}", addr);

    while let Ok((stream, peer_addr)) = listener.accept().await {
        tokio::spawn(accept_connection(stream, peer_addr));
    }

    Ok(())
}

/// Extract all information needed from handshake, create and insert Peer into map and launch new tasks for listening
/// for new messages from this peer and to send heartbeats to it.
async fn accept_connection(stream: TcpStream, peer_addr: SocketAddr) -> anyhow::Result<()> {
    let mut peer_id = None;
    let mut user_agent = None;
    let mut x_forwarded_for = None;
    let mut webrtc = false;

    let ws_stream = tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response: Response| {
        headers::callback(
            request,
            response,
            &mut peer_id,
            &mut user_agent,
            &mut x_forwarded_for,
            &mut webrtc,
        )
    })
    .await?;

    info!("New WebSocket connection: {}", peer_addr);

    let (write, read) = ws_stream.split();

    let peer = Peer::new(
        write,
        peer_addr,
        x_forwarded_for,
        user_agent.ok_or(error::SnapdropError::ClientNoUserAgent)?,
        webrtc,
    );

    // TODO spawn read task

    peer.keep_alive_timer().await;

    Ok(())
}
