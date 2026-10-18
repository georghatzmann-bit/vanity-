'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const logic = require('../../src/main/tools/wincheck-logic');
const mod = require('../../src/main/modules/tools/wincheck');
const registry = require('../../src/main/sys/registry');
const { HelixError } = require('../../src/main/sys/exec');

const GB = 1024 ** 3;
const HP = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const BAL = '381b4222-f694-41f0-9685-ff5bb260df2e';
const SAVER = 'a1841308-3541-4fab-bc81-f71556f20b4a';

const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';
function cp850(text) {
  return Buffer.from([...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    const i = CP850.indexOf(ch);
    if (i < 0) throw new Error(`nicht in CP850: ${ch}`);
    return 0x80 + i;
  }));
}

const PC_DE_ACTIVE = (guid, name) => `GUID des Energieschemas: ${guid}  (${name})\r\n`;
const PC_DE_LIST = (active) => [
  '',
  'Vorhandene Energieschemas (* Aktiv)',
  '-----------------------------------',
  `GUID des Energieschemas: ${BAL}  (Ausbalanciert)${active === BAL ? ' *' : ''}`,
  `GUID des Energieschemas: ${HP}  (Höchstleistung)${active === HP ? ' *' : ''}`,
  `GUID des Energieschemas: ${SAVER}  (Energiesparmodus)${active === SAVER ? ' *' : ''}`,
  '',
].join('\r\n');
const PC_EN_LIST = [
  'Existing Power Schemes (* Active)',
  '-----------------------------------',
  `Power Scheme GUID: ${BAL}  (Balanced) *`,
  `Power Scheme GUID: ${HP}  (High performance)`,
  'Power Scheme GUID: 3af9b8d9-7c97-431d-ad78-34a8bfea439f  (Lenovo Balanced)',
].join('\r\n');

// ---------------------------------------------------------------- powercfg
test('powercfg: aktiver Plan auf Deutsch und Englisch, nur die GUID zählt', () => {
  assert.deepEqual(logic.parsePowercfgActive(PC_DE_ACTIVE(BAL, 'Ausbalanciert')), { guid: BAL, name: 'Ausbalanciert' });
  assert.deepEqual(logic.parsePowercfgActive(`Power Scheme GUID: ${HP.toUpperCase()}  (High performance)`), { guid: HP, name: 'High performance' });
  assert.equal(logic.parsePowercfgActive('Zugriff verweigert.'), null);
  assert.equal(logic.parsePowercfgActive(''), null);
});

test('powercfg: Liste mit Markierung des aktiven Plans', () => {
  const de = logic.parsePowercfgList(PC_DE_LIST(SAVER));
  assert.deepEqual(de.map((p) => [p.guid, p.active]), [[BAL, false], [HP, false], [SAVER, true]]);
  assert.equal(de[1].name, 'Höchstleistung');
  const en = logic.parsePowercfgList(PC_EN_LIST);
  assert.equal(en.length, 3);
  assert.equal(en[0].active, true);
  assert.equal(en[2].name, 'Lenovo Balanced');
});

test('powercfg: Konsolen-Codepage 850 und 1252 werden richtig gelesen', () => {
  const text = PC_DE_ACTIVE(HP, 'Höchstleistung');
  assert.equal(logic.decodeConsole(cp850(text)), text);
  assert.equal(logic.decodeConsole(Buffer.from(text, 'latin1')), text);
  assert.equal(logic.decodeConsole(Buffer.from(text, 'utf8')), text);
  assert.equal(logic.decodeConsole(text), text);
  assert.equal(logic.decodeConsole(Buffer.from([0x81, 0x84, 0x94, 0xe1, 0x8e, 0x99, 0x9a])), 'üäößÄÖÜ');
});

