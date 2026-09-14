const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(getUserMedia, stored = null) {
    const calls = [], handlers = {};
    const elements = new Map();
    const context = vm.createContext({
        Dialog: class { show() { calls.push('show'); } hide() { calls.push('hide'); } },
        $: id => {
            if (!elements.has(id)) elements.set(id, { addEventListener() {} });
            return elements.get(id);
        },
        Events: { on(name, handler) { handlers[name] = handler; }, fire(name) { calls.push(name); } },
        navigator: { userAgent: 'Chrome/150', mediaDevices: { getUserMedia } },
        sessionStorage: { getItem() { return stored; }, setItem(k, value) { stored = value; } },
        window: { location: { reload() { calls.push('reload'); } } }
    });
    const source = fs.readFileSync('client/scripts/ui.js', 'utf8');
    vm.runInContext(source.slice(source.indexOf('class ConnectionRecoveryDialog'), source.indexOf('class ReceiveDialog')) + '\nthis.dialog = new ConnectionRecoveryDialog();', context);
    return { dialog: context.dialog, fail: handlers['connection-failed'], calls };
}

test('failures offer recovery once without activating microphone automatically', () => {
    const t = setup(() => { throw Error('must require click'); });
    t.fail(); t.fail(); t.dialog.hide(); t.fail();
    assert.deepEqual(t.calls, ['show', 'hide']);
    const reloaded = setup(() => {}, 'offered');
    reloaded.fail();
    assert.deepEqual(reloaded.calls, []);
});

test('permission success stops all capture tracks before retrying connections', async () => {
    const t = setup(async constraints => {
        assert.equal(constraints.audio, true);
        assert.equal(constraints.video, undefined);
        return { getTracks: () => [1, 2].map(n => ({ stop: () => t.calls.push(`stop${n}`) })) };
    });
    t.fail(); await t.dialog._retry();
    assert.deepEqual(t.calls, ['show', 'stop1', 'stop2', 'hide', 'retry-failed-connections']);
});

test('denial is recoverable and does not reload or automatically reprompt', async () => {
    let requests = 0;
    const t = setup(async () => { requests++; throw { name: 'NotAllowedError' }; });
    t.fail(); await t.dialog._retry(); t.fail();
    assert.equal(requests, 1);
    assert.match(t.dialog.$status.textContent, /not allowed/);
    assert.equal(t.dialog.$retry.disabled, false);
    assert.deepEqual(t.calls, ['show']);
});

test('dismissing a pending request still stops capture if permission arrives later', async () => {
    let grant;
    const t = setup(() => new Promise(resolve => { grant = resolve; }));
    t.fail();
    const pending = t.dialog._retry();
    await t.dialog._retry(); // Double click must not create another request.
    t.dialog.hide();
    grant({ getTracks: () => [{ stop: () => t.calls.push('stop') }] });
    await pending;
    assert.deepEqual(t.calls, ['show', 'hide', 'stop']);
});
