'use strict';
// Sucht den Fortnite-Einstellungsordner selbst, statt einen festen Pfad anzunehmen.
// Reihenfolge: eigene Auswahl des Nutzers -> %LOCALAPPDATA% -> %USERPROFILE%\AppData\Local
// -> alle Ordner in diesen Orten, deren Name "Fortnite" enthält.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { isDir, walk } = require('./fsutil');
const { isBlockedRoot } = require('./sensitive');

function baseDirs(env) {
  const bases = [];
  const add = (p) => {
    if (!p) return;
    const r = path.resolve(p);
    if (!bases.some((b) => b.toLowerCase() === r.toLowerCase())) bases.push(r);
  };
  add(env.LOCALAPPDATA);
  if (env.USERPROFILE) add(path.join(env.USERPROFILE, 'AppData', 'Local'));
  if (env.HOME && process.platform !== 'win32') add(path.join(env.HOME, '.local', 'share'));
  return bases;
}

/** Bewertet einen möglichen Saved-Ordner: wie viele Einstellungsdateien liegen in Config? */
async function rateSavedDir(savedDir) {
  const configDir = path.join(savedDir, 'Config');
  if (!(await isDir(configDir))) return null;
  const { files } = await walk(configDir, { maxDepth: 4, maxFiles: 400 });
  const settings = files.filter((f) => /\.(ini|sav)$/i.test(f.rel));
  if (!settings.length) return { savedDir, configDir, score: 0, files: 0, hasGameUserSettings: false };
  const hasGus = settings.some((f) => /(^|\/)GameUserSettings\.ini$/i.test(f.rel));
  const hasClient = settings.some((f) => /ClientSettings.*\.sav$/i.test(f.rel));
  return {
    savedDir,
    configDir,
    files: settings.length,
    hasGameUserSettings: hasGus,
    hasClientSettings: hasClient,
    score: settings.length + (hasGus ? 100 : 0) + (hasClient ? 50 : 0),
  };
}

/** Prüft, ob die GameUserSettings.ini wirklich von Fortnite stammt. */
async function looksLikeFortnite(configDir) {
  const { files } = await walk(configDir, { maxDepth: 4, maxFiles: 400 });
  for (const f of files) {
    if (!/(^|\/)GameUserSettings\.ini$/i.test(f.rel)) continue;
    try {
      const text = await fsp.readFile(f.abs, 'utf8');
      if (/\[\/Script\/FortniteGame\./i.test(text) || /\0\[\0\/\0S\0c\0r\0i\0p\0t\0\/\0F\0o\0r\0t\0n\0i\0t\0e/i.test(text)) return true;
    } catch { /* weiter */ }
  }
  return false;
}

/**
 * Findet den Fortnite-"Saved"-Ordner.
 * Rückgabe: { found, savedDir, configDir, candidates, searched, source }
 */
async function locateFortnite({ env = process.env, override = null } = {}) {
  const searched = [];
  const candidates = [];

  if (override) {
    const dir = path.basename(override).toLowerCase() === 'config' ? path.dirname(override) : override;
    searched.push(dir);
    // Nur echte Fortnite-Ordner: nie den Epic Games Launcher o. Ä., und es muss Fortnite-Grafikeinstellungen geben
    if (!isBlockedRoot(dir)) {
      const r = await rateSavedDir(dir);
      if (r && r.hasGameUserSettings && await looksLikeFortnite(r.configDir)) {
        return { found: true, ...r, candidates: [r], searched, source: 'manual' };
      }
    }
  }

  for (const base of baseDirs(env)) {
    const direct = path.join(base, 'FortniteGame', 'Saved');
    searched.push(direct);
    const r = await rateSavedDir(direct);
    if (r) candidates.push({ ...r, source: 'standard' });

    // weitere Ordner mit "Fortnite" im Namen (z. B. umbenannt oder andere Variante)
    let entries = [];
    try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch { /* fehlt */ }
    for (const ent of entries) {
      if (!ent.isDirectory() || !/fortnite/i.test(ent.name) || ent.name === 'FortniteGame' || isBlockedRoot(ent.name)) continue;
      const saved = path.join(base, ent.name, 'Saved');
      searched.push(saved);
      const r2 = await rateSavedDir(saved);
      if (r2) candidates.push({ ...r2, source: 'gesucht' });
    }
  }

  // Der Standardordner hat immer Vorrang – eine Kopie wie "FortniteGame - Kopie" wird nur genommen,
  // wenn es den Standardordner nicht gibt.
  candidates.sort((a, b) => ((b.source === 'standard') - (a.source === 'standard')) || (b.score - a.score));
  const best = candidates.find((c) => c.score > 0) || candidates[0];
  if (!best) return { found: false, candidates, searched, source: null };
  return { found: true, ...best, candidates, searched };
}

module.exports = { locateFortnite, rateSavedDir, baseDirs };
