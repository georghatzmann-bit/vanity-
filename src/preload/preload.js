'use strict';
// Preload: exposes the typed Phoenix API (see docs/ARCHITECTURE.md §4) to the sandboxed renderer.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENT_CHANNELS = new Set(['scan:progress', 'winget:ensure-progress', 'install:event']);

contextBridge.exposeInMainWorld('phoenix', {
  app: { info: invoke('app:info'), markInstalled: invoke('app:markInstalled') },
  win: {
    minimize: invoke('win:minimize'),
    toggleMaximize: invoke('win:toggleMaximize'),
    close: invoke('win:close'),
  },
  system: { info: invoke('system:info') },
  winget: { status: invoke('winget:status'), ensure: invoke('winget:ensure') },
  scan: { run: invoke('scan:run') },
  catalog: { get: invoke('catalog:get') },
  profile: {
    save: invoke('profile:save'),
    saveToDrive: invoke('profile:saveToDrive'),
    open: invoke('profile:open'),
    find: invoke('profile:find'),
    load: invoke('profile:load'),
    encode: invoke('profile:encode'),
    decode: invoke('profile:decode'),
  },
  drives: { list: invoke('drives:list') },
  setup: { find: invoke('setup:find') },
  install: { start: invoke('install:start'), cancel: invoke('install:cancel') },
  games: { launchers: invoke('games:launchers'), install: invoke('games:install') },
  shell: { open: invoke('shell:open'), showItem: invoke('shell:showItem') },
  clipboard: { write: invoke('clipboard:write') },
  log: { export: invoke('log:export') },
  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
