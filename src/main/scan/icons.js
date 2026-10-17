'use strict';
// App icons as 32px PNG data URLs (stored in the profile so the restore screen shows real icons).
const fs = require('fs');
const path = require('path');

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Picks a usable icon source: DisplayIcon (exe/ico/dll) or the first .exe in the install folder. */
function iconSource(displayIconPath, installLocation) {
  if (displayIconPath && fs.existsSync(displayIconPath)) return displayIconPath;
  if (installLocation) {
    try {
      const dir = installLocation.replace(/^"|"$/g, '');
      const exe = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe') && !/unins|uninstall|update|crash|helper/i.test(f));
      if (exe) return path.join(dir, exe);
    } catch {
      /* folder gone */
    }
  }
  return null;
}

async function iconDataUrl(file) {
  const { app } = require('electron');
  const img = await withTimeout(app.getFileIcon(file, { size: 'normal' }), 3000);
  if (!img || img.isEmpty()) return null;
  const url = img.toDataURL();
  return url.length <= 60 * 1024 ? url : null;
}

/** Adds .icon to each app that has _iconSrc; runs with limited concurrency. Never throws. */
async function attachIcons(apps, { concurrency = 4, onTick } = {}) {
  const queue = apps.filter((a) => a._iconSrc);
  let done = 0;
  async function worker() {
    while (queue.length) {
      const app = queue.shift();
      try {
        const url = await iconDataUrl(app._iconSrc);
        if (url) app.icon = url;
      } catch {
        /* ignore */
      }
      done++;
      if (onTick) onTick(done);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const a of apps) delete a._iconSrc;
  return apps;
}

module.exports = { iconSource, attachIcons };
