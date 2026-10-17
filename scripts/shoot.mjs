#!/usr/bin/env node
// Screenshot tool for the built renderer (dist/renderer). Builds nothing itself – run `npx vite build` first.
//
//   node scripts/shoot.mjs --out <dir> --shots '<json array>' [--width 1360] [--height 860] [--dist dist/renderer] [--offline]
//   node scripts/shoot.mjs --out <dir> --shots-file shots.json
//
// Shot spec:
//   { "name": "home", "query": "screen=home&firstRun=0&lag=0", "wait": 1500, "reducedMotion": false,
//     "width": 1100, "height": 700, "fullPage": false, "selector": ".card" (element-only screenshot),
//     "actions": [ { "click": "sel" }, { "hover": "sel" }, { "wait": 500 }, { "press": "Control+," },
//                  { "scroll": ".screen", "y": 900 }, { "type": "input", "text": "disc" },
//                  { "eval": "window.__phoenix.toast.success('Hallo')" }, { "eval": "fetchSomething()", "await": true },
//                  { "shot": "name-suffix" } ] }
// Tip: add "lag=0" to the query so GSAP follows wall-clock time in slow software rendering.
// Writes <out>/<name>.png (+ intermediate "shot" actions) and <out>/console.txt.
// Exits 1 on page errors (uncaught exceptions) or console errors (CSP violations etc.).
// Failed external image requests (favicons while offline) are reported but do not fail the run.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.out || (!args.shots && !args['shots-file'])) {
  console.error('Usage: node scripts/shoot.mjs --out <dir> --shots \'[{"name":"home","query":"screen=home&firstRun=0"}]\'');
  process.exit(2);
}

const distDir = path.resolve(ROOT, args.dist || 'dist/renderer');
const outDir = path.resolve(args.out);
const width = Number(args.width || 1360);
const height = Number(args.height || 860);
const shots = JSON.parse(args['shots-file'] ? fs.readFileSync(path.resolve(args['shots-file']), 'utf8') : args.shots);

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`No build found at ${distDir}. Run "npx vite build" first.`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// ---- static server ------------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(distDir, '.' + rel);
    if (!file.startsWith(distDir + path.sep) && file !== distDir) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  } catch {
    res.writeHead(400).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/index.html`;

// ---- browser ------------------------------------------------------------------------------------
// External images (favicons) are fetched with curl, which honours HTTPS_PROXY and the system CA bundle;
// --offline aborts them instead so the monogram fallback can be checked.
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

function curlFetch(url) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `shoot-${process.pid}-${Math.random().toString(36).slice(2)}`);
    execFile('curl', ['-sSL', '--max-time', '10', '-o', tmp, '-w', '%{http_code} %{content_type}', url], (err, stdout) => {
      let body = null;
      try {
        body = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
      } catch {
        /* no body */
      }
      if (err || !body) return resolve(null);
      const [code, type] = String(stdout).trim().split(' ');
      resolve({ status: Number(code) || 502, contentType: type || 'application/octet-stream', body });
    });
  });
}

async function routeExternal(context) {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    if (args.offline) return route.abort();
    const res = await curlFetch(route.request().url());
    if (!res) return route.abort();
    return route.fulfill({ status: res.status, contentType: res.contentType, body: res.body });
  });
}

const log = [];
let failures = 0;
const isExternal = (u) => u && !u.startsWith(`http://127.0.0.1:${port}`);

for (const spec of shots) {
  const name = String(spec.name || `shot-${shots.indexOf(spec)}`).replace(/[^\w.-]+/g, '_');
  const context = await browser.newContext({
    viewport: { width: Number(spec.width || width), height: Number(spec.height || height) },
    deviceScaleFactor: Number(spec.scale || 1),
    ignoreHTTPSErrors: true,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    reducedMotion: spec.reducedMotion ? 'reduce' : 'no-preference',
  });
  await routeExternal(context);
  const page = await context.newPage();
  const tag = `[${name}]`;

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    const loc = msg.location();
    const external = /Failed to load resource/.test(text) && isExternal(loc && loc.url);
    log.push(`${tag} console.${type}${external ? ' (external, ignored)' : ''}: ${text}`);
    if (type === 'error' && !external) failures++;
  });
  page.on('pageerror', (err) => {
    log.push(`${tag} PAGE ERROR: ${err.stack || err.message}`);
    failures++;
  });
  page.on('requestfailed', (req) => {
    const ext = isExternal(req.url());
    log.push(`${tag} request failed${ext ? ' (external, ignored)' : ''}: ${req.url()} – ${req.failure()?.errorText}`);
    if (!ext) failures++;
  });

  const url = `${base}${spec.query ? `?${spec.query}` : ''}`;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(Number(spec.wait ?? 1200));
    for (const action of spec.actions || []) {
      if (action.click) await page.click(action.click, { timeout: 8000 });
      else if (action.hover) await page.hover(action.hover, { timeout: 8000 });
      else if (action.press) await page.keyboard.press(action.press);
      else if (action.type) await page.fill(action.type, action.text ?? '');
      else if (action.scroll) {
        await page.evaluate(({ sel, y }) => {
          const el = document.querySelector(sel);
          if (el) el.scrollTop = y;
          else window.scrollTo(0, y);
        }, { sel: action.scroll, y: Number(action.y || 0) });
      } else if (action.eval) {
        // Runs as a statement block; returned promises are not awaited unless "await": true.
        await page.evaluate(action.await ? action.eval : `(() => { ${action.eval}\n})()`);
      }
      else if (action.shot) await page.screenshot({ path: path.join(outDir, `${name}-${action.shot}.png`) });
      if (action.wait !== undefined) await page.waitForTimeout(Number(action.wait));
    }
    const file = path.join(outDir, `${name}.png`);
    if (spec.selector) await page.locator(spec.selector).first().screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: !!spec.fullPage });
    console.log(`saved ${file}`);
  } catch (err) {
    log.push(`${tag} SHOT FAILED: ${err.message}`);
    failures++;
    console.error(`${tag} failed: ${err.message}`);
  }
  await context.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'console.txt'), log.join('\n') + '\n');

if (failures) {
  console.error(`\n${failures} error(s) – see ${path.join(outDir, 'console.txt')}`);
  for (const line of log.filter((l) => /PAGE ERROR|console\.error(?! \(external)|SHOT FAILED|request failed(?! \(external)/.test(l))) console.error('  ' + line);
  process.exit(1);
}
console.log(`ok – ${shots.length} shot(s), console log at ${path.join(outDir, 'console.txt')}`);
