'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const L = require('../../src/main/tools/maus-logic');
const mod = require('../../src/main/modules/tools/maus');
const { HelixError } = require('../../src/main/sys/exec');
const { CoreService } = require('../../src/main/core/service');
const { makeLocalAppData, tmpDir, fakeExec } = require('../helpers');

const MEASURE = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'lib', 'maus-measure.mjs');
const measure = () => import(MEASURE);

const REG_ON = {
  MouseSensitivity: { type: 'REG_SZ', value: '10' },
  MouseSpeed: { type: 'REG_SZ', value: '1' },
  MouseThreshold1: { type: 'REG_SZ', value: '6' },
  MouseThreshold2: { type: 'REG_SZ', value: '10' },
  DoubleClickSpeed: { type: 'REG_SZ', value: '500' },
};

/** Nachgebautes ctx: Registry im Speicher, PowerShell-Antwort einstellbar, Zustand im Speicher. */
function fakeCtx({ reg = REG_ON, win = true, psResult, psThrows = false } = {}) {
  const store = new Map();
  const log = [];
  const regData = { ...reg };
  const ctx = {
    exec: {
      IS_WIN: win,
      powershell: async (script, opts) => {
        log.push(['ps', script, opts]);
        if (psThrows) throw new HelixError('EXEC_FAILED', 'PowerShell blockiert');
        if (psResult) return psResult;
        // so antwortet Windows nach erfolgreichem SystemParametersInfo
        const m = script.match(/\[int\[\]\]\((\d+),(\d+),(\d+)\)/);
        const s = script.match(/\[IntPtr\](\d+)/);
        return { setMouse: true, setSpeed: true, threshold1: +m[1], threshold2: +m[2], accel: +m[3], speed: +s[1] };
      },
    },
    registry: {
      readKey: async (key) => {
        log.push(['read', key]);
        if (!win) throw new HelixError('NOT_WINDOWS', 'Die Registrierung gibt es nur unter Windows.');
        return regData;
      },
      writeValue: async (key, name, type, value) => {
        log.push(['write', key, name, type, value]);
        if (!/^HKCU\\/i.test(key)) throw new HelixError('REG_DENIED', 'nur HKCU');
        regData[name] = { type, value: String(value) };
      },
    },
    core: {
      readState: async (name, fb) => (store.has(name) ? JSON.parse(store.get(name)) : fb),
      writeState: async (name, obj) => { log.push(['state', name]); store.set(name, JSON.stringify(obj)); },
    },
    log: () => {},
  };
  return { ctx, store, log, regData };
}

// ---------------------------------------------------------------- Parser & Bewertung

test('maus: Registry-Werte (REG_SZ und DWORD) werden zu Zahlen, fehlende zu null', () => {
  const v = L.parseMouseValues({ MouseSensitivity: { type: 'REG_SZ', value: ' 14 ' }, MouseSpeed: { type: 'REG_DWORD', value: 0 }, MouseThreshold1: { type: 'REG_SZ', value: 'abc' } });
  assert.deepEqual(v, { MouseSensitivity: 14, MouseSpeed: 0, MouseThreshold1: null, MouseThreshold2: null });
  assert.deepEqual(L.parseMouseValues(null), { MouseSensitivity: null, MouseSpeed: null, MouseThreshold1: null, MouseThreshold2: null });
});

test('maus: Stufen im Windows-Regler (11 Stufen)', () => {
  assert.equal(L.notchInfo(1).label, '1/11');
  assert.equal(L.notchInfo(2).label, '2/11');
  assert.equal(L.notchInfo(4).label, '3/11');
  assert.equal(L.notchInfo(10).label, '6/11');
  assert.equal(L.notchInfo(20).label, '11/11');
  assert.equal(L.notchInfo(3).label, 'zwischen 2/11 und 3/11');
  assert.equal(L.notchInfo(3).exact, false);
  assert.equal(L.notchInfo(0).notch, null);
  assert.equal(L.notchInfo(21).notch, null);
  assert.equal(L.speedFactor(10), 1);
  assert.equal(L.speedFactor(6), 0.5);
});

test('maus: Bewertung – Windows-Standard hat Beschleunigung an, 6/11 + 0/0/0 ist optimal', () => {
  const std = L.evaluate(L.parseMouseValues(REG_ON));
  assert.equal(std.speed.ok, true);
  assert.equal(std.accel.on, true);
  assert.equal(std.allOk, false);
  const best = L.evaluate({ MouseSensitivity: 10, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 });
  assert.equal(best.allOk, true);
  const slow = L.evaluate({ MouseSensitivity: 8, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 });
  assert.equal(slow.speed.ok, false);
  assert.equal(slow.speed.label, '5/11');
  // fehlende Werte = Windows-Standard (Beschleunigung an)
  assert.equal(L.evaluate({}).accel.on, true);
});

