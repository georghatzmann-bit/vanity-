'use strict';
// Sicht-Presets: fertige Einstellungen für bessere Sicht (Sturm, Nacht, helle Karte, Turnier).
// Geschrieben wird nur GameUserSettings.ini – ausschließlich über ctx.core.applyIniChanges
// (macht ein Backup, verlangt geschlossenes Fortnite, behält den Schreibschutz) und nur
// mit den erlaubten lokalen Werten aus sicht-rules.js. Farbenblind-Modus und HUD liegen in der
// Epic-Cloud und werden nie angefasst – die Ansicht erklärt sie als Schritte im Spiel.

const { HelixError } = require('../../sys/exec');
const rules = require('../../tools/sicht-rules');

const ID = 'sicht';
const STATE = 'tool-sicht';
const HISTORY_MAX = 50;

async function readState(ctx) {
  const s = await ctx.core.readState(STATE, {});
  return s && typeof s === 'object' ? s : {};
}

/** Liest alle relevanten Werte. Ohne Fortnite-Ordner/Datei: { found:false, reason }. */
async function readCurrent(ctx) {
  try {
    const r = await ctx.core.readIniValues(rules.FILE, rules.readKeys());
    if (!r.found) return { found: false, reason: 'NO_FILE' };
    return { found: true, rel: r.rel, readOnly: !!r.readOnly, raw: r.values };
  } catch (e) {
    if (e.code === 'NO_FORTNITE') return { found: false, reason: 'NO_FORTNITE', message: e.message };
    throw e;
  }
}

async function fortnite(ctx) {
  try { return await ctx.core.fortniteStatus(); } catch { return { running: false, unsupported: true }; }
}

function presetMeta(a) {
  const id = String(a.presetId || '');
  if (id === 'eigen') return { id, name: 'eigene Werte', short: 'eigene Werte' };
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new HelixError('BAD_ARG', 'Unbekanntes Preset.');
  const name = rules.cleanName(a.presetName, id);
  return { id, name, short: rules.cleanName(a.presetShort, name) };
}

module.exports = {
  id: ID,
  handlers: {
    /** Aktuelle Werte + gemerkte Originalwerte + Fortnite-Status. */
    async current(_a, ctx) {
      const [cur, st, fn] = await Promise.all([readCurrent(ctx), readState(ctx), fortnite(ctx)]);
      return { ...cur, fortnite: fn, original: st.original || null, last: st.last || null };
    },

    /** Zeigt, was sich ändern würde (nichts wird geschrieben). */
    async preview(a, ctx) {
      const changes = rules.validateChanges(a.changes);
      const [prev, fn] = await Promise.all([ctx.core.previewIniChanges(rules.FILE, changes), fortnite(ctx)]);
      return { ...prev, fortnite: fn };
    },

    /** Schreibt die Werte (Backup, Fortnite muss geschlossen sein). */
    async apply(a, ctx) {
      const changes = rules.validateChanges(a.changes);
      const meta = presetMeta(a);
      const st = await readState(ctx);
      // Vor dem allerersten Sicht-Preset die jetzigen Werte merken („Standard zurück“).
      if (!st.original) {
        const cur = await readCurrent(ctx);
        if (cur.found) {
          st.original = {};
          for (const r of rules.ALLOWED) {
            const k = `${r.section}|${r.key}`;
            st.original[k] = cur.raw[k] ?? null;
          }
          st.originalAt = Date.now();
        }
      }
      const label = meta.id === 'eigen' ? 'Sicht: eigene Werte' : `Sicht-Preset „${meta.name}“`;
      const res = await ctx.core.applyIniChanges(rules.FILE, changes, { reason: 'tool', label });
      const at = Date.now();
      st.last = { id: meta.id, name: meta.name, short: meta.short, at, changes };
      st.history = [...(Array.isArray(st.history) ? st.history : []), { at, id: meta.id, name: meta.name, changed: res.applied.length }].slice(-HISTORY_MAX);
      await ctx.core.writeState(STATE, st);
      ctx.emit?.('sicht.applied', { id: meta.id, name: meta.name });
      return { ...res, label, preset: meta };
    },

    async summary(_a, ctx) {
      const cur = await readCurrent(ctx).catch(() => ({ found: false }));
      if (!cur.found) return null;
      return rules.summaryText(await readState(ctx), cur.raw);
    },
  },
};
