const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pty', {
  start: (cols, rows) => ipcRenderer.send('pty:start', { cols, rows }),
  input: (d) => ipcRenderer.send('pty:input', d),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
});
