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
  reg.del = async () => { reg.value = null; return true; };
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

test('Nur die Datei, die der Launcher liest, zählt – Kopien in anderen Ordnern nicht', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-la-'));
  const cfg = path.join(base, 'EpicGamesLauncher', 'Saved', 'Config');
  fs.mkdirSync(path.join(cfg, 'Windows'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'WindowsNoEditor'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'Windows', 'GameUserSettings.ini'), '[Core]\r\nFoo=1\r\n', 'utf8');
  fs.writeFileSync(path.join(cfg, 'WindowsNoEditor', 'GameUserSettings.ini'), '[RememberMe]\r\nEnable=True\r\nData=ANDERSWO\r\n', 'utf8');
  const before = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    epic.init({ dataDir: path.join(base, 'data'), crypto: null, noProcess: true, registry: fakeRegistry() });
    const st = await epic.getStatus();
    assert.equal(st.remembered, false, 'eine Kopie in einem fremden Ordner ist keine Anmeldung');
    assert.equal(st.diag.file, path.join(cfg, 'Windows', 'GameUserSettings.ini'));
    assert.equal(st.diag.configFiles.length, 2, 'die Diagnose zeigt trotzdem alle Dateien');
    assert.equal(st.diag.configFiles[0].used, true);
    assert.equal(st.diag.configFiles[1].used, false);
    assert.equal(st.diag.configFiles[1].dataLength, 8);
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

test('Launcher ab Version 19: nur WindowsEditor wird benutzt, die alte Kopie in Windows wird geleert', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-we-'));
  const cfg = path.join(base, 'EpicGamesLauncher', 'Saved', 'Config');
  const oldFile = path.join(cfg, 'Windows', 'GameUserSettings.ini');
  const newFile = path.join(cfg, 'WindowsEditor', 'GameUserSettings.ini');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.writeFileSync(oldFile, '[Core]\r\nAlt=1\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=VERALTET\r\n', 'utf8');
  fs.writeFileSync(newFile, '[Launcher]\r\nX=1\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=AKTUELL\r\n', 'utf8');
  // Auch wenn die alte Datei neuer aussieht: Der Launcher 19+ liest nur WindowsEditor
  const future = new Date(Date.now() + 3600 * 1000);
  fs.utimesSync(oldFile, future, future);
  const before = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = base;
  try {
    const reg = fakeRegistry(ID_A);
    epic.init({ dataDir: path.join(base, 'data'), crypto: null, noProcess: true, registry: reg });
    let st = await epic.getStatus();
    assert.equal(st.diag.file, newFile);
    assert.equal(st.diag.configFiles[0].file, newFile, 'WindowsEditor zuerst');
    assert.equal(st.diag.accountId, ID_A);
    assert.equal((await epic.saveCurrent('A')).ok, true);
    // Weiteres Konto: WindowsEditor geleert, die alte Kopie ebenfalls (kein überflüssiger Zugang auf der Platte)
    assert.equal((await epic.addNew()).ok, true);
    assert.equal(epic._ini.getSection(fs.readFileSync(newFile, 'utf8'), 'RememberMe'), 'Enable=True\nData=');
    assert.equal(epic._ini.getSection(fs.readFileSync(oldFile, 'utf8'), 'RememberMe'), 'Enable=False\nData=');
    assert.equal(epic._ini.getSection(fs.readFileSync(oldFile, 'utf8'), 'Core'), 'Alt=1');
    assert.equal(epic._ini.getSection(fs.readFileSync(newFile, 'utf8'), 'Launcher'), 'X=1');
    assert.equal(reg.value, null, '"Weiteres Konto" löscht die Konto-ID wie der TcNo-Wechsler');
    // B meldet sich an
    fs.writeFileSync(newFile, '[Launcher]\r\nX=1\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=KONTO_B\r\n', 'utf8');
    reg.value = ID_B;
    assert.equal((await epic.saveCurrent('B')).ok, true);
    st = await epic.getStatus();
    const a = st.accounts.find((x) => x.label === 'A');
    assert.equal((await epic.switchTo(a.id)).ok, true);
    assert.match(fs.readFileSync(newFile, 'utf8'), /Data=AKTUELL/);
    assert.doesNotMatch(fs.readFileSync(oldFile, 'utf8'), /Data=AKTUELL/, 'der Zugang wird nicht in die alte Datei kopiert');
    assert.equal(reg.value, ID_A);
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = before;
  }
});

