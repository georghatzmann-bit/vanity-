'use strict';
// Session-Statistik: Spielzeit pro Profil und Tag, Aim-Test-Verlauf, Reaktions- und Ping-Werte.
// Nur lesend: liest die lokalen HELIX-Zustände (Spielzeit-Zähler und Ergebnisse der anderen Tools).
// Es wird nichts an Fortnite oder Windows verändert. Einzige Schreibaktion: die CSV-Datei, die der
// Nutzer selbst im Speichern-Dialog wählt.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { HelixError, IS_WIN } = require('../../sys/exec');
const logic = require('../../tools/stats-logic');

const ID = 'stats';

async function safeState(ctx, name, fallback) {
  try {
    const v = await ctx.core.readState(name, fallback);
    return v == null ? fallback : v;
  } catch (e) {
    ctx.log?.('warn', `stats: Zustand ${name} nicht lesbar`, e && e.message ? e.message : String(e));
    return fallback;
  }
}

/** Rohliste des Spielzeit-Zählers. Fällt auf ctx.sessions.summary() zurück, wenn sie fehlt. */
async function loadSessions(ctx) {
  const raw = await safeState(ctx, 'sessions', null);
  if (raw && typeof raw === 'object' && Array.isArray(raw.list)) return raw;
  try {
    if (ctx.sessions?.summary) return logic.sessionsFromSummary(await ctx.sessions.summary({ days: 90 }));
  } catch { /* kein Zähler verfügbar */ }
  return { list: [], current: null };
}

/** Aktuelle Profilnamen (damit umbenannte Profile richtig heißen). */
async function profileNames(ctx) {
  try {
    const list = await ctx.core.listProfiles();
    const names = {};
    for (const p of Array.isArray(list) ? list : []) if (p && p.id && p.name) names[p.id] = p.name;
    return names;
  } catch {
    return {};
  }
}

async function loadInputs(ctx) {
  const [sessionsRaw, sensi, reaktion, ping, names] = await Promise.all([
    loadSessions(ctx),
    safeState(ctx, 'tool-sensi', {}),
    safeState(ctx, 'tool-reaktion', {}),
    safeState(ctx, 'tool-ping', {}),
    profileNames(ctx),
  ]);
  return { sessionsRaw, sensi, reaktion, ping, names };
}

function trackingSupported(ctx) {
  return ctx.exec && typeof ctx.exec.IS_WIN === 'boolean' ? ctx.exec.IS_WIN : IS_WIN;
}

async function overview(args, ctx, now = Date.now()) {
  const input = await loadInputs(ctx);
  return logic.buildOverview({ ...input, days: logic.normDays(args?.days ?? 30), now, trackingSupported: trackingSupported(ctx) });
}

async function exportCsv(_args, ctx, now = Date.now()) {
  const input = await loadInputs(ctx);
  const sessions = logic.normalizeSessions(input.sessionsRaw, { now, names: input.names });
  const aim = logic.normalizeAim(input.sensi);
  const { reaction } = logic.normalizeReaction(input.reaktion);
  if (!sessions.length && !aim.length && !reaction.length) {
    throw new HelixError('NO_DATA', 'Es gibt noch keine Werte zum Speichern. Spiele zuerst eine Runde Fortnite, während HELIX läuft, oder mach einen Aim-Test.');
  }
  const el = ctx.electron || {};
  if (!el.dialog || typeof el.dialog.showSaveDialog !== 'function') {
    throw new HelixError('NO_DIALOG', 'Der Speichern-Dialog ist hier nicht verfügbar.');
  }
  let dir = '';
  try { dir = el.app?.getPath ? el.app.getPath('documents') : ''; } catch { dir = ''; }
  if (!dir) dir = ctx.env?.USERPROFILE || ctx.env?.HOME || '';
  const opts = {
    title: 'Statistik als Tabelle speichern',
    defaultPath: dir ? path.join(dir, logic.csvFileName(now)) : logic.csvFileName(now),
    buttonLabel: 'Speichern',
    filters: [{ name: 'CSV-Tabelle (Excel)', extensions: ['csv'] }],
  };
  const win = typeof el.getWindow === 'function' ? el.getWindow() : null;
  const r = win ? await el.dialog.showSaveDialog(win, opts) : await el.dialog.showSaveDialog(opts);
  if (!r || r.canceled || !r.filePath) return { canceled: true };
  let file = r.filePath;
  if (!/\.csv$/i.test(file)) file += '.csv';
  const csv = logic.buildCsv({ sessions, aim, reaction, now });
  try {
    await fsp.writeFile(file, csv, 'utf8');
  } catch (e) {
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
      throw new HelixError('WRITE_FAILED', 'Die Datei konnte nicht gespeichert werden. Ist sie vielleicht gerade in Excel geöffnet? Schließe sie und versuche es noch einmal.');
    }
    throw new HelixError('WRITE_FAILED', `Die Datei konnte nicht gespeichert werden (${e && e.code ? e.code : 'unbekannter Fehler'}).`);
  }
  return { canceled: false, file, fileName: path.basename(file), sessions: sessions.length, aimTests: aim.length, reactionTests: reaction.length };
}

async function summary(_args, ctx, now = Date.now()) {
  const input = await loadInputs(ctx);
  const sessions = logic.normalizeSessions(input.sessionsRaw, { now, names: input.names });
  const aim = logic.normalizeAim(input.sensi);
  return logic.summaryLine({ sessions, aim, now });
}

module.exports = {
  id: ID,
  handlers: {
    overview: (args, ctx) => overview(args, ctx),
    exportCsv: (args, ctx) => exportCsv(args, ctx),
    summary: (args, ctx) => summary(args, ctx),
  },
  // für Unit-Tests (mit fester Uhrzeit)
  _test: { overview, exportCsv, summary, loadInputs },
};
