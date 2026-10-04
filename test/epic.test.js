'use strict';
// Prüft den Konten-Schnellwechsel mit einer nachgebauten GameUserSettings.ini.
// Läuft überall (auch ohne Windows): Launcher-Prozesse werden dabei nicht angefasst (noProcess).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const epic = require('../src/main/epic');

const SAMPLE = '[Core]\r\nFoo=1\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=ABC123\r\nEmail=eins@beispiel.de\r\n\r\n[Other]\r\nX=y\r\n';

function writeUtf16(file, text) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

function setup({ text = SAMPLE, utf16 = false, crypto = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-'));
  const ini = path.join(base, 'Config', 'GameUserSettings.ini');
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  if (utf16) writeUtf16(ini, text);
  else fs.writeFileSync(ini, text, 'utf8');
  epic.init({ dataDir: path.join(base, 'data'), crypto, ini, noProcess: true });
  return { base, ini };
}

// Simuliert: Im Launcher hat sich ein anderes Konto mit "Angemeldet bleiben" angemeldet
function loginAs(ini, data, email, utf16) {
  const { readIni, writeIni, setSection } = epic._ini;
  const cur = readIni(ini);
  const text = setSection(cur.text, 'RememberMe', 'Enable=True\nData=' + data + '\nEmail=' + email);
  if (utf16) writeUtf16(ini, text);
  else writeIni(ini, cur, text);
}

test('INI: Abschnitt lesen, ersetzen und anhängen – alles andere bleibt unverändert', () => {
  const { getSection, setSection, parseKeys } = epic._ini;
  assert.equal(getSection(SAMPLE, 'RememberMe'), 'Enable=True\nData=ABC123\nEmail=eins@beispiel.de');
  assert.equal(getSection(SAMPLE, 'Fehlt'), null);
  assert.deepEqual(parseKeys('Enable=True\nData=ABC123\nEmail=eins@beispiel.de'), { Enable: 'True', Data: 'ABC123', Email: 'eins@beispiel.de' });

  const replaced = setSection(SAMPLE, 'RememberMe', 'Enable=True\nData=NEU');
  assert.equal(getSection(replaced, 'RememberMe'), 'Enable=True\nData=NEU');
  assert.equal(getSection(replaced, 'Core'), 'Foo=1');
  assert.equal(getSection(replaced, 'Other'), 'X=y');
  assert.ok(!/[^\r]\n/.test(replaced), 'Zeilenenden müssen CRLF bleiben');
  assert.ok(replaced.endsWith('\r\n') && !replaced.endsWith('\r\n\r\n'));

  const appended = setSection('[Core]\nFoo=1\n', 'RememberMe', 'Enable=True\nData=X');
  assert.equal(appended, '[Core]\nFoo=1\n\n[RememberMe]\nEnable=True\nData=X\n');
});

test('Aktuelles Konto speichern, zweites Konto speichern, zum ersten wechseln', async () => {
  const { ini } = setup();
  const st0 = await epic.getStatus();
  assert.equal(st0.supported, true);
  assert.equal(st0.remembered, true);
  assert.equal(st0.currentEmail, 'eins@beispiel.de');
  assert.deepEqual(st0.accounts, []);

  const s1 = await epic.saveCurrent('Hauptkonto');
  assert.equal(s1.ok, true, s1.message);
  let st = await epic.getStatus();
  assert.equal(st.accounts.length, 1);
  assert.equal(st.accounts[0].label, 'Hauptkonto');
  assert.equal(st.accounts[0].email, 'eins@beispiel.de');
  assert.equal(st.accounts[0].isCurrent, true);
  // Nochmal speichern = aktualisieren, kein Duplikat
  assert.equal((await epic.saveCurrent('')).ok, true);
  assert.equal((await epic.getStatus()).accounts.length, 1);

  loginAs(ini, 'XYZ789', 'zwei@beispiel.de');
  const s2 = await epic.saveCurrent('');
  assert.equal(s2.ok, true, s2.message);
  st = await epic.getStatus();
  assert.equal(st.accounts.length, 2);
  assert.equal(st.accounts[1].label, 'zwei@beispiel.de', 'ohne Namen wird die E-Mail-Adresse genommen');
  assert.equal(st.accounts[0].isCurrent, false);
  assert.equal(st.accounts[1].isCurrent, true);

  const sw = await epic.switchTo(st.accounts[0].id);
  assert.equal(sw.ok, true, sw.message);
  const text = fs.readFileSync(ini, 'utf8');
  assert.equal(epic._ini.getSection(text, 'RememberMe'), 'Enable=True\nData=ABC123\nEmail=eins@beispiel.de');
  assert.equal(epic._ini.getSection(text, 'Core'), 'Foo=1', '[Core] darf sich nicht ändern');
  assert.equal(epic._ini.getSection(text, 'Other'), 'X=y', '[Other] darf sich nicht ändern');
  st = await epic.getStatus();
  assert.equal(st.currentEmail, 'eins@beispiel.de');
  assert.equal(st.accounts[0].isCurrent, true);
  assert.ok(st.accounts[0].lastUsed, 'Zeitpunkt des Wechsels fehlt');
});

test('Ohne "Angemeldet bleiben" wird nichts gespeichert', async () => {
  setup({ text: '[RememberMe]\r\nEnable=False\r\nData=\r\n' });
  const st = await epic.getStatus();
  assert.equal(st.remembered, false);
  const res = await epic.saveCurrent('x');
  assert.equal(res.ok, false);
  assert.match(res.message, /Angemeldet bleiben/);
});

test('Ohne Launcher-Einstellungen: klare Meldung statt Absturz', async () => {
  const { ini } = setup();
  fs.unlinkSync(ini);
  const st = await epic.getStatus();
  assert.equal(st.settingsFound, false);
  assert.equal(st.launcherInstalled, false);
  const res = await epic.saveCurrent('x');
  assert.equal(res.ok, false);
  assert.match(res.message, /nicht gefunden/);
});

test('Beim Wechsel wird das bisher angemeldete Konto automatisch mitgesichert', async () => {
  const { ini } = setup();
  await epic.saveCurrent('A');
  loginAs(ini, 'UNSAVED42', 'drei@beispiel.de');
  const a = (await epic.getStatus()).accounts[0];
  const sw = await epic.switchTo(a.id);
  assert.equal(sw.ok, true, sw.message);
  assert.match(sw.message, /mitgesichert/);
  const st = await epic.getStatus();
  assert.equal(st.accounts.length, 2);
  assert.equal(st.accounts[1].email, 'drei@beispiel.de');
});

test('UTF-16-Datei bleibt UTF-16 (so wie der Launcher sie manchmal schreibt)', async () => {
  const { ini } = setup({ utf16: true });
  assert.equal((await epic.saveCurrent('A')).ok, true);
  loginAs(ini, 'ZWEI', 'zwei@beispiel.de', true);
  assert.equal((await epic.saveCurrent('B')).ok, true);
  const a = (await epic.getStatus()).accounts[0];
  assert.equal((await epic.switchTo(a.id)).ok, true);
  const buf = fs.readFileSync(ini);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xfe);
  const text = buf.subarray(2).toString('utf16le');
  assert.match(text, /Data=ABC123/);
  assert.match(text, /\[Other\]\r\nX=y/);
});

