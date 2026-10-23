// Copy the packaged macOS app to ~/Applications. (Windows: run dist/Terminalo-win32-*/Terminalo.exe.)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist');
const out = fs.readdirSync(dist).find((n) => n.startsWith('Terminalo-darwin-'));
if (process.platform !== 'darwin' || !out) {
  console.error('install-app is macOS only. Windows: npm run package:win, then run dist/Terminalo-win32-*/Terminalo.exe');
  process.exit(1);
}
const target = path.join(os.homedir(), 'Applications', 'Terminalo.app');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(path.join(dist, out, 'Terminalo.app'), target, { recursive: true });
const prebuilds = path.join(target, 'Contents', 'Resources', 'app', 'node_modules', 'node-pty', 'prebuilds');
for (const d of fs.readdirSync(prebuilds).filter((n) => n.startsWith('darwin-'))) fs.chmodSync(path.join(prebuilds, d, 'spawn-helper'), 0o755);
console.log('Installed', target);
