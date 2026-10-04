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

const title = () => win.locator('.step-title').innerText();

// 1) Begrüßung
await win.waitForSelector('.modal', { timeout: 20000 });
await shot('01-begruessung');
await win.click('.modal .btn-primary');

// 2) Konto retten: die kurze Anleitung (6 Schritte), Seiten nicht automatisch öffnen
await win.waitForSelector('.step-card');
await win.click('.switch');
check((await title()).includes('SMS und Authenticator'), 'Schritt 1 fehlt: ' + (await title()));
check((await win.locator('.step-item').count()) === 6, 'Es müssen genau 6 Schritte sein');
await shot('02-konto-retten');
await win.click('.step-foot .btn-primary');
await win.waitForTimeout(300);
check((await title()).includes('E-Mail-Bestätigung'), 'Weiter zu Schritt 2 hat nicht geklappt: ' + (await title()));
await win.click('.step-foot .btn-primary');
await win.waitForTimeout(300);
check((await title()).includes('Passwort vergessen'), 'Weiter zu Schritt 3 hat nicht geklappt: ' + (await title()));
// Klick in der Liste zeigt nur den Schritt an (öffnet keine Seite im Browser)
await win.click('.step-item[data-fk="step-twofa-setup"]');
await win.waitForTimeout(200);
check((await title()).includes('SMS und Authenticator'), 'Klick auf Schritt 1 in der Liste zeigt ihn nicht an');
await win.click('.step-item[data-fk="step-forgot"]');
await win.waitForTimeout(200);
await shot('03-schritt-3');

// 3) Meine Daten: Konto-ID aus dem (nachgebauten) Epic Games Launcher übernehmen, E-Mail eintragen
await win.evaluate(() => window.App.go('data'));
await win.waitForSelector('#f-account_id');
await win.click('button:has-text("Konto-ID auf diesem PC suchen")');
await win.waitForSelector('.modal');
check(await win.locator('.modal').innerText().then((t) => t.includes(FAKE_ID)), 'Konto-ID aus dem Launcher-Ordner wurde nicht gefunden');
await shot('03-konto-id-gefunden');
await win.click('.modal .btn-primary');
await win.waitForTimeout(400);
check((await win.inputValue('#f-account_id')) === FAKE_ID, 'Gefundene Konto-ID steht nicht unter Meine Daten');
await win.fill('#f-email_original', 'max.mustermann@gmx.de');
check((await win.locator('#f-first_purchase_date').count()) === 1, 'Feld "Datum der ersten Zahlung" fehlt');

// 4) PDF auslesen: Beispiel-PDF über die Oberfläche hineinziehen
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
check(await win.locator('main').innerText().then((t) => t.includes('Kaufdatum')), 'Kaufdatum (Vorschlag für die erste Zahlung) wurde nicht angezeigt');

// 5) Meine Daten: übernommene Werte sind da, eigene Eingaben wurden nicht überschrieben
await win.evaluate(() => window.App.go('data'));
await win.waitForSelector('#f-invoice_ids');
check((await win.inputValue('#f-invoice_ids')).includes('A812855087'), 'Rechnungsnummer nicht unter Meine Daten');
check((await win.inputValue('#f-email_original')) === 'max.mustermann@gmx.de', 'Eingetragene E-Mail wurde überschrieben');
await shot('05-meine-daten');

// 6) Support-Text auf Englisch
await win.evaluate(() => window.App.go('support'));
await win.click('.segmented button:nth-child(2)');
await win.waitForTimeout(300);
const text = await win.inputValue('.support-text');
check(text.includes('Hello Epic Games Support') && text.includes('A812855087'), 'Englischer Support-Text unvollständig');
await shot('06-support-text');

// 7) Konten-Wechsel: Ansicht öffnet sich und meldet den Stand (ohne echten Launcher: Hinweis)
await win.evaluate(() => window.App.go('accounts'));
await win.waitForSelector('.status-line', { timeout: 10000 });
await win.waitForTimeout(800);
check(await win.locator('main').innerText().then((t) => /Nur unter Windows|nicht gefunden|Launcher/.test(t)), 'Konten-Ansicht zeigt keinen Stand an');
check((await win.locator('button:has-text("Aktuelles Konto speichern")').count()) === 1, 'Knopf "Aktuelles Konto speichern" fehlt');
await shot('07-konten');

// 8) Discord
await win.evaluate(() => window.App.go('discord'));
await win.waitForTimeout(2500);
await shot('08-discord');

// 8b) Effekte: 3D-Hintergrund läuft, Schalter oben rechts schaltet aus und wieder ein
check(await win.evaluate(() => Boolean(window.FX) && window.FX.enabled()), 'Effekte sind beim Start nicht an');
await win.click('#fx-toggle');
check(await win.evaluate(() => document.documentElement.classList.contains('fx-off')), 'Effekte ließen sich nicht ausschalten');
await win.click('#fx-toggle');
check(await win.evaluate(() => !document.documentElement.classList.contains('fx-off')), 'Effekte ließen sich nicht wieder einschalten');
// Für den Neustart ausgeschaltet lassen: die Einstellung muss gespeichert bleiben
await win.click('#fx-toggle');
await win.waitForTimeout(800);

// 9) Fortschritt bleibt nach Neustart erhalten
await app.close();
const app2 = await electron.launch({ ...launch, timeout: 60000 });
const win2 = await app2.firstWindow();
await win2.setViewportSize({ width: 1280, height: 860 });
await win2.waitForSelector('.nav-item .nav-badge', { timeout: 20000 });
await win2.waitForTimeout(500);
check((await win2.locator('.modal').count()) === 0, 'Begrüßung kam nach Neustart erneut');
check(await win2.evaluate(() => document.documentElement.classList.contains('fx-off')), 'Ausgeschaltete Effekte waren nach Neustart wieder an');
check((await win2.getAttribute('#fx-toggle', 'aria-pressed')) === 'false', 'Effekte-Schalter zeigt nach Neustart den falschen Stand');
// textContent statt innerText: bei kleinen Bildschirmen ist die Beschriftung ausgeblendet
const badge = await win2.locator('.nav-item').first().locator('.nav-badge').textContent();
check(badge.includes('2/6'), 'Fortschritt nach Neustart verloren: ' + badge);
await win2.screenshot({ path: path.join(outDir, '09-nach-neustart.png') });
await app2.close();

if (errors.length) {
  console.error('FEHLER:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Rauchtest bestanden. Bilder: ' + outDir);
