'use strict';
// Brücke zwischen Oberfläche und Hauptprozess. Die Oberfläche bekommt nur diese zwei Funktionen,
// keinen Zugriff auf Dateien oder Programme.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helix', {
  /** Ruft eine Aktion auf. Rückgabe: { ok, data } oder { ok:false, error:{code,message} } */
  call: (channel, args) => ipcRenderer.invoke('helix:call', String(channel), args ?? {}),
  /** Hört auf Ereignisse aus dem Hauptprozess. Gibt eine Abmeldefunktion zurück. */
  on: (event, cb) => {
    const h = (_e, name, payload) => {
      if (name === event || event === '*') {
        try { cb(payload, name); } catch { /* Fehler im Empfänger nicht weiterreichen */ }
      }
    };
    ipcRenderer.on('helix:event', h);
    return () => ipcRenderer.removeListener('helix:event', h);
  },
  platform: process.platform,
});
