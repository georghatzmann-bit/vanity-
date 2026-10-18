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

/** Datei-Werte ({ 'Abschnitt|Schlüssel': Text }) aus Änderungen */
const rawOf = (changes) => Object.fromEntries(changes.map((c) => [`${c.section}|${c.key}`, c.value]));

test('Regeln: Zeile fürs Cockpit', () => {
  const sturm = lib.presetChanges(lib.findPreset('sturm'));
  const raw = { ...rawOf(sturm), [`${S}|sg.FoliageQuality`]: '2' };
  const last = { id: 'sturm', name: 'Sturm', short: 'Sturm', changes: sturm };
  assert.deepEqual(rules.summaryText({ last }, raw), { text: 'Aktiv: Sturm' });
  assert.deepEqual(rules.summaryText({}, raw), { text: 'Aktiv: Sturm' }, 'auch ohne gemerktes letztes Preset – wie die Ansicht');
  assert.deepEqual(rules.summaryText({ last }, { ...raw, [`${G}|DisplayGamma`]: '2.35' }), { text: 'Aktiv: Sturm' }, '2.35 = 2.350000');
  assert.deepEqual(rules.summaryText({ last }, { ...raw, [`${G}|DisplayGamma`]: '2.200000' }), { text: 'Kein Sicht-Preset aktiv · Helligkeit 100 %' });
  // eigene Werte: nur solange sie noch in der Datei stehen
  const eigen = lib.toChanges(lib.customValues({ brightness: 121, uiContrast: 1.15 }));
  const rawEigen = { ...raw, ...rawOf(eigen) };
  assert.deepEqual(rules.summaryText({ last: { id: 'eigen', changes: eigen } }, rawEigen), { text: 'Aktiv: eigene Sicht-Werte' });
  assert.deepEqual(rules.summaryText({ last: { id: 'eigen', changes: eigen } }, raw), { text: 'Aktiv: Sturm' }, 'Preset geht vor alten eigenen Werten');
  assert.deepEqual(rules.summaryText({ last: { id: 'sturm', changes: eigen } }, rawEigen), { text: 'Kein Sicht-Preset aktiv · Helligkeit 121 %' });
  // „Standard“ nur mit gemerkten Originalwerten
  const fresh = { [`${G}|DisplayGamma`]: '2.200000', [`${G}|UserInterfaceContrast`]: '1.000000', [`${S}|sg.ShadowQuality`]: '2' };
  assert.deepEqual(rules.summaryText({}, fresh), { text: 'Kein Sicht-Preset aktiv · Helligkeit 100 %' });
  assert.deepEqual(rules.summaryText({ original: { [`${S}|sg.ShadowQuality`]: '2' } }, fresh), { text: 'Aktiv: Standard' });
  assert.equal(rules.summaryText({}, {}), null);
  assert.equal(rules.cleanName('  „Böse“\u0000Name  ', 'x'), 'BöseName');
  assert.equal(rules.cleanName('', 'Ersatz'), 'Ersatz');
});

