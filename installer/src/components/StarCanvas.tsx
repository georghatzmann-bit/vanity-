/**
 * Neutronenstern im Schirm (F.3), Canvas 2D, 380 × 320 bei Fenster (20, 72), Sternmitte (210, 232).
 * Belichtungskamera statt Zeitlupe: Strahl- und Kappen-Samples über den belichteten Bogen werden als
 * Vereinigungsmenge mit einer Deckkraft eingesetzt (ab einer vollen Umdrehung zwischengespeichert:
 * die Sanduhr ist drehinvariant). Stroboskop, Wandlung zum Zeichen, Bayer-Zerfall.
 * Kein Verlauf, keine Unschärfe, keine additive Mischung, keine Filter. Werte liegen in Refs.
 */
import { useCallback, useEffect, useRef } from "react";
import type { SpinModel } from "@shared/sound/spin";
import { sound, F_STAR } from "@shared/sound/engine";
import { MARK_GEOMETRY } from "@shared/ui/PulsarMark";
import { useFrameLoop } from "../hooks/useFrameLoop";
import { qualityConfig, reportFrame, type QualityConfig } from "../hooks/useQuality";
import { decayBeamAlpha, UNINSTALL_TIMING, DONE_TIMING } from "../hooks/useObservatory";
import { REFERENCES } from "../obs/catalog";
import { bayerLevel, bayerMask } from "../obs/dither";
import { mulberry32 } from "../obs/rng";
import {
  basis, beamQuad, blurWeight, capEllipse, dipolePoints, exposureAlpha, exposureTurns, FIELD_CHI_DEG, FIELD_L, flashAllowed, KAPPA_DEG, LOGO_PHASE, magneticAxis, markMorph,
  MARK_SIZE_PX, psiForPhase, pulseDisc, sampleCount, STAR_CENTER, STAR_R, ALPHA_DEG, BEAM_LEN, type Ellipse, type MorphParams, type Projected, type Vec3,
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

export type CameraKind = "exposure" | "strobe" | "still" | "none";

export interface Scene {
  /** Phase/Frequenz des Modells zur Bildzeit */
  phi: number;
  f: number;
  /** belichtetes Fenster in Umdrehungen; `sharp` = Phase des scharf gezeichneten Strahls (n < 1) */
  from: number;
  to: number;
  width: number;
  sharp: number | null;
  /** Deckkraft der Belichtungsebene (A(n) × Faktoren) */
  expAlpha: number;
  /** Faktor für alles, was Strahl ist (Fläche, Kanten, Lichtscheibe) */
  beamAlpha: number;
  dashed: boolean;
  caps: boolean;
  disc: "flash" | "steady" | "none";
  fieldMul: number;
  /** w(n) für Meridiane und Feldlinien */
  blur: number;
  morph: MorphParams | null;
  /** Bayer-Stufe 0…16 (−1 = kein Zerfall) */
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

/**
 * Szene zu Modus und Zeit (F.3, F.5, G.1, G.2, H). `elapsedMs` = Zeit seit `modeSince`.
 */
export function sceneFor(mode: ObsMode, elapsedMs: number, phiIn: number, f: number, reduced: boolean): Scene {
  const base: Scene = {
    phi: phiIn, f, from: phiIn, to: phiIn, width: 0, sharp: phiIn, expAlpha: 0.16, beamAlpha: 1, dashed: false, caps: true, disc: "none",
    fieldMul: 1, blur: 1, morph: null, bayer: -1, noiseOnly: false, camera: "exposure",
  };
  if (mode === "lost" || (mode === "decay" && reduced)) return { ...base, noiseOnly: true, camera: "none", caps: false };

  // Standbild (reduzierte Bewegung): Logo-Phase, keine Belichtung, kein Blitzen
  const still = (phi: number): Scene => {
    const p = Math.floor(phi) + LOGO_PHASE;
    return { ...base, phi: p, from: p, to: p, sharp: p, camera: "still" };
  };
  // Stroboskop: Fenster um die Logo-Phase
  const strobe = (width: number): Scene => {
    const c = Math.floor(phiIn) + LOGO_PHASE;
    const w = Math.max(0, width);
    return { ...base, phi: c, from: c - w / 2, to: c + w / 2, width: w, sharp: w < 1 ? c : null, expAlpha: exposureAlpha(w, F_STAR), blur: blurWeight(w), camera: "strobe" };
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
    const n = exposureTurns(f);
    s = { ...base, from: phiIn - n, to: phiIn, width: n, sharp: n < 1 ? phiIn : null, expAlpha: exposureAlpha(n, f), blur: blurWeight(n), disc: flashAllowed(f) ? "flash" : "steady" };
  }
  if (mode === "uninstalling" || mode === "release" || mode === "decay") s.fieldMul = 0.4 + 0.6 * driveFromFreq(f);
  if (mode === "halted") s.beamAlpha = 0.5;
  if (mode === "error") {
    s.dashed = true;
    s.beamAlpha = 0.4;
    s.expAlpha *= 0.3;
    s.fieldMul *= 0.3;
    s.caps = false;
    s.disc = "none";
  }
  if (mode === "decay") {
    s.beamAlpha = decayBeamAlpha(elapsedMs);
    const u = (elapsedMs - UNINSTALL_TIMING.decayFromMs) / (UNINSTALL_TIMING.decayToMs - UNINSTALL_TIMING.decayFromMs);
    s.bayer = u <= 0 ? -1 : bayerLevel(u);
  }
  if (reduced) s.disc = "none";
  return s;
}

/* ── Zeichnen ───────────────────────────────────────────── */

const SIG = (a: number) => `rgba(242,213,60,${a.toFixed(3)})`;
const FG = (a: number) => `rgba(230,232,235,${a.toFixed(3)})`;
const FG2 = (a: number) => `rgba(168,174,184,${a.toFixed(3)})`;
const SPHERE = "#0C0E11";
const DEG = Math.PI / 180;
const B = basis();
const [CX, CY] = STAR_CENTER;

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

function ellipsePath(ctx: Ctx, e: Ellipse) {
  ctx.moveTo(e.cx + e.rx * Math.cos(e.rotation), e.cy + e.rx * Math.sin(e.rotation));
  ctx.ellipse(e.cx, e.cy, Math.max(0.01, e.rx), Math.max(0.01, e.ry), e.rotation, 0, Math.PI * 2, false);
}

/** Viereck im Uhrzeigersinn (Bildschirm), damit die Vereinigung mit „nonzero“ keine Löcher bekommt */
function quadPath(ctx: Ctx, q: readonly Projected[]) {
  const area = (q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[2].x - q[0].x) * (q[1].y - q[0].y);
  const pts = area >= 0 ? q : [q[0], q[3], q[2], q[1]];
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** Beide Strahlen (±m) einer Phase in die Pfade „hinten“/„vorn“ legen */
function addBeams(back: Ctx, front: Ctx, phi: number, withCaps: boolean) {
  const m = magneticAxis(psiForPhase(phi));
  for (const s of [1, -1] as const) {
    const axis: Vec3 = [m[0] * s, m[1] * s, m[2] * s];
    const bq = beamQuad(axis);
    const ctx = axis[2] < 0 ? back : front;
    quadPath(ctx, bq.quad);
    ellipsePath(ctx, bq.end);
    if (withCaps) {
      const cap = capEllipse(axis, 1);
      if (cap.visible) ellipsePath(front, cap);
    }
  }
}

/** Kugelpunkte um Ω̂: Breite β, Länge λ (rad) */
function spherePoint(beta: number, lambda: number): Vec3 {
  const cb = Math.cos(beta);
  const cl = Math.cos(lambda);
  const sl = Math.sin(lambda);
  const sb = Math.sin(beta);
  return [cb * (cl * B.e1[0] + sl * B.e2[0]) + sb * B.omega[0], cb * (cl * B.e1[1] + sl * B.e2[1]) + sb * B.omega[1], cb * (cl * B.e1[2] + sl * B.e2[2]) + sb * B.omega[2]];
}

/** Polylinie nur dort, wo `keep` gilt (Abschnitte) */
function strokeRuns(ctx: Ctx, pts: { x: number; y: number }[], keep: (i: number) => boolean) {
  let open = false;
  for (let i = 0; i < pts.length; i++) {
    if (keep(i)) {
      if (!open) ctx.moveTo(pts[i].x, pts[i].y);
      else ctx.lineTo(pts[i].x, pts[i].y);
      open = true;
    } else open = false;
  }
}

/** Kreis um Ω̂ in Kolatitude θ (Rad) mit Radius r (R★), z.B. Rand des Sanduhr-Kegels */
function axisCircle(theta: number, r: number, n: number): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const v = spherePoint(Math.PI / 2 - theta, (2 * Math.PI * i) / n);
    out.push({ x: CX + STAR_R * r * v[0], y: CY - STAR_R * r * v[1], z: v[2] });
  }
  return out;
}

interface Layers {
  dpr: number;
  w: number;
  h: number;
  /** Vereinigung der Samples dieses Bildes */
  uBack: HTMLCanvasElement;
  uFront: HTMLCanvasElement;
  /** volle Umdrehung (Sanduhr), einmal je Größe */
  fullBack: HTMLCanvasElement | null;
  fullFront: HTMLCanvasElement | null;
  /** Zerfall */
  layer: HTMLCanvasElement;
  noiseMasked: HTMLCanvasElement;
  noise: HTMLCanvasElement | null;
  masks: (CanvasPattern | null)[];
}

function makeLayers(dpr: number): Layers {
  const w = Math.round(STAR_CANVAS_W * dpr);
  const h = Math.round(STAR_CANVAS_H * dpr);
  return { dpr, w, h, uBack: mk(w, h), uFront: mk(w, h), fullBack: null, fullFront: null, layer: mk(w, h), noiseMasked: mk(w, h), noise: null, masks: [] };
}

function fillUnion(back: HTMLCanvasElement, front: HTMLCanvasElement, dpr: number, phases: number[], withCaps: boolean) {
  const b = back.getContext("2d");
  const f = front.getContext("2d");
  if (!b || !f) return;
  for (const c of [b, f]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, back.width, back.height);
    toWindow(c, dpr);
    c.beginPath();
  }
  for (const p of phases) addBeams(b, f, p, withCaps);
  b.fillStyle = f.fillStyle = "#F2D53C";
  b.fill("nonzero");
  f.fill("nonzero");
}

