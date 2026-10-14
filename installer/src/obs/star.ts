/**
 * Neutronenstern (Spec F.3), rein: Geometrie, Projektion, Belichtung, Stroboskop, Wandlung.
 * Orthografisch, x rechts, y oben, z zum Betrachter (= Erde, Sichtlinie +z).
 */
import { MARK_GEOMETRY } from "@shared/ui/PulsarMark";

export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;

/** Konstanten */
export const ZETA_DEG = 50; // Neigung der Drehachse gegen die Sichtlinie
export const ALPHA_DEG = 45; // Winkel Magnetachse ↔ Drehachse
export const IMAGE_ROT_DEG = -35; // Bilddrehung um z
export const RHO_DEG = 9; // halber Öffnungswinkel des Strahlkegels
export const KAPPA_DEG = 8; // Winkelradius der Polkappen
export const BEAM_LEN = 2.0; // Strahllänge in R★ (Ringzone bei x 96–324, y 116–348: frei vom Kamera-Label)
/** Feldlinien: zwei Schalen (max. 2,1 R★ ≈ 122 px), Schleifen nur in der Ebene von Ω̂ und m */
export const FIELD_L = [1.6, 2.1] as const;
export const FIELD_CHI_DEG = [90, 270] as const;
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
/** smoothstep(e0; e1; x) */
export function smoothstep(e0: number, e1: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-9)));
  return u * u * (3 - 2 * u);
}
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

/**
 * Gewicht einer Feldlinien-Schleife: w = smoothstep(0,35; 0,7; |n_z|), n = norm(m × side).
 * Schleifen in (fast) Kanten-Ansicht blenden aus, statt als lange dünne Bögen quer durchs Bild zu stehen.
 */
export function fieldLoopWeight(chiDeg: number, m: Vec3, b: Basis = B): number {
  const u1 = norm(cross(b.omega, m));
  const u2 = cross(m, u1);
  const chi = chiDeg * DEG;
  const side = add(scale(u1, Math.cos(chi)), scale(u2, Math.sin(chi)));
  const n = norm(cross(m, side));
  return smoothstep(0.35, 0.7, Math.abs(n[2]));
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

/** Strahlkegel (ρ 9°) von r = 1 bis BEAM_LEN als offener Keil (Viereck; `end` nur noch für Tests/Geometrie) */
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

export interface Pt2 {
  x: number;
  y: number;
}

/** Zwei Einheitsvektoren senkrecht zu a (3D) */
function perpPair(a: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(a, ref));
  return [u, cross(a, u)];
}

/** Konvexe Hülle (Monotone Chain); Ergebnis im Uhrzeigersinn auf dem Bildschirm (y nach unten) */
export function convexHull(pts: Pt2[]): Pt2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o: Pt2, a: Pt2, b: Pt2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  // Monotone Chain liefert mathematisch positiv (bei y nach unten: gegen den Uhrzeigersinn) → umdrehen
  const hull = lower.concat(upper);
  return signedArea(hull) >= 0 ? hull : hull.reverse();
}

/** Vorzeichenbehaftete Fläche (Bildschirm-Koordinaten; > 0 = im Uhrzeigersinn) */
export function signedArea(pts: readonly Pt2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Exakte Silhouette des Strahl-Kegelstumpfs (ρ 9°) von r = 1 bis 2,5 R★: konvexe Hülle aus je 32 Punkten
 * des projizierten Basiskreises (Mitte axis·1, Radius tan ρ) und des Endkreises (Mitte axis·2,5, Radius 2,5·tan ρ).
 * Polygon im Uhrzeigersinn (Bildschirm), damit die Vereinigung mit „nonzero“ keine Löcher bekommt.
 */
export function beamHull(axis: Vec3, center: [number, number] = STAR_CENTER, r = STAR_R, rhoDeg = RHO_DEG, len = BEAM_LEN, n = 32): Pt2[] {
  const t = Math.tan(rhoDeg * DEG);
  const [u, v] = perpPair(axis);
  const pts: Pt2[] = [];
  for (const d of [1, len]) {
    const c = scale(axis, d);
    const rad = d * t;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const p = project(add(c, add(scale(u, rad * Math.cos(a)), scale(v, rad * Math.sin(a)))), center, r);
      pts.push({ x: p.x, y: p.y });
    }
  }
  return convexHull(pts);
}

/** Endkreis des Strahls (2,5 R★) als projizierte Ellipse – nur als Kontur, nie gefüllt */
export function beamEnd(axis: Vec3, center: [number, number] = STAR_CENTER, r = STAR_R, rhoDeg = RHO_DEG, len = BEAM_LEN): Ellipse {
  return circleEllipse(scale(axis, len), axis, len * Math.tan(rhoDeg * DEG), center, r);
}

/**
 * Füllung des einzelnen Strahls (n < 1): 0,16·(1 − smoothstep(0,6; 0,9; |m_z|)); sie verschwindet,
 * wenn der Strahl auf die Erde zeigt oder von ihr weg. Hinterer Strahl (z < 0) × 0,6.
 */
export function beamFillAlpha(axis: Vec3): number {
  return 0.16 * beamFillFactor(axis);
}

