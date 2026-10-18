'use strict';
// Tests für den Monitor-Tuner: Testbild-Berechnungen, Sturm-Test, Inhalte der Einrichtung,
// Grafikkarten-Erkennung (mit nachgemachter PowerShell-Ausgabe) und das Starten von dccw.exe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const logic = require('../../src/main/tools/monitor-logic');
const monitor = require('../../src/main/modules/tools/monitor');

const LIB = path.join(__dirname, '../../src/renderer/js/lib');
let pat;
let guide;
test.before(async () => {
  pat = await import(pathToFileURL(path.join(LIB, 'monitor-patterns.mjs')).href);
  guide = await import(pathToFileURL(path.join(LIB, 'monitor-guide.mjs')).href);
});

/** Nachgemachter Canvas-Kontext: merkt sich alle Aufrufe. */
function fakeCtx() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'top', imageSmoothingEnabled: true,
    measureText: (t) => ({ width: String(t).length * 7 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  for (const m of ['fillRect', 'strokeRect', 'fillText', 'beginPath', 'arc', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'setTransform', 'save', 'restore']) {
    ctx[m] = (...args) => calls.push({ m, args, fillStyle: ctx.fillStyle });
  }
  return ctx;
}

// ---------------------------------------------------------------- Testbilder
test('Stufen: Schwarzwert 0–25, Weißwert 230–255, Verlauf 32 Stufen von 0 bis 255', () => {
  assert.deepEqual(pat.blackLevels(), Array.from({ length: 26 }, (_, i) => i));
  assert.equal(pat.whiteLevels()[0], 230);
  assert.equal(pat.whiteLevels().at(-1), 255);
  const s = pat.contrastSteps(32);
  assert.equal(s.length, 32);
  assert.equal(s[0], 0);
  assert.equal(s.at(-1), 255);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], 'streng steigend');
});

test('Gamma: festes Grau, das bei Gamma g so hell wirkt wie das Streifenmuster', () => {
  assert.equal(pat.gammaGrey(2.2), 186);
  assert.equal(pat.gammaGrey(1), 128);
  assert.equal(pat.gammaGrey(1.8), 174);
  assert.equal(pat.gammaGrey(2.6), 195);
  const g = pat.GAMMA_TARGETS.map(pat.gammaGrey);
  for (let i = 1; i < g.length; i++) assert.ok(g[i] > g[i - 1]);
  assert.ok(pat.GAMMA_TARGETS.includes(2.2));
});

test('Gamma-Feld: 1-Pixel-Linien im Wechsel und die feste Fläche in der Mitte', () => {
  const ctx = fakeCtx();
  pat.drawGammaPatch(ctx, 10, 20, 100, 2.2);
  const lines = ctx.calls.filter((c) => c.m === 'fillRect' && c.args[3] === 1);
  assert.equal(lines.length, 50, 'jede zweite Zeile weiß');
  assert.ok(lines.every((c) => c.fillStyle === '#fff' && Number.isInteger(c.args[1])));
  assert.deepEqual(lines.slice(0, 3).map((c) => c.args[1]), [20, 22, 24]);
  const inner = ctx.calls.at(-1);
  assert.equal(inner.fillStyle, 'rgb(186,186,186)');
});

test('Canvas-Größe in echten Pixeln (Windows-Skalierung 125 %)', () => {
  assert.deepEqual(pat.backingSize(960, 540, 1.25), { w: 1200, h: 675, dpr: 1.25 });
  assert.deepEqual(pat.backingSize(1920, 1080, 1), { w: 1920, h: 1080, dpr: 1 });
  assert.deepEqual(pat.backingSize(100, 50, NaN), { w: 100, h: 50, dpr: 1 });
  assert.deepEqual(pat.backingSize(0, 0, 2), { w: 1, h: 1, dpr: 2 });
});

