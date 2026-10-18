'use strict';
// Tests für die Sicht-Presets: Umrechnung, Preset-Daten, Sicherheitsregeln und der echte Ablauf
// Vorschau -> Anwenden mit dem CoreService (nachgemachter Fortnite-Ordner, nachgemachtes tasklist).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const rules = require('../../src/main/tools/sicht-rules');
const sicht = require('../../src/main/modules/tools/sicht');
const { CoreService } = require('../../src/main/core/service');
const { makeLocalAppData, tmpDir, fakeExec } = require('../helpers');

const LIB = path.join(__dirname, '../../src/renderer/js/lib/sicht-presets.mjs');
let lib;
test.before(async () => { lib = await import(pathToFileURL(LIB).href); });

const G = '/Script/FortniteGame.FortGameUserSettings';
const S = 'ScalabilityGroups';

// ---------------------------------------------------------------- Umrechnung
test('Helligkeit: DisplayGamma 1,7 / 2,2 / 2,7 = 50 / 100 / 150 %', () => {
  assert.equal(lib.gammaToPercent(1.7), 50);
  assert.equal(lib.gammaToPercent(2.2), 100);
  assert.equal(lib.gammaToPercent('2.700000'), 150);
  assert.equal(lib.gammaToPercent(2.35), 115);
  assert.equal(lib.gammaToPercent(3.5), 150, 'begrenzt auf 150 %');
  assert.equal(lib.gammaToPercent('abc'), null);
  assert.equal(lib.percentToGamma(100), 2.2);
  assert.equal(lib.percentToGamma(130), 2.5);
  assert.equal(lib.percentToGamma(10), 1.7, 'begrenzt auf 50 %');
  for (let p = 50; p <= 150; p++) assert.equal(lib.gammaToPercent(lib.percentToGamma(p)), p, `Hin und zurück ${p} %`);
});

test('Schreibweise wie Fortnite: 2.350000, True/False, Stufen als Ganzzahl', () => {
  assert.equal(lib.toIni('brightness', 115), '2.350000');
  assert.equal(lib.toIni('brightness', 100), '2.200000');
  assert.equal(lib.toIni('uiContrast', 1.2), '1.200000');
  assert.equal(lib.toIni('uiContrast', 9), '1.500000', 'begrenzt');
  assert.equal(lib.toIni('motionBlur', false), 'False');
  assert.equal(lib.toIni('grass', true), 'True');
  assert.equal(lib.toIni('shadows', 0), '0');
  assert.equal(lib.toIni('shadows', 7), '3');
  assert.throws(() => lib.toIni('ColorBlindMode', 1));
});

test('Werte aus der Datei lesen (Groß-/Kleinschreibung, fehlende Werte, Darstellungsmodus)', () => {
  const v = lib.valuesFromIni({
    [`${G}|DisplayGamma`]: '2.500000', [`${G}|bMotionBlur`]: 'false', [`${S}|sg.ShadowQuality`]: '2', [`${G}|UserInterfaceContrast`]: '1.25',
  });
  assert.equal(v.brightness, 130);
  assert.equal(v.motionBlur, false);
  assert.equal(v.shadows, 2);
  assert.equal(v.uiContrast, 1.25);
  assert.equal(v.grass, null);
  assert.equal(lib.renderMode({ 'D3DRHIPreference|PreferredFeatureLevel': 'es31' }).id, 'performance');
  assert.equal(lib.renderMode({ 'D3DRHIPreference|PreferredRHI': 'dx12' }).id, 'dx12');
  assert.equal(lib.renderMode({}).id, 'unknown');
  assert.equal(lib.valueText('shadows', 0), 'Aus');
  assert.equal(lib.valueText('effects', 0), 'Niedrig');
  assert.equal(lib.valueText('brightness', 115), '115 %');
  assert.equal(lib.valueText('uiContrast', 1.2), '1,20');
  assert.equal(lib.rawText(G, 'DisplayGamma', '2.200000'), '100 %');
  assert.equal(lib.rawText(G, 'DisplayGamma', null), 'nicht gesetzt');
});

// ---------------------------------------------------------------- Presets
test('Presets: die fünf gewünschten gibt es, jedes mit „wofür“ und Erklärung', () => {
  const ids = lib.PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['sturm', 'nacht', 'hell', 'turnier', 'standard']);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of lib.PRESETS) {
    assert.ok(p.name && p.short && p.wofuer && p.why, p.id);
    assert.ok(Object.keys(p.values).length >= 2, p.id);
    for (const s of p.inGame || []) assert.ok(s.title && s.text && s.why, `${p.id}: Schritt im Spiel vollständig`);
    if (p.values.brightness != null) assert.ok(p.values.brightness >= 50 && p.values.brightness <= 150);
  }
  assert.ok(lib.findPreset('sturm').inGame.some((s) => /Tritanopie/.test(s.title) && /5 bis 7/.test(s.title)), 'Sturm erklärt Farbenblind-Modus');
});

