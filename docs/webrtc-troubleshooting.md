# WebRTC troubleshooting and browser quirks

Last reviewed: 2026-09-13. Browser behavior can change; distinguish the documented
behavior below from observations in a particular network or browser version.

## Devices appear, but transfers cannot connect

Peer discovery and SDP/ICE signaling use the WebSocket server. File transfers use
a separate WebRTC data channel. Seeing another device or `WS: server connected`
does not prove that the devices can establish the data connection.

An offer and answer followed by `signaling: "stable"`, ICE checks with no replies,
and `connection: "failed"` indicate a connectivity problem. The earlier
`setLocalDescription` error “Called in wrong state: stable” is different: it
indicates an SDP negotiation/state problem. Do not treat every failure as a
router or permission issue.

## Chrome media permission changes local ICE candidates

Chrome can conceal private IP addresses in ICE host candidates using temporary
mDNS names ending in `.local`. These names are expected and should be passed to
the browser unchanged. Their presence alone is not evidence of a failure.

Chrome's [2019 rollout announcement][chrome-mdns] explicitly excludes origins
with `getUserMedia` permission from this obfuscation. The [Chromium implementation][filtering]
checks both audio-capture and video-capture permission. If either is granted, it
allows network-interface enumeration and disables mDNS obfuscation for that
network manager. This is browser-specific behavior, not a portable WebRTC API
for requesting local IP addresses.

