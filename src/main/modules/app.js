'use strict';
// Allgemeine Programm-Einstellungen (Sound, Intro, ...) und sichere Links.

const { HelixError } = require('../sys/exec');

const DEFAULTS = {
  sound: true,
  volume: 0.7,
  intro: true,
  lightWhilePlaying: true, // Videos pausieren, solange Fortnite läuft
  reduceMotion: false,
  closeToTray: true, // beim Schließen im Infobereich weiterlaufen (Spielzeit, Cloud-Wächter)
};

const ALLOWED_HOSTS = /^(www\.)?(nvidia\.com|amd\.com|intel\.com|intel\.de|epicgames\.com|fortnite\.com|microsoft\.com|support\.microsoft\.com|learn\.microsoft\.com)$/i;

module.exports = {
  id: 'app',
  handlers: {
    info: (_a, ctx) => ({
      version: ctx.electron.app.getVersion(),
      dataDir: ctx.dataDir,
      platform: process.platform,
      electron: process.versions.electron,
    }),
    settings: async (_a, ctx) => ({ ...DEFAULTS, ...(await ctx.core.readState('app', {})) }),
    setSettings: async (a, ctx) => {
      const cur = { ...DEFAULTS, ...(await ctx.core.readState('app', {})) };
      const patch = a.patch || {};
      for (const k of Object.keys(patch)) {
        if (!(k in DEFAULTS)) continue;
        if (typeof DEFAULTS[k] === 'boolean') cur[k] = !!patch[k];
        if (typeof DEFAULTS[k] === 'number') {
          const n = Number(patch[k]);
          if (Number.isFinite(n)) cur[k] = Math.min(1, Math.max(0, n));
        }
      }
      await ctx.core.writeState('app', cur);
      ctx.emit('app.settings', cur);
      return cur;
    },
    openWindowsSettings: async (a, ctx) => {
      const uri = String(a.uri || '');
      if (!/^ms-settings:[a-z0-9-]+$/i.test(uri)) throw new HelixError('BAD_ARG', 'Diese Einstellungsseite ist nicht erlaubt.');
      await ctx.electron.shell.openExternal(uri);
      return { opened: uri };
    },
    openUrl: async (a, ctx) => {
      let u;
      try { u = new URL(String(a.url || '')); } catch { throw new HelixError('BAD_ARG', 'Ungültiger Link.'); }
      if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) throw new HelixError('BAD_ARG', 'Dieser Link ist nicht erlaubt.');
      await ctx.electron.shell.openExternal(u.toString());
      return { opened: u.toString() };
    },
    ready: (_a, ctx) => {
      ctx.onRendererReady?.();
      return { ok: true };
    },
  },
  DEFAULTS,
};
