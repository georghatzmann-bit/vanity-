// Sicht-Presets: reine Daten und Rechenfunktionen (ohne DOM).
// Wird von der Ansicht, dem Simulator und den Unit-Tests benutzt.
//
// Geschrieben werden nur LOKALE Werte aus GameUserSettings.ini (Recherche "fortnite-config", §5/§6):
//   DisplayGamma           = Helligkeits-Regler: 1,7 = 50 %, 2,2 = 100 % (Standard), 2,7 = 150 % (linear)
//   UserInterfaceContrast  = Kontrast der Anzeigen (HUD/Menüs): 1,0 (Standard) bis 1,5
//   bShowGrass, bMotionBlur, sg.*Quality (0 Niedrig … 3 Episch)
// Farbenblind-Modus, Stärke und HUD liegen in der Epic-Cloud (ClientSettings.Sav) –
// die werden NIE geschrieben, sondern nur als Schritt „Im Spiel einstellen“ erklärt.

export const FILE = 'GameUserSettings.ini';
export const S_GUS = '/Script/FortniteGame.FortGameUserSettings';
export const S_SG = 'ScalabilityGroups';
export const S_RHI = 'D3DRHIPreference';

/** Alle Werte, die HELIX hier ändern darf. Reihenfolge = Anzeige-Reihenfolge. */
export const KEYS = {
  brightness: { section: S_GUS, key: 'DisplayGamma', type: 'gamma', label: 'Helligkeit', hint: 'Der Helligkeits-Regler in Fortnite.' },
  uiContrast: { section: S_GUS, key: 'UserInterfaceContrast', type: 'float', min: 1, max: 1.5, label: 'Anzeige-Kontrast', hint: 'Kontrast von Leben, Munition, Karte und Menüs – nicht der Spielwelt.' },
  shadows: { section: S_SG, key: 'sg.ShadowQuality', type: 'level', label: 'Schatten', hint: 'Ohne Schatten sind dunkle Ecken heller.' },
  postProcess: { section: S_SG, key: 'sg.PostProcessQuality', type: 'level', label: 'Nachbearbeitung', hint: 'Leuchten, Dunst und Lichtstrahlen über dem Bild.' },
  effects: { section: S_SG, key: 'sg.EffectsQuality', type: 'level', label: 'Effekte', hint: 'Rauch, Funken und Explosionen.' },
  foliage: { section: S_SG, key: 'sg.FoliageQuality', type: 'level', label: 'Pflanzen', hint: 'Wie dicht Büsche und Pflanzen gezeichnet werden.' },
  gi: { section: S_SG, key: 'sg.GlobalIlluminationQuality', type: 'level', label: 'Globale Beleuchtung', hint: 'Indirektes Licht (Licht, das von Wänden zurückstrahlt).' },
  grass: { section: S_GUS, key: 'bShowGrass', type: 'bool', label: 'Gras', hint: 'Grashalme auf dem Boden (nicht im Leistungsmodus).' },
  motionBlur: { section: S_GUS, key: 'bMotionBlur', type: 'bool', label: 'Bewegungsunschärfe', hint: 'Verwischt das Bild beim schnellen Drehen.' },
};

export const KEY_IDS = Object.keys(KEYS);

/** Nur zum Lesen (Darstellungsmodus erkennen), wird nie geschrieben. */
export const READ_ONLY_KEYS = [
  { section: S_RHI, key: 'PreferredFeatureLevel' },
  { section: S_RHI, key: 'PreferredRHI' },
];

export const BRIGHTNESS = { min: 50, max: 150, def: 100 };
export const UI_CONTRAST = { min: 1, max: 1.5, def: 1, step: 0.05 };

const LEVEL_TEXT = ['Niedrig', 'Mittel', 'Hoch', 'Episch', 'Kino'];

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const round = (v, d = 0) => { const f = 10 ** d; return Math.round((v + Number.EPSILON * Math.sign(v)) * f) / f; };

// ---------- Umrechnung Helligkeit <-> DisplayGamma ----------

