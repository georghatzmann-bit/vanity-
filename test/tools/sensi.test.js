'use strict';
// Tests für die Sensi-Kalibrierung: Rechenregeln, Umrechner, Projektion, Runden, ganzer Testablauf
// (mit einem simulierten Spieler), Empfehlung, Verlauf und das Hauptprozess-Modul.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'src', 'renderer', 'js', 'lib');
const logic = require('../../src/main/tools/sensi-logic');
const mod = require('../../src/main/modules/tools/sensi');

let M; let R; let S;
before(async () => {
  M = await import(pathToFileURL(path.join(LIB, 'sensi-math.mjs')).href);
  R = await import(pathToFileURL(path.join(LIB, 'sensi-rounds.mjs')).href);
  S = await import(pathToFileURL(path.join(LIB, 'sensi-session.mjs')).href);
});

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} erwartet ${b} ± ${eps}, war ${a}`);

// ---------------------------------------------------------------- Fortnite-Werte
test('cm/360 und eDPI stimmen mit veröffentlichten Profi-Werten überein', () => {
  near(M.cm360(800, 6.5), 31.66, 0.01, '800 DPI, 6,5 %');
  near(M.cm360(800, 6.3), 32.66, 0.01, 'Bugha');
  near(M.cm360(800, 3.4), 60.52, 0.01, 'purebx');
  near(M.cm360(6400, 1), 25.72, 0.01, '916Gon');
  near(M.cm360(1000, 13.2), 12.47, 0.01, 'Cadu');
  assert.equal(M.edpi(800, 6.4), 51.2);
  assert.equal(M.edpi(800, 6.5), 52);
  near(M.inch360(800, 6.5), 31.66 / 2.54, 0.01);
  near(M.adsCm360(800, 6.4, 45), 71.44, 0.02, 'Zielen 45 %');
  near(M.countsToDeg(1000, 6.5), 36.1075, 1e-9);
});

test('Profi-Vergleich ordnet die eDPI richtig ein (Median 52, Mitte 48–59)', () => {
  assert.equal(M.proCompare(52).zone, 'inside');
  assert.equal(M.proCompare(48).zone, 'inside');
  assert.equal(M.proCompare(59).zone, 'inside');
  assert.equal(M.proCompare(40).zone, 'below');
  assert.equal(M.proCompare(20).zone, 'far-below');
  assert.equal(M.proCompare(70).zone, 'above');
  assert.equal(M.proCompare(150).zone, 'far-above');
  assert.equal(M.proCompare(NaN).zone, 'unknown');
  for (const e of [20, 40, 52, 70, 150]) assert.ok(M.proCompare(e).label, 'Status immer mit Text');
});

test('Zahlen: deutsche Schreibweise und Fortnite-Genauigkeit 0,1 %', () => {
  assert.equal(M.parseNum('6,5'), 6.5);
  assert.equal(M.parseNum(' 800 '), 800);
  assert.ok(Number.isNaN(M.parseNum('abc')));
  assert.ok(Number.isNaN(M.parseNum('6,5,1')));
  assert.equal(M.fmtNum(31.6612, 1), '31,7');
  assert.equal(M.fmtSens(6.8), '6,8');
  assert.equal(M.fmtSens(6.25), '6,25');
  assert.equal(M.roundSens(6.83), 6.8);
  assert.equal(M.roundSens(6.86), 6.9);
  assert.equal(M.roundSens(0.01), 0.1, 'nie unter dem kleinsten Wert');
});

test('Eingaben werden geprüft (Renderer und Hauptprozess gleich)', () => {
  const good = { dpi: '800', sens: '6,5', targeting: 45, scope: '45' };
  const a = M.validateSettings(good);
  const b = logic.validateSettings(good);
  assert.equal(a.ok, true);
  assert.deepEqual(a.values, { dpi: 800, sens: 6.5, targeting: 45, scope: 45 });
  assert.deepEqual(b.settings, a.values);
  const bad = { dpi: 10, sens: 'x', targeting: 300, scope: 0 };
  const c = M.validateSettings(bad);
  const d = logic.validateSettings(bad);
  assert.equal(c.ok, false);
  assert.deepEqual(Object.keys(c.errors).sort(), ['dpi', 'scope', 'sens', 'targeting']);
  assert.deepEqual(Object.keys(d.errors).sort(), ['dpi', 'scope', 'sens', 'targeting']);
  near(logic.cm360(800, 6.5), M.cm360(800, 6.5), 1e-9, 'gleiche Formel im Hauptprozess');
});

// ---------------------------------------------------------------- Umrechner
test('Umrechner Fortnite -> andere Spiele (Werte aus der Recherche, 6,4 % bei 800 DPI)', () => {
  const v = (id, opts = {}) => M.fortniteToGame(id, { sens: 6.4, dpi: 800, ...opts });
  near(v('cs2'), 1.616, 0.001, 'CS2');
  near(v('apex'), 1.616, 0.001, 'Apex');
  near(v('valorant'), 0.508, 0.001, 'Valorant');
  near(v('overwatch2'), 5.387, 0.001, 'Overwatch 2');
  near(v('cod'), 5.387, 0.001, 'CoD');
  near(v('r6'), 6.205, 0.001, 'R6');
  near(v('thefinals'), 35.55, 0.01, 'The Finals');
  near(v('marvelrivals'), 2.03, 0.005, 'Marvel Rivals');
  near(v('pubg', { fov: 90 }), 42.6, 0.05, 'PUBG FOV 90');
  near(v('pubg', { fov: 103 }), 39.7, 0.05, 'PUBG FOV 103');
  near(v('pubg', { fov: 80 }), 45.2, 0.05, 'PUBG FOV 80');
  assert.ok(Number.isNaN(M.fortniteToGame('gibtsnicht', { sens: 6.4, dpi: 800 })));
});

test('Umrechner anderes Spiel -> Fortnite, mit DPI-Wechsel und in beide Richtungen gleich', () => {
  near(M.gameToFortnite('valorant', { value: 0.4, gameDpi: 800 }), 5.04, 0.01, 'Valorant 0,4 (×12,6)');
  near(M.gameToFortnite('cs2', { value: 1.2, gameDpi: 800 }), 4.75, 0.01, 'CS 1,2 -> 4,75 %');
  // gleiche Drehung pro Zentimeter: doppelte DPI im Zielspiel -> halber Wert
  near(M.fortniteToGame('cs2', { sens: 6.4, dpi: 800, targetDpi: 1600 }), 0.808, 0.001, 'CS2 bei 1600 DPI');
  near(M.gameToFortnite('cs2', { value: 1.616, gameDpi: 1600, dpi: 800 }), 12.8, 0.01, 'zurück bei anderer DPI');
  // PUBG-Rechnung: S50, FOV 90, 800 DPI = 22,86 cm
  near(914.4 / (800 * M.gameDegPerCount(M.findGame('pubg'), 50, { fov: 90 })), 22.86, 0.01, 'PUBG-Prüfwert');
  // R6: 800 DPI, Wert 10 -> 19,95 cm
  near(914.4 / (800 * M.gameDegPerCount(M.findGame('r6'), 10)), 19.95, 0.01, 'R6-Prüfwert');
  for (const g of M.GAMES) {
    const val = M.fortniteToGame(g, { sens: 7.1, dpi: 1600, targetDpi: 400, fov: 90 });
    near(M.gameToFortnite(g, { value: val, gameDpi: 400, dpi: 1600, fov: 90 }), 7.1, 1e-9, g.name);
  }
  assert.equal(M.fmtGameValue(M.findGame('r6'), 6.205), '6');
  assert.equal(M.fmtGameValue(M.findGame('cs2'), 1.6157), '1,616');
});

// ---------------------------------------------------------------- Sichtfeld & Projektion
test('Sichtfeld: 80° horizontal bei 16:9, vertikal ≈ 50,53°', () => {
  near(M.VFOV_DEG, 50.534, 0.001);
  near(M.hfovForAspect(16 / 9), 80, 1e-9);
  near(M.hfovForAspect(4 / 3), 64.37, 0.01);
  near(M.hfovForAspect(64 / 27), 96.42, 0.01);
  assert.deepEqual(M.fit169(1920, 1200), { w: 1920, h: 1080 });
  assert.deepEqual(M.fit169(1000, 400), { w: 711, h: 400 });
});

test('Projektion: Mitte bleibt Mitte, 40° rechts liegt am Bildrand (16:9), hinter der Kamera = null', () => {
  const w = 1600; const h = 900;
  const c = M.projectDir(10, 5, { yaw: 10, pitch: 5 }, w, h);
  near(c.x, 800, 1e-6); near(c.y, 450, 1e-6);
  const edge = M.projectDir(40, 0, { yaw: 0, pitch: 0 }, w, h);
  near(edge.x, 1600, 1e-6, 'rechter Rand');
  const up = M.projectDir(0, 10, { yaw: 0, pitch: 0 }, w, h);
  assert.ok(up.y < 450, 'oben ist oben');
  assert.equal(M.projectDir(180, 0, { yaw: 0, pitch: 0 }, w, h), null);
  near(M.angDist({ yaw: 0, pitch: 0 }, { yaw: 30, pitch: 0 }), 30, 1e-9);
  near(M.angDist({ yaw: 179, pitch: 0 }, { yaw: -179, pitch: 0 }), 2, 1e-9, 'über ±180 hinweg');
});

test('Mausbewegung: Counts × Sensi × 0,005555 = Grad, Maus runter = Blick runter, Grenzen', () => {
  const cam = M.applyMovement({ yaw: 0, pitch: 0 }, 1000, 0, 6.5);
  near(cam.yaw, 36.1075, 1e-9);
  const down = M.applyMovement({ yaw: 0, pitch: 0 }, 0, 100, 6.5);
  assert.ok(down.pitch < 0);
  const top = M.applyMovement({ yaw: 0, pitch: 0 }, 0, -100000, 6.5);
  assert.equal(top.pitch, 85);
  const wrap = M.applyMovement({ yaw: 170, pitch: 0 }, 1000, 0, 6.5);
  assert.ok(wrap.yaw < -150, 'yaw bleibt zwischen -180 und 180');
});

// ---------------------------------------------------------------- Testablauf
test('Plan Sensi-Modus: 5 verdeckte, gemischte Faktoren, je 3 Runden, kurz ≈ 15 s, normal ≈ 30 s', () => {
  const settings = { dpi: 800, sens: 6.5, targeting: 45, scope: 45 };
  const p = M.buildPlan({ mode: 'sens', settings, length: 'short', rng: M.mulberry32(3) });
  assert.equal(p.blocks.length, 5);
  assert.deepEqual(p.blocks.map((b) => b.sens).sort(), [5.2, 5.9, 6.5, 7.2, 7.8], 'auf 0,1 % gerundet, wie in Fortnite einstellbar');
  assert.notDeepEqual(p.blocks.map((b) => b.sens), [5.2, 5.9, 6.5, 7.2, 7.8], 'Reihenfolge gemischt');
  // sehr kleine Sensi: Runden würde doppelte Werte ergeben -> genaue Werte bleiben
  assert.deepEqual(M.testedSens(0.5, 0.2).map((x) => x.mult), [0.8, 0.9, 1, 1.1, 1.2]);
  for (const b of p.blocks) {
    assert.deepEqual(b.rounds.map((r) => r.type), ['flick', 'tracking', 'moving']);
    near(b.sens, 6.5 * b.mult, 0.001);
    assert.equal(b.rounds.reduce((n, r) => n + r.durationMs, 0), 15000);
  }
  const n = M.buildPlan({ mode: 'sens', settings, length: 'normal', rng: M.mulberry32(3) });
  for (const b of n.blocks) assert.equal(b.rounds.reduce((x, r) => x + r.durationMs, 0), 30000);
  assert.ok(M.planDurationSec(p) < M.planDurationSec(n));
  assert.deepEqual(M.multipliers(0.1, 5), [0.9, 0.95, 1, 1.05, 1.1]);
});

test('Plan DPI-Modus: eDPI bleibt gleich, Reihenfolge A-B-B-A, Umstellen nur bei Wechsel', () => {
  const settings = { dpi: 800, sens: 6.5, targeting: 45, scope: 45 };
  const p = M.buildPlan({ mode: 'dpi', settings, dpis: [1600], length: 'short' });
  assert.deepEqual(p.blocks.map((b) => b.dpi), [800, 1600, 1600, 800]);
  for (const b of p.blocks) near(M.edpi(b.dpi, b.sens), 52, 1e-9, `eDPI bei ${b.dpi}`);
  assert.deepEqual(p.blocks.map((b) => b.needsSwitch), [false, true, false, true]);
  assert.equal(p.warmup.dpi, 800);
  assert.throws(() => M.buildPlan({ mode: 'dpi', settings, dpis: [800] }), /zwei verschiedene DPI/);
  assert.deepEqual(M.uniqueDpis(800, ['1600', 'x', 1600, 10, 400]), [800, 1600, 400]);
});

// ---------------------------------------------------------------- Bewertung
test('Punkte pro Runde: gute Flicks > schlechte, Tracking = Anteil auf dem Ziel', () => {
  const good = { type: 'flick', hits: 12, misses: 0, ttks: [400, 450, 420], liveMs: 6000, flicks: 12, over: 0, under: 0 };
  const bad = { type: 'flick', hits: 4, misses: 6, ttks: [1400, 1500], liveMs: 6000, flicks: 6, over: 5, under: 1 };
  assert.ok(M.scoreRound(good) > 90);
  assert.ok(M.scoreRound(bad) < 30);
  const overshooty = { ...good, over: 10 };
  assert.ok(M.scoreRound(overshooty) < M.scoreRound(good), 'Überziehen kostet Punkte');
  assert.equal(M.scoreRound({ type: 'tracking', onTargetMs: 3000, measuredMs: 4000 }), 75);
  assert.equal(M.scoreRound({ type: 'tracking', onTargetMs: 0, measuredMs: 0 }), 0);
  const agg = M.aggregateBlock([good, { type: 'tracking', onTargetMs: 3000, measuredMs: 4000 }, { type: 'moving', hits: 5, misses: 5, ttks: [900], liveMs: 5000 }]);
  assert.equal(agg.hits, 17);
  assert.equal(agg.misses, 5);
  assert.equal(agg.trackingPct, 75);
  assert.equal(agg.overshoot, 0);
  assert.ok(agg.score > 0 && agg.score <= 100);
});

test('Parabel: exakte Werte werden wiedergefunden, Scheitel stimmt', () => {
  const pts = [0.8, 0.9, 1, 1.1, 1.2].map((x) => ({ x, y: -500 * (x - 1.05) ** 2 + 90 }));
  const fit = M.fitParabola(pts);
  near(fit.a, -500, 1e-6);
  near(fit.vertex, 1.05, 1e-9);
  near(fit.r2, 1, 1e-9);
  assert.equal(M.fitParabola(pts.slice(0, 2)), null);
  near(M.peak3({ x: 0.9, y: 80 }, { x: 1, y: 90 }, { x: 1.1, y: 80 }), 1, 1e-9);
  const p = M.peak3({ x: 1, y: 91.5 }, { x: 1.1, y: 97.4 }, { x: 1.2, y: 95.3 });
  assert.ok(p > 1.1 && p < 1.15);
});

function blocksFor(scoreFn, extra = () => ({})) {
  return [0.8, 0.9, 1, 1.1, 1.2].map((mult) => ({ mult, sens: 6.5 * mult, score: scoreFn(mult), ...extra(mult) }));
}

test('Empfehlung: Parabel-Optimum, auf 0,1 % gerundet, mit Erklärung zum Überziehen', () => {
  const rec = M.recommend({
    blocks: blocksFor((m) => 90 - 400 * (m - 1.05) ** 2, (m) => ({ overshoot: m > 1.05 ? 0.6 : 0.05, undershoot: m < 1.05 ? 0.6 : 0.05 })),
    baseSens: 6.5, dpi: 800,
  });
  assert.equal(rec.method, 'parabel');
  assert.equal(rec.sens, 6.8);
  assert.equal(rec.edpi, 54.4);
  assert.equal(rec.edge, false);
  assert.equal(rec.lines[0], 'Du hast mit 6,8 % am besten getroffen.');
  assert.ok(rec.lines.includes('Bei höheren Werten bist du oft über das Ziel hinausgeschossen.'));
  assert.ok(rec.lines.includes('Bei niedrigeren Werten hast du oft zu kurz gezielt.'));
  assert.ok(rec.lines.some((l) => /etwas schneller als deine jetzige Sensi \(6,5 %\)/.test(l)));
});

test('Empfehlung: bleibt im getesteten Bereich und nahe am besten gemessenen Wert', () => {
  // steigt bis zum Rand -> Rand, mit Hinweis zum Wiederholen
  const edge = M.recommend({ blocks: blocksFor((m) => 50 + 40 * m), baseSens: 6.5, dpi: 800 });
  assert.equal(edge.sens, 7.8);
  assert.equal(edge.edge, true);
  assert.ok(edge.lines.some((l) => /am Rand des Tests/.test(l)));
  // bester Wert innen, Parabel-Scheitel außerhalb -> Optimum zwischen den Nachbarn
  const inner = M.recommend({ blocks: [0.8, 0.9, 1, 1.1, 1.2].map((mult, i) => ({ mult, score: [86.4, 89.9, 91.5, 97.4, 95.3][i] })), baseSens: 6.5, dpi: 800 });
  assert.ok(inner.mult >= 1 && inner.mult <= 1.2, `mult ${inner.mult}`);
  assert.ok(inner.sens >= 7.1 && inner.sens <= 7.5, `sens ${inner.sens}`);
  // zu wenige Punkte -> bester Wert
  const two = M.recommend({ blocks: [{ mult: 0.9, score: 70 }, { mult: 1.1, score: 80 }], baseSens: 6.5, dpi: 800 });
  assert.equal(two.method, 'bester');
  assert.equal(two.sens, 7.2);
  // flach -> geringe Sicherheit, ehrlich gesagt
  const flat = M.recommend({ blocks: blocksFor(() => 80), baseSens: 6.5, dpi: 800 });
  assert.equal(flat.confidence, 'niedrig');
  assert.ok(flat.lines.some((l) => /Unterschiede zwischen den Werten waren klein/.test(l)));
  // ohne Rohdaten -> Hinweis auf den Maus-Check
  const raw = M.recommend({ blocks: blocksFor((m) => 90 - 400 * (m - 1) ** 2), baseSens: 6.5, dpi: 800, rawInput: false });
  assert.ok(raw.lines.some((l) => /Maus-Check/.test(l)));
  assert.ok(raw.lines.some((l) => /jetzige Sensi\. Sie passt also schon gut/.test(l)));
  assert.equal(M.recommend({ blocks: [], baseSens: 6.5 }), null);
});

test('Gleichgewicht aus Überziehen und Zu-kurz-Zielen zeigt die passende Sensi', () => {
  const g = [
    { mult: 0.8, overshoot: 0, undershoot: 0.9 }, { mult: 0.9, overshoot: 0.1, undershoot: 0.3 },
    { mult: 1, overshoot: 0.5, undershoot: 0 }, { mult: 1.1, overshoot: 0.9, undershoot: 0 },
  ];
  const b = M.balancePoint(g);
  near(b.mult, 0.9 + 0.1 * (0.2 / 0.7), 1e-9);
  assert.ok(b.trend > 1.5);
  assert.equal(M.balancePoint(g.map((x) => ({ ...x, overshoot: 0.3, undershoot: 0.3 }))), null, 'kein Trend -> kein Signal');
  assert.equal(M.balancePoint([{ mult: 1, overshoot: 0.5, undershoot: 0 }]), null);
  // Punkte gleich gut, aber klarer Trend: Empfehlung rückt zum Gleichgewicht
  const rec = M.recommend({ blocks: [0.8, 0.9, 1, 1.1, 1.2].map((mult, i) => ({ mult, score: [80, 90, 90, 84, 78][i], ...g[Math.min(i, 3)] })), baseSens: 6.5, dpi: 800 });
  assert.ok(rec.mult < 0.97 && rec.mult >= 0.9, `mult ${rec.mult}`);
});

test('Empfehlung: zu wenige Treffer -> keine Empfehlung, jetzige Sensi bleibt', () => {
  const rec = M.recommend({ blocks: blocksFor((m) => (m === 1.2 ? 4 : 1)), baseSens: 6.5, dpi: 800 });
  assert.equal(rec.method, 'zuwenig');
  assert.equal(rec.sens, 6.5);
  assert.equal(rec.confidence, 'niedrig');
  assert.equal(rec.lines[0], 'Es gab zu wenige Treffer für eine Empfehlung.');
  const d = M.recommendDpi({ blocks: [{ dpi: 800, score: 2 }, { dpi: 1600, score: 9 }], baseDpi: 800, baseSens: 6.5 });
  assert.equal(d.method, 'zuwenig');
  assert.equal(d.dpi, 800);
  // ganzer Test ohne Spieler -> ebenfalls keine Empfehlung
  const plan = M.buildPlan({ mode: 'sens', settings: { dpi: 800, sens: 6.5 }, rng: M.mulberry32(1) });
  const s = new S.TestSession(plan, { rng: M.mulberry32(2) });
  s.start(0);
  for (let T = 0; !s.finished && T < 600000; T += 50) s.update(T);
  assert.equal(s.outcome().rec.method, 'zuwenig');
});

test('Empfehlung DPI-Modus: eDPI bleibt gleich, kleiner Unterschied -> bei der DPI bleiben', () => {
  const better = M.recommendDpi({ blocks: [{ dpi: 800, score: 70 }, { dpi: 1600, score: 82 }, { dpi: 1600, score: 80 }, { dpi: 800, score: 72 }], baseDpi: 800, baseSens: 6.5 });
  assert.equal(better.dpi, 1600);
  assert.equal(better.sens, 3.3);
  assert.ok(better.lines[0].startsWith('Mit 1600 DPI hast du am besten getroffen.'));
  assert.ok(better.lines.some((l) => /0,1-%-Schritte/.test(l)), 'Rundung wird erklärt');
  const same = M.recommendDpi({ blocks: [{ dpi: 800, score: 80 }, { dpi: 1600, score: 81 }], baseDpi: 800, baseSens: 6.5 });
  assert.equal(same.dpi, 800);
  assert.equal(same.sens, 6.5);
  assert.equal(same.confidence, 'niedrig');
});

// ---------------------------------------------------------------- Runden
test('Flick-Klassifizierung: drüber, zu kurz, sauber', () => {
  const start = { yaw: 0, pitch: 0 }; const target = { yaw: 20, pitch: 0 };
  near(R.flickProgress(start, target, { yaw: 10, pitch: 0 }), 0.5, 1e-9);
  near(R.flickProgress(start, target, { yaw: 25, pitch: 0 }), 1.25, 1e-9);
  assert.equal(R.classifyFlick({ pMax: 1.3, firstStopP: 1.3, shortClick: false, rr: 0.075 }), 'over');
  assert.equal(R.classifyFlick({ pMax: 0.85, firstStopP: 0.85, shortClick: false, rr: 0.075 }), 'under');
  assert.equal(R.classifyFlick({ pMax: 1.0, firstStopP: 1.0, shortClick: false, rr: 0.075 }), 'clean');
  assert.equal(R.classifyFlick({ pMax: 1.0, firstStopP: null, shortClick: true, rr: 0.075 }), 'under');
});

test('Flick-Runde: keine Ziele in der Ansage, Treffer mit Zeit, Fehlklick, Zeitüberschreitung, Überziehen', () => {
  const r = new R.FlickRound({ durationMs: 6000, leadInMs: 1000, rng: M.mulberry32(5), timeoutMs: 3000 });
  let aim = { yaw: 0, pitch: 0 };
  r.begin(aim, 0);
  r.update(aim, 500);
  assert.equal(r.targets().length, 0, 'Ansage');
  assert.equal(r.shoot(aim, 600).result, 'ignored');
  r.update(aim, 1000);
  const t1 = r.targets()[0];
  assert.ok(t1, 'Ziel erscheint');
  assert.ok(Math.abs(t1.yaw) <= R.ZONE.yaw && Math.abs(t1.pitch) <= R.ZONE.pitch);
  // drüber hinaus und zurück, dann treffen -> "over"
  const beyond = { yaw: t1.yaw + (t1.yaw - aim.yaw) * 0.4, pitch: t1.pitch + (t1.pitch - aim.pitch) * 0.4 };
  r.move(beyond, 1200); r.update(beyond, 1210);
  aim = { yaw: t1.yaw, pitch: t1.pitch };
  r.move(aim, 1300);
  assert.equal(r.shoot(aim, 1350).result, 'hit');
  assert.equal(r.ttks[0], 350);
  assert.equal(r.over, 1);
  // Fehlklick
  assert.equal(r.shoot({ yaw: aim.yaw + 30, pitch: 0 }, 1400).result, 'miss');
  // Zeitüberschreitung zählt als daneben
  r.update(aim, 1350 + 3000);
  assert.equal(r.timeouts, 1);
  r.update(aim, 7000);
  assert.equal(r.done, true);
  assert.equal(r.targets().length, 0);
  const st = r.stats();
  assert.equal(st.hits, 1);
  assert.equal(st.misses, 2);
  assert.equal(st.liveMs, 6000);
});

test('Tracking-Runde: genau folgen ≈ 100 %, wegschauen = 0 %', () => {
  const follow = new R.TrackingRound({ durationMs: 4000, leadInMs: 0, rng: M.mulberry32(1) });
  follow.begin({ yaw: 0, pitch: 0 }, 0);
  for (let t = 16; t <= 4000; t += 16) {
    const tg = follow.targets()[0] || follow.pos;
    follow.update({ yaw: tg.yaw, pitch: tg.pitch }, t);
  }
  assert.ok(follow.trackingPct > 95, `war ${follow.trackingPct}`);
  const away = new R.TrackingRound({ durationMs: 4000, leadInMs: 0, rng: M.mulberry32(1) });
  away.begin({ yaw: 0, pitch: 0 }, 0);
  for (let t = 16; t <= 4000; t += 16) away.update({ yaw: 120, pitch: 0 }, t);
  assert.equal(away.trackingPct, 0);
  assert.equal(away.done, true);
});

test('Bewegte Ziele: Treffer auf das nächste Ziel, abgelaufene Ziele zählen als daneben', () => {
  const r = new R.MovingRound({ durationMs: 12000, leadInMs: 0, rng: M.mulberry32(9), lifeMs: 2000 });
  const aim = { yaw: 0, pitch: 0 };
  r.begin(aim, 0);
  r.update(aim, 16);
  assert.equal(r.targets().length, 2);
  const tg = r.targets()[0];
  assert.equal(r.shoot({ yaw: tg.yaw, pitch: tg.pitch }, 20).result, 'hit');
  assert.equal(r.targets().length, 2, 'neues Ziel kommt nach');
  for (let t = 32; t <= 2100; t += 16) r.update(aim, t);
  assert.ok(r.timeouts >= 1);
  assert.ok(r.stats().misses >= 1);
});

// ---------------------------------------------------------------- Ganzer Test mit simuliertem Spieler
/**
 * Ein einfacher "Bot": Er hat sich an trueSens gewöhnt (Muskelgedächtnis) und plant seine Mausbewegung
 * in Counts dafür. Ist die getestete Sensi höher, schießt er übers Ziel, ist sie niedriger, greift er zu kurz.
 */
function makeBot({ trueSens, rng, reactMs = 170, noise = 0.07 }) {
  const k = trueSens * 0.005555;
  let curId = null; let waitUntil = 0; let steps = []; const seen = [];
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rng(); return s - 3; };
  function plan(dyaw, dpitch, frames, nf) {
    const cx = (dyaw / k) * (1 + nf * gauss()); const cy = (-dpitch / k) * (1 + nf * gauss());
    const w = Array.from({ length: frames }, (_, i) => Math.sin(Math.PI * ((i + 0.5) / frames)) ** 2);
    const sum = w.reduce((a, b) => a + b, 0);
    let ax = 0; let ay = 0; let acc = 0; const out = [];
    for (let i = 0; i < frames; i++) {
      acc += w[i];
      const sx = Math.round((cx * acc) / sum - ax); const sy = Math.round((cy * acc) / sum - ay);
      ax += sx; ay += sy; out.push([sx, sy]);
    }
    return out;
  }
  return function step(s, T) {
    const v = s.view();
    if (v.phase !== 'round' || v.inLeadIn) { curId = null; steps = []; seen.length = 0; return; }
    if (v.roundType === 'tracking') {
      const tg = v.targets[0]; if (!tg) return;
      seen.push({ yaw: tg.yaw, pitch: tg.pitch });
      if (seen.length > 14) seen.shift();
      const now = seen[Math.max(0, seen.length - 13)]; const prev = seen[Math.max(0, seen.length - 14)];
      const vy = now.yaw - prev.yaw; const vp = now.pitch - prev.pitch;
      const ey = M.wrapDeg(now.yaw - v.cam.yaw) + vy * 13; const ep = now.pitch - v.cam.pitch + vp * 13;
      s.move(Math.round((vy + ey * 0.12) / k + gauss() * 0.4), Math.round(-(vp + ep * 0.12) / k + gauss() * 0.4), T);
      return;
    }
    const tg = v.targets.slice().sort((a, b) => M.angDist(v.cam, a) - M.angDist(v.cam, b))[0];
    if (!tg) return;
    if (tg.id !== curId) { curId = tg.id; waitUntil = T + reactMs * (0.85 + 0.3 * rng()); steps = []; return; }
    if (T < waitUntil) return;
    if (steps.length) { const [dx, dy] = steps.shift(); s.move(dx, dy, T); if (!steps.length) waitUntil = T + 70; return; }
    const err = M.angDist(v.cam, tg);
    if (err * (1 + 0.25 * gauss()) <= tg.radius * 0.8) { s.shoot(T); waitUntil = T + 60; return; }
    const big = err > 4;
    steps = plan(M.wrapDeg(tg.yaw - v.cam.yaw), tg.pitch - v.cam.pitch, big ? 14 : 7, big ? noise : noise * 0.6);
  };
}

function simulate({ baseSens = 6.5, trueSens, seed = 1, length = 'short', mode = 'sens', dpis = [], dpi = 800 }) {
  const plan = M.buildPlan({ mode, settings: { dpi, sens: baseSens, targeting: 45, scope: 45 }, length, rng: M.mulberry32(seed), dpis });
  const s = new S.TestSession(plan, { rng: M.mulberry32(seed + 99) });
  const bot = makeBot({ trueSens, rng: M.mulberry32(seed + 7) });
  const events = [];
  let T = 0;
  events.push(...s.start(0));
  for (let guard = 0; !s.finished && guard < 100000; guard++) {
    if (s.phase === 'switch') events.push(...s.confirmSwitch(T));
    bot(s, T);
    T += 8;
    events.push(...s.update(T));
  }
  return { s, events, T, ...s.outcome(1700000000000) };
}

test('Ganzer Test: der simulierte Spieler bekommt seine "echte" Sensi empfohlen (± 0,4 %)', () => {
  for (const trueSens of [5.6, 5.9, 6.5, 6.9, 7.4]) {
    for (const seed of [1, 2, 3, 4]) {
      const { rec, entry, s } = simulate({ trueSens, seed });
      assert.ok(Math.abs(rec.sens - trueSens) <= 0.4, `Bot ${trueSens} %, Seed ${seed}: empfohlen ${rec.sens} %`);
      assert.equal(entry.rounds.length, 5);
      assert.equal(s.results.length, 5, 'Aufwärmen zählt nicht');
    }
  }
});

test('Ganzer Test: Überziehen bei zu hoher Sensi, zu kurz bei zu niedriger', () => {
  const { entry } = simulate({ trueSens: 6.5, seed: 4 });
  const hi = entry.rounds.find((r) => r.mult === 1.2);
  const lo = entry.rounds.find((r) => r.mult === 0.8);
  assert.ok(hi.overshoot > 0.6, `zu schnell überzieht: ${hi.overshoot}`);
  assert.ok(lo.undershoot > 0.6, `zu langsam greift zu kurz: ${lo.undershoot}`);
});

test('Ganzer Test: Verlaufseintrag hat genau die vereinbarte Form', () => {
  const { entry } = simulate({ trueSens: 7, seed: 5 });
  for (const k of ['at', 'dpi', 'sens', 'recommendedSens', 'edpi', 'cm360', 'score', 'accuracy', 'hits', 'misses', 'trackingPct', 'avgTtkMs', 'rounds']) {
    assert.ok(k in entry, `Feld ${k}`);
  }
  for (const r of entry.rounds) {
    for (const k of ['mult', 'sens', 'score', 'accuracy', 'hits', 'misses', 'trackingPct', 'avgTtkMs', 'overshoot']) assert.ok(k in r, `Runde: ${k}`);
  }
  assert.equal(entry.at, 1700000000000);
  assert.equal(entry.dpi, 800);
  assert.equal(entry.sens, 6.5);
  near(entry.edpi, (800 * entry.recommendedSens) / 100, 0.051);
  const ok = logic.sanitizeEntry(entry, 1700000001000);
  assert.equal(ok.ok, true, 'Hauptprozess nimmt den Eintrag an');
  assert.equal(ok.entry.rounds.length, 5);
});

test('Ganzer Test: Sensi bleibt während des Tests verdeckt, Phasen laufen durch', () => {
  const plan = M.buildPlan({ mode: 'sens', settings: { dpi: 800, sens: 6.5, targeting: 45, scope: 45 }, rng: M.mulberry32(1) });
  const s = new S.TestSession(plan, { rng: M.mulberry32(2) });
  const ev = s.start(0);
  assert.equal(ev[0].type, 'block');
  assert.equal(ev[0].warmup, true);
  const v = s.view();
  assert.equal(v.phase, 'round');
  assert.equal(v.inLeadIn, true);
  assert.ok(!('sens' in v) && !('mult' in v), 'keine Sensi in der Anzeige');
  assert.equal(JSON.stringify(v).includes('6.5'), false);
  // ohne Spieler bis zum Ende: alles daneben, aber der Ablauf endet sauber
  let T = 0; const types = new Set();
  while (!s.finished && T < 600000) { T += 50; for (const e of s.update(T)) types.add(e.type); }
  assert.equal(s.finished, true);
  assert.ok(types.has('blockDone') && types.has('done') && types.has('round'));
  assert.ok(s.totalProgress === 1);
  const { rec } = s.outcome();
  assert.ok(rec && Number.isFinite(rec.sens));
  assert.equal(rec.method, 'zuwenig', 'ohne Treffer keine Empfehlung');
  near(T / 1000, M.planDurationSec(plan), 2, 'Dauer wie angekündigt');
});

test('Ganzer Test im DPI-Modus: fordert zum Umstellen auf, wartet, gruppiert nach DPI', () => {
  const { events, entry, rec } = simulate({ trueSens: 6.5, mode: 'dpi', dpis: [1600], seed: 2 });
  const sw = events.filter((e) => e.type === 'switch').map((e) => e.dpi);
  assert.deepEqual(sw, [1600, 800]);
  assert.equal(entry.rounds.length, 2);
  assert.deepEqual(entry.rounds.map((r) => r.dpi), [800, 1600]);
  assert.ok([800, 1600].includes(rec.dpi));
  near(M.edpi(rec.dpi, rec.sens), 52, 0.8, 'eDPI bleibt (fast) gleich');
  // ohne Bestätigung geht es nicht weiter
  const plan = M.buildPlan({ mode: 'dpi', settings: { dpi: 800, sens: 6.5 }, dpis: [1600], rng: M.mulberry32(1) });
  const s = new S.TestSession(plan, { rng: M.mulberry32(1) });
  s.start(0);
  let T = 0;
  while (s.phase !== 'switch' && T < 300000) { T += 50; s.update(T); }
  assert.equal(s.phase, 'switch');
  assert.equal(s.view().switchDpi, 1600);
  s.update(T + 60000);
  assert.equal(s.phase, 'switch', 'wartet auf den Spieler');
  s.confirmSwitch(T + 60000);
  assert.equal(s.phase, 'round');
  near(s.sens * s.dpi, 5200, 1e-9);
});

test('Sprung-Filter: echte schnelle Flicks bleiben, einzelne Riesen-Sprünge fliegen raus', () => {
  const f = S.createSpikeFilter({ dpi: 3200 });
  for (const m of [5, 200, 900, 2200, 3800, 4600, 3500, 1800, 400, 20]) assert.equal(f.accept(m, 0), true, `Flick ${m}`);
  assert.equal(f.dropped, 0);
  const g = S.createSpikeFilter({ dpi: 800 });
  for (let i = 0; i < 10; i++) g.accept(3, 1);
  assert.equal(g.accept(1500, 0), false, 'Sprung aus dem Stand');
  assert.equal(g.accept(4, 0), true);
  assert.equal(g.accept(800 * 7, 0), false, 'unmöglich weit');
  assert.equal(g.accept(NaN, 0), false);
  assert.equal(g.dropped, 3);
});

// ---------------------------------------------------------------- Hauptprozess
test('Hauptprozess: Eintrag wird geprüft, unbekannte Felder fallen weg, Zahlen begrenzt', () => {
  const base = { at: 1000, dpi: 800, sens: 6.5, recommendedSens: 6.83, score: 140, accuracy: -3, hits: 3.7, misses: 1, trackingPct: 55, avgTtkMs: 600, evil: '<script>', rounds: [{ mult: 1, sens: 6.5, score: 80, accuracy: 90, hits: 9, misses: 1, trackingPct: 60, avgTtkMs: 500, overshoot: 0.2, extra: 1 }], lines: ['a', 5, 'x'.repeat(500)] };
  const r = logic.sanitizeEntry(base, 2000);
  assert.equal(r.ok, true);
  assert.equal(r.entry.recommendedSens, 6.8);
  assert.equal(r.entry.edpi, 54.4);
  assert.equal(r.entry.score, 100);
  assert.equal(r.entry.accuracy, 0);
  assert.equal(r.entry.hits, 4);
  assert.equal('evil' in r.entry, false);
  assert.equal('extra' in r.entry.rounds[0], false);
  assert.deepEqual(r.entry.lines.map((l) => l.length), [1, 300]);
  assert.equal(logic.sanitizeEntry({ ...base, rounds: [] }).ok, false);
  assert.equal(logic.sanitizeEntry({ ...base, dpi: 'x' }).ok, false);
  assert.equal(logic.sanitizeEntry(null).ok, false);
  assert.equal(logic.sanitizeEntry({ ...base, at: 9e15 }, 2000).entry.at, 2000, 'Zeit in ferner Zukunft -> jetzt');
});

test('Hauptprozess: Verlauf höchstens 200, Neuestes hinten', () => {
  let h = [];
  for (let i = 0; i < 205; i++) h = logic.appendHistory(h, { at: i + 1, recommendedSens: 6 });
  assert.equal(h.length, 200);
  assert.equal(h[0].at, 6);
  assert.equal(h[199].at, 205);
});

test('Cockpit-Kurzinfo', () => {
  assert.equal(logic.summaryText({ history: [{ at: 1, dpi: 800, recommendedSens: 6.8, edpi: 54.4 }] }), 'Empfohlen: 6,8 % (eDPI 54)');
  assert.equal(logic.summaryText({ history: [{ at: 1, dpi: 800, mode: 'dpi', recommendedDpi: 1600, recommendedSens: 3.3, edpi: 52.8 }] }), 'Empfohlen: 1600 DPI, 3,3 % (eDPI 53)');
  assert.equal(logic.summaryText({ settings: { dpi: 800, sens: 6.5, targeting: 45, scope: 45 }, history: [] }), 'Deine Sensi: 6,5 % (eDPI 52) – noch kein Aim-Test');
  assert.equal(logic.summaryText({}), null);
  assert.equal(logic.summaryText(null), null);
});

/** Kontext mit Speicher im Arbeitsspeicher. Zugriff auf Windows-Befehle, Registry oder Fortnite-Dateien = Fehler. */
function fakeCtx(initial) {
  const store = new Map();
  if (initial !== undefined) store.set('tool-sensi', JSON.parse(JSON.stringify(initial)));
  const forbidden = (name) => { throw new Error(`verbotener Zugriff: ${name}`); };
  const core = new Proxy({
    async readState(name, fb) { await new Promise((r) => setTimeout(r, Math.random() * 3)); return store.has(name) ? JSON.parse(JSON.stringify(store.get(name))) : fb; },
    async writeState(name, obj) { await new Promise((r) => setTimeout(r, Math.random() * 3)); store.set(name, JSON.parse(JSON.stringify(obj))); },
  }, { get: (t, k) => (k in t ? t[k] : forbidden(`core.${String(k)}`)) });
  const ctx = new Proxy({ core, emit: () => {}, env: {} }, {
    get: (t, k) => (k in t ? t[k] : (k === 'then' ? undefined : forbidden(String(k)))),
  });
  return { ctx, store };
}

test('Modul: Einstellungen speichern, Ergebnisse anhängen, löschen, Kurzinfo – Form bleibt { settings, history }', async () => {
  const { ctx, store } = fakeCtx();
  const h = mod.handlers;
  assert.equal(mod.id, 'sensi');
  assert.deepEqual(await h.summary({}, ctx), null);
  const first = await h.state({}, ctx);
  assert.equal(first.saved, false);
  assert.deepEqual(first.settings, logic.DEFAULT_SETTINGS);
  await assert.rejects(h.saveSettings({ settings: { dpi: 5, sens: 6.5, targeting: 45, scope: 45 } }, ctx), (e) => e.code === 'BAD_ARG' && /DPI/.test(e.message));
  const saved = await h.saveSettings({ settings: { dpi: '1600', sens: '3,2', targeting: 50, scope: 45 } }, ctx);
  assert.deepEqual(saved.settings, { dpi: 1600, sens: 3.2, targeting: 50, scope: 45 });
  assert.deepEqual(Object.keys(store.get('tool-sensi')).sort(), ['history', 'settings']);
  const { entry } = simulate({ trueSens: 6.5, seed: 1 });
  // gleichzeitig speichern: nichts geht verloren
  await Promise.all(Array.from({ length: 8 }, (_, i) => h.saveResult({ entry: { ...entry, at: entry.at + i } }, ctx)));
  assert.equal(store.get('tool-sensi').history.length, 8);
  assert.deepEqual(store.get('tool-sensi').settings, saved.settings, 'Einstellungen bleiben erhalten');
  const hist = await h.history({ limit: 3 }, ctx);
  assert.equal(hist.length, 3);
  assert.equal(hist[2].at, entry.at + 7, 'Neuestes hinten');
  const sum = await h.summary({}, ctx);
  assert.match(sum.text, /^Empfohlen: \d+,\d % \(eDPI \d+\)$/);
  const rm = await h.removeResult({ at: entry.at + 7 }, ctx);
  assert.deepEqual(rm, { removed: true, count: 7 });
  await assert.rejects(h.removeResult({}, ctx), (e) => e.code === 'BAD_ARG');
  await assert.rejects(h.saveResult({ entry: { foo: 1 } }, ctx), (e) => e.code === 'BAD_ARG');
  assert.deepEqual(await h.clearHistory({}, ctx), { cleared: 7 });
  assert.deepEqual(store.get('tool-sensi').history, []);
  assert.match((await h.summary({}, ctx)).text, /^Deine Sensi: 3,2 %/);
});

test('Modul: kaputter gespeicherter Zustand wird repariert statt abzustürzen', async () => {
  const { ctx } = fakeCtx({ settings: { dpi: 'kaputt' }, history: [null, 5, { at: 3, recommendedSens: 6.1 }, { at: 'x' }] });
  const st = await mod.handlers.state({}, ctx);
  assert.equal(st.saved, false);
  assert.equal(st.settings.dpi, 800);
  assert.equal(st.history.length, 1);
});

test('Sicherheit: Sensi schreibt keine Fortnite-Dateien, startet nichts, keine Registry, kein innerHTML', () => {
  const files = [
    'src/main/modules/tools/sensi.js', 'src/main/tools/sensi-logic.js',
    'src/renderer/js/views/sensi.js', 'src/renderer/js/mock/sensi.js',
    'src/renderer/js/lib/sensi-math.mjs', 'src/renderer/js/lib/sensi-rounds.mjs', 'src/renderer/js/lib/sensi-session.mjs', 'src/renderer/js/lib/sensi-arena.mjs',
  ].filter((f) => fs.existsSync(path.join(ROOT, f)));
  assert.ok(files.length >= 7, 'Dateien vorhanden');
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, `${f}: kein HTML aus Text`);
    assert.doesNotMatch(src, /applyIniChanges|writeValue|powershell|child_process|\.exec\.run|Engine\.ini/, `${f}: keine Schreibzugriffe aufs System`);
    assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${f}: keine Emojis`);
  }
});
