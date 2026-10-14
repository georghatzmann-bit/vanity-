/**
 * Neutronenstern im Schirm (F.3), Canvas 2D, 380 × 320 bei Fenster (20, 72), Sternmitte (210, 232).
 * Belichtungskamera statt Zeitlupe: Belichtet wird die RINGZONE am Strahlende (r = BEAM_LEN, θ = α ± ρ),
 * die der Strahl in der belichteten Zeit überstreicht – als Bogen (n < 1), der stetig zum geschlossenen
 * Ring wächst (n ≥ 1, zwei geneigte Ringe um Ω̂). Fläche aus 1°-Vierecken (nonzero, eine Lage), dazu je
 * Kegel ein äußerer und ein innerer Rand. Der aktuelle Strahl ist ein offener Keil, bei schneller Drehung
 * eine ruhige Strobo-Mittellinie (sichtbare Alias-Drehung). Drehachse Ω̂ als gestrichelte Haarlinie.
 * Stroboskop, Wandlung zum Zeichen, radialer Bayer-Zerfall. Kein Verlauf, keine Unschärfe, keine
 * additive Mischung, keine Filter, kein Offscreen-Cache für die Belichtung. Werte liegen in Refs.
 */
import { useCallback, useEffect, useRef } from "react";
import type { SpinModel } from "@shared/sound/spin";
import { sound, F_STAR } from "@shared/sound/engine";
import { MARK_GEOMETRY } from "@shared/ui/PulsarMark";
import { useFrameLoop } from "../hooks/useFrameLoop";
import { holdQualityJudging, qualityConfig, reportFrame, type QualityConfig } from "../hooks/useQuality";
import { decayBeamAlpha, UNINSTALL_TIMING, DONE_TIMING, RELOCK_MS } from "../hooks/useObservatory";
import { REFERENCES } from "../obs/catalog";
import { BAYER4 } from "../obs/dither";
import { mixSeed, mulberry32 } from "../obs/rng";
import {
  angleToSight, arcWeight, basis, beamFillFactor, beamQuad, blurWeight, capDot, CAP_DOT_R, CAP_RING_THETAS_DEG, coneDir, dipolePoints, exposureTurns, FIELD_CHI_DEG, FIELD_L, fieldLoopWeight,
  flashAllowed, lambdaForPhase, LOGO_PHASE, magneticAxis, markMorph, MARK_SIZE_PX, psiForPhase, pulseDisc, RIM_INNER_ALPHA, RIM_OUTER_ALPHA, smoothstep, STAR_CENTER, STAR_R, BEAM_LEN,
  strobeVisFreq, zoneAlpha, zoneQuads, zoneThetas, type MorphParams, type Projected, type Pt2, type Vec3,
} from "../obs/star";
import type { ObsMode, Quality } from "../obs/types";

export interface StarCanvasProps {
  model: SpinModel;
  mode: ObsMode;
  /** Modellzeit (s), seit der `mode` gilt */
  modeSince: number;
  reduced: boolean;
  quality: Quality;
}

export const STAR_CANVAS_W = 380;
export const STAR_CANVAS_H = 320;
/** Lage des Canvas im Fenster */
export const STAR_CANVAS_X = 20;
export const STAR_CANVAS_Y = 72;

/* ── Szene (rein) ───────────────────────────────────────── */

export type CameraKind = "exposure" | "strobe" | "still" | "nosignal" | "none";

export interface Scene {
  /** Phase/Frequenz des Modells zur Bildzeit */
  phi: number;
  f: number;
  /** belichtetes Fenster in Umdrehungen (Bogen der Ringzone); `sharp` = Phase des Keils (n < 1) */
  from: number;
  to: number;
  width: number;
  sharp: number | null;
  /** Deckkraft der Ringzone (Füllung, inkl. Einblendung über n); 0 = keine Fläche */
  zone: number;
  /** Faktor der Zonenränder 0…1 (äußerer Rand 0,55, innerer 0,25) */
  rims: number;
  /** Faktor für alles, was Strahl ist (Fläche, Kanten, Lichtscheibe) */
  beamAlpha: number;
  /** Fehler: nur ein gestrichelter Keilumriss in FG2, kein Signalgelb, keine Zone, keine Achse */
  dashed: boolean;
  /** Drehachse Ω̂ als gestrichelte Haarlinie */
  axis: boolean;
  caps: boolean;
  disc: "flash" | "none";
  /** ruhiger Strobo-Strahl bei der sichtbaren Alias-Phase (n ≥ 1) */
  strobeBeam: boolean;
  fieldMul: number;
  /** w(n) für Meridiane und Feldlinien */
  blur: number;
  morph: MorphParams | null;
  /** Bayer-Zerfall 0…1 (−1 = kein Zerfall) */
  decay: number;
  /** Bayer-Stufe 0…16 (−1 = kein Zerfall), für Anzeige/Tests */
  bayer: number;
  noiseOnly: boolean;
  camera: CameraKind;
}

const clamp01 = (u: number) => Math.min(1, Math.max(0, Number.isFinite(u) ? u : 0));
const easeOut = (u: number) => 1 - (1 - clamp01(u)) ** 3;
const LN_B = Math.log(REFERENCES.b1919.freqHz);
const LN_STAR = Math.log(F_STAR);

