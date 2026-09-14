const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
    const connections = [], errors = [], sent = [], events = [], logs = [];
    const timers = new Map();
    const listeners = new Map();
    let nextTimer = 0;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    class Connection {
        constructor() {
            this.signalingState = 'stable';
            this.channels = [];
            this.answers = 0;
            this.candidates = [];
            connections.push(this);
        }
        createDataChannel() {
            const channel = { readyState: 'connecting', sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.readyState = 'closed'; } };
            this.channels.push(channel);
            return channel;
        }
        async createOffer() { await tick(); return { type: 'offer', sdp: 'local-offer' }; }
        async createAnswer() { await tick(); this.answers++; return { type: 'answer', sdp: 'answer' }; }
        async setLocalDescription(description) {
            await tick();
            if (description.type === 'answer') assert.equal(this.signalingState, 'have-remote-offer');
            if (description.type === 'offer') assert.equal(this.signalingState, 'stable');
            this.localDescription = description;
            this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
        }
        async setRemoteDescription(description) {
            await tick();
            this.remoteDescription = description;
            this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
        }
        async addIceCandidate(candidate) {
            assert.ok(this.remoteDescription);
            this.candidates.push(candidate);
        }
        close() { this.signalingState = 'closed'; }
    }
    const context = vm.createContext({
        window: { URL: {}, RTCPeerConnection: Connection,
            addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
            dispatchEvent(event) { events.push(event); for (const callback of listeners.get(event.type) || []) callback(event); } },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        console: { log(...args) { logs.push(args); }, error(error) { errors.push(error); } },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        RTCPeerConnection: Connection,
        RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
        RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } },
    });
    vm.runInContext(fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.RTCPeer = RTCPeer; this.PeersManager = PeersManager; this.ConnectionLog = ConnectionLog; this.Peer = Peer;', context);
    return { ...context, connections, errors, sent, events, timers, logs, server: { send(message) { sent.push(message); } } };
}

test('sessions from two tabs of one peer negotiate independently and replies retain their destination', async () => {
    const t = setup();
    let next = 0;
    t.server.nextSessionId = () => 'local:' + (++next);
    const manager = new t.PeersManager(t.server);
    for (const session of ['tab-one:1', 'tab-two:1']) {
        manager._onMessage({ sender: 'phone', senderSession: session.split(':')[0], sessionId: session,
            sdp: { type: 'offer', sdp: session } });
    }
    await Promise.all([...manager._sessions.values()].map(peer => peer._operations));
    assert.equal(t.connections.length, 2);
    assert.equal(manager._sessions.size, 2);
    for (const message of t.sent.filter(message => message.sdp)) {
        assert.equal(message.to, 'phone');
        assert.equal(message.toSession, message.sessionId.split(':')[0]);
    }
    const first = manager.peers.phone;
    manager._onMessage({ sender: 'phone', sessionId: 'tab-one:1', disconnected: true });
    assert.equal(first._closed, true);
    assert.equal(manager._sessions.size, 1);
    assert.equal(manager.peers.phone._signalId, 'tab-two:1');
    manager._onMessage({ sender: 'phone', sessionId: 'tab-one:1', sdp: { type: 'offer', sdp: 'late' } });
    assert.equal(t.connections.length, 2);
    manager._onPeerLeft('phone');
    assert.equal(manager._sessions.size, 0);
    assert.ok(t.connections.every(connection => connection.signalingState === 'closed'));
});

test('a departing tab restarts only its session on the remaining peer, while self is never connected', async () => {
    const t = setup();
    let next = 0;
    t.server.nextSessionId = () => 'local:' + (++next);
    const manager = new t.PeersManager(t.server);
    t.window.dispatchEvent({ type: 'peer-identity', detail: 'me' });
    manager._onPeers([{ id: 'me', rtcSupported: true }, { id: 'phone', rtcSupported: true }]);
    assert.deepEqual(Object.keys(manager.peers), ['phone']);
    const old = manager.peers.phone;
    await old._operations;
    manager._onMessage({ sender: 'phone', sessionId: old._signalId, disconnected: true });
    const replacement = manager.peers.phone;
    assert.notEqual(replacement, old);
    assert.equal(old._closed, true);
    manager._onMessage({ sender: 'me', sessionId: 'self', sdp: { type: 'offer', sdp: 'self' } });
    assert.equal(manager.peers.me, undefined);
    await replacement._operations;
    assert.equal(t.sent.at(-1).sessionId, replacement._signalId);
    assert.equal(t.errors.length, 0);
});