test('Cockpit und Ansicht kennen dieselben Presets und erkennen sie gleich', () => {
  assert.deepEqual(
    rules.PRESETS.map((p) => ({ id: p.id, name: p.name, short: p.short, values: p.values, restoreOriginal: !!p.restoreOriginal })),
    lib.PRESETS.map((p) => ({ id: p.id, name: p.name, short: p.short, values: p.values, restoreOriginal: !!p.restoreOriginal })),
  );
  // gleiche Erkennung für viele Datei-Stände (Presets, leicht daneben, andere Schreibweise, mit/ohne Originalwerte)
  const origRaw = rawOf(lib.toChanges({ brightness: 120, uiContrast: 1, shadows: 2, postProcess: 3, effects: 1, foliage: 1, gi: 2, grass: true, motionBlur: true }));
  const variants = [];
  for (const p of lib.PRESETS) {
    for (const opts of [{}, { original: lib.valuesFromIni(origRaw) }]) {
      const base = rawOf(lib.presetChanges(p, opts));
      variants.push(base, { ...base, [`${S}|sg.GlobalIlluminationQuality`]: '3' });
      variants.push({ ...base, [`${G}|DisplayGamma`]: (Number(base[`${G}|DisplayGamma`]) + 0.004).toFixed(6) }, { ...base, [`${G}|DisplayGamma`]: (Number(base[`${G}|DisplayGamma`]) + 0.01).toFixed(6) });
      variants.push({ ...base, [`${G}|UserInterfaceContrast`]: (Number(base[`${G}|UserInterfaceContrast`]) + 0.004).toFixed(2) });
      if (base[`${G}|bMotionBlur`]) variants.push({ ...base, [`${G}|bMotionBlur`]: base[`${G}|bMotionBlur`].toLowerCase() }, { ...base, [`${G}|bMotionBlur`]: 'True' });
      if (base[`${S}|sg.ShadowQuality`]) variants.push({ ...base, [`${S}|sg.ShadowQuality`]: '0.0' }, { ...base, [`${S}|sg.ShadowQuality`]: '1' });
    }
  }
  for (let g = 1.7; g <= 2.7; g += 0.0125) variants.push({ ...rawOf(lib.presetChanges(lib.findPreset('nacht'))), [`${G}|DisplayGamma`]: g.toFixed(6) });
  for (const raw of variants) {
    for (const original of [null, origRaw]) {
      const viewP = lib.activePreset(lib.valuesFromIni(raw), { original: original ? lib.valuesFromIni(original) : null });
      const mainP = rules.activePreset(rules.valuesFromIni(raw), { original: original ? rules.valuesFromIni(original) : null });
      assert.equal(mainP?.id ?? null, viewP?.id ?? null, JSON.stringify(raw));
    }
  }
  assert.deepEqual(rules.valuesFromIni(origRaw), lib.valuesFromIni(origRaw));
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

test('Ablauf: nach „Rückgängig machen“ zeigt das Cockpit dasselbe Preset wie die Ansicht', async () => {
  const { core, ctx } = setup();
  await core.init();
  const P = (id) => lib.findPreset(id);
  await sicht.handlers.apply({ changes: lib.presetChanges(P('sturm')), presetId: 'sturm', presetName: 'Sturm', presetShort: 'Sturm' }, ctx);
  const r2 = await sicht.handlers.apply({ changes: lib.presetChanges(P('nacht')), presetId: 'nacht', presetName: 'Nacht / Dunkle Gebiete', presetShort: 'Nacht' }, ctx);
  assert.deepEqual(await sicht.handlers.summary({}, ctx), { text: 'Aktiv: Nacht' });
  // „Rückgängig machen“ im Ergebniskasten = backups.restore -> die Datei hat wieder die Sturm-Werte
  assert.equal((await core.restoreBackup(r2.backupId)).ok, true);
  const cur = await sicht.handlers.current({}, ctx);
  const viewActive = lib.activePreset(lib.valuesFromIni(cur.raw), { original: cur.original ? lib.valuesFromIni(cur.original) : null });
  assert.equal(viewActive?.id, 'sturm', 'Ansicht: Aktiv: Sturm');
  assert.equal(cur.last.id, 'nacht', 'zuletzt angewendet war Nacht');
  assert.deepEqual(await sicht.handlers.summary({}, ctx), { text: 'Aktiv: Sturm' }, 'Cockpit sagt dasselbe');
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

// ---------------------------------------------------------------- Ansicht (nachgemachte Oberfläche)
// Ein sehr kleines Element-Modell statt eines Browsers: reicht, um die Ansicht zu laden, Knöpfe zu drücken
// und zu prüfen, was der Nutzer sieht. ui kommt wie in der App über env.ui.

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
    this.scrolled = [];
  }
  get classList() {
    const s = this.cls;
    return { add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c) };
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.tagName === '#TEXT' ? this.text : this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { [...this.children].forEach((c) => this.removeChild(c)); if (v != null && v !== '') this.append(v); }
  appendChild(c) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs.flat(Infinity)) if (c != null && c !== false) this.appendChild(c instanceof FakeEl ? c : textNode(c)); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  click() { return Promise.all((this.listeners.click || []).map((f) => f({ currentTarget: this, target: this, preventDefault() {} }))); }
  focus() {}
  scrollIntoView(opts) { this.scrolled.push(opts ?? true); }
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

function fakeUi() {
  const toasts = [];
  const modals = [];
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
      if (onClick) {
        b.addEventListener('click', async (e) => {
          if (b.dataset.busy) return;
          b.dataset.busy = '1';
          try { await onClick(e); } finally { delete b.dataset.busy; }
        });
      }
      return b;
    },
    toast: (msg, type = 'ok') => { toasts.push({ msg, type }); },
    showError: (e, title) => { toasts.push({ msg: `${title || 'Fehler'}: ${e.message}`, type: 'err' }); },
    emptyState: ({ title, text, action }) => h('div.empty', h('h3', title), h('p.hint', text), action || null),
    section: (title, hint, ...c) => h('section.block', h('h3', title), hint ? h('p.hint', hint) : null, c),
    badge: (t) => h('span.badge', t),
    spinner: () => h('span.spinner'),
    // wie ui.modal: Esc/X/„Abbrechen“ = close(null); ein Knopf mit onClick schließt erst, wenn onClick nicht false liefert
    modal(opts) {
      return new Promise((resolve) => {
        const m = { opts, open: true };
        m.close = (v) => { if (!m.open) return; m.open = false; resolve(v); };
        m.press = async (re) => {
          const a = opts.actions.find((x) => re.test(x.label));
          const r = a.onClick ? await a.onClick({ close: m.close }) : undefined;
          if (r !== false) m.close(a.value ?? a.label);
        };
        modals.push(m);
      });
    },
  };
  return { ui, toasts, modals };
}