/** Antrieb zurückgerechnet aus der Frequenz (0 = B1919, 1 = f★) – für die Feldlinien beim Deinstallieren */
export function driveFromFreq(f: number): number {
  return clamp01((Math.log(Math.max(1e-6, f)) - LN_B) / (LN_STAR - LN_B));
}

/** Gewicht des Keils (n < 1) und der Strobo-Mittellinie (n ≥ 1) – weicher Übergang um n = 1 */
export const sharpWeight = (n: number) => 1 - smoothstep(0.6, 1.0, n);
export const fullWeight = (n: number) => smoothstep(0.8, 1.2, n);

/**
 * Szene zu Modus und Zeit (F.3, F.5, G.1, G.2, H). `elapsedMs` = Zeit seit `modeSince`.
 * `nIn` = geglättete Belichtung aus dem Render-Loop (fehlt: n(f)).
 */
export function sceneFor(mode: ObsMode, elapsedMs: number, phiIn: number, f: number, reduced: boolean, nIn?: number): Scene {
  const base: Scene = {
    phi: phiIn, f, from: phiIn, to: phiIn, width: 0, sharp: phiIn, zone: 0, rims: 0, beamAlpha: 1, dashed: false, axis: true, caps: true, disc: "none", strobeBeam: false,
    fieldMul: 1, blur: 1, morph: null, decay: -1, bayer: -1, noiseOnly: false, camera: "exposure",
  };
  if (mode === "lost" || (mode === "decay" && reduced)) return { ...base, noiseOnly: true, camera: "none", caps: false, axis: false };

  // Standbild (reduzierte Bewegung): Logo-Phase, keine Belichtung, kein Blitzen
  const still = (phi: number): Scene => {
    const p = Math.floor(phi) + LOGO_PHASE;
    return { ...base, phi: p, from: p, to: p, sharp: p, camera: "still" };
  };
  // Stroboskop: Bogen der Ringzone um die Logo-Phase, Breite min(w, 1) – schließt bzw. öffnet sich stetig
  const strobe = (width: number): Scene => {
    const c = Math.floor(phiIn) + LOGO_PHASE;
    const w = Math.max(0, width);
    const a = Math.min(1, w);
    const k = arcWeight(w);
    return { ...base, phi: c, from: c - a / 2, to: c + a / 2, width: w, sharp: w < 1 ? c : null, zone: zoneAlpha(F_STAR) * k, rims: k, blur: blurWeight(w), camera: "strobe" };
  };

  if (mode === "installed") return { ...still(phiIn), morph: markMorph(1), caps: false, camera: "none" };
  if (mode === "strobe") {
    if (reduced) return { ...still(phiIn), morph: markMorph(1), caps: false, camera: "none" };
    const s = strobe(2 * (1 - easeOut(elapsedMs / DONE_TIMING.strobeMs)));
    if (elapsedMs >= DONE_TIMING.strobeMs) s.morph = markMorph((elapsedMs - DONE_TIMING.strobeMs) / (DONE_TIMING.morphEndMs - DONE_TIMING.strobeMs));
    return s;
  }
  if (mode === "release" && !reduced) {
    if (elapsedMs < UNINSTALL_TIMING.morphMs) return { ...strobe(0), morph: markMorph(1 - elapsedMs / UNINSTALL_TIMING.morphMs) };
    return strobe(2 * easeOut((elapsedMs - UNINSTALL_TIMING.morphMs) / UNINSTALL_TIMING.strobeOpenMs));
  }

  // Belichtungskamera
  let s: Scene;
  if (reduced) s = still(phiIn);
  else {
    const n = nIn !== undefined && Number.isFinite(nIn) ? Math.max(0, nIn) : exposureTurns(f);
    const k = arcWeight(n);
    s = {
      ...base, from: phiIn - Math.min(1, n), to: phiIn, width: n, sharp: n < 1 ? phiIn : null, zone: zoneAlpha(f) * k, rims: k, blur: blurWeight(n),
      disc: flashAllowed(f) ? "flash" : "none", strobeBeam: n >= 0.8,
    };
  }
  // Fortsetzen: Belichtungsebene (Zone und Ränder) über 300 ms von 0 einblenden
  if (mode === "relock") {
    const u = clamp01(elapsedMs / RELOCK_MS);
    s.zone *= u;
    s.rims *= u;
  }
  if (mode === "uninstalling" || mode === "release" || mode === "decay") s.fieldMul = 0.4 + 0.6 * driveFromFreq(f);
  if (mode === "halted") s.beamAlpha = 0.5;
  if (mode === "error") {
    // „Kein Signal“: Standbild bei der eingefrorenen Phase – keine Zone, keine Ränder, keine Achse, keine Kappen,
    // keine Lichtscheibe, kein Strobo, kein Gelb; nur ein gestrichelter Keilumriss
    s.dashed = true;
    s.zone = 0;
    s.rims = 0;
    s.axis = false;
    s.sharp = s.phi;
    s.blur = 1;
    s.camera = "nosignal";
    s.fieldMul *= 0.3;
    s.caps = false;
    s.disc = "none";
    s.strobeBeam = false;
  }
  if (mode === "decay") {
    s.beamAlpha = decayBeamAlpha(elapsedMs);
    s.axis = false;
    const u = (elapsedMs - UNINSTALL_TIMING.decayFromMs) / (UNINSTALL_TIMING.decayToMs - UNINSTALL_TIMING.decayFromMs);
    s.decay = u <= 0 ? -1 : clamp01(u);
    s.bayer = u <= 0 ? -1 : Math.max(0, Math.min(16, Math.floor(clamp01(u) * 16 + 1e-9)));
    s.strobeBeam = false;
  }
  if (reduced) {
    s.disc = "none";
    s.strobeBeam = false;
  }
  return s;
}