test('repeated sends and refreshes during startup produce only one offer and channel', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    for (let i = 0; i < 10; i++) { peer.refresh(); peer.sendFiles([{}]); }
    await peer._operations;
    assert.equal(t.connections.length, 1);
    assert.equal(t.connections[0].channels.length, 1);
    assert.equal(t.sent.filter(m => m.sdp).length, 1);
    assert.equal(t.errors.length, 0);
    assert.equal(peer._busy, false);
});

test('overlapping offers finish their answers in order; duplicate offer is ignored', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server);
    const offer = sdp => ({ sender: 'peer', sdp: { type: 'offer', sdp } });
    peer.onServerMessage(offer('first'));
    peer.onServerMessage(offer('second'));
    peer.onServerMessage(offer('second'));
    await peer._operations;
    assert.equal(t.connections[0].answers, 2);
    assert.equal(t.connections[0].signalingState, 'stable');
    assert.equal(t.errors.length, 0);
});

test('ICE arriving before the remote answer waits for its description', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    peer.onServerMessage({ sender: 'peer', ice: { candidate: 'test' } });
    peer.onServerMessage({ sender: 'peer', sdp: { type: 'answer', sdp: 'answer' } });
    await peer._operations;
    assert.equal(t.connections[0].candidates.length, 1);
    assert.equal(t.errors.length, 0);
});

test('departed peers close channels and cannot signal from unfinished async work', async () => {
    const t = setup();
    const manager = new t.PeersManager(t.server);
    const peer = new t.RTCPeer(t.server, 'peer');
    manager.peers.peer = peer;
    manager._onPeerLeft('peer');
    await peer._operations;
    assert.equal(t.connections[0].signalingState, 'closed');
    assert.equal(t.connections[0].channels[0].readyState, 'closed');
    assert.equal(t.sent.length, 0);
    peer.refresh();
    assert.equal(t.connections.length, 1);
});

test('late answers cannot recreate a final failed connection; explicit retry creates just one', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    await peer._operations;
    const conn = t.connections[0];
    peer._reversed = true;
    conn.connectionState = 'failed';
    conn.onconnectionstatechange();
    peer.onServerMessage({ sender: 'peer', reversed: true, sdp: { type: 'answer', sdp: 'late' } });
    assert.equal(t.connections.length, 1);
    peer.refresh(); peer.refresh();
    await peer._operations;
    assert.equal(t.connections.length, 2);
    assert.equal(conn.signalingState, 'closed');
    assert.equal(t.errors.length, 0);
});

test('diagnostics include resolvable addresses while omitting SDP', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    await peer._operations;
    const conn = t.connections[0];
    conn.connectionState = 'failed';
    conn.iceConnectionState = 'failed';
    conn.iceGatheringState = 'complete';
    conn.sctp = { state: 'connecting' };
    conn.localDescription.sdp = 'sensitive-session-description';
    conn.getStats = async () => new Map([
        ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.2' }],
        ['remote', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: 'private-device.local' }],
        ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', state: 'failed', requestsSent: 7, responsesReceived: 0 }],
        ['transport', { type: 'transport', dtlsState: 'new', iceState: 'failed' }],
        ['channel', { type: 'data-channel', dataChannelIdentifier: 1, state: 'connecting', messagesSent: 1, messagesReceived: 0 }]
    ]);
    const report = await peer._reportDiagnostics(conn, 'test');
    assert.equal(report.pairs[0].requestsSent, 7);
    assert.equal(report.pairs[0].responsesReceived, 0);
    assert.equal(report.pairs[0].local.addressKind, 'ipv4');
    assert.equal(report.pairs[0].remote.addressKind, 'mdns');
    assert.equal(report.transports[0].dtlsState, 'new');
    assert.equal(report.sctp, 'connecting');
    assert.equal(report.channel.state, 'connecting');
    assert.equal(report.dataChannels[0].messagesSent, 1);
    assert.equal(report.dataChannels[0].messagesReceived, 0);
    assert.equal(report.localDescription, 'offer');
    const json = JSON.stringify(report);
    assert.ok(json.includes('192.168.1.2'));
    assert.ok(json.includes('private-device.local'));
    assert.ok(!json.includes('sensitive-session-description'));
});

test('candidate diagnostics distinguish mDNS, public candidates, and end-of-candidates', () => {
    const t = setup();
    const host = t.RTCPeer._candidateSummary({ candidate: 'candidate:1 1 udp 123 masked.local 1234 typ host' });
    const srflx = t.RTCPeer._candidateSummary({ candidate: 'candidate:2 1 udp 123 203.0.113.1 4321 typ srflx' });
    assert.equal(host.type, 'host');
    assert.equal(host.addressKind, 'mdns');
    assert.equal(srflx.type, 'srflx');
    assert.equal(t.RTCPeer._candidateSummary({ candidate: '' }).type, 'end-of-candidates');
});