/** Faktor zu beamFillAlpha (ohne die 0,16): 1 − smoothstep(0,6; 0,9; |m_z|), hinten × 0,6 */
export function beamFillFactor(axis: Vec3): number {
  const a = 1 - smoothstep(0.6, 0.9, Math.abs(axis[2]));
  return axis[2] < 0 ? 0.6 * a : a;
}

/** Polkappe um ±m (Winkelradius κ 8°); Deckkraft 0,7·max(0, ±m_z) */
export function capEllipse(m: Vec3, sign: 1 | -1 = 1, center: [number, number] = STAR_CENTER, r = STAR_R, kappaDeg = KAPPA_DEG): Ellipse & { alpha: number; visible: boolean } {
  const k = kappaDeg * DEG;
  const axis = scale(m, sign);
  const e = circleEllipse(scale(axis, Math.cos(k)), axis, Math.sin(k), center, r);
  const mz = axis[2];
  return { ...e, alpha: 0.7 * Math.max(0, mz), visible: mz > 0 };
}

/** Kontur der Polkappe (1 px): SIG 0,5·max(0, m_z) – keine gefüllte Scheibe */
export function capOutlineAlpha(axis: Vec3): number {
  return 0.5 * Math.max(0, axis[2]);
}

/** Polkappe als Punkt: Mittelpunkt (Bildschirm) und Deckkraft 0,9·max(0, m_z); r 2 px (Ø 4 px) */
export const CAP_DOT_R = 2;
export function capDot(axis: Vec3, center: [number, number] = STAR_CENTER, r = STAR_R): { x: number; y: number; alpha: number; visible: boolean } {
  const p = project(axis, center, r);
  return { x: p.x, y: p.y, alpha: 0.9 * Math.max(0, axis[2]), visible: axis[2] > 0 };
}

/**
 * Lichtscheibe (Puls) an der Kappe: bei γ < 12° und f ≤ 2,5 Hz wächst der Kappen-Punkt von r 2 auf r 4 px,
 * Deckkraft 0,6·exp(−(γ/6°)²). Keine Ellipse; darüber kein Blitzen (die Belichtung zeigt den Puls).
 */