/* ── Zeichnen ───────────────────────────────────────────── */

const SIG = (a: number) => `rgba(242,213,60,${clamp01(a).toFixed(3)})`;
const FG = (a: number) => `rgba(230,232,235,${clamp01(a).toFixed(3)})`;
const FG2 = (a: number) => `rgba(168,174,184,${clamp01(a).toFixed(3)})`;
const SPHERE = "#0C0E11";
const DEG = Math.PI / 180;
const B = basis();
const [CX, CY] = STAR_CENTER;
/** Feldlinien-Clip: Canvas minus 8 px Innenrand (Fenster-Koordinaten) */
const FIELD_CLIP = { x: STAR_CANVAS_X + 8, y: STAR_CANVAS_Y + 8, w: STAR_CANVAS_W - 16, h: STAR_CANVAS_H - 16 };
/** Feldlinien erst ab 1,15 R★ (kein zweiter Umriss am Sternrand) */
const FIELD_R_MIN = 1.15;

type Ctx = CanvasRenderingContext2D;

function mk(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Transformation: CSS-px im Fenster-Koordinatensystem */
function toWindow(ctx: Ctx, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, -STAR_CANVAS_X * dpr, -STAR_CANVAS_Y * dpr);
}

function polyPath(ctx: Ctx | Path2D, pts: readonly Pt2[]) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

const axisOf = (phi: number, s: 1 | -1): Vec3 => {
  const m = magneticAxis(psiForPhase(phi));
  return [m[0] * s, m[1] * s, m[2] * s];
};

/** Kugelpunkte um Ω̂: Breite β, Länge λ (rad) */
function spherePoint(beta: number, lambda: number): Vec3 {
  const cb = Math.cos(beta);
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const sb = Math.sin(beta);
  return [cb * (cl * B.e1[0] + sl * B.e2[0]) + sb * B.omega[0], cb * (cl * B.e1[1] + sl * B.e2[1]) + sb * B.omega[1], cb * (cl * B.e1[2] + sl * B.e2[2]) + sb * B.omega[2]];
}

/** Polylinie nur dort, wo `keep` gilt (Abschnitte) */
function strokeRuns(ctx: Ctx | Path2D, pts: { x: number; y: number }[], keep: (i: number) => boolean) {
  let open = false;
  for (let i = 0; i < pts.length; i++) {
    if (keep(i)) {
      if (!open) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
      open = true;
    } else open = false;
  }
}

/** Kreis um Ω̂ in Kolatitude θ (Rad) mit Radius r (R★) */
function axisCircle(theta: number, r: number, n: number): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const v = spherePoint(Math.PI / 2 - theta, (2 * Math.PI * i) / n);
    out.push({ x: CX + STAR_R * r * v[0], y: CY - STAR_R * r * v[1], z: v[2] });
  }
  return out;
}

/* ── Ringzone am Strahlende (Fenster-Koordinaten, unabhängig von der Pixeldichte) ── */

interface ZonePaths {
  /** Fläche der Zone (1°-Vierecke, im Uhrzeigersinn) – hinten (z < 0) / vorn */
  fillBack: Path2D;
  fillFront: Path2D;
  /** äußerer Rand (θ = α + ρ bzw. 180° − α − ρ) und innerer Rand – hinten / vorn */
  outerBack: Path2D;
  outerFront: Path2D;
  innerBack: Path2D;
  innerFront: Path2D;
}

/** Rand der Zone (Kolatitude θ, r = BEAM_LEN) über λ, 1°-Raster, letzter Punkt genau bei `lTo` */
function rimPoints(theta: number, lFrom: number, lTo: number): Projected[] {
  const n = Math.max(1, Math.ceil((lTo - lFrom) / DEG - 1e-9));
  const out: Projected[] = [];
  for (let i = 0; i <= n; i++) {
    const d = coneDir(theta, Math.min(lTo, lFrom + i * DEG));
    out.push({ x: CX + STAR_R * BEAM_LEN * d[0], y: CY - STAR_R * BEAM_LEN * d[1], z: d[2] });
  }
  return out;
}

