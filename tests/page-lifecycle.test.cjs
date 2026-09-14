const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

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
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    }
    const context = vm.createContext({
        window, WebSocket: Socket,
        document: { hidden: false, addEventListener() {} },
        location: { protocol: 'https:', host: 'snapdrop.test', pathname: '/' },
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        console: { log() {}, error() {} },
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); }
    });
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
    assert.equal(old.sent.length, 1);
    assert.equal(old.sent[0].type, 'disconnect');
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
