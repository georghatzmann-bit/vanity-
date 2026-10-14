/**
 * Bildkarte einer Runde (PNG, 1200 × 630, Maßstab 2). Vertrag: docs/API.md, „Match-Zeitleiste“ (Bildkarte).
 * - `cardModel` (rein, getestet): alle Texte und Kurvenpunkte – nur Namen von Messzielen, keine Adressen.
 * - `renderMatchCard` zeichnet das Modell mit Canvas 2D: Farben aus dem aktuellen Design (`--nv-…`),
 *   Spiel-Farben als Verlauf, Schriften nach `document.fonts.ready`, **keine Bilder** (immer exportierbar).
 */
import { formatDateTime, formatDuration, formatNumber } from "./format";
import { compressTimeline } from "./grade";
import { t as globalT } from "./i18n";
import { causeSummary } from "./lagtext";
import { headerModel, spikeMarks } from "./timeline";
import type { Game, GamePalette, Grade, SessionReport, SessionTimeline } from "./types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Logische Größe der Karte (px); gespeichert wird mit Maßstab 2 */
export const CARD_W = 1200;
export const CARD_H = 630;
export const CARD_SCALE = 2;
/** So viele Punkte hat die Kurve auf der Karte höchstens */
export const CARD_CURVE_POINTS = 360;
/** So viele Ausreißer-Punkte zeichnet die Karte höchstens */
export const CARD_MAX_DOTS = 80;

/** Farbton einer Kennzahl (Design-Token) */
export type CardTone = "success" | "accent" | "warning" | "danger" | "fg";

export interface CardStat {
  key: "avg" | "jitter" | "loss" | "spikes";
  label: string;
  value: string;
  tone: CardTone;
}

export interface CardModel {
  brand: "PULSAR";
  kicker: string;
  title: string;
  when: string;
  duration: string;
  grade: Grade;
  gradeLabel: string;
  stats: CardStat[];
  /** Messziel(e) als Text (Namen, keine Adressen) */
  target: string;
  /** [t, rtt | null] – höchstens `CARD_CURVE_POINTS` */
  curve: [number, number | null][];
  spikeDots: { t: number; rtt: number }[];
  limit: number | null;
  start: number;
  end: number;
  causeText: string;
  examinedText: string;
  footer: string;
  palette: GamePalette | null;
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6 = /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}\b/i;
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/i;

/** Name eines Messziels für die Karte; sieht er wie eine Adresse aus, steht dort „eigenes Ziel“. */
export function safeTargetName(label: string, tr: Translate = globalT): string {
  const s = label.trim();
  if (!s || IPV4.test(s) || IPV6.test(s) || MAC.test(s)) return tr("timeline.card.customTarget");
  return s;
}

const pingTone = (ms: number | null): CardTone => (ms === null ? "danger" : ms < 35 ? "success" : ms < 60 ? "accent" : ms < 100 ? "warning" : "danger");
const gradeTone = (g: Grade): CardTone => (g === "A+" || g === "A" ? "success" : g === "B" ? "accent" : g === "C" || g === "D" ? "warning" : "danger");

/**
 * Kurve für die Karte: höchstens `max` Punkte wie `compressTimeline` (Mittel je Abschnitt, Verlust bleibt
 * sichtbar) – liegt im Abschnitt ein Ausreißer über der Grenze, zählt dessen Wert, damit die Spitze in der
 * Kurve zu sehen ist und zum Ausreißer-Punkt passt.
 */
export function cardCurve(points: [number, number | null][], limit: number | null, max = CARD_CURVE_POINTS): [number, number | null][] {
  const out = compressTimeline(points, max);
  if (points.length <= max || limit === null) return out;
  const step = points.length / max;
  return out.map(([t, v], i) => {
    if (v === null) return [t, v];
    const slice = points.slice(Math.floor(i * step), Math.floor((i + 1) * step));
    const peak = slice.reduce<number>((a, p) => (p[1] !== null && p[1] > a ? p[1] : a), -Infinity);
    return [t, peak > limit ? peak : v];
  });
}