test('Entfernen, Umbenennen und "Alle Daten löschen"', async () => {
  setup();
  await epic.saveCurrent('A');
  let acc = (await epic.getStatus()).accounts[0];
  assert.equal((await epic.rename(acc.id, '  Mein Hauptkonto  ')).ok, true);
  acc = (await epic.getStatus()).accounts[0];
  assert.equal(acc.label, 'Mein Hauptkonto');
  assert.equal((await epic.rename(acc.id, '')).ok, false);
  assert.equal((await epic.remove('gibt-es-nicht')).ok, false);
  assert.equal((await epic.remove(acc.id)).ok, true);
  assert.deepEqual((await epic.getStatus()).accounts, []);
  await epic.saveCurrent('B');
  epic.removeAll();
  assert.deepEqual((await epic.getStatus()).accounts, []);
});

test('Gespeicherte Zugänge werden verschlüsselt, wenn Verschlüsselung verfügbar ist', async () => {
  const crypto = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from('ENC:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decrypt: (b) => Buffer.from(b.toString('utf8').slice(4), 'base64').toString('utf8'),
  };
  const { base } = setup({ crypto });
  assert.equal((await epic.saveCurrent('A')).ok, true);
  const raw = fs.readFileSync(path.join(base, 'data', 'epic-konten.json'), 'utf8');
  assert.ok(!raw.includes('ABC123'), 'Zugang darf nicht im Klartext in der Datei stehen');
  assert.ok(raw.includes('"enc":"safeStorage"'));
  const st = await epic.getStatus();
  assert.equal(st.encrypted, true);
  assert.equal(st.accounts.length, 1);
  // Mit anderem Schlüssel (anderer Windows-Benutzer) nicht lesbar: verständliche Meldung, kein Absturz
  epic.init({ dataDir: path.join(base, 'data'), crypto: { isAvailable: () => false }, ini: path.join(base, 'Config', 'GameUserSettings.ini'), noProcess: true });
  const st2 = await epic.getStatus();
  assert.deepEqual(st2.accounts, []);
  assert.match(st2.problem, /entschlüsseln/);
});
