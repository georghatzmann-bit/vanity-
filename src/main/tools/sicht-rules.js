'use strict';
// Sicht-Presets: Sicherheitsregeln im Hauptprozess.
// Die Oberfläche schickt fertige Änderungen. Hier wird streng geprüft, dass nur die
// erlaubten LOKALEN Werte aus GameUserSettings.ini geschrieben werden – im Fortnite-Format
// (Kommazahlen mit 6 Nachkommastellen, True/False, Stufen 0–3). Alles andere wird abgelehnt.
// Engine.ini, Farbenblind-Modus und HUD (Epic-Cloud) sind hier absichtlich nicht enthalten.

const { HelixError } = require('../sys/exec');

const FILE = 'GameUserSettings.ini';
const S_GUS = '/Script/FortniteGame.FortGameUserSettings';
const S_SG = 'ScalabilityGroups';

const ALLOWED = [
  { section: S_GUS, key: 'DisplayGamma', type: 'float', min: 1.7, max: 2.7 },
  { section: S_GUS, key: 'UserInterfaceContrast', type: 'float', min: 1, max: 1.5 },
  { section: S_SG, key: 'sg.ShadowQuality', type: 'level' },
  { section: S_SG, key: 'sg.PostProcessQuality', type: 'level' },
  { section: S_SG, key: 'sg.EffectsQuality', type: 'level' },
  { section: S_SG, key: 'sg.FoliageQuality', type: 'level' },
  { section: S_SG, key: 'sg.GlobalIlluminationQuality', type: 'level' },
  { section: S_GUS, key: 'bShowGrass', type: 'bool' },
  { section: S_GUS, key: 'bMotionBlur', type: 'bool' },
];

/** Zusätzlich nur gelesen (Darstellungsmodus). */
const READ_EXTRA = [
  { section: 'D3DRHIPreference', key: 'PreferredFeatureLevel' },
  { section: 'D3DRHIPreference', key: 'PreferredRHI' },
];

const keyId = (section, key) => `${String(section).toLowerCase()}|${String(key).toLowerCase()}`;
const BY_ID = new Map(ALLOWED.map((a) => [keyId(a.section, a.key), a]));

function findRule(section, key) {
  return BY_ID.get(keyId(section, key)) || null;
}

function validValue(rule, value) {
  const v = String(value);
  if (rule.type === 'float') {
    if (!/^\d+\.\d{6}$/.test(v)) return false;
    const n = Number(v);
    return n >= rule.min - 1e-9 && n <= rule.max + 1e-9;
  }
  if (rule.type === 'bool') return v === 'True' || v === 'False';
  if (rule.type === 'level') return /^[0-3]$/.test(v);
  return false;
}

/**
 * Prüft die Änderungen und gibt sie in der Original-Schreibweise der Abschnitte/Schlüssel zurück.
 * Wirft HelixError('BAD_CHANGE') bei allem, was nicht erlaubt ist.
 */
function validateChanges(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > ALLOWED.length) {
    throw new HelixError('BAD_CHANGE', 'Es wurden keine gültigen Änderungen übergeben.');
  }
  const seen = new Set();
  return changes.map((c) => {
    const rule = c && findRule(c.section, c.key);
    if (!rule) throw new HelixError('BAD_CHANGE', `Der Wert „${String(c?.key ?? '?').slice(0, 60)}“ darf von den Sicht-Presets nicht geändert werden.`);
    const id = keyId(rule.section, rule.key);
    if (seen.has(id)) throw new HelixError('BAD_CHANGE', `Der Wert „${rule.key}“ kommt doppelt vor.`);
    seen.add(id);
    if (!validValue(rule, c.value)) throw new HelixError('BAD_CHANGE', `Ungültiger Wert für „${rule.key}“.`);
    return { section: rule.section, key: rule.key, value: String(c.value) };
  });
}

function sameValue(a, b) {
  if (a == null || b == null) return false;
  const x = String(a).trim();
  const y = String(b).trim();
  if (x.toLowerCase() === y.toLowerCase()) return true;
  const nx = Number(x);
  const ny = Number(y);
  return x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) && Math.abs(nx - ny) < 0.0005;
}

function gammaToPercent(g) {
  const n = Number(g);
  if (!Number.isFinite(n)) return null;
  return Math.min(150, Math.max(50, Math.round((n - 2.2) * 100 + 100)));
}

/** Gilt das zuletzt angewendete Preset noch? raw = { 'Abschnitt|Schlüssel': Text } */
function lastStillActive(last, raw) {
  if (!last || !Array.isArray(last.changes) || !last.changes.length) return false;
  return last.changes.every((c) => sameValue(raw[`${c.section}|${c.key}`], c.value));
}

// ---------- Preset-Erkennung fürs Cockpit ----------
// Dieselben Preset-Werte und dieselbe Erkennung wie in src/renderer/js/lib/sicht-presets.mjs
// (PRESETS, valuesFromIni, presetValues, activePreset) – ein Test stellt sicher, dass beide gleich bleiben.
// So zeigt das Cockpit „Aktiv: Sturm“ auch nach „Rückgängig machen“ oder einem Settings-Profil,
// genau wie die Sicht-Ansicht.

