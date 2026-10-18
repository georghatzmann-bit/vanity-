'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const logic = require('../../src/main/tools/booster-logic');
const booster = require('../../src/main/modules/tools/booster');
const processes = require('../../src/main/sys/processes');

const VIEW = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'lib', 'booster-view.mjs');
const { PLAN } = logic;

booster._test.setDeps({ sleep: async () => {}, closeWaitMs: 30, forceWaitMs: 20, pollMs: 0 });

// ---------------------------------------------------------------- nachgebautes Windows
const PF = 'C:\\Program Files';
const LOCAL = 'C:\\Users\\Spieler\\AppData\\Local';

function defaultProcs() {
  return [
    { pid: 4, name: 'System', parent: 0, path: '', cmd: '' },
    { pid: 700, name: 'explorer.exe', parent: 600, path: 'C:\\Windows\\explorer.exe', cmd: 'C:\\Windows\\Explorer.EXE' },
    { pid: 900, name: 'svchost.exe', parent: 650, path: 'C:\\Windows\\System32\\svchost.exe', cmd: 'svchost.exe -k netsvcs' },
    { pid: 1001, name: 'Discord.exe', parent: 700, path: `${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe`, cmd: `"${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe" --start-minimized` },
    { pid: 1002, name: 'Discord.exe', parent: 1001, path: `${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe`, cmd: `"${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe" --type=renderer --field-trial` },
    { pid: 1003, name: 'Discord.exe', parent: 1001, path: `${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe`, cmd: `"${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe" --type=gpu-process` },
    { pid: 1101, name: 'Spotify.exe', parent: 700, path: `${LOCAL}\\Spotify\\Spotify.exe`, cmd: `${LOCAL}\\Spotify\\Spotify.exe` },
    { pid: 1201, name: 'steam.exe', parent: 700, path: `${PF} (x86)\\Steam\\steam.exe`, cmd: `"${PF} (x86)\\Steam\\steam.exe" -silent` },
    { pid: 1301, name: 'EasyAntiCheat_EOS.exe', parent: 650, path: `${PF} (x86)\\EasyAntiCheat_EOS\\EasyAntiCheat_EOS.exe`, cmd: '' },
    { pid: 1401, name: 'FortniteClient-Win64-Shipping.exe', parent: 1402, path: `${PF}\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe`, cmd: '' },
    { pid: 1501, name: 'EpicGamesLauncher.exe', parent: 700, path: `${PF} (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe`, cmd: '' },
    { pid: 1601, name: 'nvcontainer.exe', parent: 650, path: `${PF}\\NVIDIA Corporation\\NvContainer\\nvcontainer.exe`, cmd: '' },
  ];
}

const POWERCFG_LIST = [
  'Bestehende Energieschemas (* Aktiv)',
  '-----------------------------------',
  `GUID des Energieschemas: ${PLAN.balanced}  (Ausbalanciert)`,
  `GUID des Energieschemas: ${PLAN.high}  (Höchstleistung)`,
  `GUID des Energieschemas: ${PLAN.saver}  (Energiesparmodus)`,
].join('\r\n');

/** Text so kodieren, wie ihn die deutsche Konsole liefert (Codepage 850). */
function cp850(text) {
  return Buffer.from(text.replace(/ö/g, '\x94').replace(/ä/g, '\x84').replace(/ü/g, '\x81'), 'latin1');
}

