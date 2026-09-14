const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

function eventTarget() {
    const handlers = new Map();
    return {
        handlers,
        addEventListener(type, handler) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type).add(handler);
        },
        removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
        async emit(type, event = {}) {
            for (const handler of [...handlers.get(type) || []]) await handler(event);
        }
    };
}

function setup({ permission = 'granted', mobile = false, supported = true, secure = true, registration } = {}) {
    const shown = [], notices = [], actions = [], timers = new Map();
    const button = { ...eventTarget(), hidden: true };
    const document = { ...eventTarget(), visibilityState: 'hidden', focused: false,
        hasFocus() { return this.focused; },
        querySelector: () => ({ click: () => actions.push('download') }) };
    class Notification {
        static permission = permission;
        static async requestPermission() { return this.permission; }
        constructor(title, options) {
            if (mobile) throw new TypeError('Use ServiceWorkerRegistration.showNotification');
            this.title = title;
            this.options = options;
            shown.push(this);
        }
        close() { this.closed = true; this.onclose?.(); }
    }
    const window = { ...eventTarget(), isSecureContext: secure, isDownloadSupported: true,
        location: { href: 'https://snapdrop.test/' },
        serviceWorkerReady: registration,
        focus() { actions.push('focus'); document.focused = true; },
        open(url) { actions.push(url); }
    };
    if (supported) window.Notification = Notification;
    const navigator = { clipboard: { async writeText(text) { actions.push(text); } } };
    const context = vm.createContext({ window, document, navigator, Notification, crypto, URL,
        setTimeout(fn) { timers.set(fn, fn); return fn; },
        clearTimeout(id) { timers.delete(id); },
        $: () => button,
        Events: {
            on: (type, handler) => window.addEventListener(type, handler),
            off: (type, handler) => window.removeEventListener(type, handler),
            fire: (type, detail) => notices.push({ type, detail })
        }
    });
    const source = fs.readFileSync('client/scripts/ui.js', 'utf8');
    vm.runInContext(source.slice(source.indexOf('const getURL'), source.indexOf('const playNotificationSound')), context);
    vm.runInContext(source.slice(source.indexOf('class Notifications'), source.indexOf('class NetworkStatusUI'))
        + '\nNotifications.PERMISSION_ERROR = "Notifications are blocked."; this.notifications = new Notifications();', context);
    return { ...context, button, shown, notices, actions, timers };
}

test('unsupported and insecure contexts keep the permission button hidden', () => {
    for (const options of [{ supported: false }, { secure: false }]) {
        const t = setup(options);
        assert.equal(t.button.hidden, true);
        assert.equal(t.window.handlers.size, 0);
    }
});

test('permission requests use the promise result and prevent duplicate prompts', async () => {
    const t = setup({ permission: 'default' });
    let grant, requests = 0;
    t.Notification.requestPermission = (...args) => {
        assert.equal(args.length, 0);
        requests++;
        return new Promise(resolve => { grant = resolve; });
    };
    assert.equal(t.button.hidden, false);
    let prevented = false;
    await t.button.emit('click', { preventDefault() { prevented = true; } });
    await t.notifications._requestPermission();
    assert.equal(prevented, true);
    assert.equal(requests, 1);
    t.Notification.permission = 'granted';
    grant('granted');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(t.button.hidden, true);
    assert.equal(t.shown.length, 1);
    assert.equal(t.shown[0].closed, undefined);
});

test('denial is explained, dismissal stays retryable, and request failures are caught', async () => {
    for (const permission of ['denied', 'default']) {
        const t = setup({ permission });
        await t.notifications._requestPermission();
        assert.equal(t.button.hidden, false);
        assert.equal(t.shown.length, 0);
        assert.equal(t.notices.length, permission === 'denied' ? 1 : 0);
    }
    const t = setup({ permission: 'default' });
    t.Notification.requestPermission = async () => { throw new Error('Unavailable'); };
    await t.notifications._requestPermission();
    assert.match(t.notices[0].detail, /Could not enable/);
    assert.equal(t.notifications._requesting, false);
});

test('receiving without permission does not construct or bind a notification', async () => {
    for (const permission of ['denied', 'default']) {
        const t = setup({ permission, mobile: true });
        await t.window.emit('text-received', { detail: { text: 'Hello' } });
        await t.window.emit('file-received', { detail: { name: 'photo.png' } });
        assert.equal(t.shown.length, 0);
        assert.equal(t.notices.length, 0);
    }
});

