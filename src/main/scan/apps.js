'use strict';
// Installed apps: winget export (authoritative ids) merged with registry entries (names, versions, icons).
const catalog = require('../catalog');
const profile = require('../profile/profile');
const registry = require('./registry');
const { iconSource } = require('./icons');
const locate = require('../winget/locate');
const runner = require('../winget/runner');
const log = require('../log');

/** Candidate normalized names for a winget/msstore id. */
function candidates(app) {
  const names = new Set();
  const hit = catalog.lookup(app.id, app.source);
  if (hit) names.add(registry.normName(hit.name));
  if (app.name) names.add(registry.normName(app.name));
  names.add(registry.normName(catalog.prettifyId(app.id)));
  const last = app.id.split('.').pop();
  if (last && !/^(x64|x86|arm64|\d+)$/i.test(last)) names.add(registry.normName(last));
  return [...names].filter((n) => n.length >= 3);
}

function matches(entryNorm, cands) {
  return cands.some((c) => entryNorm === c || (c.length >= 4 && entryNorm.startsWith(c)) || (entryNorm.length >= 5 && c.startsWith(entryNorm)));
}

/** PURE merge step (unit-testable). Returns { apps, unmatched }. */
function mergeAppsWithRegistry(exportedApps, entries) {
  const apps = exportedApps.map((a) => ({ ...a }));
  const used = new Set();
  const normEntries = entries.map((e) => ({ e, norm: registry.normName(e.name) }));
  for (const app of apps) {
    const cands = candidates(app);
    const found = normEntries.find((ne) => !used.has(ne) && matches(ne.norm, cands));
    if (!found) continue;
    used.add(found);
    if (!app.version && found.e.version) app.version = found.e.version;
    if (found.e.publisher) app.publisher = found.e.publisher;
    if (!catalog.lookup(app.id, app.source) && (!app.name || app.name === app.id || app.name === catalog.prettifyId(app.id))) {
      app.name = found.e.name;
    }
    const src = iconSource(registry.iconPath(found.e.displayIcon), found.e.installLocation);
    if (src) app._iconSrc = src;
  }

  // Registry entries that winget did not report: rescue known catalog apps by name, list the rest.
  const catalogItems = catalog.getCatalog().items.filter((i) => i.source !== 'link');
  const byNorm = new Map(catalogItems.map((i) => [registry.normName(i.name), i]));
  const have = new Set(apps.map((a) => `${a.source}:${a.id}`.toLowerCase()));
  const unmatched = [];
  for (const ne of normEntries) {
    if (used.has(ne)) continue;
    const item = byNorm.get(ne.norm);
    if (item && !have.has(`${item.source}:${item.id}`.toLowerCase())) {
      have.add(`${item.source}:${item.id}`.toLowerCase());
      const app = { id: item.id, source: item.source, name: item.name, version: ne.e.version || undefined, publisher: ne.e.publisher || undefined };
      const src = iconSource(registry.iconPath(ne.e.displayIcon), ne.e.installLocation);
      if (src) app._iconSrc = src;
      apps.push(app);
      continue;
    }
    if (item) continue; // already covered
    unmatched.push({ name: ne.e.name, publisher: ne.e.publisher || undefined, version: ne.e.version || undefined });
  }
  unmatched.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { apps, unmatched };
}

/** Runs winget export + registry scan. Never throws; problems go to warnings. */
async function scanApps({ onPhase = () => {} } = {}) {
  const warnings = [];
  let exported = [];
  const status = await locate.getStatus();
  if (status.available) {
    onPhase('winget');
    try {
      const res = await runner.exportPackages({ wingetPath: status.path });
      if (res.ok && res.json) exported = profile.fromWingetExport(res.json).apps;
      else warnings.push('winget konnte die App-Liste nicht exportieren – es wird nur die Registry genutzt.');
    } catch (err) {
      log.warn('winget export fehlgeschlagen', err);
      warnings.push('winget konnte die App-Liste nicht exportieren – es wird nur die Registry genutzt.');
    }
  } else {
    warnings.push('winget ist auf diesem PC nicht verfügbar – es wird nur die Registry genutzt.');
  }

  onPhase('registry');
  let entries = [];
  try {
    entries = await registry.readUninstallEntries();
  } catch (err) {
    log.warn('Registry-Scan fehlgeschlagen', err);
    warnings.push('Die Registry konnte nicht gelesen werden.');
  }
  const merged = mergeAppsWithRegistry(exported, entries);
  return { ...merged, wingetStatus: status, warnings };
}

module.exports = { scanApps, mergeAppsWithRegistry, candidates };
