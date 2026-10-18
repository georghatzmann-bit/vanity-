'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logic = require('../../src/main/tools/replays-logic');
const replaysModule = require('../../src/main/modules/tools/replays');

const TICKS_EPOCH = 621355968000000000n;

/** Baut einen synthetischen Replay-Kopf (Unreal LocalFileReplay-Format, little-endian). */
function buildReplay({
  version = 7, customVersions = 2, lengthMs = 1234567, networkVersion = 17, changelist = 41234567,
  name = 'Unsaved Replay', nameMode = 'utf16fixed', isLive = false, whenMs = Date.UTC(2026, 9, 17, 18, 30, 0),
  compressed = true, encrypted = true, keyLen = 32, branch = '++Fortnite+Release-42.20', magic = 0x1ca2e27f, payload = 4096,
} = {}) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
  const fstring = (s, mode) => {
    if (mode === 'utf16fixed') {
      // Fortnite: feste Länge -257 Zeichen UTF-16, mit Leerzeichen aufgefüllt, NUL am Ende
      const padded = (s + ' '.repeat(256)).slice(0, 256) + '\0';
      i32(-257);
      parts.push(Buffer.from(padded, 'utf16le'));
    } else if (mode === 'utf16') {
      i32(-(s.length + 1));
      parts.push(Buffer.from(s + '\0', 'utf16le'));
    } else {
      i32(s.length + 1);
      parts.push(Buffer.from(s + '\0', 'latin1'));
    }
  };
  u32(magic);
  u32(version);
  if (version >= 7) {
    i32(customVersions);
    for (let i = 0; i < customVersions; i++) { parts.push(Buffer.alloc(16, i + 1)); i32(i + 3); }
  }
  i32(lengthMs);
  u32(networkVersion);
  u32(changelist);
  fstring(name, nameMode);
  u32(isLive ? 1 : 0);
  if (version >= 3) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(whenMs) * 10000n + TICKS_EPOCH);
    parts.push(b);
  }
  if (version >= 2) u32(compressed ? 1 : 0);
  if (version >= 6) {
    u32(encrypted ? 1 : 0);
    i32(keyLen);
    parts.push(Buffer.alloc(keyLen, 0xab));
  }
  // Header-Chunk (Typ 0) mit Magic und Branch-Text
  const chunk = [];
  const c32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); chunk.push(b); };
  c32(0x2cf5a13d); c32(networkVersion); c32(123); c32(14); c32(0);
  chunk.push(Buffer.alloc(16, 7));
  chunk.push(Buffer.from([5, 0, 8, 0, 0, 0]));
  c32(changelist);
  if (branch) { const bb = Buffer.from(branch + '\0', 'latin1'); const len = Buffer.alloc(4); len.writeInt32LE(bb.length); chunk.push(len, bb); }
  const chunkBuf = Buffer.concat(chunk);
  u32(0); i32(chunkBuf.length); parts.push(chunkBuf);
  // weitere (Daten-)Chunks – Inhalt egal
  u32(1); i32(payload); parts.push(Buffer.alloc(payload, 0x5a));
  return Buffer.concat(parts);
}

