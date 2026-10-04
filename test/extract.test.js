'use strict';
// Prüft die PDF-Erkennung mit den erfundenen Beispiel-PDFs aus test/fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pdf = require('../src/main/pdf');
const { extractFields, parseDate, detectKind } = require('../src/shared/extract');

const FIX = path.join(__dirname, 'fixtures');
const PASSWORD = 'Passwort-Aus-Der-Mail-0123456789ab';

async function read(name, password) {
  const res = await pdf.extractText(new Uint8Array(fs.readFileSync(path.join(FIX, name))), { password });
  return { ...res, found: extractFields(res.text) };
}

function values(found, target) {
  return found.items.filter((i) => i.target === target).map((i) => i.value);
}

function item(found, target) {
  return found.items.find((i) => i.target === target);
}

test('Epic-Kontodaten: alle wichtigen Felder werden erkannt', async () => {
  const { found } = await read('account-export.pdf');
  assert.equal(found.kind, 'account-export');
  assert.deepEqual(values(found, 'account_id'), ['94b1569506b04f9f8557af611e8c5e47']);
  assert.equal(item(found, 'account_id').auto, true);
  assert.deepEqual(values(found, 'display_name'), ['GeorgZockt']);
  assert.deepEqual(values(found, 'first_name'), ['Max']);
  assert.deepEqual(values(found, 'last_name'), ['Mustermann']);
  assert.deepEqual(values(found, 'country'), ['Deutschland']);
  assert.deepEqual(values(found, 'account_created'), ['17.05.2018']);
  assert.deepEqual(values(found, 'email_original'), ['max.mustermann@beispiel.de']);
  // Die Adresse im Export könnte schon die des Hackers sein: nicht automatisch übernehmen
  assert.equal(item(found, 'email_original').auto, false);
  assert.deepEqual(values(found, 'platforms'), [
    'PlayStation: Georg_PSN (verknüpft seit 02.03.2019)',
    'Nintendo: Georg (verknüpft seit 24.12.2020)',
    'Xbox: Georg Gamer (verknüpft seit 15.06.2021)',
  ]);
  assert.deepEqual(values(found, 'ip_addresses').sort(), ['185.220.101.7', '84.150.12.34']);
  assert.deepEqual(values(found, 'hack_date'), ['02.10.2026, 21:13 Uhr']);
  assert.equal(item(found, 'hack_date').auto, false);
  const history = found.items.filter((i) => i.key === 'history').map((i) => i.label + ': ' + i.value);
  assert.ok(history.includes('E-Mail-Adresse geändert: 02.10.2026, 21:13 Uhr · IP 185.220.101.7'), history.join('\n'));
});

test('Sitzungs- und Client-IDs werden nicht für die Konto-ID gehalten', async () => {
  const { found } = await read('account-export.pdf');
  const ids = values(found, 'account_id');
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], '3f1e2d3c4b5a69788796a5b4c3d2e1f0');
  assert.notEqual(ids[0], 'ec684b8c687f479fadea3cb2ad83f5c6');
});

test('Passwortgeschützte PDF: ohne Passwort NEED_PASSWORD, falsches Passwort WRONG_PASSWORD, richtiges geht', async () => {
  await assert.rejects(read('account-export-encrypted.pdf'), (err) => err.code === 'NEED_PASSWORD' && /Passwort/.test(err.userMessage));
  await assert.rejects(read('account-export-encrypted.pdf', 'falsch'), (err) => err.code === 'WRONG_PASSWORD');
  const { found } = await read('account-export-encrypted.pdf', PASSWORD);
  assert.deepEqual(values(found, 'account_id'), ['94b1569506b04f9f8557af611e8c5e47']);
});

test('Epic-Kaufbeleg (englisch, zweispaltig): Rechnungsnummer, Mail, Zahlungsart', async () => {
  const { found } = await read('epic-receipt-en.pdf');
  assert.equal(found.kind, 'epic-receipt');
  assert.deepEqual(values(found, 'invoice_ids'), ['A812855087']);
  assert.equal(item(found, 'invoice_ids').auto, true);
  assert.deepEqual(values(found, 'email_original'), ['max.mustermann@beispiel.de']);
  assert.deepEqual(values(found, 'payment_method'), ['Visa, endet auf 4242']);
  const order = found.items.find((i) => i.key === 'order_id');
  assert.equal(order.value, 'A2206132055093643');
  assert.equal(order.target, null, 'Bestellnummer ist keine Rechnungsnummer');
  assert.equal(found.items.find((i) => i.key === 'order_date').value, '13.06.2022');
  // Die Absender-Adresse von Epic darf nie als eigene Adresse erkannt werden
  assert.ok(!found.items.some((i) => /epicgames\.com/.test(i.value) && i.target));
});

