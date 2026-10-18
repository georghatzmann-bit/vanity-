'use strict';
// PC-Check – reine Logik ohne Windows-Aufrufe (komplett testbar):
// Hardware-Daten zerlegen, einordnen und drei Video-Vorschläge für GameUserSettings.ini bauen.
// Geschrieben wird hier nichts – das macht das Modul über ctx.core.applyIniChanges (mit Backup).

const FGUS = '/Script/FortniteGame.FortGameUserSettings';
const SG = 'ScalabilityGroups';
const RHI = 'D3DRHIPreference';
const PERF = 'PerformanceMode';

const PRESET_IDS = ['leistung', 'ausgewogen', 'qualitaet'];
const QUALITY = ['Niedrig', 'Mittel', 'Hoch', 'Episch', 'Kino'];
// Manche Einstellungen nennt Fortnite im Menü anders – HELIX zeigt dieselben Namen wie das Spiel
const QUALITY_NAMES = {
  shadows: ['Aus', 'Mittel', 'Hoch', 'Episch', 'Kino'],
  gi: ['Aus', 'Mittel', 'Hoch', 'Episch', 'Kino'],
  reflections: ['Aus', 'Mittel', 'Hoch', 'Episch', 'Kino'],
  viewDistance: ['Nah', 'Mittel', 'Weit', 'Episch', 'Kino'],
};
const WINDOW_MODE = { 0: 'Vollbild', 1: 'Fenster-Vollbild', 2: 'Fenster' };
const REFLEX = { 0: 'Aus', 1: 'An', 2: 'An + Boost' };
const AA_TEXT = {
  disabled: 'Aus', fxaa: 'FXAA', taa: 'TAA', smaa: 'SMAA', tsrlow: 'TSR niedrig', tsrmedium: 'TSR mittel',
  tsrhigh: 'TSR hoch', tsrepic: 'TSR episch', dlss: 'NVIDIA DLSS', xess: 'Intel XeSS',
};
// Grenzwerte, die Fortnite selbst im Menü anbietet (plus Monitor-Hz)
const FPS_STEPS = [30, 60, 120, 144, 160, 165, 180, 200, 240, 360];
const COMMON_HZ = [24, 30, 48, 50, 60, 72, 75, 85, 90, 100, 110, 120, 144, 160, 165, 170, 175, 180, 200, 240, 260, 280, 300, 320, 360, 390, 480, 500, 540, 600];

// ---------------------------------------------------------------- kleine Helfer

/**
 * ConvertTo-Json liefert bei einem Treffer ein Objekt, bei mehreren ein Array.
 * Windows PowerShell 5.1 verpackt Arrays manchmal als { value: [...], Count: n } – auch das wird ausgepackt.
 */
function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && Array.isArray(v.value) && ('Count' in v || 'count' in v)) return v.value;
  return [v];
}

/** "PCI\VEN_10DE&DEV_2786&SUBSYS_..." -> "10de:2786" (nur Hersteller- und Modellnummer, keine Geräte-Instanz). */
function pciId(s) {
  const t = str(s);
  if (/^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(t)) return t.toLowerCase();
  const m = /ven_([0-9a-f]{4})&dev_([0-9a-f]{4})/i.exec(t);
  return m ? `${m[1]}:${m[2]}`.toLowerCase() : '';
}
const str = (v) => (v == null ? '' : String(v)).trim();
function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function int(v) {
  const n = num(v);
  return n == null ? null : Math.round(n);
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const GB = 1024 ** 3;

/** Fortnite schreibt Kommazahlen mit sechs Nachkommastellen (240.000000). */
const fmtFloat = (v) => Number(v).toFixed(6);
const fmtBool = (v) => (v ? 'True' : 'False');
const fmtInt = (v) => String(Math.round(Number(v)));

/** Gleicher Wert, auch wenn er anders geschrieben ist (100 = 100.000000, true = True). */
function sameValue(a, b) {
  if (a == null || b == null) return false;
  const sa = str(a);
  const sb = str(b);
  if (sa.toLowerCase() === sb.toLowerCase()) return true;
  if (sa === '' || sb === '') return false;
  const na = Number(sa);
  const nb = Number(sb);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 1e-6;
}

function round5(n) {
  if (!Number.isFinite(n)) return null;
  return n < 100 ? Math.round(n / 5) * 5 : Math.round(n / 10) * 10;
}

const deNum = (n, d = 1) => Number(n).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: 0 });

/** Rundet krumme Bildwiederholraten (59,94 / 143) auf die üblichen Werte (60 / 144). */
function normalizeHz(v) {
  const n = num(v);
  if (n == null || n < 20 || n > 1000) return null;
  for (const r of COMMON_HZ) if (Math.abs(n - r) <= 1.5) return r;
  return Math.round(n);
}

// ---------------------------------------------------------------- Grafikkarte

const VIRTUAL_GPU = /(basic display|basic render|remote display|remotefx|virtual|parsec|citrix|vmware|virtualbox|hyper-v|indirect display|\bidd\b|spacedesk|displaylink|splashtop|teamviewer|dameware|mirage|radmin|qxl|red hat)/i;

// Grobe relative Spieleleistung (RTX 4090 = 100). Reicht für eine Einordnung in Stufen.
const NV = {
  5090: 115, 5080: 85, '5070ti': 75, 5070: 62, '5060ti': 48, 5060: 42, 5050: 32,
  4090: 100, '4080super': 80, 4080: 78, '4070tisuper': 68, '4070ti': 63, '4070super': 57, 4070: 50, '4060ti': 38, 4060: 32, 4050: 24,
  '3090ti': 62, 3090: 57, '3080ti': 56, 3080: 52, '3070ti': 44, 3070: 41, '3060ti': 36, 3060: 28, '3050ti': 17, 3050: 19,
  '2080ti': 40, '2080super': 35, 2080: 33, '2070super': 31, 2070: 27, '2060super': 25, 2060: 22,
  '1660ti': 18, '1660super': 18, 1660: 16, '1650super': 14, 1650: 11, 1630: 6,
  '1080ti': 28, 1080: 22, '1070ti': 20, 1070: 18, 1060: 13, '1050ti': 8, 1050: 6, 1030: 3,
  '980ti': 17, 980: 13, 970: 11, 960: 7, 950: 6, '750ti': 4, 750: 3, '780ti': 9, 780: 8, 770: 6, 760: 5, 680: 5, 670: 4, 660: 3, 650: 2,
};
const AMD = {
  '9070xt': 72, '9070gre': 55, 9070: 64, '9060xt': 45, 9060: 38,
  '7900xtx': 82, '7900xt': 72, '7900gre': 60, '7800xt': 56, '7700xt': 46, 7700: 40, '7650gre': 33, '7600xt': 31, 7600: 29,
  '6950xt': 60, '6900xt': 57, '6800xt': 53, 6800: 46, '6750xt': 38, '6750gre': 34, '6700xt': 36, 6700: 32, '6650xt': 30, '6600xt': 28, 6600: 25, '6500xt': 11, 6500: 10, 6400: 9,
  '5700xt': 27, 5700: 24, '5600xt': 21, 5600: 19, '5500xt': 14, 5500: 13, 5300: 10,
  590: 12, 580: 11, 570: 9, 560: 5, 550: 3, 480: 10, 470: 8, 460: 4,
};
const ARC = { a770: 30, a750: 27, a580: 24, a380: 9, a310: 6, b580: 34, b570: 29, a770m: 20, a730m: 17, a570m: 14, a550m: 12, a370m: 7, a350m: 5 };
const AMD_IGPU = { '8060s': 30, '8050s': 24, '8040s': 20, '890m': 13, '880m': 11, '860m': 7, '840m': 5, '780m': 10, '760m': 8, '740m': 5, '680m': 8, '660m': 5, '610m': 2 };

