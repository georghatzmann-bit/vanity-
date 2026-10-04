// Erzeugt die Beispiel-PDFs für die Tests (alle Daten sind erfunden).
// Aufruf (braucht Playwright mit Chromium und qpdf):  node test/fixtures/make-fixtures.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

const css = `<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; margin: 32px; color: #111; }
  table { border-collapse: collapse; margin: 8px 0 16px; }
  td, th { padding: 4px 18px 4px 0; text-align: left; vertical-align: top; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 18px; }
  .two { display: grid; grid-template-columns: 260px 260px; gap: 2px 40px; }
  .lbl { font-weight: bold; }
</style>`;

const fixtures = {
  'account-export.pdf': `
    <h1>Epic Games Account Data</h1>
    <h2>Account Info</h2>
    <table>
      <tr><th>Display Name</th><td>GeorgZockt</td></tr>
      <tr><th>First Name</th><td>Max</td></tr>
      <tr><th>Last Name</th><td>Mustermann</td></tr>
      <tr><th>Account ID</th><td>94b1569506b04f9f8557af611e8c5e47</td></tr>
      <tr><th>Creation Date</th><td>2018-05-17T14:03:22Z</td></tr>
      <tr><th>Last Login</th><td>2026-10-02T19:22:05Z</td></tr>
      <tr><th>Country</th><td>DE</td></tr>
      <tr><th>Email</th><td>max.mustermann@beispiel.de</td></tr>
      <tr><th>Account Status</th><td>ACTIVE</td></tr>
    </table>
    <h2>Addresses</h2><p>None</p>
    <h2>Devices</h2><p>None</p>
    <h2>Payment Profiles</h2><p>None</p>
    <h2>Transaction History</h2><p>None</p>
    <h2>Third Party App Consents</h2>
    <table><tr><th>Client ID</th><th>Name</th></tr><tr><td>ec684b8c687f479fadea3cb2ad83f5c6</td><td>Fortnite Tracker</td></tr></table>
    <h2>Sessions</h2>
    <table><tr><th>Session</th><th>Created</th><th>Expires</th></tr>
      <tr><td>3f1e2d3c4b5a69788796a5b4c3d2e1f0</td><td>2026-10-01T10:00:00Z</td><td>2026-10-31T10:00:00Z</td></tr></table>
    <h2>External Auths</h2>
    <table>
      <tr><th>Type</th><th>External Auth ID</th><th>External Display Name</th><th>Added Date</th></tr>
      <tr><td>psn</td><td>1234567890123456789</td><td>Georg_PSN</td><td>2019-03-02T12:00:00Z</td></tr>
      <tr><td>nintendo</td><td>0123456789abcdef</td><td>Georg</td><td>2020-12-24T08:30:00Z</td></tr>
      <tr><td>xbl</td><td>2533274900000001</td><td>Georg Gamer</td><td>2021-06-15T16:45:00Z</td></tr>
    </table>
    <h2>Account History</h2>
    <table>
      <tr><th>Action</th><th>Date</th><th>IP</th><th>Method</th></tr>
      <tr><td>HISTORY_ACCOUNT_EMAIL_CONFIRMATION</td><td>2018-05-17T14:05:00Z</td><td>84.150.12.34</td><td>email</td></tr>
      <tr><td>HISTORY_ACCOUNT_CHALLENGE_CREATED</td><td>2026-10-02T19:10:44Z</td><td>185.220.101.7</td><td>email</td></tr>
      <tr><td>HISTORY_ACCOUNT_EMAIL_UPDATED</td><td>2026-10-02T19:13:02Z</td><td>185.220.101.7</td><td>email</td></tr>
      <tr><td>HISTORY_ACCOUNT_DECLINED_MFA_SETUP</td><td>2026-10-02T19:15:40Z</td><td>185.220.101.7</td><td>web</td></tr>
    </table>`,

  'epic-receipt-en.pdf': `
    <p>Thank You.</p>
    <p>Thanks for your purchase from Epic Games Commerce GmbH.</p>
    <p class="lbl">INVOICE ID:</p>
    <p>A812855087</p>
    <p>Please keep a copy of this receipt for your records.</p>
    <p class="lbl">YOUR ORDER INFORMATION:</p>
    <div class="two">
      <div class="lbl">Order ID:</div><div class="lbl">Bill To:</div>
      <div>A2206132055093643</div><div>max.mustermann@beispiel.de</div>
      <div class="lbl">Order Date:</div><div class="lbl">Source:</div>
      <div>June 13, 2022</div><div>Fortnite</div>
    </div>
    <p class="lbl">HERE'S WHAT YOU ORDERED:</p>
    <table><tr><th>Description:</th><th>Publisher:</th><th>Price:</th></tr>
      <tr><td>2,800 V-Bucks</td><td>Epic Games, Inc.</td><td>EUR € 22.99</td></tr></table>
    <p class="lbl">TOTAL [ EUR ]:</p><p>€ 22.99</p>
    <p>VAT is included if applicable.</p>
    <p class="lbl">PAYMENT DETAILS:</p>
    <p class="lbl">PAID FROM:</p><p>Visa ending in 4242</p>
    <p>help@accts.epicgames.com</p>`,

  'epic-receipt-free-de.pdf': `
    <p>Dein Epic Games-Beleg</p>
    <p class="lbl">RECHNUNGSNUMMER:</p><p>F1156160356</p>
    <p class="lbl">DEINE BESTELLINFORMATIONEN:</p>
    <div class="two">
      <div class="lbl">Bestellnummer:</div><div class="lbl">Rechnung an:</div>
      <div>F2108051830045648</div><div>georg.alt@beispiel.de</div>
      <div class="lbl">Bestelldatum:</div><div class="lbl">Quelle:</div>
      <div>5. August 2021</div><div>Epic Games Store</div>
    </div>
    <p class="lbl">GESAMT [ EUR ]:</p><p>0,00 €</p>`,

  'account-page-de.pdf': `
    <p>04.10.26, 14:03 &nbsp;&nbsp;&nbsp; Kontoeinstellungen | Epic Games</p>
    <h1>Kontoeinstellungen</h1>
    <h2>Kontoinformationen</h2>
    <table>
      <tr><th>ID</th><td>0123456789abcdef0123456789abcdef</td></tr>
      <tr><th>Anzeigename</th><td>GeorgZockt</td></tr>
      <tr><th>E-Mail-Adresse</th><td>m***@b*******.de</td></tr>
    </table>
    <h2>Persönliche Daten</h2>
    <table>
      <tr><th>Vorname</th><td>Max</td></tr>
      <tr><th>Nachname</th><td>Mustermann</td></tr>
      <tr><th>Land/Region</th><td>Deutschland</td></tr>
    </table>
    <p>https://www.epicgames.com/account/personal 1/2</p>`,

  'recovery-mail.pdf': `
    <p>Von: Epic Games &lt;help@acct.epicgames.com&gt;</p>
    <p>An: neu-und-sicher@beispiel.de</p>
    <h1>Your Epic account recovery request</h1>
    <p>We have received your account recovery request. We usually respond within 48 hours.</p>
    <p><b>Recovery ID:</b> 7XK2-9QPL-4421</p>
    <p>You can check your account recovery status at any time.</p>`,

  'psn-receipt.pdf': `
    <h1>Thank You For Your Purchase</h1>
    <table>
      <tr><th>Order Number:</th><td>216026393969</td></tr>
      <tr><th>Name:</th><td>Max Mustermann</td></tr>
      <tr><th>Online ID:</th><td>Georg_PSN</td></tr>
      <tr><th>Date Purchased:</th><td>08/07/2020 12:35 PM PT</td></tr>
    </table>
    <p>Fortnite - 1,000 V-Bucks &nbsp; $7.99</p>
    <p>reply@txn-email.playstation.com</p>`,

  'unrelated.pdf': `
    <h1>Mietvertrag</h1>
    <p>Zwischen Vermieter und Mieter wird folgender Vertrag geschlossen. Miete: 650,00 € monatlich.</p>`,
};

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, body] of Object.entries(fixtures)) {
  await page.setContent(`<html><head><meta charset="utf-8">${css}</head><body>${body}</body></html>`);
  await page.pdf({ path: path.join(dir, name), format: 'A4' });
  console.log('erstellt', name);
}
// Nur ein Bild, kein Text (wie ein eingescanntes Dokument)
await page.setContent('<html><body style="margin:0"><canvas id="c" width="600" height="300"></canvas><script>const x=document.getElementById("c").getContext("2d");x.fillStyle="#222";x.fillRect(0,0,600,300);x.fillStyle="#fff";x.font="40px Arial";x.fillText("Konto-ID abc",40,150);</script></body></html>');
const png = await page.locator('#c').screenshot();
await page.setContent(`<html><body style="margin:0"><img src="data:image/png;base64,${png.toString('base64')}"></body></html>`);
await page.pdf({ path: path.join(dir, 'scanned.pdf'), format: 'A4' });
console.log('erstellt scanned.pdf');
await browser.close();

// Verschlüsselte Variante wie bei Epic (Passwort per extra Mail)
execFileSync('qpdf', ['--encrypt', 'Passwort-Aus-Der-Mail-0123456789ab', 'owner-geheim', '256', '--', path.join(dir, 'account-export.pdf'), path.join(dir, 'account-export-encrypted.pdf')]);
console.log('erstellt account-export-encrypted.pdf');