test('Epic-Beleg für ein Gratis-Spiel (deutsch): F-Rechnungsnummer', async () => {
  const { found } = await read('epic-receipt-free-de.pdf');
  assert.equal(found.kind, 'epic-receipt');
  assert.deepEqual(values(found, 'invoice_ids'), ['F1156160356']);
  assert.deepEqual(values(found, 'email_original'), ['georg.alt@beispiel.de']);
  assert.equal(found.items.find((i) => i.key === 'order_date').value, '05.08.2021');
});

test('Gespeicherte Epic-Kontoseite (deutsch, mit Druck-Kopfzeile)', async () => {
  const { found } = await read('account-page-de.pdf');
  assert.equal(found.kind, 'account-page');
  assert.deepEqual(values(found, 'account_id'), ['0123456789abcdef0123456789abcdef']);
  assert.deepEqual(values(found, 'display_name'), ['GeorgZockt']);
  assert.deepEqual(values(found, 'country'), ['Deutschland']);
  assert.equal(values(found, 'email_original').length, 0, 'verdeckte Adresse ist keine echte Adresse');
  assert.ok(found.items.some((i) => i.key === 'email_masked' && i.info));
  // Druckdatum aus der Kopfzeile darf kein Datum im Ergebnis werden
  assert.ok(!found.items.some((i) => /04\.10\.2026/.test(i.value)));
});

test('Mail zur Wiederherstellung: Recovery ID und neue Adresse', async () => {
  const { found } = await read('recovery-mail.pdf');
  assert.equal(found.kind, 'recovery-mail');
  assert.deepEqual(values(found, 'recovery_id'), ['AR7XK29QPL4421ABCDEF']);
  assert.deepEqual(values(found, 'email_new'), ['neu-und-sicher@beispiel.de']);
  assert.equal(values(found, 'emails_old').length, 0);
});

test('PlayStation-Beleg: Online-ID als Vorschlag, nichts automatisch', async () => {
  const { found } = await read('psn-receipt.pdf');
  assert.equal(found.kind, 'psn-receipt');
  assert.deepEqual(values(found, 'platforms'), ['PlayStation: Georg_PSN']);
  assert.ok(found.items.every((i) => !i.auto));
});

test('Eingescannte PDF ohne Text wird erkannt', async () => {
  const res = await read('scanned.pdf');
  assert.equal(res.scanned, true);
  assert.equal(res.found.items.length, 0);
});

test('Fremdes Dokument liefert keine Kontodaten', async () => {
  const { found } = await read('unrelated.pdf');
  assert.equal(found.kind, 'unknown');
  assert.equal(found.items.filter((i) => i.target).length, 0);
});

test('Datumsformate', () => {
  assert.equal(parseDate('04.10.2026'), '04.10.2026');
  assert.equal(parseDate('4. Oktober 2026'), '04.10.2026');
  assert.equal(parseDate('3. März 2019'), '03.03.2019');
  assert.equal(parseDate('August 5, 2021'), '05.08.2021');
  assert.equal(parseDate('4 Oct 2026'), '04.10.2026');
  assert.equal(parseDate('2018-05-17T14:03:22Z'), '17.05.2018, 16:03 Uhr');
  assert.equal(parseDate('2026-01-10T10:00:00Z'), '10.01.2026, 11:00 Uhr');
  assert.equal(parseDate('08/07/2020 12:35 PM PT', true), '07.08.2020, 12:35 Uhr');
  assert.equal(parseDate('16/08/2020 13:05:19'), '16.08.2020, 13:05 Uhr');
  assert.equal(parseDate('31.02.2020'), null);
  assert.equal(parseDate('kein Datum'), null);
});

test('Text-Eingaben ohne PDF (z. B. kopierte Mail) funktionieren auch', () => {
  const found = extractFields('Your Epic Games Receipt\nINVOICE ID:\nA123456789\nOrder ID: A2601011200001234\nBill To: test@beispiel.de\n');
  assert.equal(detectKind('INVOICE ID:\nA123456789'), 'epic-receipt');
  assert.equal(detectKind('Bitte schick uns deine Rechnungsnummer.'), 'unknown');
  assert.deepEqual(values(found, 'invoice_ids'), ['A123456789']);
  assert.deepEqual(values(found, 'email_original'), ['test@beispiel.de']);
});

