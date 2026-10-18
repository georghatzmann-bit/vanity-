'use strict';
// Sensi-Kalibrierung: speichert deine Maus-Werte und den Verlauf der Aim-Tests.
// Der Aim-Test selbst läuft komplett in der Oberfläche (Canvas). Hier wird nur gespeichert.
//
// Wichtig: Die Fortnite-Sensi liegt in ClientSettings.Sav, also in der Epic-Cloud des Kontos.
// HELIX schreibt sie deshalb nicht – der Spieler stellt den empfohlenen Wert im Spiel selbst ein.
// Dieses Modul fasst keine Fortnite-Dateien an und startet keine Programme.

const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/sensi-logic');

const ID = 'sensi';
const STATE = 'tool-sensi';

// Schreibzugriffe nacheinander ausführen, damit sich zwei Speichervorgänge nicht überholen.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function load(ctx) {
  return logic.normalizeState(await ctx.core.readState(STATE, {}));
}

async function store(ctx, st) {
  await ctx.core.writeState(STATE, { settings: st.settings, history: st.history });
}

module.exports = {
  id: ID,
  handlers: {
    /** Alles auf einmal für die Ansicht: { settings, saved, history } */
    async state(_a, ctx) {
      return load(ctx);
    },

    async getSettings(_a, ctx) {
      const st = await load(ctx);
      return { settings: st.settings, saved: st.saved };
    },

    async saveSettings(a, ctx) {
      const v = logic.validateSettings(a && a.settings);
      if (!v.ok) throw new HelixError('BAD_ARG', Object.values(v.errors)[0], { errors: v.errors });
      return serial(async () => {
        const raw = await ctx.core.readState(STATE, {});
        const st = logic.normalizeState(raw);
        st.settings = v.settings;
        await store(ctx, st);
        return { settings: st.settings, saved: true };
      });
    },

    async saveResult(a, ctx) {
      const r = logic.sanitizeEntry(a && a.entry);
      if (!r.ok) throw new HelixError('BAD_ARG', r.error);
      return serial(async () => {
        const st = logic.normalizeState(await ctx.core.readState(STATE, {}));
        st.history = logic.appendHistory(st.history, r.entry);
        await store(ctx, st);
        ctx.emit?.('sensi.history', { count: st.history.length });
        return { entry: r.entry, count: st.history.length };
      });
    },

    async history(a, ctx) {
      const st = await load(ctx);
      const limit = Math.min(logic.MAX_HISTORY, Math.max(1, Math.round(Number(a && a.limit) || logic.MAX_HISTORY)));
      return st.history.slice(-limit);
    },

    async removeResult(a, ctx) {
      const at = Number(a && a.at);
      if (!Number.isFinite(at)) throw new HelixError('BAD_ARG', 'Angabe fehlt: Zeitpunkt des Ergebnisses.');
      return serial(async () => {
        const st = logic.normalizeState(await ctx.core.readState(STATE, {}));
        const before = st.history.length;
        st.history = st.history.filter((e) => e.at !== at);
        if (st.history.length !== before) await store(ctx, st);
        return { removed: before !== st.history.length, count: st.history.length };
      });
    },

    async clearHistory(_a, ctx) {
      return serial(async () => {
        const st = logic.normalizeState(await ctx.core.readState(STATE, {}));
        const cleared = st.history.length;
        st.history = [];
        await store(ctx, st);
        return { cleared };
      });
    },

    async summary(_a, ctx) {
      const text = logic.summaryText(await ctx.core.readState(STATE, {}));
      return text ? { text } : null;
    },
  },
};
