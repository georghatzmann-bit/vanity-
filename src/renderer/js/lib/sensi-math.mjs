// Sensi-Kalibrierung: reine Rechen- und Bewertungsfunktionen (ohne DOM).
// Wird von der Ansicht, der Test-Arena und den Unit-Tests benutzt.
//
// Quellen der Zahlen: siehe Recherche "sensitivity-math" (KovaaK-Konverterdaten, fpsmath, senslab.pro).
//   Fortnite: Grad pro Maus-Count = Sensi% * 0.005555, Sichtfeld 80° horizontal bei 16:9.

export const FN_YAW = 0.005555; // Grad pro Count je 1 % Fortnite-Sensi
export const CM_PER_INCH = 2.54;
export const HFOV_DEG = 80; // Fortnite, gemessen bei 16:9
export const VFOV_DEG = (2 * Math.atan(Math.tan((40 * Math.PI) / 180) * (9 / 16)) * 180) / Math.PI; // ≈ 50,53°

/** Verteilung der Profis (senslab.pro, 259 Spieler): Median 52, mittlere Hälfte 48–59. */
export const PRO_EDPI = { median: 52, p25: 48, p75: 59, min: 27, max: 132 };

export const LIMITS = {
  dpi: [50, 32000],
  sens: [0.1, 100],
  targeting: [1, 200],
  scope: [1, 200],
};

export const DEFAULT_SETTINGS = { dpi: 800, sens: 6.5, targeting: 45, scope: 45 };

const RAD = Math.PI / 180;

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const clamp01 = (v) => clamp(v, 0, 1);
const round = (v, d = 0) => {
  const f = 10 ** d;
  return Math.round((v + Number.EPSILON * Math.sign(v)) * f) / f;
};
export { round as roundTo };

// ---------------------------------------------------------------- Zahlen

/** Liest "6,5", "6.5", " 800 " oder Zahlen. Gibt NaN zurück, wenn es keine Zahl ist. */
export function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  const s = v.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** Deutsche Schreibweise mit Komma. fmtNum(6.5, 1) -> "6,5" */
export function fmtNum(v, decimals = 1) {
  if (!Number.isFinite(v)) return '–';
  const r = round(v, decimals);
  const s = (Object.is(r, -0) ? 0 : r).toFixed(decimals);
  return s.replace('.', ',');
}

/** Sensi wie in Fortnite (eine Nachkommastelle, bei Bedarf zwei). */
export function fmtSens(v) {
  if (!Number.isFinite(v)) return '–';
  const one = Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
  return fmtNum(v, one ? 1 : 2);
}

/** Rundet auf die Genauigkeit des Fortnite-Schiebereglers (0,1 %). */
export function roundSens(v) {
  return Math.max(LIMITS.sens[0], round(v, 1));
}

// ---------------------------------------------------------------- Fortnite-Werte

export const edpi = (dpi, sens) => (dpi * sens) / 100;
export const degPerCount = (sens) => sens * FN_YAW;
/** Zentimeter Mausweg für eine ganze Drehung (360°). */
export const cm360 = (dpi, sens) => (360 * CM_PER_INCH) / (dpi * sens * FN_YAW);
export const inch360 = (dpi, sens) => cm360(dpi, sens) / CM_PER_INCH;
/** Zielen (ADS) ist ein Prozent-Anteil der normalen Sensi. */
export const adsCm360 = (dpi, sens, targeting) => cm360(dpi, sens) / (targeting / 100);
export const scopeCm360 = (dpi, sens, scope) => cm360(dpi, sens) / (scope / 100);
/** Maus-Counts -> Grad Drehung bei der gegebenen Sensi. */
export const countsToDeg = (counts, sens) => counts * sens * FN_YAW;

/** Einordnung der eDPI im Vergleich zu den Profis. */
export function proCompare(e) {
  const P = PRO_EDPI;
  if (!Number.isFinite(e)) return { zone: 'unknown', label: 'unbekannt', type: '', text: '' };
  if (e < P.min) return { zone: 'far-below', label: 'sehr langsam', type: 'warn', text: `Langsamer als alle Profis in der Liste (die langsamsten liegen bei etwa ${P.min}).` };
  if (e < P.p25) return { zone: 'below', label: 'eher langsam', type: '', text: `Etwas langsamer als die meisten Profis. Typisch sind ${P.p25} bis ${P.p75}.` };
  if (e <= P.p75) return { zone: 'inside', label: 'im Profi-Bereich', type: 'ok', text: `Genau im typischen Bereich der Profis (${P.p25} bis ${P.p75}).` };
  if (e <= P.max) return { zone: 'above', label: 'eher schnell', type: '', text: `Etwas schneller als die meisten Profis. Typisch sind ${P.p25} bis ${P.p75}.` };
  return { zone: 'far-above', label: 'sehr schnell', type: 'warn', text: `Schneller als alle Profis in der Liste (die schnellsten liegen bei etwa ${P.max}).` };
}

/** Alle Werte, die live angezeigt werden. */
export function liveValues({ dpi, sens, targeting, scope }) {
  const e = edpi(dpi, sens);
  return {
    edpi: e,
    cm360: cm360(dpi, sens),
    inch360: inch360(dpi, sens),
    adsCm360: adsCm360(dpi, sens, targeting),
    scopeCm360: scopeCm360(dpi, sens, scope),
    pro: proCompare(e),
  };
}

