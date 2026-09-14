//! MessagePack envelopes via Serde. Payloads belong to the browsers, not the relay.
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::io::Cursor;
use uuid::Uuid;

pub const MAX_MESSAGE: usize = 64 * 1024;
pub const MAX_PAYLOAD: usize = 60 * 1024;

// Serde's compact representation is [recipient, binary payload].
#[derive(Debug, Serialize, Deserialize)]
pub struct Relay {
    pub recipient: Uuid,
    pub payload: ByteBuf,
}

#[derive(Clone, Debug)]
pub struct Name {
    pub kind: String,
    pub device_name: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PeerInfo {
    pub id: Uuid,
    pub connection: Uuid,
    pub display_name: String,
    pub icon: u8,
    pub rtc: bool,
}

#[derive(Debug, Serialize)]
pub enum Message {
    #[serde(rename = "i")]
    Identity(Uuid, Uuid, String, String),
    #[serde(rename = "p")]
    Peers(Vec<PeerInfo>),
    #[serde(rename = "j")]
    Joined(PeerInfo),
    #[serde(rename = "u")]
    Updated(PeerInfo, Option<Uuid>),
    #[serde(rename = "l")]
    Left(Uuid),
    #[serde(rename = "r")]
    Relay(Uuid, Uuid, ByteBuf),
}

pub fn decode(bytes: &[u8]) -> Result<Relay, &'static str> {
    if bytes.len() > MAX_MESSAGE {
        return Err("message too large");
    }
    let mut decoder = rmp_serde::Deserializer::new(Cursor::new(bytes));
    decoder.set_max_depth(4);
    let relay = Relay::deserialize(&mut decoder).map_err(|_| "invalid envelope")?;
    if decoder.position() as usize != bytes.len()
        || relay.recipient.is_nil()
        || relay.payload.is_empty()
        || relay.payload.len() > MAX_PAYLOAD
    {
        return Err("invalid envelope");
    }
    Ok(relay)
}

pub fn encode(message: &Message) -> Result<Vec<u8>, &'static str> {
    let bytes = rmp_serde::to_vec(message).map_err(|_| "encoding failed")?;
    if bytes.len() > MAX_MESSAGE {
        return Err("message too large");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payload_is_opaque_even_when_not_valid_msgpack_or_utf8() {
        let input = Relay {
            recipient: Uuid::new_v4(),
            payload: ByteBuf::from(vec![0xc1, 0xff, 0x00]),
        };
        let bytes = rmp_serde::to_vec(&input).unwrap();
        let decoded = decode(&bytes).unwrap();
        assert_eq!(decoded.recipient, input.recipient);
        assert_eq!(decoded.payload, input.payload);
        for end in 0..bytes.len() {
            assert!(decode(&bytes[..end]).is_err());
        }
        let mut extra = bytes;
        extra.push(0);
        assert!(decode(&extra).is_err());
    }
    #[test]
    fn envelope_size_and_identity_are_bounded() {
        for input in [
            Relay {
                recipient: Uuid::nil(),
                payload: ByteBuf::from(vec![1]),
            },
            Relay {
                recipient: Uuid::new_v4(),
                payload: ByteBuf::from(vec![0; MAX_PAYLOAD + 1]),
            },
        ] {
            assert!(decode(&rmp_serde::to_vec(&input).unwrap()).is_err());
        }
        // An enormous declared binary size with no body must fail without a huge allocation.
        assert!(decode(&[0x92, 0xc6, 0xff, 0xff, 0xff, 0xff]).is_err());
    }
}
