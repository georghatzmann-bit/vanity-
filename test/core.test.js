'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ini = require('../src/main/core/ini');
const sensitive = require('../src/main/core/sensitive');
const { locateFortnite } = require('../src/main/core/locator');
const { scan } = require('../src/main/core/scanner');
const { CoreService } = require('../src/main/core/service');
const { safeJoin, isReadOnly } = require('../src/main/core/fsutil');
const { summarizeGameUserSettings } = require('../src/main/core/summary');
const { makeLocalAppData, tmpDir, fakeExec, GUS_MAIN, ACCOUNT_B } = require('./helpers');

function core(env, exec = fakeExec()) {
  return new CoreService({ dataDir: tmpDir(), env, exec });
}

// ---------------------------------------------------------------- INI
test('ini: unveränderter Text kommt 1:1 wieder heraus', () => {
  const text = '; Kommentar\r\n[A]\r\nx=1\r\n+Paths=a\r\n+Paths=b\r\n\r\n[B]\r\ny = 2\r\n';
  assert.equal(ini.stringify(ini.parse(text)), text);
  const noNl = '[A]\nx=1';
  assert.equal(ini.stringify(ini.parse(noNl)), noNl);
});

test('ini: set ändert vorhandene Werte, fügt fehlende ein und legt Abschnitte an', () => {
  const doc = ini.parse('[A]\r\nx=1\r\n\r\n[B]\r\ny=2\r\n');
  ini.set(doc, 'A', 'x', '5');
  ini.set(doc, 'A', 'z', '7');
  ini.set(doc, 'C', 'k', 'v');
  const out = ini.stringify(doc);
  assert.match(out, /\[A\]\r\nx=5\r\nz=7\r\n\r\n\[B\]/);
  assert.match(out, /\[C\]\r\nk=v\r\n$/);
  assert.equal(ini.get(ini.parse(out), 'a', 'X'), '5', 'Groß-/Kleinschreibung egal');
});

test('ini: UTF-16 mit BOM bleibt UTF-16', () => {
  const buf = ini.encode('[A]\r\nname=Jörg\r\n', 'utf16le');
  const dec = ini.decode(buf);
  assert.equal(dec.encoding, 'utf16le');
  assert.equal(ini.get(ini.parse(dec.text), 'A', 'name'), 'Jörg');
  assert.deepEqual(ini.encode(dec.text, dec.encoding), buf);
});

// ---------------------------------------------------------------- Schutzfilter
test('Schutzfilter: Browser-, Login- und Protokolldaten sind gesperrt', () => {
  for (const p of ['webcache_4430/Cookies/Cookies', 'Logs/x.log', 'EpicGamesLauncher/x.ini', 'a/token.json', 'Local Storage/leveldb/1.ldb']) {
    assert.equal(sensitive.isBlockedPath(p), true, p);
  }
  for (const p of ['WindowsClient/GameUserSettings.ini', 'ClientSettings.Sav', 'CrashReportClient/UECC-Windows-ABC/CrashReportClient.ini']) {
    assert.equal(sensitive.isBlockedPath(p), false, p);
  }
});

test('Schutzfilter: [RememberMe] und Token-Schlüssel werden entfernt', () => {
  const text = '[A]\r\nx=1\r\nRefreshToken=abc\r\n\r\n[RememberMe]\r\nEnable=True\r\nData=XYZ\r\n\r\n[B]\r\ny=2\r\n';
  const s = sensitive.sanitizeIniText(text);
  assert.equal(s.changed, true);
  assert.doesNotMatch(s.text, /RememberMe|XYZ|RefreshToken/);
  assert.match(s.text, /x=1/);
  assert.match(s.text, /\[B\]\r\ny=2/);
});

