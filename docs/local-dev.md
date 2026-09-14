# Local development

Run the Rust relay and nginx together:

```sh
docker compose up --build -d
docker compose logs -f relay
```

Open `http://localhost:8080`. Stop with `docker compose down`.
The relay is private to the Docker network. If `172.30.0.0/24` overlaps an
existing network, change both the Compose subnet and `TRUSTED_PROXIES`.

For native server development:

```sh
cargo run --locked --manifest-path server/Cargo.toml
```

The relay listens on `127.0.0.1:3000`. Serve `client/` through nginx and proxy
`/server` to that address; see `docker/nginx/default.conf`. The proxy must replace
`X-Forwarded-For` with the client's address and set `X-Forwarded-Proto`.
Only explicitly trusted proxy addresses may assign clients to IP rooms.

Tests require Rust and Node.js (Node is only used for browser tooling/tests):

```sh
pnpm install --frozen-lockfile
cargo test --locked --manifest-path server/Cargo.toml
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

The browser test uses two isolated identities and an additional tab to check text
without WebRTC, exact file transfer, and replacement of a departed tab. Set
`CHROME_PATH` to use an existing Chrome executable instead of downloading Chromium.

`pnpm vendor` updates the checked-in MessagePack browser library from the locked
package. Production serves that file locally and requires no package manager.

For HTTPS/PWA development, set the workstation name in `docker/fqdn.env`.
The nginx container generates development certificates; trust its CA from
`http://localhost:8080/ca.crt` and open `https://<your workstation name>`.
Development certificates expire after a day and are recreated on container restart.

[Deployment](deployment.md) · [Protocol](websocket-protocol.md)