function makeWorld({ win = true, procs = defaultProcs(), ignoreClose = ['steam.exe'], plans = [PLAN.balanced, PLAN.high, PLAN.saver], active = PLAN.balanced, setactiveFails = false, state = {} } = {}) {
  const w = { procs: procs.map((p) => ({ ...p })), plan: active, taskkill: [], powercfg: [], started: [], scripts: [], nextPid: 5000 };
  const run = async (file, args = []) => {
    if (file === 'tasklist.exe') {
      return w.procs.map((p) => `"${p.name}","${p.pid}","Console","1","10.000 K"`).join('\r\n');
    }
    if (file === 'taskkill.exe') {
      w.taskkill.push(args.slice());
      const pid = Number(args[args.indexOf('/PID') + 1]);
      const force = args.includes('/F');
      const p = w.procs.find((x) => x.pid === pid);
      if (p && (force || !ignoreClose.includes(p.name.toLowerCase()))) w.procs = w.procs.filter((x) => x.pid !== pid);
      return 'OK';
    }
    if (file === 'powercfg.exe') {
      w.powercfg.push(args.slice());
      if (args[0] === '/list') {
        const lines = POWERCFG_LIST.split('\r\n').filter((l) => !/GUID/.test(l) || plans.some((g) => l.includes(g)));
        return cp850(lines.map((l) => (l.includes(w.plan) ? `${l} *` : l)).join('\r\n'));
      }
      if (args[0] === '/getactivescheme') return cp850(`GUID des Energieschemas: ${w.plan}  (Name)`);
      if (args[0] === '/setactive') {
        if (setactiveFails) { const e = new Error('Zugriff verweigert'); e.code = 'EXEC_FAILED'; throw e; }
        w.plan = args[1];
        return Buffer.from('');
      }
    }
    throw new Error(`unerwartet: ${file} ${args.join(' ')}`);
  };
  const decode = (script) => JSON.parse(Buffer.from(script.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8'));
  const powershell = async (script) => {
    w.scripts.push(script);
    if (/Win32_Process/.test(script)) {
      const names = decode(script).names.map((n) => n.toLowerCase());
      return w.procs.filter((p) => names.includes(p.name.toLowerCase().replace(/\.exe$/, '')))
        .map((p) => ({ Name: p.name, Id: p.pid, ParentId: p.parent, Path: p.path, CommandLine: p.cmd }));
    }
    if (/Start-Process/.test(script)) {
      const items = decode(script).items;
      return items.map((it) => {
        w.started.push(it);
        w.procs.push({ pid: w.nextPid++, name: it.file.split('\\').pop(), parent: 700, path: it.file, cmd: `"${it.file}" ${it.args}`.trim() });
        return { key: it.key, ok: true, error: null };
      });
    }
    if (/Get-Process/.test(script)) {
      return w.procs.map((p) => ({ Name: p.name.replace(/\.exe$/i, ''), Id: p.pid, Path: p.path, MainWindowTitle: /discord|spotify/i.test(p.name) ? 'Fenster' : '', Company: '', Description: '', WorkingSet: 100 * 1024 * 1024 }));
    }
    throw new Error('unbekanntes Skript');
  };
  const store = { 'tool-booster': JSON.parse(JSON.stringify(state)) };
  const fortniteCbs = [];
  const ctx = {
    exec: { IS_WIN: win, run, powershell },
    processes,
    core: {
      readState: async (n, fb) => (n in store ? JSON.parse(JSON.stringify(store[n])) : fb),
      writeState: async (n, o) => { store[n] = JSON.parse(JSON.stringify(o)); },
      onFortniteState: (cb) => fortniteCbs.push(cb),
    },
    emit: () => {},
    log: () => {},
  };
  return { w, ctx, store, fortniteCbs };
}

const listState = (names, extra = {}) => ({ list: names.map((n) => ({ name: logic.normalizeName(n), display: n.replace(/\.exe$/i, '') })), options: { powerPlan: false, auto: false }, ...extra });

// ---------------------------------------------------------------- Namen
test('Namen: Groß/klein, mit oder ohne .exe, mit Pfad – alles gleich', () => {
  for (const n of ['Discord', 'discord.exe', 'DISCORD.EXE', ' "C:\\Users\\x\\Discord.exe" ', 'C:/Apps/Discord.exe']) {
    assert.equal(logic.normalizeName(n), 'discord', n);
  }
  assert.equal(logic.normalizeName('NVDisplay.Container.exe'), 'nvdisplay.container');
  assert.equal(logic.validName('Spotify.exe'), true);
  assert.equal(logic.validName(''), false);
  assert.equal(logic.validName('a*b'), false);
  assert.equal(logic.validName('..'), false);
  assert.equal(logic.validName('x'.repeat(101)), false);
});

// ---------------------------------------------------------------- Schutzliste
test('Schutzliste: Windows, Virenschutz, Anti-Cheat, Fortnite, Epic und HELIX sind immer gesperrt', () => {
  const blocked = [
    'System', 'Idle', 'Registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'svchost.exe',
    'dwm.exe', 'explorer.exe', 'sihost.exe', 'fontdrvhost.exe', 'ctfmon.exe', 'audiodg.exe', 'conhost.exe', 'RuntimeBroker.exe',
    'SearchHost.exe', 'StartMenuExperienceHost.exe', 'ShellExperienceHost.exe', 'SecurityHealthSystray.exe', 'SecurityHealthService.exe',
    'MsMpEng.exe', 'NisSrv.exe', 'smartscreen.exe',
    'EasyAntiCheat.exe', 'EasyAntiCheat_EOS.exe', 'BEService.exe', 'BEService_x64.exe', 'BattlEye.exe',
    'FortniteClient-Win64-Shipping_EAC.exe', 'FortniteClient-Win64-Shipping_EAC_EOS.exe', 'FortniteClient-Win64-Shipping_BE.exe', 'SomeGame_BE.exe',
    'FortniteClient-Win64-Shipping.exe', 'FortniteLauncher.exe', 'EpicGamesLauncher.exe', 'EpicWebHelper.exe', 'EOSOverlayRenderer-Win64-Shipping.exe',
    'electron.exe', 'HELIX.exe', 'powershell.exe', 'WUDFHost.exe', 'TextInputHost.exe',
  ];
  for (const n of blocked) {
    const c = logic.classify(n);
    assert.ok(c && c.level === 'block', `${n} muss gesperrt sein`);
    assert.equal(logic.classify(n.toUpperCase())?.level, 'block', `${n} groß geschrieben`);
    assert.equal(logic.classify(n.replace(/\.exe$/i, ''))?.level, 'block', `${n} ohne .exe`);
  }
  assert.equal(logic.classify('C:\\Program Files (x86)\\EasyAntiCheat_EOS\\EasyAntiCheat_EOS.exe').kind, 'anticheat');
  assert.equal(logic.classify('FortniteClient-Win64-Shipping_EAC_EOS.exe').level, 'block');
  assert.equal(logic.classify('EpicGamesLauncher').kind, 'epic');
  assert.match(logic.classify('EpicGamesLauncher').reason, /Sitzung stören/);
});

test('Schutzliste: HELIX selbst wird über den eigenen Programmnamen erkannt', () => {
  assert.deepEqual(logic.selfNames('C:\\Programme\\HELIX\\HELIX.exe').includes('helix'), true);
  assert.equal(logic.classify('MeinTool.exe', { self: logic.selfNames('D:\\x\\MeinTool.exe') }).kind, 'helix');
  assert.equal(logic.classify(path.basename(process.execPath)).level, 'block', 'das laufende Programm (hier node) ist geschützt');
});

test('Schutzliste: Grafik-, Eingabe- und Sound-Helfer nur mit Warnung, normale Programme frei', () => {
  for (const n of ['nvcontainer.exe', 'NVDisplay.Container.exe', 'atiesrxx.exe', 'atieclxx.exe', 'RadeonSoftware.exe']) {
    assert.equal(logic.classify(n)?.level, 'warn', n);
    assert.equal(logic.classify(n).kind, 'graphics');
  }
  assert.equal(logic.classify('lghub_agent.exe').kind, 'inputsw');
  assert.equal(logic.classify('Razer Synapse 3.exe').kind, 'inputsw');
  assert.equal(logic.classify('RtkAudUService64.exe').kind, 'audio');
  for (const n of ['Discord.exe', 'Spotify.exe', 'steam.exe', 'chrome.exe', 'OneDrive.exe', 'ms-teams.exe', 'vibe.exe', 'Overwolf.exe']) {
    assert.equal(logic.classify(n), null, n);
  }
});

// ---------------------------------------------------------------- Laufende Programme
test('Laufende Programme: zusammengefasst, Windows-Interna ausgeblendet, Geschützte markiert', () => {
  const raw = [
    { Name: 'Discord', Id: 10, Path: 'C:\\D\\Discord.exe', MainWindowTitle: 'Discord', Description: 'Discord', Company: 'Discord Inc.', WorkingSet: 200 * 1048576 },
    { Name: 'Discord', Id: 11, Path: 'C:\\D\\Discord.exe', MainWindowTitle: '', WorkingSet: 100 * 1048576 },
    { Name: 'chrome', Id: 20, Path: 'C:\\C\\chrome.exe', MainWindowTitle: '', WorkingSet: 900 * 1048576 },
    { Name: 'svchost', Id: 30, Path: 'C:\\Windows\\System32\\svchost.exe', WorkingSet: 1 },
    { Name: 'explorer', Id: 31, Path: 'C:\\Windows\\explorer.exe', MainWindowTitle: 'x', WorkingSet: 1 },
    { Name: 'EpicGamesLauncher', Id: 40, Path: 'C:\\E\\EpicGamesLauncher.exe', MainWindowTitle: 'Epic', WorkingSet: 300 * 1048576 },
    { Name: 'Geheim', Id: 50, Path: '', MainWindowTitle: '', WorkingSet: 1 },
    { Name: 'System', Id: 4, Path: '', WorkingSet: 1 },
  ];
  const g = logic.groupRunning(raw, { listNames: ['Discord.exe'] });
  assert.deepEqual(g.map((x) => x.name), ['discord', 'chrome', 'epicgameslauncher']);
  const d = g[0];
  assert.equal(d.count, 2);
  assert.equal(d.memMb, 300);
  assert.equal(d.hasWindow, true);
  assert.equal(d.inList, true);
  assert.equal(d.description, 'Discord');
  assert.equal(g[2].protect.level, 'block', 'Epic wird angezeigt, ist aber gesperrt');
  assert.deepEqual(logic.groupRunning(null), []);
  assert.equal(logic.groupRunning({ Name: 'Spotify', Id: 9, Path: 'C:\\S\\Spotify.exe', WorkingSet: 0 }).length, 1, 'Einzelobjekt aus PowerShell');
});

test('Befehlszeile: Argumente ohne das Programm selbst', () => {
  const exe = 'C:\\Program Files (x86)\\Steam\\steam.exe';
  assert.equal(logic.argsFromCommandLine(`"${exe}" -silent`, exe), '-silent');
  assert.equal(logic.argsFromCommandLine(`${exe} -silent -x`, exe), '-silent -x');
  assert.equal(logic.argsFromCommandLine(`"C:\\Other\\steam.exe" -a "b c"`, exe), '-a "b c"');
  assert.equal(logic.argsFromCommandLine('steam.exe -silent', exe), '-silent');
  assert.equal(logic.argsFromCommandLine('', exe), '');
  assert.equal(logic.argsFromCommandLine(`"${exe}"`, exe), '');
});

test('Neustart-Daten: nur Hauptprozesse, keine Chromium-Hilfsprozesse', () => {
  const procs = defaultProcs().filter((p) => p.name === 'Discord.exe').map((p) => ({ Name: p.name, Id: p.pid, ParentId: p.parent, Path: p.path, CommandLine: p.cmd }));
  const roots = logic.pickRoots(procs);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].args, '--start-minimized');
  assert.equal(roots[0].cwd, `${LOCAL}\\Discord\\app-1.0.9200`);
  // ohne lesbaren Pfad kann nichts neu gestartet werden
  assert.deepEqual(logic.pickRoots([{ Name: 'x.exe', Id: 5, ParentId: 1, Path: '', CommandLine: '' }]), []);
  assert.equal(logic.validExePath('C:\\a\\b.exe'), true);
  assert.equal(logic.validExePath('\\\\server\\x.exe'), false);
  assert.equal(logic.validExePath('C:\\a\\b.bat'), false);
});

