'use strict';
// Game library scan: Epic Games (Fortnite …) and Steam.
const fs = require('fs');
const path = require('path');
const { parseEpicItem, parseLauncherInstalled, mergeEpic } = require('./epic');
const { parseLibraryFolders, parseAppManifest } = require('./vdf');
const { regQueryValue } = require('../util/reg');
const log = require('../log');

// Steam entries that are tools/runtimes, not games.
// (ids verified via api.steamcmd.net: redistributables, Proton, Steam Linux Runtime, Source SDK)
const STEAM_SKIP_IDS = new Set([228980, 1070560, 1391110, 1628350, 1493710, 3658110, 2180100, 1054830, 1245040, 961940, 858280, 1113280, 1826330, 1161040, 243750, 243730]);
const STEAM_SKIP_NAME = /^(Steamworks Common|Steam Linux Runtime|Proton\b|Steam Audio)/i;

function programData() {
  return process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

async function epicManifestsDir() {
  const fromReg = await regQueryValue('HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'AppDataPath');
  const candidates = [fromReg && path.join(fromReg, 'Manifests'), path.join(programData(), 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')];
  return candidates.find((d) => d && fs.existsSync(d)) || candidates[candidates.length - 1];
}

/** Epic does not clean up old manifests: keep only games whose folder still exists. */
function stillInstalled(game) {
  if (!game.installLocation) return true;
  try {
    return fs.existsSync(game.installLocation);
  } catch {
    return true;
  }
}

async function scanEpic() {
  const manifestsDir = await epicManifestsDir();
  const fromManifests = [];
  try {
    for (const name of fs.readdirSync(manifestsDir)) {
      if (!name.toLowerCase().endsWith('.item')) continue;
      const game = parseEpicItem(readText(path.join(manifestsDir, name)));
      if (game) fromManifests.push(game);
    }
  } catch {
    /* no manifests folder */
  }
  const datText = readText(path.join(programData(), 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'));
  const fromInstalled = datText ? parseLauncherInstalled(datText) : [];
  return mergeEpic(fromManifests, fromInstalled).filter(stillInstalled);
}

async function steamRoot() {
  const fromReg = await regQueryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const fromHklm = await regQueryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath');
  const candidates = [
    fromReg && fromReg.replace(/\//g, '\\'),
    fromHklm,
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(path.join(p, 'steamapps'))) || null;
}

async function scanSteam() {
  const root = await steamRoot();
  if (!root) return [];
  const libs = new Set([path.join(root, 'steamapps')]);
  for (const vdf of [path.join(root, 'steamapps', 'libraryfolders.vdf'), path.join(root, 'config', 'libraryfolders.vdf')]) {
    const text = readText(vdf);
    if (!text) continue;
    for (const lib of parseLibraryFolders(text)) libs.add(path.join(lib.path, 'steamapps'));
  }
  const games = new Map();
  for (const lib of libs) {
    let files = [];
    try {
      files = fs.readdirSync(lib).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const m = parseAppManifest(readText(path.join(lib, f)));
      if (!m || STEAM_SKIP_IDS.has(m.appId) || STEAM_SKIP_NAME.test(m.name)) continue;
      games.set(m.appId, { platform: 'steam', title: m.name, appId: m.appId, sizeBytes: m.sizeBytes || undefined });
    }
  }
  return [...games.values()];
}

/** GameEntry[] sorted by title. Never throws. */
async function scanGames() {
  const out = [];
  try {
    out.push(...(await scanEpic()));
  } catch (err) {
    log.warn('Epic-Scan fehlgeschlagen', err);
  }
  try {
    out.push(...(await scanSteam()));
  } catch (err) {
    log.warn('Steam-Scan fehlgeschlagen', err);
  }
  return out
    .map(({ installLocation, ...g }) => g)
    .sort((a, b) => a.title.localeCompare(b.title, 'de'));
}

module.exports = { scanGames, scanEpic, scanSteam, steamRoot };