/** Inhalt der Bildkarte (rein) */
export function cardModel(report: SessionReport, timeline: SessionTimeline | null, tr: Translate = globalT, game: Pick<Game, "palette"> | null = null): CardModel {
  const h = headerModel(report, timeline);
  const pts = timeline?.points.length ? timeline.points : report.timeline.map(([t, rtt]) => [t, rtt, null, null, null] as const);
  const { limit, marks } = spikeMarks(
    pts.map((p) => [p[0], p[1], null, null, null]),
    timeline?.events ?? [],
  );
  const curve = cardCurve(
    pts.map((p) => [p[0], p[1]] as [number, number | null]),
    limit,
  );
  const step = Math.max(1, Math.ceil(marks.length / CARD_MAX_DOTS));
  const spikeDots = marks.filter((_, i) => i % step === 0).map((m) => ({ t: m.t, rtt: m.rtt }));
  const targets = [...new Set(h.targets.map((x) => safeTargetName(x, tr)))];
  const target = targets.length ? targets.join(" → ") : tr("timeline.card.customTarget");
  const ms = (v: number | null) => (v === null ? "–" : `${formatNumber(v, v < 10 ? 1 : 0)} ms`);
  return {
    brand: "PULSAR",
    kicker: tr("timeline.card.kicker"),
    title: h.gameName,
    when: formatDateTime(h.start),
    duration: formatDuration(h.durationS, { short: true }),
    grade: h.grade,
    gradeLabel: tr("timeline.card.grade"),
    stats: [
      { key: "avg", label: tr("timeline.card.avg"), value: ms(h.avg), tone: pingTone(h.avg) },
      { key: "jitter", label: tr("timeline.card.jitter"), value: ms(h.jitter), tone: h.jitter !== null && h.jitter >= 12 ? "warning" : "fg" },
      { key: "loss", label: tr("timeline.card.loss"), value: `${formatNumber(h.loss * 100, 1)} %`, tone: h.loss > 0.01 ? "danger" : "fg" },
      { key: "spikes", label: tr("timeline.card.spikes"), value: String(h.spikes), tone: h.spikes > 10 ? "warning" : "fg" },
    ],
    target,
    curve,
    spikeDots,
    limit,
    start: h.start,
    end: h.end,
    causeText: causeSummary(h.causes, tr),
    examinedText: tr("timeline.header.examined", { n: h.examined, m: h.spikes }),
    footer: tr("timeline.card.footer", { target }),
    palette: game?.palette ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Zeichnen (nur im Browser bzw. in der App – vitest/Node hat kein Canvas)
// ---------------------------------------------------------------------------------------------

interface Colors {
  bg: string;
  bgElev: string;
  surface: string;
  border: string;
  borderStrong: string;
  fg: string;
  fgSoft: string;
  muted: string;
  faint: string;
  accent: string;
  accent2: string;
  accent3: string;
  success: string;
  warning: string;
  danger: string;
  fontDisplay: string;
  fontSans: string;
}

function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--nv-bg", "#04070f"),
    bgElev: v("--nv-bg-elev", "#0a1020"),
    surface: v("--nv-surface-2", "rgba(160,200,255,0.075)"),
    border: v("--nv-border", "rgba(160,200,255,0.09)"),
    borderStrong: v("--nv-border-strong", "rgba(160,200,255,0.18)"),
    fg: v("--nv-fg", "#e9f1ff"),
    fgSoft: v("--nv-fg-soft", "#c2d0ea"),
    muted: v("--nv-muted", "#8091b3"),
    faint: v("--nv-faint", "#4b5878"),
    accent: v("--nv-accent", "#22d3ee"),
    accent2: v("--nv-accent-2", "#60a5fa"),
    accent3: v("--nv-accent-3", "#a78bfa"),
    success: v("--nv-success", "#34d399"),
    warning: v("--nv-warning", "#fbbf24"),
    danger: v("--nv-danger", "#fb7185"),
    fontDisplay: v("--nv-font-display", "system-ui, sans-serif"),
    fontSans: v("--nv-font-sans", "system-ui, sans-serif"),
  };
}

const toneColor = (c: Colors, tone: CardTone) => ({ success: c.success, accent: c.accent, warning: c.warning, danger: c.danger, fg: c.fg })[tone];