test('Schutzfilter: kontogebundene Werte (Konto-IDs, Mitspieler) bleiben beim Konto', () => {
  const s = sensitive.sanitizeIniText('[/Script/FortniteGame.FortGameUserSettings]\r\nFrameRateLimit=240.000000\r\nEulaAcceptedUserId=abc\r\nRecentPlayerEncounters=(x)\r\nRecentPlayerEncounters=(y)\r\n');
  assert.doesNotMatch(s.text, /EulaAcceptedUserId|RecentPlayerEncounters/);
  const m = sensitive.mergeKeepTargetSensitive(s.text, '[/Script/FortniteGame.FortGameUserSettings]\r\nFrameRateLimit=60.000000\r\nEulaAcceptedUserId=ZIEL\r\nRecentPlayerEncounters=(a)\r\nRecentPlayerEncounters=(b)\r\n');
  assert.match(m.text, /FrameRateLimit=240\.000000\r\nEulaAcceptedUserId=ZIEL\r\nRecentPlayerEncounters=\(a\)\r\nRecentPlayerEncounters=\(b\)/);
});

test('Schutzfilter: beim Anwenden bleiben die Login-Daten des Zielkontos erhalten', () => {
  const profile = '[A]\r\nx=9\r\n';
  const current = '[A]\r\nx=1\r\nAccessToken=CUR\r\n\r\n[RememberMe]\r\nData=TARGETDATA\r\n';
  const m = sensitive.mergeKeepTargetSensitive(profile, current);
  assert.match(m.text, /x=9/);
  assert.match(m.text, /AccessToken=CUR/);
  assert.match(m.text, /\[RememberMe\]\r\nData=TARGETDATA/);
  const doc = ini.parse(m.text);
  assert.equal(ini.get(doc, 'A', 'AccessToken'), 'CUR', 'Schlüssel steht wieder im richtigen Abschnitt');
});

// ---------------------------------------------------------------- Suche & Scan
test('Suche: findet FortniteGame über %LOCALAPPDATA% ohne festen Pfad', async () => {
  const fx = makeLocalAppData();
  const loc = await locateFortnite({ env: { LOCALAPPDATA: fx.local } });
  assert.equal(loc.found, true);
  assert.equal(loc.configDir, fx.config);
  assert.equal(loc.hasGameUserSettings, true);
});

test('Suche: findet auch einen umbenannten Fortnite-Ordner und eine eigene Auswahl', async () => {
  const fx = makeLocalAppData();
  const local2 = tmpDir('helix-local2-');
  fs.renameSync(path.join(fx.local, 'FortniteGame'), path.join(local2, 'FortniteGame-Test'));
  const loc = await locateFortnite({ env: { LOCALAPPDATA: local2 } });
  assert.equal(loc.found, true);
  assert.match(loc.configDir, /FortniteGame-Test/);
  const none = await locateFortnite({ env: { LOCALAPPDATA: tmpDir() } });
  assert.equal(none.found, false);
  const manual = await locateFortnite({ env: {}, override: path.join(local2, 'FortniteGame-Test', 'Saved', 'Config') });
  assert.equal(manual.found, true);
  assert.equal(manual.source, 'manual');
});

test('Scan: liest Config mit Unterordnern, Cookies und Logs bleiben draußen', async () => {
  const fx = makeLocalAppData({ withRememberMe: true });
  const r = await scan({ configDir: fx.config, savedDir: fx.saved });
  const rels = r.files.filter((f) => f.included).map((f) => f.rel).sort();
  assert.deepEqual(rels, [
    'Cloud/0123456789abcdef0123456789abcdef/ClientSettings.Sav',
    'CrashReportClient/UECC-Windows-ABC/CrashReportClient.ini',
    'WindowsClient/Engine.ini',
    'WindowsClient/GameUserSettings.ini',
  ]);
  assert.ok(!r.files.some((f) => /webcache|Logs/.test(f.rel)));
  const gus = r.files.find((f) => f.kind === 'video');
  assert.ok(gus.sensitive, 'RememberMe wird erkannt');
  assert.equal(r.totals.hasClientSettings, true);
});

