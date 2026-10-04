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

// Nachgebaute Registry (HKCU\Software\Epic Games\Unreal Engine\Identifiers\AccountId)
function fakeRegistry(initial) {
  const reg = { value: initial || null };
  reg.get = async () => reg.value;
  reg.set = async (v) => { reg.value = v; return true; };
  return reg;
}

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

function setup({ text = SAMPLE, utf16 = false, crypto = null, registry = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-'));
  const ini = path.join(base, 'Config', 'GameUserSettings.ini');
  fs.mkdirSync(path.dirname(ini), { recursive: true });
  if (utf16) writeUtf16(ini, text);
  else fs.writeFileSync(ini, text, 'utf8');
  const reg = registry || fakeRegistry();
  epic.init({ dataDir: path.join(base, 'data'), crypto, ini, noProcess: true, registry: reg });
  return { base, ini, reg };
}

// Simuliert: Im Launcher hat sich ein anderes Konto mit "Angemeldet bleiben" angemeldet
// (der Launcher schreibt dann auch die Konto-ID in die Registry)
function loginAs(ini, data, email, utf16, reg, accountId) {
  const { readIni, writeIni, setSection } = epic._ini;
  const cur = readIni(ini);
  const text = setSection(cur.text, 'RememberMe', 'Enable=True\nData=' + data + (email ? '\nEmail=' + email : ''));
  if (utf16) writeUtf16(ini, text);
  else writeIni(ini, cur, text);
  if (reg && accountId) reg.value = accountId;
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
  assert.equal(st.diag.sectionFound, true);
  assert.equal(st.diag.dataLength, 0);
  const res = await epic.saveCurrent('x');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'not-remembered');
  assert.equal(res.running, false);
  assert.match(res.message, /Angemeldet bleiben/);
});

test('Erkennung ist tolerant: Data ohne Enable zählt, Enable=False nicht', async () => {
  setup({ text: '[RememberMe]\r\nData=NURDATEN\r\n' });
  let st = await epic.getStatus();
  assert.equal(st.remembered, true, 'Data ohne Enable-Zeile muss als angemeldet gelten');
  assert.equal((await epic.saveCurrent('A')).ok, true);
  setup({ text: '[RememberMe]\r\nEnable=false\r\nData=NURDATEN\r\n' });
  st = await epic.getStatus();
  assert.equal(st.remembered, false);
});

test('Diagnose zeigt, was gefunden wurde – aber nie den Zugang selbst', async () => {
  const { ini } = setup();
  const st = await epic.getStatus();
  assert.equal(st.diag.file, ini);
  assert.equal(st.diag.fileFound, true);
  assert.equal(st.diag.sectionFound, true);
  assert.equal(st.diag.enable, 'True');
  assert.equal(st.diag.dataLength, 6);
  assert.equal(st.diag.email, 'eins@beispiel.de');
  assert.ok(!JSON.stringify(st).includes('ABC123'), 'Der Zugang darf die Oberfläche nie erreichen');
});

test('Anmeldung wird auch in einer anderen Einstellungsdatei des Launchers gefunden', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-la-'));
  const cfg = path.join(base, 'EpicGamesLauncher', 'Saved', 'Config');
  fs.mkdirSync(path.join(cfg, 'Windows'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'WindowsNoEditor'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'Windows', 'GameUserSettings.ini'), '[Core]\r\nFoo=1\r\n', 'utf8');
  fs.writeFileSync(path.join(cfg, 'WindowsNoEditor', 'GameUserSettings.ini'), '[RememberMe]\r\nEnable=True\r\nData=ANDERSWO\r\nEmail=x@beispiel.de\r\n', 'utf8');
  const before = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    epic.init({ dataDir: path.join(base, 'data'), crypto: null, noProcess: true });
    const st = await epic.getStatus();
    assert.equal(st.remembered, true);
    assert.equal(st.currentEmail, 'x@beispiel.de');
    assert.equal(st.diag.file, path.join(cfg, 'WindowsNoEditor', 'GameUserSettings.ini'));
    assert.equal(st.diag.configFiles.length, 2);
    assert.equal(st.diag.configFiles[0].file, path.join(cfg, 'Windows', 'GameUserSettings.ini'), 'übliche Datei zuerst');
    assert.equal(st.diag.configFiles[0].hasSection, false);
    assert.equal(st.diag.configFiles[1].hasSection, true);
    assert.equal((await epic.saveCurrent('B')).ok, true);
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = before;
  }
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