function tmp(prefix = 'helix-replays-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------- Parser
test('Replay-Kopf: Version 7 mit Custom-Versions, fester UTF-16-Name, Zeitstempel, Verschlüsselung', () => {
  const when = Date.UTC(2026, 9, 17, 18, 30, 0);
  const r = logic.parseReplayHeader(buildReplay({ whenMs: when }));
  assert.equal(r.fileVersion, 7);
  assert.equal(r.lengthMs, 1234567);
  assert.equal(r.networkVersion, 17);
  assert.equal(r.changelist, 41234567);
  assert.equal(r.friendlyName, 'Unsaved Replay', 'Leerzeichen und NUL werden abgeschnitten');
  assert.equal(r.isLive, false);
  assert.equal(r.timestampUtcMs, when);
  assert.equal(r.compressed, true);
  assert.equal(r.encrypted, true);
  assert.equal(r.branch, '++Fortnite+Release-42.20');
  assert.equal(r.version, '42.20');
  assert.equal(r.key, undefined, 'Schlüssel wird nie herausgegeben');
});

test('Replay-Kopf: ältere Versionen und ANSI-/UTF-16-Namen', () => {
  const v5 = logic.parseReplayHeader(buildReplay({ version: 5, name: 'Finale Sieg', nameMode: 'ansi', isLive: true }));
  assert.equal(v5.fileVersion, 5);
  assert.equal(v5.friendlyName, 'Finale Sieg');
  assert.equal(v5.isLive, true);
  assert.equal(v5.encrypted, null);
  assert.equal(v5.compressed, true);
  assert.equal(v5.version, '42.20');
  const v6 = logic.parseReplayHeader(buildReplay({ version: 6, name: 'Größter Sieg', nameMode: 'utf16', keyLen: 0, encrypted: false }));
  assert.equal(v6.friendlyName, 'Größter Sieg');
  assert.equal(v6.encrypted, false);
  const v2 = logic.parseReplayHeader(buildReplay({ version: 2, nameMode: 'ansi' }));
  assert.equal(v2.timestampUtcMs, null);
  assert.equal(v2.compressed, true);
});

test('Replay-Kopf: fremde, kaputte oder abgeschnittene Dateien werden sauber abgelehnt', () => {
  assert.throws(() => logic.parseReplayHeader(Buffer.from('hallo welt, das ist kein replay')), (e) => e.code === 'BAD_REPLAY');
  assert.throws(() => logic.parseReplayHeader(buildReplay({ magic: 0x12345678 })), (e) => e.code === 'BAD_REPLAY');
  const full = buildReplay();
  for (const n of [0, 10, 30, 60, 200]) {
    assert.throws(() => logic.parseReplayHeader(full.subarray(0, n)), (e) => e.code === 'BAD_REPLAY', `Länge ${n}`);
  }
  // unsinnige Namenslänge
  const bad = buildReplay({ version: 5, nameMode: 'ansi' });
  bad.writeInt32LE(999999, 4 + 4 + 4 + 4 + 4);
  assert.throws(() => logic.parseReplayHeader(bad), (e) => e.code === 'BAD_REPLAY');
  assert.throws(() => logic.parseReplayHeader(null), (e) => e.code === 'BAD_REPLAY');
});

test('Replay-Kopf: ohne Header-Chunk gibt es keine Versionsangabe (kein Absturz)', () => {
  const r = logic.parseReplayHeader(buildReplay({ branch: null }));
  assert.equal(r.version, null);
  const head = buildReplay();
  const r2 = logic.parseReplayHeader(head.subarray(0, logic.parseReplayHeader(head).firstChunkOffset + 6));
  assert.equal(r2.version, null);
});

test('Replay: Versionen vergleichen', () => {
  assert.equal(logic.compareVersions('42.20', '42.10'), 1);
  assert.equal(logic.compareVersions('41.40', '42.0'), -1);
  assert.equal(logic.compareVersions('42.2', '42.2.0'), 0);
  assert.equal(logic.versionFromBranch('++Fortnite+Release-38.11'), '38.11');
  assert.equal(logic.versionFromBranch(null), null);
});

// ---------------------------------------------------------------- Zeit & Aufnahme
test('Replay: Zeitstempel – UTC oder Ortszeit, je nachdem was zur Datei passt', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  try {
    const realStart = Date.UTC(2026, 9, 17, 18, 0, 0); // 20:00 Uhr in Berlin
    const len = 20 * 60000;
    const mtime = realStart + len;
    // Kopf als UTC gespeichert
    assert.equal(logic.resolveRecordedAt({ timestampUtcMs: realStart, mtimeMs: mtime, lengthMs: len }), realStart);
    // Kopf als Ortszeit gespeichert (20:00 "als UTC" gelesen)
    const wallAsUtc = Date.UTC(2026, 9, 17, 20, 0, 0);
    assert.equal(logic.resolveRecordedAt({ timestampUtcMs: wallAsUtc, mtimeMs: mtime, lengthMs: len }), realStart);
    // ohne Zeitstempel: Dateiname, sonst Änderungszeit minus Dauer
    assert.equal(logic.resolveRecordedAt({ timestampUtcMs: null, mtimeMs: mtime, lengthMs: len, nameMs: 5 }), 5);
    assert.equal(logic.resolveRecordedAt({ timestampUtcMs: null, mtimeMs: mtime, lengthMs: len }), realStart);
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

test('Replay: Zeit aus dem Dateinamen', () => {
  const t = logic.timeFromFileName('UnsavedReplay-2018.10.17-20.22.26.replay');
  const d = new Date(t);
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2018, 9, 17, 20, 22, 26]);
  assert.equal(logic.timeFromFileName('Mein Sieg.replay'), null);
});

test('Replay: "wird gerade aufgenommen" nur bei bIsLive und Änderung vor < 2 Minuten', () => {
  const now = 10_000_000;
  assert.equal(logic.isRecording({ isLive: true, mtimeMs: now - 30_000, now }), true);
  assert.equal(logic.isRecording({ isLive: true, mtimeMs: now - 3 * 60_000, now }), false, 'abgestürzt, nicht mehr in Arbeit');
  assert.equal(logic.isRecording({ isLive: false, mtimeMs: now - 1000, now }), false);
  assert.equal(logic.isRecording({ isLive: false, mtimeMs: now - 1000, now, parsed: false }), true, 'Kopf noch nicht lesbar, frisch');
});

// ---------------------------------------------------------------- Namen & Ordner
test('Replay: Dateinamen werden streng geprüft (kein Pfad, nur .replay)', () => {
  assert.equal(logic.checkReplayFileName('UnsavedReplay-2026.10.17-20.00.00.replay'), 'UnsavedReplay-2026.10.17-20.00.00.replay');
  for (const bad of ['../x.replay', '..\\x.replay', 'C:\\x.replay', '/etc/x.replay', 'a/b.replay', 'x.txt', '', 'x.replay ', 'a:b.replay', null]) {
    assert.throws(() => logic.checkReplayFileName(bad), (e) => e.code === 'BAD_PATH', String(bad));
  }
});

test('Replay: neue Namen werden bereinigt', () => {
  assert.equal(logic.cleanReplayName('  Mein  bester  Sieg  '), 'Mein bester Sieg');
  assert.equal(logic.cleanReplayName('Sieg: 12 Kills / Solo?'), 'Sieg 12 Kills Solo');
  assert.equal(logic.cleanReplayName('Finale.replay'), 'Finale');
  assert.throws(() => logic.cleanReplayName('   '), (e) => e.code === 'BAD_NAME');
  assert.throws(() => logic.cleanReplayName('con'), (e) => e.code === 'BAD_NAME');
  assert.throws(() => logic.cleanReplayName('x'.repeat(81)), (e) => e.code === 'BAD_NAME');
});

test('Replay: Tresor darf nicht im Fortnite-Ordner liegen', () => {
  const base = tmp();
  const saved = path.join(base, 'FortniteGame', 'Saved');
  assert.equal(logic.vaultProblem(path.join(base, 'Documents', 'HELIX Replays'), { savedDir: saved }), null);
  assert.ok(logic.vaultProblem(path.join(saved, 'Demos'), { savedDir: saved }));
  assert.ok(logic.vaultProblem(saved, { savedDir: saved }));
  assert.ok(logic.vaultProblem(path.join(base, 'Epic Games', 'Fortnite'), { savedDir: saved }));
  assert.ok(logic.vaultProblem('relativ', {}));
  assert.ok(logic.vaultProblem(path.parse(base).root, {}));
});

test('Replay: Cockpit-Text', () => {
  assert.equal(logic.summaryText(12), '12 Replays im Tresor');
  assert.equal(logic.summaryText(1), '1 Replay im Tresor');
  assert.equal(logic.summaryText(0), null);
});

// ---------------------------------------------------------------- Modul mit echten Ordnern
function setup({ running = false } = {}) {
  const home = tmp();
  const saved = path.join(home, 'AppData', 'Local', 'FortniteGame', 'Saved');
  const demos = path.join(saved, 'Demos');
  fs.mkdirSync(demos, { recursive: true });
  const docs = path.join(home, 'Documents');
  const old = Date.now() - 3 * 3600 * 1000;
  const a = 'UnsavedReplay-2026.10.17-20.00.00.replay';
  const b = 'UnsavedReplay-2026.10.17-21.00.00.replay';
  const live = 'UnsavedReplay-2026.10.18-12.00.00.replay';
  fs.writeFileSync(path.join(demos, a), buildReplay({ whenMs: old - 7200_000, lengthMs: 1_200_000 }));
  fs.writeFileSync(path.join(demos, b), buildReplay({ whenMs: old - 3600_000, lengthMs: 900_000, branch: '++Fortnite+Release-41.40' }));
  fs.utimesSync(path.join(demos, a), new Date(old), new Date(old));
  fs.utimesSync(path.join(demos, b), new Date(old), new Date(old));
  fs.writeFileSync(path.join(demos, live), buildReplay({ isLive: true, whenMs: Date.now() - 60_000, lengthMs: 30_000 }));
  fs.writeFileSync(path.join(demos, 'notiz.txt'), 'kein replay');
  fs.writeFileSync(path.join(demos, 'kaputt.replay'), 'XXXX');
  fs.utimesSync(path.join(demos, 'kaputt.replay'), new Date(old), new Date(old));
  const state = {};
  const trashed = [];
  const fortnite = { running };
  const ctx = {
    env: { USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') },
    core: {
      location: { found: true, savedDir: saved, configDir: path.join(saved, 'Config') },
      requireLocation: async () => ({ found: true, savedDir: saved, configDir: path.join(saved, 'Config') }),
      readState: async (n, fb) => (n in state ? JSON.parse(JSON.stringify(state[n])) : fb),
      writeState: async (n, o) => { state[n] = JSON.parse(JSON.stringify(o)); },
      ensureFortniteClosed: async () => {
        if (fortnite.running) { const e = new Error('Fortnite läuft noch.'); e.code = 'FORTNITE_RUNNING'; throw e; }
      },
    },
    electron: {
      app: { getPath: (n) => (n === 'documents' ? docs : home) },
      shell: {
        trashItem: async (p) => { trashed.push(p); fs.rmSync(p); },
        openPath: async () => '',
      },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      getWindow: () => null,
    },
  };
  return { home, saved, demos, docs, vault: path.join(docs, 'HELIX Replays'), a, b, live, state, trashed, fortnite, ctx };
}

test('Replay-Modul: hat id und alle Handler', () => {
  assert.equal(replaysModule.id, 'replays');
  for (const h of ['list', 'copyToVault', 'copyAllNew', 'restore', 'rename', 'remove', 'pickVault', 'resetVault', 'openFolder', 'summary']) {
    assert.equal(typeof replaysModule.handlers[h], 'function', h);
  }
});

test('Replay-Modul: Liste zeigt Dauer, Datum, Größe, Version, laufende Aufnahme und kaputte Dateien', async () => {
  const s = setup();
  const r = await replaysModule.handlers.list({}, s.ctx);
  assert.equal(r.vault.dir, s.vault, 'Standard: Dokumente\\HELIX Replays');
  assert.equal(r.vault.isDefault, true);
  assert.equal(r.demos.found, true);
  assert.equal(r.demos.entries.length, 4, 'nur *.replay');
  const by = Object.fromEntries(r.demos.entries.map((e) => [e.file, e]));
  assert.equal(by[s.a].lengthMs, 1_200_000);
  assert.equal(by[s.a].version, '42.20');
  assert.equal(by[s.b].version, '41.40');
  assert.ok(by[s.a].size > 4096);
  assert.equal(by[s.live].recording, true);
  assert.equal(by['kaputt.replay'].ok, false);
  assert.ok(by['kaputt.replay'].error);
  assert.equal(r.newestVersion, '42.20');
  assert.equal(r.vault.entries.length, 0);
});

test('Replay-Modul: in den Tresor kopieren behält das Original und erkennt doppelte Kopien', async () => {
  const s = setup();
  const r = await replaysModule.handlers.copyToVault({ file: s.a }, s.ctx);
  assert.equal(r.already, false);
  assert.ok(fs.existsSync(path.join(s.demos, s.a)), 'Original bleibt in Fortnite');
  assert.ok(fs.existsSync(path.join(s.vault, s.a)));
  assert.deepEqual(fs.readFileSync(path.join(s.vault, s.a)), fs.readFileSync(path.join(s.demos, s.a)));
  assert.equal(Math.round(fs.statSync(path.join(s.vault, s.a)).mtimeMs / 1000), Math.round(fs.statSync(path.join(s.demos, s.a)).mtimeMs / 1000), 'Datum bleibt');
  const again = await replaysModule.handlers.copyToVault({ file: s.a }, s.ctx);
  assert.equal(again.already, true);
  assert.equal(fs.readdirSync(s.vault).length, 1);
  const list = await replaysModule.handlers.list({}, s.ctx);
  assert.equal(list.demos.entries.find((e) => e.file === s.a).inVault, true);
  assert.equal(list.vault.entries[0].inDemos, true);
});

test('Replay-Modul: laufende Aufnahmen werden nicht kopiert', async () => {
  const s = setup();
  await assert.rejects(replaysModule.handlers.copyToVault({ file: s.live }, s.ctx), (e) => e.code === 'RECORDING');
  const all = await replaysModule.handlers.copyAllNew({}, s.ctx);
  assert.equal(all.recording, 1);
  assert.equal(all.copied, 2, 'nur die zwei lesbaren, fertigen Replays');
  assert.equal(all.unreadable, 1, 'kaputte Datei wird nur einzeln auf Wunsch gesichert');
  assert.ok(!fs.existsSync(path.join(s.vault, s.live)));
  assert.ok(!fs.existsSync(path.join(s.vault, 'kaputt.replay')));
  const again = await replaysModule.handlers.copyAllNew({}, s.ctx);
  assert.equal(again.copied, 0);
  assert.equal(again.already, 2);
});

test('Replay-Modul: Pfad-Tricks werden abgelehnt', async () => {
  const s = setup();
  for (const file of ['../../../etc/passwd', '..\\Config\\x.replay', path.join(s.demos, s.a)]) {
    await assert.rejects(replaysModule.handlers.copyToVault({ file }, s.ctx), (e) => e.code === 'BAD_PATH', file);
    await assert.rejects(replaysModule.handlers.remove({ file, where: 'vault' }, s.ctx), (e) => e.code === 'BAD_PATH', file);
  }
  assert.equal(s.trashed.length, 0);
});

test('Replay-Modul: umbenennen (nur im Tresor) und doppelte Namen', async () => {
  const s = setup();
  await replaysModule.handlers.copyToVault({ file: s.a }, s.ctx);
  await replaysModule.handlers.copyToVault({ file: s.b }, s.ctx);
  const r = await replaysModule.handlers.rename({ file: s.a, name: 'Mein bester Sieg' }, s.ctx);
  assert.equal(r.file, 'Mein bester Sieg.replay');
  assert.ok(fs.existsSync(path.join(s.vault, 'Mein bester Sieg.replay')));
  assert.ok(fs.existsSync(path.join(s.demos, s.a)), 'Fortnite-Datei bleibt unverändert');
  await assert.rejects(replaysModule.handlers.rename({ file: s.b, name: 'Mein bester Sieg' }, s.ctx), (e) => e.code === 'NAME_TAKEN');
  // umbenannte Kopie wird weiter als "schon im Tresor" erkannt
  const list = await replaysModule.handlers.list({}, s.ctx);
  assert.equal(list.demos.entries.find((e) => e.file === s.a).inVault, true);
});

test('Replay-Modul: zurück in Fortnite nur bei geschlossenem Fortnite', async () => {
  const s = setup();
  await replaysModule.handlers.copyToVault({ file: s.a }, s.ctx);
  await replaysModule.handlers.rename({ file: s.a, name: 'Sieg' }, s.ctx);
  fs.rmSync(path.join(s.demos, s.a)); // Fortnite hat das Original gelöscht
  s.fortnite.running = true;
  await assert.rejects(replaysModule.handlers.restore({ file: 'Sieg.replay' }, s.ctx), (e) => e.code === 'FORTNITE_RUNNING');
  assert.ok(!fs.existsSync(path.join(s.demos, 'Sieg.replay')));
  s.fortnite.running = false;
  const r = await replaysModule.handlers.restore({ file: 'Sieg.replay' }, s.ctx);
  assert.equal(r.already, false);
  assert.ok(fs.existsSync(path.join(s.demos, 'Sieg.replay')));
  assert.ok(fs.existsSync(path.join(s.vault, 'Sieg.replay')), 'Tresor-Kopie bleibt');
  const again = await replaysModule.handlers.restore({ file: 'Sieg.replay' }, s.ctx);
  assert.equal(again.already, true);
});

test('Replay-Modul: löschen geht in den Papierkorb, aus Fortnite nur bei geschlossenem Spiel', async () => {
  const s = setup();
  await replaysModule.handlers.copyToVault({ file: s.a }, s.ctx);
  const r = await replaysModule.handlers.remove({ file: s.a, where: 'vault' }, s.ctx);
  assert.equal(r.trashed, true);
  assert.equal(s.trashed[0], path.join(s.vault, s.a));
  s.fortnite.running = true;
  await assert.rejects(replaysModule.handlers.remove({ file: s.b, where: 'demos' }, s.ctx), (e) => e.code === 'FORTNITE_RUNNING');
  assert.ok(fs.existsSync(path.join(s.demos, s.b)));
  s.fortnite.running = false;
  await assert.rejects(replaysModule.handlers.remove({ file: s.live, where: 'demos' }, s.ctx), (e) => e.code === 'RECORDING');
  await replaysModule.handlers.remove({ file: s.b, where: 'demos' }, s.ctx);
  assert.equal(s.trashed[1], path.join(s.demos, s.b));
  // Papierkorb schlägt fehl -> klare Meldung, Datei bleibt
  s.ctx.electron.shell.trashItem = async () => { throw new Error('nope'); };
  await assert.rejects(replaysModule.handlers.remove({ file: s.a, where: 'demos' }, s.ctx), (e) => e.code === 'TRASH_FAILED');
  assert.ok(fs.existsSync(path.join(s.demos, s.a)));
});

test('Replay-Modul: eigener Tresor-Ordner wird gespeichert, Fortnite-Ordner abgelehnt', async () => {
  const s = setup();
  const own = path.join(s.home, 'Eigene Replays');
  s.ctx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [own] });
  const r = await replaysModule.handlers.pickVault({}, s.ctx);
  assert.equal(r.dir, own);
  assert.equal(s.state['tool-replays'].vaultDir, own);
  assert.ok(fs.existsSync(own));
  const list = await replaysModule.handlers.list({}, s.ctx);
  assert.equal(list.vault.dir, own);
  assert.equal(list.vault.isDefault, false);
  s.ctx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [s.demos] });
  await assert.rejects(replaysModule.handlers.pickVault({}, s.ctx), (e) => e.code === 'BAD_VAULT');
  assert.equal(s.state['tool-replays'].vaultDir, own, 'bleibt beim alten Ordner');
  await replaysModule.handlers.resetVault({}, s.ctx);
  assert.equal(s.state['tool-replays'].vaultDir, null);
});