function ensureFull(L: Layers) {
  if (L.fullBack && L.fullFront) return;
  L.fullBack = mk(L.w, L.h);
  L.fullFront = mk(L.w, L.h);
  const n = 120; // 3° Abstand, einmalig
  fillUnion(L.fullBack, L.fullFront, L.dpr, Array.from({ length: n }, (_, i) => i / n), false);
}

/** Rauschkachel (CSS-px-Korn) und Bayer-Muster je Stufe, in Geräte-Pixeln */
function ensureNoise(L: Layers) {
  if (L.noise) return;
  const k = Math.max(1, Math.round(L.dpr));
  const size = 128;
  const c = mk(size * k, size * k);
  const ctx = c.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size * k, size * k);
    const rnd = mulberry32(0x1919);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const a = Math.round(rnd() * 255 * 0.16); // Mittel 0,08
        for (let dy = 0; dy < k; dy++)
          for (let dx = 0; dx < k; dx++) {
            const i = ((y * k + dy) * size * k + x * k + dx) * 4;
            img.data[i] = 230;
            img.data[i + 1] = 232;
            img.data[i + 2] = 235;
            img.data[i + 3] = a;
          }
      }
    ctx.putImageData(img, 0, 0);
  }
  L.noise = c;
}

function maskPattern(ctx: Ctx, L: Layers, level: number): CanvasPattern | null {
  if (L.masks[level] !== undefined) return L.masks[level];
  const k = Math.max(1, Math.round(L.dpr));
  const c = mk(4 * k, 4 * k);
  const g = c.getContext("2d");
  if (g) {
    const m = bayerMask(level);
    g.fillStyle = "#000";
    for (let i = 0; i < 16; i++) if (m[i]) g.fillRect((i % 4) * k, Math.floor(i / 4) * k, k, k);
  }
  const p = ctx.createPattern(c, "repeat");
  L.masks[level] = p;
  return p;
}

