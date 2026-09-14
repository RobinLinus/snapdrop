const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const MessagePack = require('@msgpack/msgpack');
const WebSocket = require('ws');
const { startServer } = require('./helpers/server.cjs');
let server;
before(async () => { server = await startServer(); });
after(async () => { if (server) await server.stop(); });
const bytes = id => Buffer.from(id.replace(/-/g, ''), 'hex');

class Client extends EventEmitter {
    constructor(ip, id = randomUUID()) {
        super();
        this.id = id;
        this.messages = [];
        this.socket = new WebSocket(`ws://${server.address}/server/webrtc`, {
            headers: { Cookie: `other=1; peerid=${id}`, 'X-Forwarded-For': ip, 'User-Agent': 'Macintosh Chrome/1' }
        });
        this.closed = new Promise(resolve => this.socket.once('close', resolve));
        this.socket.on('error', () => {});
        this.socket.on('message', (data, binary) => {
            assert.equal(binary, true);
            this.messages.push(MessagePack.decode(Uint8Array.from(data)));
            this.emit('received');
        });
    }
    async next(predicate, timeout = 2500) {
        const take = () => {
            const index = this.messages.findIndex(predicate);
            return index < 0 ? undefined : this.messages.splice(index, 1)[0];
        };
        const found = take();
        if (found) return found;
        return new Promise((resolve, reject) => {
            const listener = () => { const result = take(); if (result) { cleanup(); resolve(result); } };
            const timer = setTimeout(() => { cleanup(); reject(new Error('Expected message not received')); }, timeout);
            const cleanup = () => { clearTimeout(timer); this.off('received', listener); };
            this.on('received', listener);
        });
    }
    async ready() {
        const { i } = await this.next(m => m.i);
        assert.deepEqual(i[0], Uint8Array.from(bytes(this.id)));
        this.connection = i[1];
        this.name = i[2];
        return this;
    }
    send(to, payload) { this.socket.send(MessagePack.encode([to.connection, payload])); }
    async close() { this.socket.close(); await this.closed; }
}
async function client(t, ip, id) {
    const peer = new Client(ip, id);
    t.after(() => peer.close());
    return peer.ready();
}

test('Rust discovery and text relay interoperate with standard JavaScript MessagePack', async t => {
    const alice = await client(t, '192.0.2.1');
    const bob = await client(t, '192.0.2.1');
    const joined = (await alice.next(m => m.j)).j;
    assert.deepEqual(joined[0], Uint8Array.from(bytes(bob.id)));
    assert.deepEqual(joined[1], bob.connection);
    const snapshot = (await bob.next(m => m.p)).p;
    assert.equal(snapshot.length, 1);
    const payload = MessagePack.encode({ type: 'text', text: 'Private test 🌍 日本語' });
    alice.send(bob, payload);
    const { r } = await bob.next(m => m.r);
    assert.deepEqual(r[0], Uint8Array.from(bytes(alice.id)));
    assert.deepEqual(r[1], alice.connection);
    assert.deepEqual(r[2], payload);
    assert.equal(server.output().includes('Private test'), false);
});

test('relay forwards completely opaque payloads, without parsing SDP, ICE, text, or sessions', async t => {
    const a = await client(t, '192.0.2.2');
    const b = await client(t, '192.0.2.2');
    const payload = Uint8Array.of(0xc1, 0xff, 0x00, 0x80);
    a.send(b, payload);
    assert.deepEqual((await b.next(m => m.r)).r[2], payload);
});

test('traffic remains pinned to a tab as new tabs join and old tabs leave', async t => {
    const a = await client(t, '192.0.2.3');
    const b1 = await client(t, '192.0.2.3');
    const b2 = await client(t, '192.0.2.3', b1.id);
    assert.equal(b1.name, b2.name);
    const changed = (await a.next(m => m.u)).u;
    assert.deepEqual(changed[0][1], b2.connection);
    a.send(b1, Uint8Array.of(1));
    assert.deepEqual((await b1.next(m => m.r)).r[2], Uint8Array.of(1));
    assert.equal(b2.messages.some(m => m.r), false);
    await b1.close();
    const left = (await a.next(m => m.u && m.u[1])).u;
    assert.deepEqual(left[1], b1.connection);
    a.send(b1, Uint8Array.of(2));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(b2.messages.some(m => m.r), false);
    a.send(b2, Uint8Array.of(3));
    assert.deepEqual((await b2.next(m => m.r)).r[2], Uint8Array.of(3));
});