test('Erneuerter Zugang (gleiche Konto-ID) aktualisiert das Konto statt es doppelt anzulegen', async () => {
  const { ini, reg } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=A_ALT\r\n' });
  reg.value = ID_A;
  assert.equal((await epic.saveCurrent('Konto A')).ok, true);
  // Epic erneuert den Zugang von A, während A angemeldet ist
  loginAs(ini, 'A_NEU', '', false, reg, ID_A);
  let st = await epic.getStatus();
  assert.equal(st.accounts.length, 1);
  assert.equal(st.accounts[0].isCurrent, true, 'über die Konto-ID als angemeldet erkannt');
  assert.equal(st.accounts[0].accountIdShort, 'aaaaaaaa');
  // Weiteres Konto hinzufügen: A wird dabei mit dem neuen Zugang aufgefrischt, die Anmeldung geleert
  const add = await epic.addNew();
  assert.equal(add.ok, true, add.message);
  st = await epic.getStatus();
  assert.equal(st.remembered, false, 'nach "Weiteres Konto hinzufügen" ist niemand mehr angemeldet');
  assert.equal(st.accounts.length, 1, 'kein doppelter Eintrag für A');
  // B anmelden und speichern
  loginAs(ini, 'B_EINS', '', false, reg, ID_B);
  assert.equal((await epic.saveCurrent('Konto B')).ok, true);
  st = await epic.getStatus();
  assert.equal(st.accounts.length, 2);
  // Zurück zu A: der NEUE Zugang von A wird eingespielt, die Registry zeigt wieder auf A
  const a = st.accounts.find((x) => x.label === 'Konto A');
  const sw = await epic.switchTo(a.id);
  assert.equal(sw.ok, true, sw.message);
  assert.match(fs.readFileSync(ini, 'utf8'), /Data=A_NEU/);
  assert.equal(reg.value, ID_A, 'Konto-ID in der Registry wurde nicht zurückgestellt');
  st = await epic.getStatus();
  assert.equal(st.accounts.length, 2);
  assert.equal(st.accounts.find((x) => x.label === 'Konto A').isCurrent, true);
});

test('Beim Wechsel wird der erneuerte Zugang des bisherigen Kontos mitgenommen', async () => {
  const { ini, reg } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=A1\r\n' });
  reg.value = ID_A;
  await epic.saveCurrent('A');
  await epic.addNew();
  loginAs(ini, 'B1', '', false, reg, ID_B);
  await epic.saveCurrent('B');
  // B ist angemeldet und Epic erneuert dessen Zugang
  loginAs(ini, 'B2', '', false, reg, ID_B);
  const st = await epic.getStatus();
  const a = st.accounts.find((x) => x.label === 'A');
  const b = st.accounts.find((x) => x.label === 'B');
  assert.equal((await epic.switchTo(a.id)).ok, true);
  assert.equal((await epic.getStatus()).accounts.length, 2, 'kein "Vorheriges Konto" angelegt');
  // Zurück zu B: muss den erneuerten Zugang B2 einspielen, nicht den alten B1
  assert.equal((await epic.switchTo(b.id)).ok, true);
  assert.match(fs.readFileSync(ini, 'utf8'), /Data=B2/);
  assert.equal(reg.value, ID_B);
});

test('"Weiteres Konto hinzufügen" leert nur die Anmeldung, alles andere bleibt', async () => {
  const { ini } = setup();
  const res = await epic.addNew();
  assert.equal(res.ok, true, res.message);
  assert.match(res.message, /gesichert/, 'das bisherige Konto wird mitgesichert');
  const text = fs.readFileSync(ini, 'utf8');
  assert.equal(epic._ini.getSection(text, 'RememberMe'), 'Enable=True\nData=');
  assert.equal(epic._ini.getSection(text, 'Core'), 'Foo=1');
  assert.equal(epic._ini.getSection(text, 'Other'), 'X=y');
  const st = await epic.getStatus();
  assert.equal(st.remembered, false);
  assert.equal(st.accounts.length, 1);
  assert.equal(st.accounts[0].email, 'eins@beispiel.de');
});

