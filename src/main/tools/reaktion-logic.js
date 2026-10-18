'use strict';
// Reaktions-Labor: reine Logik für den Hauptprozess (Prüfen und Speichern der Ergebnisse, Tastenbelegung).
// Die gleichen Aktionen und Standard-Tasten stehen in src/renderer/js/lib/reaktion-logic.mjs
// (ein Test stellt sicher, dass beide gleich bleiben).

const MAX_HISTORY = 200;

// Fortnite-Standard am PC: Wand F1, Boden F2, Treppe F3, Dach F4, Bearbeiten G,
// Spitzhacke 1, Waffen-Slots 1–5 auf den Tasten 2–6. Waffen sind im Training erst einmal aus.
const ACTIONS = [
  { id: 'wall', label: 'Wand', code: 'F1', key: 'F1', on: true },
  { id: 'floor', label: 'Boden', code: 'F2', key: 'F2', on: true },
  { id: 'stairs', label: 'Treppe', code: 'F3', key: 'F3', on: true },
  { id: 'roof', label: 'Dach', code: 'F4', key: 'F4', on: true },
  { id: 'edit', label: 'Bearbeiten', code: 'KeyG', key: 'G', on: true },
  { id: 'weapon1', label: 'Waffe 1', code: 'Digit2', key: '2', on: false },
  { id: 'weapon2', label: 'Waffe 2', code: 'Digit3', key: '3', on: false },
  { id: 'weapon3', label: 'Waffe 3', code: 'Digit4', key: '4', on: false },
  { id: 'weapon4', label: 'Waffe 4', code: 'Digit5', key: '5', on: false },
  { id: 'weapon5', label: 'Waffe 5', code: 'Digit6', key: '6', on: false },
];
const ACTION_IDS = ACTIONS.map((a) => a.id);

// Tasten, die nie belegt werden dürfen (Esc bricht ab, Windows-Taste öffnet das Startmenü)
const RESERVED = /^(Escape|MetaLeft|MetaRight|OSLeft|OSRight|ContextMenu|Unidentified)$/;
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
// Längster HELIX-Name ist „Mittlere Maustaste“ (18 Zeichen), ein Tasten-Code hat höchstens 24 Zeichen
const LABEL_MAX = 24;

function defaultBinds() {
  const out = {};
  for (const a of ACTIONS) out[a.id] = { code: a.code, label: a.key, on: a.on };
  return out;
}

function cleanLabel(v, fallback) {
  const t = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  // „<“ bzw. „>“ allein ist eine echte Taste (deutsche Tastatur, neben der linken Umschalttaste).
  // In längeren Namen werden spitze Klammern entfernt (kein HTML).
  const s = (/^[<>]$/.test(t) ? t : t.replace(/[<>]/g, '').trim()).slice(0, LABEL_MAX);
  return s || fallback;
}

function validCode(c) {
  return typeof c === 'string' && CODE_RE.test(c) && !RESERVED.test(c);
}

/** Übernimmt nur bekannte Aktionen und gültige Tasten. Fehlendes wird mit dem Standard aufgefüllt. */
function sanitizeBinds(input) {
  const def = defaultBinds();
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const id of ACTION_IDS) {
    const b = src[id];
    if (b && typeof b === 'object' && validCode(b.code)) {
      out[id] = { code: b.code, label: cleanLabel(b.label, b.code), on: typeof b.on === 'boolean' ? b.on : def[id].on };
    } else {
      out[id] = { ...def[id], on: b && typeof b.on === 'boolean' ? b.on : def[id].on };
    }
  }
  return out;
}

const isNum = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
const isInt = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;

/** Reaktionstest: {avgMs, bestMs, rounds, falseStarts} -> sauberes Objekt oder null. */
function sanitizeReaction(d) {
  if (!d || typeof d !== 'object') return null;
  const { avgMs, bestMs, rounds, falseStarts } = d;
  if (!isNum(avgMs, 80, 3000) || !isNum(bestMs, 80, 3000) || bestMs > avgMs + 0.5) return null;
  if (!isInt(rounds, 1, 20) || !isInt(falseStarts, 0, 100)) return null;
  return { avgMs: Math.round(avgMs), bestMs: Math.round(bestMs), rounds, falseStarts };
}