/** Lädt die Ansicht (als .mjs-Kopie, damit Node sie ohne "type": "module" als ES-Modul liest). */
async function loadView() {
  const dir = tmpDir('helix-view-');
  fs.mkdirSync(path.join(dir, 'views'));
  fs.mkdirSync(path.join(dir, 'lib'));
  const src = path.join(__dirname, '../../src/renderer/js/views/sicht.js');
  for (const m of fs.readFileSync(src, 'utf8').matchAll(/from '\.\.\/lib\/([\w-]+\.mjs)'/g)) {
    fs.copyFileSync(path.join(path.dirname(LIB), m[1]), path.join(dir, 'lib', m[1]));
  }
  // geteilte Ansichts-Bausteine (z. B. ./profile-sync.js) mitkopieren; package.json macht sie zu ES-Modulen
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const m of fs.readFileSync(src, 'utf8').matchAll(/from '\.\/([\w-]+\.js)'/g)) {
    fs.copyFileSync(path.join(path.dirname(src), m[1]), path.join(dir, 'views', m[1]));
  }
  fs.copyFileSync(src, path.join(dir, 'views', 'sicht.mjs'));
  return (await import(pathToFileURL(path.join(dir, 'views', 'sicht.mjs')).href)).default;
}

/** Ansicht mit nachgemachtem Hauptprozess: sicht.apply wartet, bis der Test es freigibt. */
async function mountView({ holdApply = false } = {}) {
  const raw = { [`${G}|DisplayGamma`]: '2.200000', [`${G}|UserInterfaceContrast`]: '1.000000', [`${G}|bMotionBlur`]: 'True', [`${S}|sg.ShadowQuality`]: '2', [`${S}|sg.PostProcessQuality`]: '2', [`${S}|sg.EffectsQuality`]: '1' };
  let release;
  const gate = holdApply ? new Promise((r) => { release = r; }) : Promise.resolve();
  const calls = [];
  const { ui, toasts, modals } = fakeUi();
  const env = {
    ui,
    on: () => () => {},
    nav: { go() {} },
    refreshStatus() {},
    async call(name, a = {}) {
      calls.push(name);
      if (name === 'sicht.current') return { found: true, rel: 'WindowsClient/GameUserSettings.ini', raw: { ...raw }, fortnite: { running: false }, original: null, last: null };
      if (name === 'sicht.preview') {
        return { readOnly: false, fortnite: { running: false }, changes: a.changes.map((c) => ({ ...c, from: raw[`${c.section}|${c.key}`] ?? null, to: c.value, changed: raw[`${c.section}|${c.key}`] !== c.value })) };
      }
      if (name === 'sicht.apply') {
        await gate;
        const applied = a.changes.filter((c) => raw[`${c.section}|${c.key}`] !== c.value);
        for (const c of applied) raw[`${c.section}|${c.key}`] = c.value;
        return { applied, backupId: '20261018-101500-ab12', label: 'Sicht-Preset' };
      }
      if (name === 'core.fortniteStatus') return { running: false };
      throw new Error(`unerwarteter Aufruf ${name}`);
    },
  };
  const root = new FakeEl('div');
  await view.mount(root, env);
  return { root, env, raw, calls, toasts, modals, release: () => release?.() };
}

