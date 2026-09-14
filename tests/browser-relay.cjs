// Run with Playwright available (NODE_PATH may point to a shared installation).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { serve } = require('../scripts/serve-tests.cjs');

async function checkNotifications(browser, url, errors) {
    const context = await browser.newContext({ permissions: ['notifications'] });
    try {
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            // Exercise the mobile path with Chrome's real service worker/notification APIs.
            window.Notification = new Proxy(window.Notification, {
                construct() { throw new TypeError('Use service worker notifications'); }
            });
            document.hasFocus = () => false;
            HTMLMediaElement.prototype.play = () => Promise.resolve();
        });
        await page.goto(url);
        await page.evaluate(async () => { await window.serviceWorkerReady; });
        await page.evaluate(() => Events.fire('text-received', { text: 'Notification test' }));
        await page.waitForFunction(async () => (await (await window.serviceWorkerReady).getNotifications()).length === 1);
        assert.deepEqual(await page.evaluate(async () => {
            const [notification] = await (await window.serviceWorkerReady).getNotifications();
            return { title: notification.title, body: notification.body, url: notification.data.url };
        }), { title: 'Notification test', body: 'Click to return to Snapdrop', url: url + '/' });
        await page.evaluate(() => {
            document.hasFocus = () => true;
            window.dispatchEvent(new Event('focus'));
        });
        await page.waitForFunction(async () => (await (await window.serviceWorkerReady).getNotifications()).length === 0);
        console.log('PASS: actual service worker notification creation and cleanup on focus.');
    } finally {
        await context.close();
    }
}

(async () => {
    const app = await serve();
    let browser;
    const errors = [];
    try {
        browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
        await checkNotifications(browser, app.url, errors);
        const contextA = await browser.newContext({ serviceWorkers: 'block' });
        const contextB = await browser.newContext({ serviceWorkers: 'block' });
        const a = await contextA.newPage();
        const b = await contextB.newPage();
        async function prepare(page) {
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Autoplay blocked', 'NotAllowedError'));
                window.rtcCount = 0;
                window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
                    construct(target, args) { window.rtcCount++; return new target(...args); }
                });
                window.receivedText = [];
                window.receivedFiles = [];
                window.addEventListener('text-received', e => receivedText.push(e.detail.text));
                window.addEventListener('file-received', async e => {
                    const bytes = new Uint8Array(await e.detail.blob.arrayBuffer());
                    receivedFiles.push({ size: bytes.length, exact: bytes.every((byte, i) => byte === i % 251) });
                });
            });
            await page.goto(app.url);
        }
        await prepare(a);
        await prepare(b);
        await Promise.all([a.waitForSelector('x-peer'), b.waitForSelector('x-peer')]);
        const message = 'Hello 🌍 日本語';
        await a.evaluate(text => Events.fire('send-text', { to: document.querySelector('x-peer').id, text }), message);
        await b.waitForFunction(() => receivedText.length === 1);
        assert.deepEqual(await b.evaluate(() => receivedText), [message]);
        assert.equal(await a.evaluate(() => rtcCount), 0);
        assert.equal(await b.evaluate(() => rtcCount), 0);
        // Select immediately, before any WebRTC connection exists.
        const waitingStatus = await a.evaluate(() => {
            RTCPeer.config.iceServers = [];
            const bytes = Uint8Array.from({ length: 1200000 }, (_, i) => i % 251);
            Events.fire('files-selected', { to: document.querySelector('x-peer').id, files: [new File([bytes], 'test.bin')] });
            return document.querySelector('x-peer .status').textContent;
        });
        assert.equal(waitingStatus, 'Connecting…');
        await b.waitForFunction(() => receivedFiles.length === 1, null, { timeout: 30000 });
        assert.deepEqual(await b.evaluate(() => receivedFiles), [{ size: 1200000, exact: true }]);
        assert.equal(await a.evaluate(() => rtcCount), 1);
        assert.equal(await b.evaluate(() => rtcCount), 1);
        // A new tab shares the identity, receives text, and replaces a departed file endpoint.
        const secondTab = await contextB.newPage();
        await prepare(secondTab);
        await secondTab.waitForSelector('x-peer');
        await a.evaluate(text => Events.fire('send-text', { to: document.querySelector('x-peer').id, text }), 'new tab');
        await secondTab.waitForFunction(() => receivedText.length === 1);
        assert.deepEqual(await secondTab.evaluate(() => receivedText), ['new tab']);
        assert.equal(await secondTab.evaluate(() => rtcCount), 0);
        await a.evaluate(() => { Events.on('peer-updated', e => {
            if (e.detail.departedConnection) window.departed = true;
        }); });
        await b.close();
        await a.waitForFunction(() => window.departed);
        await a.evaluate(() => {
            const bytes = Uint8Array.from({ length: 1200000 }, (_, i) => i % 251);
            Events.fire('files-selected', { to: document.querySelector('x-peer').id, files: [new File([bytes], 'next.bin')] });
        });
        await secondTab.waitForFunction(() => receivedFiles.length === 1, null, { timeout: 30000 });
        assert.deepEqual(await secondTab.evaluate(() => receivedFiles), [{ size: 1200000, exact: true }]);
        assert.deepEqual(errors, []);
        console.log('PASS: browser discovery, text with zero RTC connections, exact 1,200,000-byte on-demand transfers, and replacement of a departed tab through Rust/MessagePack signaling.');
    } finally {
        if (browser) await browser.close();
        await app.stop();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
