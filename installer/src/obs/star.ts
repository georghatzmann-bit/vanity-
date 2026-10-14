/**
 * Neutronenstern (Spec F.3), rein: Geometrie, Projektion, Belichtung, Stroboskop, Wandlung.
 * Orthografisch, x rechts, y oben, z zum Betrachter (= Erde, Sichtlinie +z).
 */
import { MARK_GEOMETRY } from "@shared/ui/PulsarMark";
import type { Quality } from "./types";

export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

/** Konstanten */
export const ZETA_DEG = 50; // Neigung der Drehachse gegen die Sichtlinie
export const ALPHA_DEG = 45; // Winkel Magnetachse ↔ Drehachse
export const IMAGE_ROT_DEG = -35; // Bilddrehung um z
export const RHO_DEG = 9; // halber Öffnungswinkel des Strahlkegels
export const KAPPA_DEG = 8; // Winkelradius der Polkappen
export const BEAM_LEN = 2.5; // Strahllänge in R★
export const FIELD_L = [1.6, 2.2, 3.0] as const;
export const FIELD_CHI_DEG = [0, 90, 180, 270] as const;
export const LOGO_PHASE = 0.5;
export const STAR_CENTER: [number, number] = [210, 232];
export const STAR_R = 58;
/** Lichtscheibe ab γ < 12°, Blitzen nur bis 2,5 Hz */
export const DISC_GAMMA_DEG = 12;
export const FLASH_MAX_HZ = 2.5;

/* ── Vektoren ─────────────────────────────────────────────── */
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const rotZ = (v: Vec3, a: number): Vec3 => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]];

export interface Basis {
  /** Drehachse Ω̂ */
  omega: Vec3;
  e1: Vec3;
  e2: Vec3;
}

/** Ω̂, ê₁, ê₂ nach der Bilddrehung R_z(−35°) */
export function basis(zetaDeg = ZETA_DEG, rotDeg = IMAGE_ROT_DEG): Basis {
  const z = zetaDeg * DEG;
  const r = rotDeg * DEG;
  return {
    omega: rotZ([0, Math.sin(z), Math.cos(z)], r),
    e1: rotZ([-1, 0, 0], r),
    e2: rotZ([0, -Math.cos(z), Math.sin(z)], r),
  };
}
const B = basis();

/** Drehphase φ (Umdrehungen) → ψ = 2π·φ + π/2 */
export function psiForPhase(phi: number): number {
  return 2 * Math.PI * phi + Math.PI / 2;
}

/** Magnetachse m(ψ) = cos α·Ω̂ + sin α·(cos ψ·ê₁ + sin ψ·ê₂) */
export function magneticAxis(psi: number, b: Basis = B, alphaDeg = ALPHA_DEG): Vec3 {
  const a = alphaDeg * DEG;
  return add(scale(b.omega, Math.cos(a)), scale(add(scale(b.e1, Math.cos(psi)), scale(b.e2, Math.sin(psi))), Math.sin(a)));
}

/** Winkel (Grad) zwischen Vektor und Sichtlinie +z */
export function angleToSight(v: Vec3): number {
  const n = norm(v);
  return Math.acos(Math.max(-1, Math.min(1, n[2]))) / DEG;
}

export interface Projected {
  x: number;
  y: number;
  z: number;
}

/** Bildschirmpunkt = Mitte + R·(x, −y) */
export function project(v: Vec3, center: [number, number] = STAR_CENTER, r = STAR_R): Projected {
  return { x: center[0] + r * v[0], y: center[1] - r * v[1], z: v[2] };
}

/** Projizierter Winkel (Grad, im Uhrzeigersinn ab senkrecht) eines Vektors */
export function projectedAngle(v: Vec3): number {
  return Math.atan2(v[0], v[1]) / DEG;
}

/* ── Feldlinien ──────────────────────────────────────────── */
export interface FieldPoint extends Projected {
  /** Abstand zur Sternmitte (in R★) */
  r: number;
  /** liegt hinter der Scheibe (z < 0 und innerhalb des Umrisses) → nicht zeichnen */
  hidden: boolean;
}

/**
 * Dipol-Feldlinie r(θ) = L·sin²θ im Magnetsystem, Azimut χ.
 * θ von asin(1/√L) bis π − asin(1/√L), Basis u₁ = norm(Ω̂ × m), u₂ = m × u₁.
 */