test('maus: Korrektur plant nur, was gewählt ist und sich wirklich ändert', () => {
  const cur = { MouseSensitivity: 14, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 };
  const both = L.planFix(cur);
  assert.deepEqual(both.target, { MouseSensitivity: 10, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 });
  assert.deepEqual(both.changes.map((c) => c.name), ['MouseSensitivity', 'MouseSpeed', 'MouseThreshold1', 'MouseThreshold2']);
  const onlySpeed = L.planFix(cur, { accel: false });
  assert.deepEqual(onlySpeed.changes, [{ name: 'MouseSensitivity', from: 14, to: 10 }]);
  assert.equal(onlySpeed.target.MouseSpeed, 1, 'Beschleunigung bleibt');
  const onlyAccel = L.planFix(cur, { speed: false });
  assert.deepEqual(onlyAccel.changes.map((c) => c.name), ['MouseSpeed', 'MouseThreshold1', 'MouseThreshold2']);
  assert.equal(L.planFix({ MouseSensitivity: 10, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 }).changes.length, 0);
});

test('maus: PowerShell-Skript nutzt SPI_SETMOUSE mit {T1,T2,Beschleunigung} und SPI_SETMOUSESPEED mit Wert, Flags 3', () => {
  const off = L.spiScript({ MouseSensitivity: 10, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 });
  assert.match(off, /SystemParametersInfo\(0x0004, 0, \[int\[\]\]\(0,0,0\), \$F\)/);
  assert.match(off, /SystemParametersInfoPtr\(0x0071, 0, \[IntPtr\]10, \$F\)/);
  assert.match(off, /\$F = 3\r\n/);
  assert.match(off, /ConvertTo-Json -Compress/);
  assert.match(off, /\r\n'@\r\n/, 'Ende des Here-Strings steht am Zeilenanfang');
  // Rückgängig auf Windows-Standard: Registry 1/6/10 -> SPI-Reihenfolge {6,10,1}
  const on = L.spiScript({ MouseSensitivity: 12, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 });
  assert.match(on, /\[int\[\]\]\(6,10,1\)/);
  assert.match(on, /\[IntPtr\]12/);
  // nur geprüfte ganze Zahlen – nichts kann eingeschleust werden
  assert.throws(() => L.spiScript({ MouseSensitivity: '10); Remove-Item C:\\ #', MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 }), RangeError);
  assert.throws(() => L.spiScript({ MouseSensitivity: 25, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 }), RangeError);
  assert.throws(() => L.spiScript({ MouseSensitivity: 10, MouseSpeed: 3, MouseThreshold1: 0, MouseThreshold2: 0 }), RangeError);
});

test('maus: Antwort von SystemParametersInfo wird geprüft', () => {
  const t = { MouseSensitivity: 10, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 };
  assert.equal(L.parseSpiResult({ setMouse: true, setSpeed: true, threshold1: 0, threshold2: 0, accel: 0, speed: 10 }, t).live, true);
  assert.equal(L.parseSpiResult({ setMouse: true, setSpeed: false, threshold1: 0, threshold2: 0, accel: 0, speed: 10 }, t).live, false);
  assert.equal(L.parseSpiResult({ setMouse: true, setSpeed: true, threshold1: 6, threshold2: 10, accel: 1, speed: 10 }, t).live, false);
  assert.equal(L.parseSpiResult(null, t).live, false);
});

test('maus: Rückgängig behält den Stand vor der ersten HELIX-Änderung', () => {
  const orig = { MouseSensitivity: 14, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 };
  const p1 = L.planFix(orig, { accel: false });
  const u1 = L.nextUndo(null, orig, p1, 1);
  assert.deepEqual(u1.before, orig);
  const now = { ...orig, MouseSensitivity: 10 };
  const p2 = L.planFix(now, { speed: false });
  const u2 = L.nextUndo(u1, now, p2, 2);
  assert.deepEqual(u2.before, orig, 'Original bleibt');
  assert.deepEqual(u2.changes.map((c) => [c.name, c.from, c.to]), [['MouseSensitivity', 14, 10], ['MouseSpeed', 1, 0], ['MouseThreshold1', 6, 0], ['MouseThreshold2', 10, 0]]);
  // Hat jemand dazwischen selbst etwas geändert, gilt der neue Stand als Vorher-Stand
  const manual = { MouseSensitivity: 6, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 };
  const u3 = L.nextUndo(u1, manual, L.planFix(manual), 3);
  assert.deepEqual(u3.before, manual);
});

test('maus: Fortnite-Wert lesen', () => {
  assert.deepEqual(L.fortniteAccelInfo('True'), { value: 'True', disabled: true, ok: true });
  assert.deepEqual(L.fortniteAccelInfo('false'), { value: 'false', disabled: false, ok: false });
  assert.deepEqual(L.fortniteAccelInfo(null), { value: null, disabled: null, ok: null });
  assert.deepEqual(L.fortniteChange(true), [{ section: '/Script/FortniteGame.FortGameUserSettings', key: 'bDisableMouseAcceleration', value: 'True' }]);
  assert.equal(L.fortniteChange(false)[0].value, 'False');
});

test('maus: Messergebnisse werden geprüft, Unsinn abgelehnt', () => {
  assert.deepEqual(L.sanitizeTest('polling', { hz: 998.4, medianMs: 1.0004, samples: 3000, durationMs: 3010, cls: '1000', stable: true, evil: 'x' }),
    { hz: 998, medianMs: 1, samples: 3000, durationMs: 3010, cls: '1000', stable: true });
  assert.equal(L.sanitizeTest('polling', { hz: 'viel', medianMs: 1, samples: 3000, durationMs: 3010, cls: '1000' }), null);
  assert.equal(L.sanitizeTest('polling', { hz: 1000, medianMs: 1, samples: 3000, durationMs: 3010, cls: '<script>' }), null);
  assert.deepEqual(L.sanitizeTest('dpi', { dpi: 812.2, cm: 10, runs: [3200, 3190, 3210], nearest: 800 }), { dpi: 812, cm: 10, runs: [3200, 3190, 3210], nearest: 800, raw: true });
  assert.equal(L.sanitizeTest('dpi', { dpi: 812, cm: 10, runs: [] }), null);
  assert.equal(L.sanitizeTest('other', { a: 1 }), null);
  const capped = Array.from({ length: 60 }, (_, i) => i).reduce((l, i) => L.pushCapped(l, i, 50), []);
  assert.equal(capped.length, 50);
  assert.equal(capped[0], 10);
});

test('maus: Cockpit-Text', () => {
  const ok = L.evaluate({ MouseSensitivity: 10, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 });
  assert.equal(L.summaryText(ok, { cls: '1000' }), 'Maus passt: Zeiger 6/11, Beschleunigung aus · 1000 Hz');
  assert.equal(L.summaryText(L.evaluate(L.parseMouseValues(REG_ON)), null), 'Zeigerbeschleunigung ist an – empfohlen: aus');
  assert.equal(L.summaryText(L.evaluate({ MouseSensitivity: 14, MouseSpeed: 0, MouseThreshold1: 0, MouseThreshold2: 0 }), null), 'Zeiger 8/11 – empfohlen: 6/11');
  assert.equal(L.summaryText(null, { cls: '500' }), 'Abfragerate: 500 Hz');
  assert.equal(L.summaryText(null, null), null);
});

// ---------------------------------------------------------------- Handler

test('maus.status: liest HKCU\\Control Panel\\Mouse, ohne Windows -> unsupported', async () => {
  const { ctx, log } = fakeCtx();
  const st = await mod.handlers.status({}, ctx);
  assert.equal(st.unsupported, false);
  assert.equal(log[0][1], 'HKCU\\Control Panel\\Mouse');
  assert.equal(st.windows.speed.label, '6/11');
  assert.equal(st.windows.accel.on, true);
  assert.equal(st.undo, null);
  const nw = await mod.handlers.status({}, fakeCtx({ win: false }).ctx);
  assert.equal(nw.unsupported, true);
  assert.equal(nw.windows, null);
});

test('maus.fix: sichert erst die alten Werte, schreibt nur HKCU als REG_SZ und macht es sofort wirksam', async () => {
  const { ctx, log, store } = fakeCtx();
  const r = await mod.handlers.fix({}, ctx);
  assert.equal(r.live, true);
  assert.deepEqual(r.changed.map((c) => c.name), ['MouseSpeed', 'MouseThreshold1', 'MouseThreshold2']);
  const iState = log.findIndex((x) => x[0] === 'state');
  const iWrite = log.findIndex((x) => x[0] === 'write');
  assert.ok(iState >= 0 && iState < iWrite, 'Rückgängig-Daten werden vor dem Schreiben gesichert');
  const writes = log.filter((x) => x[0] === 'write');
  assert.equal(writes.length, 3);
  for (const w of writes) {
    assert.equal(w[1], 'HKCU\\Control Panel\\Mouse');
    assert.equal(w[3], 'REG_SZ');
    assert.equal(w[4], '0');
  }
  const ps = log.find((x) => x[0] === 'ps');
  assert.match(ps[1], /\[int\[\]\]\(0,0,0\)/);
  assert.match(ps[1], /\[IntPtr\]10/);
  assert.equal(ps[2].json, true);
  const saved = JSON.parse(store.get('tool-maus'));
  assert.deepEqual(saved.undo.before, { MouseSensitivity: 10, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 });
  assert.equal(r.status.windows.allOk, true);
  assert.ok(r.status.undo);
  // zweiter Aufruf: nichts mehr zu tun, keine weiteren Schreibzugriffe
  const before = log.filter((x) => x[0] === 'write').length;
  const r2 = await mod.handlers.fix({}, ctx);
  assert.equal(r2.alreadyOk, true);
  assert.equal(log.filter((x) => x[0] === 'write').length, before);
});

test('maus.fix: blockiertes PowerShell -> gespeichert, aber Hinweis auf Abmelden', async () => {
  const { ctx } = fakeCtx({ psThrows: true });
  const r = await mod.handlers.fix({ speed: true, accel: true }, ctx);
  assert.equal(r.live, false);
  assert.match(r.liveError, /Abmelden/);
  assert.equal(r.status.windows.accel.on, false, 'Registry ist trotzdem geschrieben');
});

test('maus.undo: holt die gesicherten Werte zurück und löscht den Rückgängig-Eintrag', async () => {
  const reg = { ...REG_ON, MouseSensitivity: { type: 'REG_SZ', value: '14' } };
  const { ctx, log, store, regData } = fakeCtx({ reg });
  await mod.handlers.fix({}, ctx);
  assert.equal(regData.MouseSensitivity.value, '10');
  log.length = 0;
  const r = await mod.handlers.undo({}, ctx);
  assert.equal(r.live, true);
  assert.equal(regData.MouseSensitivity.value, '14');
  assert.equal(regData.MouseSpeed.value, '1');
  assert.equal(regData.MouseThreshold1.value, '6');
  assert.equal(regData.MouseThreshold2.value, '10');
  const ps = log.find((x) => x[0] === 'ps');
  assert.match(ps[1], /\[int\[\]\]\(6,10,1\)/, 'SPI-Reihenfolge T1,T2,Beschleunigung');
  assert.match(ps[1], /\[IntPtr\]14/);
  assert.equal(JSON.parse(store.get('tool-maus')).undo, undefined);
  await assert.rejects(() => mod.handlers.undo({}, ctx), (e) => e.code === 'NO_UNDO');
});

test('maus.fix/undo: ohne Windows -> NOT_WINDOWS, nichts wird geschrieben', async () => {
  const { ctx, log } = fakeCtx({ win: false });
  await assert.rejects(() => mod.handlers.fix({}, ctx), (e) => e.code === 'NOT_WINDOWS');
  assert.equal(log.filter((x) => x[0] === 'write').length, 0);
  await assert.rejects(() => mod.handlers.fix({ speed: false, accel: false }, fakeCtx().ctx), (e) => e.code === 'BAD_ARG');
});

test('maus.saveTest + summary', async () => {
  const { ctx } = fakeCtx();
  await assert.rejects(() => mod.handlers.saveTest({ kind: 'polling', result: { hz: -1 } }, ctx), (e) => e.code === 'BAD_ARG');
  const r = await mod.handlers.saveTest({ kind: 'polling', result: { hz: 1001, medianMs: 1, samples: 3100, durationMs: 3050, cls: '1000', stable: true } }, ctx);
  assert.equal(r.saved.cls, '1000');
  assert.ok(r.saved.at > 0);
  assert.equal(r.tests.polling.hz, 1001);
  await mod.handlers.saveTest({ kind: 'dpi', result: { dpi: 805, cm: 10, runs: [3170, 3160, 3180], nearest: 800 } }, ctx);
  const st = await mod.handlers.status({}, ctx);
  assert.equal(st.tests.dpi.dpi, 805);
  assert.deepEqual(await mod.handlers.summary({}, ctx), { text: 'Zeigerbeschleunigung ist an – empfohlen: aus · 1000 Hz' });
  const nw = fakeCtx({ win: false });
  assert.equal(await mod.handlers.summary({}, nw.ctx), null);
});

// ---------------------------------------------------------------- Fortnite (echter CoreService)

function realCore(local, running = { value: [] }) {
  const c = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: local }, exec: fakeExec(running) });
  return c;
}

