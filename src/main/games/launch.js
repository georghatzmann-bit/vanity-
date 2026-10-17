'use strict';
// Triggers game installs through the launchers (the user must be logged in there).
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { regKeysExist } = require('../util/reg');

/** PURE: launcher URI that opens the install dialog for a GameEntry, or null. */
function installUri(game) {
  if (!game || typeof game !== 'object') return null;
  if (game.platform === 'steam') {
    const id = Math.trunc(Number(game.appId));
    return id > 0 ? `steam://install/${id}` : null;
  }
  if (game.platform === 'epic') {
    const app = String(game.appName || '');
    if (!/^[A-Za-z0-9_.\-]+$/.test(app)) return null;
    if (game.namespace && game.catalogItemId && /^[A-Za-z0-9_\-]+$/.test(game.namespace) && /^[A-Za-z0-9]+$/.test(game.catalogItemId)) {
      return `com.epicgames.launcher://apps/${game.namespace}%3A${game.catalogItemId}%3A${app}?action=install`;
    }
    return `com.epicgames.launcher://apps/${app}?action=install`;
  }
  return null;
}

/** PURE: store page used when the launcher route is not available. */
function fallbackUrl(game) {
  if (!game) return null;
  if (game.platform === 'steam' && game.appId) return `https://store.steampowered.com/app/${Math.trunc(Number(game.appId))}/`;
  if (game.platform === 'epic') {
    if (game.appName === 'Fortnite') return 'https://store.epicgames.com/de/p/fortnite';
    return `https://store.epicgames.com/de/browse?q=${encodeURIComponent(game.title || game.appName || '')}`;
  }
  return null;
}

function firstExisting(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || null;
}

/** Which launchers are installed and have their URI handler registered. */
async function detectLaunchers() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const [epicUri, steamUri] = await regKeysExist(['HKCR\\com.epicgames.launcher', 'HKCR\\steam']);
  const epicExe = firstExisting([
    path.join(pf86, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
    path.join(pf, 'Epic Games', 'Launcher', 'Portal', 'Binaries', 'Win64', 'EpicGamesLauncher.exe'),
  ]);
  const steamExe = firstExisting([path.join(pf86, 'Steam', 'steam.exe'), path.join(pf, 'Steam', 'steam.exe')]);
  return {
    epic: { installed: !!(epicExe || epicUri) },
    steam: { installed: !!(steamExe || steamUri) },
  };
}

/** Opens the launcher install dialog. Returns { ok, uri, error? }. */
async function installGame(game) {
  const uri = installUri(game);
  if (!uri) return { ok: false, uri: null, error: 'Für dieses Spiel gibt es keinen Installations-Link.' };
  const launchers = await detectLaunchers();
  const launcher = game.platform === 'epic' ? launchers.epic : launchers.steam;
  if (!launcher || !launcher.installed) {
    const name = game.platform === 'epic' ? 'Epic Games Launcher' : 'Steam';
    return { ok: false, uri, error: `${name} ist noch nicht installiert. Installiere ihn zuerst.` };
  }
  try {
    await shell.openExternal(uri);
    return { ok: true, uri };
  } catch (err) {
    const fb = fallbackUrl(game);
    if (fb) await shell.openExternal(fb).catch(() => {});
    return { ok: false, uri, error: 'Der Launcher konnte nicht geöffnet werden – die Store-Seite wurde stattdessen geöffnet.' };
  }
}

module.exports = { installUri, fallbackUrl, detectLaunchers, installGame };