// ---------------------------------------------------------------- Energiepläne
test('Energiepläne: deutsche powercfg-Ausgabe (Codepage 850) wird sprachneutral gelesen', () => {
  const text = logic.decodeConsole(cp850(`${POWERCFG_LIST.split('\r\n').slice(0, 3).join('\r\n')} *\r\nGUID des Energieschemas: ${PLAN.high}  (Höchstleistung)`));
  assert.match(text, /Höchstleistung/);
  const plans = logic.parsePowercfgList(text);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].active, true);
  assert.equal(plans[0].guid, PLAN.balanced);
  assert.equal(plans[1].name, 'Höchstleistung');
  assert.equal(logic.chooseHighPlan(plans).guid, PLAN.high);
  assert.equal(logic.chooseHighPlan([{ guid: PLAN.balanced, name: 'Balanced' }]), null);
  assert.equal(logic.chooseHighPlan([{ guid: '11111111-2222-3333-4444-555555555555', name: 'Ultimative Leistung' }]).name, 'Ultimative Leistung');
  assert.equal(logic.parseActiveScheme(`Power Scheme GUID: ${PLAN.saver}  (Power saver)`), PLAN.saver);
  assert.equal(logic.planLabel({ guid: PLAN.balanced, name: 'Balanced' }), 'Ausbalanciert');
  assert.equal(logic.decodeConsole(Buffer.from('Grüße', 'utf8')), 'Grüße');
  assert.equal(logic.validGuid('8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c & del'), false);
});

