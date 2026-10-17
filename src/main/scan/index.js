'use strict';
// Full backup scan (ARCHITECTURE §1.1): apps, games, hardware, icons. Emits scan:progress.
const { scanApps } = require('./apps');
const { scanGames } = require('./games');
const { attachIcons } = require('./icons');
const hardware = require('./hardware');
const catalog = require('../catalog');

async function runScan({ onProgress = () => {} } = {}) {
  const report = (phase, message, pct, found) => onProgress({ phase, message, pct, found });

  report('start', 'Systemanalyse startet …', 2);
  const machinePromise = hardware.getMachineInfo();

  const appsRes = await scanApps({
    onPhase: (p) => {
      if (p === 'winget') report('winget', 'winget erfasst deine Apps …', 8);
      if (p === 'registry') report('registry', 'Installierte Programme werden gelesen …', 45);
    },
  });
  report('registry', `${appsRes.apps.length} Apps erkannt`, 60, appsRes.apps.length);

  report('games', 'Spielebibliotheken (Epic, Steam) werden gelesen …', 66, appsRes.apps.length);
  const games = await scanGames();
  report('games', `${games.length} Spiele gefunden`, 74, appsRes.apps.length);

  const total = appsRes.apps.filter((a) => a._iconSrc).length;
  report('icons', 'Icons werden gesammelt …', 76, appsRes.apps.length);
  await attachIcons(appsRes.apps, {
    onTick: (n) => report('icons', 'Icons werden gesammelt …', 76 + Math.round((n / Math.max(1, total)) * 20), appsRes.apps.length),
  });

  const machine = await machinePromise;
  const apps = appsRes.apps
    .map((a) => {
      const hit = catalog.lookup(a.id, a.source);
      return { ...a, category: a.category || (hit && hit.category) || undefined, elevation: (hit && hit.elevation) || a.elevation || 'unknown' };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));

  report('done', 'Fertig', 100, apps.length);
  return {
    apps,
    games,
    unmatched: appsRes.unmatched,
    machine,
    winget: { ok: !!(appsRes.wingetStatus && appsRes.wingetStatus.ok), version: (appsRes.wingetStatus && appsRes.wingetStatus.version) || null },
    warnings: appsRes.warnings,
  };
}

module.exports = { runScan };