const FIELD_TEXT = {
  dpi: 'Bitte eine ganze Zahl zwischen 50 und 32000 eingeben.',
  sens: 'Bitte einen Wert zwischen 0,1 und 100 eingeben.',
  targeting: 'Bitte einen Wert zwischen 1 und 200 eingeben.',
  scope: 'Bitte einen Wert zwischen 1 und 200 eingeben.',
};

/** Prüft die Eingaben. Gibt { ok, values, errors } zurück (Fehlertexte auf Deutsch). */
export function validateSettings(raw = {}) {
  const values = {};
  const errors = {};
  for (const key of Object.keys(LIMITS)) {
    const n = parseNum(raw[key]);
    const [lo, hi] = LIMITS[key];
    if (!Number.isFinite(n) || n < lo || n > hi) { errors[key] = FIELD_TEXT[key]; continue; }
    values[key] = key === 'dpi' ? Math.round(n) : round(n, 3);
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

// ---------------------------------------------------------------- Umrechner

/**
 * Grad pro Count je Einheit des Spielwerts. Werte aus den KovaaK-Konverterdaten.
 * decimals = Anzeige-Genauigkeit, integer = das Spiel nimmt nur ganze Zahlen.
 */
export const GAMES = [
  { id: 'cs2', name: 'Counter-Strike 2', yaw: 0.022, decimals: 3 },
  { id: 'valorant', name: 'Valorant', yaw: 0.07, decimals: 3 },
  { id: 'apex', name: 'Apex Legends', yaw: 0.022, decimals: 3 },
  { id: 'overwatch2', name: 'Overwatch 2', yaw: 0.0066, decimals: 2 },
  { id: 'cod', name: 'Call of Duty (MW3, Warzone, BO6)', yaw: 0.0066, decimals: 2, note: 'Gilt fürs normale Zielen ohne Visier.' },
  { id: 'r6', name: 'Rainbow Six Siege', yaw: 0.018 / Math.PI, decimals: 0, integer: true, note: 'Mit dem Standard-Multiplikator 0,02. Im Spiel nur ganze Zahlen.' },
  { id: 'thefinals', name: 'The Finals', yaw: 0.001, decimals: 1 },
  { id: 'marvelrivals', name: 'Marvel Rivals', yaw: 0.0175, decimals: 2 },
  { id: 'pubg', name: 'PUBG', kind: 'pubg', decimals: 0, integer: true, note: 'Hängt vom Sichtfeld (FOV) ab. Im Spiel nur ganze Zahlen.' },
];

export const PUBG_DEFAULT_FOV = 80;

export function findGame(id) {
  return GAMES.find((g) => g.id === id) || null;
}

/** Grad pro Count im anderen Spiel für dessen Wert. */
export function gameDegPerCount(game, value, { fov = PUBG_DEFAULT_FOV } = {}) {
  if (game.kind === 'pubg') return 0.00005555 * 10 ** (value / 50) * fov;
  return value * game.yaw;
}

/** Spielwert, der zu "Grad pro Count" passt. */
export function gameValueFromDegPerCount(game, dpc, { fov = PUBG_DEFAULT_FOV } = {}) {
  if (!(dpc > 0)) return NaN;
  if (game.kind === 'pubg') return 50 * Math.log10(dpc / (0.00005555 * fov));
  return dpc / game.yaw;
}

/**
 * Fortnite -> anderes Spiel. Gleiche Drehung pro Zentimeter Mausweg.
 * targetDpi = DPI, die im anderen Spiel benutzt wird (Standard: gleiche DPI).
 */
export function fortniteToGame(gameId, { sens, dpi, targetDpi = dpi, fov } = {}) {
  const game = typeof gameId === 'string' ? findGame(gameId) : gameId;
  if (!game) return NaN;
  const degPerInch = dpi * sens * FN_YAW;
  return gameValueFromDegPerCount(game, degPerInch / targetDpi, { fov });
}

/** Anderes Spiel -> Fortnite-Sensi in %. */
export function gameToFortnite(gameId, { value, gameDpi, dpi = gameDpi, fov } = {}) {
  const game = typeof gameId === 'string' ? findGame(gameId) : gameId;
  if (!game) return NaN;
  const degPerInch = gameDegPerCount(game, value, { fov }) * gameDpi;
  return degPerInch / (dpi * FN_YAW);
}

/** Anzeige eines Spielwerts mit der passenden Genauigkeit. */
export function fmtGameValue(game, value) {
  if (!Number.isFinite(value)) return '–';
  return fmtNum(value, game.decimals);
}

// ---------------------------------------------------------------- Blickrichtung & Projektion

/** Einheitsvektor für Blickrichtung (yaw rechts positiv, pitch oben positiv). */
export function dirVec(yaw, pitch) {
  const cp = Math.cos(pitch * RAD);
  return [cp * Math.sin(yaw * RAD), Math.sin(pitch * RAD), cp * Math.cos(yaw * RAD)];
}

/** Achsen der Kamera: f = vorne, r = rechts, u = oben. */
export function cameraBasis(yaw, pitch) {
  const sy = Math.sin(yaw * RAD); const cy = Math.cos(yaw * RAD);
  const sp = Math.sin(pitch * RAD); const cp = Math.cos(pitch * RAD);
  return { f: [cp * sy, sp, cp * cy], r: [cy, 0, -sy], u: [-sp * sy, cp, -sp * cy] };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Weltvektor -> Kamerakoordinaten [rechts, oben, vorne]. */
export function toCamera(v, basis) {
  return [dot(v, basis.r), dot(v, basis.u), dot(v, basis.f)];
}

/** Brennweite in Pixeln, so dass die Bildhöhe dem vertikalen Sichtfeld entspricht (Fortnite: Hor+). */
export function focalPx(heightPx, vfovDeg = VFOV_DEG) {
  return heightPx / 2 / Math.tan((vfovDeg / 2) * RAD);
}

/** Horizontales Sichtfeld für ein Seitenverhältnis bei festem vertikalem Sichtfeld. */
export function hfovForAspect(aspect, vfovDeg = VFOV_DEG) {
  return (2 * Math.atan(Math.tan((vfovDeg / 2) * RAD) * aspect)) / RAD;
}

/** Kamerapunkt -> Bildschirm. null, wenn hinter der Kamera. */
export function projectCam(c, w, h, f) {
  if (c[2] <= 1e-6) return null;
  return { x: w / 2 + (f * c[0]) / c[2], y: h / 2 - (f * c[1]) / c[2] };
}

/** Richtung (yaw/pitch) -> Bildschirmpunkt für eine Kamera {yaw, pitch}. */
export function projectDir(yaw, pitch, cam, w, h, f = focalPx(h)) {
  return projectCam(toCamera(dirVec(yaw, pitch), cameraBasis(cam.yaw, cam.pitch)), w, h, f);
}

/** Winkel in Grad zwischen zwei Blickrichtungen. */
export function angDist(a, b) {
  const d = dot(dirVec(a.yaw, a.pitch), dirVec(b.yaw, b.pitch));
  return Math.acos(clamp(d, -1, 1)) / RAD;
}

/** Winkel auf -180 … 180 bringen. */
export function wrapDeg(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Mausbewegung (Counts) auf die Kamera anwenden. Maus nach unten = nach unten schauen. */
export function applyMovement(cam, dx, dy, sens) {
  const k = sens * FN_YAW;
  return { yaw: wrapDeg(cam.yaw + dx * k), pitch: clamp(cam.pitch - dy * k, -85, 85) };
}

/** Größte 16:9-Fläche, die in w×h passt. */
export function fit169(w, h) {
  const W = Math.max(0, w); const H = Math.max(0, h);
  if (W / 16 * 9 <= H) return { w: Math.floor(W), h: Math.floor((W / 16) * 9) };
  return { w: Math.floor((H / 9) * 16), h: Math.floor(H) };
}

// ---------------------------------------------------------------- Testablauf

/** Dauer der Runden pro getesteter Sensi (ms): Kurz ≈ 15 s, Normal ≈ 30 s. */
export const ROUND_TIMES = {
  short: { flick: 6000, tracking: 4000, moving: 5000 },
  normal: { flick: 12000, tracking: 8000, moving: 10000 },
};
export const LEAD_IN_MS = 1200; // Ansage vor jeder Runde (zählt nicht)
export const INTERLUDE_MS = 1500; // kurze Pause zwischen zwei Sensis
export const WARMUP_MS = { short: 6000, normal: 8000 };
export const ROUND_TYPES = ['flick', 'tracking', 'moving'];

/** Kleiner, reproduzierbarer Zufallsgenerator (für Tests und gemischte Reihenfolge). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Faktoren um die eigene Sensi, z. B. spread 0.2 -> 0.8, 0.9, 1.0, 1.1, 1.2 */
export function multipliers(spread = 0.2, steps = 5) {
  const n = Math.max(2, Math.round(steps));
  const out = [];
  for (let i = 0; i < n; i++) out.push(round(1 - spread + (2 * spread * i) / (n - 1), 3));
  return out;
}

/**
 * Getestete Sensis: auf 0,1 % gerundet (so kann man sie in Fortnite auch einstellen).
 * Ergibt das Runden doppelte Werte (sehr kleine Sensi), bleiben die genauen Werte.
 */
export function testedSens(baseSens, spread = 0.2, steps = 5) {
  const mults = multipliers(spread, steps);
  const rounded = mults.map((m) => roundSens(baseSens * m));
  if (new Set(rounded).size === rounded.length && rounded.every((v) => v > 0)) {
    return rounded.map((sens) => ({ mult: round(sens / baseSens, 4), sens }));
  }
  return mults.map((mult) => ({ mult, sens: baseSens * mult }));
}

/** DPI-Liste ohne Doppelte, aktuelle DPI zuerst. */
export function uniqueDpis(baseDpi, extra = []) {
  const out = [];
  for (const v of [baseDpi, ...extra]) {
    const n = Math.round(parseNum(v));
    if (!Number.isFinite(n) || n < LIMITS.dpi[0] || n > LIMITS.dpi[1]) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Baut den Ablauf eines Tests.
 * mode 'sens': mehrere Sensis (gemischt, verdeckt) mit gleicher DPI.
 * mode 'dpi':  verschiedene DPI-Werte, die eDPI bleibt gleich (Sensi wird angepasst). Reihenfolge A-B-B-A.
 */
export function buildPlan({ mode = 'sens', settings, length = 'short', spread = 0.2, dpis = [], rng = Math.random } = {}) {
  const times = ROUND_TIMES[length] || ROUND_TIMES.short;
  const len = ROUND_TIMES[length] ? length : 'short';
  const rounds = () => ROUND_TYPES.map((type) => ({ type, durationMs: times[type] }));
  const baseDpi = settings.dpi;
  const baseSens = settings.sens;
  let blocks;
  if (mode === 'dpi') {
    const list = uniqueDpis(baseDpi, dpis);
    if (list.length < 2) throw new Error('Für den DPI-Vergleich brauchst du mindestens zwei verschiedene DPI-Werte.');
    const baseEdpi = edpi(baseDpi, baseSens);
    const seq = [...list, ...list.slice().reverse()];
    blocks = seq.map((dpi, i) => ({
      index: i, mult: 1, dpi, sens: (baseEdpi * 100) / dpi,
      needsSwitch: dpi !== (i ? seq[i - 1] : baseDpi), rounds: rounds(),
    }));
  } else {
    blocks = shuffle(testedSens(baseSens, spread), rng).map(({ mult, sens }, i) => ({
      index: i, mult, dpi: baseDpi, sens, needsSwitch: false, rounds: rounds(),
    }));
  }
  const first = blocks[0];
  const warmup = {
    warmup: true, index: -1, mult: 1, dpi: first.dpi, sens: mode === 'dpi' ? first.sens : baseSens,
    needsSwitch: first.needsSwitch, rounds: [{ type: 'flick', durationMs: WARMUP_MS[len] }],
  };
  if (warmup.needsSwitch) first.needsSwitch = false;
  return { mode: mode === 'dpi' ? 'dpi' : 'sens', length: len, spread, baseDpi, baseSens, warmup, blocks };
}

/** Ungefähre Dauer eines Plans in Sekunden. */
export function planDurationSec(plan) {
  const all = [plan.warmup, ...plan.blocks];
  let ms = 0;
  for (const b of all) for (const r of b.rounds) ms += r.durationMs + LEAD_IN_MS;
  ms += plan.blocks.length * INTERLUDE_MS;
  return Math.round(ms / 1000);
}

// ---------------------------------------------------------------- Bewertung

export const SCORE = {
  flick: { ttkGood: 450, ttkBad: 1500, hpmRef: 90, w: { acc: 0.4, ttk: 0.3, hpm: 0.15, control: 0.15 } },
  moving: { ttkGood: 550, ttkBad: 1800, hpmRef: 70, w: { acc: 0.45, ttk: 0.3, hpm: 0.25 } },
  block: { flick: 0.4, tracking: 0.3, moving: 0.3 },
};

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

/** 1 = sehr schnell getroffen, 0 = zu langsam. */
export function ttkScore(ms, good, bad) {
  if (!Number.isFinite(ms)) return 0;
  return clamp01((bad - ms) / (bad - good));
}

function accuracyOf(s) {
  const shots = (s.hits || 0) + (s.misses || 0);
  return shots ? s.hits / shots : 0;
}

function hpmOf(s) {
  return s.liveMs > 0 ? (s.hits || 0) / (s.liveMs / 60000) : 0;
}

/**
 * Punkte (0–100) für eine einzelne Runde.
 * Flicks: Genauigkeit, Zeit bis Treffer, Treffer pro Minute, Kontrolle (wenig Über-/Unterziehen).
 * Tracking: Anteil der Zeit auf dem Ziel. Bewegte Ziele: Genauigkeit, Zeit, Treffer pro Minute.
 */
export function scoreRound(s) {
  if (!s) return 0;
  if (s.type === 'tracking') return s.measuredMs > 0 ? round(100 * clamp01(s.onTargetMs / s.measuredMs), 2) : 0;
  const cfg = SCORE[s.type === 'moving' ? 'moving' : 'flick'];
  const acc = accuracyOf(s);
  const ttk = ttkScore(mean(s.ttks || []), cfg.ttkGood, cfg.ttkBad);
  const hpm = clamp01(hpmOf(s) / cfg.hpmRef);
  let v = cfg.w.acc * acc + cfg.w.ttk * ttk + cfg.w.hpm * hpm;
  if (s.type !== 'moving') {
    const control = s.flicks ? 1 - clamp01(((s.over || 0) + (s.under || 0)) / s.flicks) : 0;
    v += cfg.w.control * control;
  }
  return round(100 * clamp01(v), 2);
}

/** Fasst die drei Runden einer getesteten Sensi zusammen. */
export function aggregateBlock(statsList = []) {
  let hits = 0; let misses = 0; let ttkSum = 0; let ttkCount = 0; let liveMs = 0;
  let over = 0; let under = 0; let flicks = 0;
  let trackOn = 0; let trackMs = 0;
  const roundScores = {};
  let wSum = 0; let sSum = 0;
  for (const s of statsList) {
    const sc = scoreRound(s);
    roundScores[s.type] = sc;
    const w = SCORE.block[s.type] ?? 0;
    wSum += w; sSum += w * sc;
    if (s.type === 'tracking') { trackOn += s.onTargetMs || 0; trackMs += s.measuredMs || 0; continue; }
    hits += s.hits || 0; misses += s.misses || 0; liveMs += s.liveMs || 0;
    for (const t of s.ttks || []) { ttkSum += t; ttkCount++; }
    if (s.type === 'flick') { over += s.over || 0; under += s.under || 0; flicks += s.flicks || 0; }
  }
  const shots = hits + misses;
  return {
    hits, misses,
    accuracy: shots ? round((100 * hits) / shots, 1) : 0,
    hitsPerMin: liveMs ? round(hits / (liveMs / 60000), 1) : 0,
    avgTtkMs: ttkCount ? Math.round(ttkSum / ttkCount) : null,
    ttkSum, ttkCount,
    trackingPct: trackMs ? round((100 * trackOn) / trackMs, 1) : null,
    overshoot: flicks ? round(over / flicks, 3) : null,
    undershoot: flicks ? round(under / flicks, 3) : null,
    flicks,
    score: wSum ? round(sSum / wSum, 1) : 0,
    roundScores,
  };
}

/**
 * Parabel y = a·x² + b·x + c nach der Methode der kleinsten Quadrate.
 * Rückgabe { a, b, c, r2, vertex, predict } oder null (zu wenige/gleiche Punkte).
 */
export function fitParabola(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p.x));
  let S1 = 0; let S2 = 0; let S3 = 0; let S4 = 0; let T0 = 0; let T1 = 0; let T2 = 0;
  const S0 = pts.length;
  for (const p of pts) {
    const x = p.x - mx; const x2 = x * x;
    S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
    T0 += p.y; T1 += x * p.y; T2 += x2 * p.y;
  }
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[S4, S3, S2], [S3, S2, S1], [S2, S1, S0]];
  const D = det3(M);
  if (Math.abs(D) < 1e-12) return null;
  const col = (i) => M.map((row, r) => row.map((v, c) => (c === i ? [T2, T1, T0][r] : v)));
  const a = det3(col(0)) / D;
  const bc = det3(col(1)) / D; // b für zentriertes x
  const cc = det3(col(2)) / D;
  const predict = (x) => a * (x - mx) ** 2 + bc * (x - mx) + cc;
  const my = T0 / S0;
  let ssTot = 0; let ssRes = 0;
  for (const p of pts) { ssTot += (p.y - my) ** 2; ssRes += (p.y - predict(p.x)) ** 2; }
  const r2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;
  // zurück in normale Koordinaten
  const b = bc - 2 * a * mx;
  const c = a * mx * mx - bc * mx + cc;
  const vertex = Math.abs(a) > 1e-12 ? mx - bc / (2 * a) : null;
  return { a, b, c, r2, vertex, predict };
}

/**
 * Scheitel einer Parabel durch drei Punkte (der mittlere ist der beste).
 * Liegt immer zwischen den beiden äußeren Punkten.
 */
export function peak3(p0, p1, p2) {
  const x0 = p0.mult ?? p0.x; const x1 = p1.mult ?? p1.x; const x2 = p2.mult ?? p2.x;
  const y0 = p0.score ?? p0.y; const y1 = p1.score ?? p1.y; const y2 = p2.score ?? p2.y;
  const d = (x0 - x1) * (x0 - x2) * (x1 - x2);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return NaN;
  const A = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d;
  const B = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d;
  if (!(A < 0)) return x1;
  return clamp(-B / (2 * A), Math.min(x0, x2), Math.max(x0, x2));
}

/**
 * Gleichgewichtspunkt von Überziehen und Zu-kurz-Zielen über die getesteten Faktoren.
 * groups: [{ mult, overshoot, undershoot }] nach mult sortiert.
 * Rückgabe { mult, trend } oder null. trend = wie stark das Überziehen mit der Sensi zunimmt (0 … 2).
 */
export function balancePoint(groups) {
  const pts = groups.filter((g) => Number.isFinite(g.overshoot) && Number.isFinite(g.undershoot))
    .map((g) => ({ x: g.mult, d: g.overshoot - g.undershoot }));
  if (pts.length < 2) return null;
  const trend = pts[pts.length - 1].d - pts[0].d;
  if (!(trend > 0)) return null;
  let found = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]; const b = pts[i + 1];
    if (a.d <= 0 && b.d > 0) {
      const x = a.d === b.d ? a.x : a.x + ((b.x - a.x) * (0 - a.d)) / (b.d - a.d);
      if (!found || Math.abs(x - 1) < Math.abs(found - 1)) found = x;
    }
  }
  return found == null ? null : { mult: found, trend };
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

const avgOf = (items, key) => {
  const vals = items.map((x) => x[key]).filter((v) => Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
};

/** Unter diesen Punkten (bester Durchgang) ist das Ergebnis Zufall – dann keine Empfehlung. */
export const MIN_USEFUL_SCORE = 20;
const TOO_FEW = 'Es gab zu wenige Treffer für eine Empfehlung.';

const RAW_HINT = 'Der Test lief im normalen Mausmodus. Dabei kann die Mausbeschleunigung von Windows mitwirken. Prüfe im Maus-Check, ob sie aus ist.';

/**
 * Empfehlung im Sensi-Modus.
 * blocks: [{ mult, sens, score, overshoot, undershoot }]
 * Parabel über Faktor -> Punkte; Notlösung: bester gemessener Wert. Immer innerhalb des getesteten Bereichs.
 */
export function recommend({ blocks = [], baseSens, dpi, rawInput = true } = {}) {
  const groups = [...groupBy(blocks.filter((b) => Number.isFinite(b.mult) && Number.isFinite(b.score)), (b) => round(b.mult, 3)).entries()]
    .map(([mult, items]) => ({ mult, score: avgOf(items, 'score'), overshoot: avgOf(items, 'overshoot'), undershoot: avgOf(items, 'undershoot') }))
    .sort((x, y) => x.mult - y.mult);
  if (!groups.length || !Number.isFinite(baseSens)) return null;
  if (Math.max(...groups.map((g) => g.score)) < MIN_USEFUL_SCORE) {
    const keep = roundSens(baseSens);
    return {
      mode: 'sens', mult: 1, sens: keep, dpi,
      edpi: Number.isFinite(dpi) ? edpi(dpi, keep) : null,
      cm360: Number.isFinite(dpi) ? cm360(dpi, keep) : null,
      method: 'zuwenig', edge: false, confidence: 'niedrig', r2: null, bestMult: null, balanceMult: null,
      lines: [TOO_FEW, 'Bleib erst einmal bei deiner jetzigen Sensi und mach den Test noch einmal in Ruhe.', ...(rawInput ? [] : [RAW_HINT])],
    };
  }
  const lo = groups[0].mult; const hi = groups[groups.length - 1].mult;
  const bi = groups.reduce((m, g, i) => (g.score > groups[m].score ? i : m), 0);
  const best = groups[bi];
  const interior = bi > 0 && bi < groups.length - 1;
  // Das Optimum liegt zwischen den Nachbarn des besten gemessenen Werts – nie weiter weg.
  const nLo = groups[Math.max(0, bi - 1)].mult;
  const nHi = groups[Math.min(groups.length - 1, bi + 1)].mult;
  let mult = best.mult;
  let method = 'bester';
  let fit = null;
  if (groups.length >= 3) {
    fit = fitParabola(groups.map((g) => ({ x: g.mult, y: g.score })));
    if (fit && fit.a < 0 && fit.r2 >= 0.25 && Number.isFinite(fit.vertex) && fit.vertex >= nLo && fit.vertex <= nHi) {
      mult = fit.vertex; method = 'parabel';
    } else if (interior) {
      const v = peak3(groups[bi - 1], best, groups[bi + 1]);
      if (Number.isFinite(v)) { mult = v; method = 'nachbarn'; }
    }
  }
  // Zweites Signal aus den Flicks: Wo halten sich "drüber" und "zu kurz" die Waage?
  // Viel Überziehen = zu schnell, viel zu kurz = zu langsam. Je klarer der Trend, desto mehr Gewicht.
  const bal = balancePoint(groups);
  if (bal) {
    const w = 0.5 * clamp01((bal.trend - 0.2) / 0.8);
    mult = clamp((1 - w) * mult + w * bal.mult, nLo, nHi);
  }
  mult = clamp(mult, lo, hi);
  const edge = groups.length >= 3 && !interior;
  const sens = roundSens(baseSens * mult);
  const scores = groups.map((g) => g.score);
  const spread = Math.max(...scores) - Math.min(...scores);
  let confidence = 'mittel';
  if (spread < 5) confidence = 'niedrig';
  else if (method === 'parabel' && fit && fit.r2 >= 0.6 && spread >= 8) confidence = 'hoch';
  if (edge && confidence === 'hoch') confidence = 'mittel';

  const lines = [`Du hast mit ${fmtSens(sens)} % am besten getroffen.`];
  const higher = groups.filter((g) => g.mult > mult + 0.02);
  const lower = groups.filter((g) => g.mult < mult - 0.02);
  const hiOver = avgOf(higher, 'overshoot');
  const loOver = avgOf(lower, 'overshoot');
  const loUnder = avgOf(lower, 'undershoot');
  const hiUnder = avgOf(higher, 'undershoot');
  if (hiOver != null && hiOver >= 0.25 && hiOver >= (loOver ?? 0) + 0.1) lines.push('Bei höheren Werten bist du oft über das Ziel hinausgeschossen.');
  if (loUnder != null && loUnder >= 0.25 && loUnder >= (hiUnder ?? 0) + 0.1) lines.push('Bei niedrigeren Werten hast du oft zu kurz gezielt.');
  if (lines.length === 1 && confidence !== 'niedrig') lines.push('Bei diesem Wert haben Treffer, Tempo und Tracking zusammen am besten gepasst.');
  const base1 = round(baseSens, 1);
  if (Math.abs(sens - base1) < 0.05) lines.push('Das ist deine jetzige Sensi. Sie passt also schon gut.');
  else {
    const rel = sens / baseSens - 1;
    const word = Math.abs(rel) >= 0.12 ? 'deutlich' : 'etwas';
    lines.push(`Das ist ${word} ${rel > 0 ? 'schneller' : 'langsamer'} als deine jetzige Sensi (${fmtSens(baseSens)} %).`);
  }
  if (edge) lines.push(`Dein bester Wert lag am Rand des Tests. Mach den Test am besten noch einmal mit ${fmtSens(sens)} % als Startwert.`);
  if (confidence === 'niedrig') lines.push('Die Unterschiede zwischen den Werten waren klein. Du kommst mit allen ähnlich gut klar.');
  if (!rawInput) lines.push(RAW_HINT);

  return {
    mode: 'sens', mult: round(mult, 4), sens, dpi,
    edpi: Number.isFinite(dpi) ? edpi(dpi, sens) : null,
    cm360: Number.isFinite(dpi) ? cm360(dpi, sens) : null,
    method, edge, confidence, r2: fit ? round(fit.r2, 3) : null, bestMult: best.mult,
    balanceMult: bal ? round(bal.mult, 4) : null, lines,
  };
}

/**
 * Empfehlung im DPI-Modus. blocks: [{ dpi, sens, score }]. Die eDPI bleibt gleich.
 */
export function recommendDpi({ blocks = [], baseDpi, baseSens, rawInput = true } = {}) {
  const groups = [...groupBy(blocks.filter((b) => Number.isFinite(b.dpi) && Number.isFinite(b.score)), (b) => b.dpi).entries()]
    .map(([dpi, items]) => ({ dpi, score: avgOf(items, 'score') }))
    .sort((x, y) => x.dpi - y.dpi);
  if (groups.length < 1) return null;
  const best = groups.reduce((m, g) => (g.score > m.score ? g : m), groups[0]);
  const base = groups.find((g) => g.dpi === baseDpi) || null;
  const baseEdpi = edpi(baseDpi, baseSens);
  if (best.score < MIN_USEFUL_SCORE) {
    const keep = round(baseSens, 2);
    return {
      mode: 'dpi', mult: 1, dpi: baseDpi, sens: keep, edpi: edpi(baseDpi, keep), cm360: cm360(baseDpi, keep),
      method: 'zuwenig', edge: false, confidence: 'niedrig', r2: null, bestDpi: null,
      lines: [TOO_FEW, `Bleib erst einmal bei ${baseDpi} DPI und mach den Vergleich noch einmal in Ruhe.`, ...(rawInput ? [] : [RAW_HINT])],
    };
  }
  const lines = [];
  let dpi = baseDpi;
  let sens = round(baseSens, 2);
  const diff = base ? best.score - base.score : Infinity;
  const scores = groups.map((g) => g.score);
  const spread = Math.max(...scores) - Math.min(...scores);
  let confidence = spread < 3 ? 'niedrig' : spread >= 8 ? 'hoch' : 'mittel';
  if (best.dpi === baseDpi) {
    lines.push(spread < 3
      ? `Kaum Unterschied zwischen den DPI-Werten. Bleib bei ${baseDpi} DPI – oder nimm, was sich besser anfühlt.`
      : `Mit deinen jetzigen ${baseDpi} DPI hast du am besten getroffen. Bleib dabei.`);
  } else if (diff < 3) {
    confidence = 'niedrig';
    lines.push(`Kaum Unterschied zwischen den DPI-Werten. Bleib bei ${baseDpi} DPI – oder nimm, was sich besser anfühlt.`);
  } else {
    dpi = best.dpi;
    sens = roundSens((baseEdpi * 100) / dpi);
    const e = edpi(dpi, sens);
    lines.push(`Mit ${dpi} DPI hast du am besten getroffen.`);
    lines.push(`Stell dann in Fortnite ${fmtSens(sens)} % ein. So bleibt eine Drehung gleich weit (eDPI ${fmtNum(e, 0)}).`);
    if (Math.abs(e - baseEdpi) >= 0.5) lines.push('Fortnite kann nur 0,1-%-Schritte. Deshalb ändert sich die eDPI ein kleines bisschen.');
  }
  if (!rawInput) lines.push(RAW_HINT);
  return { mode: 'dpi', mult: 1, dpi, sens, edpi: edpi(dpi, sens), cm360: cm360(dpi, sens), method: 'dpi', edge: false, confidence, r2: null, bestDpi: best.dpi, lines };
}

/**
 * DPI-Modus, Ergebnis: Was muss der Spieler an der Maus umstellen?
 * mouseDpi: worauf die Maus jetzt steht (nach dem Test meist wieder die eigene DPI).
 * Nie "zurückstellen" sagen, wenn die Maus schon richtig steht – mit einer DPI-Taste, die durchschaltet, landet man sonst woanders.
 */
export function dpiResultHint({ recDpi, baseDpi, mouseDpi }) {
  if (recDpi === mouseDpi) return `Deine Maus steht schon ${mouseDpi === baseDpi ? 'wieder' : 'richtig'} auf ${mouseDpi} DPI. Du musst an der Maus nichts umstellen.`;
  if (recDpi === baseDpi) return `Deine Maus steht noch auf ${mouseDpi} DPI. Stell sie wieder auf ${baseDpi} DPI zurück.`;
  if (mouseDpi === baseDpi) return `Deine Maus steht jetzt wieder auf ${baseDpi} DPI. Für die Empfehlung stellst du sie auf ${recDpi} DPI um. Bleibst du bei ${baseDpi} DPI, musst du an der Maus nichts umstellen.`;
  return `Deine Maus steht jetzt auf ${mouseDpi} DPI. Für die Empfehlung stellst du sie auf ${recDpi} DPI um, sonst wieder auf ${baseDpi} DPI.`;
}

/**
 * DPI-Modus, Abbruch: Hinweis, die Maus wieder auf die eigene DPI zu stellen ('' = nichts zu tun).
 * switchDpi: worauf HELIX gerade umstellen lassen wollte (null, wenn gerade nicht gefragt). Ob der Spieler
 * das schon gemacht hat, weiß HELIX dann nicht – deshalb fragt der Text nach.
 */
export function dpiAbortHint({ baseDpi, mouseDpi, switchDpi = null }) {
  const asked = Number.isFinite(switchDpi) && switchDpi !== mouseDpi;
  if (!asked) return mouseDpi === baseDpi ? '' : `Deine Maus steht noch auf ${mouseDpi} DPI. Stell sie wieder auf ${baseDpi} DPI zurück.`;
  if (switchDpi === baseDpi) return `Steht deine Maus noch auf ${mouseDpi} DPI? Dann stell sie wieder auf ${baseDpi} DPI zurück.`;
  if (mouseDpi === baseDpi) return `Hast du die Maus schon auf ${switchDpi} DPI umgestellt? Dann stell sie wieder auf ${baseDpi} DPI zurück.`;
  return `Stell deine Maus wieder auf ${baseDpi} DPI zurück.`;
}

// ---------------------------------------------------------------- Verlauf

/**
 * Baut einen Verlaufseintrag (Form siehe Tool-Vertrag 'tool-sensi').
 * blockResults: [{ block, agg }] (agg aus aggregateBlock)
 */
export function buildHistoryEntry({ plan, blockResults, rec, rawInput = true, at = Date.now() }) {
  const pick = (block, agg) => ({
    mult: round(block.mult, 3),
    sens: round(block.sens, 3),
    score: agg.score,
    accuracy: agg.accuracy,
    hits: agg.hits,
    misses: agg.misses,
    trackingPct: agg.trackingPct,
    avgTtkMs: agg.avgTtkMs,
    overshoot: agg.overshoot,
    undershoot: agg.undershoot,
  });
  let rounds;
  if (plan.mode === 'dpi') {
    rounds = [...groupBy(blockResults, (r) => r.block.dpi).entries()].map(([dpi, list]) => {
      const hits = list.reduce((n, r) => n + r.agg.hits, 0);
      const misses = list.reduce((n, r) => n + r.agg.misses, 0);
      const ttkSum = list.reduce((n, r) => n + (r.agg.ttkSum || 0), 0);
      const ttkCount = list.reduce((n, r) => n + (r.agg.ttkCount || 0), 0);
      const aggs = list.map((r) => r.agg);
      return {
        mult: 1,
        sens: round(list[0].block.sens, 3),
        dpi,
        score: round(avgOf(aggs, 'score') ?? 0, 1),
        accuracy: hits + misses ? round((100 * hits) / (hits + misses), 1) : 0,
        hits, misses,
        trackingPct: avgOf(aggs, 'trackingPct') == null ? null : round(avgOf(aggs, 'trackingPct'), 1),
        avgTtkMs: ttkCount ? Math.round(ttkSum / ttkCount) : null,
        overshoot: avgOf(aggs, 'overshoot') == null ? null : round(avgOf(aggs, 'overshoot'), 3),
        undershoot: avgOf(aggs, 'undershoot') == null ? null : round(avgOf(aggs, 'undershoot'), 3),
      };
    }).sort((a, b) => a.dpi - b.dpi);
  } else {
    rounds = blockResults.map((r) => pick(r.block, r.agg)).sort((a, b) => a.mult - b.mult);
  }
  const aggs = blockResults.map((r) => r.agg);
  const hits = aggs.reduce((n, a) => n + a.hits, 0);
  const misses = aggs.reduce((n, a) => n + a.misses, 0);
  const ttkSum = aggs.reduce((n, a) => n + (a.ttkSum || 0), 0);
  const ttkCount = aggs.reduce((n, a) => n + (a.ttkCount || 0), 0);
  const recDpi = rec?.dpi ?? plan.baseDpi;
  const recSens = rec?.sens ?? round(plan.baseSens, 1);
  const track = avgOf(aggs, 'trackingPct');
  return {
    at,
    dpi: plan.baseDpi,
    sens: plan.baseSens,
    recommendedSens: recSens,
    edpi: round(edpi(recDpi, recSens), 1),
    cm360: round(cm360(recDpi, recSens), 1),
    score: round(avgOf(aggs, 'score') ?? 0, 1),
    accuracy: hits + misses ? round((100 * hits) / (hits + misses), 1) : 0,
    hits,
    misses,
    trackingPct: track == null ? null : round(track, 1),
    avgTtkMs: ttkCount ? Math.round(ttkSum / ttkCount) : null,
    rounds,
    // Zusatzangaben (für die Detailansicht)
    mode: plan.mode,
    length: plan.length,
    recommendedDpi: recDpi,
    rawInput: !!rawInput,
    method: rec?.method ?? null,
    confidence: rec?.confidence ?? null,
    lines: rec?.lines ?? [],
  };
}