/** Zonen-Pfade beider Strahlen für den Bogen φ ∈ [from, to] (Umdrehungen, Länge ≤ 1) */
function buildZone(from: number, to: number): ZonePaths {
  const z: ZonePaths = { fillBack: new Path2D(), fillFront: new Path2D(), outerBack: new Path2D(), outerFront: new Path2D(), innerBack: new Path2D(), innerFront: new Path2D() };
  const span = Math.min(1, Math.max(0, to - from)) * 2 * Math.PI;
  if (span <= 1e-6) return z;
  for (const s of [1, -1] as const) {
    const l0 = lambdaForPhase(from, s);
    const l1 = l0 + span;
    for (const q of zoneQuads(l0, l1, s)) polyPath(q.z < 0 ? z.fillBack : z.fillFront, q.pts);
    const [inner, outer] = zoneThetas(s);
    const po = rimPoints(outer, l0, l1);
    const pi = rimPoints(inner, l0, l1);
    // Ränder an der Grenze vorn/hinten überlappen um einen Punkt, damit keine Lücke entsteht
    strokeRuns(z.outerBack, po, (i) => po[i].z < 0 || (po[i - 1]?.z ?? 1) < 0);
    strokeRuns(z.outerFront, po, (i) => po[i].z >= 0 || (po[i - 1]?.z ?? -1) >= 0);
    strokeRuns(z.innerBack, pi, (i) => pi[i].z < 0 || (pi[i - 1]?.z ?? 1) < 0);
    strokeRuns(z.innerFront, pi, (i) => pi[i].z >= 0 || (pi[i - 1]?.z ?? -1) >= 0);
  }
  return z;
}

/** Volle Umdrehung (geschlossene Ringe): einmal auf Modulebene, ohne Offscreen-Canvas */
let fullZone: ZonePaths | null = null;
function zoneFor(from: number, to: number): ZonePaths {
  if (to - from >= 1 - 1e-9) return (fullZone ??= buildZone(0, 1));
  return buildZone(from, to);
}

/** Kappen-Breitenringe θ = α ± κ auf r = 1, nur vorn */
let capRingsCache: Path2D | null = null;
function capRings(): Path2D {
  if (capRingsCache) return capRingsCache;
  const p = new Path2D();
  for (const th of CAP_RING_THETAS_DEG) {
    const pts = axisCircle(th * DEG, 1, 128);
    strokeRuns(p, pts, (i) => pts[i].z > 0);
  }
  capRingsCache = p;
  return p;
}

/** Drehachse Ω̂: gestrichelte Haarlinie von r 1 bis 2,2 auf beiden Seiten (nicht durch die Scheibe) */
export const AXIS_R0 = 1;
export const AXIS_R1 = 2.2;
/** Oberes Ende der Achse (Fenster-Koordinaten) und Richtung nach außen – für das DOM-Label „Ω“ */
export function omegaLabelAnchor(): { x: number; y: number; dx: number; dy: number } {
  const o = B.omega;
  const sgn = o[1] >= 0 ? 1 : -1; // oberes Ende = Bildschirm-y kleiner
  const x = CX + STAR_R * AXIS_R1 * o[0] * sgn;
  const y = CY - STAR_R * AXIS_R1 * o[1] * sgn;
  const l = Math.hypot(o[0], o[1]) || 1;
  return { x, y, dx: (o[0] * sgn) / l, dy: (-o[1] * sgn) / l };
}

/* ── Ebenen ─────────────────────────────────────────────── */

interface Layers {
  dpr: number;
  w: number;
  h: number;
  /** Zerfall */
  layer: HTMLCanvasElement;
  noiseMasked: HTMLCanvasElement;
  removal: HTMLCanvasElement;
  removalStep: number;
  noise: HTMLCanvasElement | null;
}

function makeLayers(dpr: number): Layers {
  const w = Math.round(STAR_CANVAS_W * dpr);
  const h = Math.round(STAR_CANVAS_H * dpr);
  return { dpr, w, h, layer: mk(w, h), noiseMasked: mk(w, h), removal: mk(w, h), removalStep: -1, noise: null };
}

/* ── Zerfall: eingefrorenes Korn in einer Kreisscheibe, radial steigende Bayer-Schwelle ── */

const NOISE_R = BEAM_LEN * STAR_R; // 116 px
const NOISE_SOFT = (BEAM_LEN - 0.5) * STAR_R; // weicher Rand ab 1,5 R★
const DECAY_STEPS = 32;

/** Radiale Maske 1 → 0 zwischen BEAM_LEN − 0,5 und BEAM_LEN (R★) */
function radialMask(r: number): number {
  if (r <= NOISE_SOFT) return 1;
  if (r >= NOISE_R) return 0;
  const u = (r - NOISE_SOFT) / (NOISE_R - NOISE_SOFT);
  return 1 - u * u * (3 - 2 * u);
}

