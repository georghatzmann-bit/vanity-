// Klickt das fertige Programm einmal komplett durch und macht Bildschirmfotos.
// Linux:   xvfb-run -a node test/e2e/smoke.mjs
// Windows: node test/e2e/smoke.mjs "C:\...\Konto-Retter.exe"
// Braucht das npm-Paket "playwright" (wird nicht mit ausgeliefert).
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagedExe = process.argv[2];
const outDir = process.env.SHOTS_DIR || path.join(root, 'test-results', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-smoke-'));
// Nachgebauter Epic Games Launcher: Dateiname = Konto-ID (so speichert es der echte Launcher)
const fakeLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-local-'));
const FAKE_ID = '94b1569506b04f9f8557af611e8c5e47';
fs.mkdirSync(path.join(fakeLocal, 'EpicGamesLauncher', 'Saved', 'Data'), { recursive: true });
fs.writeFileSync(path.join(fakeLocal, 'EpicGamesLauncher', 'Saved', 'Data', FAKE_ID + '.dat'), 'x');
const env = { ...process.env, LOCALAPPDATA: fakeLocal };

const launch = packagedExe
  ? { executablePath: packagedExe, args: ['--user-data-dir=' + userData], env }
  : {
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: ['--no-sandbox', '--user-data-dir=' + userData, root],
    env,
  };

const errors = [];
const app = await electron.launch({ ...launch, timeout: 60000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => errors.push('Seitenfehler: ' + e.message));
win.on('console', (m) => { if (m.type() === 'error') errors.push('Konsole: ' + m.text()); });
await win.setViewportSize({ width: 1280, height: 860 });

async function shot(name) {
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(outDir, name + '.png') });
}

function check(cond, message) {
  if (!cond) errors.push(message);
}

// 1) Begrüßung
await win.waitForSelector('.modal', { timeout: 20000 });
await shot('01-begruessung');
await win.click('.modal .btn-primary');

// 2) Konto retten: Daten im Schritt eintragen, Schritt abhaken (Seiten nicht automatisch öffnen)
await win.waitForSelector('.step-card');
await win.click('.switch');
await win.fill('.step-card input.input', 'max.mustermann@gmx.de');
await shot('02-konto-retten');
check(await win.locator('.open-box').innerText().then((t) => t.includes('Sicherheitsseite von GMX')), 'E-Mail-Anbieter wurde nicht erkannt');
await win.click('.step-foot .btn-primary');
await win.waitForTimeout(300);
check(await win.locator('.step-title').innerText().then((t) => t.includes('Schadprogramme')), 'Weiter zu Schritt 2 hat nicht geklappt');
await win.click('.step-foot .btn-primary');
await win.waitForTimeout(300);
check(await win.locator('.step-title').innerText().then((t) => t.includes('Beweise sammeln')), 'Weiter zu Schritt 3 hat nicht geklappt');

// Konto-ID aus dem (nachgebauten) Epic Games Launcher übernehmen
await win.click('button:has-text("Konto-ID auf diesem PC suchen")');
await win.waitForSelector('.modal');
check(await win.locator('.modal').innerText().then((t) => t.includes(FAKE_ID)), 'Konto-ID aus dem Launcher-Ordner wurde nicht gefunden');
await shot('03-konto-id-gefunden');
await win.click('.modal .btn-primary');
await win.waitForTimeout(400);
check(await win.locator('.step-card').innerText().then((t) => t.includes(FAKE_ID)), 'Gefundene Konto-ID wird im Schritt nicht angezeigt');
await shot('03-schritt-3');

// 3) PDF auslesen: Beispiel-PDF über die Oberfläche hineinziehen
await win.evaluate(() => window.App.go('pdf'));
const pdfBytes = fs.readFileSync(path.join(root, 'test', 'fixtures', 'epic-receipt-en.pdf'));
await win.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], 'Epic-Beleg.pdf', { type: 'application/pdf' }));
  document.querySelector('.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, pdfBytes.toString('base64'));
await win.waitForSelector('.found-list', { timeout: 30000 });
await shot('04-pdf-ergebnis');
check(await win.locator('main').innerText().then((t) => t.includes('A812855087')), 'Rechnungsnummer wurde nicht angezeigt');

// 4) Meine Daten: übernommene Werte sind da
await win.evaluate(() => window.App.go('data'));
await win.waitForSelector('#f-invoice_ids');
check((await win.inputValue('#f-invoice_ids')).includes('A812855087'), 'Rechnungsnummer nicht unter Meine Daten');
check((await win.inputValue('#f-email_original')) === 'max.mustermann@gmx.de', 'Eingetragene E-Mail wurde überschrieben');
await shot('05-meine-daten');

// 5) Support-Text auf Englisch
await win.evaluate(() => window.App.go('support'));
await win.click('.segmented button:nth-child(2)');
await win.waitForTimeout(300);
const text = await win.inputValue('.support-text');
check(text.includes('Hello Epic Games Support') && text.includes('A812855087'), 'Englischer Support-Text unvollständig');
await shot('06-support-text');

// 6) Discord
await win.evaluate(() => window.App.go('discord'));
await win.waitForTimeout(2500);
await shot('07-discord');

// 7) Fortschritt bleibt nach Neustart erhalten
await app.close();
const app2 = await electron.launch({ ...launch, timeout: 60000 });
const win2 = await app2.firstWindow();
await win2.setViewportSize({ width: 1280, height: 860 });
await win2.waitForSelector('.nav-item .nav-badge', { timeout: 20000 });
await win2.waitForTimeout(500);
check((await win2.locator('.modal').count()) === 0, 'Begrüßung kam nach Neustart erneut');
// textContent statt innerText: bei kleinen Bildschirmen ist die Beschriftung ausgeblendet
const badge = await win2.locator('.nav-item').first().locator('.nav-badge').textContent();
check(badge.includes('2/21'), 'Fortschritt nach Neustart verloren: ' + badge);
await win2.screenshot({ path: path.join(outDir, '08-nach-neustart.png') });
await app2.close();

if (errors.length) {
  console.error('FEHLER:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Rauchtest bestanden. Bilder: ' + outDir);
