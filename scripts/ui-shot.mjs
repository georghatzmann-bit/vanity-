// Macht Screenshots der Oberfläche im Browser (Demo-Modus) - für Tests und Design-Kontrolle.
// Aufruf: node scripts/ui-shot.mjs <url> <ausgabe.png> [wartezeit-ms] [js-vor-dem-screenshot]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require("/opt/node22/lib/node_modules/playwright"); }
const [, , url, out, waitArg, script, widthArg, heightArg] = process.argv;
const browser = await playwright.chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: Number(widthArg || 1440), height: Number(heightArg || 900) } });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(Number(waitArg || 4000));
if (script) { await page.evaluate(script); await page.waitForTimeout(1200); }
await page.screenshot({ path: out });
await browser.close();
if (errors.length) console.log(errors.join("\n")); else console.log("ok, keine Fehler");
