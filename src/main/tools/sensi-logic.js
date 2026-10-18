'use strict';
// Sensi-Kalibrierung (Hauptprozess): Werte prüfen, Verlauf führen, Kurzinfo fürs Cockpit.
// Reine Funktionen ohne Dateizugriff – getestet in test/tools/sensi.test.js.
// Die Rechenregeln (eDPI, cm/360) sind dieselben wie in src/renderer/js/lib/sensi-math.mjs.

const FN_YAW = 0.005555; // Grad pro Maus-Count je 1 % Fortnite-Sensi
const MAX_HISTORY = 200;
const MAX_ROUNDS = 12;
const MAX_LINES = 10;

const LIMITS = {
  dpi: [50, 32000],
  sens: [0.1, 100],
  targeting: [1, 200],
  scope: [1, 200],
};

const DEFAULT_SETTINGS = { dpi: 800, sens: 6.5, targeting: 45, scope: 45 };

const FIELD_TEXT = {
  dpi: 'DPI: bitte eine ganze Zahl zwischen 50 und 32000.',
  sens: 'Sensi: bitte einen Wert zwischen 0,1 und 100.',
  targeting: 'Zielen: bitte einen Wert zwischen 1 und 200.',
  scope: 'Zielfernrohr: bitte einen Wert zwischen 1 und 200.',
};

function round(v, d = 0) {
  const f = 10 ** d;
  return Math.round((v + Number.EPSILON * Math.sign(v)) * f) / f;
}

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** Deutsche Zahl: 6.8 -> "6,8" */
function fmtNum(v, decimals = 1) {
  if (!Number.isFinite(v)) return '–';
  return round(v, decimals).toFixed(decimals).replace('.', ',');
}

function fmtSens(v) {
  if (!Number.isFinite(v)) return '–';
  const one = Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
  return fmtNum(v, one ? 1 : 2);
}

const edpi = (dpi, sens) => (dpi * sens) / 100;
const cm360 = (dpi, sens) => 914.4 / (dpi * sens * FN_YAW);

/**
 * Prüft die Einstellungen. Gibt { ok, settings, errors } zurück.
 * DPI wird ganzzahlig, die Prozentwerte auf 3 Nachkommastellen gerundet.
 */
function validateSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const settings = {};
  const errors = {};
  for (const key of Object.keys(LIMITS)) {
    const n = toNum(src[key]);
    const [lo, hi] = LIMITS[key];
    if (!Number.isFinite(n) || n < lo || n > hi) { errors[key] = FIELD_TEXT[key]; continue; }
    settings[key] = key === 'dpi' ? Math.round(n) : round(n, 3);
  }
  return { ok: Object.keys(errors).length === 0, settings, errors };
}

/** Gespeicherte Einstellungen lesen; fehlende/kaputte Werte durch Standardwerte ersetzen. */
function normalizeSettings(raw) {
  const { settings } = validateSettings(raw);
  return { ...DEFAULT_SETTINGS, ...settings };
}