The check depends on permission, not on transmitting audio or keeping a capture
stream running. Stopping capture tracks does **not** revoke the site's permission;
users can revoke it in [Chrome's site settings][media-settings].

### Snapdrop's recovery behavior

Snapdrop starts connecting automatically when a peer is discovered. Each new
connection has a 15-second deadline to open its data channel. When both clients
support the check, each sends a small `connection-check` message through that
channel and expects its matching reply within 5 seconds. Transfers become ready
only after the round trip succeeds; this tests the actual data path, not the
WebSocket signaling path. No microphone or file access is involved.

The console reports `reason: "connection-verified"` and `connectionCheck: "passed"`
on success. This is a startup check, not a continuous heartbeat or a guarantee
that later transfers cannot fail. Older clients use channel-open readiness and
report `connectionCheck: "unsupported"`. Timers may run late in background tabs.

If connecting or verification times out, or the connection fails before it is
verified, Snapdrop first recreates the
connection with the offerer and answerer roles reversed. Either endpoint can
request this retry; simultaneous requests swap roles only once. Signals carry an
attempt marker so delayed SDP/ICE from the original attempt cannot affect the
new connection. There is at most one automatic role swap per peer object, and
no page reload or permission request is needed. Older cached peers that do not
advertise support skip the role swap and go directly to the recovery flow.

If the reversed attempt also fails or times out, the client offers an optional
microphone-permission workaround to Chrome/Chromium user agents that expose
`getUserMedia`. The behavior was investigated on desktop Chrome; the user-agent
check does not guarantee that every matching browser behaves identically.

1. Snapdrop explains the request. It does not request microphone access until the
   user clicks **Allow** in the recovery dialog.
2. It calls `getUserMedia({ audio: true })`, then immediately stops every returned
   track. The stream is never attached to a peer connection, player, or recorder.
3. It recreates failed peer connections and signals the other endpoint to do the
   same. This retry preserves the current roles, including an earlier role swap,
   to avoid both endpoints becoming callers. The page and unrelated connections stay open.
4. The user sends the file again after reconnection; the failed send is not
   automatically replayed.

The prompt is offered once per tab session using `sessionStorage`, with an
in-memory guard if storage is unavailable. Dismissal suppresses further automatic
prompts in that session. Denial or unavailable hardware produces an explanation
and allows another explicit attempt in the dialog. If the dialog is dismissed
while browser permission is pending, a subsequently returned stream is still
stopped and no retry is triggered.

See [network.js](../client/scripts/network.js), [ui.js](../client/scripts/ui.js),
the [negotiation tests](../tests/rtc-negotiation.test.cjs), and the
[recovery tests](../tests/connection-recovery.test.cjs). Serve the repository root
and open `tests/rtc-transfer.html?reverse` for a real-browser regression test:
it swaps an established pair's roles and verifies an exact 1,200,000-byte transfer.
Use `?unresponsive` to drop the initial probe replies and verify automatic
recovery and a subsequent transfer. The unit tests also simulate initial failure
on either endpoint or both at once.

### What we observed, and what remains uncertain

In one same-Wi-Fi setup, granting microphone permission on the receiving Chrome
endpoint made a previously failing transfer work. Safari-to-Chrome also worked
between separate devices before the permission change, while an iPhone-to-Chrome
attempt failed. Both successful and failing attempts advertised mDNS candidates.

This establishes that the workaround helped that setup. It does not establish
which browser, OS permission, or network component caused the original failure.
The permission change affects both address exposure and interface enumeration.
Nor is the file receiver inherently special: ICE connectivity checks are
bidirectional, and [peer-reflexive candidates][ice] can let a connection succeed
when only one endpoint advertises a directly reachable address. That is a
possible explanation for the one-sided workaround, not a verified packet trace.

Swapping offerer/answerer roles does not make ICE checks flow in only one
direction: both endpoints already perform them. The automatic reversed retry is
a bounded experiment for role-sensitive browser or negotiation behavior and also
gets a fresh connection attempt. Success alone does not prove that changing roles
was essential rather than retrying. It cannot guarantee a path through persistent
mDNS, firewall, or network restrictions. File sender/receiver and SDP
offerer/answerer are independent roles.

Chrome's team [discouraged requesting media permission solely to bypass mDNS][discussion]
because it should normally be unnecessary and can confuse users. Keep the
workaround optional and explain why a file-sharing page asks for microphone access.

## Reopening a page on mobile

A page restored from the browser's back/forward cache retains its JavaScript
objects. Snapdrop closes signaling and peer connections on `pagehide` and opens
signaling again on `pageshow`, following the [WebSocket lifecycle guidance][ws-lifecycle].
A fresh peer list rebuilds the connection objects; a rejoining device invalidates
its old connection and reversed-attempt flag before sending a new offer.

Tabs with the same identity cookie share one discoverable peer and name. The
server tracks their sockets separately, announces the first arrival and last
departure, and excludes the peer itself from discovery and signaling. The client
also learns its own ID before processing discovery and filters self entries.

A close, socket error, explicit disconnect, or missed-heartbeat deadline terminates
only that socket and cancels its timer. The heartbeat deadline is 60 seconds after
the last pong. Delayed callbacks cannot evict a newer socket or revive a dead one.
Healthy tabs remain discoverable when another tab closes.

Signaling carries a connection-specific destination and a negotiation ID, so
several tabs can transfer independently under the same visible device identity.
Replies stay with their initiating tab. When a socket disappears, its signaling
routes are removed; affected connections can reconnect to another remaining tab.
Names and device models are never used to merge separate browser identities.

`connectionCheck: "unsupported"` means the other endpoint did not advertise the
new round-trip check, usually because it still has an older client loaded. It
is not a failed check. A final `channel-open` with ICE and DTLS both `connected`
means the channel opened, but does not prove that a later file transfer succeeded.
Load the updated client on both endpoints to get `connection-verified` diagnostics.
A service-worker update does not replace JavaScript already running in a tab.

## Alternatives and limitations

| Option | What it does and does not solve |
| --- | --- |
| [`WebRtcLocalIpsAllowedUrls` policy][policy] | Allows selected origins to expose local ICE IPs without media permission. Requires user/admin browser configuration; page JavaScript cannot install it. |
| Manual microphone/camera permission | Granting a site permission in browser settings should satisfy the same Chromium check without briefly opening a capture stream. This is an inference from the implementation, and still grants media permission. Recreate the connection afterward. |
| Fix local connectivity | Check OS Local Network access, firewalls, Wi-Fi client isolation, and mDNS reachability. Sharing an SSID does not by itself establish that every connection path is usable. Avoid blaming a particular router without evidence. |
| Dedicated Local Network Access permission | Chrome's [proposal][lna] includes WebRTC. At the review date, the [source default][lna-feature] for `kLocalNetworkAccessChecksWebRTC` is disabled. Rollouts may override source defaults. This is not a verified general replacement for media permission, and its design does not promise to remove mDNS obfuscation. |
| [`restartIce()`][restart] | Restarts ICE negotiation; it does not grant permission or disable address obfuscation. It can help transient connectivity changes, but does not repair a persistent policy/network block. |
| STUN or TURN | STUN discovers server-reflexive addresses; it does not relay file data or guarantee connectivity. TURN provides a relay path with bandwidth costs. This deployment uses STUN and does not configure a TURN relay. |

OS Local Network permission and Chrome's website-level permissions are separate.
Media permission is not a supported way to override an OS network restriction.
See [Apple's local-network privacy documentation][apple-network].

## Collect useful diagnostics

Record browser and OS versions, which browser runs on each physical device,
whether the devices share a network, and which side granted permission. Separate
a two-browser test on one computer from a test across two devices.

Capture the `RTC diagnostics:` lines from both endpoints through failure and,
if possible, through a successful retry. Compare:

- Round-trip result (`connecting`, `pending`, `passed`, or `unsupported`) and
  timeout reason (`connection-timeout` or `connection-check-timeout`).
- Attempt (`initial` or `reversed`) and local role (`offerer` or `answerer`).
- SDP state and signaling errors: did the offer/answer exchange finish?
- Host candidate address kinds: `mdns`, `ipv4`, or `ipv6`.
- Candidate-pair states and connectivity-check requests/responses.
- ICE, DTLS, and data-channel connection states.

The structured diagnostics omit raw addresses, SDP, and candidate strings.
Other console messages can contain raw signaling objects; redact those before
sharing publicly. Event-time stats may lag state transitions, and teardown can
remove candidate pairs. An empty list after failure does not prove that no
candidates were tried.

After deploying client changes, update the service-worker cache name so existing
installations can obtain the new assets. Load the updated client on both endpoints
before testing a change to the signaling protocol.

[chrome-mdns]: https://groups.google.com/a/chromium.org/g/blink-dev/c/z5hSy6Rf_aE/m/amoojRkSAgAJ
[filtering]: https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/p2p/filtering_network_manager.cc
[discussion]: https://groups.google.com/g/discuss-webrtc/c/6stQXi72BEU/m/7qVwleLiBwAJ
[policy]: https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Miscellaneous/WebRtcLocalIpsAllowedUrls.yaml
[media-settings]: https://support.google.com/chrome/answer/2693767
[lna]: https://github.com/WICG/local-network-access/blob/main/explainer.md#integration-with-webrtc
[lna-feature]: https://github.com/chromium/chromium/blob/main/services/network/public/cpp/features.cc
[restart]: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce
[ice]: https://www.rfc-editor.org/rfc/rfc8445.html#section-7.3.1.3
[apple-network]: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy

[ws-lifecycle]: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications#working_with_the_bfcache