test('Scan: von mehreren Konten kommt nur die neueste ClientSettings ins Profil', async () => {
  const fx = makeLocalAppData();
  const other = path.join(fx.cloudRoot, ACCOUNT_B);
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'ClientSettings.Sav'), 'B');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(fx.cs, old, old);
  const r = await scan({ configDir: fx.config, savedDir: fx.saved });
  const cs = r.files.filter((f) => f.kind === 'controls');
  assert.equal(cs.length, 2);
  assert.equal(cs.find((f) => f.included).rel, `Cloud/${ACCOUNT_B}/ClientSettings.Sav`);
  assert.match(cs.find((f) => !f.included).reason, /anderen/);
});

test('Zusammenfassung: liest Auflösung, FPS und Leistungsmodus', () => {
  const s = summarizeGameUserSettings(GUS_MAIN);
  assert.equal(s.resolution, '1920×1080');
  assert.equal(s.fps, '240 FPS');
  assert.equal(s.renderMode, 'Leistungsmodus');
  assert.equal(s.windowMode, 'Vollbild');
});

// ---------------------------------------------------------------- Profile
test('Profile: speichern, wechseln, anwenden mit Backup und Wiederherstellen', async () => {
  const fx = makeLocalAppData({ clientSettings: 'MAIN-KEYS' });
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const main = await c.createProfile({ name: 'Main' });
  assert.equal(main.fileCount, 4);
  assert.equal(main.summary.resolution, '1920×1080');

  // Zweitaccount: andere Tasten, andere Auflösung, kein Engine.ini
  fs.writeFileSync(fx.cs, 'ZWEIT-KEYS');
  fs.writeFileSync(path.join(fx.wc, 'GameUserSettings.ini'), GUS_MAIN.replace('ResolutionSizeX=1920', 'ResolutionSizeX=1280'));
  fs.rmSync(path.join(fx.wc, 'Engine.ini'));
  const zweit = await c.createProfile({ name: 'Zweitaccount' });
  assert.equal(zweit.fileCount, 3);

  // Vorschau
  const prev = await c.previewProfile(main.id);
  assert.equal(prev.counts.change, 2);
  assert.equal(prev.counts.new, 1);

  const res = await c.applyProfile(main.id);
  assert.equal(res.ok, true, JSON.stringify(res.failed));
  assert.equal(fs.readFileSync(fx.cs).subarray(8).toString(), 'MAIN-KEYS');
  assert.match(fs.readFileSync(path.join(fx.wc, 'GameUserSettings.ini'), 'utf8'), /ResolutionSizeX=1920/);
  assert.ok(fs.existsSync(path.join(fx.wc, 'Engine.ini')), 'Engine.ini kommt aus dem Profil zurück');
  assert.ok(res.backupId);
  assert.equal((await c.getProfile(main.id)).active, true);

  // Zweitaccount anwenden: Engine.ini wird entfernt (nicht im Profil)
  const res2 = await c.applyProfile(zweit.id);
  assert.equal(res2.ok, true);
  assert.equal(res2.removed.length, 1);
  assert.ok(!fs.existsSync(path.join(fx.wc, 'Engine.ini')));
  assert.equal(fs.readFileSync(fx.cs, 'utf8'), 'ZWEIT-KEYS');

  // Backup von vorhin (Zustand vor "Zweitaccount") zurückspielen -> wieder Main
  const restored = await c.restoreBackup(res2.backupId);
  assert.equal(restored.ok, true, JSON.stringify(restored.failed));
  assert.ok(fs.existsSync(path.join(fx.wc, 'Engine.ini')));
  assert.equal(fs.readFileSync(fx.cs).subarray(8).toString(), 'MAIN-KEYS');

  const backups = await c.listBackups();
  assert.ok(backups.some((b) => b.reason === 'original' && b.pinned), 'Originalzustand ist gesichert');
  assert.ok(backups.some((b) => b.reason === 'vor-anwenden'));
  assert.ok(backups.some((b) => b.reason === 'vor-wiederherstellen'));
});

