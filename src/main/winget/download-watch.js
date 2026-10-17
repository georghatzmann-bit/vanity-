'use strict';
// winget >= 1.29 prints no progress bar when its output is piped. This watcher estimates the
// download progress from the growing installer file under %TEMP%\WinGet and the size reported
// by a HEAD request on the URL from the "Downloading <url>" line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

/** Content-Length of a URL (follows up to 5 redirects). Resolves a number or null. */
function contentLength(url, redirects = 5) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = new URL(url).protocol === 'http:' ? http : https;
    } catch {
      resolve(null);
      return;
    }
    const req = mod.request(url, { method: 'HEAD', timeout: 8000, headers: { 'User-Agent': 'winget-cli' } }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        resolve(contentLength(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      const len = Number(res.headers['content-length']);
      resolve(res.statusCode < 300 && len > 0 ? len : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Newest file (by mtime) below dir, at most two levels deep, modified after sinceMs. */
function newestFile(dir, sinceMs) {
  let best = null;
  const visit = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2) visit(full, depth + 1);
        continue;
      }
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= sinceMs && (!best || st.mtimeMs > best.mtimeMs)) best = { file: full, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        /* file vanished */
      }
    }
  };
  visit(dir, 0);
  return best;
}

/**
 * Starts watching. onProgress({ pct, bytes:{done,total} }) is called at most every 500 ms.
 * Returns stop().
 */
function watchDownload(url, onProgress) {
  const root = path.join(process.env.TEMP || os.tmpdir(), 'WinGet');
  const since = Date.now() - 2000;
  let total = null;
  let stopped = false;
  contentLength(url).then((len) => {
    total = len;
  });
  const timer = setInterval(() => {
    if (stopped) return;
    const f = newestFile(root, since);
    if (!f || !f.size) return;
    if (total && f.size <= total) onProgress({ pct: (f.size / total) * 100, bytes: { done: f.size, total } });
    else onProgress({ pct: null, bytes: { done: f.size, total: 0 } });
  }, 500);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { watchDownload, contentLength, newestFile };
