/**
 * Spuren der Match-Zeitleiste als Canvas 2D (gemeinsame Zeitachse): Ping, Schwankung, Verlust, Ausreißer,
 * Last. Gezeichnet wird nur der sichtbare Ausschnitt; bei mehr Punkten als Pixeln wird je Pixelspalte
 * zusammengefasst (Min/Max-Band + Mittel). Farben aus dem aktuellen Design (`--nv-…`).
 */
import { useEffect, useRef, useState } from "react";
import type { LagCause, TimelinePoint } from "@/lib/types";
import { axisTicks, formatElapsed, lowerBound, type Band, type SpikeMark } from "@/lib/timeline";

export type TrackKey = "ping" | "jitter" | "loss" | "spikes" | "load";

export interface TrackLayout {
  key: TrackKey;
  top: number;
  height: number;
}

/** Höhen der Spuren (Ping ≥ 120 px, andere ≥ 36 px – passt auch bei 960 × 600) */
const HEIGHTS: Record<TrackKey, number> = { ping: 136, jitter: 42, loss: 36, spikes: 44, load: 58 };
const GAP = 8;
const TOP = 6;
export const AXIS_H = 22;

export function trackLayout(pingOnly: boolean): { tracks: TrackLayout[]; height: number } {
  const keys: TrackKey[] = pingOnly ? ["ping"] : ["ping", "jitter", "loss", "spikes", "load"];
  let y = TOP;
  const tracks = keys.map((key) => {
    const t = { key, top: y, height: HEIGHTS[key] };
    y += HEIGHTS[key] + GAP;
    return t;
  });
  return { tracks, height: y - GAP + AXIS_H };
}

/** Aufbereitete Daten der ganzen Runde (einmal je Zeitleiste) */
export interface Prepared {
  start: number;
  end: number;
  points: readonly TimelinePoint[];
  jitter: readonly (number | null)[];
  intervalMs: number;
  limit: number | null;
  marks: SpikeMark[];
  bands: Band[];
  targetChanges: { t: number; label: string }[];
  pingMax: number;
  jitterMax: number;
  trafficMax: number;
  pingOnly: boolean;
}

/** Aufgelöste Design-Farben */
export interface Palette {
  fg: string;
  muted: string;
  faint: string;
  border: string;
  surface: string;
  accent: string;
  accent2: string;
  accent3: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  font: string;
  cause: Record<LagCause, string>;
}

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
  const p = {
    fg: v("--nv-fg", "#e9f1ff"),
    muted: v("--nv-muted", "#8091b3"),
    faint: v("--nv-faint", "#4b5878"),
    border: v("--nv-border", "rgba(160,200,255,0.09)"),
    surface: v("--nv-surface", "rgba(160,200,255,0.045)"),
    accent: v("--nv-accent", "#22d3ee"),
    accent2: v("--nv-accent-2", "#60a5fa"),
    accent3: v("--nv-accent-3", "#a78bfa"),
    success: v("--nv-success", "#34d399"),
    warning: v("--nv-warning", "#fbbf24"),
    danger: v("--nv-danger", "#fb7185"),
    info: v("--nv-info", "#60a5fa"),
    font: v("--nv-font-sans", "system-ui, sans-serif"),
  };
  return { ...p, cause: { wifi: p.warning, router: p.warning, isp: p.danger, internet: p.info, localTraffic: p.accent2, unknown: p.muted } };
}

