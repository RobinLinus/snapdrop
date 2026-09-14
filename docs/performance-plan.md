# Performance, cost and stability

The implementation uses a Rust relay, MessagePack envelopes through Serde,
opaque payload forwarding, and WebSocket text delivery. File connections start
on demand. This removes idle WebRTC negotiation and keeps server work limited to
discovery, bounded connection handling and recipient lookup.

The runtime has connection, room, message-size, rate and outgoing-queue limits.
Slow recipients are isolated; dead sockets expire through native ping/pong.
The deployment contains one Rust binary behind nginx, with no runtime package
installation, database, session-route table or message persistence.

Next, measure before resizing infrastructure:

1. Record CPU, RSS, active sockets, room sizes, reconnect rate, nginx traffic and
   current host/network charges under representative production traffic.
2. Load-test idle connections, text/ICE bursts, connection churn, many tabs,
   slow readers and large shared-IP rooms. Measure p50/p95/p99 relay latency,
   peak memory and maximum sustainable connections through nginx/TLS.
3. Compare the release against the previous deployment at the same workload.
   Binary size reductions and runtime changes alone do not establish savings.
4. Choose the smallest instance that meets the measured latency target with
   capacity for observed bursts. Repeat overload and graceful-restart tests there.
5. Add operational metrics only where they answer capacity or failure questions;
   keep message contents and raw peer addresses out of logs.

Text relay adds bandwidth to the server while removing WebRTC setup latency for
messages. Savings depend on the mix of connections, signaling and text, and on
whether compute or network cost dominates. No speedup or cost reduction is claimed
until it is measured. Deployment and rollback steps are in `deployment.md`.