test('Alle Testbilder lassen sich zeichnen (auch mit Hinweis), unbekannte Namen fallen auf Schwarzwert zurück', () => {
  for (const p of pat.PATTERNS) {
    const ctx = fakeCtx();
    assert.equal(pat.drawPattern(ctx, p.id, 1600, 900, { variant: 'dunkel', scene: pat.stormScene(7), reveal: true, hint: ['Titel', 'Zweite Zeile'], dpr: 1.5 }), p.id);
    assert.ok(ctx.calls.length > 1, p.id);
    assert.equal(ctx.imageSmoothingEnabled, false, 'keine Glättung');
    assert.ok(p.name && p.instruction.length > 20, `${p.id} hat eine Anleitung`);
  }
  assert.equal(pat.drawPattern(fakeCtx(), 'gibtsnicht', 100, 100), 'schwarz');
  const ctx = fakeCtx();
  pat.drawPattern(ctx, 'ausleuchtung', 200, 100, { variant: 'schwarz' });
  assert.deepEqual(ctx.calls[1].args, [0, 0, 200, 100]);
  assert.equal(ctx.calls[1].fillStyle, 'rgb(0,0,0)');
  assert.ok(pat.findPattern('schwarz').instruction.includes('Stufe 3–4'));
});

test('Wechseln mit den Pfeiltasten läuft im Kreis', () => {
  const ids = pat.PATTERNS.map((p) => p.id);
  assert.equal(pat.nextPatternId(ids[0], 1), ids[1]);
  assert.equal(pat.nextPatternId(ids[0], -1), ids.at(-1));
  assert.equal(pat.nextPatternId(ids.at(-1), 1), ids[0]);
  assert.equal(pat.nextPatternId('unbekannt', 1), ids[1]);
});

test('Zeilenumbruch für den Hinweis im Vollbild', () => {
  const m = (t) => t.length * 10;
  assert.deepEqual(pat.wrapText('eins zwei drei vier', 90, m), ['eins zwei', 'drei vier']);
  assert.deepEqual(pat.wrapText('', 90, m), []);
  assert.deepEqual(pat.wrapText('sehrlangeswortohnepause', 50, m), ['sehrlangeswortohnepause']);
});

// ---------------------------------------------------------------- Sturm-Test
test('Sturm-Szene: gleicher Startwert = gleiches Bild, 5–9 Figuren, schwer bis leicht', () => {
  assert.deepEqual(pat.stormScene(42), pat.stormScene(42));
  const totals = new Set();
  for (let seed = 1; seed < 400; seed++) {
    const s = pat.stormScene(seed);
    totals.add(s.total);
    assert.ok(s.total >= 5 && s.total <= 9);
    assert.equal(s.figures.length, s.total);
    const cs = s.figures.map((f) => f.contrast);
    assert.ok(cs.every((c) => pat.STORM_CONTRASTS.includes(c)));
    assert.equal(Math.min(...cs), pat.STORM_CONTRASTS[0], 'immer eine sehr schwere Figur');
    assert.equal(Math.max(...cs), pat.STORM_CONTRASTS.at(-1), 'immer eine leichte Figur');
    for (const f of s.figures) {
      assert.ok(f.x > 0 && f.x < 1 && f.y > 0.3 && f.y < 0.85);
      assert.ok(f.y - f.size > 0.05, 'Figur ganz im Bild');
    }
    // Figuren überlappen nicht (eigene Plätze)
    const slots = s.figures.map((f) => `${Math.floor(f.x * 5)}-${f.y < 0.6 ? 0 : 1}`);
    assert.equal(new Set(slots).size, slots.length);
  }
  assert.deepEqual([...totals].sort(), [5, 6, 7, 8, 9]);
});

test('Sturm-Test: Bewertung', () => {
  assert.equal(pat.rateStorm(8, 8).level, 'ok');
  assert.equal(pat.rateStorm(6, 7).level, 'ok');
  assert.equal(pat.rateStorm(5, 8).level, 'warn');
  assert.equal(pat.rateStorm(2, 8).level, 'err');
  assert.match(pat.rateStorm(2, 8).text, /2 von 8/);
  assert.equal(pat.rateStorm(10, 8).label, 'zu viele');
  assert.equal(pat.rateStorm(-1, 8), null);
  assert.equal(pat.rateStorm('x', 8), null);
  assert.equal(pat.stormDifficulty(4), 'sehr schwer');
  assert.equal(pat.stormDifficulty(38), 'leicht');
});