test('Saved\\Data liefert nur einen Hinweis auf die Konto-ID (Name, Diagnose), nie die Zuordnung', async () => {
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
    assert.equal(st.diag.accountId, '', 'ohne Registry-Wert keine Konto-ID');
    assert.equal(st.diag.accountIdHint, ID_B, 'neueste Datei, auch mit "OC_"');
    assert.equal(st.currentAccountIdShort, 'bbbbbbbb');
    assert.equal((await epic.saveCurrent('')).ok, true);
    const acc = (await epic.getStatus()).accounts[0];
    assert.equal(acc.label, 'Epic-Konto bbbbbbbb', 'der Hinweis dient als Namensvorschlag');
    assert.equal(acc.accountIdShort, '', 'aber nicht als gespeicherte Konto-ID');
    assert.equal(acc.legacy, true);
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

// ---------- Fälle aus der Gegenprüfung (Version 1.2.3) ----------

// Baut A und B sauber über "Weiteres Konto hinzufügen" auf. Ergebnis: { ini, reg, a, b }
async function twoAccounts() {
  const { ini, reg } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=A1\r\n' });
  reg.value = ID_A;
  await epic.saveCurrent('A');
  await epic.addNew();
  loginAs(ini, 'B1', '', false, reg, ID_B);
  await epic.saveCurrent('B');
  const st = await epic.getStatus();
  return { ini, reg, a: st.accounts.find((x) => x.label === 'A'), b: st.accounts.find((x) => x.label === 'B') };
}

test('Wechsel zum Ziel, dessen Zugang inzwischen erneuert wurde: der neue Zugang wird eingespielt, nicht der alte', async () => {
  const { ini, reg, a, b } = await twoAccounts();
  assert.equal((await epic.switchTo(a.id)).ok, true);
  // Der Nutzer meldet sich im Launcher von Hand wieder als B an; der Launcher schreibt B_NEU
  loginAs(ini, 'B_NEU', '', false, reg, ID_B);
  const sw = await epic.switchTo(b.id);
  assert.equal(sw.ok, true, sw.message);
  assert.match(fs.readFileSync(ini, 'utf8'), /Data=B_NEU/, 'der frische Zugang von B wurde überschrieben');
  assert.equal(reg.value, ID_B);
  // Hin und zurück: B kommt mit B_NEU wieder, nicht mit B1
  assert.equal((await epic.switchTo(a.id)).ok, true);
  assert.equal((await epic.switchTo(b.id)).ok, true);
  assert.match(fs.readFileSync(ini, 'utf8'), /Data=B_NEU/);
  assert.equal((await epic.getStatus()).accounts.length, 2, 'keine doppelten Einträge');
});

test('Wechsel zu einem Eintrag ohne Konto-ID löscht die Konto-ID in der Registry', async () => {
  const { ini, reg } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=ALT\r\n' });
  reg.value = null;
  await epic.saveCurrent('Alt ohne ID');
  await epic.addNew();
  loginAs(ini, 'B1', '', false, reg, ID_B);
  await epic.saveCurrent('B');
  const st = await epic.getStatus();
  const legacy = st.accounts.find((x) => x.label === 'Alt ohne ID');
  assert.equal(legacy.legacy, true);
  assert.equal((await epic.switchTo(legacy.id)).ok, true);
  assert.equal(reg.value, null, 'die Konto-ID von B darf nicht stehen bleiben');
});

test('Alten Eintrag (ohne Konto-ID) gezielt durch die aktuelle Anmeldung ersetzen', async () => {
  const { ini, reg } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=TOT\r\n' });
  reg.value = null;
  await epic.saveCurrent('Hauptkonto');
  // Der alte Zugang ist ungültig; der Nutzer meldet sich neu an, Epic gibt einen neuen Zugang
  loginAs(ini, 'FRISCH', '', false, reg, ID_A);
  let st = await epic.getStatus();
  assert.equal(st.currentMatchId, null, 'ohne Konto-ID kann der Eintrag nicht von selbst erkannt werden');
  const haupt = st.accounts[0];
  const res = await epic.saveCurrent('', haupt.id);
  assert.equal(res.ok, true, res.message);
  st = await epic.getStatus();
  assert.equal(st.accounts.length, 1, 'kein zweiter Eintrag');
  assert.equal(st.accounts[0].label, 'Hauptkonto', 'Name bleibt');
  assert.equal(st.accounts[0].accountIdShort, 'aaaaaaaa', 'Konto-ID wird übernommen');
  assert.equal(st.accounts[0].isCurrent, true);
  assert.equal(st.currentMatchId, haupt.id);
});

test('Alter Eintrag bekommt seine Konto-ID, sobald genau sein Zugang mit Konto-ID angemeldet ist', async () => {
  const { reg } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=GLEICH\r\n' });
  reg.value = null;
  await epic.saveCurrent('Alt');
  reg.value = ID_A; // der Launcher hat sich mit genau diesem Zugang angemeldet
  assert.equal((await epic.saveCurrent('')).ok, true);
  const acc = (await epic.getStatus()).accounts[0];
  assert.equal(acc.accountIdShort, 'aaaaaaaa');
  assert.equal(acc.legacy, false);
});

test('Widersprechen sich E-Mail-Adresse und Konto-ID, wird kein fremder Eintrag überschrieben', async () => {
  const { ini, reg, base } = setup({ text: '[RememberMe]\r\nEnable=True\r\nData=A1\r\nEmail=a@beispiel.de\r\n' });
  reg.value = ID_A;
  await epic.saveCurrent('A');
  // Registry ist veraltet (zeigt noch auf A), angemeldet ist aber ein anderes Konto
  loginAs(ini, 'X1', 'x@beispiel.de', false, reg, ID_A);
  assert.equal((await epic.getStatus()).currentMatchId, null);
  assert.equal((await epic.saveCurrent('X')).ok, true);
  const st = await epic.getStatus();
  assert.equal(st.accounts.length, 2);
  const raw = JSON.parse(fs.readFileSync(path.join(base, 'data', 'epic-konten.json'), 'utf8')).data;
  assert.match(raw.find((p) => p.label === 'A').section, /Data=A1/, 'der Zugang von A wurde überschrieben');
});

test('Schreibfehler beim Wechsel: nichts geht verloren, die Launcher-Datei bleibt unverändert', async () => {
  const { ini, reg, a } = await twoAccounts();
  // Ein drittes Konto C ist angemeldet und noch nicht gespeichert
  loginAs(ini, 'C1', '', false, reg, 'c'.repeat(32));
  const before = fs.readFileSync(ini, 'utf8');
  epic._test.setWriteHook((file) => {
    if (file === ini) throw Object.assign(new Error('Datei gesperrt'), { code: 'EBUSY' });
  });
  try {
    const res = await epic.switchTo(a.id);
    assert.equal(res.ok, false);
    assert.match(res.message, /nicht geschrieben/);
  } finally {
    epic._test.setWriteHook(null);
  }
  assert.equal(fs.readFileSync(ini, 'utf8'), before, 'die Launcher-Datei wurde verändert');
  const st = await epic.getStatus();
  assert.equal(st.accounts.length, 3, 'das angemeldete Konto C wurde vor dem Schreiben gesichert');
});

test('Startet der Launcher nicht, ist das Konto trotzdem umgestellt und die Meldung sagt, was zu tun ist', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-epic-start-'));
  const ini = path.join(base, 'GameUserSettings.ini');
  fs.writeFileSync(ini, '[RememberMe]\r\nEnable=True\r\nData=A1\r\n', 'utf8');
  const reg = fakeRegistry(ID_A);
  epic.init({ dataDir: path.join(base, 'data'), crypto: null, ini, noProcess: true, registry: reg, exe: 'C:\\x\\EpicGamesLauncher.exe', launch: async () => 'EACCES' });
  await epic.saveCurrent('A');
  loginAs(ini, 'B1', '', false, reg, ID_B);
  const a = (await epic.getStatus()).accounts.find((x) => x.label === 'A');
  const res = await epic.switchTo(a.id);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'start-failed');
  assert.match(res.message, /EACCES/);
  assert.match(res.message, /Starte ihn bitte selbst/);
  assert.match(fs.readFileSync(ini, 'utf8'), /Data=A1/, 'das Konto wurde trotzdem umgestellt');
});
