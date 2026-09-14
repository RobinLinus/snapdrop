# WebSocket protocol

All application frames are binary MessagePack. Rust uses Serde with `rmp-serde`;
the browser uses `@msgpack/msgpack`. There is no protocol version or custom codec.
WebSocket ping, pong and close use native control frames.

A client sends `[recipient, payload]`. The recipient is a connection UUID encoded
as 16 binary bytes. The payload is an opaque binary value, at most 60 KiB.
The relay validates the envelope and resource limits, looks up the recipient in
the sender's IP room, and forwards the bytes unchanged. It never deserializes
SDP, ICE, text or negotiation IDs.

Serde serializes server messages as single-key maps:

| Message | Value |
| --- | --- |
| `i` | `[identity, connection, displayName, deviceName]` |
| `p` | Array of peers |
| `j` | One joined peer |
| `u` | `[updatedPeer, departedConnectionOrNull]` |
| `l` | Departed identity |
| `r` | `[senderIdentity, senderConnection, payload]` |

A peer is `[identity, connection, displayName, icon, rtcSupported]`.
All IDs are 16-byte binary UUIDs. Icon is 0 (desktop/other), 1 (phone), or 2 (tablet).
Multiple tabs share a visible identity; discovery advertises the latest tab's
connection. Replies use the sender connection supplied by the relay. Traffic to
a departed connection is discarded, never silently delivered to another tab.

Only the browser decodes the inner payload, also MessagePack: either
`{type: "text", text}` or a `signal` object containing the WebRTC fields the
endpoints need. The browser trusts sender metadata only from the outer envelope.
Text is limited to 16 KiB of UTF-8 at the sender. No acknowledgments, delivery
statuses, persistence or offline delivery are provided.

File bytes travel over the WebRTC data channel. Text travels over WebSockets,
without creating a WebRTC connection. WSS protects the connection to the server;
text is not end-to-end encrypted. Payloads are not logged or stored.