// ---------------------------------------------------------------- Einrichtung
test('Einrichtung: fünf Schritte in der richtigen Reihenfolge, jeder Punkt mit Erklärung', () => {
  assert.deepEqual(guide.STEPS.map((s) => s.id), ['osd', 'windows', 'treiber', 'fortnite', 'kontrolle']);
  const ids = [];
  for (const s of guide.STEPS) {
    assert.ok(s.title && s.intro, s.id);
    const all = s.vendors ? Object.values(s.vendors).flat() : s.checks;
    for (const c of all) {
      ids.push(c.id);
      assert.ok(c.label && c.hint && c.hint.length > 20, c.id);
      assert.ok(/^[a-z][a-z0-9-]{0,31}$/.test(c.id), 'passt zur Prüfung im Hauptprozess');
      if (c.action?.type === 'settings') assert.match(c.action.uri, /^ms-settings:[a-z0-9-]+$/i, 'von app.openWindowsSettings erlaubt');
    }
    for (const p of s.patterns) assert.ok(pat.PATTERNS.some((x) => x.id === p), p);
  }
  assert.equal(new Set(ids).size, ids.length, 'IDs eindeutig');
  assert.deepEqual(Object.keys(guide.STEPS[2].vendors), ['nvidia', 'amd', 'intel']);
  const nv = guide.STEPS[2].vendors.nvidia.map((c) => `${c.label} ${c.hint}`).join(' ');
  assert.match(nv, /60 bis 80 %/);
  assert.match(nv, /Voll/);
  const win = guide.STEPS[1].checks;
  assert.ok(win.some((c) => c.action?.uri === 'ms-settings:display'));
  assert.ok(win.some((c) => c.action?.type === 'calibration'));
  assert.ok(win.some((c) => c.action?.type === 'hdrStore'));
  assert.ok(guide.STEPS[3].checks.some((c) => c.action?.type === 'nav' && c.action.to === 'sicht'));
  const osd = guide.STEPS[0].checks.map((c) => c.label).join(' ');
  assert.match(osd, /Dynamischen Kontrast/);
  assert.match(osd, /Eco/);
});

test('Einrichtung: Marken-Namen des Schwarz-Stabilisators', () => {
  const names = guide.BRANDS.map((b) => `${b.brand}: ${b.name}`).join(' | ');
  for (const n of ['Black eQualizer', 'Shadow Boost', 'Black Stabilizer', 'Dark Stabilizer']) assert.ok(names.includes(n), n);
  assert.ok(guide.BRANDS.every((b) => b.tip));
});

test('Einrichtung: Fortschritt zählt nur die Punkte des gewählten Herstellers', () => {
  const nv = guide.progress({}, 'nvidia');
  const amd = guide.progress({}, 'amd');
  assert.equal(nv.done, 0);
  assert.equal(nv.total, 6 + 5 + 3 + 3);
  assert.equal(amd.total, 6 + 5 + 3 + 3);
  assert.equal(guide.progress({}, 'intel').total, 6 + 5 + 2 + 3);
  const p = guide.progress({ mode: true, dcr: true, 'amd-sat': true, unbekannt: true }, 'nvidia');
  assert.equal(p.done, 2, 'AMD-Haken zählt bei NVIDIA nicht');
  assert.equal(p.pct, Math.round((2 / 17) * 100));
  assert.equal(guide.stepChecks(guide.STEPS[2], 'gibtsnicht'), guide.STEPS[2].vendors.nvidia);
});