/** DisplayGamma -> Prozent im Spiel (1,7 = 50 %, 2,2 = 100 %, 2,7 = 150 %). */
export function gammaToPercent(gamma) {
  const g = Number(gamma);
  if (!Number.isFinite(g)) return null;
  return clamp(round((g - 2.2) * 100 + 100), BRIGHTNESS.min, BRIGHTNESS.max);
}

/** Prozent -> DisplayGamma (ganze Prozent, gerundet auf 2 Nachkommastellen). */
export function percentToGamma(pct) {
  const p = clamp(Math.round(Number(pct)), BRIGHTNESS.min, BRIGHTNESS.max);
  return round(2.2 + (p - 100) / 100, 2);
}

// ---------- Schreibweise wie Fortnite (240.000000, True/False) ----------

export function formatFloat(v) {
  return Number(v).toFixed(6);
}

export function formatBool(b) {
  return b ? 'True' : 'False';
}

export function parseBool(s) {
  if (s == null) return null;
  const t = String(s).trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return null;
}

export function parseNum(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Wert (fachlich) -> Text für die INI-Datei. */
export function toIni(id, v) {
  const def = KEYS[id];
  if (!def) throw new Error(`Unbekannter Wert ${id}`);
  switch (def.type) {
    case 'gamma': return formatFloat(percentToGamma(v));
    case 'float': return formatFloat(round(clamp(Number(v), def.min, def.max), 2));
    case 'bool': return formatBool(!!v);
    case 'level': return String(clamp(Math.round(Number(v)), 0, 3));
    default: throw new Error(`Unbekannter Typ ${def.type}`);
  }
}

/** Text aus der INI-Datei -> Wert (fachlich), null wenn fehlt/unlesbar. */
export function fromIni(id, raw) {
  const def = KEYS[id];
  if (!def || raw == null) return null;
  switch (def.type) {
    case 'gamma': { const n = parseNum(raw); return n == null ? null : gammaToPercent(n); }
    case 'float': { const n = parseNum(raw); return n == null ? null : round(n, 2); }
    case 'bool': return parseBool(raw);
    case 'level': { const n = parseNum(raw); return n == null ? null : Math.round(n); }
    default: return null;
  }
}

/** Antwort von readIniValues ({ 'Abschnitt|Schlüssel': text }) -> { brightness: 100, shadows: 0, … } */
export function valuesFromIni(raw = {}) {
  const out = {};
  for (const id of KEY_IDS) {
    const d = KEYS[id];
    out[id] = fromIni(id, raw[`${d.section}|${d.key}`] ?? null);
  }
  return out;
}

/** Leistungsmodus (es31) erkennen: Dann sind Schatten & Co. ohnehin aus. */
export function renderMode(raw = {}) {
  const fl = String(raw[`${S_RHI}|PreferredFeatureLevel`] ?? '').trim().toLowerCase();
  const rhi = String(raw[`${S_RHI}|PreferredRHI`] ?? '').trim().toLowerCase();
  if (fl === 'es31') return { id: 'performance', label: 'Leistungsmodus' };
  if (fl === 'sm6' || rhi === 'dx12') return { id: 'dx12', label: 'DirectX 12' };
  if (fl === 'sm5' || rhi === 'dx11') return { id: 'dx11', label: 'DirectX 11' };
  return { id: 'unknown', label: 'unbekannt' };
}

/** Lesbarer Text für einen Wert, z. B. „130 %“, „Aus“, „Niedrig“. */
export function valueText(id, v) {
  if (v == null) return 'nicht gesetzt';
  const def = KEYS[id];
  switch (def?.type) {
    case 'gamma': return `${v} %`;
    case 'float': return v.toFixed(2).replace('.', ',');
    case 'bool': return v ? 'an' : 'aus';
    case 'level': return id === 'shadows' && v === 0 ? 'Aus' : (LEVEL_TEXT[v] || String(v));
    default: return String(v);
  }
}

/** Text aus der Datei direkt lesbar machen (für die Vorschau-Tabelle). */
export function rawText(section, key, raw) {
  const id = idOf(section, key);
  if (!id) return raw == null ? 'nicht gesetzt' : String(raw);
  return valueText(id, fromIni(id, raw));
}

export function idOf(section, key) {
  const s = String(section).toLowerCase();
  const k = String(key).toLowerCase();
  return KEY_IDS.find((id) => KEYS[id].section.toLowerCase() === s && KEYS[id].key.toLowerCase() === k) || null;
}

// ---------- Die Presets ----------

const COLORBLIND_PATH = 'Fortnite: Einstellungen → Barrierefreiheit (bei älteren Versionen: Video) → Farbenblind-Modus.';

// Die Werte (values, restoreOriginal, short) stehen auch in src/main/tools/sicht-rules.js für die
// Cockpit-Zeile – ein Test stellt sicher, dass beide gleich bleiben.
export const PRESETS = [
  {
    id: 'sturm',
    name: 'Sturm',
    short: 'Sturm',
    wofuer: 'Im lila Sturm siehst du Gegner und Bauteile besser.',
    values: { brightness: 115, uiContrast: 1.2, shadows: 0, postProcess: 0, effects: 0, motionBlur: false },
    why: 'Heller, ohne Dunst und Leuchten – und Leben und Munition bleiben auf Lila gut lesbar.',
    inGame: [
      {
        title: 'Farbenblind-Modus: Tritanopie, Stärke 5 bis 7',
        text: COLORBLIND_PATH,
        why: 'Der Modus verschiebt Blau- und Lilatöne. Der Sturm wirkt dadurch weniger lila, Gegner heben sich besser ab. Nachteil: Die Farben der Seltenheit (Blau/Lila) sehen sich ähnlicher.',
      },
    ],
  },
  {
    id: 'nacht',
    name: 'Nacht / Dunkle Gebiete',
    short: 'Nacht',
    wofuer: 'Nacht, Höhlen und Häuser: dunkle Ecken werden sichtbar.',
    values: { brightness: 130, uiContrast: 1.1, shadows: 0, postProcess: 0, motionBlur: false },
    why: 'Mehr Helligkeit und keine Schatten: Gegner verstecken sich nicht mehr in schwarzen Ecken.',
    inGame: [
      {
        title: 'Farbenblind-Modus so lassen',
        text: 'Im Dunkeln hilft vor allem Helligkeit. Der Farbenblind-Modus macht dunkle Stellen nicht heller.',
        why: 'Bleiben dunkle Stellen trotzdem schwarz, liegt es meist am Monitor. Prüfe das im Monitor-Tuner mit dem Schwarzwert-Bild.',
      },
    ],
  },
  {
    id: 'hell',
    name: 'Helle Karte',
    short: 'Helle Karte',
    wofuer: 'Tag, Schnee und Wüste: weniger Blenden, klarere Umrisse.',
    values: { brightness: 90, uiContrast: 1.3, postProcess: 0, effects: 0, motionBlur: false },
    why: 'Etwas dunkler und ohne Leuchten: helle Flächen bleichen nicht aus, Texte bleiben lesbar.',
    inGame: [
      {
        title: 'Farbenblind-Modus aus oder schwach (Stärke 1 bis 3)',
        text: COLORBLIND_PATH,
        why: 'Auf heller Karte brauchst du keine Farbverschiebung. Ein starker Modus macht helle Flächen eher unruhig.',
      },
    ],
  },
  {
    id: 'turnier',
    name: 'Turnier-Klarheit',
    short: 'Turnier-Klarheit',
    wofuer: 'Turnier und Arena: ruhiges, klares Bild ohne Ablenkung.',
    values: { brightness: 110, uiContrast: 1, shadows: 0, postProcess: 0, effects: 0, foliage: 0, grass: false, motionBlur: false },
    why: 'Schatten, Dunst, Effekte, Gras und Unschärfe sind aus. Etwas heller, damit dunkle Stellen sichtbar bleiben.',
    inGame: [
      {
        title: 'HUD-Größe nicht über 100 %',
        text: 'Fortnite: Einstellungen → Spiel → HUD (Anzeigegröße).',
        why: 'Eine kleinere Anzeige lässt mehr vom Bild frei. Die HUD-Größe speichert Fortnite in der Epic-Cloud – HELIX kann sie nicht setzen.',
      },
      {
        title: 'Optional: Farbenblind-Modus Tritanopie, Stärke 5 bis 7',
        text: COLORBLIND_PATH,
        why: 'Viele nutzen das für den Sturm im Endgame. Probiere es in einem Übungsspiel aus.',
      },
    ],
  },
  {
    id: 'standard',
    name: 'Standard zurück',
    short: 'Standard',
    wofuer: 'Helligkeit und Anzeige-Kontrast zurück auf Fortnite-Standard.',
    values: { brightness: 100, uiContrast: 1 },
    restoreOriginal: true,
    why: 'Helligkeit 100 % und Kontrast 1,00 – so startet Fortnite.',
    inGame: [
      {
        title: 'Farbenblind-Modus wieder auf „Aus“',
        text: COLORBLIND_PATH,
        why: 'Falls du ihn für den Sturm geändert hast. Er liegt in der Epic-Cloud, deshalb musst du ihn im Spiel zurückstellen.',
      },
    ],
  },
];

export function findPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/**
 * Welche Werte ein Preset setzt (fachlich). Bei „Standard zurück“ kommen die gemerkten
 * Originalwerte (vor dem ersten Sicht-Preset) für alle übrigen Schlüssel dazu.
 * original: { brightness: 120, shadows: 2, … } (null-Werte werden übersprungen)
 */
export function presetValues(preset, { original } = {}) {
  const vals = { ...preset.values };
  if (preset.restoreOriginal && original) {
    for (const id of KEY_IDS) {
      if (id in preset.values) continue;
      const v = original[id];
      if (v != null) vals[id] = v;
    }
  }
  return vals;
}

/** Fachliche Werte -> Änderungen für previewIniChanges/applyIniChanges. */
export function toChanges(values) {
  const out = [];
  for (const id of KEY_IDS) {
    if (!(id in values) || values[id] == null) continue;
    const d = KEYS[id];
    out.push({ section: d.section, key: d.key, value: toIni(id, values[id]) });
  }
  return out;
}

export function presetChanges(preset, opts) {
  return toChanges(presetValues(preset, opts));
}

/** „Eigener Wert“: nur Helligkeit und Anzeige-Kontrast. */
export function customValues({ brightness, uiContrast }) {
  return {
    brightness: clamp(Math.round(Number(brightness)), BRIGHTNESS.min, BRIGHTNESS.max),
    uiContrast: round(clamp(Number(uiContrast), UI_CONTRAST.min, UI_CONTRAST.max), 2),
  };
}

function same(id, a, b) {
  if (a == null || b == null) return false;
  const t = KEYS[id].type;
  if (t === 'float') return Math.abs(a - b) < 0.006;
  if (t === 'gamma') return Math.abs(a - b) < 0.6;
  return a === b;
}

/** Stimmen die aktuellen Werte mit dem Preset überein? */
export function matchesValues(current, values) {
  const ids = Object.keys(values).filter((id) => values[id] != null);
  return ids.length > 0 && ids.every((id) => same(id, current?.[id], values[id]));
}

/**
 * Welches Preset ist gerade aktiv? Bei mehreren Treffern gewinnt das genaueste
 * (mit den meisten übereinstimmenden Werten). „Standard zurück“ zählt nur, wenn die Originalwerte
 * von vor dem ersten Sicht-Preset bekannt sind.
 */
export function activePreset(current, { original } = {}) {
  let best = null;
  let bestN = 0;
  for (const p of PRESETS) {
    // „Standard zurück“ ohne gemerkte Originalwerte prüft nur Helligkeit/Kontrast – das wäre kein echtes Preset.
    if (p.restoreOriginal && !original) continue;
    const vals = presetValues(p, { original });
    if (!matchesValues(current, vals)) continue;
    const n = Object.keys(vals).length;
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

/** Kurze Liste, was ein Preset macht: [„Helligkeit 115 %“, „Schatten Aus“, …] */
export function describeValues(values) {
  return KEY_IDS.filter((id) => id in values && values[id] != null).map((id) => `${KEYS[id].label}: ${valueText(id, values[id])}`);
}

/** Zeile fürs Cockpit. */
export function summaryText(current, opts) {
  if (!current || current.brightness == null) return null;
  const p = activePreset(current, opts);
  if (p) return `Aktiv: ${p.short || p.name}`;
  return `Kein Sicht-Preset aktiv · Helligkeit ${current.brightness} %`;
}