function ensureNoise(L: Layers) {
  if (L.noise) return;
  const c = mk(L.w, L.h);
  const ctx = c.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(L.w, L.h);
    const cell = 2 * L.dpr; // Korn 2 × 2 CSS-px
    const cols = Math.ceil(L.w / cell) + 1;
    const vals = new Float32Array(cols * (Math.ceil(L.h / cell) + 1));
    const rnd = mulberry32(mixSeed(0x1919, 7));
    for (let i = 0; i < vals.length; i++) vals[i] = rnd();
    for (let y = 0; y < L.h; y++) {
      const wy = STAR_CANVAS_Y + (y + 0.5) / L.dpr;
      const cy = Math.floor(y / cell);
      for (let x = 0; x < L.w; x++) {
        const wx = STAR_CANVAS_X + (x + 0.5) / L.dpr;
        const m = radialMask(Math.hypot(wx - CX, wy - CY));
        if (m <= 0) continue;
        const i = (y * L.w + x) * 4;
        img.data[i] = 230;
        img.data[i + 1] = 232;
        img.data[i + 2] = 235;
        img.data[i + 3] = Math.round(vals[cy * cols + Math.floor(x / cell)] * 255 * 0.08 * m);
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  L.noise = c;
}

/**
 * Entfernte Pixel bei Zerfall u (0…1): Bayer-Wert b < q(r, u), q = 1,6·u − 0,6 + 0,6·(r / 2,5 R★).
 * Außen löst sich der Stern zuerst auf; bei u = 1 ist alles weg.
 */
function ensureRemoval(L: Layers, u: number): HTMLCanvasElement {
  const step = Math.round(clamp01(u) * DECAY_STEPS);
  if (L.removalStep === step) return L.removal;
  L.removalStep = step;
  const uq = step / DECAY_STEPS;
  const ctx = L.removal.getContext("2d");
  if (!ctx) return L.removal;
  const img = ctx.createImageData(L.w, L.h);
  const k = Math.max(1, Math.round(L.dpr));
  for (let y = 0; y < L.h; y++) {
    const wy = STAR_CANVAS_Y + (y + 0.5) / L.dpr;
    const by = Math.floor(y / k) % 4;
    for (let x = 0; x < L.w; x++) {
      const wx = STAR_CANVAS_X + (x + 0.5) / L.dpr;
      const rr = Math.min(1, Math.hypot(wx - CX, wy - CY) / NOISE_R);
      const q = 1.6 * uq - 0.6 + 0.6 * rr;
      const b = (BAYER4[by * 4 + (Math.floor(x / k) % 4)] + 0.5) / 16;
      if (b < q) img.data[(y * L.w + x) * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return L.removal;
}

function drawNoise(ctx: Ctx, L: Layers) {
  ensureNoise(L);
  if (!L.noise) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(L.noise, 0, 0);
  ctx.restore();
}

/* ── Bild ───────────────────────────────────────────────── */

export interface RenderState {
  /** Phase des Strobo-Strahls (Umdrehungen) */
  phiVis: number;
}

/** Ganze Szene in einen Kontext (Fenster-Koordinaten) */
function drawStar(ctx: Ctx, L: Layers, sc: Scene, qc: QualityConfig, rs: RenderState) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, L.w, L.h);
  toWindow(ctx, L.dpr);
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  const mp = sc.morph;
  const gridA = mp ? mp.gridAlpha : 1;
  const fieldA = (mp ? mp.fieldAlpha : 1) * sc.fieldMul;
  const split = mp ? mp.raySplit : 0;
  const beamA = sc.beamAlpha * (1 - split);
  const n = sc.width;
  const still = sc.camera === "still";
  /** Keil des aktuellen Strahls (n < 1) bzw. Strobo-Mittellinie (n ≥ 1) – weicher Übergang um n = 1 */
  const kSingle = still ? 1 : sharpWeight(n);
  const kFull = still ? 0 : fullWeight(n);
  const err = sc.dashed;

  // Phase des Keils (bzw. aktuelle Phase)
  const phiS = sc.sharp ?? sc.to;
  const m = magneticAxis(psiForPhase(phiS));
  const axes = [1, -1].map((s) => [m[0] * s, m[1] * s, m[2] * s] as Vec3);

  // Ringzone: belichteter Bogen [from, to] beider Strahlen (ab einer Umdrehung geschlossen, aus dem Modul-Cache)
  const zoneA = sc.zone * beamA;
  const rimK = sc.rims * beamA;
  const zone = !err && (zoneA > 0.002 || rimK > 0.004) ? zoneFor(sc.from, sc.to) : null;
  const zonePass = (front: boolean) => {
    if (!zone) return;
    if (zoneA > 0.002) {
      ctx.fillStyle = SIG(zoneA);
      ctx.fill(front ? zone.fillFront : zone.fillBack, "nonzero");
    }
    if (rimK > 0.004) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = SIG(RIM_OUTER_ALPHA * rimK);
      ctx.stroke(front ? zone.outerFront : zone.outerBack);
      ctx.strokeStyle = SIG(RIM_INNER_ALPHA * rimK);
      ctx.stroke(front ? zone.innerFront : zone.innerBack);
    }
  };

  // Drehachse Ω̂ (gestrichelt, FG2 0,35): hinteres Stück vor der Scheibe, vorderes danach
  const axisA = sc.axis && !err ? 0.35 * (1 - split) * gridA : 0;
  const axisPass = (front: boolean) => {
    if (axisA <= 0.004) return;
    const o = B.omega;
    const sgn = (o[2] >= 0) === front ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(CX + STAR_R * AXIS_R0 * o[0] * sgn, CY - STAR_R * AXIS_R0 * o[1] * sgn);
    ctx.lineTo(CX + STAR_R * AXIS_R1 * o[0] * sgn, CY - STAR_R * AXIS_R1 * o[1] * sgn);
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = FG2(axisA);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Feldlinien (Dipol): 4 Schleifen in der Ebene von Ω̂ und m, Kanten-Ansicht blendet aus; nicht dicht am Sternrand
  const loopW = fieldLoopWeight(FIELD_CHI_DEG[0], m);
  const fieldPass = (wantFront: boolean, alpha: number) => {
    const a = alpha * loopW;
    if (a <= 0.002) return;
    if (!wantFront && qc.fieldFrontOnly) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(FIELD_CLIP.x, FIELD_CLIP.y, FIELD_CLIP.w, FIELD_CLIP.h);
    ctx.clip();
    ctx.beginPath();
    for (const L0 of FIELD_L)
      for (const chi of FIELD_CHI_DEG) {
        const pts = dipolePoints(L0, chi, m, 48);
        strokeRuns(ctx, pts, (i) => pts[i].r >= FIELD_R_MIN && (wantFront ? pts[i].z >= 0 : pts[i].z < 0 && !pts[i].hidden));
      }
    ctx.strokeStyle = FG2(a);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  };

  // Aktueller Strahl (n < 1): offener Keil – Füllung 0,08, nur die zwei Seitenkanten 1 px; kein Deckel.
  // Zur Erde hin (γ < 25°) blendet er aus. Fehler: EIN gestrichelter Keilumriss in FG2 (vorderer Strahl).
  const wedge = (wantFront: boolean) => {
    if (sc.sharp === null || beamA <= 0) return;
    if (err) {
      const ax = axes[0][2] >= axes[1][2] ? axes[0] : axes[1];
      if (!wantFront) return;
      const q = beamQuad(ax).quad;
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      ctx.lineTo(q[1].x, q[1].y);
      ctx.moveTo(q[3].x, q[3].y);
      ctx.lineTo(q[2].x, q[2].y);
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = FG2(0.4 * beamA);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    for (const ax of axes) {
      if (ax[2] >= 0 !== wantFront) continue;
      const k = beamA * kSingle * smoothstep(10, 25, angleToSight(ax));
      if (k <= 0.002) continue;
      const q = beamQuad(ax).quad;
      ctx.beginPath();
      polyPath(ctx, q);
      ctx.fillStyle = SIG(0.08 * k);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(q[0].x, q[0].y);
      ctx.lineTo(q[1].x, q[1].y);
      ctx.moveTo(q[3].x, q[3].y);
      ctx.lineTo(q[2].x, q[2].y);
      ctx.strokeStyle = SIG(0.6 * k);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  // Strobo-Strahl (n ≥ 1): nur die Mittellinie r 1 … BEAM_LEN bei der sichtbaren Alias-Phase, zur Erde hin ausgeblendet
  const strobeBeam = (wantFront: boolean) => {
    if (!sc.strobeBeam || beamA <= 0 || err) return;
    for (const s of [1, -1] as const) {
      const ax = axisOf(rs.phiVis, s);
      if (ax[2] >= 0 !== wantFront) continue;
      const k = 0.8 * kFull * beamA * beamFillFactor(ax);
      if (k <= 0.002) continue;
      ctx.beginPath();
      ctx.moveTo(CX + STAR_R * ax[0], CY - STAR_R * ax[1]);
      ctx.lineTo(CX + STAR_R * BEAM_LEN * ax[0], CY - STAR_R * BEAM_LEN * ax[1]);
      ctx.strokeStyle = SIG(k);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  // 1 hintere Feldlinien, Achse, Zone, Strahlen
  fieldPass(false, 0.06 * sc.blur * fieldA);
  axisPass(false);
  zonePass(false);
  strobeBeam(false);
  wedge(false);

  // 3 Sternscheibe (flach), Rand 1 px fg 35 % (bei der Wandlung: siehe Ring)
  ctx.beginPath();
  ctx.arc(CX, CY, STAR_R, 0, Math.PI * 2);
  ctx.fillStyle = SPHERE;
  ctx.globalAlpha = 1 - split;
  ctx.fill();
  ctx.globalAlpha = 1;
  if (!mp) {
    ctx.strokeStyle = FG(0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 4 Gradnetz um Ω̂ (Fehler: 0,10 statt 0,18)
  const gridLine = err ? 0.1 : 0.18;
  if (gridA > 0.002) {
    const nPts = qc.gridPoints;
    ctx.beginPath();
    for (const lat of [0, 30, -30, 60, -60]) {
      const pts: Projected[] = [];
      for (let i = 0; i <= nPts; i++) {
        const v = spherePoint(lat * DEG, (2 * Math.PI * i) / nPts);
        pts.push({ x: CX + STAR_R * v[0], y: CY - STAR_R * v[1], z: v[2] });
      }
      strokeRuns(ctx, pts, (i) => pts[i].z > 0);
    }
    ctx.strokeStyle = FG(gridLine * gridA);
    ctx.lineWidth = 1;
    ctx.stroke();
    const wMer = sc.blur * gridA;
    if (qc.meridians && wMer > 0.01) {
      const psi = psiForPhase(sc.phi);
      ctx.beginPath();
      for (let k = 0; k < 12; k++) {
        const lam = psi + k * 30 * DEG;
        const pts: Projected[] = [];
        for (let i = 0; i <= nPts; i++) {
          const v = spherePoint(-Math.PI / 2 + (Math.PI * i) / nPts, lam);
          pts.push({ x: CX + STAR_R * v[0], y: CY - STAR_R * v[1], z: v[2] });
        }
        strokeRuns(ctx, pts, (i) => pts[i].z > 0);
      }
      ctx.strokeStyle = FG(gridLine * wMer);
      ctx.stroke();
    }
  }

  // 5 Polkappen: n < 1 ein Punkt Ø 4 px im Kappenmittelpunkt (nur vorn); n ≥ 1 Breitenringe α ± κ (vorn)
  if (sc.caps && gridA > 0.002 && beamA > 0 && !err) {
    if (kSingle > 0.002) {
      for (const ax of axes) {
        const d = capDot(ax);
        const a = d.alpha * beamA * gridA * kSingle;
        if (!d.visible || a <= 0.004) continue;
        ctx.beginPath();
        ctx.arc(d.x, d.y, CAP_DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = SIG(a);
        ctx.fill();
      }
    }
    const ringA = 0.35 * sc.zone * beamA * gridA * kFull;
    if (ringA > 0.002) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = SIG(ringA);
      ctx.stroke(capRings());
    }
  }

  // 6 vordere Feldlinien
  fieldPass(true, 0.12 * sc.blur * fieldA);
  // 7 vordere Achse, Zone, Strahlen
  axisPass(true);
  zonePass(true);
  strobeBeam(true);
  wedge(true);

  // 8 Lichtscheibe: der Kappen-Punkt wächst auf r 4 (Blitzschutz: nur bis 2,5 Hz, γ < 12°)
  if (sc.disc === "flash" && beamA > 0 && !err) {
    const d = pulseDisc(m, sc.f);
    if (d.visible && d.alpha > 0.004) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = SIG(d.alpha * beamA);
      ctx.fill();
    }
  }

  // 9 Wandlung zum Zeichen: ein geschlossener Strahl, Fächer erst ab 0,6; Ring als Bogen ab 12 Uhr
  if (mp && split > 0) {
    const sMark = MARK_SIZE_PX / MARK_GEOMETRY.VIEWBOX;
    const e = split;
    const spread = smoothstep(0.6, 1, e);
    for (const ax of axes) {
      const len = Math.hypot(ax[0], ax[1]);
      const ang = Math.atan2(ax[0], ax[1]) / DEG; // im Uhrzeigersinn ab senkrecht
      const r0 = len * STAR_R;
      const r1 = len * STAR_R * BEAM_LEN;
      ctx.beginPath();
      for (let k = 0; k < MARK_GEOMETRY.RAYS_PER_BEAM; k++) {
        const th = (ang + (k - 3.5) * MARK_GEOMETRY.RAY_SPREAD * spread) * DEG;
        const rin = r0 + (MARK_GEOMETRY.RAY_IN * sMark - r0) * e;
        const rout = r1 + (MARK_GEOMETRY.RAY_OUT(k) * sMark - r1) * e;
        ctx.moveTo(CX + rin * Math.sin(th), CY - rin * Math.cos(th));
        ctx.lineTo(CX + rout * Math.sin(th), CY - rout * Math.cos(th));
      }
      ctx.strokeStyle = SIG(0.6 + 0.4 * e);
      // Vor dem Auffächern ein geschlossener Strahl (Breite der acht Haarstrahlen zusammen), danach die Ziel-Strichstärke
      const markW = MARK_GEOMETRY.rayStroke(MARK_SIZE_PX) * sMark;
      ctx.lineWidth = 1 + (markW - 1) * e;
      ctx.lineCap = "butt";
      ctx.stroke();
    }
  }
  if (mp) {
    const e = split;
    // alter Sternrand blendet aus, der Ring zieht sich im Uhrzeigersinn ab 12 Uhr auf
    if (e < 1) {
      ctx.beginPath();
      ctx.arc(CX, CY, mp.ringR, 0, Math.PI * 2);
      ctx.strokeStyle = FG(0.35 * (1 - e));
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const frac = smoothstep(0, 0.85, e);
    if (frac > 0.001) {
      const circ = 2 * Math.PI * mp.ringR;
      ctx.beginPath();
      ctx.arc(CX, CY, mp.ringR, -Math.PI / 2, (3 * Math.PI) / 2);
      ctx.setLineDash(frac >= 0.999 ? [] : [circ * frac, circ]);
      ctx.strokeStyle = FG(mp.ringAlpha);
      ctx.lineWidth = mp.ringWidth;
      ctx.lineCap = "butt";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  if (mp && mp.coreR > 0.05) {
    ctx.beginPath();
    ctx.arc(CX, CY, mp.coreR, 0, Math.PI * 2);
    ctx.fillStyle = SIG(Math.min(1, mp.coreR / 4));
    ctx.fill();
  }
  ctx.lineCap = "butt";
}

/** Bild zusammensetzen (mit radialem Bayer-Zerfall) */
function render(main: Ctx, L: Layers, sc: Scene, qc: QualityConfig, rs: RenderState) {
  if (sc.noiseOnly) {
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.clearRect(0, 0, L.w, L.h);
    drawNoise(main, L);
    return;
  }
  if (sc.decay < 0) {
    drawStar(main, L, sc, qc, rs);
    return;
  }
  const lc = L.layer.getContext("2d");
  const nc = L.noiseMasked.getContext("2d");
  if (!lc || !nc) return;
  drawStar(lc, L, sc, qc, rs);
  const removal = ensureRemoval(L, sc.decay);
  lc.save();
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = "destination-out";
  lc.drawImage(removal, 0, 0);
  lc.restore();
  // Rauschen nur dort, wo der Stern schon fehlt
  nc.setTransform(1, 0, 0, 1, 0, 0);
  nc.clearRect(0, 0, L.w, L.h);
  drawNoise(nc, L);
  nc.save();
  nc.globalCompositeOperation = "destination-in";
  nc.drawImage(removal, 0, 0);
  nc.restore();
  main.setTransform(1, 0, 0, 1, 0, 0);
  main.clearRect(0, 0, L.w, L.h);
  main.drawImage(L.noiseMasked, 0, 0);
  main.drawImage(L.layer, 0, 0);
}

/* ── Komponente ─────────────────────────────────────────── */

/** Bildzeit-Vorlauf (E.3): ein Bild später sichtbar */
const FRAME_LEAD_S = 0.0167;
/** Zeitkonstante der geglätteten Belichtung (ln n) */
export const EXPOSURE_TAU_S = 0.4;

/** Ein Schritt der geglätteten Belichtung: ln n_disp folgt ln n mit τ (rein) */
export function smoothExposure(nDisp: number, nTarget: number, dtS: number, tauS = EXPOSURE_TAU_S): number {
  const lo = 1e-6;
  const a = Math.log(Math.max(lo, nDisp));
  const b = Math.log(Math.max(lo, nTarget));
  const k = 1 - Math.exp(-Math.max(0, dtS) / tauS);
  return Math.exp(a + (b - a) * k);
}

export function StarCanvas({ model, mode, modeSince, reduced, quality }: StarCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const props = useRef({ model, mode, modeSince, reduced, quality });
  props.current = { model, mode, modeSince, reduced, quality };
  const layers = useRef<Layers | null>(null);
  /** Render-Zustand: geglättete Belichtung, Strobo-Phase, letzte Zeit, Modell/Modus zum Einrasten */
  const loop = useRef({ nDisp: -1, phiVis: LOGO_PHASE, lastT: -1, model: null as SpinModel | null, mode: "" as ObsMode | "" });
  const qc = qualityConfig(quality, typeof window !== "undefined" ? window.devicePixelRatio : 1);
  const dpr = qc.dprSchirm;

  // Größe je Pixeldichte; Zwischenspeicher neu
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const L = makeLayers(dpr);
    c.width = L.w;
    c.height = L.h;
    layers.current = L;
  }, [dpr]);

  // Nach Moduswechsel 2 s keine Bilder für die Qualitätsautomatik werten
  useEffect(() => {
    holdQualityJudging();
  }, [mode]);

  const draw = useCallback(() => {
    const c = ref.current;
    const L = layers.current;
    if (!c || !L) return;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D nicht verfügbar");
    const p = props.current;
    const t = sound.clock.now();
    const tb = t + FRAME_LEAD_S;
    const f = p.model.freqAt(tb);
    const S = loop.current;
    const nT = exposureTurns(f);
    const dt = S.lastT < 0 ? 0 : Math.min(0.25, Math.max(0, t - S.lastT));
    const snap = S.nDisp < 0 || S.model !== p.model || p.reduced || (S.mode !== p.mode && (p.mode === "idle" || p.mode === "installed" || p.mode === "lost"));
    S.nDisp = snap ? nT : smoothExposure(S.nDisp, nT, dt);
    S.phiVis += strobeVisFreq(f) * dt;
    S.lastT = t;
    S.model = p.model;
    S.mode = p.mode;
    // Fehler: Standbild bei der Phase des Fehlerzeitpunkts (der Stern „dreht“ für die Anzeige nicht weiter)
    const phi = p.mode === "error" ? p.model.phaseAt(p.modeSince) : p.model.phaseAt(tb);
    const sc = sceneFor(p.mode, (t - p.modeSince) * 1000, phi, f, p.reduced, S.nDisp);
    render(ctx, L, sc, qualityConfig(p.quality, L.dpr), { phiVis: S.phiVis });
  }, []);

  // Laufend zeichnen, außer im Standbild (Zeichen, Signal verloren); reduziert nur selten (Zustandswechsel)
  const still = mode === "installed" || mode === "lost";
  const fps = reduced ? 4 : qc.fps;
  useFrameLoop(
    (_now, _dt, gap) => {
      const t0 = performance.now();
      draw();
      if (!props.current.reduced) reportFrame(performance.now() - t0, gap);
    },
    !still,
    fps,
  );
  // Einmal sofort zeichnen (Standbild, Moduswechsel, Größe)
  useEffect(() => {
    draw();
  }, [draw, mode, modeSince, reduced, quality, dpr, model]);

  return <canvas ref={ref} width={STAR_CANVAS_W} height={STAR_CANVAS_H} aria-hidden="true" className="block" style={{ width: STAR_CANVAS_W, height: STAR_CANVAS_H }} data-testid="star-canvas" data-mode={mode} />;
}