// ---------------------------------------------------------------- Hauptprozess: Hilfen
test('Grafikkarte aus PowerShell-JSON erkennen (eigene Karte vor Intel)', () => {
  const both = logic.parseAdapters([
    { Name: 'Intel(R) UHD Graphics 770', AdapterCompatibility: 'Intel Corporation', PNPDeviceID: 'PCI\\VEN_8086&DEV_4680' },
    { Name: 'NVIDIA GeForce RTX 4070', AdapterCompatibility: 'NVIDIA', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2786' },
  ]);
  assert.equal(both.length, 2);
  assert.equal(logic.pickVendor(both), 'nvidia');
  assert.equal(logic.pickVendor(logic.parseAdapters({ Name: 'AMD Radeon RX 7800 XT', AdapterCompatibility: 'Advanced Micro Devices, Inc.', PNPDeviceID: 'PCI\\VEN_1002&DEV_747E' })), 'amd');
  assert.equal(logic.pickVendor(logic.parseAdapters([{ Name: 'Intel(R) Arc(TM) A770', PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0' }])), 'intel');
  assert.equal(logic.pickVendor(logic.parseAdapters([{ Name: 'Microsoft Basic Display Adapter', PNPDeviceID: 'ROOT\\BASICDISPLAY' }])), null);
  assert.deepEqual(logic.parseAdapters(null), []);
  assert.deepEqual(logic.parseAdapters('kaputt'), []);
  assert.deepEqual(logic.parseAdapters([null, 5, {}]), []);
});

test('dccw.exe-Pfad nur aus Umgebungsvariablen', () => {
  assert.equal(logic.dccwPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\dccw.exe');
  assert.equal(logic.dccwPath({ windir: 'C:\\WINDOWS' }), 'C:\\WINDOWS\\System32\\dccw.exe');
  assert.equal(logic.dccwPath({}), 'dccw.exe');
});

test('Cockpit-Zeile und Datum', () => {
  assert.equal(logic.summaryText({}), null);
  assert.equal(logic.summaryText(null), null);
  const at = new Date(2026, 9, 18, 12, 0).getTime();
  assert.deepEqual(logic.summaryText({ wizard: { completedAt: at } }), { text: 'Monitor eingerichtet am 18.10.2026' });
  assert.deepEqual(logic.summaryText({ wizard: { completedAt: at }, stormTests: [{ seen: 3, total: 9 }, { seen: 6, total: 7 }] }), { text: 'Monitor eingerichtet am 18.10.2026 · Sturm-Test 6 von 7' });
  assert.deepEqual(logic.summaryText({ stormTests: [{ seen: 5, total: 8 }] }), { text: 'Sturm-Test 5 von 8' });
  assert.equal(logic.fmtDay('kein Datum'), null);
});

test('Eingaben aus der Oberfläche werden gesäubert', () => {
  assert.deepEqual(logic.cleanChecks({ mode: true, dcr: false, 'nv-range': true, 'Böse Taste': true, x: 'ja', __proto__: true }), { mode: true, 'nv-range': true });
  assert.deepEqual(logic.cleanChecks(null), {});
  assert.deepEqual(logic.cleanStormTest({ seen: 6, total: 8 }), { seen: 6, total: 8 });
  assert.equal(logic.cleanStormTest({ seen: -1, total: 8 }), null);
  assert.equal(logic.cleanStormTest({ seen: 3, total: 0 }), null);
  assert.equal(logic.cleanStormTest({ seen: 'x', total: 8 }), null);
});

// ---------------------------------------------------------------- Hauptprozess: Handler
function memCore() {
  const store = {};
  return {
    store,
    readState: async (n, fb) => (n in store ? JSON.parse(JSON.stringify(store[n])) : fb),
    writeState: async (n, o) => { store[n] = JSON.parse(JSON.stringify(o)); },
  };
}

function ctxFor({ win = true, powershell, openExternal } = {}) {
  const opened = [];
  return {
    opened,
    core: memCore(),
    env: { SystemRoot: 'C:\\Windows' },
    exec: { IS_WIN: win, powershell: powershell || (async () => { throw Object.assign(new Error('x'), { code: 'NOT_WINDOWS' }); }) },
    electron: { shell: { openExternal: openExternal || (async (u) => { opened.push(u); }) } },
    log: () => {},
  };
}

function fakeSpawn({ fail = false } = {}) {
  const calls = [];
  const fn = (file, args, opts) => {
    const child = new EventEmitter();
    child.pid = 4321;
    child.unrefCalled = false;
    child.unref = () => { child.unrefCalled = true; };
    calls.push({ file, args, opts, child });
    process.nextTick(() => (fail ? child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : child.emit('spawn')));
    return child;
  };
  fn.calls = calls;
  return fn;
}

test('Farbkalibrierung: startet dccw.exe sichtbar und unabhängig – sonst NOT_WINDOWS', async () => {
  const orig = monitor._test.deps.spawn;
  try {
    const sp = fakeSpawn();
    monitor._test.deps.spawn = sp;
    assert.deepEqual(await monitor.handlers.openCalibration({}, ctxFor()), { started: true });
    assert.equal(sp.calls.length, 1);
    assert.equal(sp.calls[0].file, 'C:\\Windows\\System32\\dccw.exe');
    assert.deepEqual(sp.calls[0].args, []);
    assert.equal(sp.calls[0].opts.detached, true);
    assert.equal(sp.calls[0].opts.windowsHide, false);
    assert.equal(sp.calls[0].opts.shell, false);
    assert.equal(sp.calls[0].child.unrefCalled, true);

    monitor._test.deps.spawn = fakeSpawn({ fail: true });
    await assert.rejects(() => monitor.handlers.openCalibration({}, ctxFor()), (e) => e.code === 'START_FAILED' && /Startmenü/.test(e.message));

    const sp2 = fakeSpawn();
    monitor._test.deps.spawn = sp2;
    await assert.rejects(() => monitor.handlers.openCalibration({}, ctxFor({ win: false })), (e) => e.code === 'NOT_WINDOWS');
    assert.equal(sp2.calls.length, 0, 'unter Linux wird nichts gestartet');
  } finally {
    monitor._test.deps.spawn = orig;
  }
});

test('HDR-Kalibrierung: öffnet nur die feste Store-Seite', async () => {
  const ctx = ctxFor();
  assert.deepEqual(await monitor.handlers.openHdrStore({ uri: 'https://boese.example' }, ctx), { opened: true });
  assert.deepEqual(ctx.opened, [monitor._test.HDR_STORE_URI]);
  assert.match(monitor._test.HDR_STORE_URI, /^ms-windows-store:\/\/pdp\/\?ProductId=9N7F2SM5D1LR$/);
  await assert.rejects(() => monitor.handlers.openHdrStore({}, ctxFor({ win: false })), (e) => e.code === 'NOT_WINDOWS');
});

test('Grafikkarte erkennen: JSON aus PowerShell, freundlich ohne Windows oder bei Fehlern', async () => {
  let script = null;
  const ok = await monitor.handlers.detectGpu({}, ctxFor({
    powershell: async (s, o) => { script = s; assert.equal(o.json, true); return [{ Name: 'NVIDIA GeForce RTX 3060', AdapterCompatibility: 'NVIDIA', PNPDeviceID: 'PCI\\VEN_10DE&DEV_2504' }]; },
  }));
  assert.deepEqual(ok, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', adapters: ['NVIDIA GeForce RTX 3060'] });
  assert.match(script, /Get-CimInstance -ClassName Win32_VideoController/);
  assert.match(script, /ConvertTo-Json/);
  assert.doesNotMatch(script, /Set-|Remove-|New-Item|Invoke-WebRequest|reg(\.exe)? add/i, 'nur lesen');
  assert.deepEqual(await monitor.handlers.detectGpu({}, ctxFor({ win: false })), { unsupported: true, vendor: null, adapters: [] });
  assert.deepEqual(await monitor.handlers.detectGpu({}, ctxFor({ powershell: async () => { throw Object.assign(new Error('weg'), { code: 'EXEC_FAILED' }); } })), { vendor: null, adapters: [], failed: true });
  assert.deepEqual(await monitor.handlers.detectGpu({}, ctxFor({ powershell: async () => null })), { vendor: null, name: null, adapters: [] });
  const two = await monitor.handlers.detectGpu({}, ctxFor({ powershell: async () => [{ Name: 'Intel(R) UHD Graphics', PNPDeviceID: 'PCI\\VEN_8086&DEV_1' }, { Name: 'AMD Radeon RX 6600', PNPDeviceID: 'PCI\\VEN_1002&DEV_2' }] }));
  assert.equal(two.vendor, 'amd');
  assert.equal(two.name, 'AMD Radeon RX 6600', 'Name der eigentlichen Karte, nicht der Intel-Grafik');
});

test('Fortschritt, Sturm-Tests und Cockpit-Zeile werden im Zustand tool-monitor gespeichert', async () => {
  const ctx = ctxFor();
  assert.equal(await monitor.handlers.summary({}, ctx), null);
  const w = await monitor.handlers.saveWizard({ checks: { mode: true, 'bad key': true }, step: 9, vendor: 'amd' }, ctx);
  assert.deepEqual(w.checks, { mode: true });
  assert.equal(w.step, 4, 'auf letzten Schritt begrenzt');
  assert.equal(w.vendor, 'amd');
  assert.equal(w.completedAt, undefined);
  assert.equal(await monitor.handlers.summary({}, ctx), null);
  const done = await monitor.handlers.saveWizard({ checks: {}, step: 4, vendor: 'quatsch', done: true }, ctx);
  assert.equal(done.vendor, 'amd', 'unbekannter Hersteller behält den alten');
  assert.ok(done.completedAt > 0);
  await monitor.handlers.saveStormTest({ seen: 6, total: 8 }, ctx);
  await assert.rejects(() => monitor.handlers.saveStormTest({ seen: 3, total: 100 }, ctx), (e) => e.code === 'BAD_ARG');
  const st = await monitor.handlers.state({}, ctx);
  assert.equal(st.stormTests.length, 1);
  assert.equal(st.wizard.completedAt, done.completedAt);
  const sum = await monitor.handlers.summary({}, ctx);
  assert.match(sum.text, /^Monitor eingerichtet am \d{2}\.\d{2}\.\d{4} · Sturm-Test 6 von 8$/);
  assert.ok(ctx.core.store['tool-monitor']);
  for (let i = 0; i < 60; i++) await monitor.handlers.saveStormTest({ seen: 1, total: 5 }, ctx);
  assert.equal((await monitor.handlers.state({}, ctx)).stormTests.length, 50, 'höchstens 50 Einträge');
  // gleichzeitig gespeichert: nichts geht verloren
  const ctx2 = ctxFor();
  await Promise.all([
    monitor.handlers.saveWizard({ checks: { mode: true }, step: 1 }, ctx2),
    monitor.handlers.saveStormTest({ seen: 4, total: 6 }, ctx2),
    monitor.handlers.saveWizard({ checks: { mode: true, dcr: true }, step: 2 }, ctx2),
    monitor.handlers.saveStormTest({ seen: 5, total: 6 }, ctx2),
  ]);
  const st2 = await monitor.handlers.state({}, ctx2);
  assert.equal(st2.stormTests.length, 2);
  assert.deepEqual(st2.wizard.checks, { mode: true, dcr: true });
});

test('Modul: id, Handler und keine verbotenen Dinge', () => {
  assert.equal(monitor.id, 'monitor');
  assert.deepEqual(Object.keys(monitor.handlers).sort(), ['detectGpu', 'openCalibration', 'openHdrStore', 'saveStormTest', 'saveWizard', 'state', 'summary']);
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/modules/tools/monitor.js'), 'utf8');
  assert.doesNotMatch(src, /writeValue|applyIniChanges|taskkill|Fortnite.*\.exe|C:\\\\Windows/i);
});

// ---------------------------------------------------------------- Ansicht (nachgemachte Oberfläche)
// Ein sehr kleines Element-Modell statt eines Browsers: reicht, um die Ansicht zu laden, Knöpfe zu drücken,
// das Vollbild nachzuspielen und zu prüfen, welches Testbild gezeigt wird. ui kommt wie in der App über env.ui.

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.cls = new Set();
    this.text = '';
    this.ctx = null;
  }
  get classList() {
    const s = this.cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, on = !s.has(c)) => { if (on) s.add(c); else s.delete(c); return on; },
      contains: (c) => s.has(c),
    };
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.tagName === '#TEXT' ? this.text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { [...this.children].forEach((c) => this.removeChild(c)); if (v != null && v !== '') this.append(v); }
  appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs.flat(Infinity)) if (c != null && c !== false) this.appendChild(c instanceof FakeEl ? c : textNode(c)); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    n.parentNode?.removeChild(n);
    p.children[p.children.indexOf(this)] = n;
    n.parentNode = p;
    this.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { return Promise.all((this.listeners.click || []).map((f) => f({ currentTarget: this, target: this, preventDefault() {} }))); }
  matches(sel) { const [tag, ...cls] = sel.split('.'); return (!tag || this.tagName === tag.toUpperCase()) && cls.every((c) => this.cls.has(c)); }
  querySelectorAll(sel) { return findAll(this, (e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() {}
  // Canvas
  getBoundingClientRect() { return { width: 640, height: 360 }; }
  getContext() { this.ctx ||= fakeCtx(); return this.ctx; }
  async requestFullscreen() { fakeDoc.fullscreenElement = this; fakeDoc.fire('fullscreenchange'); }
}
const textNode = (v) => Object.assign(new FakeEl('#text'), { text: String(v) });
function findAll(root, pred) {
  const out = [];
  const walk = (e) => { for (const c of e.children) { if (pred(c)) out.push(c); walk(c); } };
  walk(root);
  return out;
}
const byClass = (root, c) => findAll(root, (e) => e.cls.has(c));
const buttonsWith = (root, re) => findAll(root, (e) => e.tagName === 'BUTTON' && re.test(e.textContent));
const tick = () => new Promise((r) => setTimeout(r, 0));

/** document/window mit Vollbild und Tastatur zum Nachspielen. */
function fakeTarget() {
  const l = {};
  return {
    l,
    addEventListener(t, f) { (l[t] ||= []).push(f); },
    removeEventListener(t, f) { l[t] = (l[t] || []).filter((x) => x !== f); },
    fire(t, e = {}) { for (const f of [...(l[t] || [])]) f(e); },
  };
}
const fakeDoc = Object.assign(fakeTarget(), {
  fullscreenElement: null,
  body: new FakeEl('body'),
  async exitFullscreen() { fakeDoc.fullscreenElement = null; fakeDoc.fire('fullscreenchange'); },
});
const fakeWin = Object.assign(fakeTarget(), { devicePixelRatio: 1 });
const press = (key) => fakeWin.fire('keydown', { key, preventDefault() {}, stopImmediatePropagation() {} });

function fakeUi() {
  const toasts = [];
  const h = (spec, attrs, ...children) => {
    if (attrs == null || typeof attrs !== 'object' || attrs instanceof FakeEl || Array.isArray(attrs)) {
      if (attrs != null) children.unshift(attrs);
      attrs = {};
    }
    const [tag, ...classes] = String(spec).split('.');
    const el = new FakeEl(tag || 'div');
    classes.filter(Boolean).forEach((c) => el.cls.add(c));
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v);
    }
    el.append(children);
    return el;
  };
  const clear = (el) => { [...el.children].forEach((c) => el.removeChild(c)); return el; };
  const ui = {
    h, clear,
    icon: () => new FakeEl('svg'),
    mount: (el, ...c) => { clear(el); el.append(c); return el; },
    button(label, { onClick, variant = '', disabled } = {}) {
      const b = h(`button.btn${variant ? `.${variant}` : ''}`, { disabled }, label ? h('span', label) : null);
      if (onClick) b.addEventListener('click', (e) => onClick(e));
      return b;
    },
    toast: (msg, type = 'ok') => { toasts.push({ msg, type }); },
    showError: (e, title) => { toasts.push({ msg: `${title || 'Fehler'}: ${e.message}`, type: 'err' }); },
    badge: (t) => h('span.badge', t),
    more: (summary, ...c) => h('details.more', h('summary', summary), c.map((x) => (typeof x === 'string' ? h('p', x) : x))),
    fmtAgo: () => 'gerade eben',
    fmtDate: () => 'heute',
  };
  return { ui, toasts };
}

/** Lädt die Ansicht (als .mjs-Kopie, damit Node sie ohne "type": "module" als ES-Modul liest). */
async function loadMonitorView() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-view-'));
  fs.mkdirSync(path.join(dir, 'views'));
  fs.mkdirSync(path.join(dir, 'lib'));
  const src = path.join(__dirname, '../../src/renderer/js/views/monitor.js');
  for (const m of fs.readFileSync(src, 'utf8').matchAll(/from '\.\.\/lib\/([\w-]+\.mjs)'/g)) {
    fs.copyFileSync(path.join(LIB, m[1]), path.join(dir, 'lib', m[1]));
  }
  fs.copyFileSync(src, path.join(dir, 'views', 'monitor.mjs'));
  return (await import(pathToFileURL(path.join(dir, 'views', 'monitor.mjs')).href)).default;
}

test('Ansicht: Kontrolle bleibt beim Sturm-Test – auch nach Vollbild und Pfeiltaste', async (t) => {
  const view = await loadMonitorView();
  const globals = { document: fakeDoc, window: fakeWin, requestAnimationFrame: (f) => setTimeout(f, 0), ResizeObserver: class { observe() {} disconnect() {} } };
  const saved = {};
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  t.after(async () => {
    view.unmount();
    await new Promise((r) => setTimeout(r, 20));
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  });
  const { ui } = fakeUi();
  const env = {
    ui,
    nav: { go() {} },
    async call(name) {
      if (name === 'monitor.state') return { wizard: { step: guide.STEPS.findIndex((s) => s.id === 'kontrolle'), checks: {} }, stormTests: [] };
      if (name === 'monitor.detectGpu') return { vendor: 'nvidia', name: 'NVIDIA GeForce' };
      return {};
    },
  };
  const root = new FakeEl('div');
  await view.mount(root, env);
  const sturm = pat.findPattern('sturm').name;
  const label = (c) => c.getAttribute('aria-label') || '';
  const hintTexts = (c) => c.ctx.calls.filter((x) => x.m === 'fillText').map((x) => String(x.args[0])).join(' | ');

  // Testbilder-Tab: dort wechseln die Pfeiltasten im Vollbild weiterhin das Bild
  const mainCanvas = findAll(root, (e) => e.tagName === 'CANVAS')[0];
  await buttonsWith(root, /^Vollbild$/)[0].click();
  const first = label(mainCanvas);
  press('ArrowRight');
  assert.notEqual(label(mainCanvas), first, 'Testbilder: Pfeiltaste wechselt das Bild');
  press('Escape');
  assert.equal(fakeDoc.fullscreenElement, null);

  // Geführte Einrichtung -> Schritt „Kontrolle“
  await buttonsWith(root, /Geführte Einrichtung/)[0].click();
  await tick();
  const control = byClass(root, 'mon-control')[0];
  assert.ok(control, 'Schritt Kontrolle offen');
  const canvas = findAll(control, (e) => e.tagName === 'CANVAS')[0];
  await buttonsWith(control, /^Vollbild$/)[0].click();
  assert.equal(fakeDoc.fullscreenElement, canvas);
  assert.match(label(canvas), new RegExp(`^Testbild ${sturm}`));
  assert.match(hintTexts(canvas), /Esc beendet das Vollbild/);
  assert.doesNotMatch(hintTexts(canvas), /Pfeiltasten/, 'kein Hinweis auf Bildwechsel, den es hier nicht gibt');
  press('ArrowRight');
  press('ArrowLeft');
  press(' ');
  assert.match(label(canvas), new RegExp(`^Testbild ${sturm}`), 'im Vollbild bleibt der Sturm-Test');
  press('Escape');
  assert.equal(fakeDoc.fullscreenElement, null);
  assert.match(label(canvas), new RegExp(`^Testbild ${sturm}`), 'nach dem Vollbild: Sturm-Test, passend zur Frage daneben');
  assert.match(control.textContent, /Wie viele Figuren erkennst du\?/);
});
