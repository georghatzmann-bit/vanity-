'use strict';
// Windows-Gaming-Check: prüft Windows-Einstellungen, die fürs Spielen zählen, und bietet sichere Ein-Klick-Lösungen.
//
// Lesen: reg.exe (HKCU und HKLM), powercfg /getactivescheme und /list, fs.statfs, os.release.
// Schreiben: nur HKCU über ctx.registry.writeValue (Spielmodus, Aufnahme im Hintergrund) und
// den aktiven Energieplan über powercfg /setactive. Die alten Werte werden vorher gespeichert ("Rückgängig").
// Alles mit Administrator-Rechten (z. B. GPU-Planung unter HKLM) wird nur erklärt und in Windows geöffnet.
// Kein Administrator, nichts am Spiel, nichts am Anti-Cheat.

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { HelixError } = require('../../sys/exec');
const logic = require('../../tools/wincheck-logic');

const ID = 'wincheck';
const STATE = 'tool-wincheck';
const SUMMARY_MAX_AGE = 6 * 3600 * 1000;

const PS_BATTERY = '[pscustomobject]@{ battery = @(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue).Count } | ConvertTo-Json -Compress';

let busy = false;
let DEPS = {}; // nur für Tests austauschbar: { statfs, readFile, release }

function isWindows(ctx) {
  return ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : process.platform === 'win32';
}

const UNSUPPORTED = {
  unsupported: true,
  message: 'Der Windows-Gaming-Check prüft Einstellungen von Windows. Das geht nur auf einem Windows-PC.',
};

async function powercfg(ctx, args) {
  const out = await ctx.exec.run('powercfg.exe', args, { timeout: 10000, encoding: 'buffer' });
  return logic.decodeConsole(out);
}

async function readPower(ctx) {
  try {
    const [a, l] = await Promise.all([powercfg(ctx, ['/getactivescheme']), powercfg(ctx, ['/list'])]);
    return { active: logic.parsePowercfgActive(a), list: logic.parsePowercfgList(l) };
  } catch (e) {
    ctx.log?.('warn', 'wincheck: powercfg', e && e.message);
    return null;
  }
}

