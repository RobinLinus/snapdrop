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
    class Socket extends EventEmitter {
        constructor() {
            super();
            this.messages = [];
        }
        send(message, callback) {
            this.messages.push(JSON.parse(message));
            callback();
        }
        terminate() {
            this.terminated = true;
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
        setTimeout() { return 1; },
        clearTimeout() {}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8')
        + '\nthis.server = server;', context);
    const server = context.server;
    function connect(id, ip = '192.0.2.1', ua = { os: { name: 'Mac OS' } }) {
        const socket = new Socket();
        server._wss.emit('connection', socket, {
            peerId: id,
            url: '/webrtc',
            headers: { 'user-agent': JSON.stringify(ua) },
            connection: { remoteAddress: ip }
        });
        return { peer: Object.values(server._rooms[ip]).find(peer => peer.socket === socket), socket };
    }
    return { server, connect };
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