const VALUE_KEYS = {
  brightness: { section: S_GUS, key: 'DisplayGamma', type: 'gamma' },
  uiContrast: { section: S_GUS, key: 'UserInterfaceContrast', type: 'float' },
  shadows: { section: S_SG, key: 'sg.ShadowQuality', type: 'level' },
  postProcess: { section: S_SG, key: 'sg.PostProcessQuality', type: 'level' },
  effects: { section: S_SG, key: 'sg.EffectsQuality', type: 'level' },
  foliage: { section: S_SG, key: 'sg.FoliageQuality', type: 'level' },
  gi: { section: S_SG, key: 'sg.GlobalIlluminationQuality', type: 'level' },
  grass: { section: S_GUS, key: 'bShowGrass', type: 'bool' },
  motionBlur: { section: S_GUS, key: 'bMotionBlur', type: 'bool' },
};
const VALUE_IDS = Object.keys(VALUE_KEYS);

const PRESETS = [
  { id: 'sturm', name: 'Sturm', short: 'Sturm', values: { brightness: 115, uiContrast: 1.2, shadows: 0, postProcess: 0, effects: 0, motionBlur: false } },
  { id: 'nacht', name: 'Nacht / Dunkle Gebiete', short: 'Nacht', values: { brightness: 130, uiContrast: 1.1, shadows: 0, postProcess: 0, motionBlur: false } },
  { id: 'hell', name: 'Helle Karte', short: 'Helle Karte', values: { brightness: 90, uiContrast: 1.3, postProcess: 0, effects: 0, motionBlur: false } },
  { id: 'turnier', name: 'Turnier-Klarheit', short: 'Turnier-Klarheit', values: { brightness: 110, uiContrast: 1, shadows: 0, postProcess: 0, effects: 0, foliage: 0, grass: false, motionBlur: false } },
  { id: 'standard', name: 'Standard zurück', short: 'Standard', values: { brightness: 100, uiContrast: 1 }, restoreOriginal: true },
];

const round2 = (v) => Math.round((v + Number.EPSILON * Math.sign(v)) * 100) / 100;

function parseNum(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

function fromIni(id, raw) {
  const def = VALUE_KEYS[id];
  if (!def || raw == null) return null;
  if (def.type === 'bool') {
    const t = String(raw).trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
    return null;
  }
  const n = parseNum(raw);
  if (n == null) return null;
  if (def.type === 'gamma') return gammaToPercent(n);
  if (def.type === 'float') return round2(n);
  return Math.round(n);
}

/** { 'Abschnitt|Schlüssel': Text } -> { brightness: 115, shadows: 0, … } */
function valuesFromIni(raw = {}) {
  const out = {};
  for (const id of VALUE_IDS) {
    const d = VALUE_KEYS[id];
    out[id] = fromIni(id, raw[`${d.section}|${d.key}`] ?? null);
  }
  return out;
}

function presetValues(preset, { original } = {}) {
  const vals = { ...preset.values };
  if (preset.restoreOriginal && original) {
    for (const id of VALUE_IDS) {
      if (id in preset.values) continue;
      if (original[id] != null) vals[id] = original[id];
    }
  }
  return vals;
}

function sameFach(id, a, b) {
  if (a == null || b == null) return false;
  const t = VALUE_KEYS[id].type;
  if (t === 'float') return Math.abs(a - b) < 0.006;
  if (t === 'gamma') return Math.abs(a - b) < 0.6;
  return a === b;
}

function matchesValues(current, values) {
  const ids = Object.keys(values).filter((id) => values[id] != null);
  return ids.length > 0 && ids.every((id) => sameFach(id, current?.[id], values[id]));
}

/** Welches Preset passt zu den Werten? (genaueste Übereinstimmung; „Standard“ nur mit Originalwerten) */
function activePreset(current, { original } = {}) {
  let best = null;
  let bestN = 0;
  for (const p of PRESETS) {
    if (p.restoreOriginal && !original) continue;
    const vals = presetValues(p, { original });
    if (!matchesValues(current, vals)) continue;
    const n = Object.keys(vals).length;
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

/** Zeile fürs Cockpit oder null. */
function summaryText(state, raw) {
  if (!raw) return null;
  const original = state?.original ? valuesFromIni(state.original) : null;
  const p = activePreset(valuesFromIni(raw), { original });
  if (p) return { text: `Aktiv: ${p.short || p.name}` };
  const last = state?.last;
  if (last && last.id === 'eigen' && lastStillActive(last, raw)) return { text: 'Aktiv: eigene Sicht-Werte' };
  const pct = gammaToPercent(raw[`${S_GUS}|DisplayGamma`]);
  if (pct == null) return null;
  return { text: `Kein Sicht-Preset aktiv · Helligkeit ${pct} %` };
}

function cleanName(name, fallback) {
  const n = String(name ?? '').replace(/[\u0000-\u001f„“"<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return n || fallback;
}

function readKeys() {
  return [...ALLOWED, ...READ_EXTRA].map(({ section, key }) => ({ section, key }));
}

module.exports = {
  FILE, S_GUS, S_SG, ALLOWED, READ_EXTRA, findRule, validValue, validateChanges, sameValue,
  gammaToPercent, lastStillActive, summaryText, cleanName, readKeys,
  PRESETS, valuesFromIni, presetValues, activePreset,
};