test('maus.fortniteAccel + fixFortniteAccel: nur GameUserSettings.ini, mit Backup, Fortnite muss zu sein', async () => {
  const fx = makeLocalAppData();
  const gus = path.join(fx.wc, 'GameUserSettings.ini');
  fs.writeFileSync(gus, fs.readFileSync(gus, 'utf8').replace('bDisableMouseAcceleration=True', 'bDisableMouseAcceleration=False'));
  const engineBefore = fs.readFileSync(path.join(fx.wc, 'Engine.ini'), 'utf8');
  const running = { value: [] };
  const core = realCore(fx.local, running);
  await core.init();
  const ctx = { core, exec: { IS_WIN: false } };
  const a = await mod.handlers.fortniteAccel({}, ctx);
  assert.equal(a.found, true);
  assert.equal(a.value, 'False');
  assert.equal(a.disabled, false);
  const backupsBefore = (await core.listBackups()).length;
  // Fortnite läuft -> abgelehnt, Datei unverändert
  running.value = ['FortniteClient-Win64-Shipping.exe'];
  await assert.rejects(() => mod.handlers.fixFortniteAccel({}, ctx), (e) => e.code === 'FORTNITE_RUNNING');
  assert.match(fs.readFileSync(gus, 'utf8'), /bDisableMouseAcceleration=False/);
  running.value = [];
  const r = await mod.handlers.fixFortniteAccel({}, ctx);
  assert.equal(r.disabled, true);
  assert.equal(r.applied.length, 1);
  assert.ok(r.backupId);
  const text = fs.readFileSync(gus, 'utf8');
  assert.match(text, /bDisableMouseAcceleration=True\r\n/);
  assert.match(text, /FrameRateLimit=240\.000000\r\n/, 'Rest der Datei bleibt');
  assert.equal(fs.readFileSync(path.join(fx.wc, 'Engine.ini'), 'utf8'), engineBefore, 'Engine.ini bleibt unberührt');
  assert.equal((await core.listBackups()).length, backupsBefore + 1);
  const backups = await core.listBackups();
  assert.ok(backups.some((b) => b.reason === 'tool' && /Maus-Check/.test(b.label)));
  // wieder einschalten geht auch
  const back = await mod.handlers.fixFortniteAccel({ disable: false }, ctx);
  assert.equal(back.disabled, false);
});

