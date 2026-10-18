// Simulator für die Sicht-Presets (nur Browser-Vorschau).
// Hält eine kleine Kopie der Fortnite-Werte im Speicher, damit Vorschau und Anwenden echt wirken.

import { activePreset, valuesFromIni } from '../lib/sicht-presets.mjs';

const G = '/Script/FortniteGame.FortGameUserSettings';
const S = 'ScalabilityGroups';

const ini = {
  [`${G}|DisplayGamma`]: '2.200000',
  [`${G}|UserInterfaceContrast`]: '1.000000',
  [`${G}|bShowGrass`]: 'True',
  [`${G}|bMotionBlur`]: 'True',
  [`${S}|sg.ShadowQuality`]: '2',
  [`${S}|sg.PostProcessQuality`]: '2',
  [`${S}|sg.EffectsQuality`]: '1',
  [`${S}|sg.FoliageQuality`]: '1',
  [`${S}|sg.GlobalIlluminationQuality`]: '1',
  'D3DRHIPreference|PreferredFeatureLevel': 'sm6',
  'D3DRHIPreference|PreferredRHI': 'dx12',
};

const state = { original: null, last: null };
const ALLOWED = new Set(Object.keys(ini).filter((k) => !k.startsWith('D3DRHIPreference')));

function err(code, message) { const e = new Error(message); e.code = code; throw e; }

function check(changes) {
  if (!Array.isArray(changes) || !changes.length) err('BAD_CHANGE', 'Es wurden keine gültigen Änderungen übergeben.');
  for (const c of changes) if (!ALLOWED.has(`${c.section}|${c.key}`)) err('BAD_CHANGE', `Der Wert „${c.key}“ darf nicht geändert werden.`);
  return changes;
}

const same = (a, b) => a != null && (String(a).trim() === String(b).trim() || Math.abs(Number(a) - Number(b)) < 0.0005);

export default {
  async current(_a, mctx) {
    await mctx.wait(200);
    return {
      found: true, rel: 'WindowsClient/GameUserSettings.ini', readOnly: false, raw: { ...ini },
      fortnite: mctx.db.fortnite, original: state.original, last: state.last,
    };
  },
  async preview(a, mctx) {
    await mctx.wait(250);
    const changes = check(a.changes);
    return {
      rel: 'WindowsClient/GameUserSettings.ini', readOnly: false, fortnite: mctx.db.fortnite,
      changes: changes.map((c) => { const from = ini[`${c.section}|${c.key}`] ?? null; return { ...c, from, to: c.value, changed: !same(from, c.value) }; }),
    };
  },
  async apply(a, mctx) {
    await mctx.wait(600);
    const changes = check(a.changes);
    if (mctx.db.fortnite.running) err('FORTNITE_RUNNING', 'Fortnite läuft noch. Schließe Fortnite zuerst – HELIX kann das für dich übernehmen.');
    if (!state.original) state.original = Object.fromEntries([...ALLOWED].map((k) => [k, ini[k]]));
    const applied = [];
    for (const c of changes) {
      const k = `${c.section}|${c.key}`;
      if (same(ini[k], c.value)) continue;
      applied.push({ section: c.section, key: c.key, from: ini[k], to: c.value });
      ini[k] = c.value;
    }
    const name = a.presetId === 'eigen' ? 'eigene Werte' : a.presetName;
    state.last = { id: a.presetId, name, short: a.presetShort || name, at: Date.now(), changes };
    return { rel: 'WindowsClient/GameUserSettings.ini', applied, backupId: '20261018-101500-ab12', label: `Sicht-Preset „${name}“`, preset: { id: a.presetId, name } };
  },
  // wie der Hauptprozess: Preset nach den Werten erkennen (wie die Ansicht), eigene Werte nur solange sie noch gelten
  async summary() {
    const p = activePreset(valuesFromIni(ini), { original: state.original ? valuesFromIni(state.original) : null });
    if (p) return { text: `Aktiv: ${p.short || p.name}` };
    const last = state.last;
    if (last && last.id === 'eigen' && last.changes.every((c) => same(ini[`${c.section}|${c.key}`], c.value))) {
      return { text: 'Aktiv: eigene Sicht-Werte' };
    }
    const pct = Math.round((Number(ini[`${G}|DisplayGamma`]) - 2.2) * 100 + 100);
    return { text: `Kein Sicht-Preset aktiv · Helligkeit ${pct} %` };
  },
};
