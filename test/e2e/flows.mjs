// Prüft besondere Abläufe in der echten Oberfläche (Fehler, die früher aufgetreten sind).
// Linux:   xvfb-run -a node test/e2e/flows.mjs
// Windows: node test/e2e/flows.mjs "C:\...\Konto-Retter.exe"
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagedExe = process.argv[2];
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-flows-'));
const launch = packagedExe
  ? { executablePath: packagedExe, args: ['--user-data-dir=' + userData] }
  : {
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: ['--no-sandbox', '--user-data-dir=' + userData, root],
  };

const errors = [];
function check(cond, message) {
  if (!cond) errors.push(message);
}

const app = await electron.launch({ ...launch, timeout: 60000 });
const win = await app.firstWindow();
win.on('pageerror', (e) => errors.push('Seitenfehler: ' + e.message));
await win.setViewportSize({ width: 1280, height: 860 });
await win.waitForSelector('.modal', { timeout: 20000 });
await win.click('.modal .btn-primary');
await win.waitForSelector('.step-card');
await win.click('.switch'); // Seiten nicht automatisch öffnen
// Effekte aus: Hier werden Abläufe geprüft, keine Animationen (die prüft der Rauchtest).
// Mit Effekten an kann eine Karte unter dem Mauszeiger kippen, und Klicks warten dann vergeblich auf Ruhe.
if (await win.evaluate(() => Boolean(window.FX) && window.FX.enabled())) await win.click('#fx-toggle');
await win.waitForTimeout(200);

const title = () => win.locator('.step-title').innerText();
const storeData = () => win.evaluate(() => window.Store.get().data);

async function dropPdf(name, displayName) {
  const b64 = fs.readFileSync(path.join(root, 'test', 'fixtures', name)).toString('base64');
  await win.evaluate(async ({ b64, displayName }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], displayName, { type: 'application/pdf' }));
    document.querySelector('.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { b64, displayName });
}

// ---- 1) Alle 6 Schritte der Reihe nach führen zu "Geschafft!" ----
for (let i = 0; i < 10; i++) {
  if (await win.locator('.finish').count()) break;
  await win.click('[data-fk="next"]');
  await win.waitForTimeout(150);
}
check(await win.locator('.finish').count() === 1, '"Geschafft!" wurde nicht angezeigt');
const badge = await win.locator('.nav-item').first().locator('.nav-badge').textContent();
check(badge === '6/6', 'Fortschritt am Ende falsch: ' + badge);
// Schritte nochmal ansehen: Klick in der Liste zeigt den Schritt, ohne eine Seite zu öffnen
await win.click('button:has-text("Schritte nochmal ansehen")');
await win.waitForTimeout(200);
await win.click('.step-item[data-fk="step-codes"]');
await win.waitForTimeout(200);
check((await title()).includes('Codes aus Authenticator'), 'Klick auf einen Schritt in der Liste zeigt ihn nicht an: ' + (await title()));

// ---- 2) Rückgängig nimmt nur die eigene Übernahme zurück ----
await win.evaluate(() => window.App.go('pdf'));
await dropPdf('epic-receipt-en.pdf', 'Beleg1.pdf');
await win.waitForFunction(() => document.querySelectorAll('.found-list').length > 0, null, { timeout: 30000 });
await dropPdf('epic-receipt-free-de.pdf', 'Beleg2.pdf');
await win.waitForFunction(() => (window.Store.get().data.invoice_ids || []).length === 2, null, { timeout: 30000 });
// Ergebnisse stehen neu oben: das zweite Kärtchen ist Beleg1
const cards = win.locator('section.card:has(.badge-accent)');
await cards.nth(1).locator('button:has-text("Übernahme rückgängig")').click();
await win.waitForTimeout(300);
let d = await storeData();
check(JSON.stringify(d.invoice_ids) === JSON.stringify(['F1156160356']), 'Rückgängig hat zu viel entfernt: ' + JSON.stringify(d.invoice_ids));
await cards.nth(0).locator('button:has-text("Übernahme rückgängig")').click();
await win.waitForTimeout(300);
d = await storeData();
check(d.invoice_ids.length === 0, 'Zweites Rückgängig hat alte Werte zurückgeholt: ' + JSON.stringify(d.invoice_ids));

// ---- 3) Passwort: falsch, dann richtig ----
await dropPdf('account-export-encrypted.pdf', 'Konto.pdf');
await win.waitForSelector('.modal input[type=password]', { timeout: 30000 });
await win.fill('.modal input[type=password]', 'falsch');
await win.keyboard.press('Enter');
await win.waitForSelector('.modal .callout-danger', { timeout: 30000 });
await win.fill('.modal input[type=password]', 'Passwort-Aus-Der-Mail-0123456789ab');
await win.keyboard.press('Enter');
await win.waitForFunction(() => window.Store.get().data.account_id === '94b1569506b04f9f8557af611e8c5e47', null, { timeout: 30000 }).catch(() => {});
d = await storeData();
check(d.account_id === '94b1569506b04f9f8557af611e8c5e47', 'Verschlüsselte PDF wurde nach richtigem Passwort nicht gelesen');

// ---- 4) Eigene Änderungen am Support-Text bleiben erhalten ----
await win.evaluate(() => window.App.go('support'));
await win.waitForSelector('.support-text');
await win.click('.support-text');
await win.keyboard.press('Control+End');
await win.keyboard.type('\nMEIN EIGENER SATZ');
await win.click('[data-fk="seg-en"]');
await win.waitForTimeout(200);
check(!(await win.inputValue('.support-text')).includes('MEIN EIGENER SATZ'), 'Deutsche Änderung taucht im englischen Text auf');
await win.click('[data-fk="seg-de"]');
await win.waitForTimeout(200);
check((await win.inputValue('.support-text')).includes('MEIN EIGENER SATZ'), 'Eigene Änderung am deutschen Text ging verloren');
check(await win.locator('button:has-text("Text neu erstellen")').count() === 1, 'Hinweis "Text neu erstellen" fehlt');

// ---- 5) "Alle Daten löschen" vergisst auch erkannte PDF-Werte ----
await win.evaluate(() => window.App.go('data'));
await win.click('button:has-text("Alle Daten löschen")');
await win.click('.modal .btn-danger');
await win.waitForTimeout(400);
await win.evaluate(() => window.App.go('pdf'));
await win.waitForTimeout(200);
check(await win.locator('.found-list').count() === 0, 'Nach "Alle Daten löschen" werden noch PDF-Ergebnisse angezeigt');
d = await storeData();
check(!d.account_id && !(d.invoice_ids || []).length, 'Daten wurden nicht gelöscht');

await app.close();
if (errors.length) {
  console.error('FEHLER:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('Ablauf-Tests bestanden.');