test('maus.fortniteAccel: ohne Fortnite-Ordner -> verständliches Ergebnis statt Fehler', async () => {
  const empty = tmpDir('helix-empty-');
  const core = realCore(empty);
  await core.init();
  const r = await mod.handlers.fortniteAccel({}, { core, exec: { IS_WIN: false } });
  assert.equal(r.found, false);
  assert.equal(r.noFolder, true);
});

// ---------------------------------------------------------------- Messen (Oberflächen-Logik)

test('Abfragerate: 1000 Hz mit Pausen wird richtig erkannt', async () => {
  const m = await measure();
  const ts = [];
  let t = 100;
  for (let seg = 0; seg < 4; seg++) {
    for (let i = 0; i < 800; i++) { ts.push(t); t += 1; }
    t += 400; // Pause – zählt nicht mit
  }
  const r = m.analyzePolling(ts);
  assert.equal(r.cls, '1000');
  assert.ok(Math.abs(r.hz - 1000) < 5, `hz=${r.hz}`);
  assert.equal(r.medianMs, 1);
  assert.equal(r.stable, true);
  assert.equal(r.enough, true);
  assert.equal(r.reliable, true);
  assert.ok(Math.abs(m.movingTime(ts).ms - 4 * 799) < 1);
});

test('Abfragerate: Einstufung 125/250/500/1000/über 1000 und zu kurze Messung', async () => {
  const m = await measure();
  const gen = (interval, n) => Array.from({ length: n }, (_, i) => i * interval);
  assert.equal(m.analyzePolling(gen(8, 400)).cls, '125');
  assert.equal(m.analyzePolling(gen(4, 800)).cls, '250');
  assert.equal(m.analyzePolling(gen(2, 1600)).cls, '500');
  const fast = m.analyzePolling(gen(0.25, 14000));
  assert.equal(fast.cls, '2000+');
  assert.equal(fast.reliable, false, 'über 1000 Hz ist im Browser nicht zuverlässig');
  const short = m.analyzePolling(gen(1, 500));
  assert.equal(short.enough, false);
  assert.equal(m.classifyRate(60).cls, 'low');
  assert.equal(m.classifyRate(NaN).cls, 'low');
  assert.match(m.pollingAdvice({ cls: '2000+' }).text, /nicht genau messen/);
  assert.match(m.pollingAdvice({ cls: '250' }).text, /^250 Hz ist wenig/);
  assert.equal(m.pollingAdvice({ cls: '1000' }).tone, 'ok');
});