/** Tasten-Trainer: {avgMs, accuracy, count} -> sauberes Objekt oder null. avgMs darf null sein (nichts getroffen). */
function sanitizeKeys(d) {
  if (!d || typeof d !== 'object') return null;
  const { avgMs, accuracy, count } = d;
  if (!(avgMs === null || isNum(avgMs, 50, 5000))) return null;
  if (!isNum(accuracy, 0, 100) || !isInt(count, 1, 100)) return null;
  if (avgMs === null && accuracy > 0) return null;
  return { avgMs: avgMs === null ? null : Math.round(avgMs), accuracy: Math.round(accuracy * 10) / 10, count };
}

function pushCapped(list, item, max = MAX_HISTORY) {
  const out = Array.isArray(list) ? list.slice() : [];
  out.push(item);
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Bringt den gespeicherten Zustand in die vereinbarte Form { reaction:[], keys:[], binds:{} }. */
function normalizeState(s) {
  const src = s && typeof s === 'object' ? s : {};
  const reaction = (Array.isArray(src.reaction) ? src.reaction : [])
    .filter((e) => e && Number.isFinite(e.at) && sanitizeReaction(e))
    .map((e) => ({ at: e.at, ...sanitizeReaction(e) }))
    .slice(-MAX_HISTORY);
  const keys = (Array.isArray(src.keys) ? src.keys : [])
    .filter((e) => e && Number.isFinite(e.at) && sanitizeKeys(e))
    .map((e) => ({ at: e.at, ...sanitizeKeys(e) }))
    .slice(-MAX_HISTORY);
  return { reaction, keys, binds: sanitizeBinds(src.binds) };
}

const fmtPct = (v) => `${String(Math.round(v * 10) / 10).replace('.', ',')} %`;

/** Kurzer Text fürs Cockpit, z. B. "Reaktion Ø 182 ms". */
function summaryText(state) {
  const s = normalizeState(state);
  const r = s.reaction[s.reaction.length - 1];
  const k = s.keys[s.keys.length - 1];
  if (r && k && k.avgMs !== null) return `Reaktion Ø ${r.avgMs} ms · Tasten Ø ${k.avgMs} ms`;
  if (r) return `Reaktion Ø ${r.avgMs} ms · Bestwert ${r.bestMs} ms`;
  if (k) return k.avgMs !== null ? `Tasten-Trainer Ø ${k.avgMs} ms, ${fmtPct(k.accuracy)} richtig` : `Tasten-Trainer: ${fmtPct(k.accuracy)} richtig`;
  return null;
}

/** Ein paar Kennzahlen für die Ansicht. */
function stats(state) {
  const s = normalizeState(state);
  const r = s.reaction;
  const k = s.keys.filter((e) => e.avgMs !== null);
  const avg = (l, f) => (l.length ? Math.round(l.reduce((n, e) => n + f(e), 0) / l.length) : null);
  return {
    reaction: {
      count: r.length,
      bestMs: r.length ? Math.min(...r.map((e) => e.bestMs)) : null,
      bestAvgMs: r.length ? Math.min(...r.map((e) => e.avgMs)) : null,
      last5AvgMs: avg(r.slice(-5), (e) => e.avgMs),
    },
    keys: {
      count: s.keys.length,
      bestAvgMs: k.length ? Math.min(...k.map((e) => e.avgMs)) : null,
      last5AvgMs: avg(k.slice(-5), (e) => e.avgMs),
      last5Accuracy: s.keys.length ? Math.round(s.keys.slice(-5).reduce((n, e) => n + e.accuracy, 0) / Math.min(5, s.keys.length)) : null,
    },
  };
}

module.exports = {
  MAX_HISTORY, ACTIONS, ACTION_IDS, RESERVED, LABEL_MAX, defaultBinds, validCode, sanitizeBinds,
  sanitizeReaction, sanitizeKeys, pushCapped, normalizeState, summaryText, stats,
};
