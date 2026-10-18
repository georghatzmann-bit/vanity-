'use strict';
// Tests für den PC-Check: Hardware zerlegen, Einordnung, Vorschläge, Vorschau, Schreiben mit Backup, Sicherheitsregeln.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../../src/main/tools/pccheck-logic');
const mod = require('../../src/main/modules/tools/pccheck');
const ini = require('../../src/main/core/ini');
const { CoreService } = require('../../src/main/core/service');
const { makeLocalAppData, tmpDir, fakeExec } = require('../helpers');

const GB = 1024 ** 3;
const VIEW_LIB = path.join(__dirname, '../../src/renderer/js/lib/pccheck-view.mjs');

/** Baut eine PowerShell-Antwort wie vom Scan-Skript. */
function psData({
  cpu = 'AMD Ryzen 7 7800X3D 8-Core Processor', threads = 16, cores = 8, clock = 4201,
  gpu = 'NVIDIA GeForce RTX 4070', vram = 12, pci = '10de:2786', ram = [16, 16], ramSpeed = 6000, ramRated = 4800, ramType = 34,
  refresh = 144, build = '26100',
} = {}) {
  return {
    cpu: { Name: cpu, NumberOfCores: cores, NumberOfLogicalProcessors: threads, MaxClockSpeed: clock },
    gpu: { Name: gpu, DriverVersion: '32.0.15.6636', DriverDate: '2026-09-01', AdapterCompatibility: 'X', AdapterRAM: 4293918720, PciId: pci, CurrentRefreshRate: refresh, MaxRefreshRate: refresh },
    vram: vram ? { Name: gpu, PciId: pci, Bytes: vram * GB } : null,
    ram: ram.map((g) => ({ Capacity: g * GB, ConfiguredClockSpeed: ramSpeed, Speed: ramRated, SMBIOSMemoryType: ramType })),
    os: { Caption: 'Microsoft Windows 11 Pro', BuildNumber: build },
  };
}

function disp(w = 1920, hgt = 1080, hz = 144, scale = 1) {
  return { displays: [{ id: 7, size: { width: w / scale, height: hgt / scale }, scaleFactor: scale, displayFrequency: hz }], primaryId: 7 };
}

function analyzeFor(opts = {}, d = disp()) {
  const hw = L.parseHardware(psData(opts), {}, d);
  return { hw, a: L.analyze(hw, { now: Date.parse('2026-10-18T12:00:00Z') }) };
}

const presetOf = (a, id) => a.presets.find((p) => p.id === id);
const changesOf = (p) => L.allChanges(p.items);
const valueOf = (p, key) => changesOf(p).find((c) => c.key === key)?.value;

// ---------------------------------------------------------------- Zerlegen der Rohdaten

