'use strict';
// Reaktions-Labor: Reaktionstest und Trainer für Bau-/Edit-Tasten.
// Gemessen wird nur in der HELIX-Oberfläche (keine globalen Tastatur-Hooks, nichts im Spiel).
// Der Hauptprozess prüft und speichert nur die Ergebnisse in 'tool-reaktion'.

const { HelixError } = require('../../sys/exec');
const L = require('../../tools/reaktion-logic');

const STATE = 'tool-reaktion';

let queue = Promise.resolve();
/** Änderungen nacheinander ausführen, damit sich zwei Speichervorgänge nicht überschreiben. */
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function load(ctx) {
  return L.normalizeState(await ctx.core.readState(STATE, {}));
}

function publicState(s) {
  return { reaction: s.reaction, keys: s.keys, binds: s.binds, defaults: L.defaultBinds(), stats: L.stats(s) };
}

module.exports = {
  id: 'reaktion',
  handlers: {
    async getState(_a, ctx) {
      return publicState(await load(ctx));
    },

    /** args: {avgMs, bestMs, rounds, falseStarts} */
    async saveReaction(a, ctx) {
      const clean = L.sanitizeReaction(a);
      if (!clean) throw new HelixError('BAD_ARG', 'Das Ergebnis des Reaktionstests ist ungültig und wurde nicht gespeichert.');
      return serial(async () => {
        const s = await load(ctx);
        const entry = { at: Date.now(), ...clean };
        s.reaction = L.pushCapped(s.reaction, entry);
        await ctx.core.writeState(STATE, s);
        return { entry, state: publicState(s) };
      });
    },

    /** args: {avgMs, accuracy, count} */
    async saveKeys(a, ctx) {
      const clean = L.sanitizeKeys(a);
      if (!clean) throw new HelixError('BAD_ARG', 'Das Ergebnis des Tasten-Trainers ist ungültig und wurde nicht gespeichert.');
      return serial(async () => {
        const s = await load(ctx);
        const entry = { at: Date.now(), ...clean };
        s.keys = L.pushCapped(s.keys, entry);
        await ctx.core.writeState(STATE, s);
        return { entry, state: publicState(s) };
      });
    },

    /** args: {binds:{wall:{code,label,on}, ...}} – unbekannte Aktionen und ungültige Tasten werden verworfen. */
    async saveBinds(a, ctx) {
      if (!a || typeof a.binds !== 'object' || a.binds === null) throw new HelixError('BAD_ARG', 'Keine Tastenbelegung übergeben.');
      return serial(async () => {
        const s = await load(ctx);
        s.binds = L.sanitizeBinds(a.binds);
        await ctx.core.writeState(STATE, s);
        return { binds: s.binds };
      });
    },

    /** args: {which:'reaction'|'keys'|'all'} – die Tastenbelegung bleibt immer erhalten. */
    async clearHistory(a, ctx) {
      const which = ['reaction', 'keys', 'all'].includes(a.which) ? a.which : null;
      if (!which) throw new HelixError('BAD_ARG', 'Unbekannter Verlauf.');
      return serial(async () => {
        const s = await load(ctx);
        if (which === 'reaction' || which === 'all') s.reaction = [];
        if (which === 'keys' || which === 'all') s.keys = [];
        await ctx.core.writeState(STATE, s);
        return publicState(s);
      });
    },

    async summary(_a, ctx) {
      const text = L.summaryText(await ctx.core.readState(STATE, {}));
      return text ? { text } : null;
    },
  },
};