// ---------------------------------------------------------------- Liste
test('Liste: Geschützte nie, Treiber-Helfer nur mit Bestätigung, doppelte nur einmal', async () => {
  booster._test.reset();
  const { ctx, store } = makeWorld();
  for (const n of ['explorer.exe', 'EasyAntiCheat_EOS.exe', 'FortniteClient-Win64-Shipping_EAC_EOS.exe', 'EpicGamesLauncher.exe', 'svchost', 'FortniteClient-Win64-Shipping.exe']) {
    await assert.rejects(booster.handlers.add({ name: n }, ctx), (e) => e.code === 'PROTECTED', n);
  }
  await assert.rejects(booster.handlers.add({ name: 'nvcontainer.exe' }, ctx), (e) => e.code === 'CONFIRM_NEEDED');
  const r = await booster.handlers.add({ name: 'nvcontainer.exe', confirm: true }, ctx);
  assert.equal(r.added, true);
  await assert.rejects(booster.handlers.add({ name: '' }, ctx), (e) => e.code === 'BAD_ARG');
  await assert.rejects(booster.handlers.add({ name: 'a|b.exe' }, ctx), (e) => e.code === 'BAD_ARG');
  const a = await booster.handlers.add({ name: 'Discord.exe', display: 'Discord', path: `${LOCAL}\\Discord\\Discord.exe` }, ctx);
  assert.equal(a.added, true);
  const b = await booster.handlers.add({ name: 'DISCORD' }, ctx);
  assert.equal(b.already, true);
  assert.deepEqual(store['tool-booster'].list.map((e) => e.name), ['nvcontainer', 'discord']);
  assert.equal(a.info.list.find((e) => e.name === 'discord').running, true);
  const rm = await booster.handlers.remove({ name: 'Discord.exe' }, ctx);
  assert.equal(rm.removed, true);
  assert.equal(store['tool-booster'].list.length, 1);
  const s = await booster.handlers.summary({}, ctx);
  assert.equal(s.text, '1 Programm in der Liste');
});

