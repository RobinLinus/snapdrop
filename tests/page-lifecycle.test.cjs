const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const MessagePack = require('@msgpack/msgpack');

function setup() {
    const handlers = new Map(), sockets = [], timers = new Map();
    let nextTimer = 0;
    const window = {
        URL: {},
        addEventListener(type, fn) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(fn);
        },
        dispatchEvent(event) { for (const fn of handlers.get(event.type) || []) fn(event); }
    };
    class Socket {
        constructor() { this.OPEN = 1; this.CONNECTING = 0; this.readyState = 0; this.sent = []; sockets.push(this); }
        send(data) { this.sent.push(MessagePack.decode(data)); }
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    }
    const context = vm.createContext({
        window, WebSocket: Socket, MessagePack,
        document: { hidden: false, addEventListener() {} },
        location: { protocol: 'https:', host: 'snapdrop.test', pathname: '/' },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        console: { log() {}, error() {} },
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
    vm.runInContext(fs.readFileSync('client/scripts/protocol.js', 'utf8') + '\nthis.protocol = SnapdropProtocol;', context);
    vm.runInContext(fs.readFileSync('client/scripts/network.js', 'utf8') + '\nthis.connection = new ServerConnection();', context);
    return { ...context, sockets, timers };
}

test('restoring the page reconnects even without a visibilitychange event', () => {
    const t = setup();
    const old = t.sockets[0];
    old.readyState = 1;
    t.window.dispatchEvent({ type: 'pagehide' });
    t.window.dispatchEvent({ type: 'beforeunload' });
    assert.equal(old.readyState, 3);
    assert.equal(old.sent.length, 0); // The WebSocket close frame handles departure.
    assert.equal(t.timers.size, 0);
    t.window.dispatchEvent({ type: 'pageshow', persisted: true });
    t.window.dispatchEvent({ type: 'pageshow', persisted: true });
    assert.equal(t.sockets.length, 2);
});

test('delayed callbacks from the previous socket cannot affect the new session', () => {
    const t = setup();
    const old = t.sockets[0];
    const close = old.onclose, message = old.onmessage;
    let delivered = 0;
    t.window.addEventListener('peers', () => delivered++);
    t.window.dispatchEvent({ type: 'pagehide' });
    t.window.dispatchEvent({ type: 'pageshow', persisted: true });
    close();
    message({ data: JSON.stringify({ type: 'peers', peers: [] }) });
    assert.equal(t.connection._socket, t.sockets[1]);
    assert.equal(t.timers.size, 0);
    assert.equal(delivered, 0);
});

test('leaving during a reconnect delay cancels the background reconnect', () => {
    const t = setup();
    t.sockets[0].close();
    assert.equal(t.timers.size, 1);
    t.window.dispatchEvent({ type: 'pagehide' });
    assert.equal(t.timers.size, 0);
    t.window.dispatchEvent({ type: 'pageshow', persisted: true });
    assert.equal(t.sockets.length, 2);
});

test('the client learns its identity before discovery and rejects self discovery and signaling', () => {
    const t = setup();
    const socket = t.sockets[0];
    socket.readyState = 1;
    const received = [];
    for (const type of ['peer-identity', 'peers', 'peer-joined', 'signal']) {
        t.window.addEventListener(type, event => received.push({ type, detail: event.detail }));
    }
    const phone = '11111111-1111-4111-8111-111111111111';
    const mac = '22222222-2222-4222-8222-222222222222';
    const connection = '33333333-3333-4333-8333-333333333333';
    const bytes = id => t.protocol.bytes(id);
    const peer = id => [bytes(id), bytes(connection), 'Device', 0, true];
    function message(value) { socket.onmessage({ data: MessagePack.encode(value) }); }
    message({ i: [bytes(phone), bytes(connection), 'Coral iPhone', 'iPhone'] });
    message({ p: [peer(phone), peer(mac)] });
    message({ j: peer(phone) });
    message({ r: [bytes(phone), bytes(connection), MessagePack.encode({ type: 'signal' })] });
    assert.equal(received[0].type, 'peer-identity');
    assert.deepEqual(Array.from(received[1].detail, peer => peer.id), [mac]);
    assert.equal(received.length, 2);
    t.connection.send({ type: 'signal', to: phone });
    assert.equal(socket.sent.length, 0);
    assert.equal(t.connection.nextSessionId(), connection + ':1');
    assert.equal(t.connection.nextSessionId(), connection + ':2');
});