test('Profile: Schreibschutz setzen, trotzdem überschreibbar, Notfall-Knopf', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Turnier' });
  await c.setProfileOptions(p.id, { readOnly: ['video'] });
  fs.writeFileSync(path.join(fx.wc, 'GameUserSettings.ini'), 'GEAENDERT');
  const r = await c.applyProfile(p.id);
  assert.equal(r.ok, true);
  assert.equal(await isReadOnly(path.join(fx.wc, 'GameUserSettings.ini')), true);
  assert.equal(await isReadOnly(path.join(fx.wc, 'Engine.ini')), false);
  // erneutes Anwenden mit "alles schützen" klappt trotz bestehendem Schreibschutz
  const r2 = await c.applyProfile(p.id, { readOnly: 'all' });
  assert.equal(r2.ok, true);
  assert.equal(await isReadOnly(path.join(fx.wc, 'Engine.ini')), true);
  assert.equal(await isReadOnly(fx.cs), false, 'Cloud-Kopie wird nie schreibgeschützt');
  const cleared = await c.clearAllReadOnly();
  assert.ok(cleared.cleared.length >= 2);
  assert.equal(await isReadOnly(path.join(fx.wc, 'GameUserSettings.ini')), false);
});

test('Profile: Login-Daten werden nie gespeichert und beim Anwenden nicht überschrieben', async () => {
  const fx = makeLocalAppData({ withRememberMe: true });
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  const stored = fs.readFileSync(safeJoin(path.join(c.profiles.dir(p.id), 'files', 'config'), 'WindowsClient/GameUserSettings.ini'), 'utf8');
  assert.doesNotMatch(stored, /RememberMe/);
  assert.equal(p.files.find((f) => f.kind === 'video').sanitized, true);
  // anderes Konto ist eingeloggt: andere Daten im Ziel
  const gusPath = path.join(fx.wc, 'GameUserSettings.ini');
  fs.writeFileSync(gusPath, GUS_MAIN.replace('FrameRateLimit=240.000000', 'FrameRateLimit=60.000000') + '\r\n[RememberMe]\r\nEnable=True\r\nData=OTHERACCOUNT\r\n');
  const r = await c.applyProfile(p.id);
  assert.equal(r.ok, true);
  const after = fs.readFileSync(gusPath, 'utf8');
  assert.match(after, /FrameRateLimit=240/);
  assert.match(after, /Data=OTHERACCOUNT/);
  // auch in Backups landen keine Login-Daten
  for (const b of await c.listBackups()) {
    const f = path.join(c.backups.dir(b.id), 'files', 'config', 'WindowsClient', 'GameUserSettings.ini');
    if (fs.existsSync(f)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /RememberMe|OTHERACCOUNT/);
  }
});

test('Profile: Fortnite läuft -> nicht anwenden, schließen hilft', async () => {
  const fx = makeLocalAppData();
  const running = { value: ['FortniteClient-Win64-Shipping.exe', 'FortniteClient-Win64-Shipping_EAC_EOS.exe', 'FortniteLauncher.exe'] };
  const c = core({ LOCALAPPDATA: fx.local }, fakeExec(running));
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  await assert.rejects(() => c.applyProfile(p.id), (e) => e.code === 'FORTNITE_RUNNING');
  const closed = await c.closeFortnite();
  assert.equal(closed.closed, true);
  // nur das Spiel selbst wurde geschlossen, nie das Anti-Cheat-Startprogramm
  const kills = c.exec.calls.filter((x) => /taskkill/i.test(x[0])).map((x) => x.join(' '));
  assert.deepEqual(kills, ['taskkill.exe /IM FortniteClient-Win64-Shipping.exe']);
  const r = await c.applyProfile(p.id);
  assert.equal(r.ok, true);
});

