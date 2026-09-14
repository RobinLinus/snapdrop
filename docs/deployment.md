# Deploying snapdrop.me

Current setup, verified 2026-09-13:

- EC2 Elastic IP: `3.123.121.55`; SSH user: `ubuntu`.
- Git checkout: `/opt/snapdrop`, owned by the SSH user `ubuntu`.
- Origin: `https://github.com/RobinLinus/snapdrop.git`. Production runs a detached
  commit, so a branch moving does not change the deployed version.
- nginx serves `/opt/snapdrop/client` and proxies `/server` WebSockets to
  `127.0.0.1:3000`.
- `snapdrop.service` runs `/usr/bin/node index.js` from `/opt/snapdrop/server`
  as the `snapdrop` user. This deployment does not require Docker.
- nginx configuration: `/etc/nginx/sites-available/snapdrop`.
- HTTPS uses Certbot; `certbot.timer` handles renewal. Certificates are under
  `/etc/letsencrypt/live/snapdrop.me/`.
- TURN is not configured for the app. Keep the installed coturn service disabled.

## Prepare locally

Run from the repository root with Node.js on your PATH:

```sh
git diff --check
node --test tests/*.test.cjs
node --check client/scripts/network.js
node --check client/scripts/ui.js
```

For client changes, increment `CACHE_NAME` in `client/service-worker.js` to a
new, unused version. The client caches assets, so replacing files alone is not
enough. Commit the cache version bump along with the other client changes.

For WebRTC changes, also serve the repository with
`python3 -m http.server 8766 --bind 127.0.0.1` and open
`http://127.0.0.1:8766/tests/rtc-transfer.html?reverse`. It should report an exact
1,200,000-byte transfer after swapping roles. `?recovery` tests the explicit
reconnection path without requesting microphone access.

## Commit, push, and deploy

Use your existing SSH key/agent. The commands below use the previously verified
host-key file `/tmp/snapdrop-known-hosts`. If it has disappeared, verify the host
key again and use a persistent known-hosts file; do not disable host checking.
The server fetches the public repository over HTTPS and needs no GitHub private key.

Review and commit the intended changes locally, then push the current branch.
Do not deploy uncommitted changes. These commands deploy the exact local commit:

```sh
git push origin HEAD
deploy_commit=$(git rev-parse HEAD)
ssh -o BatchMode=yes -o UserKnownHostsFile=/tmp/snapdrop-known-hosts \
  ubuntu@3.123.121.55 bash -s -- "$deploy_commit" <<'REMOTE'
set -eu
cd /opt/snapdrop
test -z "$(git status --porcelain)" || { echo 'Server checkout is dirty; inspect it first.'; exit 1; }
git fetch origin
target=$(git rev-parse --verify "$1^{commit}")
previous=$(git rev-parse HEAD)
if [ "$target" = "$previous" ]; then
  echo "Already deployed: $target"
  exit 0
fi
git update-ref refs/deploy/previous "$previous"
git checkout --detach "$target"
if ! git diff --quiet "$previous" "$target" -- server/package.json server/package-lock.json; then
  (cd server && npm ci --omit=dev)
fi
if ! git diff --quiet "$previous" "$target" -- server; then
  sudo systemctl restart snapdrop
fi
systemctl is-active nginx snapdrop
git rev-parse HEAD
REMOTE
```

If a command fails after checkout, inspect the failure and use the rollback
procedure below. This is a simple deployment in place, not an atomic release
system. Backend restarts briefly disconnect signaling clients. Static client
changes need no restart. Reload nginx only when its configuration changed,
after `sudo nginx -t` succeeds.

Do not edit application files on the server. Make changes locally and deploy
another commit. Keep certificates and service/nginx configuration outside Git.

## Verify

Compare each deployed file with its public response, not just the server's disk.
For example, the two hashes below must match:

```sh
shasum -a 256 client/scripts/network.js
curl -fsS https://snapdrop.me/scripts/network.js | shasum -a 256
curl -fsS https://snapdrop.me/service-worker.js | head -n 1
ssh "${ssh_options[@]}" "$deploy_host" 'systemctl is-active nginx snapdrop'
```

Open the updated client on both devices and check discovery and a small file
transfer. Existing tabs may still be running old JavaScript: reopen or reload
them after the service worker updates. Reconnection during normal operation does
not require a reload. See [WebRTC troubleshooting](webrtc-troubleshooting.md).

Useful server checks:

```sh
sudo journalctl -u snapdrop -n 80 --no-pager
sudo nginx -t
systemctl status certbot.timer --no-pager
```

## Roll back

On the server, restore the previous deployment commit and its dependencies:

```sh
cd /opt/snapdrop
test -z "$(git status --porcelain)" || { echo 'Server checkout is dirty; inspect it first.'; exit 1; }
git checkout --detach refs/deploy/previous
(cd server && npm ci --omit=dev)
sudo systemctl restart snapdrop
systemctl is-active nginx snapdrop
git rev-parse HEAD
```

For the initial migration from copied files, the old application directory is
retained at `/opt/snapdrop-before-git-TIMESTAMP`; there is no previous Git
release yet. Subsequent deployments save `refs/deploy/previous` automatically.

For a client rollback, follow up with a commit containing the restored client
and a new, unused service-worker cache version. Verify the public assets again;
do not rely on cached clients immediately reverting to an older cache name.
