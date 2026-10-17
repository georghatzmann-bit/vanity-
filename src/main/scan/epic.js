'use strict';
// PURE parsers for Epic Games Launcher data files.
//   %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item   (one JSON per installed app)
//   %ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat (JSON InstallationList)

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** True for engine installs, engine plugins, DLC/add-ons and other non-game entries (rules from Playnite/Legendary). */
function isNonGame(item) {
  const appName = String(item.AppName || '');
  if (!appName || /^UE_/i.test(appName)) return true;
  if (String(item.CatalogNamespace || '').toLowerCase() === 'ue') return true;
  const categories = Array.isArray(item.AppCategories) ? item.AppCategories.map((c) => String(c).toLowerCase()) : [];
  if (categories.includes('addons') && !categories.includes('addons/launchable')) return true;
  if (categories.includes('dlc') || categories.includes('engines') || categories.includes('plugins') || categories.includes('plugins/engine')) return true;
  if (String(item.TechnicalType || '').toLowerCase().includes('plugins/engine')) return true;
  if (Array.isArray(item.CompatibleApps) && item.CompatibleApps.some((a) => /^UE_/i.test(String(a)))) return true;
  if (item.MainGameAppName && item.MainGameAppName !== appName) return true;
  return false;
}

/** One *.item manifest -> GameEntry or null. */
function parseEpicItem(text) {
  const item = parseJson(text);
  if (!item || typeof item !== 'object' || isNonGame(item)) return null;
  const title = String(item.DisplayName || item.AppName || '').trim();
  if (!title) return null;
  return {
    platform: 'epic',
    title,
    appName: String(item.AppName),
    namespace: item.CatalogNamespace ? String(item.CatalogNamespace) : undefined,
    catalogItemId: item.CatalogItemId ? String(item.CatalogItemId) : undefined,
    sizeBytes: Number(item.InstallSize) > 0 ? Number(item.InstallSize) : undefined,
    installLocation: item.InstallLocation ? String(item.InstallLocation) : undefined,
  };
}

/** LauncherInstalled.dat -> GameEntry[] (fallback when the manifests folder is missing). */
function parseLauncherInstalled(text) {
  const data = parseJson(text);
  const list = data && Array.isArray(data.InstallationList) ? data.InstallationList : [];
  return list
    .filter((e) => e && e.AppName && !/^UE_/i.test(e.AppName) && String(e.NamespaceId || '').toLowerCase() !== 'ue')
    .map((e) => ({
      platform: 'epic',
      title: String(e.AppName) === 'Fortnite' ? 'Fortnite' : String(e.AppName),
      appName: String(e.AppName),
      namespace: e.NamespaceId ? String(e.NamespaceId) : undefined,
      catalogItemId: e.ItemId ? String(e.ItemId) : undefined,
      installLocation: e.InstallLocation ? String(e.InstallLocation) : undefined,
    }));
}

/** Merges manifest entries with LauncherInstalled entries (manifests win). */
function mergeEpic(fromManifests, fromInstalled) {
  const byApp = new Map();
  for (const g of fromInstalled) byApp.set(g.appName.toLowerCase(), g);
  for (const g of fromManifests) byApp.set(g.appName.toLowerCase(), { ...byApp.get(g.appName.toLowerCase()), ...g });
  return [...byApp.values()];
}

module.exports = { parseEpicItem, parseLauncherInstalled, mergeEpic, isNonGame };