test('Energieplan: bekannte GUIDs, Ultimative-Kopie über den Namen, sonst eigener Plan', () => {
  assert.equal(logic.planInfo(SAVER).kind, 'saver');
  assert.equal(logic.planInfo(HP, 'High performance').name, 'Höchstleistung');
  assert.equal(logic.planInfo('11111111-2222-3333-4444-555555555555', 'Ultimative Leistung').kind, 'ultimate');
  assert.equal(logic.planInfo('11111111-2222-3333-4444-555555555555', 'Lenovo Balanced').kind, 'custom');
});

// ---------------------------------------------------------------- Bewertung
const byId = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
const val = (type, value) => ({ type, value });
const NT_11 = { CurrentBuildNumber: val('REG_SZ', '26100'), DisplayVersion: val('REG_SZ', '24H2'), EditionID: val('REG_SZ', 'Professional'), UBR: val('REG_DWORD', 2033) };

test('Bewertung: fehlende Werte = Windows-Standard (Spielmodus an, Aufnahme bereit)', () => {
  const items = byId(logic.evaluate({ release: '10.0.26100' }));
  assert.equal(items.gamemode.status, 'good');
  assert.equal(items.gamedvr.status, 'hint');
  assert.equal(items.gamedvr.value, 'Bereit, nimmt nicht auf');
  assert.equal(items.hags.status, 'hint');
  assert.equal(items.hags.value, 'Nicht festgelegt');
  assert.equal(items.hags.fix, null, 'GPU-Planung (HKLM) wird nie selbst geändert');
  assert.equal(items.mouse.status, 'hint');
  assert.equal(items.power.value, 'Unbekannt');
  assert.equal(items.windows.status, 'good');
  assert.equal(items.notifications.status, 'tip');
});

test('Bewertung: Spielmodus aus und Daueraufnahme an -> ändern empfohlen', () => {
  const items = byId(logic.evaluate({
    gameBar: { AutoGameModeEnabled: val('REG_DWORD', 0) },
    gameDvr: { AppCaptureEnabled: val('REG_DWORD', 1), HistoricalCaptureEnabled: val('REG_DWORD', 1) },
    gameConfig: { GameDVR_Enabled: val('REG_DWORD', 1) },
    graphics: { HwSchMode: val('REG_DWORD', 2) },
    mouse: { MouseSpeed: val('REG_SZ', '0') },
    nt: NT_11,
  }));
  assert.equal(items.gamemode.status, 'change');
  assert.deepEqual(items.gamemode.fix, { label: 'Einschalten', safe: true });
  assert.equal(items.gamedvr.status, 'change');
  assert.match(items.gamedvr.fix.note, /Game Bar/);
  assert.equal(items.hags.status, 'good');
  assert.equal(items.mouse.status, 'good');
  assert.equal(items.windows.value, 'Windows 11 Pro · 24H2 · Build 26100.2033');
  // alles aus -> gut
  const off = byId(logic.evaluate({ gameDvr: { AppCaptureEnabled: val('REG_DWORD', 0), HistoricalCaptureEnabled: val('REG_DWORD', 0) }, gameConfig: { GameDVR_Enabled: val('REG_DWORD', 0) } }));
  assert.equal(off.gamedvr.status, 'good');
});

test('Bewertung: Energieplan nach GUID, Höchstleistung nur anbieten, wenn vorhanden', () => {
  const list = logic.parsePowercfgList(PC_DE_LIST(SAVER));
  const saver = logic.evaluate({ power: { active: { guid: SAVER, name: 'Energiesparmodus' }, list }, battery: 1 }).find((i) => i.id === 'power');
  assert.equal(saver.status, 'change');
  assert.equal(saver.fix.safe, false, 'nicht Teil von "Alles Empfohlene"');
  assert.match(saver.fix.confirm, /Akku/);
  const bal = logic.evaluate({ power: { active: { guid: BAL, name: 'x' }, list } }).find((i) => i.id === 'power');
  assert.equal(bal.status, 'hint');
  assert.equal(bal.value, 'Ausbalanciert', 'deutscher Name aus der GUID, nicht aus der Ausgabe');
  const high = logic.evaluate({ power: { active: { guid: HP }, list } }).find((i) => i.id === 'power');
  assert.equal(high.status, 'good');
  assert.equal(high.fix, null);
  const laptop = logic.evaluate({ power: { active: { guid: BAL }, list: [{ guid: BAL, active: true }] } }).find((i) => i.id === 'power');
  assert.equal(laptop.fix, null);
  assert.match(laptop.note, /Beste Leistung/);
  const custom = logic.evaluate({ power: { active: { guid: '3af9b8d9-7c97-431d-ad78-34a8bfea439f', name: 'Lenovo Balanced' }, list: logic.parsePowercfgList(PC_EN_LIST) } }).find((i) => i.id === 'power');
  assert.equal(custom.status, 'hint');
  assert.equal(custom.value, 'Lenovo Balanced');
});