test('Profile: umbenennen, doppelte Namen, duplizieren, löschen', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const a = await c.createProfile({ name: 'Main' });
  await assert.rejects(() => c.createProfile({ name: 'main' }), (e) => e.code === 'NAME_TAKEN');
  await assert.rejects(() => c.createProfile({ name: '   ' }), (e) => e.code === 'BAD_NAME');
  const b = await c.duplicateProfile(a.id);
  assert.equal(b.name, 'Main Kopie');
  assert.equal(b.fileCount, a.fileCount);
  await c.renameProfile(b.id, 'Turnier');
  await assert.rejects(() => c.renameProfile(b.id, 'Main'), (e) => e.code === 'NAME_TAKEN');
  await c.removeProfile(a.id);
  const list = await c.listProfiles();
  assert.deepEqual(list.map((x) => x.name), ['Turnier']);
  assert.ok(fs.readdirSync(c.trashDir).length === 1, 'Gelöschtes Profil liegt im Papierkorb');
});

test('Profile: Export und Import, gefährliche Archive werden abgelehnt', async () => {
  const { zipSync, strToU8 } = require('fflate');
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  const file = path.join(tmpDir(), 'main.helixprofil');
  const ex = await c.exportProfile(p.id, file);
  assert.equal(ex.files, 4);
  const imp = await c.importProfile(file);
  assert.equal(imp.profile.name, 'Main (2)');
  assert.equal(imp.profile.fileCount, 4);

  const evil = path.join(tmpDir(), 'evil.helixprofil');
  fs.writeFileSync(evil, zipSync({
    'helix-profil.json': strToU8(JSON.stringify({ format: 'helix-profil', version: 1, profile: { name: 'Böse' } })),
    'files/config/../../../escape.ini': strToU8('[A]\r\nx=1\r\n'),
    'files/other/x.ini': strToU8('x'),
    'files/config/webcache/Cookies': strToU8('c'),
    'files/config/WindowsClient/GameUserSettings.ini': strToU8('[RememberMe]\r\nData=STOLEN\r\n[A]\r\nx=1\r\n'),
  }));
  const r = await c.importProfile(evil);
  assert.equal(r.profile.fileCount, 1);
  assert.ok(r.rejected.length >= 3);
  const stored = fs.readFileSync(path.join(c.profiles.dir(r.profile.id), 'files', 'config', 'WindowsClient', 'GameUserSettings.ini'), 'utf8');
  assert.doesNotMatch(stored, /STOLEN/);
  assert.ok(!fs.existsSync(path.join(path.dirname(c.dataDir), 'escape.ini')));

  fs.writeFileSync(evil, 'kein zip');
  await assert.rejects(() => c.importProfile(evil), (e) => e.code === 'IMPORT_BROKEN');
});

test('Cloud-Wächter: erkennt, wenn Fortnite nach dem Anwenden Dateien ändert', async () => {
  const fx = makeLocalAppData();
  const events = [];
  const c = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec(), emit: (n, p) => events.push([n, p]) });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  await c.applyProfile(p.id);
  assert.equal((await c.checkDrift()).status, 'ok');
  fs.writeFileSync(fx.cs, 'AUS-DER-CLOUD');
  const d = await c.checkDrift(true);
  assert.equal(d.status, 'drift');
  assert.equal(d.changed[0].kind, 'controls');
  assert.ok(events.some(([n]) => n === 'drift'));
  await c.acknowledgeDrift();
  assert.equal((await c.checkDrift()).acknowledged, true);
  // eigene Änderung durch ein Tool zählt nicht als Abweichung
  await c.applyProfile(p.id);
  await c.applyIniChanges('GameUserSettings.ini', [{ section: '/Script/FortniteGame.FortGameUserSettings', key: 'FrameRateLimit', value: '144.000000' }]);
  assert.equal((await c.checkDrift()).status, 'ok');
});