test('DPI: Counts / 3,937 bei 10 cm, Durchschnitt aus 3 Messungen, übliche Werte', async () => {
  const m = await measure();
  assert.ok(Math.abs(m.countsToDpi(3150, 10) - 800.1) < 0.1);
  assert.equal(m.countsToDpi(0, 10), null);
  const r = m.evaluateDpi([3150, 3130, 3170], 10);
  assert.equal(r.dpi, 800);
  assert.equal(r.consistent, true);
  assert.deepEqual(r.nearest, { value: 800, diffPct: 0 });
  const card = m.evaluateDpi([2696], m.CARD_CM);
  assert.equal(card.nearest.value, 800);
  assert.equal(r.plausible, true);
  assert.equal(m.evaluateDpi([561, 561, 561], 10).plausible, false, '142 DPI gibt es praktisch nicht');
  const messy = m.evaluateDpi([3150, 2400, 3900], 10);
  assert.equal(messy.consistent, false);
  assert.equal(m.nearestCommonDpi(1100, 0.05), null);
  assert.equal(m.moveLength(3, 4), 5);
});

test('Empfehlungen: Checkliste mit offenen Punkten und Ergebnissen', async () => {
  const m = await measure();
  const open = m.buildChecklist({ unsupported: true });
  assert.equal(open.done, 0);
  assert.ok(open.items.every((i) => i.state === 'open'));
  const w = L.evaluate({ MouseSensitivity: 10, MouseSpeed: 1, MouseThreshold1: 6, MouseThreshold2: 10 });
  const c = m.buildChecklist({ windows: w, fortnite: { found: true, disabled: true }, polling: { cls: '1000' } });
  assert.deepEqual(c.items.map((i) => [i.id, i.state]), [['speed', 'ok'], ['accel', 'warn'], ['fortnite', 'ok'], ['polling', 'ok']]);
  assert.equal(c.done, 3);
  assert.equal(c.total, 4);
  assert.ok(c.items.every((i) => i.text && i.title), 'jede Empfehlung hat eine Erklärung');
});