export function dipolePoints(L: number, chiDeg: number, m: Vec3, n = 40, b: Basis = B): FieldPoint[] {
  const u1 = norm(cross(b.omega, m));
  const u2 = cross(m, u1);
  const chi = chiDeg * DEG;
  const side = add(scale(u1, Math.cos(chi)), scale(u2, Math.sin(chi)));
  const t0 = Math.asin(1 / Math.sqrt(L));
  const out: FieldPoint[] = [];
  for (let i = 0; i < n; i++) {
    const th = t0 + ((Math.PI - 2 * t0) * i) / (n - 1);
    const r = L * Math.sin(th) ** 2;
    const v = scale(add(scale(m, Math.cos(th)), scale(side, Math.sin(th))), r);
    const p = project(v);
    out.push({ ...p, r, hidden: v[2] < 0 && v[0] * v[0] + v[1] * v[1] < 1 });
  }
  return out;
}

/* ── Strahl und Kappen ───────────────────────────────────── */
export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Drehung der rx-Achse (rad, Canvas-Konvention) */
  rotation: number;
}

/** Bildschirm-Einheitsvektor senkrecht zur projizierten Achse (liegt in 3D senkrecht zu m) */
function perpInPlane(m: Vec3): Vec3 {
  const l = Math.hypot(m[0], m[1]);
  return l < 1e-9 ? [1, 0, 0] : [-m[1] / l, m[0] / l, 0];
}

/** Projizierter Kreis (Radius rad, Mittelpunkt c auf der Achse m) */
function circleEllipse(c: Vec3, m: Vec3, rad: number, center: [number, number], r: number): Ellipse {
  const w = perpInPlane(m);
  const p = project(c, center, r);
  // rx entlang w; Bildschirm-y ist gespiegelt
  return { cx: p.x, cy: p.y, rx: rad * r, ry: rad * Math.abs(m[2]) * r, rotation: Math.atan2(-w[1], w[0]) };
}

export interface BeamQuad {
  /** Viereck: Oberfläche ±, Ende ± (Bildschirm) */
  quad: [Projected, Projected, Projected, Projected];
  end: Ellipse;
  /** z des Strahlendes (Vorder-/Rückseite) */
  z: number;
}

/** Strahlkegel (ρ 9°) von r = 1 bis 2,5 R★ als Viereck mit Endellipse */
export function beamQuad(m: Vec3, center: [number, number] = STAR_CENTER, r = STAR_R, rhoDeg = RHO_DEG, len = BEAM_LEN): BeamQuad {
  const t = Math.tan(rhoDeg * DEG);
  const w = perpInPlane(m);
  const near = m;
  const far = scale(m, len);
  const q = (base: Vec3, s: number) => project(add(base, scale(w, s)), center, r);
  return {
    quad: [q(near, t), q(far, len * t), q(far, -len * t), q(near, -t)],
    end: circleEllipse(far, m, len * t, center, r),
    z: far[2],
  };
}

/** Polkappe um ±m (Winkelradius κ 8°); Deckkraft 0,7·max(0, ±m_z) */
export function capEllipse(m: Vec3, sign: 1 | -1 = 1, center: [number, number] = STAR_CENTER, r = STAR_R, kappaDeg = KAPPA_DEG): Ellipse & { alpha: number; visible: boolean } {
  const k = kappaDeg * DEG;
  const axis = scale(m, sign);
  const e = circleEllipse(scale(axis, Math.cos(k)), axis, Math.sin(k), center, r);
  const mz = axis[2];
  return { ...e, alpha: 0.7 * Math.max(0, mz), visible: mz > 0 };
}

/** Lichtscheibe (Puls): bei γ < 12° eine flache Ellipse mit Deckkraft 0,45·exp(−(γ/6°)²) */
export function pulseDisc(m: Vec3, f: number): { visible: boolean; gamma: number; alpha: number; ellipse: Ellipse } {
  const gamma = angleToSight(m);
  const ellipse = beamQuad(m).end;
  if (!flashAllowed(f)) return { visible: true, gamma, alpha: 0.18, ellipse };
  return { visible: gamma < DISC_GAMMA_DEG, gamma, alpha: gamma < DISC_GAMMA_DEG ? 0.45 * Math.exp(-((gamma / 6) ** 2)) : 0, ellipse };
}