test('Bewertung: freier Speicher und Windows 10', () => {
  const items = logic.evaluate({
    nt: { CurrentBuildNumber: val('REG_SZ', '19045'), DisplayVersion: val('REG_SZ', '22H2'), EditionID: val('REG_SZ', 'Core') },
    disks: [
      { drive: 'C:', windows: true, fortnite: false, free: 9 * GB, total: 476 * GB },
      { drive: 'D:', windows: false, fortnite: true, free: 30 * GB, total: 931 * GB },
    ],
  });
  const m = byId(items);
  assert.equal(m['disk-c'].status, 'change');
  assert.equal(m['disk-c'].title, 'Freier Speicher (C:, Windows)');
  assert.equal(m['disk-c'].value, '9 GB frei von 476 GB');
  assert.equal(m['disk-d'].status, 'hint');
  assert.equal(m['disk-d'].title, 'Freier Speicher (D:, Fortnite)');
  assert.equal(m.windows.status, 'hint');
  assert.match(m.windows.value, /^Windows 10 Home · 22H2/);
  assert.equal(m.notifications.title, 'Fokus-Assistent beim Spielen');
  assert.equal(m.notifications.links[0].uri, 'ms-settings:quiethours');
  assert.equal(m.visual.links[0].uri, 'ms-settings:easeofaccess-display');
  const good = logic.evaluate({ disks: [{ drive: 'C:', windows: true, fortnite: true, free: 200 * GB, total: 1000 * GB }] }).find((i) => i.id === 'disk-c');
  assert.equal(good.status, 'good');
  assert.equal(good.title, 'Freier Speicher (C:, Windows und Fortnite)');
});

test('Zusammenfassung: Text fürs Cockpit', () => {
  assert.equal(logic.summaryText(0), 'Alles bestens');
  assert.equal(logic.summaryText(1), '1 Empfehlung offen');
  assert.equal(logic.summaryText(2), '2 Empfehlungen offen');
  const s = logic.summarize([{ status: 'change' }, { status: 'change' }, { status: 'good' }, { status: 'tip' }]);
  assert.equal(s.open, 2);
  assert.equal(s.text, '2 Empfehlungen offen');
});

test('Jeder Punkt hat Titel, Status, Erklärung und erlaubte Links', () => {
  const items = logic.evaluate({
    gameBar: { AutoGameModeEnabled: val('REG_DWORD', 0) }, nt: NT_11,
    power: { active: { guid: SAVER }, list: logic.parsePowercfgList(PC_DE_LIST(SAVER)) },
    disks: [{ drive: 'C:', windows: true, fortnite: true, free: 5 * GB, total: 100 * GB }],
  });
  const groups = new Set(logic.GROUPS.map((g) => g.id));
  for (const i of items) {
    assert.ok(i.title && i.text, i.id);
    assert.ok(['good', 'hint', 'change', 'tip'].includes(i.status), i.id);
    assert.ok(groups.has(i.group), i.id);
    for (const l of i.links) {
      if (l.kind === 'settings') assert.match(l.uri, /^ms-settings:[a-z0-9-]+$/i, `${i.id}: ${l.uri}`); // wie app.openWindowsSettings
      else assert.ok(['maus', 'cache'].includes(l.id), l.id);
    }
  }
  // "Alles Empfohlene" enthält nur die HKCU-Punkte, nicht den Energieplan
  assert.deepEqual(logic.safeFixIds(items), ['gamemode']);
});