// ---------------------------------------------------------------- Sicherheitsregeln

test('maus: Sicherheitsregeln im Quelltext (nur HKCU, kein Engine.ini, kein Spielprozess, kein Anti-Cheat)', () => {
  const files = [
    path.join(__dirname, '..', '..', 'src', 'main', 'modules', 'tools', 'maus.js'),
    path.join(__dirname, '..', '..', 'src', 'main', 'tools', 'maus-logic.js'),
  ];
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.doesNotMatch(src, /HKLM|HKEY_LOCAL_MACHINE/);
  assert.doesNotMatch(src, /Engine\.ini/);
  assert.doesNotMatch(src, /taskkill|closeByName|closeByPid|PriorityClass|ProcessorAffinity|OpenProcess|ReadProcessMemory|WriteProcessMemory/i);
  assert.doesNotMatch(src, /EasyAntiCheat|BattlEye|_EAC|_BE\b/i);
  assert.doesNotMatch(src, /[A-Z]:\\\\Users/i, 'keine festen Benutzerpfade');
  assert.doesNotMatch(src, /fs\.(writeFile|appendFile)/, 'Fortnite-Datei nur über ctx.core');
  assert.match(src, /applyIniChanges\(L\.FORTNITE\.file/);
  assert.equal(L.MOUSE_KEY.startsWith('HKCU\\'), true);
  assert.equal(mod.id, 'maus');
  for (const h of ['status', 'fix', 'undo', 'fortniteAccel', 'fixFortniteAccel', 'saveTest', 'summary']) assert.equal(typeof mod.handlers[h], 'function', h);
});