/** Blitzschutz: Blitzen nur bei f ≤ 2,5 Hz (≤ 3 Blitze pro Sekunde) */
export function flashAllowed(f: number): boolean {
  return f <= FLASH_MAX_HZ;
}

/* ── Virtuelle Kamera ────────────────────────────────────── */
const smooth = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

/** Belichtete Umdrehungen n(f): f/60 bis 0,75 Hz, 2 ab 2,5 Hz, dazwischen ln n per smoothstep in ln f */
export function exposureTurns(f: number): number {
  if (f <= 0.75) return Math.max(0, f) / 60;
  if (f >= 2.5) return 2;
  const s = smooth((Math.log(f) - Math.log(0.75)) / (Math.log(2.5) - Math.log(0.75)));
  const a = Math.log(0.75 / 60);
  return Math.exp(a + (Math.log(2) - a) * s);
}

/** Belichtungszeit (s) zur Frequenz: n/f */
export function exposureTime(f: number): number {
  return f > 0 ? exposureTurns(f) / f : 1 / 60;
}

const SAMPLE_CAP: Record<Quality, number> = { 0: 12, 1: 30, 2: 60 };
/** Samples über den belichteten Bogen, Abstand ≤ 6° */
export function sampleCount(n: number, quality: Quality = 2): number {
  return Math.max(1, Math.min(Math.ceil((360 * n) / 6), SAMPLE_CAP[quality]));
}

/** Deckkraft der Belichtungsebene A(n) */
export function exposureAlpha(n: number, f: number): number {
  if (n < 1) return 0.16 - 0.06 * Math.max(0, n);
  const u = Math.min(1, Math.max(0, Math.log(f / 2.5) / Math.log(173.7 / 2.5)));
  return 0.1 + 0.1 * u;
}

/** Verwischung drehender Linien (Meridiane, Feldlinien): w(n) = 1/(1 + 2n) */
export function blurWeight(n: number): number {
  return 1 / (1 + 2 * n);
}

const easeOutCubic = (u: number) => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3;
export const easeInOutCubic = (u: number) => {
  const x = Math.min(1, Math.max(0, u));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/** Stroboskop: Fenster um φ_L = ⌊φ⌋ + 0,5, Breite 2 → 0 in 800 ms (easeOutCubic) */
export function strobeWindow(phi: number, elapsedMs: number, durMs = 800): { center: number; width: number; from: number; to: number } {
  const center = Math.floor(phi) + LOGO_PHASE;
  const width = 2 * (1 - easeOutCubic(elapsedMs / durMs));
  return { center, width, from: center - width / 2, to: center + width / 2 };
}

/* ── Wandlung Stern → Zeichen ───────────────────────────── */
export interface MorphParams {
  /** Ring-/Randradius (px) */
  ringR: number;
  ringWidth: number;
  ringAlpha: number;
  /** Gradnetz und Feldlinien */
  gridAlpha: number;
  fieldAlpha: number;
  /** Kernradius (px) */
  coreR: number;
  /** 0 = ein Strahl, 1 = acht Haarstrahlen (±5,6°) */
  raySplit: number;
}

const MARK_SIZE = 220;
const S_MARK = MARK_SIZE / MARK_GEOMETRY.VIEWBOX;
export const STAR_PARAMS: MorphParams = { ringR: STAR_R, ringWidth: 1, ringAlpha: 0.35, gridAlpha: 1, fieldAlpha: 1, coreR: 0, raySplit: 0 };
export const MARK_PARAMS: MorphParams = {
  ringR: MARK_GEOMETRY.RING_R * S_MARK,
  ringWidth: MARK_GEOMETRY.ringStroke(MARK_SIZE, "rays") * S_MARK,
  ringAlpha: 1,
  gridAlpha: 0,
  fieldAlpha: 0,
  coreR: MARK_GEOMETRY.CORE_R * S_MARK,
  raySplit: 1,
};
export const MARK_SIZE_PX = MARK_SIZE;

/** markMorph(t): t 0 → Stern, 1 → Zeichen (220 px bei (210, 232)); umgekehrt bei `un-run` */
export function markMorph(t: number): MorphParams {
  const e = easeInOutCubic(t);
  const lerp = (a: number, b: number) => a + (b - a) * e;
  const k = Object.keys(STAR_PARAMS) as (keyof MorphParams)[];
  return Object.fromEntries(k.map((key) => [key, lerp(STAR_PARAMS[key], MARK_PARAMS[key])])) as unknown as MorphParams;
}
