'use strict';
// Finds winget and checks that its version supports the flags Phoenix uses.
const path = require('path');
const { spawn } = require('child_process');

// Older clients talk to a retired CDN and may exit silently (winget-cli troubleshooting docs).
const MIN_VERSION = '1.6.3482';

function parseVersion(text) {
  const m = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Possible winget locations, best first. The per-package alias folder exists even when the
 * "app execution alias" toggle is off (Microsoft.WinGet.Client uses it too).
 * Never fs.stat() these aliases – that throws EACCES; spawn and treat ENOENT as "missing".
 */
function candidates() {
  const list = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    list.push(path.join(local, 'Microsoft', 'WindowsApps', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'winget.exe'));
    list.push(path.join(local, 'Microsoft', 'WindowsApps', 'winget.exe'));
  }
  list.push('winget.exe');
  return list;
}

function probe(exe, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(exe, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const version = parseVersion(out);
      resolve(code === 0 && version ? version : null);
    });
  });
}

let cached = null;

/** { available, version, path, ok, minVersion } – cached until refresh is requested. */
async function getStatus({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  if (process.platform !== 'win32') {
    cached = { available: false, version: null, path: null, ok: false, minVersion: MIN_VERSION };
    return cached;
  }
  for (const exe of candidates()) {
    const version = await probe(exe);
    if (version) {
      cached = { available: true, version, path: exe, ok: compareVersions(version, MIN_VERSION) >= 0, minVersion: MIN_VERSION };
      return cached;
    }
  }
  cached = { available: false, version: null, path: null, ok: false, minVersion: MIN_VERSION };
  return cached;
}

module.exports = { getStatus, parseVersion, compareVersions, MIN_VERSION };