function drawNoise(ctx: Ctx, L: Layers) {
  ensureNoise(L);
  if (!L.noise) return;
  const p = ctx.createPattern(L.noise, "repeat");
  if (!p) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = p;
  ctx.fillRect(0, 0, L.w, L.h);
  ctx.restore();
}

/** Ganze Szene in einen Kontext (Fenster-Koordinaten) */
function drawStar(ctx: Ctx, L: Layers, sc: Scene, qc: QualityConfig) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, L.w, L.h);
  toWindow(ctx, L.dpr);
  ctx.lineJoin = "round";
  const mp = sc.morph;
  const gridA = mp ? mp.gridAlpha : 1;
  const fieldA = (mp ? mp.fieldAlpha : 1) * sc.fieldMul;
  const split = mp ? mp.raySplit : 0;
  const beamA = sc.beamAlpha;

  // Phase des scharfen Strahls (bzw. aktuelle Phase)
  const phiS = sc.sharp ?? sc.to;
  const m = magneticAxis(psiForPhase(phiS));

  // Belichtungsebenen vorbereiten
  const full = sc.width >= 1;
  let back: HTMLCanvasElement | null = null;
  let front: HTMLCanvasElement | null = null;
  if (beamA > 0 && sc.expAlpha > 0 && split < 1) {
    if (full) {
      ensureFull(L);
      back = L.fullBack;
      front = L.fullFront;
    } else {
      const n = Math.min(sampleCount(sc.width), qc.samples);
      const phases = n <= 1 ? [phiS] : Array.from({ length: n }, (_, i) => sc.from + ((sc.to - sc.from) * i) / (n - 1));
      fillUnion(L.uBack, L.uFront, L.dpr, phases, sc.caps && gridA > 0);
      back = L.uBack;
      front = L.uFront;
    }
  }
  const unionA = sc.expAlpha * beamA * (1 - split);
  const putUnion = (c: HTMLCanvasElement | null) => {
    if (!c || unionA <= 0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = unionA;
    ctx.drawImage(c, 0, 0);
    ctx.restore();
  };

  // Feldlinien (Dipol)
  const fieldPass = (wantFront: boolean, alpha: number) => {
    if (alpha <= 0.002) return;
    if (!wantFront && qc.fieldFrontOnly) return;
    const chis = qc.fieldLines === 12 ? FIELD_CHI_DEG : ([0, 180] as const);
    ctx.beginPath();
    for (const L0 of FIELD_L)
      for (const chi of chis) {
        const pts = dipolePoints(L0, chi, m, 40);
        strokeRuns(ctx, pts, (i) => (wantFront ? pts[i].z >= 0 : pts[i].z < 0 && !pts[i].hidden));
      }
    ctx.strokeStyle = FG2(alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  // Scharfe Kanten des aktuellen Strahls (n < 1) bzw. gestrichelter Umriss (Fehler)
  const edges = (wantFront: boolean) => {
    if (sc.sharp === null || beamA <= 0 || split >= 1) return;
    const a = (sc.dashed ? 1 : 0.6) * beamA * (1 - split);
    ctx.beginPath();
    for (const s of [1, -1] as const) {
      const axis: Vec3 = [m[0] * s, m[1] * s, m[2] * s];
      if (axis[2] < 0 === wantFront) continue;
      const q = beamQuad(axis).quad;
      ctx.moveTo(q[0].x, q[0].y);
      ctx.lineTo(q[1].x, q[1].y);
      ctx.moveTo(q[2].x, q[2].y);
      ctx.lineTo(q[3].x, q[3].y);
      ellipsePath(ctx, beamQuad(axis).end);
    }
    ctx.strokeStyle = SIG(a);
    ctx.lineWidth = 1;
    if (sc.dashed) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Rand der hohlen Kegel (Sanduhr, n ≥ 1): Ort der Strahlenden über eine Umdrehung
  const rims = (wantFront: boolean) => {
    if (!full || beamA <= 0 || split >= 1) return;
    const a = (sc.dashed ? 1 : Math.min(0.5, sc.expAlpha * 2.2)) * beamA * (1 - split);
    ctx.beginPath();
    for (const theta of [ALPHA_DEG * DEG, Math.PI - ALPHA_DEG * DEG]) {
      const pts = axisCircle(theta, BEAM_LEN, 64);
      strokeRuns(ctx, pts, (i) => (wantFront ? pts[i].z >= 0 : pts[i].z < 0));
    }
    ctx.strokeStyle = SIG(a);
    ctx.lineWidth = 1;
    if (sc.dashed) ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // 1 hintere Feldlinien
  fieldPass(false, 0.08 * sc.blur * fieldA);
  // 2 hintere Belichtungsebene (Fehler: × 0,3 steckt in expAlpha)
  putUnion(back);
  rims(false);
  edges(false);

  // 3 Sternscheibe (flach), Rand 1 px fg 35 %
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

  // 4 Gradnetz um Ω̂
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
    ctx.strokeStyle = FG(0.18 * gridA);
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
      ctx.strokeStyle = FG(0.18 * wMer);
      ctx.stroke();
    }
  }

  // 5 Polkappen (aktuelle Phase scharf; n ≥ 1: Breitenringe in Kolatitude α bzw. 180° − α)
  if (sc.caps && gridA > 0.002 && beamA > 0) {
    if (full) {
      const a = 0.5 * sc.expAlpha * beamA * gridA;
      ctx.beginPath();
      for (const theta of [ALPHA_DEG * DEG, Math.PI - ALPHA_DEG * DEG]) {
        const pts = axisCircle(theta, 1, 64);
        strokeRuns(ctx, pts, (i) => pts[i].z > 0);
      }
      ctx.strokeStyle = SIG(a);
      ctx.lineWidth = 2 * Math.sin(KAPPA_DEG * DEG) * STAR_R;
      ctx.lineCap = "butt";
      ctx.stroke();
    } else {
      for (const s of [1, -1] as const) {
        const cap = capEllipse([m[0] * s, m[1] * s, m[2] * s], 1);
        if (!cap.visible || cap.alpha <= 0) continue;
        ctx.beginPath();
        ellipsePath(ctx, cap);
        ctx.fillStyle = SIG(cap.alpha * beamA * gridA);
        ctx.fill();
      }
    }
  }

  // 6 vordere Feldlinien
  fieldPass(true, 0.22 * sc.blur * fieldA);
  // 7 vordere Belichtungsebene
  putUnion(front);
  rims(true);
  edges(true);

  // 8 Lichtscheibe (Blitzschutz: nur bis 2,5 Hz blitzen, darüber ruhig 0,18)
  if (sc.disc !== "none" && beamA > 0 && split <= 0) {
    let e: Ellipse | null = null;
    let a = 0;
    if (sc.disc === "flash") {
      const d = pulseDisc(m, sc.f);
      if (d.visible && d.alpha > 0.004) {
        e = d.ellipse;
        a = d.alpha;
      }
    } else {
      // ruhige Scheibe am Ort des nächsten Durchgangs (Phase ganzzahlig)
      e = beamQuad(magneticAxis(psiForPhase(0))).end;
      a = 0.18;
    }
    if (e) {
      ctx.beginPath();
      ellipsePath(ctx, e);
      ctx.fillStyle = SIG(a * beamA);
      ctx.fill();
      ctx.strokeStyle = SIG(Math.min(0.9, 2 * a) * beamA);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 9 Wandlung zum Zeichen: Haarstrahlen, Ring, Kern
  if (mp && split > 0) {
    const sMark = MARK_SIZE_PX / MARK_GEOMETRY.VIEWBOX;
    const e = split;
    for (const s of [1, -1] as const) {
      const axis: Vec3 = [m[0] * s, m[1] * s, m[2] * s];
      const len = Math.hypot(axis[0], axis[1]);
      const ang = Math.atan2(axis[0], axis[1]) / DEG; // im Uhrzeigersinn ab senkrecht
      const r0 = len * STAR_R;
      const r1 = len * STAR_R * BEAM_LEN;
      ctx.beginPath();
      for (let k = 0; k < MARK_GEOMETRY.RAYS_PER_BEAM; k++) {
        const th = (ang + (k - 3.5) * MARK_GEOMETRY.RAY_SPREAD * e) * DEG;
        const rin = r0 + (MARK_GEOMETRY.RAY_IN * sMark - r0) * e;
        const rout = r1 + (MARK_GEOMETRY.RAY_OUT(k) * sMark - r1) * e;
        ctx.moveTo(CX + rin * Math.sin(th), CY - rin * Math.cos(th));
        ctx.lineTo(CX + rout * Math.sin(th), CY - rout * Math.cos(th));
      }
      ctx.strokeStyle = SIG(0.6 + 0.4 * e);
      ctx.lineWidth = 1 + (MARK_GEOMETRY.rayStroke(MARK_SIZE_PX) * sMark - 1) * e;
      ctx.lineCap = "round";
      ctx.stroke();
    }
  }
  if (mp) {
    ctx.beginPath();
    ctx.arc(CX, CY, mp.ringR, 0, Math.PI * 2);
    ctx.strokeStyle = FG(mp.ringAlpha);
    ctx.lineWidth = mp.ringWidth;
    ctx.stroke();
  }
  if (mp && mp.coreR > 0.05) {
    ctx.beginPath();
    ctx.arc(CX, CY, mp.coreR, 0, Math.PI * 2);
    ctx.fillStyle = SIG(Math.min(1, mp.coreR / 4));
    ctx.fill();
  }
  ctx.lineCap = "butt";
}

/** Bild zusammensetzen (mit Bayer-Zerfall) */
function render(main: Ctx, L: Layers, sc: Scene, qc: QualityConfig) {
  if (sc.noiseOnly) {
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.clearRect(0, 0, L.w, L.h);
    drawNoise(main, L);
    return;
  }
  if (sc.bayer < 0) {
    drawStar(main, L, sc, qc);
    return;
  }
  const lc = L.layer.getContext("2d");
  const nc = L.noiseMasked.getContext("2d");
  if (!lc || !nc) return;
  drawStar(lc, L, sc, qc);
  const level = sc.bayer;
  const pat = level > 0 ? maskPattern(lc, L, level) : null;
  lc.setTransform(1, 0, 0, 1, 0, 0);
  if (pat) {
    lc.globalCompositeOperation = "destination-out";
    lc.fillStyle = pat;
    lc.fillRect(0, 0, L.w, L.h);
    lc.globalCompositeOperation = "source-over";
  }
  // Rauschen nur dort, wo der Stern schon fehlt (inverses Muster)
  nc.setTransform(1, 0, 0, 1, 0, 0);
  nc.clearRect(0, 0, L.w, L.h);
  if (pat) {
    drawNoise(nc, L);
    nc.globalCompositeOperation = "destination-in";
    nc.fillStyle = maskPattern(nc, L, level) ?? pat;
    nc.fillRect(0, 0, L.w, L.h);
    nc.globalCompositeOperation = "source-over";
  }
  main.setTransform(1, 0, 0, 1, 0, 0);
  main.clearRect(0, 0, L.w, L.h);
  main.drawImage(L.noiseMasked, 0, 0);
  main.drawImage(L.layer, 0, 0);
}

/* ── Komponente ─────────────────────────────────────────── */

/** Bildzeit-Vorlauf (E.3): ein Bild später sichtbar */
const FRAME_LEAD_S = 0.0167;

export function StarCanvas({ model, mode, modeSince, reduced, quality }: StarCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const props = useRef({ model, mode, modeSince, reduced, quality });
  props.current = { model, mode, modeSince, reduced, quality };
  const layers = useRef<Layers | null>(null);
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

  const draw = useCallback(() => {
    const c = ref.current;
    const L = layers.current;
    if (!c || !L) return;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D nicht verfügbar");
    const p = props.current;
    const t = sound.clock.now();
    const tb = t + FRAME_LEAD_S;
    const sc = sceneFor(p.mode, (t - p.modeSince) * 1000, p.model.phaseAt(tb), p.model.freqAt(tb), p.reduced);
    render(ctx, L, sc, qualityConfig(p.quality, L.dpr));
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