test('same-identity and cross-room traffic is not forwarded', async t => {
    const a = await client(t, '192.0.2.4');
    const anotherTab = await client(t, '192.0.2.4', a.id);
    const elsewhere = await client(t, '192.0.2.5');
    a.send(anotherTab, Uint8Array.of(1));
    a.send(elsewhere, Uint8Array.of(2));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(anotherTab.messages.some(m => m.r), false);
    assert.equal(elsewhere.messages.some(m => m.r), false);
});

test('malformed, oversized, and JSON messages close only the offending connection', async t => {
    const healthy = await client(t, '192.0.2.6');
    for (const malformed of [Uint8Array.of(0xc1), '{"type":"pong"}',
        MessagePack.encode([bytes(randomUUID()), new Uint8Array(61 * 1024)]),
        Buffer.concat([MessagePack.encode([bytes(randomUUID()), Uint8Array.of(1)]), Buffer.from([0])])]) {
        const bad = await client(t, '192.0.2.6');
        bad.socket.send(malformed);
        assert.equal(await bad.closed, 1008);
    }
    const other = await client(t, '192.0.2.6');
    healthy.send(other, Uint8Array.of(42));
    assert.deepEqual((await other.next(m => m.r)).r[2], Uint8Array.of(42));
    assert.equal((await fetch(`http://${server.address}/healthz`)).status, 200);
});

test('native WebSocket ping/pong works without application heartbeat messages', async t => {
    const a = await client(t, '192.0.2.7');
    const pong = once(a.socket, 'pong');
    a.socket.ping('probe');
    assert.equal((await pong)[0].toString(), 'probe');
});

test('message-rate limits leave the process available', { timeout: 5000 }, async t => {
    const a = await client(t, '192.0.2.8');
    const packet = MessagePack.encode([bytes(randomUUID()), Uint8Array.of(1)]);
    for (let i = 0; i < 250; i++) a.socket.send(packet);
    assert.equal(await a.closed, 1008);
    assert.equal((await fetch(`http://${server.address}/readyz`)).status, 200);
});

test('admission caps recover after disconnect and shutdown closes live sockets', { timeout: 10000 }, async () => {
    const limited = await startServer({ MAX_CONNECTIONS: '3', MAX_ROOM_CONNECTIONS: '2' });
    const sockets = [];
    const connect = async ip => {
        const socket = new WebSocket(`ws://${limited.address}/server/webrtc`, { headers: { 'X-Forwarded-For': ip } });
        sockets.push(socket);
        await once(socket, 'open');
        return socket;
    };
    try {
        const a = await connect('192.0.2.10');
        const b = await connect('192.0.2.10');
        const roomOverflow = await connect('192.0.2.10');
        assert.equal((await once(roomOverflow, 'close'))[0], 1008);
        const c = await connect('192.0.2.11');
        assert.equal((await fetch(`http://${limited.address}/readyz`)).status, 503);
        const overflow = new WebSocket(`ws://${limited.address}/server/webrtc`);
        overflow.on('error', () => {});
        const rejected = once(overflow, 'unexpected-response');
        const [, response] = await rejected;
        assert.equal(response.statusCode, 503);
        response.resume(); overflow.terminate();
        const closed = once(c, 'close'); c.close(); await closed;
        assert.equal((await fetch(`http://${limited.address}/readyz`)).status, 200);
        const closing = [once(a, 'close'), once(b, 'close')];
        await limited.stop();
        assert.deepEqual((await Promise.all(closing)).map(args => args[0]), [1001, 1001]);
    } finally {
        for (const socket of sockets) socket.terminate();
        await limited.stop();
    }
});