// ---------------------------------------------------------------- Boost
test('Boost: schließt nur die Liste, normal (ohne /F), meldet offene, merkt Neustart-Daten', async () => {
  booster._test.reset();
  // Liste per Hand manipuliert: explorer und Anti-Cheat dürfen trotzdem NIE geschlossen werden
  const { w, ctx, store } = makeWorld({ state: listState(['Discord.exe', 'Spotify.exe', 'steam.exe', 'OneDrive.exe', 'explorer.exe', 'EasyAntiCheat_EOS.exe']) });
  const r = await booster.handlers.boost({}, ctx);
  assert.deepEqual(r.report.closed.sort(), ['Discord', 'Spotify']);
  assert.deepEqual(r.report.stillOpen, ['steam']);
  assert.deepEqual(r.report.notRunning, ['OneDrive']);
  assert.ok(w.taskkill.length > 0);
  assert.ok(w.taskkill.every((a) => !a.includes('/F')), 'beim Boost nie sofort beenden');
  const killed = w.taskkill.map((a) => Number(a[1]));
  for (const pid of [700, 900, 1301, 1401, 1501, 1601, 4]) assert.ok(!killed.includes(pid), `PID ${pid} darf nie geschlossen werden`);
  assert.ok(w.procs.some((p) => p.name === 'explorer.exe') && w.procs.some((p) => p.name === 'EasyAntiCheat_EOS.exe'));
  const act = store['tool-booster'].active;
  const discord = act.apps.find((a) => a.name === 'discord');
  assert.equal(discord.status, 'closed');
  assert.deepEqual(discord.instances, [{ path: `${LOCAL}\\Discord\\app-1.0.9200\\Discord.exe`, args: '--start-minimized', cwd: `${LOCAL}\\Discord\\app-1.0.9200` }]);
  assert.equal(act.apps.find((a) => a.name === 'steam').status, 'open');
  assert.equal(act.powerPlan, null, 'Energieplan war aus');
  assert.equal(w.powercfg.filter((a) => a[0] === '/setactive').length, 0);
  assert.equal((await booster.handlers.summary({}, ctx)).text, 'Boost aktiv – 2 Programme geschlossen');
  const info = await booster.handlers.info({}, ctx);
  assert.equal(info.list.find((e) => e.name === 'steam').boost, 'open');
  assert.equal(info.active.apps.length, 3);
});

