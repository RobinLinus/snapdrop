const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const names = require('../server/device-names');

test('device labels use recognizable names instead of browser names or model codes', () => {
    const cases = [
        [{ device: { model: 'iPhone', type: 'mobile' }, os: { name: 'iOS' } }, 'iPhone'],
        [{ device: { model: 'iPad', type: 'tablet' }, os: { name: 'iOS' } }, 'iPad'],
        [{ device: { model: 'iPod', type: 'mobile' }, os: { name: 'iOS' } }, 'iPod'],
        [{ device: { model: 'SM-S918B', type: 'mobile' }, os: { name: 'Android' } }, 'Android Phone'],
        [{ device: { type: 'tablet' }, os: { name: 'Android' } }, 'Android Tablet'],
        [{ device: { type: 'tablet' }, os: { name: 'Windows' } }, 'Tablet'],
        [{ device: { type: 'mobile' }, os: { name: 'Windows Phone' } }, 'Phone'],
        [{ os: { name: 'Mac OS' } }, 'Mac'],
        [{ os: { name: 'Windows' } }, 'Windows PC'],
        [{ os: { name: 'Chrome OS' } }, 'Chromebook'],
        [{ os: { name: 'Linux' } }, 'Linux PC'],
        [{ os: { name: 'Ubuntu' } }, 'Linux PC'],
        [{ device: { type: 'smarttv' }, os: { name: 'Android' } }, 'TV'],
        [{}, 'Device']
    ];
    for (const [ua, expected] of cases) {
        assert.equal(names.getDeviceLabel(ua), expected);
    }
});

test('colliding identities try other colors before numbered names, without duplicates', () => {
    // These distinct IDs have the same hash and therefore prefer the same color.
    assert.equal(names.getDisplayName('Aa', 'Mac'), names.getDisplayName('BB', 'Mac'));
    const used = new Set();
    const first = names.getDisplayName('Aa', 'Mac', used);
    used.add(first);
    const second = names.getDisplayName('BB', 'Mac', used);
    assert.notEqual(second, first);
    assert.match(second, /^[A-Za-z]+ Mac$/);
    used.add(second);

    for (let i = 0; i < 200; i++) {
        const name = names.getDisplayName('Aa', 'Mac', used);
        assert.ok(!used.has(name));
        assert.match(name, /^[A-Za-z]+ Mac(?: [2-9][0-9]*| 1[0-9]+)?$/);
        used.add(name);
    }
    assert.ok([...used].some(name => / Mac 2$/.test(name)));
    // Releasing a name makes it available without changing existing peers.
    used.delete(first);
    assert.equal(names.getDisplayName('Aa', 'Mac', used), first);
    assert.equal(names.getDisplayName('Aa', 'iPhone', used), first.replace('Mac', 'iPhone'));
});

