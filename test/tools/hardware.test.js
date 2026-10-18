'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const logic = require('../../src/main/tools/hardware-logic');
const mod = require('../../src/main/modules/tools/hardware');

const { HardwareMonitor, PS_SAMPLER } = mod._test;
const GB = 1024 ** 3;
const libUrl = 'file://' + path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'lib', 'hardware-status.mjs');

// Eine echte Zeile, wie sie das PowerShell-Skript (ConvertTo-Json -Compress) ausgibt
const LINE_NVIDIA = JSON.stringify({
  v: 1, tick: 3, nvp: true,
  gpus: ['NVIDIA GeForce RTX 4060 Ti', 'Intel(R) UHD Graphics 770'],
  vt: [8585740288, 134217728],
  cpu: 37,
  eng: [
    { n: 'pid_10244_luid_0x00000000_0x0000D1A3_phys_0_eng_0_engtype_3D', u: 61 },
    { n: 'pid_4120_luid_0x00000000_0x0000D1A3_phys_0_eng_0_engtype_3D', u: 12 },
    { n: 'pid_900_luid_0x00000000_0x0000E2B1_phys_0_eng_0_engtype_3D', u: 3 },
  ],
  mem: [
    { n: 'luid_0x00000000_0x0000D1A3_phys_0', d: 5583457484 },
    { n: 'luid_0x00000000_0x0000E2B1_phys_0', d: 104857600 },
  ],
  tz: [{ n: '\\_TZ.TZ00', hp: 3231, t: 323 }, { n: '\\_TZ.TZ01', hp: 0, t: 300 }],
  nv: ['66, 87, 5324, 8188, 152.34, 2610'],
  fn: { ws: 4718592000, cpu: 1200.5, n: 1 },
});

const LINE_AMD = JSON.stringify({
  v: 1, tick: 0, nvp: false, gpus: ['AMD Radeon RX 7700 XT'], vt: [12868124672], cpu: 12,
  eng: [{ n: 'pid_77_luid_0x00000000_0x00011111_phys_0_eng_0_engtype_3D', u: 70 }, { n: 'pid_78_luid_0x00000000_0x00011111_phys_0_eng_0_engtype_3D', u: 55 }],
  mem: { n: 'luid_0x00000000_0x00011111_phys_0', d: 3221225472 }, // einzelnes Objekt statt Liste
  tz: [], fn: null,
});

function cpus(idle, busy, n = 4) {
  return Array.from({ length: n }, () => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }));
}

// ---------------------------------------------------------------- Parser
test('nvidia-smi: Zeile wird zerlegt, [N/A] wird null', () => {
  const r = logic.parseNvidiaSmi('66, 87, 5324, 8188, 152.34, 2610\r\n45, 3, 812, 6144, [N/A], 1410\r\n');
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { tempC: 66, utilPct: 87, memUsedMiB: 5324, memTotalMiB: 8188, powerW: 152.3, clockMHz: 2610 });
  assert.equal(r[1].powerW, null);
  assert.equal(r[1].tempC, 45);
});

