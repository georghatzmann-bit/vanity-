'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logic = require('../../src/main/tools/cache-logic');
const cacheModule = require('../../src/main/modules/tools/cache');

function tmp(prefix = 'helix-cache-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, bytes = 10) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

/** Baut ein nachgemachtes Benutzerprofil mit Caches, Fortnite-Ordner und Dingen, die tabu sind. */
function makeProfile() {
  const home = tmp();
  const local = path.join(home, 'AppData', 'Local');
  const temp = path.join(local, 'Temp');
  const saved = path.join(local, 'FortniteGame', 'Saved');
  const outside = tmp('helix-outside-');
  write(path.join(outside, 'wichtig.bin'), 5000);
  write(path.join(outside, 'sub', 'auch-wichtig.bin'), 300);

  write(path.join(local, 'D3DSCache', 'a1', 'x.idx'), 100);
  write(path.join(local, 'D3DSCache', 'a1', 'x.val'), 200);
  write(path.join(local, 'D3DSCache', 'b2', 'y.val'), 300);
  write(path.join(local, 'NVIDIA', 'DXCache', 'nv1.toc'), 1000);
  write(path.join(home, 'AppData', 'LocalLow', 'NVIDIA', 'PerDriverVersion', 'DXCache', 'p.bin'), 400);
  write(path.join(local, 'AMD', 'DxCache', 'amd.bin'), 50);
  write(path.join(saved, 'Logs', 'FortniteGame.log'), 700);
  write(path.join(saved, 'Logs', 'FortniteGame-backup-2026.10.01.log'), 300);
  write(path.join(saved, 'Crashes', 'UECC-Windows-ABC', 'UEMinidump.dmp'), 2000);
  // tabu
  write(path.join(saved, 'Config', 'WindowsClient', 'GameUserSettings.ini'), 50);
  write(path.join(saved, 'Cloud', 'abc', 'ClientSettings.Sav'), 50);
  write(path.join(saved, 'Demos', 'UnsavedReplay-2026.10.01-20.00.00.replay'), 50);
  write(path.join(saved, 'PersistentDownloadDir', 'EMS', 'hotfix'), 50);
  write(path.join(local, 'EpicGamesLauncher', 'Saved', 'webcache', 'Cookies'), 50);
  // Temp: nur passende Namen
  write(path.join(temp, 'UECC-Windows-1234', 'report.txt'), 80);
  write(path.join(temp, 'Fortnite-tmp.bin'), 20);
  write(path.join(temp, 'UnrealShaderWorker', 'w.tmp'), 30);
  write(path.join(temp, 'UEFI_Update', 'firmware.bin'), 999); // darf NICHT gelöscht werden (UEFI ≠ UE)
  write(path.join(temp, 'Word-Dokument.tmp'), 999);
  write(path.join(temp, 'NVIDIA Corporation', 'NV_Cache', 'legacy.bin'), 60);

  const env = { LOCALAPPDATA: local, USERPROFILE: home, TEMP: temp };
  const location = { found: true, savedDir: saved, configDir: path.join(saved, 'Config') };
  return { home, local, temp, saved, outside, env, location };
}

// ---------------------------------------------------------------- Pfade & Regeln
test('Cache: Bereiche kommen nur aus Umgebungsvariablen und dem Fortnite-Ordner', () => {
  const p = makeProfile();
  const cats = logic.buildCategories(p.env, p.location);
  const ids = cats.map((c) => c.id);
  assert.deepEqual(ids, ['directx', 'nvidia', 'amd', 'intel', 'logs', 'crashes', 'temp']);
  const all = cats.flatMap((c) => c.roots);
  for (const r of all) assert.ok(path.isAbsolute(r), r);
  assert.ok(all.includes(path.join(p.local, 'D3DSCache')));
  assert.ok(all.includes(path.join(p.home, 'AppData', 'LocalLow', 'NVIDIA', 'PerDriverVersion', 'DXCache')));
  assert.ok(all.includes(path.join(p.home, 'AppData', 'LocalLow', 'Intel', 'ShaderCache')));
  assert.ok(all.includes(path.join(p.saved, 'Logs')));
  assert.ok(all.includes(path.join(p.saved, 'Crashes')));
  // nie: Config, Cloud, Demos, PersistentDownloadDir
  for (const bad of ['Config', 'Cloud', 'Demos', 'PersistentDownloadDir']) {
    assert.ok(!all.some((r) => r.includes(path.join('Saved', bad))), bad);
  }
});

test('Cache: ohne Umgebungsvariablen oder mit relativen Pfaden gibt es keine Bereiche', () => {
  assert.deepEqual(logic.buildCategories({}, null), []);
  assert.deepEqual(logic.buildCategories({ LOCALAPPDATA: 'relativ\\pfad', USERPROFILE: '' }, null), []);
  // Ohne Fortnite-Ordner gibt es keine Protokolle/Absturzberichte
  const p = makeProfile();
  const ids = logic.buildCategories(p.env, { found: false }).map((c) => c.id);
  assert.ok(!ids.includes('logs') && !ids.includes('crashes'));
});

test('Cache: Protokolle nur in einem echten Fortnite-"Saved"-Ordner (nicht in fremden Ordnern)', () => {
  const p = makeProfile();
  const odd = path.join(p.home, 'Irgendwas');
  fs.mkdirSync(path.join(odd, 'Config'), { recursive: true });
  write(path.join(odd, 'Logs', 'privat.log'), 10);
  const ids = logic.buildCategories(p.env, { found: true, savedDir: odd }).map((c) => c.id);
  assert.ok(!ids.includes('logs') && !ids.includes('crashes'));
  const ids2 = logic.buildCategories(p.env, { found: true, savedDir: path.join(p.home, 'Daten', 'Saved') }).map((c) => c.id);
  assert.ok(!ids2.includes('logs'), 'Saved ohne Fortnite im Elternordner');
});

test('Cache: Temp-Ordner außerhalb des Benutzerordners wird nicht benutzt', () => {
  const p = makeProfile();
  const other = tmp('helix-systemp-');
  const cats = logic.buildCategories({ ...p.env, TEMP: other }, p.location);
  const temp = cats.find((c) => c.id === 'temp');
  assert.equal(temp, undefined);
  assert.ok(!cats.flatMap((c) => c.roots).some((r) => r.startsWith(other)));
});

test('Cache: Namensfilter für Temp ist vorsichtig', () => {
  for (const n of ['UE4CC-Windows-1', 'UE5-Shader', 'UECC-Windows-ABCD', 'UnrealShaderWorker', 'Fortnite-Cache', 'CrashReportClient', 'ue-temp']) {
    assert.equal(logic.isTempEntryName(n), true, n);
  }
  for (const n of ['UEFI_Update', 'uefi.log', 'Word.tmp', 'NVIDIA Corporation', 'EpicGamesLauncher', '', 'XFortnite']) {
    assert.equal(logic.isTempEntryName(n), false, n);
  }
});

test('Cache: verbotene Pfade (Config, Cloud, Demos, Launcher, Anti-Cheat, Installation)', () => {
  const p = makeProfile();
  const s = { savedDir: p.saved };
  assert.equal(logic.isForbiddenPath(path.join(p.saved, 'Logs', 'a.log'), s), false);
  assert.equal(logic.isForbiddenPath(path.join(p.saved, 'Crashes', 'x', 'y.dmp'), s), false);
  for (const rel of ['Config/WindowsClient/GameUserSettings.ini', 'Cloud/abc/ClientSettings.Sav', 'Demos/a.replay', 'PersistentDownloadDir/EMS/x', 'webcache_4430/x', '']) {
    assert.equal(logic.isForbiddenPath(path.join(p.saved, rel), s), true, rel);
  }
  assert.equal(logic.isForbiddenPath(path.join(p.local, 'EpicGamesLauncher', 'Saved', 'x'), s), true);
  assert.equal(logic.isForbiddenPath(path.join(p.home, 'Program Files', 'Epic Games', 'Fortnite', 'FortniteGame', 'Binaries', 'x.exe'), s), true);
  assert.equal(logic.isForbiddenPath(path.join(p.home, 'Games', 'Fortnite', 'FortniteGame', 'Content', 'Paks', 'a.pak'), s), true);
  assert.equal(logic.isForbiddenPath(path.join(p.home, 'EasyAntiCheat_EOS', 'x'), s), true);
  assert.equal(logic.isForbiddenPath(path.join(p.home, 'BattlEye', 'x'), s), true);
  assert.equal(logic.isForbiddenPath(path.join(p.local, 'D3DSCache', 'x'), s), false);
});

// ---------------------------------------------------------------- Messen
test('Cache: Messung zählt Bytes und Dateien je Bereich, nur vorhandene Bereiche', async () => {
  const p = makeProfile();
  const cats = logic.buildCategories(p.env, p.location);
  const found = await logic.scanCategories(cats, { savedDir: p.saved });
  const by = Object.fromEntries(found.map((c) => [c.id, c]));
  assert.equal(by.directx.bytes, 600);
  assert.equal(by.directx.count, 3);
  assert.equal(by.nvidia.bytes, 1000 + 400 + 60);
  assert.equal(by.amd.bytes, 50);
  assert.equal(by.logs.bytes, 1000);
  assert.equal(by.crashes.bytes, 2000);
  assert.equal(by.temp.bytes, 80 + 20 + 30, 'nur UE/Unreal/Fortnite/CrashReport-Einträge');
  assert.equal(by.intel, undefined, 'Intel-Ordner fehlt -> nicht angezeigt');
  assert.ok(by.logs.privacy, 'Protokolle haben den Datenschutz-Hinweis');
});

test('Cache: Saved-Ordner über einen anderen Pfad (Kurzname/Verknüpfung) – Protokolle werden trotzdem gemessen und geleert', async (t) => {
  // Unter Windows liefert os.tmpdir() oft einen Kurznamen (RUNNER~1), realpath den langen Namen.
  const p = makeProfile();
  const alias = path.join(tmp('helix-alias-'), 'home');
  try { fs.symlinkSync(p.home, alias, 'junction'); } catch (e) { t.skip(e.code); return; }
  const local = path.join(alias, 'AppData', 'Local');
  const saved = path.join(local, 'FortniteGame', 'Saved');
  const cats = logic.buildCategories({ LOCALAPPDATA: local, USERPROFILE: alias, TEMP: path.join(local, 'Temp') }, { found: true, savedDir: saved, configDir: path.join(saved, 'Config') });
  const found = await logic.scanCategories(cats, { savedDir: saved });
  const by = Object.fromEntries(found.map((c) => [c.id, c]));
  assert.equal(by.logs?.bytes, 1000);
  assert.equal(by.crashes?.bytes, 2000);
  const r = await logic.cleanCategories(cats.filter((c) => c.id === 'logs'), { savedDir: saved });
  assert.equal(r.freedBytes, 1000);
  assert.ok(fs.existsSync(path.join(p.saved, 'Config', 'WindowsClient', 'GameUserSettings.ini')), 'Einstellungen bleiben');
});

test('Cache: TEMP als Kurzname/Verknüpfung (C:\\Users\\GEORGH~1\\…) – Temp-Bereich bleibt erhalten', (t) => {
  const p = makeProfile();
  const alias = path.join(tmp('helix-short-'), 'GEORGH~1');
  try { fs.symlinkSync(p.home, alias, 'junction'); } catch (e) { t.skip(e.code); return; }
  const shortTemp = path.join(alias, 'AppData', 'Local', 'Temp');
  const cats = logic.buildCategories({ ...p.env, TEMP: shortTemp }, p.location);
  const temp = cats.find((c) => c.id === 'temp');
  assert.ok(temp, 'Temp-Bereich ist da');
  assert.equal(temp.roots[0], fs.realpathSync.native(p.temp), 'mit dem echten, langen Pfad');
  assert.ok(cats.find((c) => c.id === 'nvidia').roots.some((r) => r.endsWith(path.join('NVIDIA Corporation', 'NV_Cache')) && r.startsWith(fs.realpathSync.native(p.temp))));
  // ein Temp-Ordner außerhalb des Benutzerordners bleibt verboten
  const other = tmp('helix-fremd-temp-');
  assert.equal(logic.buildCategories({ ...p.env, TEMP: other }, p.location).find((c) => c.id === 'temp'), undefined);
});

test('Cache: Verknüpfungen nach außen werden NICHT verfolgt (Messen und Löschen)', async (t) => {
  const p = makeProfile();
  const d3d = path.join(p.local, 'D3DSCache');
  try {
    fs.symlinkSync(p.outside, path.join(d3d, 'link-dir'), 'junction');
    fs.symlinkSync(path.join(p.outside, 'wichtig.bin'), path.join(d3d, 'link-file'));
  } catch (e) {
    t.skip(`Verknüpfungen hier nicht möglich: ${e.code}`);
    return;
  }
  const cats = logic.buildCategories(p.env, p.location).filter((c) => c.id === 'directx');
  const found = await logic.scanCategories(cats, { savedDir: p.saved });
  assert.equal(found[0].bytes, 600, 'Inhalt hinter der Verknüpfung zählt nicht mit');
  const r = await logic.cleanCategories(cats, { savedDir: p.saved });
  assert.equal(r.deleted, 3);
  assert.equal(r.freedBytes, 600);
  assert.ok(fs.existsSync(path.join(p.outside, 'wichtig.bin')), 'Ziel der Verknüpfung bleibt');
  assert.ok(fs.existsSync(path.join(p.outside, 'sub', 'auch-wichtig.bin')), 'Unterordner des Ziels bleibt');
  assert.ok(fs.lstatSync(path.join(d3d, 'link-dir')).isSymbolicLink(), 'Verknüpfung selbst bleibt unangetastet');
});

test('Cache: ein Bereichsordner, der selbst eine Verknüpfung ist, wird übersprungen', async (t) => {
  const p = makeProfile();
  const amdDx = path.join(p.local, 'AMD', 'DxCache');
  fs.rmSync(amdDx, { recursive: true, force: true });
  try { fs.symlinkSync(p.outside, amdDx, 'junction'); } catch (e) { t.skip(e.code); return; }
  const cats = logic.buildCategories(p.env, p.location).filter((c) => c.id === 'amd');
  const found = await logic.scanCategories(cats, { savedDir: p.saved });
  assert.equal(found.length, 0);
  await logic.cleanCategories(cats, { savedDir: p.saved });
  assert.ok(fs.existsSync(path.join(p.outside, 'wichtig.bin')));
});

// ---------------------------------------------------------------- Löschen
test('Cache: Aufräumen löscht Dateien, behält die Bereichsordner und entfernt leere Unterordner', async () => {
  const p = makeProfile();
  const cats = logic.buildCategories(p.env, p.location);
  const r = await logic.cleanCategories(cats, { savedDir: p.saved });
  assert.equal(r.skipped, 0);
  assert.equal(r.freedBytes, 600 + 1460 + 50 + 1000 + 2000 + 130);
  assert.ok(fs.existsSync(path.join(p.local, 'D3DSCache')), 'Ordner selbst bleibt');
  assert.deepEqual(fs.readdirSync(path.join(p.local, 'D3DSCache')), [], 'leere Unterordner sind weg');
  assert.ok(fs.existsSync(path.join(p.saved, 'Logs')));
  assert.ok(fs.existsSync(path.join(p.saved, 'Crashes')));
  // tabu-Dateien sind noch da
  for (const rel of ['Config/WindowsClient/GameUserSettings.ini', 'Cloud/abc/ClientSettings.Sav', 'Demos/UnsavedReplay-2026.10.01-20.00.00.replay', 'PersistentDownloadDir/EMS/hotfix']) {
    assert.ok(fs.existsSync(path.join(p.saved, rel)), rel);
  }
  assert.ok(fs.existsSync(path.join(p.local, 'EpicGamesLauncher', 'Saved', 'webcache', 'Cookies')));
  // Temp: fremde Dateien bleiben
  assert.ok(fs.existsSync(path.join(p.temp, 'UEFI_Update', 'firmware.bin')));
  assert.ok(fs.existsSync(path.join(p.temp, 'Word-Dokument.tmp')));
  assert.ok(!fs.existsSync(path.join(p.temp, 'Fortnite-tmp.bin')));
  assert.ok(!fs.existsSync(path.join(p.temp, 'UECC-Windows-1234')), 'leerer Fortnite-Temp-Ordner entfernt');
  assert.ok(fs.existsSync(p.temp), 'Temp-Ordner selbst bleibt');
});

test('Cache: gesperrte Dateien (EBUSY/EPERM/EACCES) werden übersprungen und gezählt', async () => {
  const p = makeProfile();
  const cats = logic.buildCategories(p.env, p.location).filter((c) => c.id === 'directx');
  const locked = new Set([path.join(p.local, 'D3DSCache', 'a1', 'x.val'), path.join(p.local, 'D3DSCache', 'b2', 'y.val')]);
  const codes = ['EBUSY', 'EACCES'];
  let i = 0;
  const fakeFs = {
    ...require('node:fs/promises'),
    unlink: async (f) => {
      if (locked.has(f)) { const e = new Error('busy'); e.code = codes[i++ % codes.length]; throw e; }
      return require('node:fs/promises').unlink(f);
    },
  };
  const r = await logic.cleanCategories(cats, { savedDir: p.saved, fs: fakeFs });
  assert.equal(r.deleted, 1);
  assert.equal(r.freedBytes, 100);
  assert.equal(r.skipped, 2);
  assert.equal(r.skippedBytes, 500);
  for (const f of locked) assert.ok(fs.existsSync(f));
});

test('Cache: Datei, deren Ordner nach außen zeigt, wird nicht gelöscht (Pfad-Prüfung)', async () => {
  const p = makeProfile();
  const root = path.join(p.local, 'D3DSCache');
  const res = await logic.deleteInside(path.join(p.outside, 'wichtig.bin'), fs.realpathSync(root), { savedDir: p.saved });
  assert.equal(res, 'outside');
  assert.ok(fs.existsSync(path.join(p.outside, 'wichtig.bin')));
  const forbidden = path.join(p.saved, 'Config', 'WindowsClient', 'GameUserSettings.ini');
  assert.equal(await logic.deleteInside(forbidden, fs.realpathSync(p.saved), { savedDir: p.saved }), 'outside');
  assert.ok(fs.existsSync(forbidden));
});

test('Cache: Grenze für die Dateianzahl wird beachtet', async () => {
  const p = makeProfile();
  const r = await logic.collect(path.join(p.local, 'D3DSCache'), { maxFiles: 2 });
  assert.equal(r.count, 2);
  assert.equal(r.truncated, true);
});

// ---------------------------------------------------------------- Texte
test('Cache: Bytes auf Deutsch und Cockpit-Zeile', () => {
  assert.equal(logic.fmtBytesDe(512), '512 B');
  assert.equal(logic.fmtBytesDe(1536), '1,5 KB');
  assert.equal(logic.fmtBytesDe(2.1 * 1024 ** 3), '2,1 GB');
  assert.equal(logic.fmtBytesDe(820 * 1024 ** 2), '820 MB');
  assert.equal(logic.fmtBytesDe(5 * 1024 ** 2), '5 MB');
  assert.equal(logic.summaryText({ bytes: 2.1 * 1024 ** 3 }), '2,1 GB können frei werden');
  assert.equal(logic.summaryText({ bytes: 1000 }), null);
  assert.equal(logic.summaryText(null), null);
});

// ---------------------------------------------------------------- Modul (Handler)
function fakeCtx(p, { running = false, win = true } = {}) {
  const state = {};
  const events = [];
  return {
    env: p.env,
    exec: { IS_WIN: win },
    emit: (n, d) => events.push([n, d]),
    events,
    state,
    core: {
      location: p.location,
      requireLocation: async () => p.location,
      readState: async (n, fb) => (n in state ? JSON.parse(JSON.stringify(state[n])) : fb),
      writeState: async (n, o) => { state[n] = JSON.parse(JSON.stringify(o)); },
      fortniteStatus: async () => ({ running }),
      ensureFortniteClosed: async () => {
        if (running) { const e = new Error('Fortnite läuft noch.'); e.code = 'FORTNITE_RUNNING'; throw e; }
      },
    },
    electron: { shell: { openPath: async () => '' } },
  };
}

test('Cache-Modul: hat id, Handler und summary', () => {
  assert.equal(cacheModule.id, 'cache');
  for (const h of ['scan', 'clean', 'openFolder', 'summary']) assert.equal(typeof cacheModule.handlers[h], 'function', h);
});

test('Cache-Modul: scan speichert die letzte Messung, summary liest sie', async () => {
  const p = makeProfile();
  write(path.join(p.local, 'NVIDIA', 'DXCache', 'big.bin'), 2 * 1024 * 1024);
  const ctx = fakeCtx(p);
  const s = await cacheModule.handlers.scan({}, ctx);
  assert.ok(s.categories.length >= 5);
  assert.equal(s.fortniteRunning, false);
  assert.ok(ctx.state['tool-cache'].lastScan.bytes > 2 * 1024 * 1024);
  const sum = await cacheModule.handlers.summary({}, ctx);
  assert.match(sum.text, /^2(,\d)? MB können frei werden$/);
});

test('Cache-Modul: clean verlangt geschlossenes Fortnite und löscht dann nichts', async () => {
  const p = makeProfile();
  const ctx = fakeCtx(p, { running: true });
  await assert.rejects(cacheModule.handlers.clean({ ids: ['directx'] }, ctx), (e) => e.code === 'FORTNITE_RUNNING');
  assert.ok(fs.existsSync(path.join(p.local, 'D3DSCache', 'a1', 'x.idx')));
});

test('Cache-Modul: clean nimmt nur bekannte ids an – Pfade von außen werden ignoriert', async () => {
  const p = makeProfile();
  const ctx = fakeCtx(p);
  await assert.rejects(cacheModule.handlers.clean({ ids: [] }, ctx), (e) => e.code === 'BAD_ARG');
  await assert.rejects(cacheModule.handlers.clean({ ids: [p.outside, '../..'] }, ctx), (e) => e.code === 'BAD_ARG');
  const r = await cacheModule.handlers.clean({ ids: ['logs', 'crashes'], paths: [p.outside] }, ctx);
  assert.equal(r.freedBytes, 3000);
  assert.ok(fs.existsSync(path.join(p.outside, 'wichtig.bin')));
  assert.ok(fs.existsSync(path.join(p.local, 'D3DSCache', 'a1', 'x.idx')), 'nicht gewählte Bereiche bleiben');
  assert.equal(ctx.state['tool-cache'].history.length, 1);
  assert.ok(r.scan && Array.isArray(r.scan.categories), 'liefert neue Messung mit');
  assert.ok(ctx.events.some(([n]) => n === 'cache.progress'));
});

test('Cache-Modul: außerhalb von Windows freundlich "nicht unterstützt"', async () => {
  const p = makeProfile();
  const ctx = fakeCtx(p, { win: false });
  const s = await cacheModule.handlers.scan({}, ctx);
  assert.equal(s.unsupported, true);
  assert.equal(await cacheModule.handlers.summary({}, ctx), null);
  await assert.rejects(cacheModule.handlers.clean({ ids: ['directx'] }, ctx), (e) => e.code === 'NOT_WINDOWS');
  assert.ok(fs.existsSync(path.join(p.local, 'D3DSCache', 'a1', 'x.idx')));
});

// ---------------------------------------------------------------- Ansicht (lib/cache-select.mjs)
const selPath = path.join(__dirname, '../../src/renderer/js/lib/cache-select.mjs');

test('Cache-Ansicht: Standard-Auswahl lässt leere Bereiche weg, Summen stimmen', async () => {
  const sel = await import(require("node:url").pathToFileURL(selPath).href);
  const cats = [
    { id: 'directx', group: 'shader', bytes: 100, count: 2 },
    { id: 'nvidia', group: 'shader', bytes: 900, count: 5 },
    { id: 'temp', group: 'fortnite', bytes: 0, count: 0 },
    { id: 'logs', group: 'fortnite', bytes: 50, count: 1 },
  ];
  const s = sel.defaultSelection(cats);
  assert.deepEqual([...s].sort(), ['directx', 'logs', 'nvidia']);
  assert.deepEqual(sel.selectedTotals(cats, s), { bytes: 1050, count: 8, n: 3 });
  s.delete('nvidia');
  assert.deepEqual(sel.selectedTotals(cats, s), { bytes: 150, count: 3, n: 2 });
  const g = sel.grouped(cats);
  assert.deepEqual(g.map((x) => [x.id, x.items.length]), [['shader', 2], ['fortnite', 2]]);
});

test('Cache-Ansicht: Auswahl nach neuer Messung – abgewählte bleiben abgewählt, neue werden gewählt', async () => {
  const sel = await import(require("node:url").pathToFileURL(selPath).href);
  const before = [{ id: 'a', bytes: 1 }, { id: 'b', bytes: 1 }];
  const known = new Set(before.map((c) => c.id));
  const prev = new Set(['a']);
  const after = [{ id: 'a', bytes: 1 }, { id: 'b', bytes: 1 }, { id: 'c', bytes: 5 }, { id: 'd', bytes: 0 }];
  assert.deepEqual([...sel.mergeSelection(prev, after, known)].sort(), ['a', 'c']);
  // geleerter Bereich fällt aus der Auswahl
  assert.deepEqual([...sel.mergeSelection(new Set(['a', 'b']), [{ id: 'a', bytes: 0, count: 0 }, { id: 'b', bytes: 3 }], known)], ['b']);
});

test('Cache-Ansicht: Texte für Dateien und Ergebnis', async () => {
  const sel = await import(require("node:url").pathToFileURL(selPath).href);
  const fmt = (n) => logic.fmtBytesDe(n);
  assert.equal(sel.filesText(1), '1 Datei');
  assert.equal(sel.filesText(0), '0 Dateien');
  assert.match(sel.filesText(1843), /^1\.?843 Dateien$/);
  assert.equal(sel.resultText({ deleted: 0, skipped: 0, freedBytes: 0 }, fmt), 'Es war nichts zu löschen.');
  assert.equal(sel.resultText({ deleted: 10, skipped: 0, freedBytes: 2.1 * 1024 ** 3 }, fmt), '2,1 GB frei geworden.');
  assert.equal(sel.resultText({ deleted: 10, skipped: 1, freedBytes: 1024 }, fmt), '1 KB frei geworden, 1 Datei übersprungen (gerade in Benutzung).');
  assert.match(sel.resultText({ deleted: 10, skipped: 3, freedBytes: 1024 }, fmt), /3 Dateien übersprungen \(gerade in Benutzung\)/);
});
