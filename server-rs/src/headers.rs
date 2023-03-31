use std::str::FromStr;

use tokio_tungstenite::tungstenite::{
    handshake::server::{Request, Response},
    http::{HeaderValue, Response as HttpResponse},
};
use uuid::Uuid;

/// This is a callback for the `tungstenite::accept_hdr` function that extracts all information we need.
pub(crate) fn callback(
    request: &Request,
    mut response: Response,
    peer_id: &mut Option<Uuid>,
    user_agent: &mut Option<String>,
    x_forwarded_for: &mut Option<String>,
    webrtc: &mut bool,
) -> Result<Response, HttpResponse<Option<String>>> {
    let headers = response.headers_mut();

    // get peer id from cookie or create a new random UUID
    if let Some(cookie) = request.headers().get("cookie") {
        if let Ok(cookie_str) = cookie.to_str() {
            // check if cookie contains the string "peerid=" before making a potentially costly computation
            if cookie_str.contains("peerid=") {
                *peer_id = cookie_str
                    .split(';')
                    .into_iter()
                    .filter_map(|s| {
                        if s.contains("peerid=") {
                            s.split('=').nth(1).and_then(|u| Uuid::from_str(u).ok())
                        } else {
                            None
                        }
                    })
                    .next();
            }
        }
    }

    if peer_id.is_none() {
        *peer_id = Some(uuid::Uuid::new_v4());
        let new_cookie = format!("peerid={}; SameSite=Strict; Secure", peer_id.unwrap());
        headers.append("Set-Cookie", new_cookie.parse().unwrap());
    }

    // get user-agent and x-forwarded-for from headers
    *user_agent = headers.get("user-agent").and_then(header_value_to_string);
    *x_forwarded_for = headers.get("x-forwarded-for").and_then(header_value_to_string);

    // get url from request
    *webrtc = request.uri().path_and_query().unwrap().as_str().contains("webrtc");

    Ok(response)
}

#[inline]
fn header_value_to_string(value: &HeaderValue) -> Option<String> {
    value.to_str().map(|ua| ua.to_string()).ok()
}
