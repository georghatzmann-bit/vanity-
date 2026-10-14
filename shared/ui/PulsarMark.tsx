/**
 * Flaches PULSAR-Zeichen (Spec D.4 / I.2): Ring, Kern, zwei Strahlen.
 * `rays` = 2 × 8 Haarstrahlen (Ergebnis der Intro-Faltung), `solid` = zwei volle Strahlen.
 * Kein Verlauf, kein Glühen. Die Geometrie ist exportiert, damit Canvas und SVG identisch sind.
 *
 * Zwei Größenstufen:
 * - klein (≤ 24 px, Titelleiste): eigene Pixelgeometrie – Strahlen beginnen AUSSERHALB des Rings
 *   (keine Linie durch den Ring, sonst liest es sich als „⊘“), kurze Striche, Kern r 2,5 px.
 * - groß (Fertig-Zeichen 220 px): Kern Ø ≈ 14 px (kein „Spiegelei“/keine Zielscheibe), Ringstrich 2,5 px,
 *   Haarstrahlen ±4° mit GLEICHER Länge (gerade Endkante, keine Treppe/„Besen“), stumpfe Enden (`butt`).
 */
import type { CSSProperties } from "react";

const deg = Math.PI / 180;

/** Grenze der kleinen Variante (px) */
export const MARK_SMALL_MAX = 24;

export const MARK_GEOMETRY = {
  VIEWBOX: 512,
  CENTER: 256,
  RING_R: 168,
  /** 220 px → Kern r ≈ 6,9 px (Ø ≈ 14 px) */
  CORE_R: 16,
  RAY_IN: 56,
  /** äußeres Strahlende je Haarstrahl k = 0…7 – für alle k gleich (bei ±4° Fächer praktisch gerade Endkante) */
  RAY_OUT: (_k: number) => 236,
  /** Abstand der Haarstrahlen (Grad): 8 Strahlen über ±4° */
  RAY_SPREAD: 8 / 7,
  /** Strahlrichtungen im Uhrzeigersinn ab senkrecht (Grad) */
  BEAM_ANGLES: [35, 215] as const,
  RAYS_PER_BEAM: 8,
  /** Linienenden der Strahlen (Canvas: ctx.lineCap, SVG: stroke-linecap) */
  RAY_CAP: "butt" as CanvasLineCap,
  /** Ringstrich im viewBox-Maß, abhängig von der Darstellungsgröße (px): `rays` 2,5 px, `solid` ≥ 1,5 px */
  ringStroke: (size: number, variant: "solid" | "rays" = "rays") => (variant === "solid" ? Math.max(14, (1.5 * 512) / size) : (2.5 * 512) / Math.max(1, size)),
  /** Strahlstrich im viewBox-Maß */
  rayStroke: (size: number) => Math.max(3.2, 512 / size),
  /** voller Strahl (`solid`), senkrecht nach oben; wird um 35° bzw. 215° gedreht */
  BEAM_PATH: "M256 256 L236 92 Q256 10 276 92 Z",
} as const;

/**
 * Kleine Variante in Pixeln (für 18 px gebaut, skaliert linear bis 24 px):
 * Ring r 4,75 / Strich 1,5, Kern r 2,5, Strahlen von RING_R + 1,5 bis + 3,25 px (Strich 1,75, stumpf).
 */
export const MARK_SMALL = { BASE: 18, RING_R: 4.75, RING_STROKE: 1.5, CORE_R: 2.5, RAY_IN: 4.75 + 1.5, RAY_LEN: 3.25, RAY_STROKE: 1.75 } as const;

/** Winkel (Grad) des Haarstrahls k im Strahl b */
export function rayAngle(b: 0 | 1, k: number): number {
  return MARK_GEOMETRY.BEAM_ANGLES[b] + (k - 3.5) * MARK_GEOMETRY.RAY_SPREAD;
}

/** Richtung (Bildschirm, y nach unten) zum Winkel im Uhrzeigersinn ab senkrecht */
export function rayDir(angleDeg: number): [number, number] {
  return [Math.sin(angleDeg * deg), -Math.cos(angleDeg * deg)];
}