test('Cloud-Wächter: Zeitstempel beim Beenden sind keine Änderung, echte Einstellungen schon', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  await c.applyProfile(p.id);
  const gusPath = path.join(fx.wc, 'GameUserSettings.ini');
  // so schreibt Fortnite beim Beenden: Zusatzwerte, Zeitstempel, 240 statt 240.000000
  fs.writeFileSync(gusPath, fs.readFileSync(gusPath, 'utf8').replace('FrameRateLimit=240.000000', 'FrameRateLimit=240').replace('[ScalabilityGroups]', 'LastTimeSettingsSnapshotUploaded=2026.10.18-12.00.00\r\nLastGPUBenchmarkResult=123.4\r\n\r\n[ScalabilityGroups]'));
  assert.equal((await c.checkDrift()).status, 'ok');
  fs.writeFileSync(gusPath, fs.readFileSync(gusPath, 'utf8').replace('FrameRateLimit=240', 'FrameRateLimit=60.000000'));
  const d = await c.checkDrift();
  assert.equal(d.status, 'drift');
  assert.deepEqual(d.changed[0].settings, [{ section: '/Script/FortniteGame.FortGameUserSettings', key: 'FrameRateLimit', from: '240.000000', to: '60.000000' }]);
});

test('Tools-Schnittstelle: INI-Werte ändern mit Backup, Schreibschutz bleibt', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const gus = path.join(fx.wc, 'GameUserSettings.ini');
  fs.chmodSync(gus, 0o444);
  const prev = await c.previewIniChanges('GameUserSettings.ini', [
    { section: '/Script/FortniteGame.FortGameUserSettings', key: 'FrameRateLimit', value: '165.000000' },
    { section: 'ScalabilityGroups', key: 'sg.ShadowQuality', value: '0' },
  ]);
  assert.equal(prev.changes[0].changed, true);
  assert.equal(prev.changes[1].changed, false);
  const r = await c.applyIniChanges('GameUserSettings.ini', [
    { section: '/Script/FortniteGame.FortGameUserSettings', key: 'FrameRateLimit', value: '165.000000' },
    { section: 'NeuerAbschnitt', key: 'Wert', value: '1' },
  ]);
  assert.equal(r.applied.length, 2);
  const text = fs.readFileSync(gus, 'utf8');
  assert.match(text, /FrameRateLimit=165\.000000\r\n/);
  assert.match(text, /\[NeuerAbschnitt\]\r\nWert=1/);
  assert.equal(await isReadOnly(gus), true);
  await assert.rejects(() => c.applyIniChanges('GameUserSettings.ini', [{ section: 'A', key: 'x', value: 'a\r\n[Evil]' }]), (e) => e.code === 'BAD_CHANGE');
  const vals = await c.readIniValues('GameUserSettings.ini', [{ section: 'ScalabilityGroups', key: 'sg.TextureQuality' }]);
  assert.equal(vals.values['ScalabilityGroups|sg.TextureQuality'], '1');
});

test('Vergleich: zeigt geänderte Werte zwischen Profil und aktuellem Stand', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  fs.writeFileSync(path.join(fx.wc, 'GameUserSettings.ini'), GUS_MAIN.replace('FrameRateLimit=240.000000', 'FrameRateLimit=60.000000'));
  const d = await c.diff('profile', p.id);
  const g = d.files.find((f) => f.kind === 'video');
  assert.equal(g.status, 'different');
  assert.deepEqual(g.changes, [{ section: '/Script/FortniteGame.FortGameUserSettings', key: 'FrameRateLimit', current: '60.000000', saved: '240.000000' }]);
});

test('Sicherheit: safeJoin lässt keine Pfade aus dem Ordner heraus', () => {
  const root = tmpDir();
  assert.throws(() => safeJoin(root, '../x'));
  assert.throws(() => safeJoin(root, 'a/../../x'));
  assert.throws(() => safeJoin(root, '/etc/passwd'));
  assert.throws(() => safeJoin(root, 'C:/Windows/x'));
  assert.throws(() => safeJoin(root, 'a/b:c'));
  assert.equal(safeJoin(root, 'a/b.ini'), path.join(root, 'a', 'b.ini'));
});

