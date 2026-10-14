/**
 * Zeichenfläche des Intros (D.2–D.4): Bildrauschen im Panel, 16 Ridgeline-Zeilen mit
 * Verdeckung, Schreibkopf, Summenkurve Σ, Faltung Zeilen → Haarstrahlen, Σ → Ring, Kern.
 * Rein gezeichnet aus `IntroState` (dieselbe Tabelle wie der Ton). Kein Text im Canvas,
 * kein Verlauf, kein Glühen. Fensterkoordinaten: Canvas liegt bei y 40–600.
 */
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { MARK_GEOMETRY } from "@shared/ui/PulsarMark";
import type { IntroState } from "../obs/introTimeline";
import {
  INTRO_MARK_CENTER,
  INTRO_MARK_SIZE,
  RIDGE_SEED,
  ROWS,
  ROW_H,
  SAMPLES,
  foldMean,
  makeRows,
  noiseRow,
  plotX,
  probeGain,
  rayTarget,
  ringTarget,
  rowBaseY,
  sumPoint,
  type Row,
} from "../obs/ridgeline";
import { mulberry32 } from "../obs/rng";
import type { Quality } from "../obs/types";

export interface IntroDraw {
  s: IntroState;
  /** Gesamtdeckkraft (Überspringen: in 150 ms auf 0) */
  alpha: number;
  /** Bild-Index des Flimmerns (12 fps); fest bei L0 und reduzierter Bewegung */
  flicker: number;
}

export interface IntroCanvasHandle {
  draw(d: IntroDraw): void;
}

export interface IntroCanvasProps {
  quality: Quality;
  handleRef?: Ref<IntroCanvasHandle>;
}

const W = 980;
const H = 560;
const TOP = 40;
/** Panel-Innenfläche für das Bildrauschen */
const GRAIN_RECT = { x: 211, y: 89, w: 558, h: 322 };
const TILE = 128;
const TILES = 4;
const NOISE_SIGMA_ROWS = 0.1;

type RGB = [number, number, number];