/** Text auf eine Breite kürzen („…“) */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/** Text mit Buchstabenabstand (Canvas kann `letterSpacing` nicht überall) */
function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number, align: "left" | "right" = "left") {
  const chars = [...text];
  const width = chars.reduce((a, ch) => a + ctx.measureText(ch).width, 0) + spacing * Math.max(0, chars.length - 1);
  let cx = align === "right" ? x - width : x;
  ctx.textAlign = "left";
  for (const ch of chars) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return width;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Deterministischer Zufall für die Sterne (gleiche Karte → gleiches Bild) */
function seeded(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function drawCard(ctx: CanvasRenderingContext2D, m: CardModel, c: Colors) {
  const W = CARD_W;
  const H = CARD_H;
  const primary = m.palette?.primary || c.accent;
  const secondary = m.palette?.secondary || c.accent3;

  // Hintergrund: Grundfarbe, Leuchten in Spiel- und Design-Farben, Sterne, feines Raster
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);
  const glow = (x: number, y: number, r: number, color: string, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  };
  glow(140, 60, 620, primary, 0.34);
  glow(1120, 600, 560, secondary, 0.22);
  glow(980, 120, 300, c.accent, 0.12);
  const rnd = seeded(Math.floor(m.start / 1000));
  ctx.fillStyle = c.fg;
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.08 + rnd() * 0.25;
    const r = rnd() < 0.85 ? 0.7 : 1.3;
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Rahmen
  ctx.strokeStyle = c.borderStrong;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 18, 18, W - 36, H - 36, 26);
  ctx.stroke();

  // Spiel-Farbstreifen links
  const band = ctx.createLinearGradient(0, 60, 0, 230);
  band.addColorStop(0, primary);
  band.addColorStop(1, secondary);
  ctx.fillStyle = band;
  roundRect(ctx, 56, 64, 5, 150, 3);
  ctx.fill();

  // Marke: Pulsar-Zeichen + Schriftzug
  const bx = 84;
  const by = 74;
  ctx.save();
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 2;
  for (const [r, a] of [
    [13, 0.25],
    [9, 0.55],
  ] as const) {
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(bx + 13, by + 13, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = c.accent;
  ctx.shadowBlur = 14;
  ctx.fillStyle = c.accent;
  ctx.beginPath();
  ctx.arc(bx + 13, by + 13, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = c.fg;
  ctx.font = `700 20px ${c.fontDisplay}`;
  ctx.textBaseline = "middle";
  spaced(ctx, m.brand, bx + 38, by + 14, 6);
  ctx.fillStyle = c.muted;
  ctx.font = `600 12px ${c.fontSans}`;
  spaced(ctx, m.kicker.toUpperCase(), bx + 172, by + 14, 2.5);

  // Datum und Dauer oben rechts
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "right";
  ctx.fillStyle = c.fgSoft;
  ctx.font = `600 16px ${c.fontSans}`;
  ctx.fillText(m.when, W - 230, 92);
  ctx.fillStyle = c.muted;
  ctx.font = `500 14px ${c.fontSans}`;
  ctx.fillText(m.duration, W - 230, 114);

  // Titel und Messziel
  ctx.textAlign = "left";
  ctx.fillStyle = c.fg;
  ctx.font = `700 52px ${c.fontDisplay}`;
  ctx.fillText(fit(ctx, m.title, 760), bx, 172);
  ctx.fillStyle = c.muted;
  ctx.font = `500 17px ${c.fontSans}`;
  ctx.fillText(fit(ctx, m.target, 760), bx, 204);

  // Note als leuchtender Ring
  const gx = W - 132;
  const gy = 138;
  const gr = 62;
  const gc = toneColor(c, gradeTone(m.grade));
  const share = { "A+": 1, A: 0.88, B: 0.72, C: 0.52, D: 0.32, F: 0.12 }[m.grade] ?? 0.12;
  ctx.lineCap = "round";
  ctx.lineWidth = 10;
  ctx.strokeStyle = c.surface;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.shadowColor = gc;
  ctx.shadowBlur = 22;
  ctx.strokeStyle = gc;
  ctx.beginPath();
  ctx.arc(gx, gy, gr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * share);
  ctx.stroke();
  ctx.restore();
  ctx.textAlign = "center";
  ctx.fillStyle = gc;
  ctx.font = `800 54px ${c.fontDisplay}`;
  ctx.fillText(m.grade, gx, gy + 18);
  ctx.fillStyle = c.muted;
  ctx.font = `600 11px ${c.fontSans}`;
  ctx.textBaseline = "middle";
  const gl = m.gradeLabel.toUpperCase();
  spaced(ctx, gl, gx - (ctx.measureText(gl).width + 2 * (gl.length - 1)) / 2, gy + gr + 20, 2);
  ctx.textBaseline = "alphabetic";

  // Kennzahlen
  const sx = bx;
  const sy = 246;
  const sw = 222;
  const sh = 84;
  m.stats.forEach((s, i) => {
    const x = sx + i * (sw + 16);
    ctx.fillStyle = c.surface;
    roundRect(ctx, x, sy, sw, sh, 16);
    ctx.fill();
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = c.muted;
    ctx.font = `600 11px ${c.fontSans}`;
    ctx.textAlign = "left";
    spaced(ctx, s.label.toUpperCase(), x + 18, sy + 26, 1.8);
    ctx.fillStyle = toneColor(c, s.tone);
    ctx.font = `700 32px ${c.fontDisplay}`;
    ctx.fillText(fit(ctx, s.value, sw - 36), x + 18, sy + 66);
  });

  // Ping-Kurve
  const cx0 = bx;
  const cx1 = W - 60;
  const cy0 = 358;
  const cy1 = 520;
  const ok = m.curve.map((p) => p[1]).filter((v): v is number => v !== null);
  const peak = Math.max(m.limit ?? 0, ...m.spikeDots.map((d) => d.rtt), ...ok, 20);
  const yMax = peak * 1.08;
  const span = Math.max(1, m.end - m.start);
  const X = (t: number) => cx0 + ((t - m.start) / span) * (cx1 - cx0);
  const Y = (v: number) => cy1 - (Math.min(v, yMax) / yMax) * (cy1 - cy0);
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = cy0 + ((cy1 - cy0) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(cx0, y);
    ctx.lineTo(cx1, y);
    ctx.stroke();
  }
  if (m.limit !== null && m.limit < yMax) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = c.warning;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(cx0, Y(m.limit));
    ctx.lineTo(cx1, Y(m.limit));
    ctx.stroke();
    ctx.restore();
  }
  // Fläche und Linie (Lücken bei Verlust)
  const segments: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (const [t, v] of m.curve) {
    if (v === null) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push([X(t), Y(v)]);
  }
  if (cur.length) segments.push(cur);
  const fill = ctx.createLinearGradient(0, cy0, 0, cy1);
  fill.addColorStop(0, c.accent);
  fill.addColorStop(1, "transparent");
  for (const seg of segments) {
    if (seg.length < 2) continue;
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(seg[0][0], cy1);
    for (const [x, y] of seg) ctx.lineTo(x, y);
    ctx.lineTo(seg[seg.length - 1][0], cy1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  const line = ctx.createLinearGradient(cx0, 0, cx1, 0);
  line.addColorStop(0, c.accent);
  line.addColorStop(1, c.accent2);
  ctx.save();
  ctx.strokeStyle = line;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = "round";
  ctx.shadowColor = c.accent;
  ctx.shadowBlur = 10;
  for (const seg of segments) {
    ctx.beginPath();
    seg.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.restore();
  // Verlust als rote Striche am unteren Rand
  ctx.fillStyle = c.danger;
  for (const [t, v] of m.curve) if (v === null) ctx.fillRect(X(t) - 1, cy1 + 4, 2, 8);
  // Ausreißer als leuchtende Punkte
  ctx.save();
  ctx.shadowColor = c.danger;
  ctx.shadowBlur = 12;
  for (const d of m.spikeDots) {
    ctx.fillStyle = c.danger;
    ctx.beginPath();
    ctx.arc(X(d.t), Y(d.rtt), 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.bg;
    ctx.beginPath();
    ctx.arc(X(d.t), Y(d.rtt), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // Skala
  ctx.fillStyle = c.faint;
  ctx.font = `500 11px ${c.fontSans}`;
  ctx.textAlign = "right";
  ctx.fillText(`${Math.round(yMax)} ms`, cx1, cy0 - 6);

  // Ursachen und Fußzeile
  ctx.textAlign = "left";
  ctx.fillStyle = c.fgSoft;
  ctx.font = `600 15px ${c.fontSans}`;
  ctx.fillText(fit(ctx, m.causeText, cx1 - cx0 - 280), cx0, 554);
  ctx.textAlign = "right";
  ctx.fillStyle = c.muted;
  ctx.font = `500 13px ${c.fontSans}`;
  ctx.fillText(fit(ctx, m.examinedText, 270), cx1, 554);
  ctx.textAlign = "left";
  ctx.fillStyle = c.faint;
  ctx.font = `500 12.5px ${c.fontSans}`;
  ctx.fillText(fit(ctx, m.footer, cx1 - cx0), cx0, 584);
}

/** Bildkarte als PNG (2400 × 1260 px) */
export async function renderMatchCard(report: SessionReport, timeline: SessionTimeline | null, game: Pick<Game, "palette"> | null): Promise<Blob> {
  const model = cardModel(report, timeline, globalT, game);
  try {
    await document.fonts?.ready;
  } catch {
    /* ohne geladene Schriften zeichnen */
  }
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W * CARD_SCALE;
  canvas.height = CARD_H * CARD_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(globalT("timeline.card.failed"));
  ctx.scale(CARD_SCALE, CARD_SCALE);
  drawCard(ctx, model, readColors());
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(globalT("timeline.card.failed")))), "image/png"));
}