test('hidden tabs and visible unfocused windows notify; the active page stays quiet', async () => {
    for (const [visibilityState, focused, count] of [['hidden', false, 2], ['visible', false, 2], ['visible', true, 0]]) {
        const t = setup();
        Object.assign(t.document, { visibilityState, focused });
        await t.window.emit('text-received', { detail: { text: 'Hello' } });
        await t.window.emit('file-received', { detail: { name: 'photo.png' } });
        assert.equal(t.shown.length, count);
    }
});

test('returning to the page closes desktop notifications and releases listeners', async () => {
    const t = setup();
    await t.notifications._messageNotification('Hello');
    t.document.visibilityState = 'visible';
    await t.document.emit('visibilitychange');
    assert.equal(t.shown[0].closed, undefined); // Another window still has focus.
    t.document.focused = true;
    await t.window.emit('focus');
    assert.equal(t.shown[0].closed, true);
    assert.equal(t.document.handlers.get('visibilitychange').size, 0);
    assert.equal(t.window.handlers.get('focus').size, 1); // Permission refresh only.
    t.Notification.permission = 'denied';
    await t.window.emit('focus');
    assert.equal(t.button.hidden, false);
});

test('desktop clicks focus Snapdrop before copying, opening links, or downloading', async () => {
    const t = setup();
    await t.notifications._messageNotification('Hello');
    t.shown[0].onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(t.actions, ['focus', 'Hello']);
    assert.equal(t.shown[0].closed, true);
    assert.equal(t.notices.at(-1).detail, 'Copied to clipboard');
    await t.notifications._messageNotification('https://example.com/');
    t.shown[1].onclick();
    await t.notifications._downloadNotification('photo.png');
    t.shown[2].onclick();
    assert.deepEqual(t.actions.slice(2), ['focus', 'https://example.com/', 'focus', 'download']);
    t.navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied'); };
    await t.notifications._copyText('Hello');
    assert.match(t.notices.at(-1).detail, /Could not copy/);
});

test('notification copy waits for actual document focus and keeps the clicked message', async () => {
    const t = setup();
    t.window.focus = () => t.actions.push('focus-request');
    t.navigator.clipboard.writeText = async text => {
        if (!t.document.hasFocus()) throw new Error('Document is not focused');
        t.actions.push(text);
    };
    await t.notifications._messageNotification('Message from the clicked notification');
    t.shown[0].onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(t.notices, []);
    assert.deepEqual(t.actions, ['focus-request']);
    await t.window.emit('focus'); // Browser window can activate before its document.
    assert.deepEqual(t.actions, ['focus-request']);
    t.document.visibilityState = 'visible';
    t.document.focused = true;
    await t.window.emit('focus');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(t.actions, ['focus-request', 'Message from the clicked notification']);
    assert.equal(t.notices.at(-1).detail, 'Copied to clipboard');
    assert.equal(t.window.handlers.get('focus').size, 1);
    assert.equal(t.document.handlers.get('visibilitychange').size, 0);
});

test('copy abandons a failed focus request instead of copying on an unrelated later visit', async () => {
    const t = setup();
    const pending = t.notifications._copyText('Old message');
    assert.equal(t.actions.length, 0);
    assert.equal(t.timers.size, 1);
    t.timers.values().next().value();
    await pending;
    assert.match(t.notices.at(-1).detail, /Could not copy/);
    t.document.focused = true;
    await t.window.emit('focus');
    assert.equal(t.actions.length, 0);
    assert.equal(t.timers.size, 0);
    assert.equal(t.window.handlers.get('focus').size, 1);
    assert.equal(t.document.handlers.get('visibilitychange').size, 0);
});

test('copy in an already focused document writes in the click task', async () => {
    const t = setup();
    t.document.focused = true;
    const pending = t.notifications._copyText('Immediate copy');
    assert.deepEqual(t.actions, ['Immediate copy']);
    assert.equal(t.timers.size, 0);
    await pending;
});

test('mobile notifications wait for registration and close only their own notification', async () => {
    let ready, options;
    const closed = [];
    const registration = {
        async showNotification(title, config) { options = config; }, // Resolves undefined.
        async getNotifications(filter) {
            assert.equal(filter.tag, options.tag);
            return [{ close() { closed.push(filter.tag); } }];
        }
    };
    const t = setup({ mobile: true, registration: new Promise(resolve => { ready = resolve; }) });
    const pending = t.notifications._messageNotification('Hello');
    assert.equal(options, undefined);
    ready(registration);
    await pending;
    assert.equal(options.data.url, t.window.location.href);
    assert.match(options.body, /return to Snapdrop/);
    t.document.visibilityState = 'visible';
    t.document.focused = true;
    await t.document.emit('visibilitychange');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(closed, [options.tag]);
});

