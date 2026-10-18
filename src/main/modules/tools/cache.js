'use strict';
// Cache-Cleaner: löscht Shader-, DirectX- und Fortnite-Zwischenspeicher und zeigt vorher den Platzgewinn.
// Pfade nur aus ctx.env und ctx.core.location. Nur Dateien in den Bereichsordnern werden gelöscht,
// nie die Ordner selbst. Verknüpfungen werden nie verfolgt. Fortnite muss geschlossen sein.
// Protokolle werden nie gelesen – nur ihre Größe gemessen und auf Wunsch gelöscht.

const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/cache-logic');

const ID = 'cache';
const STATE = 'tool-cache';
let busy = false;

function isWin(ctx) {
  const v = ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : process.platform === 'win32';
  return v;
}

async function currentLocation(ctx) {
  try { return await ctx.core.requireLocation(); } catch { return ctx.core.location || null; }
}

async function categoriesFor(ctx) {
  const loc = await currentLocation(ctx);
  return { list: logic.buildCategories(ctx.env || {}, loc), savedDir: loc && loc.found ? loc.savedDir : null };
}

async function readState(ctx) {
  const s = await ctx.core.readState(STATE, {});
  return { lastScan: null, history: [], ...(s && typeof s === 'object' ? s : {}) };
}

function publicScan(found, at) {
  return {
    at,
    bytes: found.reduce((n, c) => n + c.bytes, 0),
    count: found.reduce((n, c) => n + c.count, 0),
    categories: found.map((c) => ({
      id: c.id, group: c.group, label: c.label, hint: c.hint, privacy: c.privacy,
      bytes: c.bytes, count: c.count, truncated: c.truncated, folders: c.roots.length,
    })),
  };
}

async function doScan(ctx) {
  const { list, savedDir } = await categoriesFor(ctx);
  const found = await logic.scanCategories(list, { savedDir });
  const scan = publicScan(found, Date.now());
  const st = await readState(ctx);
  st.lastScan = { at: scan.at, bytes: scan.bytes, count: scan.count, categories: scan.categories.map((c) => ({ id: c.id, bytes: c.bytes, count: c.count })) };
  await ctx.core.writeState(STATE, st);
  return scan;
}

async function cleanNow(ids, ctx) {
  await ctx.core.ensureFortniteClosed();
  const { list, savedDir } = await categoriesFor(ctx);
  const chosen = list.filter((c) => ids.includes(c.id));
  if (!chosen.length) throw new HelixError('BAD_ARG', 'Die gewählten Bereiche gibt es auf diesem PC nicht.');
  const result = await logic.cleanCategories(chosen, {
    savedDir,
    onProgress: (p) => { try { ctx.emit?.('cache.progress', p); } catch { /* egal */ } },
  });
  try { ctx.emit?.('cache.progress', { index: chosen.length, total: chosen.length, done: true }); } catch { /* egal */ }
  const st = await readState(ctx);
  const entry = { at: Date.now(), freedBytes: result.freedBytes, deleted: result.deleted, skipped: result.skipped, ids: chosen.map((c) => c.id) };
  st.history = [...(Array.isArray(st.history) ? st.history : []), entry].slice(-50);
  await ctx.core.writeState(STATE, st);
  ctx.log?.('info', `cache: ${result.deleted} Dateien gelöscht, ${result.skipped} übersprungen`);
  const scan = await doScan(ctx);
  return { ...result, scan };
}

module.exports = {
  id: ID,
  handlers: {
    /** Misst alle vorhandenen Bereiche. */
    async scan(_a, ctx) {
      if (!isWin(ctx)) return { unsupported: true, categories: [], bytes: 0, count: 0 };
      const scan = await doScan(ctx);
      const fn = await ctx.core.fortniteStatus().catch(() => ({ running: false }));
      const st = await readState(ctx);
      return { ...scan, fortniteRunning: !!fn.running, lastClean: st.history[st.history.length - 1] || null };
    },

    /** Leert die gewählten Bereiche (nur ids – Pfade bestimmt immer der Hauptprozess). */
    async clean(a, ctx) {
      if (!isWin(ctx)) throw new HelixError('NOT_WINDOWS', 'Der Cache-Cleaner funktioniert nur unter Windows.');
      const ids = Array.isArray(a.ids) ? a.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) throw new HelixError('BAD_ARG', 'Bitte wähle mindestens einen Bereich aus.');
      if (busy) throw new HelixError('BUSY', 'Es wird gerade schon aufgeräumt. Bitte kurz warten.');
      busy = true;
      try {
        return await cleanNow(ids, ctx);
      } finally {
        busy = false;
      }
    },

    /** Öffnet den ersten vorhandenen Ordner eines Bereichs im Explorer. */
    async openFolder(a, ctx) {
      if (!isWin(ctx)) throw new HelixError('NOT_WINDOWS', 'Ordner öffnen gibt es hier nur unter Windows.');
      const { list, savedDir } = await categoriesFor(ctx);
      const c = list.find((x) => x.id === a.id);
      if (!c) throw new HelixError('BAD_ARG', 'Unbekannter Bereich.');
      for (const root of c.roots) {
        const info = await logic.inspectRoot(root);
        if (info.ok && !logic.isForbiddenPath(info.real, { savedDir })) {
          const err = await ctx.electron.shell.openPath(root);
          if (err) throw new HelixError('OPEN_FAILED', `Ordner konnte nicht geöffnet werden: ${err}`);
          return { opened: root };
        }
      }
      throw new HelixError('NOT_FOUND', 'Der Ordner existiert nicht mehr.');
    },

    async summary(_a, ctx) {
      if (!isWin(ctx)) return null;
      const st = await readState(ctx);
      const text = logic.summaryText(st.lastScan);
      return text ? { text } : null;
    },
  },
  _test: { isWin, publicScan },
};
