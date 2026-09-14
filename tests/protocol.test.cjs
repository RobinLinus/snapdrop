const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const MessagePack = require('@msgpack/msgpack');
const context = vm.createContext({ MessagePack });
vm.runInContext(readFileSync('client/scripts/protocol.js', 'utf8') + '\nthis.protocol = SnapdropProtocol;', context);
const protocol = context.protocol;
const alice = '11111111-1111-4111-8111-111111111111';
const tab = '22222222-2222-4222-8222-222222222222';

test('client envelope contains only the recipient and opaque MessagePack payload', () => {
    const candidate = Object.create({ candidate: 'candidate:abc', sdpMid: null, sdpMLineIndex: 0, usernameFragment: 'u' });
    const message = { type: 'signal', to: alice, toSession: tab, sessionId: 'negotiation', ice: candidate };
    const [recipient, payload] = MessagePack.decode(protocol.encode(tab, message));
    assert.equal(protocol.id(recipient), tab);
    assert.deepEqual(MessagePack.decode(payload), { type: 'signal', sessionId: 'negotiation',
        ice: { candidate: 'candidate:abc', sdpMid: null, sdpMLineIndex: 0, usernameFragment: 'u' } });
});

test('browser decodes text and takes sender identity only from the relay envelope', () => {
    const inner = MessagePack.encode({ type: 'text', text: 'Hello 🌍 日本語', sender: 'forged', senderSession: 'forged' });
    const result = protocol.decode(MessagePack.encode({ r: [protocol.bytes(alice), protocol.bytes(tab), inner] }));
    assert.equal(result.text, 'Hello 🌍 日本語');
    assert.equal(result.sender, alice);
    assert.equal(result.senderSession, tab);
});

test('browser rejects relayed discovery injection and malformed binary payloads', () => {
    for (const payload of [MessagePack.encode({ type: 'peers', peers: [] }), Uint8Array.of(0xc1)]) {
        assert.throws(() => protocol.decode(MessagePack.encode({ r: [protocol.bytes(alice), protocol.bytes(tab), payload] })));
    }
    assert.throws(() => protocol.decode('{"type":"peers"}'));
    assert.throws(() => protocol.encode(tab, { type: 'text', text: 'x'.repeat(64 * 1024) }));
});

test('discovery carries only identity, target connection, display name, icon, and RTC capability', () => {
    const peer = [protocol.bytes(alice), protocol.bytes(tab), 'Blue iPhone', 1, true];
    const result = protocol.decode(MessagePack.encode({ p: [peer] }));
    assert.equal(result.peers[0].id, alice);
    assert.equal(result.peers[0].connectionId, tab);
    assert.equal(result.peers[0].name.type, 'mobile');
});