test('Sofort beenden: nur nach Bestätigung und nur die noch offenen Programme', async () => {
  booster._test.reset();
  const { w, ctx, store } = makeWorld({ state: listState(['Discord.exe', 'steam.exe']) });
  await booster.handlers.boost({}, ctx);
  await assert.rejects(booster.handlers.forceClose({ names: ['steam'] }, ctx), (e) => e.code === 'CONFIRM_NEEDED');
  await assert.rejects(booster.handlers.forceClose({ names: ['steam'], confirm: 'ja' }, ctx), (e) => e.code === 'CONFIRM_NEEDED');
  const before = w.taskkill.length;
  const r = await booster.handlers.forceClose({ names: ['steam', 'explorer'], confirm: true }, ctx);
  const forced = w.taskkill.slice(before);
  assert.deepEqual(forced, [['/PID', '1201', '/F']]);
  assert.deepEqual(r.report.forced, ['steam']);
  assert.equal(store['tool-booster'].active.apps.find((a) => a.name === 'steam').status, 'forced');
  assert.ok(!store['tool-booster'].lastReport.stillOpen.includes('steam'));
});

test('Wiederherstellen: startet mit Originalpfad und -argumenten, überspringt laufende', async () => {
  booster._test.reset();
  const { w, ctx, store } = makeWorld({ ignoreClose: [], state: listState(['Discord.exe', 'Spotify.exe', 'steam.exe']) });
  await booster.handlers.boost({}, ctx);
  // Spotify hat der Nutzer schon selbst wieder geöffnet
  w.procs.push({ pid: 7777, name: 'Spotify.exe', parent: 700, path: `${LOCAL}\\Spotify\\Spotify.exe`, cmd: '' });
  const r = await booster.handlers.restore({}, ctx);
  assert.deepEqual(r.report.restarted.sort(), ['Discord', 'steam']);
  assert.deepEqual(r.report.alreadyRunning, ['Spotify']);
  const steam = w.started.find((s) => /steam\.exe$/.test(s.file));
  assert.equal(steam.args, '-silent');
  assert.equal(steam.cwd, `${PF} (x86)\\Steam`);
  // Pfade stehen nur Base64-kodiert im Skript (keine Anführungszeichen-Tricks möglich)
  const script = w.scripts.find((s) => /Start-Process/.test(s));
  assert.doesNotMatch(script, /steam\.exe/i);
  assert.match(script, /-LiteralPath/);
  assert.equal(store['tool-booster'].active, null);
  const again = await booster.handlers.restore({}, ctx);
  assert.equal(again.nothing, true);
});

test('Wiederherstellen: manipulierte Neustart-Daten werden nicht gestartet', async () => {
  booster._test.reset();
  const state = listState(['Discord.exe', 'explorer.exe']);
  state.active = {
    startedAt: 1, trigger: 'manual', powerPlan: null,
    apps: [
      { name: 'discord', display: 'Discord', status: 'closed', instances: [{ path: 'C:\\Temp\\boese.exe', args: '', cwd: 'C:\\Temp' }] },
      { name: 'explorer', display: 'explorer', status: 'closed', instances: [{ path: 'C:\\Windows\\explorer.exe', args: '', cwd: 'C:\\Windows' }] },
      { name: 'spotify', display: 'Spotify', status: 'closed', instances: [{ path: 'relativ\\Spotify.exe', args: '', cwd: '' }] },
    ],
  };
  const { w, ctx } = makeWorld({ procs: defaultProcs().filter((p) => !/discord|spotify/i.test(p.name)), state });
  const r = await booster.handlers.restore({}, ctx);
  assert.equal(w.started.length, 0);
  assert.deepEqual(r.report.failed.map((f) => f.display).sort(), ['Discord', 'Spotify']);
});

test('Energieplan: auf Höchstleistung und danach zurück', async () => {
  booster._test.reset();
  const { w, ctx, store } = makeWorld({ ignoreClose: [], state: listState(['Discord.exe'], { options: { powerPlan: true, auto: false } }) });
  const r = await booster.handlers.boost({}, ctx);
  assert.equal(w.plan, PLAN.high);
  assert.equal(r.report.powerPlan.changed, true);
  assert.match(r.report.powerPlan.text, /„Ausbalanciert“ auf „Höchstleistung“/);
  assert.deepEqual(store['tool-booster'].active.powerPlan, { before: PLAN.balanced, beforeName: 'Ausbalanciert', set: PLAN.high, setName: 'Höchstleistung' });
  const back = await booster.handlers.restore({}, ctx);
  assert.equal(w.plan, PLAN.balanced);
  assert.match(back.report.powerPlan.text, /zurück auf „Ausbalanciert“/);
});