// ---------------------------------------------------------------- Rückgängig
test('Fix-Werte: nur HKCU, alte Werte gemerkt, fehlende Werte -> Windows-Standard', () => {
  const raw = {
    gameBar: { AutoGameModeEnabled: val('REG_DWORD', 0), AllowAutoGameMode: val('REG_DWORD', 0) },
    gameDvr: { HistoricalCaptureEnabled: val('REG_DWORD', 1) }, // AppCaptureEnabled fehlt
    gameConfig: { GameDVR_Enabled: val('REG_DWORD', 1) },
  };
  const gm = logic.fixWrites('gamemode', raw);
  assert.deepEqual(gm.map((w) => [w.name, w.value]), [['AutoGameModeEnabled', 1], ['AllowAutoGameMode', 1]]);
  const dvr = logic.fixWrites('gamedvr', raw);
  assert.deepEqual(dvr.map((w) => [w.name, w.value]), [['HistoricalCaptureEnabled', 0], ['AppCaptureEnabled', 0], ['GameDVR_Enabled', 0]]);
  for (const w of [...gm, ...dvr]) assert.ok(logic.isHkcu(w.key), w.key);
  const undo = logic.buildUndo(dvr, raw);
  assert.deepEqual(undo.map((u) => [u.name, u.existed, u.value]), [['HistoricalCaptureEnabled', true, 1], ['AppCaptureEnabled', false, null], ['GameDVR_Enabled', true, 1]]);
  assert.deepEqual(logic.undoWrites(undo).map((w) => [w.name, w.value]), [['HistoricalCaptureEnabled', 1], ['AppCaptureEnabled', 1], ['GameDVR_Enabled', 1]]);
  // nichts zu tun
  assert.deepEqual(logic.fixWrites('gamemode', {}), []);
  assert.deepEqual(logic.fixWrites('hags', raw), [], 'HKLM wird nie geschrieben');
  // manipulierte Rückgängig-Daten: HKLM oder fremde Namen werden ignoriert
  assert.deepEqual(logic.undoWrites([{ key: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', name: 'HwSchMode', existed: true, type: 'REG_DWORD', value: 2 }]), []);
  assert.deepEqual(logic.undoWrites([{ key: 'HKCU\\Software\\X', name: 'Evil', existed: true, type: 'REG_SZ', value: 'x' }]), []);
});

test('Epic-Installationsliste: Fortnite-Laufwerk', () => {
  const dat = JSON.stringify({ InstallationList: [
    { InstallLocation: 'C:\\Program Files\\Epic Games\\RocketLeague', AppName: 'Sugar' },
    { InstallLocation: 'D:\\Spiele\\Epic Games\\Fortnite', AppName: 'Fortnite', AppVersion: '++Fortnite+Release-38.10' },
  ] });
  assert.equal(logic.parseLauncherInstalled(dat), 'D:\\Spiele\\Epic Games\\Fortnite');
  assert.equal(logic.parseLauncherInstalled('\uFEFF' + dat), 'D:\\Spiele\\Epic Games\\Fortnite');
  assert.equal(logic.parseLauncherInstalled('kaputt'), null);
  assert.equal(logic.driveOf('d:\\x'), 'D:');
  assert.equal(logic.driveOf('/home/x'), null);
});

// ---------------------------------------------------------------- Ganzer Ablauf mit nachgemachtem Windows
function fakeWindows({ active = BAL, reg = {}, setactiveFails = false } = {}) {
  const calls = [];
  const keys = {};
  const norm = (k) => k.replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\').toLowerCase();
  for (const [k, v] of Object.entries(reg)) keys[norm(k)] = { full: k, values: { ...v } };
  let plan = active;
  let listFails = false;
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'reg.exe' && args[0] === 'query') {
      const k = keys[norm(args[1])];
      if (!k) throw new HelixError('EXEC_FAILED', 'reg.exe ist fehlgeschlagen (Code 1).');
      const lines = Object.entries(k.values).map(([n, x]) => `    ${n}    ${x.type}    ${x.type === 'REG_DWORD' ? '0x' + Number(x.value).toString(16) : x.value}`);
      return `\r\n${args[1]}\r\n${lines.join('\r\n')}\r\n\r\n`;
    }
    if (file === 'reg.exe' && args[0] === 'add') {
      const [, key, , name, , type, , data] = args;
      const k = (keys[norm(key)] ||= { full: key, values: {} });
      k.values[name] = { type, value: type === 'REG_DWORD' ? Number(data) : data };
      return 'Der Vorgang wurde erfolgreich beendet.\r\n';
    }
    if (file === 'powercfg.exe') {
      if (args[0] === '/getactivescheme') return cp850(PC_DE_ACTIVE(plan, plan === HP ? 'Höchstleistung' : plan === SAVER ? 'Energiesparmodus' : 'Ausbalanciert'));
      if (args[0] === '/list') {
        if (listFails) throw new HelixError('EXEC_TIMEOUT', 'powercfg.exe hat zu lange gebraucht.');
        return cp850(PC_DE_LIST(plan));
      }
      if (args[0] === '/setactive') {
        if (setactiveFails) throw new HelixError('EXEC_FAILED', 'powercfg.exe ist fehlgeschlagen (Code 1).');
        plan = args[1];
        return '';
      }
    }
    throw new Error(`unerwarteter Aufruf ${file} ${args.join(' ')}`);
  };
  const store = {};
  const ctx = {
    env: { SystemDrive: 'C:', ProgramData: 'C:\\ProgramData' },
    exec: { IS_WIN: true, run: exec, powershell: async () => ({ battery: 0 }) },
    registry: {
      readKey: (k) => registry.readKey(k, exec),
      writeValue: (k, n, t, v) => registry.writeValue(k, n, t, v, exec),
    },
    core: {
      readState: async (n, fb) => (n in store ? JSON.parse(JSON.stringify(store[n])) : fb),
      writeState: async (n, o) => { store[n] = JSON.parse(JSON.stringify(o)); },
    },
    log: () => {},
  };
  return { ctx, calls, keys, store, plan: () => plan, setListFails: (v) => { listFails = !!v; } };
}

const DEPS = {
  release: '10.0.26100',
  statfs: async (root) => (root === 'C:\\' ? { bsize: 4096, blocks: (476 * GB) / 4096, bavail: (120 * GB) / 4096 } : { bsize: 4096, blocks: (931 * GB) / 4096, bavail: (12 * GB) / 4096 }),
  readFile: async () => JSON.stringify({ InstallationList: [{ InstallLocation: 'D:\\Epic Games\\Fortnite', AppName: 'Fortnite' }] }),
};

const START_REG = {
  'HKCU\\Software\\Microsoft\\GameBar': { AutoGameModeEnabled: { type: 'REG_DWORD', value: 0 } },
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR': { AppCaptureEnabled: { type: 'REG_DWORD', value: 1 }, HistoricalCaptureEnabled: { type: 'REG_DWORD', value: 1 } },
  'HKCU\\System\\GameConfigStore': { GameDVR_Enabled: { type: 'REG_DWORD', value: 1 } },
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers': { HwSchMode: { type: 'REG_DWORD', value: 1 } },
  'HKCU\\Control Panel\\Mouse': { MouseSpeed: { type: 'REG_SZ', value: '1' }, MouseThreshold1: { type: 'REG_SZ', value: '6' } },
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion': { CurrentBuildNumber: { type: 'REG_SZ', value: '26100' }, DisplayVersion: { type: 'REG_SZ', value: '24H2' }, EditionID: { type: 'REG_SZ', value: 'Core' } },
};

test('Ablauf: prüfen, alles Empfohlene anwenden, rückgängig machen', async () => {
  mod._test.setDeps(DEPS);
  mod._test.resetLock();
  const w = fakeWindows({ active: BAL, reg: START_REG });
  const r1 = await mod.handlers.check({}, w.ctx);
  const m1 = byId(r1.items);
  assert.equal(r1.summary.open, 3, 'Spielmodus, Daueraufnahme, Speicher D:');
  assert.equal(r1.summary.text, '3 Empfehlungen offen');
  assert.deepEqual(r1.safeFixes, ['gamemode', 'gamedvr']);
  assert.equal(m1.power.value, 'Ausbalanciert');
  assert.equal(m1.hags.value, 'Aus');
  assert.equal(m1['disk-d'].status, 'change');
  assert.equal(m1['disk-c'].status, 'good');
  assert.equal(m1.windows.value, 'Windows 11 Home · 24H2 · Build 26100');
  assert.equal(r1.groups.length, 3);

  const r2 = await mod.handlers.fixAll({}, w.ctx);
  assert.deepEqual(r2.applied, ['gamemode', 'gamedvr']);
  assert.equal(r2.ok, true);
  const adds = w.calls.filter((c) => c[0] === 'reg.exe' && c[1] === 'add');
  assert.equal(adds.length, 4);
  for (const c of adds) assert.match(c[2], /^HKCU\\/, 'nur HKCU wird geschrieben');
  const m2 = byId(r2.result.items);
  assert.equal(m2.gamemode.status, 'good');
  assert.equal(m2.gamedvr.status, 'good');
  assert.ok(m2.gamemode.undo, 'Rückgängig angeboten');
  assert.equal(r2.result.summary.text, '1 Empfehlung offen');
  assert.equal(w.store['tool-wincheck'].undo.gamedvr.values.length, 3);

  const r3 = await mod.handlers.undo({ id: 'gamedvr' }, w.ctx);
  assert.equal(r3.message, 'Die Aufnahme-Einstellungen sind wieder wie vorher.');
  assert.equal(byId(r3.result.items).gamedvr.status, 'change');
  assert.equal(byId(r3.result.items).gamedvr.undo, undefined);
  assert.equal(w.keys['hkey_current_user\\software\\microsoft\\windows\\currentversion\\gamedvr'].values.HistoricalCaptureEnabled.value, 1);
  assert.equal(w.store['tool-wincheck'].undo.gamedvr, undefined);
  assert.ok(w.store['tool-wincheck'].undo.gamemode, 'anderer Punkt bleibt rückgängig machbar');

  // Cockpit-Zeile aus dem letzten Check
  assert.deepEqual(await mod.handlers.summary({}, w.ctx), { text: '2 Empfehlungen offen' });
  // HKLM wurde nie angefasst, powercfg nur gelesen
  assert.ok(!w.calls.some((c) => c[0] === 'reg.exe' && c[1] === 'add' && !/^HKCU\\/.test(c[2])));
  assert.ok(!w.calls.some((c) => c[0] === 'powercfg.exe' && c[1] === '/setactive'));
  mod._test.setDeps({});
});

test('Ablauf: Energieplan umstellen und zurück', async () => {
  mod._test.setDeps(DEPS);
  mod._test.resetLock();
  const w = fakeWindows({ active: SAVER, reg: START_REG });
  const r = await mod.handlers.fix({ id: 'power' }, w.ctx);
  assert.equal(r.changed, true);
  assert.equal(r.message, 'Energieplan „Höchstleistung“ ist jetzt aktiv.');
  assert.equal(w.plan(), HP);
  assert.deepEqual(w.calls.filter((c) => c[1] === '/setactive'), [['powercfg.exe', '/setactive', HP]]);
  assert.equal(byId(r.result.items).power.status, 'good');
  assert.equal(w.store['tool-wincheck'].undo.power.prevGuid, SAVER);
  // zweimal: nichts zu tun
  const again = await mod.handlers.fix({ id: 'power' }, w.ctx);
  assert.equal(again.changed, false);
  const u = await mod.handlers.undo({ id: 'power' }, w.ctx);
  assert.equal(u.message, 'Energieplan „Energiesparmodus“ ist wieder aktiv.');
  assert.equal(w.plan(), SAVER);
  await assert.rejects(mod.handlers.undo({ id: 'power' }, w.ctx), (e) => e.code === 'NO_UNDO');
  mod._test.setDeps({});
});

test('Ablauf: Energieplan-Liste einmal nicht lesbar -> Rückgängig bleibt erhalten und klappt beim nächsten Versuch', async () => {
  mod._test.setDeps(DEPS);
  mod._test.resetLock();
  const w = fakeWindows({ active: BAL, reg: START_REG });
  await mod.handlers.fix({ id: 'power' }, w.ctx);
  assert.equal(w.plan(), HP);
  w.setListFails(true);
  await assert.rejects(mod.handlers.undo({ id: 'power' }, w.ctx), (e) => e.code === 'POWER_UNKNOWN' && /nochmal|noch einmal/.test(e.message));
  assert.equal(w.plan(), HP, 'nichts umgeschaltet');
  assert.equal(w.store['tool-wincheck'].undo.power.prevGuid, BAL, 'Rückgängig-Eintrag bleibt');
  w.setListFails(false);
  const u = await mod.handlers.undo({ id: 'power' }, w.ctx);
  assert.equal(u.message, 'Energieplan „Ausbalanciert“ ist wieder aktiv.');
  assert.equal(w.plan(), BAL);
  assert.equal(w.store['tool-wincheck'].undo.power, undefined);
  mod._test.setDeps({});
});

test('Ablauf: verweigertes Umschalten wird verständlich gemeldet, ohne Rückgängig-Eintrag', async () => {
  mod._test.setDeps(DEPS);
  mod._test.resetLock();
  const w = fakeWindows({ active: BAL, reg: START_REG, setactiveFails: true });
  await assert.rejects(mod.handlers.fix({ id: 'power' }, w.ctx), (e) => e.code === 'POWER_DENIED' && /Windows-Einstellungen/.test(e.message));
  assert.equal(w.store['tool-wincheck']?.undo?.power, undefined);
  mod._test.setDeps({});
});

test('Sicherheit: unbekannte Punkte, HKLM-Punkte und Nicht-Windows', async () => {
  mod._test.resetLock();
  const w = fakeWindows({ reg: START_REG });
  await assert.rejects(mod.handlers.fix({ id: 'hags' }, w.ctx), (e) => e.code === 'BAD_ARG');
  await assert.rejects(mod.handlers.fix({ id: '../x' }, w.ctx), (e) => e.code === 'BAD_ARG');
  await assert.rejects(mod.handlers.undo({ id: 'mouse' }, w.ctx), (e) => e.code === 'BAD_ARG');
  // registry.writeValue verweigert selbst alles außerhalb von HKCU
  await assert.rejects(w.ctx.registry.writeValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', 'HwSchMode', 'REG_DWORD', 2), (e) => e.code === 'REG_DENIED');
  const lin = { exec: { IS_WIN: false }, core: w.ctx.core };
  const r = await mod.handlers.check({}, lin);
  assert.equal(r.unsupported, true);
  assert.match(r.message, /nur auf einem Windows-PC/);
  await assert.rejects(mod.handlers.fix({ id: 'gamemode' }, lin), (e) => e.code === 'NOT_WINDOWS');
  await assert.rejects(mod.handlers.fixAll({}, lin), (e) => e.code === 'NOT_WINDOWS');
  assert.equal(await mod.handlers.summary({}, lin), null);
  assert.equal(mod.id, 'wincheck');
  assert.deepEqual(Object.keys(mod.handlers).sort(), ['check', 'fix', 'fixAll', 'summary', 'undo']);
});

test('Sicherheit: Batterie-Abfrage liest nur', () => {
  assert.match(mod._test.PS_BATTERY, /Get-CimInstance -ClassName Win32_Battery/);
  assert.doesNotMatch(mod._test.PS_BATTERY, /Set-|New-|Remove-|Invoke-/i);
});