let view;
const savedGlobals = {};
test.before(async () => {
  view = await loadView();
  for (const [k, v] of Object.entries({
    document: { body: new FakeEl('body'), querySelectorAll: () => [] },
    requestAnimationFrame: (f) => setTimeout(f, 0),
  })) {
    savedGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
test.after(async () => {
  await new Promise((r) => setTimeout(r, 20)); // offene requestAnimationFrame-Aufrufe der Ansicht laufen noch mit den Ersatz-Objekten
  for (const [k, d] of Object.entries(savedGlobals)) {
    if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
  }
  view?.unmount();
});

test('Ansicht: Dialog schließen, während noch angewendet wird -> echtes Ergebnis statt „nichts wurde geändert“', async () => {
  const v = await mountView({ holdApply: true });
  const flow = buttonsWith(v.root, /Vorschau & anwenden/)[0].click(); // Karte „Sturm“
  while (!v.modals.length) await tick();
  const m = v.modals[0];
  assert.match(m.opts.title, /Sturm/);
  m.press(/Werte? anwenden$/); // sicht.apply läuft und wartet
  await tick();
  m.close(null); // Esc / X / „Abbrechen“ mitten im Anwenden
  await tick();
  await tick();
  assert.ok(!v.toasts.some((t) => /nichts wurde geändert/.test(t.msg)), `keine falsche Entwarnung: ${JSON.stringify(v.toasts)}`);
  v.release(); // die Datei wird geschrieben
  await flow;
  assert.equal(v.raw[`${G}|DisplayGamma`], '2.350000');
  assert.ok(v.toasts.some((t) => /Sicht-Preset „Sturm“ angewendet/.test(t.msg)), JSON.stringify(v.toasts));
  assert.ok(!v.toasts.some((t) => /nichts wurde geändert/.test(t.msg)));
  assert.match(byClass(v.root, 'sicht-result')[0].textContent, /„Sturm“ ist aktiv.*Rückgängig machen/);
  assert.equal(v.calls.filter((c) => c === 'sicht.current').length, 2, 'Werte neu eingelesen');
  assert.match(byClass(v.root, 'sicht-meta')[0].textContent, /Aktiv: Sturm/);
});

test('Ansicht: echtes Abbrechen meldet „nichts wurde geändert“ und schreibt nichts', async () => {
  const v = await mountView();
  const flow = buttonsWith(v.root, /Vorschau & anwenden/)[1].click(); // Karte „Nacht“
  while (!v.modals.length) await tick();
  v.modals[0].close(null);
  await flow;
  assert.deepEqual(v.toasts.map((t) => t.msg), ['Abgebrochen – nichts wurde geändert.']);
  assert.equal(v.calls.includes('sicht.apply'), false);
  assert.equal(byClass(v.root, 'sicht-result')[0].children.length, 0);
});

test('Ansicht: der Kasten mit „Rückgängig machen“ wird nach dem Anwenden ins Bild geholt', async () => {
  const v = await mountView();
  const flow = buttonsWith(v.root, /Vorschau & anwenden/)[1].click(); // Karte „Nacht“ (liegt unten)
  while (!v.modals.length) await tick();
  await v.modals[0].press(/Werte? anwenden$/);
  await flow;
  const box = byClass(byClass(v.root, 'sicht-result')[0], 'callout')[0];
  assert.ok(box, 'Ergebnis-Kasten da');
  assert.match(box.textContent, /Rückgängig machen/);
  assert.match(box.textContent, /Denk an den Schritt im Spiel/);
  assert.equal(box.scrolled.length, 1, 'scrollIntoView aufgerufen');
  assert.equal(box.scrolled[0].block, 'nearest');
});