test('notification failures are contained when the worker is missing or rejects', async () => {
    for (const registration of [undefined, Promise.resolve(null), Promise.resolve({
        async showNotification() { throw new Error('Permission revoked'); }
    })]) {
        const t = setup({ mobile: true, registration });
        await t.notifications._messageNotification('Hello');
        await t.notifications._downloadNotification('photo.png');
        assert.equal(t.notices.length, 2);
        assert.match(t.notices[0].detail, /Could not show/);
    }
});

test('links request a persistent Open action and normalize www addresses', async () => {
    const shown = [];
    const t = setup({ registration: Promise.resolve({
        async showNotification(title, options) { shown.push({ title, options }); }
    }) });
    await t.notifications._messageNotification('www.example.com/path?q=1');
    assert.equal(t.shown.length, 0); // The desktop constructor cannot display action buttons.
    assert.equal(shown[0].options.data.link, 'https://www.example.com/path?q=1');
    assert.equal(shown[0].options.body, 'Click to open link');
    assert.equal(shown[0].options.actions.length, 1);
    assert.equal(shown[0].options.actions[0].action, 'open');
    assert.equal(shown[0].options.actions[0].title, 'Open');
});

test('unavailable persistent notifications keep links clickable on desktop', async () => {
    const t = setup({ registration: Promise.resolve(null) });
    await t.notifications._messageNotification('www.example.com');
    t.shown[0].onclick();
    assert.deepEqual(t.actions, ['focus', 'https://www.example.com/']);
    assert.equal(t.notices.length, 0);
});

test('non-web URLs and text containing links remain copyable messages', async () => {
    const t = setup();
    for (const message of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', 'https://example.com/ with a comment']) {
        await t.notifications._messageNotification(message);
        assert.equal(t.shown.at(-1).options.body, 'Click to copy text');
    }
});

test('a notification completing after the user returns is closed immediately', async () => {
    let shown, closed = 0;
    const t = setup({ mobile: true, registration: Promise.resolve({
        showNotification() { return new Promise(resolve => { shown = resolve; }); },
        async getNotifications() { return [{ close() { closed++; } }]; }
    }) });
    const pending = t.notifications._messageNotification('Hello');
    await new Promise(resolve => setImmediate(resolve));
    t.document.visibilityState = 'visible';
    t.document.focused = true;
    shown();
    await pending;
    assert.equal(closed, 1);
});

test('persistent notification clicks focus Snapdrop or reopen it within the worker scope', async () => {
    for (const [url, existing, expected] of [
        ['https://snapdrop.test/app/', true, 'focus'],
        ['https://snapdrop.test/app/', false, 'open'],
        ['https://example.com/', false, undefined],
        ['https://snapdrop.test/other/', false, undefined]
    ]) {
        const handlers = {}, actions = [];
        const self = {
            addEventListener(type, handler) { handlers[type] = handler; },
            location: { origin: 'https://snapdrop.test' },
            registration: { scope: 'https://snapdrop.test/app/' },
            clients: {
                async matchAll() { return existing ? [{ url, async focus() { actions.push('focus'); } }] : []; },
                async openWindow(target) { assert.equal(target, url); actions.push('open'); }
            }
        };
        vm.runInNewContext(fs.readFileSync('client/service-worker.js', 'utf8'), { self, URL });
        let pending;
        handlers.notificationclick({ notification: { data: { url }, close() { actions.push('close'); } },
            waitUntil(promise) { pending = promise; } });
        await pending;
        assert.deepEqual(actions, expected ? ['close', expected] : ['close']);
    }
});

test('Open and body clicks open the exact web link; unsafe URLs and unknown actions do nothing', async () => {
    for (const [link, action, expected] of [
        ['https://example.com/path?q=1#part', 'open', true],
        ['http://example.com/', '', true],
        ['javascript:alert(1)', 'open', false],
        ['data:text/html,test', '', false],
        ['/relative', 'open', false],
        ['https://example.com/', 'unknown', false]
    ]) {
        const handlers = {}, opened = [];
        const self = {
            addEventListener(type, handler) { handlers[type] = handler; },
            clients: { async openWindow(url) { opened.push(url); } }
        };
        vm.runInNewContext(fs.readFileSync('client/service-worker.js', 'utf8'), { self, URL });
        let pending, closed = false;
        handlers.notificationclick({ action, notification: { data: { link }, close() { closed = true; } },
            waitUntil(promise) { pending = promise; } });
        await pending;
        assert.equal(closed, true);
        assert.deepEqual(opened, expected ? [link] : []);
    }
});