function hexToRgb(v: string, fallback: RGB): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a: RGB, b: RGB, e: number): string =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * e)} ${Math.round(a[1] + (b[1] - a[1]) * e)} ${Math.round(a[2] + (b[2] - a[2]) * e)})`;
const css = (c: RGB) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

interface Palette {
  bg: RGB;
  fg: RGB;
  fg2: RGB;
  fg3: RGB;
  signal: RGB;
}

function readPalette(): Palette {
  let cs: CSSStyleDeclaration | null = null;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch {
    cs = null;
  }
  const v = (name: string) => cs?.getPropertyValue(name) ?? "";
  return {
    bg: hexToRgb(v("--obs-bg"), [10, 11, 13]),
    fg: hexToRgb(v("--obs-fg"), [230, 232, 235]),
    fg2: hexToRgb(v("--obs-fg-2"), [168, 174, 184]),
    fg3: hexToRgb(v("--obs-fg-3"), [128, 135, 146]),
    signal: hexToRgb(v("--obs-signal"), [242, 213, 60]),
  };
}

/** Rauschkacheln 128² (Graustufen, Seed fest) */
function makeTiles(): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  const rand = mulberry32(RIDGE_SEED * 7 + 3);
  for (let i = 0; i < TILES; i++) {
    const c = document.createElement("canvas");
    c.width = TILE;
    c.height = TILE;
    const cx = c.getContext("2d");
    if (cx) {
      const img = cx.createImageData(TILE, TILE);
      for (let p = 0; p < TILE * TILE; p++) {
        const g = Math.floor(rand() * 256);
        img.data[p * 4] = g;
        img.data[p * 4 + 1] = g;
        img.data[p * 4 + 2] = g;
        img.data[p * 4 + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
    }
    out.push(c);
  }
  return out;
}

/** DPR des Intros je Qualitätsstufe (H): L2 min(dpr, 1,25), sonst 1 */
export function introDpr(q: Quality): number {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return q === 2 ? Math.min(dpr, 1.25) : 1;
}

const G = MARK_GEOMETRY;
const SCALE = INTRO_MARK_SIZE / G.VIEWBOX;
const RAY_PX = G.rayStroke(INTRO_MARK_SIZE) * SCALE;
const RING_PX = G.ringStroke(INTRO_MARK_SIZE, "rays") * SCALE;

export function IntroCanvas({ quality, handleRef }: IntroCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rows = useMemo<Row[]>(() => makeRows(RIDGE_SEED), []);
  const sumAll = useMemo(() => foldMean(rows, ROWS), [rows]);
  const cache = useRef<{
    ctx: CanvasRenderingContext2D | null;
    pal: Palette | null;
    patterns: (CanvasPattern | null)[];
    noiseFrame: number;
    noise: Float64Array[];
    sumK: number;
    sum: Float64Array | null;
    dpr: number;
  }>({ ctx: null, pal: null, patterns: [], noiseFrame: -1, noise: [], sumK: -1, sum: null, dpr: 1 });

  // Größe und Kontext (DPR je Qualitätsstufe)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = introDpr(quality);
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D nicht verfügbar");
    const C = cache.current;
    C.ctx = ctx;
    C.dpr = dpr;
    C.pal = readPalette();
    try {
      C.patterns = makeTiles().map((t) => ctx.createPattern(t, "repeat"));
    } catch {
      C.patterns = [];
    }
  }, [quality]);

  useImperativeHandle(
    handleRef,
    () => ({
      draw(d: IntroDraw) {
        const C = cache.current;
        const ctx = C.ctx;
        const pal = C.pal;
        if (!ctx || !pal) return;
        drawFrame(ctx, C, pal, rows, sumAll, d);
      },
    }),
    [rows, sumAll],
  );

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute top-0 left-0 h-[560px] w-[980px]" data-testid="intro-canvas" />;
}

/* ── Zeichnen ───────────────────────────────────────────── */
type Cache = {
  patterns: (CanvasPattern | null)[];
  noiseFrame: number;
  noise: Float64Array[];
  sumK: number;
  sum: Float64Array | null;
  dpr: number;
};

function noiseFor(C: Cache, frame: number): Float64Array[] {
  if (C.noiseFrame !== frame) {
    C.noise = Array.from({ length: ROWS }, (_, i) => noiseRow(RIDGE_SEED + 101 * (i + 1), frame, NOISE_SIGMA_ROWS));
    C.noiseFrame = frame;
  }
  return C.noise;
}

function sumFor(C: Cache, rows: Row[], k: number): Float64Array {
  if (C.sumK !== k || !C.sum) {
    C.sum = foldMean(rows, k);
    C.sumK = k;
  }
  return C.sum;
}

/** Linienzug einer Zeile k (Fenster-y) */
function rowPath(ctx: CanvasRenderingContext2D, k: number, value: (j: number) => number, close: boolean) {
  const base = rowBaseY(k);
  ctx.beginPath();
  for (let j = 0; j < SAMPLES; j++) {
    const x = plotX(j);
    const y = base - ROW_H * value(j);
    if (j === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (close) {
    ctx.lineTo(plotX(SAMPLES - 1), base + 1);
    ctx.lineTo(plotX(0), base + 1);
    ctx.closePath();
  }
}

function drawFrame(ctx: CanvasRenderingContext2D, C: Cache, pal: Palette, rows: Row[], sumAll: Float64Array, d: IntroDraw) {
  const { s } = d;
  const dpr = C.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (d.alpha <= 0.001) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, -TOP * dpr);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const reduced = s.variant === "reduced" || s.variant === "reducedShort";
  /** Überblendung Canvas → SVG-Zeichen */
  const handOver = reduced ? 1 : 1 - s.markAlpha;
  const writtenAlpha = (reduced ? s.panelAlpha : 1) * handOver * d.alpha;
  const noiseAlpha = s.panelAlpha * d.alpha;

  // 1) Bildrauschen im Panel (4 Kacheln, 6 %)
  const grain = s.grainAlpha * s.panelAlpha * d.alpha;
  if (grain > 0.001 && C.patterns.length) {
    const pat = C.patterns[d.flicker % C.patterns.length];
    if (pat) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(GRAIN_RECT.x, GRAIN_RECT.y, GRAIN_RECT.w, GRAIN_RECT.h);
      ctx.clip();
      const ox = (d.flicker * 37) % TILE;
      const oy = (d.flicker * 71) % TILE;
      ctx.translate(GRAIN_RECT.x - ox, GRAIN_RECT.y - oy);
      ctx.globalAlpha = 0.06 * grain;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, GRAIN_RECT.w + TILE, GRAIN_RECT.h + TILE);
      ctx.restore();
    }
  }

  const folding = s.rowFold.some((e) => e > 0);
  const noise = noiseFor(C, d.flicker);
  const current = s.activeRow ?? (s.rowsDone > 0 ? s.rowsDone : null);
  const head = s.activeRow !== null ? Math.floor(s.writeHead * (SAMPLES - 1)) : -1;
  const probe = s.phase === "search" ? probeGain(s.needleHz) : 0;

  // 2) Zeilen von hinten (k = 1) nach vorn (k = 16)
  for (let k = 1; k <= ROWS; k++) {
    const row = rows[k - 1];
    const e = s.rowFold[k - 1] ?? 0;
    const written = k <= s.rowsDone;
    const active = s.activeRow === k;
    const n = noise[k - 1];

    if (written && folding && e > 0) continue; // wird unten als Strahl gezeichnet

    if (written || active) {
      // geschriebene Zeile (bzw. geschriebener Teil) mit Verdeckung
      const val = (j: number) => (written || j <= head ? row.y[j] : n[j] + (k === 1 ? probe * row.signal[j] : 0));
      ctx.globalAlpha = written ? writtenAlpha : d.alpha;
      rowPath(ctx, k, val, true);
      ctx.fillStyle = css(pal.bg);
      ctx.fill();
      rowPath(ctx, k, val, false);
      const isCur = k === current;
      ctx.strokeStyle = css(isCur ? pal.signal : pal.fg2);
      ctx.lineWidth = isCur ? 1.25 : 1;
      ctx.stroke();
      if (active && head >= 0) {
        // Schreibkopf, 1 px gelb
        const x = Math.round(plotX(head)) + 0.5;
        const base = rowBaseY(k);
        ctx.beginPath();
        ctx.moveTo(x, base - ROW_H - 2);
        ctx.lineTo(x, base + 3);
        ctx.strokeStyle = css(pal.signal);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      continue;
    }

    // Rauschzeile (σ 0,10, Deckkraft 0,35, fg-3); Zeile 01 zeigt beim Suchen die Probefaltung
    if (noiseAlpha <= 0.001) continue;
    const c = k === 1 ? probe : 0;
    const val = (j: number) => n[j] + c * row.signal[j];
    ctx.globalAlpha = noiseAlpha;
    rowPath(ctx, k, val, true);
    ctx.fillStyle = css(pal.bg);
    ctx.fill();
    ctx.globalAlpha = noiseAlpha * (0.35 + 0.65 * c);
    rowPath(ctx, k, val, false);
    ctx.strokeStyle = css(c > 0.05 ? pal.fg2 : pal.fg3);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 3) Summenkurve Σ (bzw. Ring)
  if (s.sumCount > 0) {
    const sum = s.sumCount >= ROWS ? sumAll : sumFor(C, rows, s.sumCount);
    const e = s.ringFold;
    ctx.globalAlpha = (reduced ? s.panelAlpha : 1) * handOver * d.alpha;
    ctx.beginPath();
    for (let j = 0; j < SAMPLES; j++) {
      const [sx, sy] = sumPoint(j, sum[j]);
      let x = sx;
      let y = sy;
      if (e > 0) {
        const [tx, ty] = ringTarget(j);
        x = sx + e * (tx - sx);
        y = sy + e * (ty - sy);
      }
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (e >= 0.999) ctx.closePath();
    ctx.strokeStyle = e > 0 ? mix(pal.signal, pal.fg, e) : css(pal.signal);
    ctx.lineWidth = 1.5 + e * (RING_PX - 1.5);
    ctx.stroke();
  }

  // 4) Faltung: Zeilen → Haarstrahlen (D.4)
  if (folding) {
    ctx.globalAlpha = handOver * d.alpha;
    for (let i = 1; i <= ROWS; i++) {
      const e = s.rowFold[i - 1];
      if (!(e > 0) || i > s.rowsDone) continue;
      const row = rows[i - 1];
      const base = rowBaseY(i);
      ctx.beginPath();
      for (let j = 0; j < SAMPLES; j++) {
        const sx = plotX(j);
        const sy = base - ROW_H * row.y[j];
        const [tx, ty] = rayTarget(i, j);
        const x = sx + e * (tx - sx);
        const y = sy + e * (ty - sy);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = mix(pal.fg2, pal.signal, e);
      ctx.lineWidth = 1 + e * (RAY_PX - 1);
      ctx.stroke();
    }
  }

  // 5) Kern: Radius 0 → CORE_R·s, Deckkraft 0 → 1
  if (s.core > 0 && handOver > 0) {
    ctx.globalAlpha = s.core * handOver * d.alpha;
    ctx.beginPath();
    ctx.arc(INTRO_MARK_CENTER[0], INTRO_MARK_CENTER[1], G.CORE_R * SCALE * s.core, 0, Math.PI * 2);
    ctx.fillStyle = css(pal.signal);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