// ---------------------------------------------------------------- Regressionen aus der Prüfung
test('Prüfung: unterbrochener Profil-Tausch wird beim nächsten Start zurückgeholt', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  // Absturz zwischen den beiden Umbenennungen nachstellen
  fs.renameSync(c.profiles.dir(p.id), path.join(c.profiles.root, `.old-${p.id}-abcd`));
  await c.profiles.cleanup();
  assert.deepEqual((await c.listProfiles()).map((x) => x.name), ['Main']);
});

test('Prüfung: Sicherung vor dem Anwenden enthält auch die Cloud-Kopie anderer Konten', async () => {
  const fx = makeLocalAppData({ clientSettings: 'A-PROFIL' });
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  fs.writeFileSync(fx.cs, 'A-NEUER');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(fx.cs, old, old);
  const other = path.join(fx.cloudRoot, ACCOUNT_B);
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'ClientSettings.Sav'), 'B');
  const r = await c.applyProfile(p.id);
  assert.equal(r.ok, true);
  const b = (await c.listBackups()).find((x) => x.id === r.backupId);
  assert.ok(b.files.some((f) => f.rel.includes(ACCOUNT_B)), 'Konto B gesichert');
  assert.ok(b.files.some((f) => f.rel.includes('0123456789abcdef')), 'Konto A (wird überschrieben) gesichert');
  await c.restoreBackup(r.backupId);
  assert.equal(fs.readFileSync(fx.cs, 'utf8'), 'A-NEUER');
});

test('Prüfung: Import nimmt außerhalb von Config nur die Cloud-Kopie und stoppt ZIP-Bomben', async () => {
  const { zipSync, strToU8 } = require('fflate');
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const f = path.join(tmpDir(), 'x.helixprofil');
  fs.writeFileSync(f, zipSync({
    'helix-profil.json': strToU8(JSON.stringify({ format: 'helix-profil', version: 1, profile: { name: 'X' } })),
    'files/saved/Config/WindowsClient/GameUserSettings.ini': strToU8('[A]\r\nx=1\r\n'),
    'files/saved/Demos/a.replay': strToU8('x'),
    'files/saved/Cloud/_konto_/ClientSettings.Sav': strToU8('CS'),
    'files/config/WindowsClient/GameUserSettings.ini': strToU8('[/Script/FortniteGame.FortGameUserSettings]\r\nFrameRateLimit=60.000000\r\n'),
  }));
  const r = await c.importProfile(f);
  assert.deepEqual(r.profile.files.map((x) => `${x.root}:${x.rel}`).sort(), ['config:WindowsClient/GameUserSettings.ini', 'saved:Cloud/_konto_/ClientSettings.Sav']);
  // Platzhalter wird beim Anwenden auf das Konto auf diesem PC abgebildet
  const ap = await c.applyProfile(r.profile.id);
  assert.equal(ap.ok, true, JSON.stringify(ap.failed));
  assert.equal(fs.readFileSync(fx.cs, 'utf8'), 'CS');
  assert.ok(fs.existsSync(path.join(fx.wc, 'GameUserSettings.ini')));

  const big = {};
  big['helix-profil.json'] = strToU8(JSON.stringify({ format: 'helix-profil', version: 1, profile: { name: 'B' } }));
  for (let i = 0; i < 12; i++) big[`files/config/f${i}.ini`] = new Uint8Array(7 * 1024 * 1024);
  fs.writeFileSync(f, zipSync(big, { level: 9 }));
  await assert.rejects(() => c.importProfile(f), (e) => e.code === 'IMPORT_TOO_BIG');
});

test('Prüfung: Export enthält keine Konto-ID', async () => {
  const { unzipSync, strFromU8 } = require('fflate');
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  const f = path.join(tmpDir(), 'm.helixprofil');
  await c.exportProfile(p.id, f);
  const z = unzipSync(new Uint8Array(fs.readFileSync(f)));
  assert.ok(!Object.keys(z).some((k) => k.includes('0123456789abcdef')));
  assert.doesNotMatch(strFromU8(z['helix-profil.json']), /0123456789abcdef/);
});