test('asArray: Einzelobjekt, Array, null und die PowerShell-5.1-Hülle {value, Count}', () => {
  assert.deepEqual(L.asArray(null), []);
  assert.deepEqual(L.asArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(L.asArray([1, 2]), [1, 2]);
  assert.deepEqual(L.asArray({ value: [1, 2], Count: 2 }), [1, 2]);
});

test('pciId: nur Hersteller- und Modellnummer, keine Geräte-Instanz', () => {
  assert.equal(L.pciId('PCI\\VEN_10DE&DEV_2786&SUBSYS_51611462&REV_A1\\4&2F2C2C&0&0019'), '10de:2786');
  assert.equal(L.pciId('pci\\ven_1002&dev_747e'), '1002:747e');
  assert.equal(L.pciId('10DE:2786'), '10de:2786');
  assert.equal(L.pciId('ROOT\\DISPLAY\\0000'), '');
});

test('parseHardware: Einzelobjekte (ein Treffer) und echter Grafikspeicher aus der Registrierung', () => {
  const hw = L.parseHardware(psData(), {}, disp());
  assert.equal(hw.cpu.name, 'AMD Ryzen 7 7800X3D 8-Core Processor');
  assert.equal(hw.cpu.threads, 16);
  assert.equal(hw.gpu.short, 'RTX 4070');
  assert.equal(hw.gpu.vramBytes, 12 * GB, 'qwMemorySize schlägt AdapterRAM (4-GB-Grenze)');
  assert.equal(hw.gpu.vramSource, 'registry');
  assert.equal(hw.gpu.driverShown, '566.36');
  assert.equal(hw.ram.gb, 32);
  assert.equal(hw.ram.type, 'DDR5');
  assert.equal(hw.ram.modules, 2);
  assert.equal(hw.os.win11, true);
  assert.deepEqual(hw.warnings, []);
});

test('parseHardware: ohne Registrierungswert bleibt AdapterRAM, gekappt markiert', () => {
  const hw = L.parseHardware(psData({ vram: 0 }), {}, disp());
  assert.equal(hw.gpu.vramSource, 'wmi');
  assert.equal(hw.gpu.vramCapped, true);
});

test('parseHardware: mehrere Grafikkarten – virtuelle fliegen raus, die stärkste zählt', () => {
  const ps = psData();
  ps.gpu = [
    { Name: 'Intel(R) UHD Graphics 770', PciId: '8086:4680', AdapterRAM: 1073741824 },
    { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0 },
    { Name: 'Parsec Virtual Display Adapter', AdapterRAM: 0 },
    { Name: 'NVIDIA GeForce RTX 3060', PciId: '10de:2504', AdapterRAM: 4293918720 },
  ];
  ps.vram = { value: [{ Name: 'NVIDIA GeForce RTX 3060', PciId: '10de:2504', Bytes: 12 * GB }], Count: 1 };
  const hw = L.parseHardware(ps, {}, disp());
  assert.equal(hw.gpus.length, 2);
  assert.equal(hw.gpu.short, 'RTX 3060');
  assert.equal(hw.gpu.vramBytes, 12 * GB);
  assert.equal(hw.gpus[1].integrated, true);
});

test('parseHardware: PowerShell fehlgeschlagen -> Node-Werte als Ersatz, Warnungen auf Deutsch', () => {
  const hw = L.parseHardware(null, { cpus: Array.from({ length: 12 }, () => ({ model: 'Intel(R) Core(TM) i5-12400F', speed: 2500 })), totalmem: 16 * GB }, disp());
  assert.equal(hw.cpu.source, 'node');
  assert.equal(hw.cpu.threads, 12);
  assert.equal(hw.ram.gb, 16);
  assert.equal(hw.gpu, null);
  assert.ok(hw.warnings.some((w) => /Grafikkarte wurde nicht erkannt/.test(w)));
  const a = L.analyze(hw);
  assert.equal(a.presets.length, 3, 'auch ohne Grafikkarte gibt es Vorschläge');
});

test('Bildschirm: size × scaleFactor = echte Pixel, Hauptbildschirm zählt, krumme Hz werden gerundet', () => {
  const d = {
    displays: [
      { id: 1, size: { width: 1536, height: 864 }, scaleFactor: 1.25, displayFrequency: 59.94 },
      { id: 2, size: { width: 1706.6667, height: 960 }, scaleFactor: 1.5, displayFrequency: 143 },
    ],
    primaryId: 2,
  };
  const hw = L.parseHardware(psData(), {}, d);
  assert.equal(hw.display.width, 2560);
  assert.equal(hw.display.height, 1440);
  assert.equal(hw.display.hz, 144);
  assert.equal(hw.displays.find((x) => x.id === 1).hz, 60);
  assert.equal(hw.displays.find((x) => x.id === 1).width, 1920);
  // Ohne Electron-Daten: Auflösung/Hz der Grafikkarte
  const ps = psData();
  ps.gpu.CurrentHorizontalResolution = 2560;
  ps.gpu.CurrentVerticalResolution = 1440;
  const hw2 = L.parseHardware(ps, {}, {});
  assert.deepEqual([hw2.display.width, hw2.display.height, hw2.display.hz], [2560, 1440, 144]);
});

// ---------------------------------------------------------------- Grafikkarte und Prozessor einordnen

test('Grafikkarten: Stufen nach Name', () => {
  const tier = (n, vram) => L.gpuTier(L.classifyGpu(n, vram ? vram * GB : null).score);
  const cases = [
    ['NVIDIA GeForce RTX 5090', 4], ['NVIDIA GeForce RTX 4090', 4], ['NVIDIA GeForce RTX 4070 Ti SUPER', 4], ['NVIDIA GeForce RTX 4070', 4],
    ['NVIDIA GeForce RTX 5060', 3], ['NVIDIA GeForce RTX 3060', 3], ['NVIDIA GeForce RTX 2060 SUPER', 3], ['NVIDIA GeForce RTX 3050', 2],
    ['NVIDIA GeForce GTX 1660 SUPER', 2], ['NVIDIA GeForce GTX 1060 6GB', 2], ['NVIDIA GeForce GTX 1050 Ti', 2], ['NVIDIA GeForce GTX 970', 2],
    ['NVIDIA GeForce GT 1030', 1],
    ['AMD Radeon RX 9070 XT', 4], ['AMD Radeon RX 7900 XTX', 4], ['AMD Radeon RX 7800 XT', 4], ['AMD Radeon RX 6600', 3],
    ['AMD Radeon RX 5700 XT', 3], ['Radeon RX 580 Series', 2], ['AMD Radeon RX 6500 XT', 2],
    ['Intel(R) Arc(TM) A770 Graphics', 3], ['Intel(R) Arc(TM) B580 Graphics', 3], ['Intel(R) Arc(TM) A380 Graphics', 2],
    ['Intel(R) UHD Graphics 620', 1], ['Intel(R) Iris(R) Xe Graphics', 1], ['AMD Radeon(TM) Graphics', 1],
    ['AMD Radeon 780M Graphics', 2], ['AMD Radeon 890M Graphics', 2], ['AMD Radeon(TM) 680M', 2], ['Intel(R) Arc(TM) Graphics', 1],
  ];
  for (const [n, t] of cases) assert.equal(tier(n), t, n);
});

test('Grafikkarten: eingebaut, Laptop, Reflex und unbekannte Modelle', () => {
  const iris = L.classifyGpu('Intel(R) Iris(R) Xe Graphics');
  assert.equal(iris.integrated, true);
  assert.equal(L.classifyGpu('AMD Radeon 780M Graphics').integrated, true);
  assert.equal(L.classifyGpu('AMD Radeon(TM) Graphics').integrated, true);
  const lap = L.classifyGpu('NVIDIA GeForce RTX 4060 Laptop GPU');
  const desk = L.classifyGpu('NVIDIA GeForce RTX 4060');
  assert.equal(lap.mobile, true);
  assert.ok(lap.score < desk.score, 'Laptop-Variante ist schwächer');
  assert.equal(desk.reflex, true);
  assert.equal(L.classifyGpu('NVIDIA GeForce GTX 970').reflex, true);
  assert.equal(L.classifyGpu('NVIDIA GeForce GTX 750 Ti').reflex, false);
  assert.equal(L.classifyGpu('AMD Radeon RX 7800 XT').reflex, false);
  const unk = L.classifyGpu('Contoso Graphix 9000', 8 * GB);
  assert.equal(unk.known, false);
  assert.equal(L.gpuTier(unk.score), 3, 'unbekannt: Einschätzung über den Grafikspeicher');
  assert.equal(L.shortGpuName('NVIDIA GeForce RTX 4070'), 'RTX 4070');
  assert.equal(L.shortGpuName('AMD Radeon RX 7800 XT'), 'RX 7800 XT');
  assert.equal(L.shortGpuName('Intel(R) Arc(TM) A770 Graphics'), 'Arc A770');
});

test('Prozessoren: Stufen nach Name und Threads', () => {
  const tier = (name, threads) => L.cpuTier(L.classifyCpu({ name, threads }).score);
  assert.equal(tier('AMD Ryzen 7 7800X3D 8-Core Processor', 16), 4);
  assert.equal(tier('AMD Ryzen 7 9800X3D 8-Core Processor', 16), 4);
  assert.equal(tier('Intel(R) Core(TM) i5-12400F', 12), 3);
  assert.equal(tier('Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz', 12), 3);
  assert.equal(tier('Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', 8), 2);
  assert.equal(tier('Intel(R) Core(TM) i5-4460 CPU @ 3.20GHz', 4), 1);
  assert.equal(tier('Intel(R) Celeron(R) N4020 CPU @ 1.10GHz', 2), 1);
  assert.equal(L.classifyCpu({ name: 'Intel(R) Core(TM) Ultra 7 155H', threads: 22 }).known, true);
  assert.equal(L.classifyCpu({ name: 'Mystery CPU', threads: 8, clockMHz: 3600 }).known, false);
  assert.equal(L.shortCpuName('Intel(R) Core(TM) i7-8700K CPU @ 3.70GHz'), 'Intel Core i7-8700K');
  assert.equal(L.shortCpuName('AMD Ryzen 5 7600X 6-Core Processor             '), 'AMD Ryzen 5 7600X');
});

test('Leistungsklasse: Grafikkarte zählt am meisten, Prozessor und RAM bremsen', () => {
  assert.equal(L.performanceClass({ gpuScore: 50, cpuScore: 99, ramGB: 32 }).cls, 4);
  const cpuBound = L.performanceClass({ gpuScore: 100, cpuScore: 40, ramGB: 32 });
  assert.equal(cpuBound.cls, 2);
  assert.equal(cpuBound.limiter, 'cpu');
  const ramBound = L.performanceClass({ gpuScore: 50, cpuScore: 99, ramGB: 8 });
  assert.equal(ramBound.cls, 2);
  assert.equal(ramBound.limiter, 'ram');
  assert.equal(L.performanceClass({ gpuScore: 2, cpuScore: 99, ramGB: 16 }).limiter, 'gpu');
});

test('Einschätzung RAM und Monitor: Tipps für einen Riegel, Grundtempo und zu niedrige Hz', () => {
  const r = L.rateRam({ gb: 16, modules: 1, type: 'DDR4', speedMTs: 2133, ratedMTs: 2133 });
  assert.equal(r.label, 'gut');
  assert.ok(r.tips.some((t) => t.kind === 'dual'));
  assert.ok(r.tips.some((t) => t.kind === 'xmp'));
  assert.equal(L.rateRam({ gb: 8 }).label, 'knapp');
  assert.equal(L.rateRam({ gb: 4 }).tone, 'err');
  const d = L.rateDisplay({ width: 1920, height: 1080, hz: 60 }, [{}], { maxRefreshHz: 144 });
  assert.ok(d.tips.some((t) => t.kind === 'hz'));
  assert.equal(L.rateDisplay(null).label, 'unbekannt');
});

// ---------------------------------------------------------------- Vorschläge

test('Vorschläge: Darstellungsmodus – Leistung = Leistungsmodus (dx12 + es31 + Meshes niedrig), sonst DirectX 12, nie DirectX 11', () => {
  const { a } = analyzeFor();
  const lei = presetOf(a, 'leistung');
  assert.equal(valueOf(lei, 'PreferredRHI'), 'dx12');
  assert.equal(valueOf(lei, 'PreferredFeatureLevel'), 'es31');
  assert.deepEqual(changesOf(lei).find((c) => c.key === 'MeshQuality'), { section: 'PerformanceMode', key: 'MeshQuality', value: '0' });
  for (const id of ['ausgewogen', 'qualitaet']) {
    const p = presetOf(a, id);
    assert.equal(valueOf(p, 'PreferredRHI'), 'dx12');
    assert.equal(valueOf(p, 'PreferredFeatureLevel'), 'sm6');
    assert.equal(valueOf(p, 'MeshQuality'), undefined);
  }
  for (const p of a.presets) for (const c of changesOf(p)) assert.doesNotMatch(String(c.value), /^(dx11|sm5)$/i, `${p.id}: ${c.key}`);
});

test('Vorschläge: Auflösung = Monitor, alle Paare passen zusammen, echtes Vollbild', () => {
  const { a } = analyzeFor({}, disp(2560, 1440, 165, 1.25));
  for (const p of a.presets) {
    for (const k of ['ResolutionSizeX', 'LastUserConfirmedResolutionSizeX', 'DesiredScreenWidth', 'LastUserConfirmedDesiredScreenWidth']) assert.equal(valueOf(p, k), '2560', `${p.id} ${k}`);
    for (const k of ['ResolutionSizeY', 'LastUserConfirmedResolutionSizeY', 'DesiredScreenHeight', 'LastUserConfirmedDesiredScreenHeight']) assert.equal(valueOf(p, k), '1440', `${p.id} ${k}`);
    for (const k of ['FullscreenMode', 'LastConfirmedFullscreenMode', 'PreferredFullscreenMode']) assert.equal(valueOf(p, k), '0');
  }
});

test('Vorschläge: Fortnite-Schreibweise (240.000000, True/False), feste Aus-Schalter und gültige Stufen', () => {
  const { a } = analyzeFor();
  for (const p of a.presets) {
    assert.match(valueOf(p, 'FrameRateLimit'), /^\d+\.000000$/);
    assert.equal(valueOf(p, 'bUseVSync'), 'False');
    assert.equal(valueOf(p, 'bMotionBlur'), 'False');
    assert.equal(valueOf(p, 'bRayTracing'), 'False');
    assert.equal(valueOf(p, 'sg.ResolutionQuality'), '100');
    for (const c of changesOf(p)) {
      if (/^b[A-Z]/.test(c.key)) assert.match(c.value, /^(True|False)$/, c.key);
      if (/^sg\./.test(c.key) && c.key !== 'sg.ResolutionQuality') assert.match(c.value, /^[0-3]$/, c.key);
      assert.ok([L.FGUS, L.SG, L.RHI, L.PERF].includes(c.section), `nur bekannte Abschnitte: ${c.section}`);
      assert.doesNotMatch(c.key, /[\r\n=[\]]/);
      assert.doesNotMatch(String(c.value), /[\r\n]/);
    }
  }
  assert.equal(valueOf(presetOf(a, 'leistung'), 'bShowGrass'), 'False');
  assert.equal(valueOf(presetOf(a, 'leistung'), 'FortAntiAliasingMethod'), 'Disabled');
  assert.equal(valueOf(presetOf(a, 'qualitaet'), 'FortAntiAliasingMethod'), 'TSRMedium');
});

test('Vorschläge: jede Zeile hat eine deutsche Erklärung ohne Platzhalter', () => {
  for (const opts of [{}, { gpu: 'Intel(R) UHD Graphics 620', vram: 0, ram: [8], cpu: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', threads: 8 }]) {
    const { a } = analyzeFor(opts);
    for (const p of a.presets) {
      for (const it of p.items) {
        assert.ok(it.label && it.why && it.why.length > 20, `${p.id}/${it.id}`);
        assert.doesNotMatch(it.why, /undefined|null|NaN|\[object/, `${p.id}/${it.id}: ${it.why}`);
      }
      assert.doesNotMatch(p.fps.why, /undefined|NaN/);
    }
  }
});

test('Reflex nur für NVIDIA (LatencyTweak2 = 2), Nanite nur bei Qualität auf starken Karten', () => {
  const nv = analyzeFor().a;
  for (const p of nv.presets) assert.equal(valueOf(p, 'LatencyTweak2'), '2');
  const amd = analyzeFor({ gpu: 'AMD Radeon RX 7800 XT', vram: 16, pci: '1002:747e' }).a;
  for (const p of amd.presets) assert.equal(valueOf(p, 'LatencyTweak2'), undefined, 'kein Reflex bei AMD');
  assert.equal(valueOf(presetOf(nv, 'qualitaet'), 'bUseNanite'), 'True');
  assert.equal(valueOf(presetOf(nv, 'ausgewogen'), 'bUseNanite'), 'False');
  assert.equal(valueOf(presetOf(nv, 'leistung'), 'bUseNanite'), 'False');
  const weak = analyzeFor({ gpu: 'NVIDIA GeForce GTX 1650', vram: 4 }).a;
  assert.equal(valueOf(presetOf(weak, 'qualitaet'), 'bUseNanite'), 'False');
  assert.match(presetOf(nv, 'qualitaet').items.find((i) => i.id === 'aa').why, /DLSS/);
  assert.doesNotMatch(presetOf(amd, 'qualitaet').items.find((i) => i.id === 'aa').why, /DLSS/);
});

test('FPS-Grenze: unbegrenzt nur auf sehr starken PCs, sonst Monitor-Hz oder eine sichere Grenze', () => {
  const strong = analyzeFor().a;
  assert.equal(presetOf(strong, 'leistung').fps.cap, 0);
  assert.equal(valueOf(presetOf(strong, 'leistung'), 'FrameRateLimit'), '0.000000');
  assert.equal(presetOf(strong, 'ausgewogen').fps.cap, 144);
  const mid = analyzeFor({ gpu: 'NVIDIA GeForce GTX 1650', vram: 4, cpu: 'Intel(R) Core(TM) i5-9400F CPU @ 2.90GHz', threads: 6, ram: [8, 8] }, disp(1920, 1080, 144)).a;
  for (const p of mid.presets) {
    assert.notEqual(p.fps.cap, 0, `${p.id}: nicht unbegrenzt`);
    assert.ok(p.fps.cap <= 144);
  }
  const weak = analyzeFor({ gpu: 'Intel(R) UHD Graphics 620', vram: 0, ram: [8], cpu: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', threads: 8 }, disp(1920, 1080, 60)).a;
  assert.ok(presetOf(weak, 'leistung').fps.cap > 0 && presetOf(weak, 'leistung').fps.cap <= 60);
  // Vom Nutzer gewählte Grenze
  const hw = L.parseHardware(psData(), {}, disp());
  const over = L.analyze(hw, { fpsOverride: { leistung: 240 } });
  assert.equal(presetOf(over, 'leistung').fps.cap, 240);
  assert.equal(presetOf(over, 'leistung').fps.reason, 'user');
  assert.equal(valueOf(presetOf(over, 'leistung'), 'FrameRateLimit'), '240.000000');
  assert.equal(L.validFpsCap(0), true);
  assert.equal(L.validFpsCap(144), true);
  assert.equal(L.validFpsCap(5), false);
  assert.equal(L.validFpsCap(144.5), false);
});

test('Empfehlung: starker PC an 144 Hz -> Ausgewogen; schwacher PC oder zu wenig RAM -> Leistung', () => {
  assert.equal(analyzeFor().a.recommended, 'ausgewogen');
  assert.equal(analyzeFor({ gpu: 'Intel(R) UHD Graphics 620', vram: 0, ram: [8], cpu: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', threads: 8 }).a.recommended, 'leistung');
  assert.equal(analyzeFor({ ram: [4] }).a.recommended, 'leistung');
  assert.equal(analyzeFor({}, disp(1920, 1080, 60)).a.recommended, 'qualitaet');
  const { a } = analyzeFor();
  assert.equal(a.presets.filter((p) => p.recommended).length, 1);
  assert.ok(a.recommendReason.length > 20);
  assert.ok(a.competitiveTip);
});

// ---------------------------------------------------------------- Vorschau

function previewFrom(changes, current) {
  return { rel: 'WindowsClient/GameUserSettings.ini', readOnly: false, changes: changes.map((c) => ({ ...c, from: current[c.key] ?? null, to: c.value })) };
}

test('Vorschau: lesbare Werte, gleiche Werte in anderer Schreibweise zählen nicht als Änderung', () => {
  const { a } = analyzeFor();
  const p = presetOf(a, 'ausgewogen');
  const current = {
    PreferredRHI: 'dx11', PreferredFeatureLevel: 'sm5', FrameRateLimit: '144', 'sg.ResolutionQuality': '100.000000', bUseVSync: 'false',
    ResolutionSizeX: '1920', ResolutionSizeY: '1080', LastUserConfirmedResolutionSizeX: '1920', LastUserConfirmedResolutionSizeY: '1080',
    DesiredScreenWidth: '1920', DesiredScreenHeight: '1080', LastUserConfirmedDesiredScreenWidth: '1920', LastUserConfirmedDesiredScreenHeight: '1080',
  };
  const rows = L.buildRows(p.items, previewFrom(changesOf(p), current));
  const row = (id) => rows.find((r) => r.id === id);
  assert.equal(row('renderMode').from, 'DirectX 11 (alt)');
  assert.equal(row('renderMode').to, 'DirectX 12');
  assert.equal(row('renderMode').changed, true);
  assert.equal(row('fps').changed, false, '144 = 144.000000');
  assert.equal(row('fps').to, '144 FPS');
  assert.equal(row('res3d').changed, false, '100 = 100.000000');
  assert.equal(row('vsync').changed, false, 'false = False');
  assert.equal(row('resolution').changed, false);
  assert.equal(row('shadows').from, 'nicht gesetzt');
  const writes = L.changesToWrite(p.items, previewFrom(changesOf(p), current));
  assert.ok(!writes.some((c) => c.key === 'FrameRateLimit' || c.key === 'sg.ResolutionQuality' || c.key === 'bUseVSync'));
  assert.ok(writes.some((c) => c.key === 'PreferredFeatureLevel' && c.value === 'sm6'));
});

test('Vorschau: abgewählte Zeilen werden nicht geschrieben, gestreckte Auflösung bekommt einen Hinweis', () => {
  const { a } = analyzeFor();
  const p = presetOf(a, 'leistung');
  const current = { ResolutionSizeX: '1440', ResolutionSizeY: '1080', LastUserConfirmedResolutionSizeX: '1440', LastUserConfirmedResolutionSizeY: '1080' };
  const pv = previewFrom(changesOf(p), current);
  const rows = L.buildRows(p.items, pv);
  assert.match(rows.find((r) => r.id === 'resolution').note, /gestreckte Auflösung/);
  const all = L.changesToWrite(p.items, pv);
  const skipped = L.changesToWrite(p.items, pv, ['resolution', 'grass']);
  assert.ok(all.some((c) => c.key === 'ResolutionSizeX'));
  assert.ok(!skipped.some((c) => /^(ResolutionSize|LastUserConfirmed|DesiredScreen)|^bShowGrass$/.test(c.key)));
  assert.ok(skipped.some((c) => c.key === 'DesiredGlobalIlluminationQuality'), 'anderes bleibt drin');
  assert.equal(L.renderModeText('dx12', 'es31'), 'Leistungsmodus');
});

test('Cockpit-Zeile: Grafikkarte und Empfehlung bzw. übernommener Vorschlag', () => {
  assert.equal(L.summaryText({}), null);
  assert.equal(L.summaryText({ lastScan: { gpuShort: 'RTX 4070', recommended: 'ausgewogen' } }), 'RTX 4070 · empfohlen: Ausgewogen');
  assert.equal(L.summaryText({ lastScan: { gpuShort: 'RTX 4070', recommended: 'ausgewogen' }, lastApplied: { preset: 'leistung' } }), 'RTX 4070 · übernommen: Leistung');
});

// ---------------------------------------------------------------- Modul mit nachgemachtem Windows

function fakeScreen(w = 1920, hgt = 1080, hz = 144) {
  return { getAllDisplays: () => disp(w, hgt, hz).displays, getPrimaryDisplay: () => ({ id: 7 }) };
}

function moduleCtx({ core, ps = psData(), isWin = true, psError = null } = {}) {
  const scripts = [];
  return {
    core,
    log() {},
    emit() {},
    scripts,
    exec: {
      IS_WIN: isWin,
      async powershell(script, opts) {
        scripts.push({ script, opts });
        if (psError) throw psError;
        return ps;
      },
    },
    electron: { screen: fakeScreen() },
  };
}

function memCore(extra = {}) {
  const state = {};
  return {
    state,
    async readState(n, fb) { return n in state ? JSON.parse(JSON.stringify(state[n])) : fb; },
    async writeState(n, o) { state[n] = JSON.parse(JSON.stringify(o)); },
    async fortniteStatus() { return { running: false, processes: [] }; },
    ...extra,
  };
}

test('Modul: nicht unter Windows -> freundliche Meldung statt Fehler, Cockpit-Zeile null', async () => {
  mod._test.resetCache();
  const ctx = moduleCtx({ core: memCore(), isWin: false });
  const r = await mod.handlers.scan({}, ctx);
  assert.equal(r.unsupported, true);
  assert.match(r.message, /Windows/);
  assert.equal(ctx.scripts.length, 0);
  assert.equal(await mod.handlers.summary({}, ctx), null);
});

test('Modul: Scan mit nachgemachter PowerShell, Ergebnis wird gemerkt und für das Cockpit gespeichert', async () => {
  mod._test.resetCache();
  const core = memCore();
  const ctx = moduleCtx({ core });
  const r = await mod.handlers.scan({ fresh: true }, ctx);
  assert.equal(r.unsupported, false);
  assert.equal(r.hardware.gpu.short, 'RTX 4070');
  assert.equal(r.recommended, 'ausgewogen');
  assert.equal(r.presets.length, 3);
  assert.ok(r.presets.every((p) => !('items' in p)), 'die Rohdaten der Einträge bleiben im Hauptprozess');
  assert.equal(ctx.scripts[0].opts.json, true);
  assert.equal(core.state['tool-pccheck'].lastScan.gpuShort, 'RTX 4070');
  assert.deepEqual(await mod.handlers.summary({}, ctx), { text: 'RTX 4070 · empfohlen: Ausgewogen' });
  await mod.handlers.scan({}, ctx);
  assert.equal(ctx.scripts.length, 1, 'ohne fresh wird die Messung wiederverwendet');
  await mod.handlers.scan({ fresh: true }, ctx);
  assert.equal(ctx.scripts.length, 2);
});

test('Modul: PowerShell-Fehler -> Node-Werte und eine Warnung, kein Absturz', async () => {
  mod._test.resetCache();
  const err = Object.assign(new Error('x'), { code: 'EXEC_FAILED' });
  const r = await mod.handlers.scan({ fresh: true }, moduleCtx({ core: memCore(), psError: err }));
  assert.equal(r.unsupported, false);
  assert.ok(r.warnings.some((w) => /nicht alle Hardware-Daten/.test(w)));
  assert.ok(r.hardware.cpu.name, 'Prozessor kommt aus os.cpus()');
});

test('Modul: falsche Angaben werden abgelehnt', async () => {
  assert.throws(() => mod._test.checkArgs({ preset: 'turbo' }), (e) => e.code === 'BAD_ARG');
  assert.throws(() => mod._test.checkArgs({ preset: 'leistung', fpsCap: 7 }), (e) => e.code === 'BAD_ARG');
  assert.throws(() => mod._test.checkArgs({ preset: 'leistung', fpsCap: '144; rm' }), (e) => e.code === 'BAD_ARG');
  assert.deepEqual(mod._test.checkArgs({ preset: 'leistung', fpsCap: 0 }), { preset: 'leistung', fpsCap: 0 });
});

test('Modul mit echtem Kern: Vorschau, Übernehmen mit Backup, nur GameUserSettings.ini wird geändert', async () => {
  mod._test.resetCache();
  const fx = makeLocalAppData();
  const engineBefore = fs.readFileSync(path.join(fx.wc, 'Engine.ini'), 'utf8');
  const core = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec() });
  await core.init();
  const ctx = moduleCtx({ core });
  await mod.handlers.scan({ fresh: true }, ctx);

  const pv = await mod.handlers.preview({ preset: 'ausgewogen' }, ctx);
  assert.equal(pv.rel, 'WindowsClient/GameUserSettings.ini');
  assert.ok(pv.rows.length > 10);
  const rm = pv.rows.find((r) => r.id === 'renderMode');
  assert.equal(rm.from, 'Leistungsmodus', 'Testdatei: dx11 + es31 = alter Leistungsmodus');
  assert.equal(rm.to, 'DirectX 12');
  assert.equal(pv.fortnite.running, false);
  for (const r of pv.rows) assert.ok(r.why && r.label && r.group);

  const backupsBefore = (await core.backups.list()).length;
  const res = await mod.handlers.apply({ preset: 'ausgewogen', fpsCap: 120, skip: ['grass', 'unbekannt'] }, ctx);
  assert.ok(res.applied > 3);
  assert.ok(res.keys >= res.applied);
  assert.deepEqual(res.skipped, ['grass']);
  assert.equal((await core.backups.list()).length, backupsBefore + 1, 'vorher wurde ein Backup gemacht');
  // nicht nach Position suchen: das Original-Backup kann in derselben Millisekunde entstanden sein
  const backup = (await core.listBackups()).find((b) => b.reason !== 'original');
  assert.match(backup.label, /^PC-Check: Vorschlag „Ausgewogen“$/);

  const text = fs.readFileSync(path.join(fx.wc, 'GameUserSettings.ini'), 'utf8');
  const doc = ini.parse(text);
  assert.equal(ini.get(doc, 'D3DRHIPreference', 'PreferredRHI'), 'dx12');
  assert.equal(ini.get(doc, 'D3DRHIPreference', 'PreferredFeatureLevel'), 'sm6');
  assert.equal(ini.get(doc, L.FGUS, 'FrameRateLimit'), '120.000000');
  assert.equal(ini.get(doc, L.FGUS, 'LatencyTweak2'), '2');
  assert.equal(ini.get(doc, L.FGUS, 'bShowGrass'), 'False', 'abgewählt: Gras bleibt wie es war');
  assert.equal(ini.get(doc, L.FGUS, 'bDisableMouseAcceleration'), 'True', 'fremde Werte bleiben');
  assert.match(text, /\r\n/, 'Zeilenenden bleiben CRLF');
  assert.equal(fs.readFileSync(path.join(fx.wc, 'Engine.ini'), 'utf8'), engineBefore, 'Engine.ini bleibt unberührt');

  const again = await mod.handlers.preview({ preset: 'ausgewogen', fpsCap: 120 }, ctx);
  assert.deepEqual(again.rows.filter((r) => r.changed).map((r) => r.id), ['grass'], 'danach ist nur noch das Abgewählte offen');
  const none = await mod.handlers.apply({ preset: 'ausgewogen', fpsCap: 120, skip: ['grass'] }, ctx);
  assert.equal(none.nothing, true);
  assert.equal((await mod.handlers.summary({}, ctx)).text, 'RTX 4070 · übernommen: Ausgewogen');
});

test('Modul mit echtem Kern: Fortnite läuft -> FORTNITE_RUNNING, Datei bleibt gleich', async () => {
  mod._test.resetCache();
  const fx = makeLocalAppData();
  const running = { value: ['FortniteClient-Win64-Shipping.exe'] };
  const core = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec(running) });
  await core.init();
  const ctx = moduleCtx({ core });
  await mod.handlers.scan({ fresh: true }, ctx);
  const before = fs.readFileSync(path.join(fx.wc, 'GameUserSettings.ini'));
  const pv = await mod.handlers.preview({ preset: 'leistung' }, ctx);
  assert.equal(pv.fortnite.running, true);
  await assert.rejects(() => mod.handlers.apply({ preset: 'leistung' }, ctx), (e) => e.code === 'FORTNITE_RUNNING');
  assert.deepEqual(fs.readFileSync(path.join(fx.wc, 'GameUserSettings.ini')), before);
});

test('Modul mit echtem Kern: fehlende GameUserSettings.ini -> NO_FILE', async () => {
  mod._test.resetCache();
  const fx = makeLocalAppData();
  fs.rmSync(path.join(fx.wc, 'GameUserSettings.ini'));
  const core = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec() });
  await core.init();
  const ctx = moduleCtx({ core });
  await mod.handlers.scan({ fresh: true }, ctx);
  await assert.rejects(() => mod.handlers.preview({ preset: 'leistung' }, ctx), (e) => e.code === 'NO_FILE');
  await assert.rejects(() => mod.handlers.apply({ preset: 'leistung' }, ctx), (e) => e.code === 'NO_FILE');
});

// ---------------------------------------------------------------- Sicherheitsregeln

test('Sicherheit: das Scan-Skript liest nur (CIM + Registrierung), gibt JSON aus und keine Geräte-Instanzen weiter', () => {
  const s = mod._test.PS_SCAN;
  assert.match(s, /ConvertTo-Json -Compress/);
  for (const cls of ['Win32_Processor', 'Win32_VideoController', 'Win32_PhysicalMemory', 'Win32_OperatingSystem', 'HardwareInformation.qwMemorySize']) assert.ok(s.includes(cls), cls);
  assert.match(s, /HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\\{4d36e968-e325-11ce-bfc1-08002be10318\}/);
  assert.doesNotMatch(s, /\b(Set|New|Remove|Rename|Clear|Copy|Move)-Item|Set-Content|Out-File|Add-Content|Stop-Process|Start-Process|Invoke-WebRequest|Invoke-RestMethod|reg(\.exe)?\s+add|Invoke-Expression|\biex\b/i);
  assert.doesNotMatch(s, /EasyAntiCheat|BattlEye|BEService|Fortnite|Logs|SerialNumber|UUID|MACAddress|ProcessorId/i);
  assert.doesNotMatch(s, /PNPDeviceID\s*=/, 'nur VEN/DEV wird weitergegeben');
});

test('Sicherheit: das Modul schreibt nur über ctx.core.applyIniChanges in GameUserSettings.ini', () => {
  const src = fs.readFileSync(require.resolve('../../src/main/modules/tools/pccheck.js'), 'utf8');
  const logicSrc = fs.readFileSync(require.resolve('../../src/main/tools/pccheck-logic.js'), 'utf8');
  for (const t of [src, logicSrc]) {
    assert.doesNotMatch(t, /writeFile|appendFile|unlink|rmSync|\.rm\(|writeValue|child_process|Engine\.ini'|setPriority|affinity/);
  }
  assert.match(src, /applyIniChanges\(FILE, changes, \{ reason: 'tool', label:/);
  assert.match(src, /const FILE = 'GameUserSettings\.ini'/);
  assert.equal((src.match(/applyIniChanges\(/g) || []).length, 1);
  // Fortnite-Prozess wird nie angefasst (Schließen gibt es nur über den Kern, ausgelöst vom Nutzer)
  assert.doesNotMatch(src + logicSrc, /closeFortnite|taskkill|processes\.close/);
});

// ---------------------------------------------------------------- Helfer der Ansicht (ES-Modul)

test('Ansicht: Bildzeit, FPS-Erklärung und Zeitleiste', async () => {
  const v = await import(VIEW_LIB);
  assert.equal(v.frameTimeMs(0), null);
  assert.ok(Math.abs(v.frameTimeMs(144) - 6.944) < 0.01);
  assert.equal(v.fmtMs(1000 / 60), '16,7 ms');
  assert.equal(v.fpsLabel(0), 'Unbegrenzt');
  assert.equal(v.fpsLabel(240), '240 FPS');
  const same = v.fpsExplain({ cap: 144, hz: 144, est: { low: 200, typical: 260 } });
  assert.equal(same.tone, 'ok');
  assert.match(same.lines[0], /6,9 ms/);
  const unl = v.fpsExplain({ cap: 0, hz: 165, est: { low: 300, typical: 400 } });
  assert.equal(unl.gameRate, 400);
  assert.match(unl.lines.join(' '), /165 pro Sekunde/);
  const tooHigh = v.fpsExplain({ cap: 240, hz: 144, est: { low: 150, typical: 200 } });
  assert.equal(tooHigh.tone, 'warn');
  assert.match(tooHigh.lines.at(-1), /150 FPS/);
  const below = v.fpsExplain({ cap: 60, hz: 144, est: { low: 70, typical: 90 } });
  assert.match(below.title, /gleichmäßig/);
  assert.equal(v.timelineTicks(100, 50).length, 5);
  assert.deepEqual(v.timelineTicks(100, 50).slice(0, 2), [0, 20]);
  assert.equal(v.timelineTicks(0, 50).length, 0);
  assert.equal(v.timelineTicks(1000, 50, 10).length, 10);
});

test('Ansicht: Gruppen, Zähler und Anzeigestufen', async () => {
  const v = await import(VIEW_LIB);
  const rows = [
    { id: 'aa', group: 'Grafik', changed: true }, { id: 'fps', group: 'Anzeige', changed: true },
    { id: 'grass', group: 'Extras', changed: false }, { id: 'x', group: 'Sonstiges', changed: true },
  ];
  assert.deepEqual(v.groupRows(rows).map((g) => g.group), ['Anzeige', 'Grafik', 'Extras', 'Sonstiges']);
  assert.equal(v.countWrites(rows, new Set(['aa'])), 2);
  assert.equal(v.meterLevel('gpu', { tier: 4 }), 4);
  assert.equal(v.meterLevel('ram', {}, { gb: 8 }), 2);
  assert.equal(v.meterLevel('display', {}, { hz: 165 }), 3);
  assert.equal(v.estText({ typical: 270, low: 200 }), 'ca. 270 FPS');
  assert.equal(v.estFightText({ low: 200 }), 'in großen Kämpfen ca. 200 FPS');
});