test('Sicherheit: Presets schreiben nur erlaubte lokale Werte – nie Farbenblind-Modus, HUD oder Engine.ini', () => {
  const allowed = new Set(rules.ALLOWED.map((a) => `${a.section}|${a.key}`));
  for (const p of lib.PRESETS) {
    const changes = lib.presetChanges(p, { original: { shadows: 2, postProcess: 3, effects: 1, foliage: 1, gi: 2, grass: true, motionBlur: true } });
    for (const c of changes) {
      assert.ok(allowed.has(`${c.section}|${c.key}`), `${p.id}: ${c.key}`);
      assert.doesNotMatch(c.key, /ColorBlind|HUD|Sensitivity|Region/i);
    }
    // jedes Preset besteht die strenge Prüfung des Hauptprozesses
    assert.doesNotThrow(() => rules.validateChanges(changes), p.id);
  }
  // Oberfläche und Hauptprozess kennen dieselben Schlüssel
  const fromLib = new Set(lib.KEY_IDS.map((id) => `${lib.KEYS[id].section}|${lib.KEYS[id].key}`));
  assert.deepEqual([...fromLib].sort(), [...allowed].sort());
  assert.ok(![...allowed].some((k) => /engine|colorblind|hud/i.test(k)));
});

test('„Standard zurück“: Helligkeit 100 %, Kontrast 1,0 und gemerkte Grafikwerte von vorher', () => {
  const std = lib.findPreset('standard');
  assert.deepEqual(lib.presetValues(std), { brightness: 100, uiContrast: 1 });
  const vals = lib.presetValues(std, { original: { brightness: 140, shadows: 2, effects: null, motionBlur: true } });
  assert.equal(vals.brightness, 100, 'Helligkeit immer Standard');
  assert.equal(vals.shadows, 2);
  assert.equal(vals.motionBlur, true);
  assert.equal('effects' in vals, false, 'fehlende Originalwerte werden übersprungen');
  const ch = lib.toChanges(vals);
  assert.ok(ch.some((c) => c.key === 'DisplayGamma' && c.value === '2.200000'));
  assert.ok(ch.some((c) => c.key === 'bMotionBlur' && c.value === 'True'));
});

test('Aktives Preset erkennen (und „Standard“ nicht ohne Originalwerte)', () => {
  const sturm = lib.findPreset('sturm');
  const now = { ...lib.presetValues(sturm), grass: true, foliage: 2, gi: 1 };
  assert.equal(lib.activePreset(now).id, 'sturm');
  assert.equal(lib.summaryText(now), 'Aktiv: Sturm');
  assert.equal(lib.activePreset({ ...now, brightness: 116 }), null, '1 % daneben = nicht aktiv');
  const fresh = { brightness: 100, uiContrast: 1, shadows: 2 };
  assert.equal(lib.activePreset(fresh), null, 'frisches Fortnite ist nicht „Standard zurück“');
  assert.equal(lib.activePreset(fresh, { original: { shadows: 2 } }).id, 'standard');
  assert.equal(lib.summaryText(fresh), 'Kein Sicht-Preset aktiv · Helligkeit 100 %');
  assert.equal(lib.summaryText({}), null);
  assert.equal(lib.matchesValues(now, {}), false);
});

test('Eigener Wert wird begrenzt und richtig formatiert', () => {
  assert.deepEqual(lib.customValues({ brightness: 300, uiContrast: 0.2 }), { brightness: 150, uiContrast: 1 });
  assert.deepEqual(lib.customValues({ brightness: '121.6', uiContrast: '1.234' }), { brightness: 122, uiContrast: 1.23 });
  const ch = lib.toChanges(lib.customValues({ brightness: 120, uiContrast: 1.3 }));
  assert.deepEqual(ch, [
    { section: G, key: 'DisplayGamma', value: '2.400000' },
    { section: G, key: 'UserInterfaceContrast', value: '1.300000' },
  ]);
  assert.doesNotThrow(() => rules.validateChanges(ch));
});