/** Endpunkte eines Haarstrahls im viewBox-Maß */
export function rayEndpoints(b: 0 | 1, k: number): { x1: number; y1: number; x2: number; y2: number } {
  const { CENTER: c, RAY_IN, RAY_OUT } = MARK_GEOMETRY;
  const [dx, dy] = rayDir(rayAngle(b, k));
  return { x1: c + RAY_IN * dx, y1: c + RAY_IN * dy, x2: c + RAY_OUT(k) * dx, y2: c + RAY_OUT(k) * dy };
}

/** Endpunkte der zwei Strahlen der kleinen Variante (px, Mitte bei size/2) */
export function smallRayEndpoints(size: number): { x1: number; y1: number; x2: number; y2: number }[] {
  const s = size / MARK_SMALL.BASE;
  const c = size / 2;
  return MARK_GEOMETRY.BEAM_ANGLES.map((a) => {
    const [dx, dy] = rayDir(a);
    const r0 = MARK_SMALL.RAY_IN * s;
    const r1 = (MARK_SMALL.RAY_IN + MARK_SMALL.RAY_LEN) * s;
    return { x1: c + r0 * dx, y1: c + r0 * dy, x2: c + r1 * dx, y2: c + r1 * dy };
  });
}

export interface PulsarMarkProps {
  size: number;
  variant?: "solid" | "rays";
  /** Deckkraft des Rings 0…1 */
  ring?: number;
  /** Deckkraft der Strahlen 0…1 */
  beams?: number;
  /** Deckkraft des Kerns 0…1 */
  core?: number;
  /** `signal`: Strahlen und Kern gelb, Ring hell; `mono`: alles in `currentColor` */
  tone?: "signal" | "mono";
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}

const SIGNAL = "var(--obs-signal, #F2D53C)";
const FG = "var(--obs-fg, #E6E8EB)";

export function PulsarMark({ size, variant = "solid", ring = 1, beams = 1, core = 1, tone = "signal", decorative = true, className, style }: PulsarMarkProps) {
  const g = MARK_GEOMETRY;
  const accent = tone === "mono" ? "currentColor" : SIGNAL;
  const ringColor = tone === "mono" ? "currentColor" : FG;
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": "Pulsar" };

  if (size <= MARK_SMALL_MAX) {
    const s = size / MARK_SMALL.BASE;
    const c = size / 2;
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" className={className} style={style} data-variant="small" {...a11y}>
        {beams > 0 && (
          <g stroke={accent} strokeWidth={MARK_SMALL.RAY_STROKE * s} strokeLinecap="butt" opacity={beams}>
            {smallRayEndpoints(size).map((e, i) => (
              <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
            ))}
          </g>
        )}
        {ring > 0 && <circle cx={c} cy={c} r={MARK_SMALL.RING_R * s} stroke={ringColor} strokeWidth={MARK_SMALL.RING_STROKE * s} opacity={ring} />}
        {core > 0 && <circle cx={c} cy={c} r={MARK_SMALL.CORE_R * s} fill={accent} opacity={core} />}
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${g.VIEWBOX} ${g.VIEWBOX}`} fill="none" className={className} style={style} {...a11y}>
      {beams > 0 &&
        (variant === "solid" ? (
          <g fill={accent} opacity={beams}>
            {g.BEAM_ANGLES.map((a) => (
              <path key={a} d={g.BEAM_PATH} transform={`rotate(${a} ${g.CENTER} ${g.CENTER})`} />
            ))}
          </g>
        ) : (
          <g stroke={accent} strokeWidth={g.rayStroke(size)} strokeLinecap={g.RAY_CAP} opacity={beams}>
            {([0, 1] as const).flatMap((b) =>
              Array.from({ length: g.RAYS_PER_BEAM }, (_, k) => {
                const e = rayEndpoints(b, k);
                return <line key={`${b}-${k}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />;
              }),
            )}
          </g>
        ))}
      {ring > 0 && <circle cx={g.CENTER} cy={g.CENTER} r={g.RING_R} stroke={ringColor} strokeWidth={g.ringStroke(size, variant)} opacity={ring} />}
      {core > 0 && <circle cx={g.CENTER} cy={g.CENTER} r={g.CORE_R} fill={accent} opacity={core} />}
    </svg>
  );
}