function setup() {
    const timers = new Map();
    let nextTimer = 0;
    class Socket extends EventEmitter {
        constructor() {
            super();
            this.messages = [];
            this.OPEN = 1;
            this.readyState = 1;
        }
        send(message, callback) {
            this.messages.push(JSON.parse(message));
            callback();
        }
        terminate() {
            this.terminated = true;
            this.readyState = 3;
            this.emit('close');
        }
    }
    const context = vm.createContext({
        require(name) {
            if (name === 'process') return { on() {}, env: {} };
            if (name === 'ua-parser-js') return value => ({ device: {}, os: {}, browser: {}, ...JSON.parse(value) });
            if (name === './device-names') return names;
            if (name === 'ws') return { Server: class extends EventEmitter {} };
            throw Error('Unexpected module: ' + name);
        },
        console: { log() {}, error() {} },
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')
        + '\nthis.server = server; this.Peer = Peer;', context);
    const server = context.server;
    function connect(id, ip = '192.0.2.1', ua = { os: { name: 'Mac OS' } }) {
        const socket = new Socket();
        server._wss.emit('connection', socket, {
            peerId: id,
            url: '/webrtc',
            headers: { 'user-agent': JSON.stringify(ua) },
            connection: { remoteAddress: ip }
        });
        return { peer: Object.values(server._rooms[ip]).flatMap(group => [...group.connections]).find(peer => peer.socket === socket), socket };
    }
    return { server, connect, timers, Peer: context.Peer };
}

test('a crowded room announces unique names consistently to the owner and every observer', () => {
    const { connect } = setup();
    const clients = Array.from({ length: 100 }, (_, i) => connect('peer-' + i));
    const displayNames = clients.map(({ peer }) => peer.name.displayName);
    assert.equal(new Set(displayNames).size, clients.length);
    assert.ok(displayNames.some(name => / Mac 2$/.test(name)));

    for (const { peer, socket } of clients) {
        const ownName = socket.messages.find(message => message.type === 'display-name');
        assert.equal(ownName.message.displayName, peer.name.displayName);
        const visible = socket.messages.flatMap(message => message.type === 'peers' ? message.peers
            : message.type === 'peer-joined' ? [message.peer] : []);
        assert.equal(visible.length, clients.length - 1);
        assert.equal(new Set([ownName.message.displayName, ...visible.map(other => other.name.displayName)]).size, clients.length);
        for (const other of visible) {
            assert.equal(other.name.displayName, clients.find(client => client.peer.id === other.id).peer.name.displayName);
        }
    }
});

test('names are unique within a room and remain independent across rooms', () => {
    const { connect } = setup();
    const first = connect('Aa');
    const second = connect('BB');
    const elsewhere = connect('BB', '192.0.2.2');
    assert.notEqual(first.peer.name.displayName, second.peer.name.displayName);
    assert.equal(first.peer.name.displayName, elsewhere.peer.name.displayName);
});

test('concurrent tabs keep the same peer identity and allocated name', () => {
    const { server, connect } = setup();
    const first = connect('Aa');
    const other = connect('BB');
    const tabs = Array.from({ length: 20 }, () => connect('BB'));
    for (const tab of tabs) {
        assert.equal(tab.peer.id, other.peer.id);
        assert.equal(tab.peer.name.displayName, other.peer.name.displayName);
        assert.equal(tab.socket.messages.find(message => message.type === 'display-name').message.displayName,
            other.peer.name.displayName);
    }
    assert.equal(Object.keys(server._rooms[first.peer.ip]).length, 2);
    assert.notEqual(first.peer.name.displayName, other.peer.name.displayName);
    assert.equal(other.socket.terminated, undefined);
    for (const tab of [other, ...tabs]) {
        assert.equal(tab.socket.messages[0].type, 'display-name');
        assert.equal(tab.socket.messages[0].message.id, 'BB');
        assert.ok(!tab.socket.messages.some(message => message.type === 'peer-joined' && message.peer.id === 'BB'));
        assert.ok(!tab.socket.messages.find(message => message.type === 'peers').peers.some(peer => peer.id === 'BB'));
    }
    assert.equal(first.socket.messages.filter(message => message.type === 'peer-joined' && message.peer.id === 'BB').length, 1);
});

test('departed peers release their names without renaming connected devices', () => {
    const { server, connect } = setup();
    const first = connect('Aa');
    const other = connect('BB');
    const otherName = other.peer.name.displayName;
    first.socket.emit('message', JSON.stringify({ type: 'disconnect' }));
    assert.equal(server._rooms[first.peer.ip].Aa, undefined);
    assert.equal(other.socket.messages.at(-1).type, 'peer-left');
    const reconnected = connect('Aa');
    assert.equal(reconnected.peer.name.displayName, first.peer.name.displayName);
    assert.equal(other.peer.name.displayName, otherName);

    other.socket.emit('message', JSON.stringify({ type: 'disconnect' }));
    reconnected.socket.emit('message', JSON.stringify({ type: 'disconnect' }));
    assert.equal(server._rooms[first.peer.ip], undefined);
});


test('late disconnect, close and heartbeat from the old socket cannot evict a reopened device', () => {
    const { server, connect } = setup();
    const observer = connect('observer');
    const old = connect('phone');
    const current = connect('phone');
    const room = server._rooms[current.peer.ip];
    const visible = current.socket.messages.find(message => message.type === 'peers').peers;
    assert.ok(!visible.some(peer => peer.id === 'phone'));
    observer.socket.messages.length = 0;
    old.socket.emit('message', JSON.stringify({ type: 'disconnect' }));
    old.socket.emit('close');
    old.peer.lastBeat = 1;
    server._keepAlive(old.peer);
    assert.equal(room.phone, current.peer);
    assert.equal(current.socket.terminated, undefined);
    assert.equal(observer.socket.messages.filter(message => message.type === 'peer-left').length, 0);
    current.socket.emit('close');
    assert.equal(room.phone, undefined);
    assert.equal(observer.socket.messages.filter(message => message.type === 'peer-left').length, 1);
});

test('every live tab receives discovery updates and only the last departure removes the peer', () => {
    const { connect } = setup();
    const first = connect('phone');
    const second = connect('phone');
    const mac = connect('mac');
    for (const tab of [first, second]) {
        assert.equal(tab.socket.messages.filter(message => message.type === 'peer-joined' && message.peer.id === 'mac').length, 1);
    }
    first.socket.emit('close');
    assert.equal(mac.socket.messages.filter(message => message.type === 'peer-left').length, 0);
    second.socket.emit('close');
    second.socket.emit('error', Error('late error'));
    assert.equal(mac.socket.messages.filter(message => message.type === 'peer-left').length, 1);
});

test('dead sockets are terminated and lose their heartbeat without affecting healthy tabs', () => {
    for (const failure of ['close', 'error', 'disconnect', 'timeout', 'send-error']) {
        const { server, connect, timers } = setup();
        const old = connect('phone');
        const healthy = connect('phone');
        const oldTimer = old.peer.timerId;
        const healthyTimer = healthy.peer.timerId;
        const lateHeartbeat = timers.get(oldTimer);
        if (failure === 'timeout') {
            old.peer.lastBeat = Date.now() - 60001;
            server._keepAlive(old.peer);
        } else if (failure === 'disconnect') old.socket.emit('message', '{"type":"disconnect"}');
        else if (failure === 'send-error') {
            old.socket.send = (message, callback) => callback(Error('broken socket'));
            server._send(old.peer, { type: 'ping' });
        } else old.socket.emit(failure, Error('disconnected'));
        lateHeartbeat();
        assert.equal(old.socket.terminated, true, failure);
        assert.equal(old.peer.closed, true, failure);
        assert.equal(old.peer.timerId, 0, failure);
        assert.equal(timers.has(oldTimer), false, failure);
        assert.equal(timers.has(healthyTimer), true, failure);
        assert.equal(healthy.peer.connections.size, 1, failure);
        assert.equal(server._rooms[healthy.peer.ip].phone, healthy.peer, failure);
    }
});

test('tab-specific signaling stays on its connection when other tabs join', () => {
    const { connect } = setup();
    const first = connect('phone');
    const second = connect('phone');
    const receiver = connect('mac');
    function send(client, message) { client.socket.emit('message', JSON.stringify({ type: 'signal', ...message })); }
    send(first, { to: 'mac', sessionId: 'first-transfer', sdp: 'offer one' });
    send(second, { to: 'mac', sessionId: 'second-transfer', sdp: 'offer two' });
    const offers = receiver.socket.messages.filter(message => message.type === 'signal');
    assert.equal(offers[0].senderSession, first.peer.connectionId);
    assert.equal(offers[1].senderSession, second.peer.connectionId);
    const anotherReceiver = connect('mac');
    send(first, { to: 'mac', sessionId: 'first-transfer', ice: 'candidate' });
    assert.equal(receiver.socket.messages.at(-1).ice, 'candidate');
    assert.equal(anotherReceiver.socket.messages.filter(message => message.type === 'signal').length, 0);
    send(receiver, { to: 'phone', toSession: offers[0].senderSession, sessionId: 'first-transfer', sdp: 'answer one' });
    send(receiver, { to: 'phone', toSession: offers[1].senderSession, sessionId: 'second-transfer', sdp: 'answer two' });
    assert.equal(first.socket.messages.at(-1).sdp, 'answer one');
    assert.equal(second.socket.messages.at(-1).sdp, 'answer two');

    first.socket.emit('close');
    assert.equal(receiver.socket.messages.at(-1).disconnected, true);
    assert.equal(receiver.socket.messages.at(-1).sessionId, 'first-transfer');
    const count = second.socket.messages.length;
    send(receiver, { to: 'phone', toSession: offers[0].senderSession, sessionId: 'first-transfer', sdp: 'late answer' });
    send(first, { to: 'mac', sessionId: 'first-transfer', sdp: 'stale offer' });
    assert.equal(second.socket.messages.length, count);
    assert.equal(receiver.socket.messages.at(-1).disconnected, true);
    assert.equal([...receiver.peer.routes.values()].some(route => route.peer === first.peer), false);
});

test('self-signaling is discarded and cookie identity is parsed independently of other cookies', () => {
    const { connect, server, Peer } = setup();
    const tab = connect('phone');
    const count = tab.socket.messages.length;
    tab.socket.emit('message', '{"type":"signal","to":"phone"}');
    assert.equal(tab.socket.messages.length, count);
    const id = 'c46f0d04-c460-4cf5-8ff3-74d0b83b1b3d';
    for (const cookie of ['peerid=' + id, 'theme=dark; peerid=' + id + '; preference=yes']) {
        assert.equal(Peer.cookieId(cookie), id);
        const headers = [];
        server._onHeaders(headers, { headers: { cookie } });
        assert.equal(headers.length, 0);
    }
    for (const cookie of [undefined, 'otherpeerid=' + id, 'peerid=bad', 'peerid=']) {
        const request = { headers: { cookie } };
        const headers = [];
        server._onHeaders(headers, request);
        assert.ok(request.peerId);
        assert.ok(headers[0].startsWith('Set-Cookie: peerid=' + request.peerId));
    }
});

test('an older client can reply without echoing the negotiation ID', () => {
    const { connect } = setup();
    const caller = connect('phone');
    const receiver = connect('mac');
    caller.socket.emit('message', JSON.stringify({ type: 'signal', to: 'mac', sessionId: 'transfer', sdp: 'offer' }));
    const otherTab = connect('phone');
    receiver.socket.emit('message', JSON.stringify({ type: 'signal', to: 'phone', sdp: 'answer' }));
    assert.equal(caller.socket.messages.at(-1).sdp, 'answer');
    assert.equal(caller.socket.messages.at(-1).sessionId, 'transfer');
    assert.equal(otherTab.socket.messages.filter(message => message.type === 'signal').length, 0);
});