/** Design-Farben, neu gelesen bei Themenwechsel (`data-theme`/`class`/`style` am `<html>`) */
export function usePalette(): Palette | null {
  const [pal, setPal] = useState<Palette | null>(null);
  useEffect(() => {
    setPal(readPalette());
    const obs = new MutationObserver(() => setPal(readPalette()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => obs.disconnect();
  }, []);
  return pal;
}

const pingTone = (p: Palette, ms: number) => (ms < 35 ? p.success : ms < 60 ? p.accent : ms < 100 ? p.warning : p.danger);

interface Column {
  n: number;
  sum: number;
  min: number;
  max: number;
  lost: boolean;
  jSum: number;
  jN: number;
  cpuSum: number;
  cpuN: number;
  rxSum: number;
  rxN: number;
  txSum: number;
  txN: number;
}

/** Sichtbare Punkte als Linienzüge (Lücken bei Verlust); viele Punkte → je Pixelspalte zusammengefasst */
function collect(d: Prepared, from: number, to: number, width: number, x: (t: number) => number) {
  const i0 = Math.max(0, lowerBound(d.points, from - d.intervalMs * 2) - 1);
  const i1 = Math.min(d.points.length, lowerBound(d.points, to + d.intervalMs * 2) + 1);
  const count = i1 - i0;
  const bucket = count > width * 1.2;
  if (!bucket) return { bucket, i0, i1, cols: [] as (Column | null)[] };
  const cols: (Column | null)[] = new Array(Math.ceil(width) + 2).fill(null);
  for (let i = i0; i < i1; i++) {
    const [t, rtt, cpu, rx, tx] = d.points[i];
    const c = Math.floor(x(t));
    if (c < 0 || c >= cols.length) continue;
    const col = (cols[c] ??= { n: 0, sum: 0, min: Infinity, max: -Infinity, lost: false, jSum: 0, jN: 0, cpuSum: 0, cpuN: 0, rxSum: 0, rxN: 0, txSum: 0, txN: 0 });
    if (rtt === null) col.lost = true;
    else {
      col.n++;
      col.sum += rtt;
      col.min = Math.min(col.min, rtt);
      col.max = Math.max(col.max, rtt);
    }
    const j = d.jitter[i];
    if (j !== null && j !== undefined) {
      col.jSum += j;
      col.jN++;
    }
    if (cpu !== null) {
      col.cpuSum += cpu;
      col.cpuN++;
    }
    if (rx !== null) {
      col.rxSum += rx;
      col.rxN++;
    }
    if (tx !== null) {
      col.txSum += tx;
      col.txN++;
    }
  }
  return { bucket, i0, i1, cols };
}

/** Linienzug aus (x, y | null) mit Lücken */
function polyline(ctx: CanvasRenderingContext2D, pts: [number, number | null][], close?: number) {
  let open = false;
  let startX = 0;
  let lastX = 0;
  ctx.beginPath();
  for (const [x, y] of pts) {
    if (y === null) {
      if (open && close !== undefined) {
        ctx.lineTo(lastX, close);
        ctx.lineTo(startX, close);
        ctx.closePath();
      }
      open = false;
      continue;
    }
    if (!open) {
      if (close !== undefined) {
        ctx.moveTo(x, close);
        ctx.lineTo(x, y);
      } else ctx.moveTo(x, y);
      startX = x;
      open = true;
    } else ctx.lineTo(x, y);
    lastX = x;
  }
  if (open && close !== undefined) {
    ctx.lineTo(lastX, close);
    ctx.lineTo(startX, close);
    ctx.closePath();
  }
}

export interface DrawArgs {
  ctx: CanvasRenderingContext2D;
  data: Prepared;
  pal: Palette;
  width: number;
  from: number;
  to: number;
  hoverT: number | null;
  labels: { limit: (ms: number) => string; band: (b: Band) => string; change: (label: string) => string };
}

export function drawTimeline({ ctx, data: d, pal, width, from, to, hoverT, labels }: DrawArgs) {
  const { tracks, height } = trackLayout(d.pingOnly);
  const span = Math.max(1, to - from);
  const pxPerMs = width / span;
  const x = (t: number) => (t - from) * pxPerMs;
  const track = (k: TrackKey) => tracks.find((tr) => tr.key === k);
  const plotBottom = height - AXIS_H;
  ctx.clearRect(0, 0, width, height);
  ctx.font = `500 10px ${pal.font}`;
  ctx.textBaseline = "alphabetic";

  // Spur-Hintergründe
  for (const tr of tracks) {
    ctx.fillStyle = pal.surface;
    ctx.fillRect(0, tr.top, width, tr.height);
  }

  // Zeitachse und senkrechte Hilfslinien
  const ticks = axisTicks(d.start, from, to, pxPerMs);
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.fillStyle = pal.muted;
  ctx.textAlign = "center";
  for (const off of ticks) {
    const tx = Math.round(x(d.start + off)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(tx, tracks[0].top);
    ctx.lineTo(tx, plotBottom + 4);
    ctx.stroke();
    ctx.fillText(formatElapsed(off), Math.min(width - 18, Math.max(18, tx)), plotBottom + 16);
  }

  // Bänder: Ruhezeit über alle Spuren, Aussetzer/Verlust in Ping und Verlust, langsam in Ping
  for (const b of d.bands) {
    if (b.to < from || b.from > to) continue;
    const bx = x(b.from);
    const bw = Math.max(2, x(b.to) - bx);
    const paint = (k: TrackKey, color: string, alpha: number) => {
      const tr = track(k);
      if (!tr) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(bx, tr.top, bw, tr.height);
      ctx.globalAlpha = 1;
    };
    if (b.kind === "quiet") {
      for (const tr of tracks) paint(tr.key, pal.muted, 0.16);
    } else if (b.kind === "slow") {
      paint("ping", pal.warning, 0.1);
    } else {
      paint("ping", pal.danger, 0.08);
      paint("loss", pal.danger, 0.28);
    }
    const ping = track("ping");
    if (ping && bw > 24) {
      ctx.fillStyle = b.kind === "quiet" ? pal.muted : b.kind === "slow" ? pal.warning : pal.danger;
      ctx.textAlign = "left";
      ctx.font = `600 10px ${pal.font}`;
      ctx.fillText(labels.band(b), Math.max(2, bx + 4), ping.top + 12, Math.max(20, bw - 8));
      ctx.font = `500 10px ${pal.font}`;
    }
  }

  const cols = collect(d, from, to, width, x);

  // Ping
  const ping = track("ping");
  if (ping) {
    const y = (v: number) => ping.top + ping.height - (Math.min(v, d.pingMax) / d.pingMax) * (ping.height - 6);
    // waagerechte Hilfslinien mit Skala
    ctx.strokeStyle = pal.border;
    ctx.fillStyle = pal.faint;
    ctx.textAlign = "left";
    for (const f of [0.5, 1]) {
      const yy = Math.round(y(d.pingMax * f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(width, yy);
      ctx.stroke();
      ctx.fillText(`${Math.round(d.pingMax * f)} ms`, 4, yy + 11);
    }
    let line: [number, number | null][] = [];
    if (cols.bucket) {
      // Min/Max-Band je Spalte
      for (let c = 0; c < cols.cols.length; c++) {
        const col = cols.cols[c];
        if (!col || !col.n) continue;
        const avg = col.sum / col.n;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = pingTone(pal, avg);
        ctx.fillRect(c, y(col.max), 1, Math.max(1, y(col.min) - y(col.max)));
      }
      ctx.globalAlpha = 1;
      // Spalte ohne Punkt = Lücke (z. B. Standby), Spalte nur mit Verlust = Lücke in der Linie
      line = cols.cols.map((col, c) => [c + 0.5, col && col.n ? y(col.sum / col.n) : null]);
    } else {
      for (let i = cols.i0; i < cols.i1; i++) {
        const [t, rtt] = d.points[i];
        line.push([x(t), rtt === null ? null : y(rtt)]);
      }
    }
    // Fläche
    const grad = ctx.createLinearGradient(0, ping.top, 0, ping.top + ping.height);
    grad.addColorStop(0, pal.accent);
    grad.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = grad;
    polyline(ctx, line, ping.top + ping.height);
    ctx.fill();
    ctx.globalAlpha = 1;
    // Linie, Farbe je Abschnitt nach Ping
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1];
      const [x1, y1] = line[i];
      if (y0 === null || y1 === null) continue;
      const ms = ((ping.top + ping.height - Math.min(y0, y1)) / (ping.height - 6)) * d.pingMax;
      ctx.strokeStyle = pingTone(pal, ms);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    // Ausreißer-Grenze
    if (d.limit !== null && d.limit < d.pingMax) {
      const ly = Math.round(y(d.limit)) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = pal.warning;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(width, ly);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = pal.warning;
      ctx.textAlign = "right";
      ctx.fillText(labels.limit(Math.round(d.limit)), width - 6, ly - 4);
    }
    // alle Ausreißer als Punkte (über der Grenze)
    for (const m of d.marks) {
      if (m.t < from - d.intervalMs || m.t > to + d.intervalMs) continue;
      const mx = x(m.t);
      const my = y(m.rtt);
      ctx.fillStyle = pal.danger;
      ctx.beginPath();
      ctx.arc(mx, Math.max(ping.top + 3, my), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Schwankung
  const jt = track("jitter");
  if (jt) {
    const y = (v: number) => jt.top + jt.height - (Math.min(v, d.jitterMax) / d.jitterMax) * (jt.height - 4);
    const pts: [number, number | null][] = cols.bucket
      ? cols.cols.map((col, c) => [c + 0.5, col?.jN ? y(col.jSum / col.jN) : null] as [number, number | null])
      : Array.from({ length: cols.i1 - cols.i0 }, (_, k) => {
          const i = cols.i0 + k;
          const j = d.jitter[i];
          return [x(d.points[i][0]), j === null || j === undefined ? null : y(j)] as [number, number | null];
        });
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = pal.accent3;
    polyline(ctx, pts, jt.top + jt.height);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = pal.accent3;
    ctx.lineWidth = 1.3;
    polyline(ctx, pts);
    ctx.stroke();
    ctx.fillStyle = pal.faint;
    ctx.textAlign = "left";
    ctx.fillText(`${Math.round(d.jitterMax)} ms`, 4, jt.top + 11);
  }

  // Verlust: rote Striche je verlorenem Punkt
  const lt = track("loss");
  if (lt) {
    ctx.fillStyle = pal.danger;
    const draw = (px: number) => ctx.fillRect(Math.floor(px), lt.top + 6, Math.max(1.5, pxPerMs * d.intervalMs * 0.6), lt.height - 12);
    if (cols.bucket) cols.cols.forEach((col, c) => col?.lost && draw(c));
    else for (let i = cols.i0; i < cols.i1; i++) if (d.points[i][1] === null) draw(x(d.points[i][0]));
  }

  // Ausreißer: Stiel je Markierung; mit Ursache übernimmt das Symbol (HTML) die Darstellung
  const st = track("spikes");
  if (st) {
    const mid = st.top + st.height / 2;
    ctx.strokeStyle = pal.border;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();
    for (const m of d.marks) {
      if (m.t < from - d.intervalMs || m.t > to + d.intervalMs) continue;
      const mx = Math.round(x(m.t)) + 0.5;
      const color = m.cause ? pal.cause[m.cause] : pal.danger;
      ctx.strokeStyle = color;
      ctx.globalAlpha = m.cause ? 0.5 : 0.85;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(mx, st.top + 6);
      ctx.lineTo(mx, st.top + st.height - 6);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (!m.cause) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(mx, mid, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.lineWidth = 1;
  }

  // Last: CPU als Fläche, rx/tx als dünne Linien
  const ld = track("load");
  if (ld) {
    const yc = (v: number) => ld.top + ld.height - (Math.min(100, Math.max(0, v)) / 100) * (ld.height - 4);
    const yt = (v: number) => ld.top + ld.height - (Math.min(v, d.trafficMax) / d.trafficMax) * (ld.height - 4);
    const series = (pick: (p: TimelinePoint) => number | null, colPick: (c: Column) => number | null, y: (v: number) => number): [number, number | null][] =>
      cols.bucket
        ? cols.cols.map((col, c) => {
            const v = col ? colPick(col) : null;
            return [c + 0.5, v === null ? null : y(v)] as [number, number | null];
          })
        : Array.from({ length: cols.i1 - cols.i0 }, (_, k) => {
            const p = d.points[cols.i0 + k];
            const v = pick(p);
            return [x(p[0]), v === null ? null : y(v)] as [number, number | null];
          });
    const cpu = series((p) => p[2], (c) => (c.cpuN ? c.cpuSum / c.cpuN : null), yc);
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = pal.accent2;
    polyline(ctx, cpu, ld.top + ld.height);
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = pal.accent2;
    ctx.lineWidth = 1.2;
    polyline(ctx, cpu);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = pal.success;
    polyline(ctx, series((p) => p[3], (c) => (c.rxN ? c.rxSum / c.rxN : null), yt));
    ctx.stroke();
    ctx.strokeStyle = pal.warning;
    polyline(ctx, series((p) => p[4], (c) => (c.txN ? c.txSum / c.txN : null), yt));
    ctx.stroke();
    ctx.fillStyle = pal.faint;
    ctx.textAlign = "left";
    ctx.fillText(`100 % · ${Math.round(d.trafficMax)} Mbit/s`, 4, ld.top + 11);
  }

  // Zielwechsel als senkrechte Linie
  for (const c of d.targetChanges) {
    if (c.t < from || c.t > to) continue;
    const cx = Math.round(x(c.t)) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = pal.fg;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(cx, tracks[0].top);
    ctx.lineTo(cx, plotBottom);
    ctx.stroke();
    ctx.restore();
    if (ping) {
      const text = labels.change(c.label);
      ctx.font = `600 10px ${pal.font}`;
      const tw = ctx.measureText(text).width;
      const left = cx + 4 + tw + 8 > width ? cx - tw - 12 : cx + 4;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = pal.surface;
      ctx.fillRect(left, ping.top + ping.height - 20, tw + 8, 15);
      ctx.globalAlpha = 1;
      ctx.fillStyle = pal.fg;
      ctx.textAlign = "left";
      ctx.fillText(text, left + 4, ping.top + ping.height - 9);
      ctx.font = `500 10px ${pal.font}`;
    }
  }

  // Fadenkreuz
  if (hoverT !== null && hoverT >= from && hoverT <= to) {
    const hx = Math.round(x(hoverT)) + 0.5;
    ctx.strokeStyle = pal.fg;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(hx, tracks[0].top);
    ctx.lineTo(hx, plotBottom);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/** Canvas in Fenstergröße, das den sichtbaren Ausschnitt zeichnet */
export function TimelineCanvas(props: Omit<DrawArgs, "ctx"> & { height: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width, height, data, pal, from, to, hoverT, labels, className } = props;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTimeline({ ctx, data, pal, width, from, to, hoverT, labels });
  }, [width, height, data, pal, from, to, hoverT, labels]);
  return <canvas ref={ref} className={className} style={{ width, height, display: "block" }} />;
}