function normGpuName(name) {
  return str(name).toLowerCase().replace(/\((r|tm|c)\)|[®™©]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Kurzer Name für Karten und Cockpit: "NVIDIA GeForce RTX 4070" -> "RTX 4070". */
function shortGpuName(name) {
  let s = str(name).replace(/\((R|TM|C)\)|[®™©]/gi, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').replace(/^AMD\s+/i, '').replace(/^Intel\s+/i, '');
  s = s.replace(/^Radeon\s+(RX\s)/i, '$1');
  s = s.replace(/^(Arc\s+[AB]\d{3}M?)\s+Graphics$/i, '$1');
  return s || str(name);
}

function vramFallbackScore(vramGB) {
  if (vramGB == null) return 12; // ganz unbekannt: vorsichtig "Mittelklasse"
  if (vramGB >= 16) return 50;
  if (vramGB >= 12) return 40;
  if (vramGB >= 8) return 26;
  if (vramGB >= 6) return 17;
  if (vramGB >= 4) return 9;
  if (vramGB >= 2) return 4;
  return 2;
}

/**
 * Ordnet eine Grafikkarte über ihren Namen ein.
 * Rückgabe: { vendor, score, known, integrated, mobile, reflex, rtx, family }
 */
function classifyGpu(name, vramBytes = null) {
  const n = normGpuName(name);
  const vramGB = vramBytes ? vramBytes / GB : null;
  const vendor = /nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(n) ? 'nvidia'
    : /\bamd\b|radeon|\bati\b/.test(n) ? 'amd'
      : /intel|\barc\b|iris|uhd graphics|hd graphics/.test(n) ? 'intel' : 'other';
  const out = { vendor, score: null, known: false, integrated: false, mobile: false, reflex: false, rtx: false, family: null };
  const mobileWord = /laptop|max-q|mobile|notebook/.test(n);

  if (vendor === 'nvidia') {
    const m = /\b(rtx|gtx|gt)\s?(\d{3,4})(m)?(?:\s?(ti\s?super|ti|super))?\b/.exec(n);
    if (m) {
      const key = m[2] + (m[4] ? m[4].replace(/\s/g, '') : '');
      const base = NV[key] ?? NV[m[2]];
      if (base != null) {
        const mobile = mobileWord || !!m[3];
        Object.assign(out, {
          score: base * (mobile ? 0.72 : 1), known: true, mobile, family: m[1],
          rtx: m[1] === 'rtx',
          // Reflex: alle RTX und GTX ab der 900er-Serie
          reflex: m[1] === 'rtx' || (m[1] === 'gtx' && Number(m[2].slice(0, -2)) >= 9),
        });
      }
    }
    if (!out.known) {
      const mx = /\bmx\s?(\d{3})\b/.exec(n);
      if (mx) Object.assign(out, { score: Number(mx[1]) >= 500 ? 5 : Number(mx[1]) >= 400 ? 4 : 3, known: true, mobile: true, family: 'mx' });
      else if (/titan/.test(n)) Object.assign(out, { score: /rtx/.test(n) ? 40 : /\bv\b/.test(n) ? 38 : /xp/.test(n) ? 28 : 20, known: true, family: 'titan', reflex: true });
    }
  } else if (vendor === 'amd') {
    const m = /\brx\s?(\d{3,4})\s?(m|s)?(?:\s?(xtx|xt|gre))?\b/.exec(n);
    const ig = /radeon\s?(\d{3,4}[ms])\b/.exec(n);
    if (m && (AMD[m[1] + (m[3] || '')] ?? AMD[m[1]]) != null) {
      const mobile = mobileWord || !!m[2];
      Object.assign(out, { score: (AMD[m[1] + (m[3] || '')] ?? AMD[m[1]]) * (mobile ? 0.75 : 1), known: true, mobile, family: 'rx' });
    } else if (ig && AMD_IGPU[ig[1]] != null) {
      Object.assign(out, { score: AMD_IGPU[ig[1]], known: true, integrated: true, mobile: true, family: 'apu' });
    } else if (/vega\s?(56|64)\b/.test(n)) {
      Object.assign(out, { score: /64/.test(n) ? 20 : 18, known: true, family: 'vega' });
    } else if (/radeon vii\b/.test(n)) {
      Object.assign(out, { score: 30, known: true, family: 'vega' });
    } else if (/vega\s?(\d{1,2})\b/.test(n) || /radeon( \w+)? graphics$|radeon graphics/.test(n)) {
      const v = Number((/vega\s?(\d{1,2})\b/.exec(n) || [])[1] || 7);
      Object.assign(out, { score: v >= 10 ? 4 : v >= 6 ? 3 : 2, known: true, integrated: true, family: 'apu' });
    } else if (/\br9\b/.test(n)) {
      Object.assign(out, { score: 8, known: true, family: 'r9' });
    } else if (/\br7\b|\br5\b/.test(n)) {
      Object.assign(out, { score: 3, known: true, family: 'r7' });
    }
  } else if (vendor === 'intel') {
    const arc = /\barc\s?(?:graphics\s?)?([ab]\d{3}m?)\b/.exec(n);
    const arcV = /\barc\s?(\d{3})v\b/.exec(n);
    if (arc && ARC[arc[1]] != null) {
      Object.assign(out, { score: ARC[arc[1]], known: true, mobile: arc[1].endsWith('m'), family: 'arc' });
    } else if (arcV) {
      Object.assign(out, { score: Number(arcV[1]) >= 140 ? 9 : 7, known: true, integrated: true, mobile: true, family: 'arc-igpu' });
    } else if (/\barc\b/.test(n)) {
      Object.assign(out, { score: 7, known: true, integrated: true, family: 'arc-igpu' });
    } else if (/iris\s?xe/.test(n)) {
      Object.assign(out, { score: 4, known: true, integrated: !/max/.test(n), family: 'iris-xe' });
    } else if (/iris/.test(n)) {
      Object.assign(out, { score: 2, known: true, integrated: true, family: 'iris' });
    } else if (/uhd/.test(n)) {
      Object.assign(out, { score: /uhd( graphics)? 7\d\d/.test(n) ? 3 : 2, known: true, integrated: true, family: 'uhd' });
    } else if (/hd graphics/.test(n)) {
      Object.assign(out, { score: 1, known: true, integrated: true, family: 'hd' });
    }
  }
  if (!out.known) out.score = vramFallbackScore(vramGB);
  out.score = Math.round(out.score * 10) / 10;
  return out;
}

function gpuTier(score) {
  if (score >= 45) return 4;
  if (score >= 20) return 3;
  if (score >= 8) return 2;
  return 1;
}

// ---------------------------------------------------------------- Prozessor

function shortCpuName(name) {
  let s = str(name).replace(/\((R|TM|C)\)|[®™©]/gi, '').replace(/\s+/g, ' ');
  s = s.replace(/^\d+(st|nd|rd|th) Gen\s+/i, '');
  s = s.replace(/\s*@\s*[\d.,]+\s*GHz/i, '').replace(/\s+CPU\b/i, '');
  s = s.replace(/\s+\d+-Core Processor/i, '').replace(/\s+(w\/|with)\s+Radeon.*$/i, '').replace(/\s+Processor$/i, '');
  return s.replace(/\s+/g, ' ').trim() || str(name);
}

function threadFactor(t) {
  if (!t) return 0.5;
  if (t >= 16) return 1;
  if (t >= 12) return 0.9;
  if (t >= 8) return 0.75;
  if (t >= 6) return 0.6;
  if (t >= 4) return 0.4;
  return 0.2;
}

const INTEL_GEN = (g) => (g <= 3 ? 0.18 : g === 4 ? 0.3 : g === 5 ? 0.32 : g <= 7 ? 0.42 : g <= 9 ? 0.52 : g === 10 ? 0.6 : g === 11 ? 0.66 : g === 12 ? 0.78 : 0.85);

/**
 * Ordnet einen Prozessor ein. Rückgabe: { score (0-100), known, family, gen }
 * MaxClockSpeed von Windows ist der Grundtakt (nicht der Turbo).
 */
function classifyCpu({ name, threads, clockMHz } = {}) {
  const n = normGpuName(name);
  let m = null;
  let family = null;
  let gen = null;
  let r;
  if ((r = /\bcore\s?ultra\s?([579])\s?(\d{3})([a-z]{0,2})\b/.exec(n))) {
    family = `core-ultra-${r[1]}`;
    gen = r[2][0] === '1' ? 'ultra1' : 'ultra2';
    m = (gen === 'ultra1' ? 0.72 : 0.86) + ({ 5: 0, 7: 0.04, 9: 0.06 }[r[1]]) - (/^[uv]/.test(r[3]) ? 0.1 : /^h/.test(r[3]) ? 0.03 : 0);
  } else if ((r = /\bcore\s?i([3579])[-\s]?(\d{3,5})([a-z]{0,3}\d?)\b/.exec(n))) {
    const model = r[2];
    gen = model.length === 3 ? 1 : (model.length === 5 || model[0] === '1') ? Number(model.slice(0, 2)) : Number(model[0]);
    family = `core-i${r[1]}`;
    const suffix = r[3] || '';
    m = INTEL_GEN(gen) + ({ 3: -0.1, 5: 0, 7: 0.05, 9: 0.08 }[r[1]]) - (/^(u|y|g\d)/.test(suffix) ? 0.1 : /^h/.test(suffix) ? 0.03 : 0);
  } else if ((r = /\bcore\s?([357])\s?(\d{3})([a-z]{0,2})\b/.exec(n))) {
    family = `core-${r[1]}`;
    gen = 13;
    m = 0.8 + ({ 3: -0.1, 5: 0, 7: 0.04 }[r[1]]) - (/u/.test(r[3]) ? 0.1 : 0);
  } else if (/pentium|celeron|atom|core\s?2|core\s?m\d?\b/.test(n)) {
    family = 'intel-low';
    m = 0.15;
  } else if ((r = /\bryzen\s?ai\s?(?:max\+?\s?)?([579])\s?(?:(?:hx|pro)\s?)*(\d{3})\b/.exec(n))) {
    family = `ryzen-ai-${r[1]}`;
    gen = 'ai';
    m = 0.82 + ({ 5: 0, 7: 0.03, 9: 0.05 }[r[1]]);
  } else if ((r = /\bryzen\s?([3579])\s?(?:pro\s?)?(\d{4})([a-z0-9]{0,4})\b/.exec(n))) {
    const model = r[2];
    const suffix = r[3] || '';
    gen = Number(model[0]);
    family = `ryzen-${r[1]}`;
    let base = { 1: 0.35, 2: 0.42, 3: 0.55, 4: 0.55, 5: 0.7, 6: 0.7, 7: 0.82, 8: 0.82, 9: 0.9 }[gen] ?? 0.5;
    if (gen === 7 && /^(u|h|hs|hx)/.test(suffix)) base = model[2] === '2' ? 0.45 : model[2] === '3' ? 0.6 : 0.8;
    m = base + ({ 3: -0.1, 5: 0, 7: 0.04, 9: 0.06 }[r[1]]) + (/x3d/.test(suffix) ? 0.12 : 0) - (/^u/.test(suffix) ? 0.1 : 0);
  } else if (/athlon|phenom|sempron|\bfx-|\ba\d{1,2}-\d{4}/.test(n)) {
    family = 'amd-low';
    m = 0.2;
  } else if (/xeon|epyc|threadripper/.test(n)) {
    family = 'server';
    m = 0.5;
  }
  const known = m != null;
  if (!known) {
    const c = num(clockMHz);
    m = c >= 3500 ? 0.5 : c >= 2500 ? 0.4 : 0.25;
  }
  const score = clamp(Math.round(100 * (0.7 * clamp(m, 0, 1) + 0.3 * threadFactor(num(threads)))), 1, 100);
  return { score, known, family, gen };
}

function cpuTier(score) {
  if (score >= 85) return 4;
  if (score >= 65) return 3;
  if (score >= 45) return 2;
  return 1;
}

// ---------------------------------------------------------------- Rohdaten zerlegen

const MEM_TYPE = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 29: 'LPDDR3', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5' };

// Übliche Pixelzahlen von Bildschirmen (Breite oder Höhe). Passen zwei Werte, gewinnt der übliche.
const COMMON_PX = new Set([
  720, 768, 800, 900, 1024, 1050, 1080, 1200, 1280, 1350, 1366, 1400, 1440, 1504, 1536, 1600, 1620, 1664, 1680, 1800, 1824, 1920,
  2000, 2048, 2160, 2256, 2400, 2560, 2736, 2880, 3000, 3200, 3440, 3456, 3840, 4320, 5120, 7680,
]);

/** So rechnet Chromium echte Pixel in DIP um: gfx::ScaleToEnclosingRect mit float, der rechte/untere Rand wird aufgerundet. */
function chromiumDip(px, sf) {
  return Math.ceil(Math.fround(px * Math.fround(1 / Math.fround(sf))));
}

/**
 * Echte Pixel einer Bildschirmseite aus Electrons DIP-Größe.
 * size × scaleFactor allein ist bei 125/150/175 % oft 1–2 Pixel zu groß, weil Chromium aufrundet
 * (2560 ÷ 1,5 = 1706,67 -> 1707 -> × 1,5 = 2561). Gesucht wird die Pixelzahl, aus der Chromium genau diese
 * DIP-Größe macht; passen mehrere, gewinnt ein üblicher, dann ein glatter (durch 8, 4, 2 teilbar), dann der größere Wert.
 */
function dipToPx(dip, sf) {
  if (!(dip > 0)) return 0;
  if (sf === 1 || !Number.isInteger(dip)) return Math.round(dip * sf);
  const hits = [];
  for (let px = Math.floor((dip - 1) * sf); px <= Math.ceil(dip * sf); px++) {
    if (px > 0 && chromiumDip(px, sf) === dip) hits.push(px);
  }
  if (!hits.length) return Math.round(dip * sf);
  const rank = (px) => (COMMON_PX.has(px) ? 8 : 0) + (px % 8 === 0 ? 4 : px % 4 === 0 ? 2 : px % 2 === 0 ? 1 : 0);
  return hits.reduce((best, px) => (rank(px) > rank(best) || (rank(px) === rank(best) && px > best) ? px : best));
}

/**
 * Echte Auflösung eines Electron-Bildschirms.
 * Zuerst die Auflösung, die Windows für die Grafikkarte meldet – wenn sie zu diesem Bildschirm passt.
 * Sonst wird Chromiums Rundung rückwärts gerechnet (dipToPx).
 */
function displayPixels(d, gpus = []) {
  const sf = num(d?.scaleFactor) || 1;
  const dw = num(d?.size?.width) || num(d?.bounds?.width) || 0;
  const dh = num(d?.size?.height) || num(d?.bounds?.height) || 0;
  const tol = Math.ceil(sf);
  const g = gpus.find((x) => x.resX && x.resY && Math.abs(x.resX - dw * sf) <= tol && Math.abs(x.resY - dh * sf) <= tol);
  if (g) return { width: g.resX, height: g.resY, scale: sf };
  return { width: dipToPx(dw, sf), height: dipToPx(dh, sf), scale: sf };
}

/** "32.0.15.6636" -> "566.36" (so zeigt NVIDIA die Treiberversion an). */
function nvidiaDriverVersion(v) {
  const p = str(v).split('.');
  if (p.length !== 4 || !p.every((x) => /^\d+$/.test(x))) return null;
  const s = (p[2] + p[3].padStart(4, '0')).slice(-5);
  return `${s.slice(0, 3)}.${s.slice(3)}`;
}

/**
 * Baut aus der PowerShell-Ausgabe, Node-Infos und den Electron-Bildschirmen ein sauberes Hardware-Objekt.
 * ps: { cpu, gpu, vram, ram, os } – jedes Feld darf Objekt, Array oder null sein (ConvertTo-Json).
 * node: { cpus: os.cpus(), totalmem: os.totalmem() }
 * disp: { displays: screen.getAllDisplays(), primaryId }
 */
function parseHardware(ps, node = {}, disp = {}) {
  ps = ps && typeof ps === 'object' ? ps : {};
  const warnings = [];

  // Prozessor (mehrere Sockel werden zusammengezählt)
  const cpuRows = asArray(ps.cpu).filter((c) => c && str(c.Name));
  const nodeCpus = asArray(node.cpus).filter(Boolean);
  const sum = (rows, k) => rows.reduce((a, c) => a + (int(c[k]) || 0), 0) || null;
  const cpu = {
    name: str(cpuRows[0]?.Name) || str(nodeCpus[0]?.model) || '',
    cores: cpuRows.length ? sum(cpuRows, 'NumberOfCores') : null,
    threads: cpuRows.length ? sum(cpuRows, 'NumberOfLogicalProcessors') : (nodeCpus.length || null),
    clockMHz: int(cpuRows[0]?.MaxClockSpeed) || int(nodeCpus[0]?.speed) || null,
    source: cpuRows.length ? 'windows' : nodeCpus.length ? 'node' : 'none',
  };
  if (!cpu.name) warnings.push('Der Prozessor wurde nicht erkannt.');

  // Grafikkarten + echter Grafikspeicher aus der Registrierung
  const vramRows = asArray(ps.vram).map((v) => ({
    name: str(v?.Name).toLowerCase(), id: pciId(v?.PciId ?? v?.MatchingDeviceId), bytes: num(v?.Bytes),
  })).filter((v) => v.bytes > 0);
  const gpus = [];
  for (const g of asArray(ps.gpu)) {
    const name = str(g?.Name);
    if (!name || VIRTUAL_GPU.test(name)) continue;
    const pci = pciId(g.PciId ?? g.PNPDeviceID);
    let reg = 0;
    for (const v of vramRows) if (v.id && pci && v.id === pci) reg = Math.max(reg, v.bytes);
    if (!reg) for (const v of vramRows) if (v.name && v.name === name.toLowerCase()) reg = Math.max(reg, v.bytes);
    const adapterRam = num(g.AdapterRAM);
    const vramBytes = reg || (adapterRam > 0 ? adapterRam : null);
    const cls = classifyGpu(name, vramBytes);
    const refresh = num(g.CurrentRefreshRate);
    gpus.push({
      name,
      short: shortGpuName(name),
      driver: str(g.DriverVersion) || null,
      driverShown: (cls.vendor === 'nvidia' && nvidiaDriverVersion(g.DriverVersion)) || str(g.DriverVersion) || null,
      driverDate: /^\d{4}-\d{2}-\d{2}$/.test(str(g.DriverDate)) ? str(g.DriverDate) : null,
      vramBytes,
      vramSource: reg ? 'registry' : vramBytes ? 'wmi' : null,
      vramCapped: !reg && adapterRam >= 4293918720,
      refreshHz: refresh && refresh < 1000 ? normalizeHz(refresh) : null,
      maxRefreshHz: normalizeHz(num(g.MaxRefreshRate) < 1000 ? num(g.MaxRefreshRate) : null),
      resX: int(g.CurrentHorizontalResolution) || null,
      resY: int(g.CurrentVerticalResolution) || null,
      ...cls,
    });
  }
  gpus.sort((a, b) => (b.score - a.score) || (a.integrated - b.integrated));
  const gpu = gpus[0] || null;
  if (!gpu) warnings.push('Die Grafikkarte wurde nicht erkannt.');

  // Arbeitsspeicher
  const mods = asArray(ps.ram).map((m) => ({
    bytes: num(m?.Capacity), configured: int(m?.ConfiguredClockSpeed), speed: int(m?.Speed), type: int(m?.SMBIOSMemoryType),
  })).filter((m) => m.bytes > 0);
  const visible = num(ps.os?.TotalVisibleMemorySize);
  const totalBytes = mods.reduce((a, m) => a + m.bytes, 0) || (visible ? visible * 1024 : null) || num(node.totalmem) || null;
  const maxOf = (k) => mods.reduce((a, m) => Math.max(a, m[k] || 0), 0) || null;
  const ram = {
    totalBytes,
    gb: totalBytes ? Math.round(totalBytes / GB) : null,
    modules: mods.length || null,
    speedMTs: maxOf('configured') || maxOf('speed'),
    ratedMTs: maxOf('speed'),
    type: MEM_TYPE[mods[0]?.type] || null,
  };
  if (!ram.gb) warnings.push('Der Arbeitsspeicher wurde nicht erkannt.');

  // Bildschirme: Electron meldet DIP (echte Pixel ÷ Skalierung, aufgerundet) – zurück in echte Pixel
  const displays = asArray(disp.displays).map((d) => {
    const px = displayPixels(d, gpus);
    return {
      id: d?.id ?? null, label: str(d?.label), width: px.width, height: px.height, hz: normalizeHz(d?.displayFrequency),
      scale: px.scale, internal: !!d?.internal, primary: disp.primaryId != null && d?.id === disp.primaryId,
    };
  }).filter((d) => d.width >= 320 && d.height >= 200);
  let display = displays.find((d) => d.primary) || displays[0] || null;
  if (!display && gpu && gpu.resX && gpu.resY) {
    display = { id: null, label: '', width: gpu.resX, height: gpu.resY, hz: gpu.refreshHz, scale: 1, internal: false, primary: true };
  }
  if (display && !display.hz && gpu?.refreshHz && displays.length <= 1) display = { ...display, hz: gpu.refreshHz };
  if (!display) warnings.push('Der Bildschirm wurde nicht erkannt.');

  const build = int(ps.os?.BuildNumber);
  return {
    cpu,
    gpu,
    gpus,
    ram,
    display,
    displays: displays.length ? displays : (display ? [display] : []),
    os: { caption: str(ps.os?.Caption) || null, build: build || null, win11: build ? build >= 22000 : null },
    warnings,
  };
}

// ---------------------------------------------------------------- Einordnen (für Menschen)

const LABELS = { 4: 'sehr stark', 3: 'stark', 2: 'mittel', 1: 'schwach' };
const TONES = { 4: 'ok', 3: 'ok', 2: '', 1: 'warn' };

function rateGpu(gpu, { now = Date.now() } = {}) {
  if (!gpu) return { tier: 2, label: 'unbekannt', tone: 'warn', text: 'HELIX konnte die Grafikkarte nicht auslesen und rechnet mit einer Mittelklasse-Karte.', details: '', tips: [] };
  const tier = gpuTier(gpu.score);
  const texts = {
    4: 'Sehr starke Grafikkarte. Hohe FPS und schöne Grafik sind kein Problem.',
    3: 'Starke Grafikkarte. Hohe FPS und gute Grafik laufen flüssig.',
    2: 'Solide Grafikkarte. Mit niedrigen bis mittleren Details läuft Fortnite flüssig.',
    1: gpu.integrated
      ? 'Eingebaute Grafik (sitzt im Prozessor). Mit dem Leistungsmodus ist Fortnite trotzdem gut spielbar.'
      : 'Ältere Grafikkarte. Mit dem Leistungsmodus läuft Fortnite am besten.',
  };
  let text = texts[tier];
  if (gpu.integrated && tier > 1) text = `Starke eingebaute Grafik (sitzt im Prozessor). ${tier >= 3 ? 'Sie schafft sogar mittlere Details.' : 'Mit niedrigen Details läuft Fortnite flüssig.'}`;
  if (!gpu.known) text += ' Das genaue Modell kennt HELIX nicht – die Einschätzung kommt vom Grafikspeicher.';
  const parts = [];
  if (gpu.integrated) parts.push('nutzt den Arbeitsspeicher mit');
  else if (gpu.vramBytes) parts.push(`${gpu.vramCapped ? 'mind. ' : ''}${deNum(gpu.vramBytes / GB, gpu.vramBytes / GB < 3 ? 1 : 0)} GB Grafikspeicher`);
  if (gpu.driverShown) parts.push(`Treiber ${gpu.driverShown}`);
  const tips = [];
  if (gpu.driverDate) {
    const age = (now - Date.parse(`${gpu.driverDate}T00:00:00Z`)) / 86400000;
    if (age > 365) {
      const [y, mo, d] = gpu.driverDate.split('-');
      tips.push({ kind: 'driver', vendor: gpu.vendor, text: `Dein Grafiktreiber ist vom ${d}.${mo}.${y}. Ein aktueller Treiber behebt oft Ruckler und bringt FPS.` });
    }
  }
  return { tier, label: LABELS[tier], tone: TONES[tier], text, details: parts.join(' · '), tips };
}

function rateCpu(cpu) {
  if (!cpu || !cpu.name) return { tier: 2, score: 50, label: 'unbekannt', tone: 'warn', text: 'HELIX konnte den Prozessor nicht genau auslesen.', details: '' };
  const c = classifyCpu(cpu);
  const tier = cpuTier(c.score);
  const texts = {
    4: 'Sehr schneller Prozessor. Perfekt für hohe FPS.',
    3: 'Schneller Prozessor. Er schafft hohe FPS.',
    2: 'Solider Prozessor. In großen Kämpfen kann er die FPS etwas bremsen.',
    1: 'Älterer oder sparsamer Prozessor. Er bremst die FPS in Fortnite am meisten.',
  };
  const parts = [];
  if (cpu.cores) parts.push(`${cpu.cores} Kerne`);
  if (cpu.threads) parts.push(`${cpu.threads} Threads (gleichzeitige Aufgaben)`);
  if (cpu.clockMHz) parts.push(`${deNum(cpu.clockMHz / 1000, 1)} GHz Grundtakt`);
  return { tier, score: c.score, known: c.known, label: LABELS[tier], tone: TONES[tier], text: texts[tier] + (c.known ? '' : ' Das genaue Modell kennt HELIX nicht – die Einschätzung kommt von Kernen und Takt.'), details: parts.join(' · ') };
}

function rateRam(ram, { laptop = false, integratedGpu = false } = {}) {
  const gb = ram?.gb;
  if (!gb) return { cap: 4, label: 'unbekannt', tone: 'warn', text: 'HELIX konnte den Arbeitsspeicher nicht auslesen.', details: '', tips: [] };
  let r;
  if (gb < 7.5) r = { cap: 1, label: 'zu wenig', tone: 'err', text: 'Fortnite braucht mindestens 8 GB. Schließe vor dem Spielen alle anderen Programme.' };
  else if (gb < 15) r = { cap: 2, label: 'knapp', tone: 'warn', text: '8 GB reichen gerade so. Schließe Browser und andere Programme, die du beim Spielen nicht brauchst.' };
  else if (gb < 31) r = { cap: 4, label: 'gut', tone: 'ok', text: `${gb} GB sind genug für Fortnite.` };
  else r = { cap: 4, label: 'sehr gut', tone: 'ok', text: `${gb} GB sind mehr als genug für Fortnite.` };
  const parts = [`${gb} GB`];
  if (ram.type) parts.push(ram.type);
  if (ram.speedMTs) parts.push(`${ram.speedMTs} MHz`);
  if (ram.modules) parts.push(ram.modules === 1 ? '1 Riegel' : `${ram.modules} Riegel`);
  const tips = [];
  if (ram.modules === 1 && !laptop) {
    tips.push({ kind: 'dual', text: `Nur ein Speicherriegel steckt. Mit zwei gleichen Riegeln („Dual-Channel“, doppelt so breite Datenleitung) läuft der PC oft spürbar schneller${integratedGpu ? ' – gerade mit eingebauter Grafik' : ''}.` });
  }
  const slowBase = (ram.type === 'DDR4' && ram.speedMTs && ram.speedMTs <= 2666) || (ram.type === 'DDR5' && ram.speedMTs && ram.speedMTs <= 4800);
  if (slowBase && !laptop && (!ram.ratedMTs || ram.speedMTs <= ram.ratedMTs)) {
    tips.push({ kind: 'xmp', text: `Der Speicher läuft mit Grundtempo (${ram.speedMTs} MHz). Viele Riegel schaffen mehr, wenn im BIOS „XMP“ oder „EXPO“ (fertiges Tempo-Profil des Herstellers) eingeschaltet ist.` });
  }
  return { ...r, details: parts.join(' · '), tips };
}

function rateDisplay(display, displays = [], gpu = null) {
  if (!display) return { label: 'unbekannt', tone: 'warn', text: 'Der Bildschirm wurde nicht erkannt. HELIX rechnet mit 1920 × 1080 und 60 Hz.', details: '', tips: [] };
  const hz = display.hz;
  let r;
  if (!hz) r = { label: 'Hz unbekannt', tone: 'warn', text: 'Die Bildwiederholrate (Bilder pro Sekunde, die der Monitor zeigt) wurde nicht erkannt. HELIX rechnet mit 60 Hz.' };
  else if (hz >= 240) r = { label: 'sehr schnell', tone: 'ok', text: `Sehr schneller Gaming-Monitor: Er zeigt bis zu ${hz} Bilder pro Sekunde (${hz} Hz).` };
  else if (hz >= 144) r = { label: 'schnell', tone: 'ok', text: `Gaming-Monitor: Er zeigt bis zu ${hz} Bilder pro Sekunde (${hz} Hz).` };
  else if (hz >= 100) r = { label: 'gut', tone: 'ok', text: `Er zeigt bis zu ${hz} Bilder pro Sekunde (${hz} Hz) – flüssiger als ein Standard-Monitor.` };
  else r = { label: 'normal', tone: '', text: `Standard-Monitor: Er zeigt höchstens ${hz} Bilder pro Sekunde (${hz} Hz). Mehr FPS machen das Spiel nur minimal direkter.` };
  const parts = [`${display.width} × ${display.height}`];
  if (hz) parts.push(`${hz} Hz`);
  if (display.scale && Math.abs(display.scale - 1) > 0.01) parts.push(`Skalierung ${Math.round(display.scale * 100)} %`);
  if (displays.length > 1) parts.push(displays.length === 2 ? '+1 weiterer Bildschirm' : `+${displays.length - 1} weitere Bildschirme`);
  const tips = [];
  if (displays.length > 1) tips.push({ kind: 'multi', text: 'Fortnite startet auf deinem Hauptbildschirm. HELIX richtet die Auflösung nach ihm aus.' });
  const max = gpu?.maxRefreshHz;
  if (hz && max && max >= hz + 10 && max <= 500 && displays.length <= 1) {
    tips.push({ kind: 'hz', text: `Windows nutzt ${hz} Hz, dein Monitor kann vermutlich bis zu ${max} Hz. Stell das in den Windows-Anzeigeeinstellungen um – dann siehst du mehr Bilder pro Sekunde.` });
  }
  return { ...r, details: parts.join(' · '), tips };
}

/**
 * Leistungsklasse 1–4 aus Grafikkarte, Prozessor und Arbeitsspeicher.
 * Die Grafikkarte zählt am meisten, ein schwacher Prozessor oder wenig RAM bremsen.
 */
function performanceClass({ gpuScore, cpuScore, ramGB }) {
  const g = gpuTier(gpuScore);
  const c = cpuTier(cpuScore);
  const ramCap = !ramGB ? 4 : ramGB < 7.5 ? 1 : ramGB < 15 ? 2 : 4;
  const cls = Math.max(1, Math.min(g, c + 1, ramCap));
  let limiter = null;
  if (ramCap < g && ramCap <= c + 1) limiter = 'ram';
  else if (c + 1 < g) limiter = 'cpu';
  else if (g < c) limiter = 'gpu';
  return { cls, gpuTier: g, cpuTier: c, ramCap, limiter };
}

const CLASS_TEXT = {
  1: ['Einsteiger-PC', 'Für Fortnite eher schwach. Mit dem Leistungsmodus läuft es trotzdem flüssig.'],
  2: ['Mittelklasse', 'Solide Mittelklasse. Für flüssige Matches ist der Leistungsmodus am besten.'],
  3: ['Stark', 'Starker PC. Hohe FPS und ein schönes Bild sind drin.'],
  4: ['Sehr stark', 'Sehr starker PC. Auch hohe Grafik läuft flüssig.'],
};
const LIMITER_TEXT = {
  gpu: 'Am meisten bremst die Grafikkarte.',
  cpu: 'Am meisten bremst der Prozessor – er bestimmt, wie viele FPS möglich sind.',
  ram: 'Am meisten bremst der Arbeitsspeicher – mehr RAM würde helfen.',
};

// ---------------------------------------------------------------- FPS grob schätzen

const K_GPU = { leistung: 18, ausgewogen: 7.2, qualitaet: 2.75 };
const K_CPU = { leistung: 1, ausgewogen: 0.7, qualitaet: 0.6 };

/** Grobe FPS-Schätzung in Matches (kein Messwert). */
function estimateFps(presetId, { gpuScore, cpuScore, width = 1920, height = 1080, ramGB = 16 }) {
  const px = Math.max(0.3, (width * height) / (1920 * 1080));
  const g = K_GPU[presetId] * Math.pow(Math.max(0.5, gpuScore), 0.95) / Math.pow(px, 0.85);
  const c = 40 * Math.exp(cpuScore / 37) * K_CPU[presetId];
  let t = Math.min(g, c);
  if (ramGB && ramGB < 7.5) t *= 0.75;
  else if (ramGB && ramGB < 15) t *= 0.9;
  t = clamp(t, 10, 999);
  return { typical: round5(t), low: round5(t * 0.75), high: round5(t * 1.15), limitedBy: g <= c ? 'gpu' : 'cpu' };
}

/**
 * FPS-Grenze für einen Vorschlag.
 * Unbegrenzt nur im Leistungsmodus auf sehr starken PCs, die weit mehr schaffen als der Monitor zeigt.
 */
function fpsCapFor(presetId, est, hz, perfClass) {
  hz = hz || 60;
  if (presetId === 'leistung' && perfClass >= 4 && est.low >= hz * 1.5) return { cap: 0, reason: 'unlimited' };
  if (est.low >= hz * 0.95) return { cap: hz, reason: 'hz' };
  let c = 30;
  for (const s of FPS_STEPS) if (s <= est.low) c = s;
  if (c < 60 && est.low >= 50 && hz >= 60) c = 60;
  return { cap: Math.min(c, hz), reason: 'stable' };
}

function fpsOptions(hz, rec) {
  hz = hz || 60;
  const set = new Set([60, 120, 144, 165, 240, 360].filter((v) => v <= hz * 2));
  set.add(hz);
  if (rec > 0) set.add(rec);
  return [...set].filter((v) => v >= 30).sort((a, b) => a - b).concat([0]);
}

function validFpsCap(v) {
  return Number.isInteger(v) && (v === 0 || (v >= 20 && v <= 1000));
}

// ---------------------------------------------------------------- Vorschläge

const LEVELS = {
  //            view sh  gi  rf  pp  fx  fol sha aa
  leistung: {
    1: [1, 0, 0, 0, 0, 0, 0, 0, 0], 2: [2, 0, 0, 0, 0, 0, 0, 0, 0], 3: [2, 0, 0, 0, 0, 0, 0, 0, 0], 4: [3, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  ausgewogen: {
    1: [2, 0, 0, 0, 0, 0, 0, 0, 0], 2: [2, 0, 1, 1, 1, 1, 1, 1, 1], 3: [3, 1, 1, 1, 1, 1, 1, 1, 1], 4: [3, 2, 1, 1, 2, 2, 2, 2, 2],
  },
  qualitaet: {
    1: [2, 1, 1, 1, 1, 1, 1, 1, 1], 2: [3, 1, 1, 1, 2, 2, 2, 2, 2], 3: [3, 2, 2, 2, 2, 2, 2, 2, 2], 4: [3, 3, 3, 3, 3, 3, 3, 3, 3],
  },
};

const PRESET_META = {
  leistung: { title: 'Leistung', desc: 'Meiste FPS und klare Sicht. Schlichte Grafik – ideal für Ranked und Turniere.', mode: 'Leistungsmodus' },
  ausgewogen: { title: 'Ausgewogen', desc: 'Gutes Bild und trotzdem flüssig. DirectX 12 mit so viel Details, wie dein PC locker schafft.', mode: 'DirectX 12' },
  qualitaet: { title: 'Qualität', desc: 'Das schönste Bild für deinen PC: Licht, Schatten und Details. Dafür weniger FPS.', mode: 'DirectX 12' },
};

function textureLevel(presetId, { integrated, vramGB, ramGB }) {
  let t;
  if (integrated) t = ramGB >= 16 ? 1 : 0;
  else if (vramGB == null) t = 1;
  else t = vramGB < 3 ? 0 : vramGB < 5 ? 1 : vramGB < 8 ? 2 : 3;
  if (presetId === 'leistung') return Math.min(t, 1);
  if (presetId === 'ausgewogen') return Math.min(t, 2);
  return t;
}

function aaMethod(presetId, cls) {
  if (presetId === 'leistung') return 'Disabled';
  if (presetId === 'ausgewogen') return cls <= 1 ? 'FXAA' : cls === 2 ? 'TSRLow' : 'TSRMedium';
  return 'TSRMedium';
}

/** Name einer Stufe, wie Fortnite ihn im Menü zeigt (id = Eintrag, z. B. 'shadows' -> 0 = „Aus“). */
const q = (l, id) => (QUALITY_NAMES[id] || QUALITY)[l] || String(l);

/**
 * Baut alle Einträge eines Vorschlags. Jeder Eintrag = eine Zeile in der Vorschau,
 * kann aber mehrere INI-Schlüssel ändern (z. B. Auflösung = 8 Schlüssel, die zusammenpassen müssen).
 */
function buildItems(presetId, b) {
  const { cls, gpu, display, fps } = b;
  const lv = LEVELS[presetId][cls];
  const [view, shadow, gi, refl, post, fx, foliage, shading, aaQ] = lv;
  const perfMode = presetId === 'leistung';
  const tex = textureLevel(presetId, b);
  const nanite = presetId === 'qualitaet' && !!b.naniteOk;
  const grass = presetId === 'qualitaet' || (presetId === 'ausgewogen' && cls >= 3);
  const aa = aaMethod(presetId, cls);
  const items = [];
  const add = (id, label, group, kind, why, changes) => items.push({ id, label, group, kind, why, changes });

  add('renderMode', 'Darstellungsmodus', 'Anzeige', 'renderMode',
    perfMode
      ? 'Der Leistungsmodus ist Fortnites eigener Modus für hohe FPS: schlichte Grafik, sehr flüssig, wenig Ruckler.'
      : 'DirectX 12 ist der normale Grafikmodus mit allen Details. (DirectX 11 gibt es in Fortnite nicht mehr.)',
    [{ section: RHI, key: 'PreferredRHI', value: 'dx12' }, { section: RHI, key: 'PreferredFeatureLevel', value: perfMode ? 'es31' : 'sm6' }]);

  if (display && display.width >= 640 && display.height >= 480) {
    const w = fmtInt(clamp(display.width, 640, 16384));
    const h = fmtInt(clamp(display.height, 480, 16384));
    add('resolution', 'Auflösung', 'Anzeige', 'resolution',
      `Die volle Auflösung deines Monitors (${w} × ${h}) gibt das schärfste Bild. Eine kleinere Auflösung bringt kaum FPS, macht Gegner auf Distanz aber unscharf.`,
      [
        { section: FGUS, key: 'ResolutionSizeX', value: w }, { section: FGUS, key: 'ResolutionSizeY', value: h },
        { section: FGUS, key: 'LastUserConfirmedResolutionSizeX', value: w }, { section: FGUS, key: 'LastUserConfirmedResolutionSizeY', value: h },
        { section: FGUS, key: 'DesiredScreenWidth', value: w }, { section: FGUS, key: 'DesiredScreenHeight', value: h },
        { section: FGUS, key: 'LastUserConfirmedDesiredScreenWidth', value: w }, { section: FGUS, key: 'LastUserConfirmedDesiredScreenHeight', value: h },
      ]);
  }

  add('windowMode', 'Anzeigemodus', 'Anzeige', 'windowMode',
    'Echtes Vollbild: Windows mischt sich nicht ein, das gibt die geringste Verzögerung. Wechselst du oft mit Alt+Tab, ist „Fenster-Vollbild“ bequemer.',
    [{ section: FGUS, key: 'FullscreenMode', value: '0' }, { section: FGUS, key: 'LastConfirmedFullscreenMode', value: '0' }, { section: FGUS, key: 'PreferredFullscreenMode', value: '0' }]);

  add('fps', 'FPS-Grenze', 'Anzeige', 'fps', fps.why, [{ section: FGUS, key: 'FrameRateLimit', value: fmtFloat(fps.cap) }]);

  add('vsync', 'VSync', 'Anzeige', 'bool',
    'VSync wartet bei jedem Bild auf den Monitor. Das verhindert Bildrisse, macht die Maus aber spürbar träger.',
    [{ section: FGUS, key: 'bUseVSync', value: fmtBool(false) }]);

  if (gpu && gpu.vendor === 'nvidia' && gpu.reflex) {
    add('reflex', 'NVIDIA Reflex', 'Anzeige', 'reflex',
      'NVIDIA Reflex verkürzt die Zeit zwischen Klick und Bild. „An + Boost“ hält die Grafikkarte dabei auf vollem Takt.',
      [{ section: FGUS, key: 'LatencyTweak2', value: '2' }]);
  }

  add('res3d', '3D-Auflösung', 'Grafik', 'percent',
    `100 % heißt: Das Spiel wird in voller Schärfe berechnet.${cls <= 1 ? ' Reicht die Leistung trotzdem nicht, stell sie im Spiel auf 75–85 %.' : ''}`,
    [{ section: SG, key: 'sg.ResolutionQuality', value: '100' }]);

  add('viewDistance', 'Sichtweite', 'Grafik', 'quality',
    `Wie weit entfernte Gebäude und Objekte mit Details gezeigt werden. „${q(view, 'viewDistance')}“ kostet wenig Leistung und hilft, Gegner früh zu sehen.`,
    [{ section: SG, key: 'sg.ViewDistanceQuality', value: fmtInt(view) }]);

  add('textures', 'Texturen', 'Grafik', 'quality',
    b.integrated
      ? `Texturen sind die Oberflächenbilder. Deine eingebaute Grafik teilt sich den Arbeitsspeicher – „${q(tex)}“ lässt genug davon frei.`
      : b.vramGB != null
        ? `Texturen sind die Oberflächenbilder und brauchen vor allem Grafikspeicher. Mit ${deNum(b.vramGB, 0)} GB passt „${q(tex)}“${perfMode ? ' – mehr bringt im Leistungsmodus kaum etwas' : ''}.`
        : `Texturen sind die Oberflächenbilder. „${q(tex)}“ ist ein sicherer Wert.`,
    [{ section: SG, key: 'sg.TextureQuality', value: fmtInt(tex) }]);

  if (perfMode) {
    add('meshes', 'Objekt-Details (Meshes)', 'Grafik', 'mesh',
      'Wie fein Objekte im Leistungsmodus gebaut sind. „Niedrig“ bringt die meisten FPS.',
      [{ section: PERF, key: 'MeshQuality', value: '0' }]);
  }

  add('shadows', 'Schatten', 'Grafik', 'quality',
    shadow === 0
      ? 'Schatten aus: mehr FPS, und Gegner in dunklen Ecken sind leichter zu sehen.'
      : presetId === 'qualitaet'
        ? `Schatten auf „${q(shadow, 'shadows')}“ für ein echtes Bild. Schatten kosten viel Leistung – wird es zu langsam, stell sie zuerst runter.`
        : `Schatten auf „${q(shadow, 'shadows')}“ sehen natürlich aus und kosten nur mäßig FPS.`,
    [{ section: SG, key: 'sg.ShadowQuality', value: fmtInt(shadow) }]);

  add('gi', 'Globale Beleuchtung', 'Grafik', 'quality',
    gi >= 2
      ? `Wie Licht von Wänden zurückstrahlt. Ab „Hoch“ nutzt Fortnite „Lumen“ (sehr echtes Licht) – sieht toll aus, kostet aber viel Leistung.`
      : gi === 1
        ? 'Wie Licht von Wänden zurückstrahlt. Auf „Mittel“ bleibt das teure Lumen-Licht aus – das spart viele FPS.'
        : 'Wie Licht von Wänden zurückstrahlt. „Aus“ bringt die meisten FPS.',
    [{ section: FGUS, key: 'DesiredGlobalIlluminationQuality', value: fmtInt(gi) }, { section: SG, key: 'sg.GlobalIlluminationQuality', value: fmtInt(gi) }]);

  add('reflections', 'Reflexionen', 'Grafik', 'quality',
    refl >= 2
      ? 'Spiegelungen auf Wasser und Glas. Ab „Hoch“ mit Lumen: echte Spiegelungen, kostet viel Leistung.'
      : `Spiegelungen auf Wasser und Glas. „${q(refl, 'reflections')}“ spart Leistung.`,
    [{ section: FGUS, key: 'DesiredReflectionQuality', value: fmtInt(refl) }, { section: SG, key: 'sg.ReflectionQuality', value: fmtInt(refl) }]);

  add('effects', 'Effekte', 'Grafik', 'quality',
    fx <= 1 ? `Explosionen, Rauch und Funken. „${q(fx)}“ sorgt für klare Sicht in Kämpfen.` : `Explosionen, Rauch und Funken sehen auf „${q(fx)}“ deutlich schöner aus.`,
    [{ section: SG, key: 'sg.EffectsQuality', value: fmtInt(fx) }]);

  add('postprocess', 'Nachbearbeitung', 'Grafik', 'quality',
    post === 0 ? 'Filter über dem ganzen Bild (z. B. Leuchten). „Niedrig“ = klareres Bild und mehr FPS.' : `Filter über dem ganzen Bild (z. B. Leuchten). „${q(post)}“ macht das Bild stimmungsvoller.`,
    [{ section: SG, key: 'sg.PostProcessQuality', value: fmtInt(post) }]);

  add('details', 'Pflanzen & Oberflächen', 'Grafik', 'quality',
    'Pflanzen-Dichte und feine Oberflächen. Im Spielmenü nicht einzeln einstellbar – HELIX setzt sie passend zum Rest.',
    [{ section: SG, key: 'sg.FoliageQuality', value: fmtInt(foliage) }, { section: SG, key: 'sg.ShadingQuality', value: fmtInt(shading) }]);

  add('aa', 'Kantenglättung', 'Grafik', 'aa',
    (aa === 'Disabled'
      ? 'Kantenglättung aus: Das Bild bleibt gestochen scharf ohne Nachzieh-Effekte und kostet keine Leistung. Kanten flimmern dafür etwas.'
      : aa === 'FXAA'
        ? 'FXAA glättet Kanten fast ohne Leistungskosten.'
        : `TSR (Epics Kantenglättung) glättet Kanten sauber. „${aa === 'TSRLow' ? 'Niedrig' : 'Mittel'}“ ist ein guter Mittelweg aus Schärfe und Leistung.`)
    + (presetId === 'qualitaet' && gpu?.rtx ? ' Mit deiner RTX-Karte kannst du im Spiel auch „NVIDIA DLSS“ wählen – das bringt mehr FPS bei fast gleichem Bild.' : ''),
    [{ section: FGUS, key: 'FortAntiAliasingMethod', value: aa }, { section: SG, key: 'sg.AntiAliasingQuality', value: fmtInt(aaQ) }]);

  add('grass', 'Gras', 'Extras', 'bool',
    grass ? 'Gras an: Die Landschaft wirkt lebendiger. Kostet etwas Leistung.' : 'Gras aus: mehr FPS und freie Sicht auf den Boden.',
    [{ section: FGUS, key: 'bShowGrass', value: fmtBool(grass) }]);

  add('motionBlur', 'Bewegungsunschärfe', 'Extras', 'bool',
    'Bewegungsunschärfe verwischt das Bild bei schnellen Drehungen – Gegner sind dann schwerer zu treffen.',
    [{ section: FGUS, key: 'bMotionBlur', value: fmtBool(false) }]);

  add('nanite', 'Nanite', 'Extras', 'bool',
    nanite
      ? 'Nanite zeigt Gebäude und Felsen extrem detailreich. Deine Grafikkarte ist stark genug dafür.'
      : presetId === 'qualitaet'
        ? 'Nanite (sehr feine Geometrie) ist für deine Grafikkarte zu schwer. Aus = flüssiger.'
        : 'Nanite (sehr feine Geometrie) kostet viel Leistung. Aus = mehr FPS.',
    [{ section: FGUS, key: 'bUseNanite', value: fmtBool(nanite) }]);

  add('raytracing', 'Raytracing', 'Extras', 'bool',
    'Raytracing (berechnetes Licht in Echtzeit) sieht toll aus, halbiert aber oft die FPS. Für Fortnite lohnt es sich kaum.',
    [{ section: FGUS, key: 'bRayTracing', value: fmtBool(false) }]);

  return items;
}

function fpsWhy(reason, cap, hz, est) {
  hz = hz || 60;
  if (reason === 'unlimited') return `Ohne Grenze: Dein PC schafft viel mehr Bilder, als dein Monitor zeigt (${hz} Hz). So reagiert das Spiel minimal schneller. Wird der PC laut oder heiß, stell die Grenze auf ${hz}.`;
  if (reason === 'hz') return `Genau so viele Bilder, wie dein Monitor zeigen kann (${hz} Hz). Das läuft gleichmäßig und hält den PC kühler und leiser.`;
  if (reason === 'stable') return `Dein PC schafft in Kämpfen grob ${est.low} Bilder pro Sekunde. Eine feste Grenze von ${cap} sorgt für ein gleichmäßiges Spielgefühl statt Ruckeln.`;
  if (cap === 0) return 'Von dir gewählt: keine Grenze. Dein PC macht so viele Bilder, wie er schafft.';
  return `Von dir gewählt: höchstens ${cap} Bilder pro Sekunde.`;
}

/**
 * Wertet die Hardware aus und baut die drei Vorschläge.
 * opts.fpsOverride: { [presetId]: cap } – vom Nutzer gewählte FPS-Grenze
 */
function analyze(hw, { now = Date.now(), fpsOverride = {} } = {}) {
  const gpu = hw.gpu || null;
  const cpuR = rateCpu(hw.cpu);
  const gpuR = rateGpu(gpu, { now });
  const laptop = !!hw.display?.internal || !!gpu?.mobile;
  const ramR = rateRam(hw.ram, { laptop, integratedGpu: !!gpu?.integrated });
  const dispR = rateDisplay(hw.display, hw.displays, gpu);
  const gpuScore = gpu ? gpu.score : 12;
  const cpuScore = cpuR.score ?? 50;
  const ramGB = hw.ram?.gb || null;
  const perf = performanceClass({ gpuScore, cpuScore, ramGB });
  const cls = perf.cls;
  const hz = hw.display?.hz || 60;
  const width = hw.display?.width || 1920;
  const height = hw.display?.height || 1080;
  const vramGB = gpu && !gpu.integrated && gpu.vramBytes ? gpu.vramBytes / GB : null;
  const naniteOk = !!gpu && !gpu.integrated && gpu.score >= 33 && (vramGB == null || vramGB >= 8);

  const presets = PRESET_IDS.map((id) => {
    const est = estimateFps(id, { gpuScore, cpuScore, width, height, ramGB });
    const rec = fpsCapFor(id, est, hz, cls);
    const override = fpsOverride[id];
    const useOverride = validFpsCap(override) && override !== rec.cap;
    const cap = useOverride ? override : rec.cap;
    const reason = useOverride ? 'user' : rec.reason;
    const fps = { cap, reason, why: fpsWhy(reason, cap, hz, est), recommendedCap: rec.cap, recommendedReason: rec.reason };
    const items = buildItems(id, { cls, gpu, display: hw.display, fps, integrated: !!gpu?.integrated, vramGB, ramGB: ramGB || 8, naniteOk });
    const levels = LEVELS[id][cls];
    const avg = Math.round((levels[0] + levels[1] + levels[2] + levels[4] + levels[5]) / 5);
    const warnings = [];
    if (est.low < 30) warnings.push('Auf diesem PC wahrscheinlich nicht flüssig.');
    else if (est.low < Math.min(hz, 60)) warnings.push('In großen Kämpfen kann es ruckeln.');
    return {
      id,
      ...PRESET_META[id],
      quality: id === 'leistung' ? 'Niedrig' : QUALITY[avg],
      est,
      fps,
      fpsOptions: fpsOptions(hz, rec.cap),
      warnings,
      heavy: est.low < 30,
      items,
    };
  });

  const byId = Object.fromEntries(presets.map((p) => [p.id, p]));
  let recommended = 'leistung';
  if (!(ramGB && ramGB < 7.5)) {
    if (cls >= 3 && byId.qualitaet.est.low >= hz * 0.95) recommended = 'qualitaet';
    else if (cls >= 2 && byId.ausgewogen.est.low >= hz * 0.95) recommended = 'ausgewogen';
  }
  for (const p of presets) p.recommended = p.id === recommended;
  const r = byId[recommended];
  const reason = recommended === 'leistung'
    ? `Damit schafft dein PC die meisten Bilder pro Sekunde${hz >= 120 ? ` – wichtig für deinen ${hz}-Hz-Monitor` : ''}.`
    : recommended === 'ausgewogen'
      ? `Dein PC schafft damit auch in Kämpfen grob ${r.est.low} FPS – genug für deinen ${hz}-Hz-Monitor – und das Bild sieht deutlich besser aus.`
      : `Dein PC ist stark genug für hohe Grafik und schafft trotzdem die ${hz} Hz deines Monitors.`;
  const [clsLabel, clsText] = CLASS_TEXT[cls];
  return {
    ratings: { cpu: cpuR, gpu: gpuR, ram: ramR, display: dispR },
    perf: { cls, label: clsLabel, text: clsText, limiter: perf.limiter, limiterText: perf.limiter ? LIMITER_TEXT[perf.limiter] : 'Die Teile passen gut zusammen – keins bremst stark.', gpuTier: perf.gpuTier, cpuTier: perf.cpuTier },
    hz,
    presets,
    recommended,
    recommendReason: reason,
    competitiveTip: recommended !== 'leistung' ? 'Spielst du vor allem Ranked oder Turniere, nimm „Leistung“ – dort sind mehr FPS wichtiger als schöne Grafik.' : null,
  };
}

// ---------------------------------------------------------------- Vorschau: INI-Werte -> lesbarer Text

const RHI_TEXT = { dx11: 'DirectX 11', dx12: 'DirectX 12' };

/** detail: beim Leistungsmodus auch DirectX dazuschreiben ("Leistungsmodus (DirectX 11)"). */
function renderModeText(rhi, level, detail = false) {
  const r = str(rhi).toLowerCase();
  const l = str(level).toLowerCase();
  if (!r && !l) return null;
  if (l === 'es31' || r === 'performance') return detail && RHI_TEXT[r] ? `Leistungsmodus (${RHI_TEXT[r]})` : 'Leistungsmodus';
  if (r === 'dx11' || l === 'sm5') return 'DirectX 11 (alt)';
  if (r === 'dx12' || l === 'sm6') return 'DirectX 12';
  return `${rhi ?? '?'} / ${level ?? '?'}`;
}

/**
 * Zeigt die Werte eines Eintrags lesbar an. get(key) liefert den Rohwert oder null.
 * detail: genauer, falls die kurze Form vorher und nachher gleich aussieht.
 */
function describe(item, get, detail = false) {
  const k0 = item.changes[0].key;
  const v = get(k0);
  switch (item.kind) {
    case 'renderMode': return renderModeText(get('PreferredRHI'), get('PreferredFeatureLevel'), detail);
    case 'resolution': {
      const x = int(get('ResolutionSizeX'));
      const y = int(get('ResolutionSizeY'));
      return x && y ? `${x} × ${y}` : null;
    }
    case 'windowMode': return v == null ? null : (WINDOW_MODE[int(v)] || str(v));
    case 'fps': {
      const n = num(v);
      if (n == null) return null;
      return n <= 0 ? 'Unbegrenzt' : `${Math.round(n)} FPS`;
    }
    case 'bool': return v == null ? null : (/^true$/i.test(str(v)) ? 'An' : /^false$/i.test(str(v)) ? 'Aus' : str(v));
    case 'reflex': return v == null ? null : (REFLEX[int(v)] || str(v));
    case 'percent': return num(v) == null ? null : `${Math.round(num(v))} %`;
    case 'mesh': return num(v) == null ? null : (num(v) <= 0 ? 'Niedrig' : 'Hoch');
    case 'aa': return v == null ? null : (AA_TEXT[str(v).toLowerCase()] || str(v));
    case 'quality': {
      if (item.id === 'details') {
        const a = int(get('sg.FoliageQuality'));
        const b = int(get('sg.ShadingQuality'));
        if (a == null && b == null) return null;
        return a === b || b == null ? q(a ?? b) : `${q(a)} / ${q(b)}`;
      }
      const n = int(v ?? (item.changes[1] ? get(item.changes[1].key) : null));
      return n == null ? null : q(n, item.id);
    }
    default: return v == null ? null : str(v);
  }
}

/** "1 Eintrag fehlt", "2 Einträge weichen ab" – was sich in der Datei ändert, obwohl es im Spiel gleich aussieht. */
function hiddenChangeText(raw) {
  const ch = raw.filter((r) => r.changed);
  const missing = ch.filter((r) => r.from == null).length;
  const differ = ch.length - missing;
  const parts = [];
  if (missing) parts.push(missing === 1 ? '1 Eintrag fehlt' : `${missing} Einträge fehlen`);
  if (differ) parts.push(differ === 1 ? '1 Eintrag weicht ab' : `${differ} Einträge weichen ab`);
  return parts.join(', ');
}

/**
 * Verbindet die Einträge eines Vorschlags mit der Vorschau von ctx.core.previewIniChanges.
 * preview.changes: [{section, key, from, to, changed}]
 */
function buildRows(items, preview) {
  const cur = new Map();
  for (const c of preview?.changes || []) cur.set(`${c.section}|${c.key}`.toLowerCase(), c.from);
  const getter = (item) => (key) => {
    const ch = item.changes.find((c) => c.key.toLowerCase() === key.toLowerCase());
    const section = ch ? ch.section : (key === 'PreferredRHI' || key === 'PreferredFeatureLevel' ? RHI : FGUS);
    const v = cur.get(`${section}|${key}`.toLowerCase());
    return v === undefined ? null : v;
  };
  return items.map((item) => {
    const get = getter(item);
    const raw = item.changes.map((c) => {
      const from = get(c.key);
      return { section: c.section, key: c.key, from, to: c.value, changed: !sameValue(from, c.value) };
    });
    const target = new Map(item.changes.map((c) => [c.key.toLowerCase(), c.value]));
    const getTo = (k) => target.get(k.toLowerCase()) ?? get(k);
    const changed = raw.some((r) => r.changed);
    const row = {
      id: item.id, label: item.label, group: item.group, why: item.why,
      from: describe(item, get) ?? 'nicht gesetzt',
      to: describe(item, getTo),
      changed, raw, note: null,
    };
    // Sieht vorher und nachher gleich aus, ändert aber Einträge: genauer zeigen, was sich ändert
    if (changed && row.from === row.to) {
      const from = describe(item, get, true);
      const to = describe(item, getTo, true);
      if (from && to && from !== to) Object.assign(row, { from, to });
      else row.from = `${row.from} (${hiddenChangeText(raw)})`;
    }
    if (item.id === 'resolution' && changed) {
      const x = int(get('ResolutionSizeX'));
      const y = int(get('ResolutionSizeY'));
      const nx = int(target.get('resolutionsizex'));
      const ny = int(target.get('resolutionsizey'));
      if (x && y && nx && ny && Math.abs(x / y - nx / ny) > 0.03) {
        row.note = 'Du nutzt gerade eine gestreckte Auflösung. Willst du sie behalten, nimm hier den Haken raus.';
      }
    }
    return row;
  });
}

/** Nur die INI-Änderungen, die wirklich etwas ändern (optional ohne übersprungene Einträge). */
function changesToWrite(items, preview, skip = []) {
  const skipSet = new Set(skip);
  const rows = buildRows(items, preview);
  const out = [];
  for (const row of rows) {
    if (skipSet.has(row.id)) continue;
    for (const r of row.raw) if (r.changed) out.push({ section: r.section, key: r.key, value: r.to });
  }
  return out;
}

function allChanges(items) {
  return items.flatMap((i) => i.changes.map((c) => ({ section: c.section, key: c.key, value: c.value })));
}

/** "RTX 4070 · empfohlen: Ausgewogen" für das Cockpit. */
function summaryText(state) {
  if (!state || !state.lastScan) return null;
  const s = state.lastScan;
  const title = PRESET_META[s.recommended]?.title;
  const parts = [];
  if (s.gpuShort) parts.push(s.gpuShort);
  if (state.lastApplied && PRESET_META[state.lastApplied.preset]) parts.push(`übernommen: ${PRESET_META[state.lastApplied.preset].title}`);
  else if (title) parts.push(`empfohlen: ${title}`);
  return parts.length ? parts.join(' · ') : null;
}

module.exports = {
  FGUS, SG, RHI, PERF, PRESET_IDS, PRESET_META, FPS_STEPS,
  asArray, pciId, num, int, sameValue, normalizeHz, fmtFloat, fmtBool,
  normGpuName, shortGpuName, shortCpuName, classifyGpu, gpuTier, classifyCpu, cpuTier, nvidiaDriverVersion,
  chromiumDip, dipToPx, parseHardware, rateGpu, rateCpu, rateRam, rateDisplay, performanceClass,
  estimateFps, fpsCapFor, fpsOptions, validFpsCap, buildItems, analyze,
  renderModeText, describe, buildRows, changesToWrite, allChanges, summaryText,
};