test('failed receiver retries with a fresh connection and asks the original caller to offer', async () => {
    const t = setup();
    const receiver = new t.RTCPeer(t.server);
    await receiver.onServerMessage({ sender: 'peer', sdp: { type: 'offer', sdp: 'first' } });
    const old = receiver._conn;
    receiver._reversed = true;
    old.connectionState = 'failed';
    old.onconnectionstatechange();
    t.sent.length = 0;
    receiver.retryConnection();
    await receiver._operations;
    assert.notEqual(receiver._conn, old);
    assert.equal(old.signalingState, 'closed');
    assert.equal(receiver._isCaller, false);
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].restart, true);
    assert.equal(receiver._needsRecovery, false);
    receiver.retryConnection();
    assert.equal(t.sent.length, 1);
});

test('restart request recreates the caller and sends a fresh offer; healthy peers are untouched', async () => {
    const t = setup();
    const caller = new t.RTCPeer(t.server, 'peer');
    await caller._operations;
    const old = caller._conn;
    caller.onServerMessage({ sender: 'peer', restart: true });
    await caller._operations;
    assert.notEqual(caller._conn, old);
    assert.equal(old.signalingState, 'closed');
    assert.equal(t.sent.filter(m => m.sdp && m.sdp.type === 'offer').length, 2);
    const fresh = caller._conn;
    caller.retryConnection();
    assert.equal(caller._conn, fresh);
});

function failConnection(peer) {
    peer._conn.connectionState = 'failed';
    peer._conn.onconnectionstatechange();
}

for (const failsFirst of ['caller', 'callee', 'both']) {
    test(`role reversal converges when ${failsFirst} fails first`, async () => {
        const t = setup();
        const pending = [];
        const callee = new t.RTCPeer({ send: message => pending.push(['caller', message]) });
        const caller = new t.RTCPeer({ send: message => pending.push(['callee', message]) }, 'callee');
        const peers = { caller, callee };
        async function relay() {
            for (let round = 0; round < 10; round++) {
                await Promise.all([caller._operations, callee._operations]);
                if (!pending.length) return;
                for (const [target, message] of pending.splice(0)) {
                    peers[target].onServerMessage({ ...message, sender: target === 'caller' ? 'callee' : 'caller' });
                }
            }
            assert.fail('Signaling did not settle');
        }
        await relay();
        const original = [caller._conn, callee._conn];
        if (failsFirst !== 'callee') failConnection(caller);
        if (failsFirst !== 'caller') failConnection(callee);
        await relay();
        assert.equal(t.connections.length, 4);
        assert.ok(original.every(conn => conn.signalingState === 'closed'));
        assert.equal(caller._isCaller, false);
        assert.equal(callee._isCaller, true);
        assert.equal(caller._conn.localDescription.type, 'answer');
        assert.equal(callee._conn.localDescription.type, 'offer');
        assert.equal(t.events.filter(e => e.type === 'connection-failed').length, 0);
        assert.equal(t.errors.length, 0);

        // Duplicate requests and old SDP/ICE must not reset or pollute the new attempt.
        caller.onServerMessage({ sender: 'callee', restart: true, reverse: true, reversed: true });
        caller.onServerMessage({ sender: 'callee', restart: true });
        caller.onServerMessage({ sender: 'callee', sdp: { type: 'offer', sdp: 'stale' } });
        caller.onServerMessage({ sender: 'callee', ice: { candidate: 'stale' } });
        await relay();
        assert.equal(t.connections.length, 4);
        assert.equal(caller._conn.answers, 1);
        assert.equal(caller._conn.candidates.length, 0);
        const report = await caller._reportDiagnostics(caller._conn, 'test');
        assert.equal(report.attempt, 'reversed');
        assert.equal(report.role, 'answerer');

        // Stop after one automatic retry, then use the existing explicit permission recovery.
        failConnection(caller);
        failConnection(callee);
        await relay();
        assert.equal(t.connections.length, 4);
        assert.equal(t.events.filter(e => e.type === 'connection-failed').length, 2);
        caller.retryConnection();
        await relay();
        assert.equal(t.connections.length, 6);
        assert.equal(caller._conn.localDescription.type, 'answer');
        assert.equal(callee._conn.localDescription.type, 'offer');
        assert.equal(t.errors.length, 0);
        caller.close(); callee.close();
        caller.onServerMessage({ sender: 'callee', reverse: true });
        assert.equal(t.connections.length, 6);
    });
}

