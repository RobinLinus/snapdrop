# Deploying the Rust relay

This release replaces the signaling server and its wire protocol. Deploy the
client and relay together, then reload existing tabs after the service worker
updates. Older JSON clients and third-party clients using that protocol cannot
connect. There is no compatibility server.

The previously verified host layout (2026-09-13) uses `/opt/snapdrop`, nginx serving
`/opt/snapdrop/client`, and `/server` proxied to `127.0.0.1:3000`. The commands below
are the migration procedure, not a claim that production has been migrated.

## Build and verify

From a clean checkout of the reviewed commit on the target Linux architecture:

```sh
cargo test --locked --manifest-path server/Cargo.toml
cargo build --release --locked --manifest-path server/Cargo.toml
pnpm install --frozen-lockfile
pnpm test
git diff --check
```

Rust builds the runtime executable. Node and pnpm are development/test tools;
neither is required on the runtime host. Alternatively use `docker compose up
--build -d`, which builds Rust in a separate image stage.

## Install on the existing host

Retain the previous executable, client release and service unit for rollback.
Deploy the chosen commit to `/opt/snapdrop` and install its Linux binary:

```sh
sudo install -m 0755 server/target/release/snapdrop-server /usr/local/bin/snapdrop-server.new
sudo mv /usr/local/bin/snapdrop-server.new /usr/local/bin/snapdrop-server
sudo install -m 0644 deploy/snapdrop.service /etc/systemd/system/snapdrop.service
sudo systemctl daemon-reload
sudo systemctl restart snapdrop
```

The service uses the existing `snapdrop` user/group. For a fresh host, create that
system account first. nginx must use HTTP/1.1 upgrades, overwrite
`X-Forwarded-For` with `$remote_addr`, set `X-Forwarded-Proto $scheme`, and use a
read timeout longer than 60 seconds. Run `sudo nginx -t` before reloading changes.
Keep the relay port private. Keep existing TLS certificates and renewal settings.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening IP |
| `PORT` | `3000` | Listening port |
| `TRUSTED_PROXIES` | `127.0.0.1/32,::1/128` | Comma-separated trusted proxy CIDRs; empty trusts none |
| `MAX_CONNECTIONS` | `10000` | Process connection cap |
| `MAX_ROOM_CONNECTIONS` | `256` | Connection cap per public IP |

Each identity can open up to 16 tabs in a room. Each socket has a bounded outgoing
queue, a 64 KiB message limit, and a 100-message/second rate limit with a 200-message
burst. Slow recipients are disconnected. Native WebSocket ping/pong detects dead
connections; SIGTERM closes sockets and drains shutdown within a bounded deadline.

## Verify and roll back

```sh
curl -f http://127.0.0.1:3000/healthz
curl -f http://127.0.0.1:3000/readyz
systemctl is-active snapdrop nginx
sudo journalctl -u snapdrop -n 80 --no-pager
```

Compare served `scripts/network.js`, `scripts/protocol.js`, `vendor/msgpack.min.js`
and `service-worker.js` with the deployed files. Check discovery, immediate Unicode
text delivery, and a file transfer between two browser identities. Check that
closing one of several tabs leaves the other discoverable.

Rollback requires restoring a matching client, executable and service unit as one
release. Restart the service and verify again. For a cached client rollback, ship
restored assets with a fresh service-worker cache name and matching
`ConnectionLog.clientVersion`; reload existing tabs. Never pair the old client
with the new relay.