const finiteOr = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numIn = (v, lo, hi, fallback = null) => {
  const n = finiteOr(v, NaN);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function cleanRound(r) {
  if (!r || typeof r !== 'object') return null;
  const sens = numIn(r.sens, 0, 1000, NaN);
  if (!Number.isFinite(sens)) return null;
  const out = {
    mult: numIn(r.mult, 0, 10, 1),
    sens: round(sens, 3),
    score: numIn(r.score, 0, 100, 0),
    accuracy: numIn(r.accuracy, 0, 100, 0),
    hits: Math.round(numIn(r.hits, 0, 1e6, 0)),
    misses: Math.round(numIn(r.misses, 0, 1e6, 0)),
    trackingPct: numIn(r.trackingPct, 0, 100, null),
    avgTtkMs: numIn(r.avgTtkMs, 0, 600000, null),
    overshoot: numIn(r.overshoot, 0, 1, null),
  };
  const under = numIn(r.undershoot, 0, 1, null);
  if (under != null) out.undershoot = under;
  const dpi = numIn(r.dpi, LIMITS.dpi[0], LIMITS.dpi[1], null);
  if (dpi != null) out.dpi = Math.round(dpi);
  return out;
}

const MODES = new Set(['sens', 'dpi']);
const LENGTHS = new Set(['short', 'normal']);
const METHODS = new Set(['parabel', 'nachbarn', 'bester', 'dpi', 'zuwenig']);
const CONFIDENCE = new Set(['hoch', 'mittel', 'niedrig']);

/**
 * Prüft einen Verlaufseintrag aus der Oberfläche (Form: Vertrag 'tool-sensi').
 * Unbekannte Felder fallen weg, Zahlen werden begrenzt. Wirft bei unbrauchbaren Daten.
 */
function sanitizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Kein Ergebnis übergeben.' };
  const dpi = numIn(raw.dpi, LIMITS.dpi[0], LIMITS.dpi[1], NaN);
  const sens = numIn(raw.sens, LIMITS.sens[0], LIMITS.sens[1], NaN);
  const rec = numIn(raw.recommendedSens, LIMITS.sens[0], LIMITS.sens[1], NaN);
  if (!Number.isFinite(dpi) || !Number.isFinite(sens) || !Number.isFinite(rec)) {
    return { ok: false, error: 'Das Ergebnis ist unvollständig (DPI oder Sensi fehlt).' };
  }
  const rounds = (Array.isArray(raw.rounds) ? raw.rounds : []).slice(0, MAX_ROUNDS).map(cleanRound).filter(Boolean);
  if (!rounds.length) return { ok: false, error: 'Das Ergebnis enthält keine Durchgänge.' };
  const at = finiteOr(raw.at, now);
  const recDpi = Math.round(numIn(raw.recommendedDpi, LIMITS.dpi[0], LIMITS.dpi[1], dpi));
  const entry = {
    at: at > 0 && at <= now + 86400000 ? Math.round(at) : now,
    dpi: Math.round(dpi),
    sens: round(sens, 3),
    recommendedSens: round(rec, 1),
    edpi: round(edpi(recDpi, round(rec, 1)), 1),
    cm360: round(cm360(recDpi, round(rec, 1)), 1),
    score: numIn(raw.score, 0, 100, 0),
    accuracy: numIn(raw.accuracy, 0, 100, 0),
    hits: Math.round(numIn(raw.hits, 0, 1e6, 0)),
    misses: Math.round(numIn(raw.misses, 0, 1e6, 0)),
    trackingPct: numIn(raw.trackingPct, 0, 100, null),
    avgTtkMs: numIn(raw.avgTtkMs, 0, 600000, null),
    rounds,
    mode: MODES.has(raw.mode) ? raw.mode : 'sens',
    length: LENGTHS.has(raw.length) ? raw.length : 'short',
    recommendedDpi: recDpi,
    rawInput: raw.rawInput !== false,
    method: METHODS.has(raw.method) ? raw.method : null,
    confidence: CONFIDENCE.has(raw.confidence) ? raw.confidence : null,
    lines: (Array.isArray(raw.lines) ? raw.lines : []).filter((l) => typeof l === 'string' && l.trim()).slice(0, MAX_LINES).map((l) => l.slice(0, 300)),
  };
  return { ok: true, entry };
}

/** Verlauf: Neuester Eintrag hinten, höchstens 200. Gleicher Zeitpunkt ersetzt den alten Eintrag. */
function appendHistory(history, entry, max = MAX_HISTORY) {
  const list = (Array.isArray(history) ? history : []).filter((e) => e && typeof e === 'object' && e.at !== entry.at);
  list.push(entry);
  list.sort((a, b) => (a.at || 0) - (b.at || 0));
  return list.length > max ? list.slice(list.length - max) : list;
}

/** Gespeicherten Zustand in die feste Form bringen: { settings, history }. */
function normalizeState(raw) {
  const st = raw && typeof raw === 'object' ? raw : {};
  const saved = !!(st.settings && typeof st.settings === 'object' && validateSettings(st.settings).ok);
  const history = (Array.isArray(st.history) ? st.history : [])
    .filter((e) => e && typeof e === 'object' && Number.isFinite(e.at) && Number.isFinite(e.recommendedSens))
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_HISTORY);
  return { settings: normalizeSettings(st.settings), saved, history };
}

/** Kurzinfo fürs Cockpit, z. B. "Empfohlen: 6,8 % (eDPI 54)". null, wenn es nichts zu sagen gibt. */
function summaryText(state) {
  const st = normalizeState(state);
  const last = st.history[st.history.length - 1];
  if (last) {
    const dpi = Number.isFinite(last.recommendedDpi) ? last.recommendedDpi : last.dpi;
    const e = Number.isFinite(last.edpi) ? last.edpi : edpi(dpi, last.recommendedSens);
    const dpiPart = last.mode === 'dpi' && dpi !== last.dpi ? `${dpi} DPI, ` : '';
    return `Empfohlen: ${dpiPart}${fmtSens(last.recommendedSens)} % (eDPI ${fmtNum(e, 0)})`;
  }
  if (st.saved) {
    return `Deine Sensi: ${fmtSens(st.settings.sens)} % (eDPI ${fmtNum(edpi(st.settings.dpi, st.settings.sens), 0)}) – noch kein Aim-Test`;
  }
  return null;
}

module.exports = {
  FN_YAW, LIMITS, DEFAULT_SETTINGS, MAX_HISTORY,
  round, toNum, fmtNum, fmtSens, edpi, cm360,
  validateSettings, normalizeSettings, sanitizeEntry, appendHistory, normalizeState, summaryText,
};
