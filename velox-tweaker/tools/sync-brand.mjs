// Copies the runtime files of the canonical brand kit (brand/) into every surface that embeds it.
// The copies are never edited in place: change brand/, then run this again.
//   node tools/sync-brand.mjs           copy (only files that differ are written)
//   node tools/sync-brand.mjs --check   exit 1 if a copy is missing or differs (no writes)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = path.join(root, 'brand');
const CORE = ['intro.js', 'sound.js', 'glyphs.js', 'intro.css', 'tokens.css'];
const SVG = ['mark.svg', 'mark-16.svg', 'app-icon.svg', 'wordmark.svg', 'wordmark-light.svg', 'wordmark-small.svg', 'wordmark-small-light.svg', 'lockup.svg'];
const SURFACES = {
  'ui/brand': [...CORE, 'tokens-app.css', ...SVG],          // web UI: in-app splash, sidebar, favicon
  'native/host/start/brand': [...CORE],                       // VELOX.exe start screen
  'native/setup-ui/brand': [...CORE, 'ticks.js', 'kit.css'],  // VeloxSetup.exe intro + screens
};

const check = process.argv.includes('--check');
let bad = 0, written = 0;
for (const [dir, files] of Object.entries(SURFACES)) {
  const dst = path.join(root, dir);
  if (!check) fs.mkdirSync(dst, { recursive: true });
  for (const f of files) {
    const src = fs.readFileSync(path.join(brand, f));
    const p = path.join(dst, f);
    const same = fs.existsSync(p) && Buffer.compare(fs.readFileSync(p), src) === 0;
    if (same) continue;
    if (check) { bad++; console.log((fs.existsSync(p) ? 'DIFFERENT  ' : 'MISSING    ') + path.join(dir, f)); continue; }
    fs.writeFileSync(p, src);
    written++;
  }
}
if (check) {
  console.log(bad ? `brand copies: ${bad} problem(s) - run: node tools/sync-brand.mjs` : 'brand copies: all identical');
  process.exit(bad ? 1 : 0);
}
console.log(`brand copies: ${written} file(s) written`);
