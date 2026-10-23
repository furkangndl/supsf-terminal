const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const pty = require('node-pty');

const fs = require('node:fs');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Repo root holding bin/supsf.js: SUPSF_ROOT, the checkout this app sits in, or the one recorded at package time (root.txt).
const recorded = fs.existsSync(path.join(__dirname, 'root.txt')) ? fs.readFileSync(path.join(__dirname, 'root.txt'), 'utf8').trim() : '';
const repo = [process.env.SUPSF_ROOT, path.resolve(__dirname, '..'), recorded]
  .find((r) => r && fs.existsSync(path.join(r, 'bin', 'supsf.js'))) || path.resolve(__dirname, '..');

// Load the page from the repo when it is there, so edits to desktop/index.html show up without reinstalling.
const PAGE_DIR = fs.existsSync(path.join(repo, 'desktop', 'index.html')) ? path.join(repo, 'desktop') : __dirname;

let win;
let term;

function startPty(cols, rows) {
  // Login shell so nvm / PATH from the user's profile is available (PowerShell on Windows).
  const [shellPath, shellArgs] = isWin
    ? ['powershell.exe', ['-NoLogo', '-Command', 'node bin/supsf.js']]
    : ['/bin/zsh', ['-lic', 'exec node bin/supsf.js']];
  term = pty.spawn(shellPath, shellArgs, {
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
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
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
  if (isWin) {
    // No SIGWINCH on Windows: a one-row size change makes supsf repaint.
    term.resize(cols, Math.max(1, rows - 1));
    term.resize(cols, rows);
  } else {
    try { process.kill(term.pid, 'SIGWINCH'); } catch {}
  }
});
ipcMain.on('pty:input', (_e, d) => term && term.write(d));
ipcMain.on('pty:resize', (_e, { cols, rows }) => term && term.resize(cols, rows));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { term && term.kill(); } catch {} });

