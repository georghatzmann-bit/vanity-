'use strict';
// Makes sure winget works (fresh Windows after a reset may not have it registered yet).
// NOTE: minimal version – full repair chain (Microsoft.WinGet.Client, msixbundle download) to be added.
const locate = require('./locate');
const { runPs } = require('../util/ps');
const log = require('../log');

const REGISTER_PS = `
try {
  Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
  Write-Output 'PHX:OK'
} catch {
  Write-Output ('PHX:FAIL:' + $_.Exception.Message)
}
`;

/** Resolves { ok, version, path?, error? }. Never throws. */
async function ensureWinget({ onProgress = () => {} } = {}) {
  onProgress({ step: 'detect', message: 'winget wird gesucht …' });
  let status = await locate.getStatus({ refresh: true });
  if (status.ok) return { ok: true, version: status.version, path: status.path };

  onProgress({ step: 'register', message: 'App-Installer wird registriert …' });
  try {
    const res = await runPs(REGISTER_PS, { timeoutMs: 120000 });
    log.info('winget register:', res.stdout.trim());
  } catch (err) {
    log.warn('winget register fehlgeschlagen', err);
  }
  status = await locate.getStatus({ refresh: true });
  if (status.ok) return { ok: true, version: status.version, path: status.path };

  const error = status.available
    ? `winget ist zu alt (${status.version}, benötigt ${status.minVersion}).`
    : 'winget wurde nicht gefunden.';
  return { ok: false, version: status.version, error };
}

module.exports = { ensureWinget };