test('Replay-Modul: summary zählt die Replays im Tresor', async () => {
  const s = setup();
  assert.equal(await replaysModule.handlers.summary({}, s.ctx), null);
  await replaysModule.handlers.copyAllNew({}, s.ctx);
  assert.deepEqual(await replaysModule.handlers.summary({}, s.ctx), { text: '2 Replays im Tresor' });
});

test('Replay-Modul: ohne Fortnite-Ordner gibt es eine leere Liste statt eines Fehlers', async () => {
  const s = setup();
  s.ctx.core.requireLocation = async () => { const e = new Error('nicht gefunden'); e.code = 'NO_FORTNITE'; throw e; };
  const r = await replaysModule.handlers.list({}, s.ctx);
  assert.equal(r.demos.found, false);
  assert.equal(r.demos.dir, null);
  await assert.rejects(replaysModule.handlers.copyToVault({ file: s.a }, s.ctx), (e) => e.code === 'NO_FORTNITE');
});

test('Replay-Modul: Verknüpfungen im Replay-Ordner werden nicht verfolgt', async (t) => {
  const s = setup();
  const outside = tmp('helix-out-');
  fs.writeFileSync(path.join(outside, 'fremd.replay'), buildReplay());
  try { fs.symlinkSync(path.join(outside, 'fremd.replay'), path.join(s.demos, 'link.replay')); } catch (e) { t.skip(e.code); return; }
  const r = await replaysModule.handlers.list({}, s.ctx);
  assert.ok(!r.demos.entries.some((e) => e.file === 'link.replay'));
  await assert.rejects(replaysModule.handlers.copyToVault({ file: 'link.replay' }, s.ctx), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(replaysModule.handlers.remove({ file: 'link.replay', where: 'demos' }, s.ctx), (e) => e.code === 'NOT_FOUND');
  assert.ok(fs.existsSync(path.join(outside, 'fremd.replay')));
});

test('Replay-Modul: liest höchstens die ersten 64 KB jeder Datei', async () => {
  const s = setup();
  const big = 'UnsavedReplay-2026.10.16-10.00.00.replay';
  fs.writeFileSync(path.join(s.demos, big), buildReplay({ payload: 3 * 1024 * 1024 }));
  const fsp = require('node:fs/promises');
  const reads = [];
  const fakeFs = {
    ...fsp,
    open: async (p, m) => {
      const fh = await fsp.open(p, m);
      const orig = fh.read.bind(fh);
      fh.read = async (buf, off, len, pos) => { reads.push(len); return orig(buf, off, len, pos); };
      return fh;
    },
  };
  const e = await logic.readReplayEntry(s.demos, big, { fs: fakeFs });
  assert.equal(e.ok, true);
  assert.ok(reads.every((n) => n <= 64 * 1024), `gelesen: ${reads}`);
});

// ---------------------------------------------------------------- Ansicht (lib/replays-format.mjs)
const fmtPath = path.join(__dirname, '../../src/renderer/js/lib/replays-format.mjs');

test('Replay-Ansicht: Dauer, Namen und Titel', async () => {
  const f = await import(fmtPath);
  assert.equal(f.fmtLength(0), '0:00');
  assert.equal(f.fmtLength(65_000), '1:05');
  assert.equal(f.fmtLength(23 * 60_000 + 41_000), '23:41');
  assert.equal(f.fmtLength(3_725_000), '1:02:05');
  assert.equal(f.displayName({ friendlyName: 'Unsaved Replay' }, 'demos'), 'Ungespeichertes Replay');
  assert.equal(f.displayName({ friendlyName: 'Finale' }, 'demos'), 'Finale');
  assert.equal(f.displayName({ file: 'Mein Sieg.replay' }, 'vault'), 'Mein Sieg');
  assert.equal(f.displayName({ file: 'UnsavedReplay-2026.10.17-20.00.00.replay' }, 'vault'), 'Ungespeichertes Replay');
  assert.equal(f.shortTitle({ friendlyName: 'Finale' }, 'demos', () => 'x'), '„Finale“');
  assert.equal(f.shortTitle({ friendlyName: 'Unsaved Replay', recordedAt: 5 }, 'demos', () => '17.10.2026, 20:00'), 'Replay vom 17.10.2026, 20:00');
  assert.equal(f.countText(1), '1 Replay');
  assert.equal(f.countText(12), '12 Replays');
});

test('Replay-Ansicht: Statusplaketten haben immer Text', async () => {
  const f = await import(fmtPath);
  const b = (e, w = 'demos', v = '42.20') => f.statusBadges({ ok: true, ...e }, w, v).map((x) => x.text);
  assert.deepEqual(b({ recording: true, version: '42.20' }), ['wird gerade aufgenommen']);
  assert.deepEqual(b({ ok: false, error: 'kaputt' }), ['nicht lesbar']);
  assert.deepEqual(b({ incomplete: true, inVault: true, version: '42.20' }), ['unvollständig', 'im Tresor']);
  assert.deepEqual(b({ version: '41.40' }), ['ältere Version']);
  assert.deepEqual(b({ inDemos: true, version: '42.20' }, 'vault'), ['auch in Fortnite']);
  for (const x of f.statusBadges({ ok: true, recording: true, inVault: true, version: '1.0' }, 'demos', '42.20')) {
    assert.ok(x.text && x.title, 'Text und Erklärung');
  }
});

test('Replay-Ansicht: offene Replays zählen und Ergebnis von "Alle sichern"', async () => {
  const f = await import(fmtPath);
  assert.equal(f.unsavedCount([{ ok: true }, { ok: true, inVault: true }, { ok: true, recording: true }, { ok: false }]), 1);
  assert.equal(f.copyAllText({ copied: 3, already: 2, recording: 1, failed: 0, unreadable: 0 }), '3 Replays gesichert, 1 läuft noch.');
  assert.equal(f.copyAllText({ copied: 0, already: 5, recording: 0, failed: 0, unreadable: 1 }), 'Nichts Neues zu sichern, 1 nicht lesbar.');
  assert.equal(f.copyAllText({ copied: 1, failed: 2 }), '1 Replay gesichert, 2 fehlgeschlagen.');
});