/** Fortnite-Laufwerk aus der Installationsliste des Epic Launchers (nur lesen, nichts kopieren). */
async function fortniteDrive(ctx, deps) {
  const pd = ctx.env && (ctx.env.ProgramData || ctx.env.PROGRAMDATA);
  if (!pd) return null;
  const file = path.win32.join(pd, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
  try {
    const text = await (deps.readFile || fsp.readFile)(file, 'utf8');
    return logic.driveOf(logic.parseLauncherInstalled(text));
  } catch {
    return null;
  }
}

async function freeSpace(drive, deps) {
  try {
    const s = await (deps.statfs || fsp.statfs)(`${drive}\\`);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { free: NaN, total: NaN };
  }
}

async function readDisks(ctx, deps) {
  const env = ctx.env || {};
  const sys = logic.driveOf(env.SystemDrive || env.SYSTEMDRIVE || env.SystemRoot || env.windir || '');
  const fn = await fortniteDrive(ctx, deps);
  const drives = [];
  if (sys) drives.push({ drive: sys, windows: true, fortnite: fn === sys });
  if (fn && fn !== sys) drives.push({ drive: fn, windows: false, fortnite: true });
  const out = [];
  for (const d of drives) out.push({ ...d, ...(await freeSpace(d.drive, deps)) });
  return out;
}

/** Liest alles, was der Check braucht. deps (für Tests): { statfs, readFile, release } */
async function readRaw(ctx, deps = DEPS) {
  const reg = (key) => Promise.resolve().then(() => ctx.registry.readKey(key)).catch(() => null);
  const K = logic.KEYS;
  const [gameBar, gameConfig, gameDvr, graphics, mouse, nt, power, battery, disks] = await Promise.all([
    reg(K.gameBar), reg(K.gameConfig), reg(K.gameDvr), reg(K.graphics), reg(K.mouse), reg(K.ntVersion),
    readPower(ctx),
    Promise.resolve().then(() => ctx.exec.powershell(PS_BATTERY, { json: true, timeout: 15000 })).then((r) => (r && Number.isFinite(r.battery) ? r.battery : null)).catch(() => null),
    readDisks(ctx, deps),
  ]);
  return { gameBar, gameConfig, gameDvr, graphics, mouse, nt, power, battery, disks, release: deps.release || os.release() };
}

async function loadState(ctx) {
  const st = await ctx.core.readState(STATE, {}).catch(() => ({}));
  return { undo: {}, last: null, ...(st || {}), undo: { ...((st && st.undo) || {}) } };
}

function buildResult(raw, st) {
  const items = logic.evaluate(raw);
  for (const it of items) {
    const u = st.undo[it.id];
    if (u) it.undo = { at: u.at, label: logic.UNDO_LABELS[it.id] || 'Von HELIX geändert' };
  }
  const summary = logic.summarize(items);
  const win = logic.windowsInfo(raw.nt, raw.release);
  return {
    unsupported: false,
    at: Date.now(),
    groups: logic.GROUPS,
    items,
    summary,
    safeFixes: logic.safeFixIds(items),
    system: win ? { name: win.name, label: win.label, win11: win.win11 } : null,
  };
}

async function runCheck(ctx, deps = DEPS) {
  const raw = await readRaw(ctx, deps);
  const st = await loadState(ctx);
  const res = buildResult(raw, st);
  st.last = { at: res.at, open: res.summary.open, text: res.summary.text };
  await ctx.core.writeState(STATE, st).catch(() => {});
  return { raw, res };
}

async function withLock(fn) {
  if (busy) throw new HelixError('BUSY', 'HELIX ändert gerade schon etwas. Bitte kurz warten.');
  busy = true;
  try { return await fn(); } finally { busy = false; }
}

/** Schreibt die HKCU-Werte eines Fixes und merkt sich vorher die alten Werte. */
async function applyRegistryFix(ctx, id, raw, st) {
  const writes = logic.fixWrites(id, raw);
  if (!writes.length) return false;
  if (!st.undo[id]) {
    st.undo[id] = { at: Date.now(), values: logic.buildUndo(writes, raw) };
    await ctx.core.writeState(STATE, st); // zuerst sichern, dann schreiben
  }
  for (const w of writes) {
    if (!logic.isHkcu(w.key)) throw new HelixError('REG_DENIED', 'HELIX ändert nur Einstellungen deines eigenen Benutzerkontos.');
    await ctx.registry.writeValue(w.key, w.name, w.type, w.value);
  }
  return true;
}

async function applyPowerFix(ctx, raw, st) {
  const p = raw.power;
  if (!p || !p.active) throw new HelixError('POWER_UNKNOWN', 'Windows hat den aktiven Energieplan nicht verraten. Öffne die Energie-Einstellungen.');
  if (p.active.guid === logic.HIGH_PERFORMANCE) return false;
  if (!p.list.some((x) => x.guid === logic.HIGH_PERFORMANCE)) {
    throw new HelixError('POWER_PLAN_MISSING', 'Den Plan „Höchstleistung“ gibt es auf diesem PC nicht. Stelle in den Windows-Einstellungen den Energiemodus auf „Beste Leistung“.');
  }
  const prev = { at: Date.now(), prevGuid: p.active.guid, prevName: logic.planInfo(p.active.guid, p.active.name).name };
  try {
    await ctx.exec.run('powercfg.exe', ['/setactive', logic.HIGH_PERFORMANCE], { timeout: 10000 });
  } catch (e) {
    ctx.log?.('warn', 'wincheck: powercfg /setactive', e && e.message);
    throw new HelixError('POWER_DENIED', 'Windows hat das Umschalten nicht erlaubt. Ändere den Energieplan bitte in den Windows-Einstellungen.');
  }
  const now = logic.parsePowercfgActive(await powercfg(ctx, ['/getactivescheme']).catch(() => ''));
  if (!now || now.guid !== logic.HIGH_PERFORMANCE) {
    throw new HelixError('POWER_DENIED', 'Windows hat den Energieplan nicht umgestellt. Ändere ihn bitte in den Windows-Einstellungen.');
  }
  if (!st.undo.power) st.undo.power = prev;
  await ctx.core.writeState(STATE, st);
  return true;
}

module.exports = {
  id: ID,
  handlers: {
    /** Alle Punkte prüfen. */
    async check(_a, ctx) {
      if (!isWindows(ctx)) return UNSUPPORTED;
      return (await runCheck(ctx)).res;
    },

    /** Einen Punkt ändern: gamemode | gamedvr | power. */
    async fix(a, ctx) {
      if (!isWindows(ctx)) throw new HelixError('NOT_WINDOWS', UNSUPPORTED.message);
      const id = String(a.id || '');
      if (!logic.FIX_IDS.includes(id)) throw new HelixError('BAD_ARG', 'Diesen Punkt kann HELIX nicht selbst ändern.');
      return withLock(async () => {
        const raw = await readRaw(ctx);
        const st = await loadState(ctx);
        const changed = id === 'power' ? await applyPowerFix(ctx, raw, st) : await applyRegistryFix(ctx, id, raw, st);
        const { res } = await runCheck(ctx);
        return { ok: true, changed, message: changed ? logic.FIX_MESSAGES[id] : 'Das war schon richtig eingestellt.', result: res };
      });
    },

    /** "Alles Empfohlene anwenden": nur die sicheren HKCU-Punkte, die "ändern empfohlen" sind. */
    async fixAll(_a, ctx) {
      if (!isWindows(ctx)) throw new HelixError('NOT_WINDOWS', UNSUPPORTED.message);
      return withLock(async () => {
        const raw = await readRaw(ctx);
        const st = await loadState(ctx);
        const ids = logic.safeFixIds(logic.evaluate(raw));
        const applied = [];
        const failed = [];
        for (const id of ids) {
          try {
            if (await applyRegistryFix(ctx, id, raw, st)) applied.push(id);
          } catch (e) {
            failed.push({ id, message: e.message });
          }
        }
        const { res } = await runCheck(ctx);
        return { ok: !failed.length, applied, failed, result: res };
      });
    },

    /** Änderung von HELIX zurücknehmen. */
    async undo(a, ctx) {
      if (!isWindows(ctx)) throw new HelixError('NOT_WINDOWS', UNSUPPORTED.message);
      const id = String(a.id || '');
      if (!logic.FIX_IDS.includes(id)) throw new HelixError('BAD_ARG', 'Unbekannter Punkt.');
      return withLock(async () => {
        const st = await loadState(ctx);
        const rec = st.undo[id];
        if (!rec) throw new HelixError('NO_UNDO', 'Hier gibt es nichts rückgängig zu machen.');
        if (id === 'power') {
          const power = await readPower(ctx);
          if (!logic.isGuid(rec.prevGuid) || !power || !power.list.some((x) => x.guid === rec.prevGuid)) {
            delete st.undo.power;
            await ctx.core.writeState(STATE, st);
            throw new HelixError('POWER_PLAN_MISSING', 'Den vorherigen Energieplan gibt es nicht mehr. Wähle ihn bitte in den Windows-Einstellungen.');
          }
          try {
            await ctx.exec.run('powercfg.exe', ['/setactive', rec.prevGuid.toLowerCase()], { timeout: 10000 });
          } catch {
            throw new HelixError('POWER_DENIED', 'Windows hat das Umschalten nicht erlaubt. Ändere den Energieplan bitte in den Windows-Einstellungen.');
          }
        } else {
          for (const w of logic.undoWrites(rec.values)) await ctx.registry.writeValue(w.key, w.name, w.type, w.value);
        }
        const name = id === 'power' ? rec.prevName : null;
        delete st.undo[id];
        await ctx.core.writeState(STATE, st);
        const { res } = await runCheck(ctx);
        return { ok: true, message: name ? `Energieplan „${name}“ ist wieder aktiv.` : logic.UNDO_MESSAGES[id], result: res };
      });
    },

    async summary(_a, ctx) {
      if (!isWindows(ctx)) return null;
      const st = await loadState(ctx);
      if (st.last && Date.now() - st.last.at < SUMMARY_MAX_AGE) return { text: st.last.text };
      try {
        const { res } = await runCheck(ctx);
        return { text: res.summary.text };
      } catch {
        return st.last ? { text: st.last.text } : null;
      }
    },
  },
  _test: { readRaw, buildResult, runCheck, PS_BATTERY, resetLock: () => { busy = false; }, setDeps: (d) => { DEPS = d || {}; } },
};