test('nvidia-smi: Fehlermeldungen und kaputte Zeilen werden ignoriert', () => {
  assert.deepEqual(logic.parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'), []);
  assert.deepEqual(logic.parseNvidiaSmi(['[Not Supported], [Not Supported], [N/A], [N/A], [N/A], [N/A]']), []);
  assert.deepEqual(logic.parseNvidiaSmi(''), []);
  assert.deepEqual(logic.parseNvidiaSmi(null), []);
});

test('GPU-Auslastung: Summe je Grafikkarte, stärkste zählt, höchstens 100 %', () => {
  const r = logic.gpuEngineLoad(JSON.parse(LINE_NVIDIA).eng);
  assert.equal(r.luid, '0x00000000_0x0000d1a3');
  assert.equal(r.pct, 73);
  const over = logic.gpuEngineLoad([{ n: 'pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D', u: 80 }, { n: 'pid_2_luid_0x0_0x1_phys_0_eng_0_engtype_3D', u: 70 }]);
  assert.equal(over.pct, 100);
  assert.equal(logic.gpuEngineLoad(null), null, 'null = Windows liefert nichts');
  assert.deepEqual(logic.gpuEngineLoad([]), { luid: null, pct: 0 }, 'leere Liste = keine Last');
  // andere Einheiten (Video, Copy) zählen nicht
  assert.equal(logic.gpuEngineLoad([{ n: 'pid_1_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode', u: 50 }]).pct, 0);
  // einzelnes Objekt statt Liste (ConvertTo-Json bei genau einem Eintrag)
  assert.equal(logic.gpuEngineLoad({ n: 'pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D', u: 42 }).pct, 42);
});

test('Grafikspeicher: Karte mit dem meisten belegten Speicher', () => {
  const r = logic.adapterMemory(JSON.parse(LINE_NVIDIA).mem);
  assert.equal(r.usedBytes, 5583457484);
  assert.equal(r.luid, '0x00000000_0x0000d1a3');
  assert.equal(logic.adapterMemory(null), null);
});

test('Wärmezonen: Zehntel-Kelvin, Kelvin als Ersatz, unplausible Werte fallen weg', () => {
  const z = logic.thermalZones([{ n: '\\_TZ.TZ00', hp: 3231, t: 323 }, { n: '_TZ.CPUZ', hp: 0, t: 318 }, { n: 'X', hp: 0, t: 0 }, { n: 'Y', hp: 5000, t: 500 }]);
  assert.deepEqual(z, [{ name: '_TZ.TZ00', tempC: 50 }, { name: '_TZ.CPUZ', tempC: 44.9 }]);
  assert.equal(logic.thermalZones(null), null);
});

test('Hersteller: diskrete Karte vor integrierter', () => {
  assert.equal(logic.detectVendor(['Intel(R) UHD Graphics 770', 'NVIDIA GeForce RTX 4060 Ti']), 'nvidia');
  assert.equal(logic.detectVendor(['AMD Radeon RX 7700 XT']), 'amd');
  assert.equal(logic.detectVendor(['Intel(R) Arc(TM) A770 Graphics']), 'intel');
  assert.equal(logic.detectVendor(['Microsoft Basic Display Adapter']), 'other');
  assert.equal(logic.detectVendor([]), null);
});

test('Prozessor-Last aus os.cpus()-Zeiten', () => {
  const a = logic.cpuTimes(cpus(1000, 1000));
  const b = logic.cpuTimes(cpus(1300, 1700)); // je Kern: 300 idle, 700 busy
  assert.equal(logic.cpuPercent(a, b), 70);
  assert.equal(logic.cpuPercent(null, b), null);
  assert.equal(logic.cpuPercent(b, b), null, 'keine Zeit vergangen');
});

// ---------------------------------------------------------------- Messung bauen
test('Messung: NVIDIA-Werte haben Vorrang, RAM aus Node, Fortnite-RAM aus Get-Process', () => {
  const state = {};
  const node = { cpus: cpus(100, 100), totalmem: 16 * GB, freemem: 6 * GB };
  const s = logic.buildSample({ ps: JSON.parse(LINE_NVIDIA), node, now: 10000, state, logical: 8 });
  assert.equal(s.cpuPct, 37);
  assert.equal(s.cpuSource, 'windows');
  assert.equal(s.gpuPct, 87);
  assert.equal(s.gpuSource, 'nvidia');
  assert.equal(s.gpuTemp, 66);
  assert.equal(s.vramUsed, 5324 * 1024 * 1024);
  assert.equal(s.vramTotal, 8188 * 1024 * 1024);
  assert.equal(s.gpuPower, 152.3);
  assert.equal(s.gpuClock, 2610);
  assert.equal(s.boardTemp, 50);
  assert.equal(s.ramUsed, 10 * GB);
  assert.equal(s.ramTotal, 16 * GB);
  assert.equal(s.fnRunning, true);
  assert.equal(s.fnRam, 4718592000);
  assert.equal(s.fnCpuPct, null, 'erst ab der zweiten Messung');
  // 2 Sekunden später, 4 CPU-Sekunden mehr bei 8 Kernen = 25 %
  const line2 = JSON.parse(LINE_NVIDIA);
  line2.fn.cpu = 1204.5;
  const s2 = logic.buildSample({ ps: line2, node, now: 12000, state, logical: 8 });
  assert.equal(s2.fnCpuPct, 25);
});

test('Messung: ohne NVIDIA kommen Last und Grafikspeicher aus den Windows-Leistungsdaten', () => {
  const s = logic.buildSample({ ps: JSON.parse(LINE_AMD), node: { cpus: cpus(1, 1), totalmem: 32 * GB, freemem: 20 * GB }, now: 1, state: {} });
  assert.equal(s.gpuPct, 100);
  assert.equal(s.gpuSource, 'windows');
  assert.equal(s.gpuTemp, null, 'AMD meldet keine Temperatur an Windows');
  assert.equal(s.vramUsed, 3221225472);
  assert.equal(s.vramTotal, 12868124672);
  assert.equal(s.boardTemp, null);
  assert.equal(s.fnRunning, false);
  const caps = logic.capsFromPs(JSON.parse(LINE_AMD));
  assert.equal(caps.vendor, 'amd');
  assert.equal(caps.nvidiaSmi, false);
  assert.equal(caps.thermal, false);
});

test('Messung: ohne Windows-Daten nur Prozessor (Node) und Arbeitsspeicher', () => {
  const state = {};
  logic.buildSample({ ps: null, node: { cpus: cpus(1000, 1000), totalmem: 8 * GB, freemem: 4 * GB }, now: 0, state });
  const s = logic.buildSample({ ps: null, node: { cpus: cpus(1500, 1500), totalmem: 8 * GB, freemem: 4 * GB }, now: 2000, state });
  assert.equal(s.cpuPct, 50);
  assert.equal(s.cpuSource, 'node');
  assert.equal(s.gpuPct, null);
  assert.equal(s.fnRunning, null, 'unbekannt, nicht "läuft nicht"');
  assert.equal(s.psFresh, false);
});

// ---------------------------------------------------------------- Zusammenfassung pro Runde
test('Runde: Durchschnitt und Höchstwerte, nur vorhandene Werte zählen', () => {
  const agg = logic.newAggregate(0);
  for (let i = 0; i < 40; i++) {
    logic.addToAggregate(agg, { at: i * 2000, cpuPct: i % 2 ? 40 : 60, gpuPct: 90, gpuTemp: i < 39 ? 70 : 80, boardTemp: null, ramUsed: 8 * GB, ramTotal: 16 * GB, fnRam: 4 * GB + i });
  }
  const s = logic.finishAggregate(agg, 90000);
  assert.equal(s.durationSec, 90);
  assert.equal(s.samples, 40);
  assert.deepEqual(s.cpu, { avg: 50, max: 60 });
  assert.deepEqual(s.gpu, { avg: 90, max: 90 });
  assert.equal(s.gpuTemp.max, 80);
  assert.equal(s.gpuTemp.avg, 70.3);
  assert.equal(s.boardTemp, null);
  assert.deepEqual(s.ram, { avg: 50, max: 50 });
  assert.equal(s.fnRamMax, 4 * GB + 39);
});

test('Runde: unter einer Minute wird nicht gespeichert, höchstens 100 Runden', () => {
  const agg = logic.newAggregate(0);
  for (let i = 0; i < 20; i++) logic.addToAggregate(agg, { at: i * 2000, cpuPct: 10 });
  assert.equal(logic.finishAggregate(agg, 40000), null);
  let list = [];
  for (let i = 0; i < 105; i++) list = logic.pushSession(list, { startedAt: i });
  assert.equal(list.length, 100);
  assert.equal(list[0].startedAt, 5, 'älteste fallen weg, neueste zuletzt');
  assert.equal(list[99].startedAt, 104);
});

test('Cockpit-Zeile: letzte Grafikkarten-Temperatur oder null', () => {
  assert.equal(logic.summaryText({ gpuTemp: 66.4 }), 'Grafikkarte zuletzt 66 °C');
  assert.equal(logic.summaryText(null), null);
  assert.equal(logic.summaryText({ gpuTemp: null }), null);
});

// ---------------------------------------------------------------- Sicherheit
test('Mess-Skript liest nur – ändert nichts, fasst Anti-Cheat und Logs nicht an', () => {
  const forbidden = [/Set-Item/i, /Set-ItemProperty/i, /New-Item/i, /Remove-/i, /Stop-Process/i, /Start-Process/i, /\.Kill\(/i,
    /PriorityClass/i, /ProcessorAffinity/i, /reg(\.exe)?\s+add/i, /EasyAntiCheat/i, /BattlEye/i, /_EAC/i, /_BE\b/i, /\\Logs/i, /ReadProcessMemory/i, /Add-Type/i];
  for (const re of forbidden) assert.doesNotMatch(PS_SAMPLER, re, String(re));
  assert.match(PS_SAMPLER, /Get-Process -Name 'FortniteClient-Win64-Shipping'/);
  assert.match(PS_SAMPLER, /ConvertTo-Json -Compress/);
  // sprachneutrale CIM-Klassen statt Get-Counter (deutsche Zählernamen)
  assert.doesNotMatch(PS_SAMPLER, /Get-Counter/i);
  for (const cls of ['Win32_PerfFormattedData_PerfOS_Processor', 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine',
    'Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory', 'Win32_PerfFormattedData_Counters_ThermalZoneInformation']) {
    assert.ok(PS_SAMPLER.includes(cls), cls);
  }
});

// ---------------------------------------------------------------- Messung starten/stoppen
function fakeCtx({ isWin = true, running = false } = {}) {
  const store = {};
  const emitted = [];
  const streams = [];
  const ctx = {
    exec: {
      IS_WIN: isWin,
      powershellStream(script, onObj, onExit) {
        const s = { script, onObj, onExit, killed: false };
        streams.push(s);
        return () => { s.killed = true; };
      },
    },
    core: {
      fortniteState: { running },
      readState: async (n, fb) => (n in store ? JSON.parse(JSON.stringify(store[n])) : fb),
      writeState: async (n, o) => { store[n] = JSON.parse(JSON.stringify(o)); },
      onFortniteState() {},
    },
    emit: (name, payload) => emitted.push([name, payload]),
    log: () => {},
  };
  return { ctx, store, emitted, streams };
}

function fakeDeps() {
  const timers = [];
  let now = 1000000;
  let idle = 1000;
  let busy = 1000;
  return {
    timers,
    advance(ms) { now += ms; idle += 100; busy += 100; },
    deps: {
      now: () => now,
      setInterval: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
      clearInterval: (t) => { if (t) t.cleared = true; },
      setTimeout: (fn) => { timers.push({ fn, once: true }); return 0; },
      os: { cpus: () => cpus(idle, busy, 4), totalmem: () => 16 * GB, freemem: () => 9 * GB },
    },
  };
}

test('Monitor: Ansicht startet Skript, Zeilen werden zu Ereignissen, Schließen beendet es', async () => {
  const { ctx, emitted, streams } = fakeCtx();
  const f = fakeDeps();
  const m = new HardwareMonitor(ctx, { ...f.deps, isWin: true });
  await m.load();
  m.acquire('view');
  assert.equal(streams.length, 1);
  assert.equal(m.stream, 'starting');
  f.advance(2000);
  streams[0].onObj(JSON.parse(LINE_NVIDIA));
  assert.equal(m.stream, 'ok');
  assert.equal(emitted.length, 1);
  const [name, s] = emitted[0];
  assert.equal(name, 'hardware.sample');
  assert.equal(s.gpuTemp, 66);
  assert.equal(s.caps.vendor, 'nvidia');
  assert.equal(s.caps.nvidiaSmi, true);
  // Zeitgeber springt nicht doppelt ein, solange das Skript liefert
  f.timers[0].fn();
  assert.equal(emitted.length, 1);
  m.release('view');
  assert.equal(streams[0].killed, true);
  assert.equal(f.timers[0].cleared, true);
  assert.equal(m.stream, 'off');
  assert.equal(m.publicStatus().running, false);
});

test('Monitor: ohne Windows nur Grundwerte über den Zeitgeber, kein Skript', async () => {
  const { ctx, emitted, streams } = fakeCtx({ isWin: false });
  const f = fakeDeps();
  const m = new HardwareMonitor(ctx, { ...f.deps, isWin: false });
  await m.load();
  m.acquire('view');
  assert.equal(streams.length, 0);
  f.advance(2000);
  f.timers[0].fn();
  assert.equal(emitted.length, 1);
  const s = emitted[0][1];
  assert.equal(s.cpuSource, 'node');
  assert.equal(s.cpuPct, 50);
  assert.equal(s.ramUsed, 7 * GB);
  assert.equal(s.gpuPct, null);
  const st = m.publicStatus();
  assert.equal(st.unsupported, true);
  assert.equal(st.stream, 'unsupported');
  m.release('view');
});

test('Monitor: Skript bricht ab -> neuer Versuch, nach 3 Fehlschlägen nur Grundwerte', async () => {
  const { ctx, streams } = fakeCtx();
  const f = fakeDeps();
  const m = new HardwareMonitor(ctx, { ...f.deps, isWin: true });
  await m.load();
  m.acquire('view');
  for (let i = 0; i < 3; i++) {
    streams[streams.length - 1].onExit(1);
    assert.equal(m.stream, 'starting');
    f.timers.filter((t) => t.once).pop().fn(); // Wartezeit vorbei -> neu starten
  }
  assert.equal(streams.length, 4);
  streams[3].onExit(1);
  assert.equal(m.stream, 'failed');
  m.release('view');
});

test('Monitor: Ansicht, die sich nicht mehr meldet, stoppt die Messung', async () => {
  const { ctx, streams } = fakeCtx();
  const f = fakeDeps();
  const m = new HardwareMonitor(ctx, { ...f.deps, isWin: true });
  await m.load();
  m.acquire('view');
  f.advance(95000);
  f.timers[0].fn();
  assert.equal(m.consumers.size, 0);
  assert.equal(streams[0].killed, true);
});

test('Monitor: Hintergrund-Aufzeichnung speichert pro Fortnite-Runde eine Zusammenfassung', async () => {
  const { ctx, store, emitted } = fakeCtx({ running: false });
  const f = fakeDeps();
  const m = new HardwareMonitor(ctx, { ...f.deps, isWin: true });
  await m.load();
  // aus (Standard): nichts wird aufgezeichnet
  await m.onFortnite(true);
  assert.equal(m.session, null);
  assert.equal(m.consumers.size, 0);
  await m.setBackground(true);
  await m.onFortnite(true);
  assert.ok(m.session);
  assert.ok(m.consumers.has('background'));
  for (let i = 0; i < 40; i++) {
    f.advance(2000);
    m.onPs(JSON.parse(LINE_NVIDIA));
  }
  assert.equal(emitted.length, 0, 'ohne offene Ansicht keine Ereignisse');
  await m.onFortnite(false);
  assert.equal(m.session, null);
  assert.equal(m.consumers.size, 0);
  await m.queue;
  const st = store['tool-hardware'];
  assert.equal(st.settings.background, true);
  assert.equal(st.sessions.length, 1);
  assert.equal(st.sessions[0].gpuTemp.max, 66);
  assert.equal(st.sessions[0].durationSec, 80);
  assert.equal(st.current, null);
  assert.equal(st.last.gpuTemp, 66, 'letzte Temperatur fürs Cockpit gemerkt');
});

test('Monitor: halb aufgezeichnete Runde wird nach einem Absturz abgeschlossen', async () => {
  const { ctx, store } = fakeCtx();
  const agg = logic.newAggregate(0);
  for (let i = 0; i < 60; i++) logic.addToAggregate(agg, { at: i * 2000, cpuPct: 30 });
  store['tool-hardware'] = { settings: { background: true }, sessions: [], current: agg, last: null };
  const m = new HardwareMonitor(ctx, { ...fakeDeps().deps, isWin: true });
  const done = await m.recover();
  assert.equal(done.durationSec, 118);
  assert.equal(store['tool-hardware'].sessions[0].recovered, true);
  assert.equal(store['tool-hardware'].current, null);
});

test('Modul: Handler vorhanden, summary liefert null ohne Messung', async () => {
  mod._test.reset();
  const { ctx } = fakeCtx({ isWin: false });
  assert.equal(mod.id, 'hardware');
  for (const k of ['status', 'start', 'ping', 'stop', 'setBackground', 'sessions', 'clearSessions', 'summary']) assert.equal(typeof mod.handlers[k], 'function', k);
  assert.equal(await mod.handlers.summary({}, ctx), null);
  const st = await mod.handlers.start({}, ctx);
  assert.equal(st.unsupported, true);
  assert.equal(st.running, true);
  const r = await mod.handlers.stop({}, ctx);
  assert.equal(r.running, false);
  await mod.dispose(ctx);
  mod._test.reset();
});

// ---------------------------------------------------------------- Texte der Ansicht
test('Ansicht: Temperatur-Texte in einfachen Worten', async () => {
  const lib = await import(libUrl);
  assert.equal(lib.gpuTempStatus(72).text, '72 °C – normal für Grafikkarten unter Last.');
  assert.equal(lib.gpuTempStatus(72).type, 'ok');
  assert.equal(lib.gpuTempStatus(83).type, 'warn');
  assert.equal(lib.gpuTempStatus(90).type, 'err');
  assert.equal(lib.gpuTempStatus(null), null);
  assert.match(lib.boardTempStatus(50).text, /nicht unbedingt die Prozessor-Temperatur/);
  assert.equal(lib.boardTempStatus(50, true).word, 'ändert sich nicht');
  assert.equal(lib.ramStatus(15 * GB, 16 * GB).type, 'err');
  assert.equal(lib.ramStatus(13 * GB, 16 * GB).type, 'warn');
  assert.equal(lib.ramStatus(8 * GB, 16 * GB).type, 'ok');
  assert.equal(lib.vramStatus(7.8 * GB, 8 * GB).type, 'err');
  assert.equal(lib.cpuStatus(95).type, 'warn');
  assert.equal(lib.isFlat(Array(25).fill(27.8)), true);
  assert.equal(lib.isFlat([...Array(24).fill(27.8), 28.9]), false);
  assert.equal(lib.isFlat(Array(5).fill(27.8)), false, 'zu wenige Werte');
});

test('Ansicht: ehrliche Erklärungen, wenn Werte fehlen', async () => {
  const lib = await import(libUrl);
  const ps = JSON.parse(LINE_AMD);
  const s = logic.buildSample({ ps, node: { cpus: cpus(1, 1), totalmem: 16 * GB, freemem: 8 * GB }, now: 1, state: {} });
  s.stream = 'ok';
  const tiles = lib.buildTiles(s, [s], { windows: true, caps: logic.capsFromPs(ps) });
  const byId = Object.fromEntries(tiles.map((t) => [t.id, t]));
  assert.deepEqual(tiles.map((t) => t.id), ['cpu', 'gpu', 'gpuTemp', 'board', 'ram', 'vram', 'fortnite']);
  assert.equal(byId.gpuTemp.available, false);
  assert.equal(byId.gpuTemp.badge.text, 'nicht verfügbar');
  assert.match(byId.gpuTemp.text, /AMD-Software/);
  assert.match(byId.board.text, /Zusatz-Treiber/);
  assert.equal(byId.fortnite.badge.text, 'läuft nicht');
  assert.equal(byId.gpu.value, '100');
  for (const t of tiles) assert.ok(t.badge && t.badge.text, `${t.id} hat eine Plakette mit Text`);
  // ohne Windows
  const lin = lib.buildTiles({ cpuPct: 12, ramUsed: 4 * GB, ramTotal: 8 * GB, stream: 'unsupported' }, [], { windows: false });
  const l = Object.fromEntries(lin.map((t) => [t.id, t]));
  assert.equal(l.cpu.available, true);
  assert.equal(l.ram.value, '4,0 / 8,0');
  assert.match(l.gpuTemp.text, /nur unter Windows/);
  // NVIDIA ohne nvidia-smi
  assert.match(lib.gpuTempMissing({ vendor: 'nvidia', nvidiaSmi: false }), /nvidia-smi/);
});

test('Ansicht: NVIDIA-Kacheln mit Strom und Takt, Runden-Zeile', async () => {
  const lib = await import(libUrl);
  const s = logic.buildSample({ ps: JSON.parse(LINE_NVIDIA), node: { cpus: cpus(1, 1), totalmem: 16 * GB, freemem: 6 * GB }, now: 1, state: {} });
  s.stream = 'ok';
  const t = Object.fromEntries(lib.buildTiles(s, [s], { windows: true }).map((x) => [x.id, x]));
  assert.equal(t.gpuTemp.text, '66 °C – normal für Grafikkarten unter Last.');
  assert.equal(t.gpu.extra, '152 W Strom · 2.610 MHz Takt');
  assert.equal(t.fortnite.badge.text, 'läuft');
  assert.match(t.fortnite.text, /4,4 GB Arbeitsspeicher/);
  const row = lib.sessionRow({ cpu: { avg: 41.2, max: 63 }, gpuTemp: { avg: 70, max: 88 }, boardTemp: null, fnRamMax: 4.6 * GB });
  assert.equal(row.cpu, 'Ø 41 % · max 63 %');
  assert.equal(row.gpu, '–');
  assert.equal(row.fnRam, 'max 4,6 GB');
  assert.equal(row.hot, true);
});
