const { spawn } = require('node:child_process');
const path = require('node:path');

async function startServer(config = {}) {
    const child = spawn(path.resolve('server/target/debug/snapdrop-server'), [], {
        env: { ...process.env, HOST: '127.0.0.1', PORT: '0', TRUSTED_PROXIES: '127.0.0.1/32',
            MAX_CONNECTIONS: '256', MAX_ROOM_CONNECTIONS: '64', ...config },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const address = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out: ' + output)); }, 15000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error('Server exited: ' + output)); });
        child.stdout.on('data', () => {
            const match = output.match(/Snapdrop listening on (127\.0\.0\.1:\d+)/);
            if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
    });
    return {
        address, child, output: () => output,
        async stop() {
            child.kill('SIGTERM');
            const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
            await exited;
            clearTimeout(timeout);
        }
    };
}
module.exports = { startServer };
