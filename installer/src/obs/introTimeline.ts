/**
 * Zeitachse des Intros (Spec D.2, D.5, D.6), rein. Bild und Ton lesen dieselbe Tabelle:
 * `introEvents(variant)` für die Klang-Partitur, `introStateAt(t, variant)` für das Bild.
 * Zeiten in ms ab dem ersten Bild.
 */
import type { IntroVariant } from "./types";

export type { IntroVariant } from "./types";

/** Periode von CP 1919 in ms – Abstand der zwei Echtzeit-Pulse */
export const PULSE_MS = 1337.3;
export const F_LOCK = 0.7478;
/** Zeitraffer: d_i = 150·r^(i−1), r = (1/3)^(1/13), i = 1…14 (150 → 50 ms) */
export const TIMELAPSE_R = Math.pow(1 / 3, 1 / 13);
export const TIMELAPSE_GAPS: number[] = Array.from({ length: 14 }, (_, i) => 150 * TIMELAPSE_R ** i);

const LOCK_MS = 1150;
const ROW_WRITE_MS = 160;
const FOLD_MS = 3900;
const ACQUIRED_MS = 4500;
const EXIT_MS = 5300;
const EXIT_DUR_MS = 300;

/** Spitzenzeiten der 16 Zeilen in der Vollfassung: 1150, 2487,3, 2637,3 … 3771,3 */
export const ROW_PULSE_TIMES: number[] = (() => {
  const t = [LOCK_MS, LOCK_MS + PULSE_MS];
  for (const d of TIMELAPSE_GAPS) t.push(t[t.length - 1] + d);
  return t;
})();

/** Zeitraffer-Faktor der Zeile i (1…16): 1 für die Echtzeit-Zeilen, sonst 1337,3/d */
export function rowFactor(i: number): number {
  return i <= 2 ? 1 : PULSE_MS / TIMELAPSE_GAPS[i - 3];
}

/** Schreibfenster der Zeile i: Dauer 160/Faktor ms, Mitte = Puls */
export function rowWriteWindow(i: number): [number, number] {
  const half = ROW_WRITE_MS / 2 / rowFactor(i);
  const p = ROW_PULSE_TIMES[i - 1];
  return [p - half, p + half];
}

/** Pegel je Puls: a(f) = min(1, √(4/f)) */
const pulseAmp = (f: number) => Math.min(1, Math.sqrt(4 / f));
export function rowPulseGainDb(i: number): number {
  if (i <= 2) return -14;
  return -14 + 20 * Math.log10(pulseAmp(1000 / TIMELAPSE_GAPS[i - 3]));
}

/** Bandpass-Mitte zur Nadel: fc = 300·8^(log(f/0,25)/log 16) Hz */
export function bandpassHz(f: number): number {
  return 300 * Math.pow(8, Math.log(f / 0.25) / Math.log(16));
}

/** Tuner: log2 von 0,25–4 Hz auf x 200–780 (145 px pro Oktave) */
export function tunerX(f: number): number {
  return 200 + 145 * Math.log2(f / 0.25);
}

