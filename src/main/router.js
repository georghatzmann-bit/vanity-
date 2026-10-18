'use strict';
// Verteilt Aufrufe aus der Oberfläche ("modul.aktion") an die Module.

const { HelixError } = require('./sys/exec');

const CHANNEL_RE = /^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/;

class Router {
  constructor(ctx) {
    this.ctx = ctx;
    this.handlers = new Map();
    this.modules = [];
  }

  register(mod) {
    if (!mod || !mod.id || !mod.handlers) throw new Error('Modul ohne id/handlers');
    for (const [name, fn] of Object.entries(mod.handlers)) {
      const channel = `${mod.id}.${name}`;
      if (!CHANNEL_RE.test(channel)) throw new Error(`Ungültiger Kanal ${channel}`);
      if (this.handlers.has(channel)) throw new Error(`Kanal doppelt: ${channel}`);
      this.handlers.set(channel, fn);
    }
    this.modules.push(mod);
  }

  async call(channel, args) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel) || !this.handlers.has(channel)) {
      return { ok: false, error: { code: 'NO_CHANNEL', message: `Unbekannte Aktion: ${channel}` } };
    }
    try {
      const data = await this.handlers.get(channel)(args ?? {}, this.ctx);
      return { ok: true, data: data === undefined ? null : data };
    } catch (e) {
      const known = e instanceof HelixError || (e && typeof e.code === 'string' && /^[A-Z_]+$/.test(e.code));
      if (!known) this.ctx.log?.('error', channel, e && e.stack ? e.stack : String(e));
      return {
        ok: false,
        error: {
          code: known ? e.code : 'INTERNAL',
          message: known ? e.message : `Unerwarteter Fehler: ${e && e.message ? e.message : e}`,
          details: known && e.details !== undefined ? e.details : undefined,
        },
      };
    }
  }

  async initAll() {
    for (const m of this.modules) {
      if (typeof m.init === 'function') {
        try { await m.init(this.ctx); } catch (e) { this.ctx.log?.('error', `init ${m.id}`, e.stack || e); }
      }
    }
  }

  async disposeAll() {
    for (const m of this.modules) {
      if (typeof m.dispose === 'function') {
        try { await m.dispose(this.ctx); } catch { /* beim Beenden egal */ }
      }
    }
  }
}

module.exports = { Router, CHANNEL_RE };
