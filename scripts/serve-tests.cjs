// Local test fixture: serve the browser client and tunnel upgrades to the Rust relay.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../tests/helpers/server.cjs');

async function serve() {
    const relay = await startServer();
    const root = path.resolve('client');
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
        if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
        fs.readFile(file, (error, data) => {
            res.writeHead(error ? 404 : 200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
            res.end(error ? 'Not found' : data);
        });
    });
    server.on('upgrade', (req, socket, head) => {
        const upstream = http.request(`http://${relay.address}${req.url}`, {
            headers: { ...req.headers, 'x-forwarded-for': '192.0.2.1', 'x-forwarded-proto': 'http' }
        });
        upstream.on('upgrade', (response, backend, backendHead) => {
            socket.write('HTTP/1.1 101 Switching Protocols\r\n' + response.rawHeaders.reduce((all, value, i, headers) =>
                i % 2 ? all : all + value + ': ' + headers[i + 1] + '\r\n', '') + '\r\n');
            if (head.length) backend.write(head);
            if (backendHead.length) socket.write(backendHead);
            socket.pipe(backend).pipe(socket);
            socket.on('error', () => backend.destroy());
            backend.on('error', () => socket.destroy());
            socket.on('close', () => backend.destroy());
            backend.on('close', () => socket.destroy());
        });
        upstream.on('error', () => socket.destroy());
        upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
        upstream.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, async stop() { await relay.stop(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { serve };
if (require.main === module) serve().then(app => {
    console.log(app.url);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.stop(); process.exit(); });
}).catch(error => { console.error(error); process.exitCode = 1; });
