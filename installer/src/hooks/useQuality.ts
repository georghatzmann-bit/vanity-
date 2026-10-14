/**
 * Qualitätsstufen (H): L2 60 fps, L1 30 fps, L0 15 fps. Start in L1 bei ≤ 2 Kernen,
 * `?quality=0|1|2` überschreibt (dann ohne Automatik). Automatisch eine Stufe tiefer, wenn über
 * 60 Bilder das p95 der Zeichenzeit > 8 ms oder das p95 des rAF-Abstands > 34 ms liegt.
 * Hochgestuft wird nie. Der Zustand liegt modulweit, damit jede Zeichenfläche melden kann.
 */
import { useSyncExternalStore } from "react";
import type { Quality } from "../obs/types";

export const QUALITY_FPS: Record<Quality, number> = { 0: 15, 1: 30, 2: 60 };

/** Was eine Stufe zeichnen darf (Tabelle H) */
export interface QualityConfig {
  fps: number;
  /** Pixeldichte Schirm / Intro */
  dprSchirm: number;
  dprIntro: number;
  /** Belichtungs-Samples */
  samples: number;
  /** Feldlinien: 12, 6 oder nur die vorderen Abschnitte */
  fieldLines: 12 | 6;
  fieldFrontOnly: boolean;
  /** Punkte je Gradnetz-Linie; 0 = nur Breitenkreise mit 24 Punkten */
  gridPoints: number;
  meridians: boolean;
  /** Rauschkacheln animiert (sonst Standbild) */
  noiseTiles: boolean;
}

export function qualityConfig(q: Quality, devicePixelRatio = 1): QualityConfig {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (q === 2) return { fps: 60, dprSchirm: Math.min(dpr, 2), dprIntro: Math.min(dpr, 1.25), samples: 60, fieldLines: 12, fieldFrontOnly: false, gridPoints: 48, meridians: true, noiseTiles: true };
  if (q === 1) return { fps: 30, dprSchirm: Math.min(dpr, 1.5), dprIntro: 1, samples: 30, fieldLines: 6, fieldFrontOnly: false, gridPoints: 24, meridians: true, noiseTiles: true };
  return { fps: 15, dprSchirm: 1, dprIntro: 1, samples: 12, fieldLines: 12, fieldFrontOnly: true, gridPoints: 24, meridians: false, noiseTiles: false };
}

/** `?quality=` (nur 0/1/2) oder null */
export function forcedQuality(search = typeof window !== "undefined" ? window.location.search : ""): Quality | null {
  try {
    const q = new URLSearchParams(search).get("quality");
    return q === "0" || q === "1" || q === "2" ? (Number(q) as Quality) : null;
  } catch {
    return null;
  }
}

export function initialQuality(): Quality {
  const f = forcedQuality();
  if (f !== null) return f;
  try {
    return (navigator.hardwareConcurrency ?? 4) <= 2 ? 1 : 2;
  } catch {
    return 2;
  }
}

/* ── Automatik (rein, testbar) ───────────────────────────── */

export const WINDOW_FRAMES = 60;
export const DRAW_P95_MS = 8;
export const GAP_P95_MS = 34;

/** p95 einer Messreihe */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

/** Entscheidung nach einem vollen Fenster: eine Stufe tiefer oder gleich (nie höher). */
export function judgeWindow(q: Quality, draws: readonly number[], gaps: readonly number[]): Quality {
  if (q === 0) return 0;
  if (p95(draws) > DRAW_P95_MS || p95(gaps) > GAP_P95_MS) return (q - 1) as Quality;
  return q;
}

/* ── Modulweiter Zustand ─────────────────────────────────── */

let current: Quality | null = null;
let auto = true;
/** bis zu dieser Zeit (performance.now) werden keine Bilder gewertet */
let holdUntil = 0;

/** Nach Moduswechsel oder Cache-Erzeugung 2 s lang keine Bilder werten (kein Abstufen mitten im Hochdrehen) */
export const QUALITY_HOLD_MS = 2000;

export function holdQualityJudging(ms = QUALITY_HOLD_MS): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  holdUntil = Math.max(holdUntil, now + ms);
  draws.length = 0;
  gaps.length = 0;
}
const draws: number[] = [];
const gaps: number[] = [];
const subs = new Set<() => void>();

function ensure(): Quality {
  if (current === null) {
    current = initialQuality();
    auto = forcedQuality() === null;
    mark(current, "start");
  }
  return current;
}

function mark(q: Quality, why: string) {
  try {
    document.documentElement.dataset.quality = String(q);
  } catch {
    /* egal */
  }
  if (why !== "start") console.info(`[setup] Qualitätsstufe L${q} (${why})`);
}

export function getQuality(): Quality {
  return ensure();
}

/**
 * Zeichenzeit und rAF-Abstand eines Bildes melden (ms). Bei vollem Fenster wird geurteilt.
 * Lücken > 250 ms (Tab im Hintergrund, Haltepunkt) zählen nicht.
 */
export function reportFrame(drawMs: number, gapMs: number): void {
  const q = ensure();
  if (!auto || q === 0 || !Number.isFinite(drawMs) || !Number.isFinite(gapMs) || gapMs > 250) return;
  if (holdUntil && (typeof performance !== "undefined" ? performance.now() : Date.now()) < holdUntil) return;
  draws.push(drawMs);
  gaps.push(gapMs);
  if (draws.length < WINDOW_FRAMES) return;
  const next = judgeWindow(q, draws, gaps);
  draws.length = 0;
  gaps.length = 0;
  if (next !== q) {
    current = next;
    mark(next, `auto, p95 über Grenze`);
    subs.forEach((cb) => cb());
  }
}

/** Nur für Tests: Zustand zurücksetzen */
export function _resetQualityForTests(q: Quality | null = null, isAuto = true): void {
  current = q;
  auto = isAuto;
  holdUntil = 0;
  draws.length = 0;
  gaps.length = 0;
}

function subscribe(cb: () => void) {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

export interface QualityControl {
  quality: Quality;
  /** Zeichenzeit und rAF-Abstand eines Bildes melden (ms) */
  reportFrame(drawMs: number, gapMs: number): void;
}

export function useQuality(): QualityControl {
  const quality = useSyncExternalStore(subscribe, getQuality, getQuality);
  return { quality, reportFrame };
}