test('Energieplan: fehlt "Höchstleistung", bleibt alles, wie es ist', async () => {
  booster._test.reset();
  const { w, ctx, store } = makeWorld({ plans: [PLAN.balanced, PLAN.saver], state: listState(['Discord.exe'], { options: { powerPlan: true, auto: false } }) });
  const r = await booster.handlers.boost({}, ctx);
  assert.equal(r.report.powerPlan.missing, true);
  assert.equal(w.powercfg.filter((a) => a[0] === '/setactive').length, 0);
  assert.equal(store['tool-booster'].active.powerPlan, null);
  const info = await booster.handlers.info({}, ctx);
  assert.equal(info.power.highAvailable, false);
  assert.equal(info.power.active, 'Ausbalanciert');
});

test('Energieplan: gesperrt (powercfg verweigert) -> verständlicher Hinweis, Boost läuft trotzdem', async () => {
  booster._test.reset();
  const { w, ctx } = makeWorld({ setactiveFails: true, state: listState(['Discord.exe'], { options: { powerPlan: true, auto: false } }) });
  const r = await booster.handlers.boost({}, ctx);
  assert.equal(r.report.powerPlan.error, true);
  assert.match(r.report.powerPlan.text, /Administrator/);
  assert.equal(w.plan, PLAN.balanced);
  assert.deepEqual(r.report.closed, ['Discord']);
});

test('Leere Liste: verständlicher Fehler', async () => {
  booster._test.reset();
  const { ctx } = makeWorld();
  await assert.rejects(booster.handlers.boost({}, ctx), (e) => e.code === 'EMPTY_LIST');
});

// ---------------------------------------------------------------- Automatik
test('Automatik: aus ab Werk; an -> Boost beim Start von Fortnite, Wiederherstellen beim Beenden', async () => {
  booster._test.reset();
  const off = makeWorld({ ignoreClose: [], state: listState(['Discord.exe']) });
  booster.init(off.ctx);
  assert.equal(off.fortniteCbs.length, 1);
  await booster._test.onFortnite(off.ctx, true);
  assert.equal(off.w.taskkill.length, 0, 'ohne Automatik passiert nichts');

  booster._test.reset();
  const on = makeWorld({ ignoreClose: [], state: listState(['Discord.exe'], { options: { powerPlan: false, auto: true } }) });
  await booster._test.onFortnite(on.ctx, true);
  assert.equal(on.store['tool-booster'].active.trigger, 'auto');
  assert.ok(on.w.taskkill.length > 0);
  await booster._test.onFortnite(on.ctx, false);
  assert.equal(on.store['tool-booster'].active, null);
  assert.equal(on.w.started.length, 1);
  assert.equal(on.store['tool-booster'].lastReport.trigger, 'auto');
  booster.dispose();
  booster._test.reset();
});

test('Ohne Windows: verständliche Meldung statt Absturz', async () => {
  booster._test.reset();
  const { ctx } = makeWorld({ win: false, state: listState(['Discord.exe']) });
  await assert.rejects(booster.handlers.boost({}, ctx), (e) => e.code === 'NOT_WINDOWS');
  await assert.rejects(booster.handlers.restore({}, ctx), (e) => e.code === 'NOT_WINDOWS');
  assert.deepEqual(await booster.handlers.running({}, ctx), { unsupported: true, processes: [] });
  assert.equal(await booster.handlers.summary({}, ctx), null);
  const info = await booster.handlers.info({}, ctx);
  assert.equal(info.supported, false);
  assert.equal(info.list[0].running, null);
});

test('Programmliste über PowerShell: nur eigene Sitzung, JSON', async () => {
  booster._test.reset();
  assert.match(booster._test.PS_RUNNING, /SessionId/);
  assert.match(booster._test.PS_RUNNING, /ConvertTo-Json/);
  assert.match(booster._test.psDetails(['discord']), /Win32_Process/);
  assert.match(booster._test.psDetails(['discord']), /CommandLine/);
  const { ctx } = makeWorld({ state: listState(['Discord.exe']) });
  const r = await booster.handlers.running({}, ctx);
  const names = r.processes.map((p) => p.name);
  assert.ok(names.includes('discord') && names.includes('spotify'));
  assert.ok(!names.includes('svchost') && !names.includes('explorer'), 'Windows-Interna werden nicht angeboten');
  assert.equal(r.processes.find((p) => p.name === 'discord').inList, true);
  assert.equal(r.processes.find((p) => p.name === 'epicgameslauncher').protect.level, 'block');
  assert.equal(r.processes[0].pids, undefined, 'keine PIDs an die Oberfläche');
});