export const PULSE_DOT_R = 4;
export function pulseDisc(m: Vec3, f: number): { visible: boolean; gamma: number; alpha: number; x: number; y: number; r: number } {
  const gamma = angleToSight(m);
  const p = project(m);
  if (!flashAllowed(f) || gamma >= DISC_GAMMA_DEG) return { visible: false, gamma, alpha: 0, x: p.x, y: p.y, r: CAP_DOT_R };
  const a = Math.exp(-((gamma / 6) ** 2));
  return { visible: true, gamma, alpha: 0.6 * a, x: p.x, y: p.y, r: CAP_DOT_R + (PULSE_DOT_R - CAP_DOT_R) * a };
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

/** Drehzahl-Anteil u = ln(f/2,5)/ln(173,7/2,5), begrenzt auf 0…1 (Sanduhr-Bereich) */
export function spinShare(f: number): number {
  return Math.min(1, Math.max(0, Math.log(Math.max(1e-9, f) / 2.5) / Math.log(173.7 / 2.5)));
}

/** Deckkraft der Ringzone (Belichtung am Strahlende): 0,07 + 0,05·u */
export function zoneAlpha(f: number): number {
  return 0.07 + 0.05 * spinShare(f);
}

/** Einblendung des belichteten Bogens über n: smoothstep(0,04; 0,15; n) – im Leerlauf (n = 1/60) kein Fleck */
export function arcWeight(n: number): number {
  return smoothstep(0.04, 0.15, Number.isFinite(n) ? n : 0);
}

/** Kontur-Deckkraft der Ringzone: äußerer Rand 0,55, innerer Rand 0,25 */
export const RIM_OUTER_ALPHA = 0.55;
export const RIM_INNER_ALPHA = 0.25;

/** Sichtbare Drehzahl des Strobo-Strahls (Hz): 0,2 + 0,6·u – wird mit der echten Drehzahl schneller, bleibt ruhig */
export function strobeVisFreq(f: number): number {
  return 0.2 + 0.6 * spinShare(f);
}

/* ── Ringzone am Strahlende (Belichtung) ────────────────── */

/** Kolatituden der Zonenränder (Grad): α ± ρ für +m, 180° − (α ± ρ) für −m */
export const RIM_THETAS_DEG = [ALPHA_DEG - RHO_DEG, ALPHA_DEG + RHO_DEG, 180 - ALPHA_DEG - RHO_DEG, 180 - ALPHA_DEG + RHO_DEG] as const;
/** äußere Ränder (54° bzw. 126°) */
export const OUTER_THETAS_DEG = [ALPHA_DEG + RHO_DEG, 180 - ALPHA_DEG - RHO_DEG] as const;
/** innere Ränder (36° bzw. 144°) */
export const INNER_THETAS_DEG = [ALPHA_DEG - RHO_DEG, 180 - ALPHA_DEG + RHO_DEG] as const;
/** Kappen-Breitenringe α ± κ (37°/53°) bzw. 180° − … */
export const CAP_RING_THETAS_DEG = [ALPHA_DEG - KAPPA_DEG, ALPHA_DEG + KAPPA_DEG, 180 - ALPHA_DEG - KAPPA_DEG, 180 - ALPHA_DEG + KAPPA_DEG] as const;

/** Richtung auf dem Kegel um Ω̂: d(λ) = cos θ·Ω̂ + sin θ·(cos λ·ê₁ + sin λ·ê₂) */
export function coneDir(thetaRad: number, lambda: number, b: Basis = B): Vec3 {
  const w = add(scale(b.e1, Math.cos(lambda)), scale(b.e2, Math.sin(lambda)));
  return add(scale(b.omega, Math.cos(thetaRad)), scale(w, Math.sin(thetaRad)));
}

/** Kolatituden (rad) der Zone eines Strahls: [innen, außen] – +m um α, −m um 180° − α */
export function zoneThetas(sign: 1 | -1): [number, number] {
  return sign === 1 ? [(ALPHA_DEG - RHO_DEG) * DEG, (ALPHA_DEG + RHO_DEG) * DEG] : [(180 - ALPHA_DEG + RHO_DEG) * DEG, (180 - ALPHA_DEG - RHO_DEG) * DEG];
}

/** Länge λ (rad) des Strahls ±m bei Phase φ: +m bei ψ(φ), −m bei ψ(φ) + π */
export function lambdaForPhase(phi: number, sign: 1 | -1): number {
  return psiForPhase(phi) + (sign === 1 ? 0 : Math.PI);
}

export interface ZoneQuad {
  /** Viereck im Uhrzeigersinn (Bildschirm) */
  pts: [Pt2, Pt2, Pt2, Pt2];
  /** mittleres z (< 0: hinter der Sternmitte) */
  z: number;
}

/**
 * Ringzone am Strahlende (r = BEAM_LEN) über die Länge λ von `lambdaFrom` bis `lambdaTo` (rad, To ≥ From):
 * je 1° ein Viereck aus coneDir(θ₁, λ), coneDir(θ₁, λ + 1°), coneDir(θ₂, λ + 1°), coneDir(θ₂, λ) mit θ₁/θ₂ = α ∓ ρ
 * (+m) bzw. 180° − α ± ρ (−m). Das letzte Viereck endet genau bei `lambdaTo`. Rein, ohne Canvas.
 */
export function zoneQuads(lambdaFrom: number, lambdaTo: number, sign: 1 | -1, center: [number, number] = STAR_CENTER, r = STAR_R, len = BEAM_LEN): ZoneQuad[] {
  const [t1, t2] = zoneThetas(sign);
  const out: ZoneQuad[] = [];
  const span = Math.max(0, lambdaTo - lambdaFrom);
  if (span <= 1e-9) return out;
  const n = Math.ceil(span / DEG - 1e-9);
  const pt = (th: number, l: number): Projected => project(scale(coneDir(th, l), len), center, r);
  let a1 = pt(t1, lambdaFrom);
  let a2 = pt(t2, lambdaFrom);
  for (let i = 1; i <= n; i++) {
    const l = Math.min(lambdaTo, lambdaFrom + i * DEG);
    const b1 = pt(t1, l);
    const b2 = pt(t2, l);
    const quad: Pt2[] = [
      { x: a1.x, y: a1.y },
      { x: b1.x, y: b1.y },
      { x: b2.x, y: b2.y },
      { x: a2.x, y: a2.y },
    ];
    out.push({ pts: (signedArea(quad) >= 0 ? quad : quad.reverse()) as [Pt2, Pt2, Pt2, Pt2], z: (a1.z + b1.z + b2.z + a2.z) / 4 });
    a1 = b1;
    a2 = b2;
  }
  return out;
}

/**
 * Silhouetten-Erzeugende eines Kegels um Ω̂ (Kolatitude θ): λ mit n_z = 0, n(λ) = −sin θ·Ω̂ + cos θ·(cos λ·ê₁ + sin λ·ê₂).
 * Vorzeichenwechsel bei 720 Schritten, dann Bisektion.
 */
export function silhouetteLambdas(thetaRad: number, b: Basis = B, steps = 720): number[] {
  const nz = (l: number) => -Math.sin(thetaRad) * b.omega[2] + Math.cos(thetaRad) * (Math.cos(l) * b.e1[2] + Math.sin(l) * b.e2[2]);
  const out: number[] = [];
  let l0 = 0;
  let v0 = nz(0);
  for (let i = 1; i <= steps; i++) {
    const l1 = (2 * Math.PI * i) / steps;
    const v1 = nz(l1);
    if (v0 === 0) out.push(l0);
    else if (v0 * v1 < 0) {
      let a = l0;
      let c = l1;
      let va = v0;
      for (let k = 0; k < 50; k++) {
        const mid = (a + c) / 2;
        const vm = nz(mid);
        if (va * vm <= 0) c = mid;
        else {
          a = mid;
          va = vm;
        }
      }
      out.push((a + c) / 2);
    }
    l0 = l1;
    v0 = v1;
  }
  return out;
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