test('Sonderzeichen aus PDFs (geschützte Leerzeichen, Ligaturen) stören nicht', () => {
  const found = extractFields('Epic Games Account Data\nExternal Auths\nAccount ID: 94b1569506b04f9f8557af611e8c5e47\nDisplay Name： Georg­Zockt\n');
  assert.deepEqual(values(found, 'account_id'), ['94b1569506b04f9f8557af611e8c5e47']);
  assert.deepEqual(values(found, 'display_name'), ['GeorgZockt']);
});

test('Präparierte oder riesige Texte frieren die Erkennung nicht ein', () => {
  const cases = {
    'PayPal und viele Sternchen': 'PayPal PAID FROM ' + '*'.repeat(100000),
    'Zeilen voller x': 'INVOICE ID PAID FROM ' + ('xX'.repeat(150) + '\n').repeat(2000),
    'verdeckte Mail-Muster': 'Kontoinformationen\n' + ('a'.repeat(60) + '*'.repeat(200) + '@').repeat(500),
    'sehr lange Adresse': 'Account Information ' + 'a'.repeat(500000) + '@b',
    'IPv6-Muster': 'HISTORY_ACCOUNT_X ' + '1:2:3:4:'.repeat(50000),
    'viele Beschriftungen': 'Display Name\n'.repeat(50000),
    '3 MB Text': 'INVOICE ID ' + 'abc def 0123 @ * x\n'.repeat(160000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const start = Date.now();
    extractFields(text);
    const ms = Date.now() - start;
    assert.ok(ms < 3000, name + ' dauerte ' + ms + ' ms');
  }
});

// ---- Problemfälle aus der Prüfung: nie Satzteile oder falsche Spalten übernehmen ----

function autoValues(found, target) {
  return found.items.filter((i) => i.target === target && i.auto).map((i) => i.value);
}

test('Satzteile werden nicht zu Namen', () => {
  const de = extractFields('Von: Epic Games Player Support <help@support.epicgames.com>\nAn: neu@beispiel.de\nnenne uns bitte deinen Vornamen und Nachnamen,\ndas Land, in dem du das Konto erstellt hast.\nViele Grüße');
  assert.equal(values(de, 'first_name').length, 0);
  assert.equal(values(de, 'last_name').length, 0);
  const en = extractFields('Account Settings\nFirst name and last name are required\nas they appear on the account.');
  assert.equal(values(en, 'first_name').length, 0);
  assert.equal(values(en, 'last_name').length, 0);
  const list = extractFields('Account Settings\n- Display Name\n- Email');
  assert.equal(values(list, 'display_name').length, 0);
  const empty = extractFields('Kontoeinstellungen\nVorname\nNachname\nAdresse');
  assert.equal(values(empty, 'first_name').length, 0);
  assert.equal(values(empty, 'last_name').length, 0);
});

test('Formulare mit zwei Spalten und Seitenmenü werden spaltengenau gelesen', () => {
  const grid = extractFields('Kontoeinstellungen\nVorname   Nachname\nMax   Mustermann');
  assert.deepEqual(values(grid, 'first_name'), ['Max']);
  assert.deepEqual(values(grid, 'last_name'), ['Mustermann']);
  const sidebar = extractFields('Kontoeinstellungen\nTransaktionen   Anzeigename\nHilfe   GeorgZockt\nAbmelden   Vorname   Nachname\nDatenschutz   Max   Mustermann');
  assert.deepEqual(values(sidebar, 'display_name'), ['GeorgZockt']);
  assert.deepEqual(values(sidebar, 'first_name'), ['Max']);
  assert.deepEqual(values(sidebar, 'last_name'), ['Mustermann']);
});

test('Support-Mail mit "Rechnungsnummern" ist kein Kaufbeleg', () => {
  const found = extractFields('Von: Epic Games Player Support <help@support.epicgames.com>\nAn: neu-und-sicher@beispiel.de\nBetreff: Dein Fall\nBitte schick uns die Rechnungsnummern deiner Käufe (INVOICE ID).');
  assert.notEqual(found.kind, 'epic-receipt');
  assert.equal(autoValues(found, 'email_original').length, 0);
});

test('Geteilte Konto-ID: nie eine Client- oder Sitzungs-ID übernehmen', () => {
  const split = extractFields('Epic Games Account Data\nAccount Info\nAccount ID   94b15695 06b04f9f 8557af61 1e8c5e47\nThird Party App Consents\nClient   Name\nec684b8c687f479fadea3cb2ad83f5c6   Fortnite Tracker');
  assert.deepEqual(values(split, 'account_id'), ['94b1569506b04f9f8557af611e8c5e47']);
  const noValue = extractFields('Epic Games Account Data\nAccount ID\nSessions\nSession   Created\n3f1e2d3c4b5a69788796a5b4c3d2e1f0 2026-10-01T10:00:00Z');
  assert.equal(autoValues(noValue, 'account_id').length, 0);
  const unrelated = extractFields('Rechnung Stromanbieter\nAccount ID: 3f1e2d3c4b5a69788796a5b4c3d2e1f0');
  assert.equal(autoValues(unrelated, 'account_id').length, 0);
});

test('Recovery ID: nur das AR-Format wird automatisch übernommen, nie ein Datum', () => {
  const found = extractFields('Your Epic account recovery request\nPlease reference your Recovery ID in all replies.\nSubmitted\n2026-10-04');
  assert.ok(!values(found, 'recovery_id').includes('2026-10-04'));
  assert.equal(autoValues(found, 'recovery_id').length, 0);
});

test('Umgebrochene E-Mail-Adresse wird wieder zusammengesetzt', () => {
  const found = extractFields('Your Epic Games Receipt\nINVOICE ID:\nA812855087\nOrder ID:   Bill To:\nA2206132055093643   jan-\ngeorg.max@gmx.de');
  assert.deepEqual(values(found, 'email_original'), ['jan-georg.max@gmx.de']);
  const tonline = extractFields('Your Epic Games Receipt\nINVOICE ID:\nA812855087\nBill To:\nmax.mustermann@t-\nonline.de');
  assert.deepEqual(values(tonline, 'email_original'), ['max.mustermann@t-online.de']);
});

test('Tabellenzeilen, die mit Datum beginnen, bleiben erhalten', () => {
  const found = extractFields('Epic Games Account Data\nAccount History\nDate   Action   IP\n10/02/2026 7:13 PM   HISTORY_ACCOUNT_EMAIL_UPDATED   185.220.101.7\nTransaction History\n06/13/2022 8:55 PM   A812855087   2,800 V-Bucks');
  assert.ok(found.items.some((i) => i.key === 'history'));
  assert.deepEqual(values(found, 'invoice_ids'), ['A812855087']);
  assert.ok(values(found, 'ip_addresses').includes('185.220.101.7'));
});

test('Verknüpfte Konten: fehlende ID-Spalte und fremde Abschnitte', () => {
  const found = extractFields('Epic Games Account Data\nExternal Auths\nType   External Auth ID   External Display Name   Added Date\nxbl   Georg Gamer   2021-06-15T16:45:00Z\npsn   Georg_PSN   June 15, 2021\nLogin History\ngoogle   2026-10-02T19:10:00Z   185.220.101.7');
  assert.deepEqual(values(found, 'platforms'), ['Xbox: Georg Gamer (verknüpft seit 15.06.2021)', 'PlayStation: Georg_PSN (verknüpft seit 15.06.2021)']);
});

test('Telefon: nicht aus "iPhone" und nie ein Datum', () => {
  const a = extractFields('Kontoeinstellungen\nGeräte\niPhone 13 Pro\n0171 2345678');
  assert.equal(values(a, 'phone').length, 0);
  const b = extractFields('Kontoeinstellungen\nTelefon\n01.10.2026');
  assert.equal(values(b, 'phone').length, 0);
  const c = extractFields('Kontoeinstellungen\nTelefonnummer   +49 151 23456789');
  assert.deepEqual(values(c, 'phone'), ['+49 151 23456789']);
});

test('Zeitpunkt des Hacks: die neueste E-Mail-Änderung, auch wenn die Tabelle neueste zuerst zeigt', () => {
  const found = extractFields('Epic Games Account Data\nAccount History\nHISTORY_ACCOUNT_EMAIL_UPDATED   2026-10-02T19:13:02Z   185.220.101.7\nHISTORY_ACCOUNT_PASSWORD_CHANGED   2024-01-05T10:00:00Z   84.150.12.34\nHISTORY_ACCOUNT_EMAIL_UPDATED   2019-03-02T12:00:00Z   84.150.12.34');
  assert.deepEqual(values(found, 'hack_date'), ['02.10.2026, 21:13 Uhr']);
});

test('Zeitangaben mit "UTC" werden in deutsche Zeit umgerechnet', () => {
  assert.equal(parseDate('2026-10-02 19:13:02 UTC'), '02.10.2026, 21:13 Uhr');
  assert.equal(parseDate('10/02/2026 7:13 PM UTC', true), '02.10.2026, 21:13 Uhr');
  assert.equal(parseDate('2026-01-10T10:00:00Z'), '10.01.2026, 11:00 Uhr');
});
