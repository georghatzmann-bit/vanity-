// Rendert eine SVG-Datei mit Chromium (Playwright) als PNG in hoher Qualität.
// Aufruf: node scripts/render-svg.mjs <eingabe.svg> <ausgabe.png> <groesse>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require("/opt/node22/lib/node_modules/playwright"); }
const [, , input, output, sizeArg] = process.argv;
const size = Number(sizeArg || 1024);
const svg = readFileSync(input, "utf8");
const browser = await playwright.chromium.launch();
const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
await page.locator("svg").screenshot({ path: output, omitBackground: true });
await browser.close();
console.log("geschrieben:", output);
