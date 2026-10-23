const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const pty = require('node-pty');

// Repo root holding bin/supsf.js; override with SUPSF_ROOT.
const ROOT = process.env.SUPSF_ROOT || path.resolve(__dirname, '..');
const DEV_ROOT = '/Users/furkangundel/Repos/supsf-terminal';
const repo = require('node:fs').existsSync(path.join(ROOT, 'bin', 'supsf.js')) ? ROOT : DEV_ROOT;

// Load the page from the repo when it is there, so edits to desktop/index.html show up without reinstalling.
const fs = require('node:fs');
const PAGE_DIR = fs.existsSync(path.join(repo, 'desktop', 'index.html')) ? path.join(repo, 'desktop') : __dirname;

let win;
let term;

function startPty(cols, rows) {
  // Login shell so nvm / PATH from the user's profile is available.
  term = pty.spawn('/bin/zsh', ['-lic', 'exec node bin/supsf.js'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: repo,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', HOME: os.homedir() },
  });
  term.onData((d) => win && !win.isDestroyed() && win.webContents.send('pty:data', d));
  term.onExit(() => app.quit());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Terminalo',
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadFile(path.join(PAGE_DIR, 'index.html'));
  // Live reload: the pty (and everything running in it) survives, only the page is rebuilt.
  let reloadTimer;
  fs.watch(path.join(PAGE_DIR, 'index.html'), () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => win && !win.isDestroyed() && win.webContents.reload(), 200);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

ipcMain.on('pty:start', (_e, { cols, rows }) => {
  if (!term) return startPty(cols, rows);
  // Page was reloaded: the new terminal is blank, so make supsf repaint everything (SIGWINCH → full redraw).
  term.resize(cols, rows);
  try { process.kill(term.pid, 'SIGWINCH'); } catch {}
});
ipcMain.on('pty:input', (_e, d) => term && term.write(d));
ipcMain.on('pty:resize', (_e, { cols, rows }) => term && term.resize(cols, rows));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { term && term.kill(); } catch {} });

