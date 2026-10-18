// Macht Bildschirmfotos der Oberfläche im Browser-Simulator.
// node scripts/shoot.mjs [ausgabeordner] [ansicht ...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'test-results/shots';
const views = process.argv.slice(3).length ? process.argv.slice(3) : ['cockpit', 'profiles'];
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
for (const v of views) {
  const [view, extra] = v.split('+');
  await page.goto(`http://localhost:${process.env.PORT || 4173}/index.html?nointro&view=${view}${extra ? '&' + extra : ''}`);
  await page.waitForTimeout(Number(process.env.WAIT || 1500));
  await page.screenshot({ path: path.join(out, `${v.replace(/[^\w-]/g, '_')}.png`) });
}
await browser.close();
if (errors.length) { console.log('FEHLER:\n' + errors.join('\n')); process.exitCode = 1; } else console.log('ok');