test('losing an established channel does not trigger an automatic role swap', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    await peer._operations;
    peer._channel.readyState = 'open';
    peer._channel.onopen();
    failConnection(peer);
    assert.equal(t.connections.length, 1);
    assert.equal(t.sent.filter(m => m.reverse).length, 0);
    assert.equal(t.events.filter(e => e.type === 'connection-failed').length, 0);
});


test('legacy peers go straight to recovery instead of receiving an unsupported role swap', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    await peer.onServerMessage({ sender: 'peer', sdp: { type: 'answer', sdp: 'legacy' } });
    failConnection(peer);
    assert.equal(t.connections.length, 1);
    assert.equal(t.sent.filter(m => m.reverse).length, 0);
    assert.equal(t.events.filter(e => e.type === 'connection-failed').length, 1);
});


async function checkablePeer() {
    const t = setup();
    t.peer = new t.RTCPeer(t.server, 'peer');
    await t.peer.onServerMessage({ sender: 'peer', reversed: false, connectionCheck: true,
        sdp: { type: 'answer', sdp: 'answer' } });
    t.channel = t.peer._channel;
    return t;
}

test('an incoming already-open channel verifies without an open event and ignores a later duplicate', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server);
    await peer.onServerMessage({ sender: 'peer', reversed: false, connectionCheck: true,
        sdp: { type: 'offer', sdp: 'offer' } });
    const conn = peer._conn;
    const channel = conn.createDataChannel();
    channel.readyState = 'open';
    conn.ondatachannel({ channel });
    assert.equal(peer._connectionCheck, 'pending');
    assert.equal(channel.sent.length, 1);
    const deadline = [...t.timers.keys()][0];
    channel.onopen();
    assert.equal(channel.sent.length, 1);
    assert.equal([...t.timers.keys()][0], deadline);
    channel.onmessage({ data: JSON.stringify({ type: 'connection-check', id: 7 }) });
    channel.onmessage({ data: JSON.stringify({ type: 'connection-check-reply', id: channel.sent[0].id }) });
    assert.equal(peer._isConnected(), true);
    assert.equal(t.timers.size, 0);
    channel.onopen();
    assert.equal(peer._connectionCheck, 'passed');
    const events = t.logs.map(args => JSON.parse(args[0].slice('Snapdrop: '.length)).event);
    for (const event of ['channel-attached', 'channel-open', 'connection-check-send',
        'connection-check-receive', 'connection-check-reply-send', 'connection-check-reply-receive']) {
        assert.equal(events.filter(value => value === event).length, 1);
    }
    const lateOpen = channel.onopen;
    peer.close();
    lateOpen();
    assert.equal(channel.onerror, null);
    assert.equal(t.errors.length, 0);
});

test('open channel must echo a probe before sending files; reply clears the deadline', async () => {
    const t = await checkablePeer();
    t.channel.readyState = 'open';
    t.channel.onopen();
    assert.equal(t.peer._isConnected(), false);
    t.peer.sendFiles([{}]);
    assert.equal(t.channel.sent.length, 1);
    const probe = t.channel.sent[0];
    assert.equal(probe.type, 'connection-check');
    assert.equal([...t.timers.values()][0].delay, 5000);
    t.channel.onmessage({ data: JSON.stringify({ type: 'connection-check-reply', id: probe.id + 1 }) });
    assert.equal(t.peer._isConnected(), false);
    t.channel.onmessage({ data: JSON.stringify({ type: 'connection-check-reply', id: probe.id }) });
    assert.equal(t.peer._isConnected(), true);
    assert.equal(t.peer._connectionCheck, 'passed');
    assert.equal(t.timers.size, 0);
    t.channel.onmessage({ data: JSON.stringify({ type: 'connection-check', id: 42 }) });
    assert.equal(t.channel.sent[1].type, 'connection-check-reply');
    assert.equal(t.channel.sent[1].id, 42);
});

test('stuck connecting retries automatically, then offers recovery; old deadlines cannot close the retry', async () => {
    const t = await checkablePeer();
    const original = t.peer._conn;
    const deadline = [...t.timers.values()][0];
    assert.equal(deadline.delay, 15000);
    deadline.callback();
    assert.equal(original.signalingState, 'closed');
    assert.equal(t.peer._reversed, true);
    const retry = t.peer._conn;
    deadline.callback();
    assert.equal(t.peer._conn, retry);
    assert.equal(t.events.filter(e => e.type === 'connection-failed').length, 0);
    [...t.timers.values()][0].callback();
    assert.equal(t.peer._conn, null);
    assert.equal(t.events.filter(e => e.type === 'connection-failed').length, 1);
    assert.equal(t.timers.size, 0);
});