test('Prüfung: Papierkorb hält 30 Tage ab dem Löschen, nicht ab der letzten Änderung', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Alt' });
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  fs.utimesSync(c.profiles.dir(p.id), old, old);
  await c.removeProfile(p.id);
  await c.purgeTrash();
  assert.equal(fs.readdirSync(c.trashDir).length, 1);
});

test('Prüfung: Standardordner hat Vorrang vor einer Kopie, Epic Launcher wird abgelehnt', async () => {
  const fx = makeLocalAppData();
  fs.cpSync(path.join(fx.local, 'FortniteGame'), path.join(fx.local, 'FortniteGame - Kopie'), { recursive: true });
  fs.writeFileSync(path.join(fx.local, 'FortniteGame - Kopie', 'Saved', 'Config', 'WindowsClient', 'Extra.ini'), '[A]\r\nx=1\r\n');
  fs.rmSync(path.join(fx.wc, 'Engine.ini'));
  const loc = await locateFortnite({ env: { LOCALAPPDATA: fx.local } });
  assert.equal(loc.configDir, fx.config);
  const egl = path.join(fx.local, 'EpicGamesLauncher', 'Saved');
  fs.mkdirSync(path.join(egl, 'Config', 'Windows'), { recursive: true });
  fs.writeFileSync(path.join(egl, 'Config', 'Windows', 'GameUserSettings.ini'), '[RememberMe]\r\nData=x\r\n');
  const manual = await locateFortnite({ env: {}, override: egl });
  assert.equal(manual.found, false);
});

test('Prüfung: Originalzustand wird auch gesichert, wenn der Ordner erst später gewählt wird', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: tmpDir() });
  await c.init();
  assert.equal(c.location.found, false);
  await c.setOverride(fx.saved);
  const backups = await c.listBackups();
  assert.ok(backups.some((b) => b.reason === 'original' && b.pinned));
});

test('Prüfung: Vergleich zeigt nie Login- oder Konto-Daten', async () => {
  const fx = makeLocalAppData({ withRememberMe: true });
  fs.appendFileSync(path.join(fx.wc, 'GameUserSettings.ini'), '');
  const gus = path.join(fx.wc, 'GameUserSettings.ini');
  fs.writeFileSync(gus, fs.readFileSync(gus, 'utf8').replace('bShowGrass=False', 'bShowGrass=False\r\nEulaAcceptedUserId=0123456789abcdef0123456789abcdef'));
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  const d = await c.diff('profile', p.id);
  const g = d.files.find((f) => f.kind === 'video');
  assert.notEqual(g.status, 'different', 'direkt nach dem Speichern ist nichts anders');
  // (der Ordnername der Cloud-Kopie wird in der Oberfläche gekürzt angezeigt)
  assert.doesNotMatch(JSON.stringify(d.files.map((f) => f.changes)), /RememberMe|AAAAAAAAAA|0123456789abcdef0123/);
});

test('Prüfung: „Ignorieren“ bleibt, auch wenn Fortnite die Datei mit gleichen Werten neu schreibt', async () => {
  const fx = makeLocalAppData();
  const c = core({ LOCALAPPDATA: fx.local });
  await c.init();
  const p = await c.createProfile({ name: 'Main' });
  await c.applyProfile(p.id);
  const gus = path.join(fx.wc, 'GameUserSettings.ini');
  fs.writeFileSync(gus, fs.readFileSync(gus, 'utf8').replace('FrameRateLimit=240.000000', 'FrameRateLimit=144.000000'));
  assert.equal((await c.checkDrift()).status, 'drift');
  await c.acknowledgeDrift();
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(gus, later, later);
  const d = await c.checkDrift();
  assert.equal(d.acknowledged, true);
});
