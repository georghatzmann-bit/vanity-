'use strict';
// Own programs shipped inside Phoenix (resources/extras), installed silently with one UAC prompt.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { runPs } = require('../util/ps');
const log = require('../log');

const EXTRAS = [
  {
    id: 'velox',
    name: 'VELOX Tweaker',
    version: '1.3.0',
    desc: 'Dein PC-Tweaker mit Presets, KI-Analyse und Sicherung jeder Änderung',
    file: 'VeloxSetup.exe',
    args: '/S',
  },
];

function extrasDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'extras') : path.join(__dirname, '..', '..', '..', 'build', 'extras');
}

function listExtras() {
  return EXTRAS.map(({ id, name, version, desc, file }) => ({ id, name, version, desc, available: fs.existsSync(path.join(extrasDir(), file)) }));
}

// The installers ask for admin rights themselves; Start-Process -Verb RunAs shows the UAC prompt.
const EXTRA_INSTALL_PS = `
try {
  $p = Start-Process -FilePath $env:PHX_FILE -ArgumentList $env:PHX_ARGS -Verb RunAs -Wait -PassThru
  [Console]::Out.WriteLine('EXIT:' + $p.ExitCode)
} catch {
  [Console]::Out.WriteLine('FAILED:' + $_.Exception.Message)
}
`;

async function installExtra(id) {
  const extra = EXTRAS.find((e) => e.id === id);
  if (!extra) throw new Error('Unbekanntes Programm.');
  const file = path.join(extrasDir(), extra.file);
  if (!fs.existsSync(file)) throw new Error(`${extra.name} ist in dieser Phoenix-Version nicht enthalten.`);
  log.info(`${extra.name} wird installiert`);
  const res = await runPs(EXTRA_INSTALL_PS, { env: { PHX_FILE: file, PHX_ARGS: extra.args }, timeoutMs: 10 * 60000 });
  const exit = /EXIT:(-?\d+)/.exec(res.stdout);
  if (exit && Number(exit[1]) === 0) return { ok: true };
  const failed = /FAILED:(.*)/.exec(res.stdout);
  if (failed && /cancel|abgebrochen/i.test(failed[1])) return { ok: false, declined: true, error: 'Die Windows-Abfrage wurde abgelehnt.' };
  log.warn(`${extra.name}: ${res.stdout.trim()} ${res.stderr.trim()}`);
  return { ok: false, error: exit ? `Setup beendet mit Code ${exit[1]}.` : 'Setup konnte nicht gestartet werden.' };
}

module.exports = { EXTRAS, listExtras, installExtra, EXTRA_INSTALL_PS };
