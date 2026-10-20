// Baut die Erweiterung nach dist/: je Einstieg ein eigenständiges Skript (IIFE, kein
// nachgeladener Code), dazu public/ (Manifest, Seiten, Regeln) und die App-Symbole.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = resolve(root, '../../apps/desktop/src-tauri/icons');
const entries = ['background', 'content', 'popup'];

for (const [index, name] of entries.entries()) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    publicDir: index === 0 ? 'public' : false,
    build: {
      outDir: 'dist',
      emptyOutDir: index === 0,
      target: 'chrome121',
      minify: false,
      sourcemap: false,
      lib: {
        entry: resolve(root, `src/${name}.ts`),
        formats: ['iife'],
        name: `aegis_${name}`,
        fileName: () => `${name}.js`,
      },
    },
  });
}

await mkdir(resolve(root, 'dist/icons'), { recursive: true });
await copyFile(resolve(icons, '32x32.png'), resolve(root, 'dist/icons/32.png'));
await copyFile(resolve(icons, '128x128.png'), resolve(root, 'dist/icons/128.png'));
console.warn('vault: dist/ gebaut');
