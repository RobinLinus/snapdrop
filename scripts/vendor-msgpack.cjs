const fs = require('node:fs');
const path = require('node:path');
const root = path.dirname(require.resolve('@msgpack/msgpack/package.json'));
fs.mkdirSync('client/vendor', { recursive: true });
fs.copyFileSync(path.join(root, 'dist.umd/msgpack.min.js'), 'client/vendor/msgpack.min.js');
fs.copyFileSync(path.join(root, 'LICENSE'), 'client/vendor/msgpack.LICENSE');
