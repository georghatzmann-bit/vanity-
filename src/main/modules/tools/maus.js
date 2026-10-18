'use strict';
// Maus-Check: Windows-Zeigergeschwindigkeit, „Zeigerbeschleunigung verbessern“ und Fortnites
// bDisableMouseAcceleration prüfen und auf Wunsch einstellen – mit Rückgängig.
//
// Sicherheit:
//  - Registry-Schreiben nur unter HKCU\Control Panel\Mouse über ctx.registry.writeValue (kein Administrator).
//  - Sofort wirksam über SystemParametersInfo (user32) mit SPIF_UPDATEINIFILE|SPIF_SENDCHANGE – betrifft nur
//    den eigenen Benutzer. Kein Zugriff auf Fortnite-Prozess, Spielspeicher oder Anti-Cheat.
//  - Fortnite-Datei nur über ctx.core.applyIniChanges (Backup, Fortnite muss geschlossen sein, Schreibschutz bleibt).
//  - Abfragerate und DPI werden nur in der HELIX-Oberfläche gemessen (keine globalen Hooks).

const { HelixError } = require('../../sys/exec');
const L = require('../../tools/maus-logic');

const ID = 'maus';
const STATE = 'tool-maus';

let queue = Promise.resolve();
/** Zustand nacheinander ändern, damit sich zwei Aufrufe nicht gegenseitig überschreiben. */
function serial(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

async function readState(ctx) {
  const s = await ctx.core.readState(STATE, {});
  return s && typeof s === 'object' ? s : {};
}

function isWin(ctx) {
  return !!(ctx.exec && ctx.exec.IS_WIN);
}

/** Liest HKCU\Control Panel\Mouse. Gibt null zurück, wenn es kein Windows ist. */
async function readWindows(ctx) {
  try {
    const reg = await ctx.registry.readKey(L.MOUSE_KEY);
    if (!reg) return { values: L.parseMouseValues({}), missingKey: true };
    return { values: L.parseMouseValues(reg), missingKey: false };
  } catch (e) {
    if (e && e.code === 'NOT_WINDOWS') return null;
    throw e;
  }
}

function lastOf(list) {
  return Array.isArray(list) && list.length ? list[list.length - 1] : null;
}

function publicTests(s) {
  const t = s.tests || {};
  return {
    polling: lastOf(t.polling),
    dpi: lastOf(t.dpi),
    pollingHistory: (t.polling || []).slice(-5),
    dpiHistory: (t.dpi || []).slice(-5),
  };
}

function publicUndo(s) {
  const u = s.undo;
  if (!u || !L.validValues(u.before)) return null;
  return { at: u.at, changes: Array.isArray(u.changes) ? u.changes : [] };
}

async function buildStatus(ctx) {
  const s = await readState(ctx);
  const w = await readWindows(ctx);
  if (!w) return { unsupported: true, windows: null, undo: null, tests: publicTests(s) };
  const ev = L.evaluate(w.values);
  return {
    unsupported: false,
    windows: { ...ev, raw: w.values, missingKey: w.missingKey },
    undo: publicUndo(s),
    tests: publicTests(s),
  };
}

/** Schreibt die Werte in HKCU und macht sie sofort wirksam. names = welche Registry-Werte geschrieben werden. */
async function writeAndApply(ctx, target, names) {
  for (const n of names) {
    try {
      await ctx.registry.writeValue(L.MOUSE_KEY, n, 'REG_SZ', String(target[n]));
    } catch (e) {
      if (e && e.code === 'NOT_WINDOWS') throw e;
      throw new HelixError('REG_FAILED', 'Windows hat die Mauseinstellung nicht angenommen. Bitte noch einmal versuchen.', { name: n, cause: e && e.message });
    }
  }
  try {
    const out = await ctx.exec.powershell(L.spiScript(target), { json: true, timeout: 30000 });
    const r = L.parseSpiResult(out, target);
    return r.live ? { live: true } : { live: false, liveError: 'Windows hat die Werte gespeichert, aber noch nicht sofort übernommen.' };
  } catch (e) {
    ctx.log?.('warn', 'maus: SystemParametersInfo', e && e.message);
    return { live: false, liveError: 'Die Werte sind gespeichert. Sie wirken nach dem nächsten Abmelden oder Neustart.' };
  }
}

async function fortniteAccel(ctx) {
  let r;
  try {
    r = await ctx.core.readIniValues(L.FORTNITE.file, [{ section: L.FORTNITE.section, key: L.FORTNITE.key }]);
  } catch (e) {
    if (e && e.code === 'NO_FORTNITE') return { found: false, noFolder: true, value: null, disabled: null, ok: null };
    throw e;
  }
  if (!r || !r.found) return { found: false, noFolder: false, value: null, disabled: null, ok: null };
  const info = L.fortniteAccelInfo(r.values[`${L.FORTNITE.section}|${L.FORTNITE.key}`]);
  let running = false;
  try { running = !!(await ctx.core.fortniteStatus()).running; } catch { running = false; }
  return { found: true, rel: r.rel, readOnly: !!r.readOnly, ...info, fortniteRunning: running };
}

module.exports = {
  id: ID,
  handlers: {
    /** Windows-Werte, Bewertung, Rückgängig-Info und letzte Messungen. */
    async status(_a, ctx) {
      return buildStatus(ctx);
    },

    /** Setzt die empfohlenen Werte (Stufe 6/11, Beschleunigung aus). args: {speed?:bool, accel?:bool} */
    async fix(a, ctx) {
      return serial(async () => {
        const parts = { speed: a.speed !== false, accel: a.accel !== false };
        if (!parts.speed && !parts.accel) throw new HelixError('BAD_ARG', 'Es wurde nichts zum Ändern ausgewählt.');
        const w = await readWindows(ctx);
        if (!w || !isWin(ctx)) throw new HelixError('NOT_WINDOWS', 'Die Windows-Mauseinstellungen gibt es nur unter Windows.');
        const plan = L.planFix(w.values, parts);
        if (!plan.changes.length) {
          return { changed: [], live: true, alreadyOk: true, status: await buildStatus(ctx) };
        }
        // Vorher-Werte für „Rückgängig“ sichern – bevor irgendetwas geschrieben wird.
        const s = await readState(ctx);
        s.undo = L.nextUndo(s.undo, w.values, plan, Date.now());
        await ctx.core.writeState(STATE, s);
        const r = await writeAndApply(ctx, plan.target, plan.changes.map((c) => c.name));
        return { changed: plan.changes, ...r, status: await buildStatus(ctx) };
      });
    },

    /** Stellt die vor der letzten Änderung gesicherten Werte wieder her. */
    async undo(_a, ctx) {
      return serial(async () => {
        const s = await readState(ctx);
        const u = s.undo;
        if (!u || !L.validValues(u.before)) throw new HelixError('NO_UNDO', 'Es gibt keine Änderung, die man rückgängig machen kann.');
        if (!isWin(ctx)) throw new HelixError('NOT_WINDOWS', 'Die Windows-Mauseinstellungen gibt es nur unter Windows.');
        const target = L.withDefaults(u.before);
        const r = await writeAndApply(ctx, target, L.NAMES);
        delete s.undo;
        await ctx.core.writeState(STATE, s);
        return { restored: L.NAMES.map((n) => ({ name: n, to: target[n] })), ...r, status: await buildStatus(ctx) };
      });
    },

    /** Liest bDisableMouseAcceleration aus GameUserSettings.ini. */
    async fortniteAccel(_a, ctx) {
      return fortniteAccel(ctx);
    },

    /** Schaltet Fortnites Mausbeschleunigung aus (Standard) oder wieder ein ({disable:false}). Mit Backup. */
    async fixFortniteAccel(a, ctx) {
      const disable = a.disable !== false;
      const r = await ctx.core.applyIniChanges(L.FORTNITE.file, L.fortniteChange(disable), {
        reason: 'tool',
        label: disable ? 'Maus-Check: Mausbeschleunigung in Fortnite aus' : 'Maus-Check: Mausbeschleunigung in Fortnite wieder an',
      });
      return { applied: r.applied, backupId: r.backupId, ...(await fortniteAccel(ctx)) };
    },

    /** Speichert ein Messergebnis aus der Oberfläche. args: {kind:'polling'|'dpi', result:{...}} */
    async saveTest(a, ctx) {
      const kind = a.kind === 'dpi' ? 'dpi' : a.kind === 'polling' ? 'polling' : null;
      const clean = kind ? L.sanitizeTest(kind, a.result) : null;
      if (!clean) throw new HelixError('BAD_ARG', 'Das Messergebnis ist unvollständig und wurde nicht gespeichert.');
      return serial(async () => {
        const s = await readState(ctx);
        s.tests = s.tests && typeof s.tests === 'object' ? s.tests : {};
        const entry = { at: Date.now(), ...clean };
        s.tests[kind] = L.pushCapped(s.tests[kind], entry, 50);
        await ctx.core.writeState(STATE, s);
        return { saved: entry, tests: publicTests(s) };
      });
    },

    async summary(_a, ctx) {
      const s = await readState(ctx);
      const lastPoll = lastOf(s.tests && s.tests.polling);
      let ev = null;
      try {
        const w = await readWindows(ctx);
        ev = w ? L.evaluate(w.values) : null;
      } catch { ev = null; }
      const text = L.summaryText(ev, lastPoll);
      return text ? { text } : null;
    },
  },
  _test: { buildStatus, readWindows, fortniteAccel, writeAndApply },
};
