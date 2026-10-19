// Erzeugt die Logo-Assets in packages/ui/assets/ aus src/logo/geometry.ts.
// Aufruf: pnpm --filter @aegis/ui export-logo        (schreibt die Dateien)
//         pnpm --filter @aegis/ui export-logo --check (prüft nur, Exit-Code 1 bei Abweichung)
// Nutzt das in Node 22 eingebaute TypeScript-Type-Stripping (kein Build-Schritt nötig).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderLogoAssets } from '../src/logo/svg.ts';

const assetsDir = new URL('../assets/', import.meta.url);
const checkOnly = process.argv.includes('--check');
let outdated = 0;

function readCurrent(target) {
  try {
    return readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

if (!checkOnly) {
  mkdirSync(assetsDir, { recursive: true });
}
for (const [name, content] of Object.entries(renderLogoAssets())) {
  const target = new URL(name, assetsDir);
  const current = readCurrent(target);
  if (current === content) {
    process.stdout.write(`aktuell:   assets/${name}\n`);
    continue;
  }
  if (checkOnly) {
    outdated += 1;
    process.stderr.write(`veraltet:  assets/${name}\n`);
    continue;
  }
  writeFileSync(target, content, 'utf8');
  process.stdout.write(`erzeugt:   assets/${name}\n`);
}

if (outdated > 0) {
  process.stderr.write(
    'Logo-Assets veraltet – bitte `pnpm --filter @aegis/ui export-logo` ausführen.\n',
  );
  process.exitCode = 1;
}