// ---------------------------------------------------------------- Regeln im Hauptprozess
test('Regeln: alles außerhalb der Liste oder im falschen Format wird abgelehnt', () => {
  const bad = (changes) => assert.throws(() => rules.validateChanges(changes), (e) => e.code === 'BAD_CHANGE', JSON.stringify(changes));
  bad([]);
  bad(null);
  bad([{ section: 'SystemSettings', key: 'r.Fog', value: '0' }]);
  bad([{ section: G, key: 'FrameRateLimit', value: '0.000000' }]);
  bad([{ section: G, key: 'ColorBlindMode', value: '1' }]);
  bad([{ section: G, key: 'DisplayGamma', value: '2.2' }]);
  bad([{ section: G, key: 'DisplayGamma', value: '3.000000' }]);
  bad([{ section: G, key: 'DisplayGamma', value: '1.600000' }]);
  bad([{ section: G, key: 'UserInterfaceContrast', value: '0.900000' }]);
  bad([{ section: G, key: 'bMotionBlur', value: 'true' }]);
  bad([{ section: S, key: 'sg.ShadowQuality', value: '4' }]);
  bad([{ section: S, key: 'sg.ShadowQuality', value: '0\r\n[Evil]' }]);
  bad([{ section: S, key: 'sg.ShadowQuality', value: '0' }, { section: S, key: 'SG.SHADOWQUALITY', value: '1' }]);
  const ok = rules.validateChanges([{ section: 'scalabilitygroups', key: 'SG.EFFECTSQUALITY', value: '0' }]);
  assert.deepEqual(ok, [{ section: S, key: 'sg.EffectsQuality', value: '0' }], 'Schreibweise wird vereinheitlicht');
});

test('Regeln: Zeile fürs Cockpit', () => {
  const raw = { [`${G}|DisplayGamma`]: '2.350000', [`${S}|sg.ShadowQuality`]: '0' };
  const last = { id: 'sturm', name: 'Sturm', short: 'Sturm', changes: [{ section: G, key: 'DisplayGamma', value: '2.350000' }, { section: S, key: 'sg.ShadowQuality', value: '0' }] };
  assert.deepEqual(rules.summaryText({ last }, raw), { text: 'Aktiv: Sturm' });
  assert.deepEqual(rules.summaryText({ last }, { ...raw, [`${G}|DisplayGamma`]: '2.35' }), { text: 'Aktiv: Sturm' }, '2.35 = 2.350000');
  assert.deepEqual(rules.summaryText({ last }, { ...raw, [`${G}|DisplayGamma`]: '2.200000' }), { text: 'Kein Sicht-Preset aktiv · Helligkeit 100 %' });
  assert.deepEqual(rules.summaryText({ last: { ...last, id: 'eigen' } }, raw), { text: 'Aktiv: eigene Sicht-Werte' });
  assert.equal(rules.summaryText({}, {}), null);
  assert.equal(rules.cleanName('  „Böse“\u0000Name  ', 'x'), 'BöseName');
  assert.equal(rules.cleanName('', 'Ersatz'), 'Ersatz');
});

// ---------------------------------------------------------------- Ablauf mit echtem CoreService
function setup({ running = [] } = {}) {
  const fx = makeLocalAppData();
  const ref = { value: running };
  const core = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: fx.local }, exec: fakeExec(ref) });
  const events = [];
  const ctx = { core, env: { LOCALAPPDATA: fx.local }, emit: (n, p) => events.push([n, p]) };
  return { fx, core, ctx, ref, events, gus: path.join(fx.wc, 'GameUserSettings.ini'), engine: path.join(fx.wc, 'Engine.ini') };
}