test('Cockpit-Zeile', () => {
  assert.equal(logic.summaryText({ list: [] }), 'Noch keine Programme in der Liste');
  assert.equal(logic.summaryText({ list: [{}, {}, {}] }), '3 Programme in der Liste');
  assert.equal(logic.summaryText({ list: [{}], active: { apps: [] } }), 'Boost aktiv');
  assert.equal(logic.summaryText({ active: { apps: [{ status: 'closed' }, { status: 'open' }] } }), 'Boost aktiv – 1 Programm geschlossen');
});

// ---------------------------------------------------------------- Anzeige-Logik (ES-Modul der Oberfläche)
test('Anzeige: Status immer mit Text', async () => {
  const v = await import(require("node:url").pathToFileURL(VIEW).href);
  assert.deepEqual(v.statusOf({ boost: 'closed' }), { label: 'geschlossen', type: 'ok' });
  assert.equal(v.statusOf({ boost: 'open' }).label, 'noch offen');
  assert.equal(v.statusOf({ running: true }).label, 'läuft');
  assert.equal(v.statusOf({ running: false }).label, 'nicht offen');
  assert.equal(v.statusOf({ running: null }).label, 'unbekannt');
  assert.equal(v.statusOf(null).label, 'unbekannt');
});

test('Anzeige: Bericht, Suche, Zahlen', async () => {
  const v = await import(require("node:url").pathToFileURL(VIEW).href);
  const boost = { kind: 'boost', closed: ['Discord', 'Spotify'], stillOpen: ['Steam'], notRunning: ['OneDrive'], failed: [] };
  assert.equal(v.reportHeadline(boost), 'Boost: 2 Programme geschlossen, 1 noch offen');
  assert.deepEqual(v.reportSections(boost).map((s) => s.title), ['Geschlossen', 'Noch offen', 'Liefen gerade nicht']);
  assert.equal(v.reportHeadline({ kind: 'boost', closed: [], stillOpen: [] }), 'Boost: keines deiner Programme lief');
  const rest = { kind: 'restore', restarted: ['Discord'], alreadyRunning: [], failed: [{ display: 'Steam', reason: 'Datei fehlt' }], untouched: [] };
  assert.equal(v.reportHeadline(rest), 'Wiederhergestellt: 1 Programm wieder gestartet, 1 nicht gestartet');
  assert.deepEqual(v.reportSections(rest)[1].items, ['Steam: Datei fehlt']);
  assert.equal(v.reportHeadline(null), null);
  const list = [{ name: 'discord', display: 'Discord', description: 'Discord' }, { name: 'chrome', display: 'chrome', description: 'Google Chrome' }];
  assert.deepEqual(v.filterProcesses(list, 'goo').map((p) => p.name), ['chrome']);
  assert.equal(v.filterProcesses(list, '').length, 2);
  assert.equal(v.fmtMem(1536), '1,5\u00a0GB');
  assert.equal(v.fmtMem(236.4), '236\u00a0MB');
  assert.equal(v.sinceText(0), '');
  assert.equal(v.sinceText(1000, 1000 + 12 * 60000), 'seit 12 Min.');
  assert.equal(v.sinceText(1000, 1000 + 125 * 60000), 'seit 2 Std. 5 Min.');
  assert.equal(v.triggerText('auto'), 'automatisch beim Start von Fortnite');
  assert.equal(v.processHint({ display: 'Discord', count: 6, memMb: 412, hasWindow: true }), 'Discord.exe · 6 Prozesse · 412\u00a0MB · Fenster offen');
});

test('Codepage 850: Tabelle vollständig, Umlaute richtig', () => {
  const buf = Buffer.from([0x48, 0x94, 0x63, 0x68, 0x73, 0x74, 0x6c, 0x65, 0x69, 0x73, 0x74, 0x75, 0x6e, 0x67, 0x20, 0x84, 0x81, 0xe1, 0x8e, 0x99, 0x9a]);
  assert.equal(logic.decodeConsole(buf), 'Höchstleistung äüßÄÖÜ');
  const all = logic.decodeConsole(Buffer.from(Array.from({ length: 128 }, (_, i) => 0x80 + i)));
  assert.equal(all.length, 128);
  assert.ok(!all.includes('undefined'));
});