test('Launcher ab Version 19: Ordner WindowsEditor hat Vorrang, gewechselt wird in beiden Dateien', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-we-'));
  const cfg = path.join(base, 'EpicGamesLauncher', 'Saved', 'Config');
  const oldFile = path.join(cfg, 'Windows', 'GameUserSettings.ini');
  const newFile = path.join(cfg, 'WindowsEditor', 'GameUserSettings.ini');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.writeFileSync(oldFile, '[RememberMe]\r\nEnable=True\r\nData=VERALTET\r\n', 'utf8');
  fs.writeFileSync(newFile, '[Launcher]\r\nX=1\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=AKTUELL\r\n', 'utf8');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(oldFile, past, past);
  const before = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    const reg = fakeRegistry(ID_A);
    epic.init({ dataDir: path.join(base, 'data'), crypto: null, noProcess: true, registry: reg });
    let st = await epic.getStatus();
    assert.equal(st.diag.file, newFile, 'die zuletzt geschriebene Datei mit Anmeldung gewinnt');
    assert.equal(st.diag.configFiles[0].file, newFile, 'WindowsEditor zuerst');
    assert.equal(st.diag.configFiles[1].file, oldFile);
    assert.equal(st.diag.accountId, ID_A);
    assert.equal((await epic.saveCurrent('A')).ok, true);
    // Weiteres Konto: beide Dateien werden geleert
    assert.equal((await epic.addNew()).ok, true);
    assert.equal(epic._ini.getSection(fs.readFileSync(newFile, 'utf8'), 'RememberMe'), 'Enable=True\nData=');
    assert.equal(epic._ini.getSection(fs.readFileSync(oldFile, 'utf8'), 'RememberMe'), 'Enable=True\nData=');
    assert.equal(epic._ini.getSection(fs.readFileSync(newFile, 'utf8'), 'Launcher'), 'X=1');
    // B meldet sich an (neuer Launcher schreibt nur WindowsEditor)
    fs.writeFileSync(newFile, '[Launcher]\r\nX=1\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=KONTO_B\r\n', 'utf8');
    reg.value = ID_B;
    assert.equal((await epic.saveCurrent('B')).ok, true);
    st = await epic.getStatus();
    const a = st.accounts.find((x) => x.label === 'A');
    assert.equal((await epic.switchTo(a.id)).ok, true);
    assert.match(fs.readFileSync(newFile, 'utf8'), /Data=AKTUELL/);
    assert.match(fs.readFileSync(oldFile, 'utf8'), /Data=AKTUELL/);
    assert.equal(reg.value, ID_A);
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = before;
  }
});

test('Ohne Registry-Eintrag kommt die Konto-ID aus Saved\\Data (neueste Datei, auch mit "OC_")', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-dat-'));
  const saved = path.join(base, 'EpicGamesLauncher', 'Saved');
  fs.mkdirSync(path.join(saved, 'Config', 'WindowsEditor'), { recursive: true });
  fs.mkdirSync(path.join(saved, 'Data'), { recursive: true });
  fs.writeFileSync(path.join(saved, 'Config', 'WindowsEditor', 'GameUserSettings.ini'), '[RememberMe]\r\nEnable=True\r\nData=X\r\n', 'utf8');
  const older = path.join(saved, 'Data', ID_A + '.dat');
  const newer = path.join(saved, 'Data', 'OC_' + ID_B + '.dat');
  fs.writeFileSync(older, 'x');
  fs.writeFileSync(newer, 'x');
  const past = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(older, past, past);
  const before = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    epic.init({ dataDir: path.join(base, 'data'), crypto: null, noProcess: true, registry: fakeRegistry(null) });
    const st = await epic.getStatus();
    assert.equal(st.diag.accountId, ID_B);
    assert.equal(st.currentAccountIdShort, 'bbbbbbbb');
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = before;
  }
});

test('Gespeichertes Konto ohne Zugang lässt sich nicht "wechseln" (klare Meldung)', async () => {
  const { base } = setup();
  await epic.saveCurrent('A');
  // Datei von Hand kaputt machen: Zugang fehlt
  const file = path.join(base, 'data', 'epic-konten.json');
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  w.data[0].section = 'Enable=True\nData=';
  fs.writeFileSync(file, JSON.stringify(w), 'utf8');
  const a = (await epic.getStatus()).accounts[0];
  const res = await epic.switchTo(a.id);
  assert.equal(res.ok, false);
  assert.match(res.message, /kein Zugang gespeichert/);
});