test('Ablauf: aktuelle Werte -> Vorschau -> Anwenden mit Sicherung -> Cockpit-Zeile', async () => {
  const { core, ctx, gus, engine, events } = setup();
  await core.init();
  const engineBefore = fs.readFileSync(engine);
  const cur = await sicht.handlers.current({}, ctx);
  assert.equal(cur.found, true);
  assert.equal(lib.valuesFromIni(cur.raw).brightness, 100);
  assert.equal(cur.original, null);

  const changes = lib.presetChanges(lib.findPreset('sturm'));
  const prev = await sicht.handlers.preview({ changes }, ctx);
  assert.ok(prev.changes.find((c) => c.key === 'DisplayGamma').changed);
  assert.equal(prev.changes.find((c) => c.key === 'sg.ShadowQuality').changed, false, 'Schatten war schon aus');
  assert.equal(fs.readFileSync(gus, 'utf8').includes('DisplayGamma=2.200000'), true, 'Vorschau schreibt nichts');

  const r = await sicht.handlers.apply({ changes, presetId: 'sturm', presetName: 'Sturm', presetShort: 'Sturm' }, ctx);
  assert.equal(r.label, 'Sicht-Preset „Sturm“');
  assert.ok(r.backupId);
  const text = fs.readFileSync(gus, 'utf8');
  assert.match(text, /DisplayGamma=2\.350000\r\n/);
  assert.match(text, /UserInterfaceContrast=1\.200000/);
  assert.match(text, /bMotionBlur=False/);
  assert.deepEqual(fs.readFileSync(engine), engineBefore, 'Engine.ini bleibt unberührt');
  const backups = await core.listBackups();
  assert.ok(backups.some((b) => b.reason === 'tool' && b.label === 'Sicht-Preset „Sturm“'), 'Sicherung mit deutschem Namen');
  assert.deepEqual(events.map((e) => e[0]), ['sicht.applied']);

  const st = await core.readState('tool-sicht', {});
  assert.equal(st.original[`${G}|DisplayGamma`], '2.200000', 'Originalwerte gemerkt');
  assert.equal(st.last.id, 'sturm');
  assert.deepEqual(await sicht.handlers.summary({}, ctx), { text: 'Aktiv: Sturm' });

  // zweites Preset: Originalwerte bleiben die vom allerersten Mal
  await sicht.handlers.apply({ changes: lib.presetChanges(lib.findPreset('nacht')), presetId: 'nacht', presetName: 'Nacht / Dunkle Gebiete', presetShort: 'Nacht' }, ctx);
  const st2 = await core.readState('tool-sicht', {});
  assert.equal(st2.original[`${G}|DisplayGamma`], '2.200000');
  assert.deepEqual(await sicht.handlers.summary({}, ctx), { text: 'Aktiv: Nacht' });

  // „Standard zurück“ holt die alten Werte (Bewegungsunschärfe war aus, Schatten 0)
  const std = lib.findPreset('standard');
  const orig = lib.valuesFromIni(st2.original);
  await sicht.handlers.apply({ changes: lib.presetChanges(std, { original: orig }), presetId: 'standard', presetName: std.name, presetShort: std.short }, ctx);
  assert.match(fs.readFileSync(gus, 'utf8'), /DisplayGamma=2\.200000\r\n/);
  assert.match(fs.readFileSync(gus, 'utf8'), /UserInterfaceContrast=1\.000000/);

  // Spieler ändert im Spiel die Helligkeit -> nicht mehr aktiv
  fs.writeFileSync(gus, fs.readFileSync(gus, 'utf8').replace('DisplayGamma=2.200000', 'DisplayGamma=2.600000'));
  assert.deepEqual(await sicht.handlers.summary({}, ctx), { text: 'Kein Sicht-Preset aktiv · Helligkeit 140 %' });
});

test('Ablauf: Fortnite läuft -> nichts wird geschrieben', async () => {
  const { core, ctx, gus } = setup({ running: ['FortniteClient-Win64-Shipping.exe'] });
  await core.init();
  const before = fs.readFileSync(gus, 'utf8');
  const changes = lib.presetChanges(lib.findPreset('nacht'));
  const prev = await sicht.handlers.preview({ changes }, ctx);
  assert.equal(prev.fortnite.running, true, 'Vorschau geht trotzdem und meldet Fortnite');
  await assert.rejects(() => sicht.handlers.apply({ changes, presetId: 'nacht', presetName: 'Nacht' }, ctx), (e) => e.code === 'FORTNITE_RUNNING');
  assert.equal(fs.readFileSync(gus, 'utf8'), before);
  assert.equal((await core.readState('tool-sicht', {})).last, undefined);
});

test('Ablauf: unerlaubte Änderungen und falsche Preset-Namen lehnt der Hauptprozess ab', async () => {
  const { core, ctx, gus } = setup();
  await core.init();
  const before = fs.readFileSync(gus, 'utf8');
  await assert.rejects(() => sicht.handlers.apply({ changes: [{ section: G, key: 'FrameRateLimit', value: '0.000000' }], presetId: 'x' }, ctx), (e) => e.code === 'BAD_CHANGE');
  await assert.rejects(() => sicht.handlers.preview({ changes: [{ section: 'SystemSettings', key: 'r.Fog', value: '0' }] }, ctx), (e) => e.code === 'BAD_CHANGE');
  await assert.rejects(() => sicht.handlers.apply({ changes: lib.presetChanges(lib.findPreset('hell')), presetId: '../böse' }, ctx), (e) => e.code === 'BAD_ARG');
  assert.equal(fs.readFileSync(gus, 'utf8'), before);
});

test('Ohne Fortnite-Ordner: freundliche Antwort statt Fehler, Cockpit-Zeile null', async () => {
  const core = new CoreService({ dataDir: tmpDir(), env: { LOCALAPPDATA: tmpDir('leer-') }, exec: fakeExec() });
  const ctx = { core, env: {}, emit: () => {} };
  const cur = await sicht.handlers.current({}, ctx);
  assert.equal(cur.found, false);
  assert.equal(cur.reason, 'NO_FORTNITE');
  assert.equal(await sicht.handlers.summary({}, ctx), null);
});

test('Modul: id und Handler', () => {
  assert.equal(sicht.id, 'sicht');
  assert.deepEqual(Object.keys(sicht.handlers).sort(), ['apply', 'current', 'preview', 'summary']);
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/modules/tools/sicht.js'), 'utf8');
  assert.doesNotMatch(src, /writeFile|registry|Engine\.ini|ClientSettings/, 'schreibt nur über ctx.core.applyIniChanges');
});