/* ── Kurven ─────────────────────────────────────────────── */
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
export const easeInOutCubic = (u: number) => {
  const x = clamp01(u);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
const easeOutCubic = (u: number) => 1 - (1 - clamp01(u)) ** 3;

/** CSS-cubic-bezier als Funktion u → y */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const bx = (s: number) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
  const by = (s: number) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  return (u) => {
    const x = clamp01(u);
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}
const searchEase = cubicBezier(0.45, 0, 0.2, 1);

/** Nadel-Keyframes der Suche (ms, Hz) */
export const NEEDLE_KEYS: [number, number][] = [[300, 0.4], [560, 2.6], [780, 0.52], [940, 1.05], [1060, 0.66], [LOCK_MS, F_LOCK]];

/* ── Zeiten je Variante ─────────────────────────────────── */
export interface IntroTimings {
  lockAt: number;
  foldAt: number;
  /** Dauer der Faltung (Voll: 600 ms) */
  foldDur: number;
  acquiredAt: number;
  exitAt: number;
  exitDur: number;
  endAt: number;
  finalAt: number;
}

export function introTimings(v: IntroVariant): IntroTimings {
  switch (v) {
    case "full":
      return { lockAt: LOCK_MS, foldAt: FOLD_MS, foldDur: 600, acquiredAt: ACQUIRED_MS, exitAt: EXIT_MS, exitDur: EXIT_DUR_MS, endAt: EXIT_MS + EXIT_DUR_MS, finalAt: ACQUIRED_MS };
    case "short":
      return { lockAt: 300, foldAt: 350, foldDur: 400, acquiredAt: 750, exitAt: 1050, exitDur: 300, endAt: 1350, finalAt: 750 };
    case "reduced":
      return { lockAt: 0, foldAt: 900, foldDur: 200, acquiredAt: 900, exitAt: 1800, exitDur: 200, endAt: 2000, finalAt: 300 + PULSE_MS };
    case "reducedShort":
      return { lockAt: 0, foldAt: 0, foldDur: 0, acquiredAt: 0, exitAt: 800, exitDur: 200, endAt: 1000, finalAt: 200 };
  }
}

/* ── Ereignisse (Ton) ───────────────────────────────────── */
export type IntroEventKind =
  | "noise-in" // Rauschbett ein (−34 dBFS, Suchfilter)
  | "search" // Bandpass folgt der Nadel (durMs)
  | "lock" // Rauschbett → −44 dBFS, Q 0,7, fc 1042,21 Hz in 200 ms
  | "tick" // Rastklick
  | "pulse" // Puls (row = Zeile, falls zugeordnet)
  | "noise-stop" // Rauschbett aus (durMs = Ausblenden)
  | "final" // Schlusspuls
  | "acquired" // „Signal erfasst.“
  | "exit"
  | "end";

export interface IntroEvent {
  at: number;
  kind: IntroEventKind;
  row?: number;
  gainDb?: number;
  durMs?: number;
}

export function introEvents(v: IntroVariant): IntroEvent[] {
  const tm = introTimings(v);
  const ev: IntroEvent[] = [];
  if (v === "full") {
    ev.push({ at: 0, kind: "noise-in", gainDb: -34 });
    ev.push({ at: 300, kind: "search", durMs: LOCK_MS - 300 });
    ev.push({ at: LOCK_MS, kind: "lock", gainDb: -44, durMs: 200 });
    ev.push({ at: LOCK_MS, kind: "tick", gainDb: -42 });
    ROW_PULSE_TIMES.forEach((at, i) => ev.push({ at, kind: "pulse", row: i + 1, gainDb: rowPulseGainDb(i + 1) }));
    ev.push({ at: FOLD_MS, kind: "noise-stop", durMs: 600 });
  } else if (v === "short") {
    ev.push({ at: 0, kind: "noise-in", gainDb: -34 });
    ev.push({ at: 50, kind: "search", durMs: 250 });
    ev.push({ at: tm.lockAt, kind: "lock", gainDb: -44, durMs: 50 });
    ev.push({ at: tm.lockAt, kind: "tick", gainDb: -42 });
    ev.push({ at: tm.lockAt, kind: "pulse", gainDb: -14 });
    ev.push({ at: tm.foldAt, kind: "noise-stop", durMs: 400 });
  } else if (v === "reduced") {
    ev.push({ at: 300, kind: "pulse", gainDb: -14 });
  }
  ev.push({ at: tm.finalAt, kind: "final", gainDb: v === "reducedShort" ? -14 : -18 });
  ev.push({ at: tm.acquiredAt, kind: "acquired" });
  ev.push({ at: tm.exitAt, kind: "exit", durMs: tm.exitDur });
  ev.push({ at: tm.endAt, kind: "end" });
  return ev.sort((a, b) => a.at - b.at);
}

/* ── Bildzustand ────────────────────────────────────────── */
export type IntroPhase = "search" | "realtime" | "timelapse" | "fold" | "acquired" | "exit";
export type IntroLabel = { kind: "realtime" } | { kind: "timelapse"; factor: number } | null;

export interface IntroState {
  t: number;
  variant: IntroVariant;
  phase: IntroPhase;
  /** Himmelskarte */
  mapAlpha: number;
  /** Panelrahmen, Achsen, Labels, Tuner */
  panelAlpha: number;
  /** Bildrauschen im Panel (Renderer × 0,06) */
  grainAlpha: number;
  needleHz: number;
  locked: boolean;
  /** fertig geschriebene Zeilen (sinkt nie) */
  rowsDone: number;
  /** gerade geschriebene Zeile (1…16) und Lage des Schreibkopfs 0…1 */
  activeRow: number | null;
  writeHead: number;
  /** Zeilen in Σ (Puls schon da) */
  sumCount: number;
  label: IntroLabel;
  /** Faltfortschritt je Zeile (geglättet) */
  rowFold: number[];
  ringFold: number;
  /** Kern: Deckkraft und Radiusanteil von CORE_R·s */
  core: number;
  /** SVG-Zeichen (Überblendung) */
  markAlpha: number;
  /** „Signal erfasst.“ */
  acquired: boolean;
  /** Zeile „Gefaltet aus …“ */
  foldedLine: boolean;
  /** Ausgang 0…1 */
  exit: number;
  done: boolean;
}

function needleAt(t: number, v: IntroVariant): number {
  if (v === "reduced" || v === "reducedShort") return F_LOCK;
  if (v === "short") {
    if (t <= 50) return 0.5;
    const e = easeOutCubic((t - 50) / 250);
    return Math.exp(Math.log(0.5) + (Math.log(F_LOCK) - Math.log(0.5)) * e);
  }
  if (t <= NEEDLE_KEYS[0][0]) return NEEDLE_KEYS[0][1];
  for (let i = 1; i < NEEDLE_KEYS.length; i++) {
    const [t1, f1] = NEEDLE_KEYS[i];
    if (t <= t1) {
      const [t0, f0] = NEEDLE_KEYS[i - 1];
      const e = searchEase((t - t0) / (t1 - t0));
      return Math.exp(Math.log(f0) + (Math.log(f1) - Math.log(f0)) * e);
    }
  }
  return F_LOCK;
}

/** Nadelstellung (Hz) zur Zeit t */
export function needleHzAt(t: number, v: IntroVariant = "full"): number {
  return needleAt(t, v);
}

function phaseAt(t: number, v: IntroVariant, tm: IntroTimings): IntroPhase {
  if (t >= tm.exitAt) return "exit";
  if (t >= tm.acquiredAt) return "acquired";
  switch (v) {
    case "full":
      if (t < LOCK_MS) return "search";
      if (t < ROW_PULSE_TIMES[2]) return "realtime";
      if (t < FOLD_MS) return "timelapse";
      return "fold";
    case "short":
      return t < tm.lockAt ? "search" : "fold";
    default:
      return "realtime";
  }
}

export function introStateAt(t: number, v: IntroVariant = "full"): IntroState {
  const tm = introTimings(v);
  const phase = phaseAt(t, v, tm);
  const reduced = v === "reduced" || v === "reducedShort";
  const sc = v === "short" ? tm.foldDur / 600 : 1;

  // Zeilen
  let rowsDone = 0;
  let activeRow: number | null = null;
  let writeHead = 0;
  let sumCount = 0;
  let label: IntroLabel = null;
  if (v === "full") {
    for (let i = 1; i <= 16; i++) {
      const [s, e] = rowWriteWindow(i);
      if (t >= e) rowsDone = i;
      else if (t >= s && activeRow === null) {
        activeRow = i;
        writeHead = (t - s) / (e - s);
      }
      if (t >= ROW_PULSE_TIMES[i - 1]) sumCount = i;
    }
    if (t >= LOCK_MS && t < FOLD_MS) {
      const latest = activeRow ?? rowsDone;
      label = latest >= 3 ? { kind: "timelapse", factor: rowFactor(latest) } : { kind: "realtime" };
    }
  } else {
    rowsDone = t >= tm.lockAt ? 16 : 0;
    sumCount = rowsDone;
  }

  // Faltung
  const rowFold: number[] = [];
  let ringFold = 0;
  let core = 0;
  if (!reduced) {
    const local = t - tm.foldAt;
    for (let i = 1; i <= 16; i++) rowFold.push(easeInOutCubic((local - 10 * (i - 1) * sc) / (450 * sc)));
    ringFold = easeInOutCubic((local - 50 * sc) / (550 * sc));
    core = clamp01((local - 450 * sc) / (150 * sc));
  } else {
    for (let i = 1; i <= 16; i++) rowFold.push(0);
  }

  // Ebenen
  const fadeIn = reduced ? 1 : clamp01(t / 300);
  let panelAlpha: number;
  if (v === "reducedShort") panelAlpha = 0;
  else if (v === "reduced") panelAlpha = 1 - clamp01((t - tm.foldAt) / 200);
  else panelAlpha = Math.min(fadeIn, 1 - clamp01((t - tm.foldAt) / (200 * sc)));
  const grainAlpha = reduced ? 0 : t < tm.lockAt ? fadeIn : 1 - clamp01((t - tm.lockAt) / 300);
  const markAlpha = v === "reducedShort" ? 1 : clamp01((t - tm.acquiredAt) / (v === "reduced" ? 200 : 120));

  return {
    t,
    variant: v,
    phase,
    mapAlpha: fadeIn,
    panelAlpha,
    grainAlpha,
    needleHz: needleAt(t, v),
    locked: t >= tm.lockAt,
    rowsDone,
    activeRow,
    writeHead,
    sumCount,
    label,
    rowFold,
    ringFold,
    core,
    markAlpha,
    acquired: t >= tm.acquiredAt,
    foldedLine: t >= tm.acquiredAt + (v === "full" ? 120 : v === "short" ? 120 : 0),
    exit: tm.exitDur > 0 ? clamp01((t - tm.exitAt) / tm.exitDur) : t >= tm.exitAt ? 1 : 0,
    done: t >= tm.endAt,
  };
}

/** Endzustand (Überspringen): alles gefaltet, „Signal erfasst.“, Ausgang noch nicht begonnen */
export function skipState(v: IntroVariant = "full"): IntroState {
  return introStateAt(introTimings(v).exitAt - 1e-6, v);
}

/** Variante wählen (D.5): reduzierte Bewegung, Kurzfassung bei Update/Deinstallation/Preset, sonst Vollfassung */
export function chooseVariant(o: { reduced: boolean; mode?: string | null; preset?: boolean }): IntroVariant {
  const short = o.mode === "update" || o.mode === "uninstall" || Boolean(o.preset);
  if (o.reduced) return short ? "reducedShort" : "reduced";
  return short ? "short" : "full";
}
