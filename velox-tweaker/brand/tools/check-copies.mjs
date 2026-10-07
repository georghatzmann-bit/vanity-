// Every surface embeds brand/ unchanged. This checks that each copy is byte-identical.
//   node brand/tools/check-copies.mjs            -> exit 1 on any difference
// A "copy" is any folder named brand (or velox-brand) elsewhere in velox-tweaker/ that holds
// one of the runtime files below. Missing files in a copy are fine (a surface may need only
// some); a file that exists must match the canonical one byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const brand = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(brand, '..');
const RUNTIME = ['intro.js', 'light-worker.js', 'sound.js', 'glyphs.js', 'ticks.js', 'intro.css', 'kit.css', 'tokens.css', 'tokens-app.css', 'mark.svg', 'mark-16.svg', 'app-icon.svg',
  'wordmark.svg', 'wordmark-light.svg', 'wordmark-small.svg', 'wordmark-small-light.svg', 'lockup.svg'];
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const canon = Object.fromEntries(RUNTIME.map((f) => [f, hash(path.join(brand, f))]));
const copies = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'bin' || e.name === 'obj') continue;
    const p = path.join(dir, e.name);
    if (p === brand) continue;
    if (e.name === 'brand' || e.name === 'velox-brand') copies.push(p);
    walk(p);
  }
})(root);
let bad = 0, checked = 0;
for (const c of copies) for (const f of RUNTIME) {
  const p = path.join(c, f);
  if (!fs.existsSync(p)) continue;
  checked++;
  if (hash(p) !== canon[f]) { bad++; console.log('DIFFERENT  ' + path.relative(root, p)); }
}
console.log(`${copies.length} copies, ${checked} files checked, ${bad} different`);
process.exit(bad ? 1 : 0);
