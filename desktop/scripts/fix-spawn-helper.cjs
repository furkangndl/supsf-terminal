// node-pty ships its macOS spawn-helper without the exec bit; Windows needs nothing.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
if (process.platform !== 'win32' && fs.existsSync(dir)) {
  for (const d of fs.readdirSync(dir).filter((n) => n.startsWith('darwin-'))) {
    try { fs.chmodSync(path.join(dir, d, 'spawn-helper'), 0o755); } catch {}
  }
}
