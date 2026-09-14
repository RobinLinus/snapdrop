const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
    const connections = [], errors = [], sent = [], events = [];
    const timers = new Map();
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
        window: { URL: {}, addEventListener() {}, dispatchEvent(event) { events.push(event); } },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        console: { log() {}, error(error) { errors.push(error); } },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        RTCPeerConnection: Connection,
        RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
        RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } },
    });
    vm.runInContext(fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.RTCPeer = RTCPeer; this.PeersManager = PeersManager;', context);
    return { ...context, connections, errors, sent, events, timers, server: { send(message) { sent.push(message); } } };
}

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

test('diagnostics capture ICE checks and DTLS without copying addresses or SDP', async () => {
    const t = setup();
    const peer = new t.RTCPeer(t.server, 'peer');
    await peer._operations;
    const conn = t.connections[0];
    conn.connectionState = 'failed';
    conn.iceConnectionState = 'failed';
    conn.iceGatheringState = 'complete';
    conn.localDescription.sdp = 'sensitive-session-description';
    conn.getStats = async () => new Map([
        ['local', { type: 'local-candidate', candidateType: 'host', protocol: 'udp', address: '192.168.1.2' }],
        ['remote', { type: 'remote-candidate', candidateType: 'host', protocol: 'udp', address: 'private-device.local' }],
        ['pair', { type: 'candidate-pair', localCandidateId: 'local', remoteCandidateId: 'remote', state: 'failed', requestsSent: 7, responsesReceived: 0 }],
        ['transport', { type: 'transport', dtlsState: 'new', iceState: 'failed' }]
    ]);
    const report = await peer._reportDiagnostics(conn, 'test');
    assert.equal(report.pairs[0].requestsSent, 7);
    assert.equal(report.pairs[0].responsesReceived, 0);
    assert.equal(report.pairs[0].local.addressKind, 'ipv4');
    assert.equal(report.pairs[0].remote.addressKind, 'mdns');
    assert.equal(report.transports[0].dtlsState, 'new');
    assert.equal(report.localDescription, 'offer');
    const json = JSON.stringify(report);
    for (const value of ['192.168.1.2', 'private-device.local', 'sensitive-session-description']) {
        assert.ok(!json.includes(value));
    }
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
