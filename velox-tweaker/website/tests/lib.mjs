// Shared helpers for the website tests: a tiny static server that behaves like GitHub Pages
// (site under /vanity-/, 404.html for unknown paths) and the Playwright loader.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const site = path.resolve(here, '..');            // velox-tweaker/website
export const app = path.resolve(site, '..');             // velox-tweaker
export const BASE = '/vanity-/';                         // like a GitHub Pages project site

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

export function loadPlaywright() {
  const tries = [
    () => createRequire(import.meta.url)('playwright'),
    () => createRequire('/opt/node22/lib/node_modules/')('playwright'),
    () => createRequire(execSync('npm root -g').toString().trim() + '/')('playwright'),
  ];
  for (const t of tries) { try { return t(); } catch { /* next */ } }
  throw new Error('Playwright not found (expected the global install in /opt/node22/lib/node_modules).');
}

export function startServer() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(req.url);
    if (u.pathname === '/' ) { res.writeHead(302, { location: BASE }); res.end(); return; }
    let rel = u.pathname.startsWith(BASE) ? decodeURIComponent(u.pathname.slice(BASE.length)) : null;
    let file = rel === null ? null : path.join(site, rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel);
    if (file && !file.startsWith(site)) file = null;
    if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file || !fs.existsSync(file) || file.includes(`${path.sep}tests${path.sep}`)) {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      res.end(fs.readFileSync(path.join(site, '404.html')));
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + srv.address().port;
    resolve({ srv, origin, url: origin + BASE, requests, close: () => new Promise((r) => srv.close(r)) });
  }));
}

export const SAMPLE_FRAGMENT = 'v=1&p=asus&c=amd&s=rpt.dcu.rbo.csu.sbt.tpo.xlu.vtu.fcu&w=bo.bl.vb&g=val.fct&b=ROG%20STRIX%20B550-F%20GAMING&i=2803&d=20220312';
