'use strict';
// Sichere Brücke zwischen Oberfläche und Hauptprozess.
// Die Oberfläche bekommt nur genau diese Funktionen, keinen Zugriff auf Dateien oder Node.

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('kr', {
  appInfo: () => call('app:info'),
  state: {
    load: () => call('state:load'),
    save: (state) => call('state:save', state),
    reset: () => call('state:reset'),
  },
  openUrl: (url) => call('open-url', url),
  copy: (text) => call('clipboard:write', text),
  pdf: {
    parseBytes: (name, bytes, password) => call('pdf:parse-bytes', name, bytes, password),
    pick: () => call('pdf:pick'),
    parsePicked: (token, password) => call('pdf:parse-picked', token, password),
  },
  exportText: (suggestedName, text) => call('export:text', suggestedName, text),
  openWindowsSecurity: () => call('windows:security'),
  findEpicAccountIds: () => call('epic:find-account-ids'),
  epicAccounts: {
    status: () => call('epic:accounts:status'),
    save: (label) => call('epic:accounts:save', label),
    switchTo: (id) => call('epic:accounts:switch', id),
    remove: (id) => call('epic:accounts:remove', id),
    rename: (id, label) => call('epic:accounts:rename', id, label),
    closeLauncher: () => call('epic:accounts:close-launcher'),
    addNew: () => call('epic:accounts:add-new'),
  },
  discord: {
    status: () => call('discord:status'),
    start: () => call('discord:start'),
    stop: () => call('discord:stop'),
    mute: (muted, options) => call('discord:mute', muted, options),
    openWindowsSettings: () => call('windows:notification-settings'),
  },
});
