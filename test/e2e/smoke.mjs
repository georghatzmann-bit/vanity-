// Klickt HELIX einmal komplett durch (echte App, echter Hauptprozess) und macht Bildschirmfotos.
// Linux:   xvfb-run -a node test/e2e/smoke.mjs
// Windows: node test/e2e/smoke.mjs "C:\...\HELIX.exe"
// Braucht das npm-Paket "playwright" (wird nicht mit ausgeliefert).
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { makeLocalAppData, GUS_MAIN } = require(path.join(root, 'test', 'helpers.js'));

const packagedExe = process.argv[2];
const outDir = process.env.SHOTS_DIR || path.join(root, 'test-results', 'e2e');
fs.mkdirSync(outDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-e2e-data-'));
const fx = makeLocalAppData({ withRememberMe: true, clientSettings: 'MAIN-KEYS' });
const env = { ...process.env, LOCALAPPDATA: fx.local, HELIX_DATA_DIR: dataDir, HELIX_NO_INTRO: '1' };

const launch = packagedExe
  ? { executablePath: packagedExe, args: [], env }
  : {
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: ['--no-sandbox', root],
    env,
  };

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
const app = await electron.launch({ ...launch, timeout: 90000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => errors.push('Seitenfehler: ' + e.message));
win.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|ERR_FILE_NOT_FOUND/.test(m.text())) errors.push('Konsole: ' + m.text());
});
await win.setViewportSize({ width: 1440, height: 900 });

let n = 0;
async function shot(name) {
  await win.waitForTimeout(700);
  await win.screenshot({ path: path.join(outDir, `${String(++n).padStart(2, '0')}-${name}.png`) });
}

// 1) Cockpit
await win.waitForSelector('.cockpit', { timeout: 30000 });
await win.waitForSelector('.planet', { timeout: 10000 });
check((await win.locator('.planet').count()) === 13, 'Es müssen 13 Planeten zu sehen sein');
await shot('cockpit');

// 2) Kern -> Profile
await win.click('.core');
await win.waitForSelector('.tool-panel[data-tool="profiles"]', { timeout: 15000 });
await win.waitForSelector('.empty, .profile-card', { timeout: 15000 });
await shot('profile-leer');

async function saveProfile(name) {
  await win.click('text=Aktuelle Einstellungen als Profil speichern');
  await win.waitForSelector('.modal input.input');
  await win.fill('.modal input.input', name);
  await win.click('.modal .btn.primary');
  await win.waitForSelector(`.profile-card h3:text-is("${name}")`, { timeout: 15000 });
}

await saveProfile('Main');
// Zweitaccount: andere Grafik, andere Tasten, kein Engine.ini
// (das Zweitkonto ist gerade eingeloggt: eigener Login-Abschnitt in der Datei)
fs.writeFileSync(path.join(fx.wc, 'GameUserSettings.ini'), GUS_MAIN.replace('ResolutionSizeX=1920', 'ResolutionSizeX=1280').replace('FrameRateLimit=240.000000', 'FrameRateLimit=60.000000') + '\r\n[RememberMe]\r\nEnable=True\r\nData=ZWEITLOGIN\r\n');
fs.writeFileSync(fx.cs, 'ZWEIT-KEYS');
fs.rmSync(path.join(fx.wc, 'Engine.ini'));
await saveProfile('Zweitaccount');
check((await win.locator('.profile-card').count()) === 2, 'Zwei Profile erwartet');
await shot('profile-zwei');

// 3) "Main" anwenden
const mainCard = win.locator('.profile-card', { has: win.locator('h3:text-is("Main")') });
await mainCard.locator('.btn.primary').click();
await win.waitForSelector('.modal');
await shot('anwenden-vorschau');
await win.click('.modal .btn.primary:has-text("Jetzt anwenden")');
await win.waitForSelector('.modal h2:has-text("wurde angewendet")', { timeout: 20000 });
await shot('anwenden-ergebnis');
const gus = fs.readFileSync(path.join(fx.wc, 'GameUserSettings.ini'), 'utf8');
check(/ResolutionSizeX=1920/.test(gus) && /FrameRateLimit=240/.test(gus), 'GameUserSettings.ini wurde nicht auf "Main" gesetzt');
check(/Data=ZWEITLOGIN/.test(gus), 'Login-Abschnitt des gerade eingeloggten Kontos muss erhalten bleiben');
check(!/A{200}/.test(gus), 'Login-Daten aus dem Profil dürfen nie zurückgeschrieben werden');
check(fs.existsSync(path.join(fx.wc, 'Engine.ini')), 'Engine.ini aus dem Profil fehlt');
check(fs.readFileSync(fx.cs).subarray(8).toString() === 'MAIN-KEYS', 'ClientSettings.Sav wurde nicht zurückgelegt');
await win.click('.modal .btn.primary:has-text("Fertig")');

// 4) Dateien und Zeitmaschine
await win.click('.tab:has-text("Gefundene Dateien")');
await win.waitForSelector('.table');
await shot('dateien');
await win.click('.tab:has-text("Zeitmaschine")');
await win.waitForSelector('.backup-item');
check((await win.locator('.backup-item').count()) >= 2, 'Mindestens zwei Sicherungen erwartet (Original + vor dem Anwenden)');
await shot('zeitmaschine');

// 5) Alle Tools einmal öffnen
await win.keyboard.press('Escape');
await win.waitForSelector('.cockpit', { timeout: 15000 });
const ids = await win.locator('.planet').evaluateAll((els) => els.map((e) => e.dataset.id));
for (const id of ids) {
  await win.waitForSelector('body:not(.navigating)');
  await win.click(`.planet[data-id="${id}"]`);
  await win.waitForSelector(`.tool-panel[data-tool="${id}"]`, { timeout: 15000 });
  await win.waitForTimeout(1200);
  const failed = await win.locator('.tool-body .empty h3:has-text("konnte nicht geladen werden")').count();
  check(failed === 0, `Tool ${id} konnte nicht geladen werden`);
  await shot(`tool-${id}`);
  await win.keyboard.press('Escape');
  await win.waitForSelector('.cockpit', { timeout: 15000 });
  await win.waitForSelector('body:not(.navigating)');
}

// 6) Einstellungen
await win.waitForSelector('body:not(.navigating)');
await win.click('#btn-settings');
await win.waitForSelector('.tool-panel[data-tool="settings"]');
await shot('einstellungen');

await app.close();
fs.writeFileSync(path.join(outDir, 'ergebnis.json'), JSON.stringify({ errors }, null, 2));
if (errors.length) {
  console.log('FEHLER:\n- ' + errors.join('\n- '));
  process.exitCode = 1;
} else {
  console.log(`ok – ${n} Bildschirmfotos in ${outDir}`);
}
