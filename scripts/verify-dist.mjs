#!/usr/bin/env node
// Sanity check of a finished build (local and CI): Setup.exe exists and app.asar holds what
// Phoenix needs at runtime. Usage: node scripts/verify-dist.mjs [releaseDir]   (default: release)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(join(ROOT, 'package.json'));
const asar = require('@electron/asar');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const dir = resolve(ROOT, process.argv[2] || 'release');
const setup = join(dir, `Phoenix-Setup-${version}.exe`);
const asarFile = join(dir, 'win-unpacked', 'resources', 'app.asar');
const REQUIRED = [
  '/package.json',
  '/src/main/main.js',
  '/src/main/winget/Ensure-Winget.ps1',
  '/src/main/catalog/catalog.json',
  '/src/preload/preload.js',
  '/dist/renderer/index.html',
];

const problems = [];
if (!existsSync(setup)) problems.push(`missing ${setup}`);
if (!existsSync(asarFile)) problems.push(`missing ${asarFile}`);
let entries = [];
if (existsSync(asarFile)) {
  // asar lists entries with the platform separator (\\ on Windows) – compare with forward slashes
  entries = asar.listPackage(asarFile).map((e) => e.replace(/\\/g, '/'));
  for (const f of REQUIRED) if (!entries.includes(f)) problems.push(`app.asar lacks ${f}`);
  const maps = entries.filter((f) => f.endsWith('.map'));
  if (maps.length) problems.push(`app.asar contains source maps: ${maps.join(', ')}`);
}

if (problems.length) {
  console.error('verify-dist: FAILED\n  ' + problems.join('\n  '));
  process.exit(1);
}
const mb = (statSync(setup).size / 1048576).toFixed(1);
console.log(`verify-dist: OK  ${setup} (${mb} MiB), app.asar ${entries.length} entries`);