test('an open but unresponsive channel triggers the same bounded retry', async () => {
    const t = await checkablePeer();
    t.channel.readyState = 'open';
    t.channel.onopen();
    const lateReply = t.channel.onmessage;
    const probe = t.channel.sent[0];
    [...t.timers.values()][0].callback();
    assert.equal(t.peer._reversed, true);
    assert.equal(t.channel.readyState, 'closed');
    lateReply({ data: JSON.stringify({ type: 'connection-check-reply', id: probe.id }) });
    assert.equal(t.peer._connectedOnce, false);
    t.peer.close();
    assert.equal(t.timers.size, 0);
});

test('a channel closing before the failure event still triggers recovery', async () => {
    const t = await checkablePeer();
    t.channel.onclose();
    assert.equal(t.peer._reversed, true);
    assert.equal(t.connections.length, 2);
});

test('older clients remain usable without supporting the connection probe', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    await peer._operations;
    peer._channel.readyState = 'open';
    peer._channel.onopen();
    assert.equal(peer._isConnected(), true);
    assert.equal(peer._connectionCheck, 'unsupported');
    assert.equal(peer._channel.sent.length, 0);
    assert.equal(t.timers.size, 0);
});


test('a rejoining device clears old reversed state before accepting its fresh offer', async () => {
    const t = setup();
    const manager = new t.PeersManager(t.server);
    const old = new t.RTCPeer(t.server, 'phone');
    manager.peers.phone = old;
    old._reversed = true;
    t.window.dispatchEvent({ type: 'peer-joined', detail: { id: 'phone' } });
    assert.equal(old._closed, true);
    manager._onMessage({ sender: 'phone', reversed: false, connectionCheck: true,
        sdp: { type: 'offer', sdp: 'new-page' } });
    const fresh = manager.peers.phone;
    await fresh._operations;
    assert.notEqual(fresh, old);
    assert.equal(fresh._conn.localDescription.type, 'answer');
    assert.equal(fresh._isCaller, false);
    assert.equal(t.errors.length, 0);
});

test('pagehide clears peers and reconnect snapshots rebuild them without stale devices', async () => {
    const t = setup();
    const manager = new t.PeersManager(t.server);
    manager._onPeers([{ id: 'phone', rtcSupported: true }, { id: 'gone', rtcSupported: true }]);
    const old = manager.peers.phone;
    old._reversed = true;
    manager._onPeers([{ id: 'phone', rtcSupported: true }]);
    assert.equal(old._closed, true);
    assert.equal(manager.peers.gone, undefined);
    assert.notEqual(manager.peers.phone, old);
    assert.equal(manager.peers.phone._reversed, undefined);
    t.window.dispatchEvent({ type: 'pagehide' });
    assert.equal(Object.keys(manager.peers).length, 0);
    assert.equal(t.timers.size, 0);
    await old._operations;
    assert.equal(t.errors.length, 0);
});


test('pasted logs are single-string JSON with exact ICE hostnames and no SDP or shared text', () => {
    const t = setup();
    t.ConnectionLog.write('ws-receive', t.ConnectionLog.message({
        type: 'signal', sender: 'phone', senderSession: 'tab', sessionId: 'tab:1', reversed: false,
        sdp: { type: 'offer', sdp: 'a=ice-pwd:secret-password' },
        ice: { candidate: 'candidate:1 1 udp 123 test-device.local 1234 typ host ufrag secret-fragment', sdpMid: '0' }
    }));
    const peer = new t.Peer(t.server, 'phone');
    peer._onTextReceived = () => {};
    peer._onMessage(JSON.stringify({ type: 'text', text: 'private-shared-text' }));
    for (const args of t.logs) {
        assert.equal(args.length, 1);
        assert.equal(typeof args[0], 'string');
        const record = JSON.parse(args[0].slice('Snapdrop: '.length));
        assert.equal(record.version, 2);
        assert.ok(record.time.endsWith('Z'));
        assert.ok(record.page);
    }
    const signal = JSON.parse(t.logs[1][0].slice('Snapdrop: '.length));
    assert.equal(signal.ice.address, 'test-device.local');
    assert.equal(signal.ice.port, 1234);
    assert.equal(signal.sdp.type, 'offer');
    assert.equal(signal.sessionId, 'tab:1');
    const output = JSON.stringify(t.logs);
    for (const secret of ['secret-password', 'secret-fragment', 'private-shared-text']) assert.ok(!output.includes(secret));
});
