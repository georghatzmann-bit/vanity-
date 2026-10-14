/**
 * Flaches PULSAR-Zeichen (Spec D.4 / I.2): Ring, Kern, zwei Strahlen.
 * `rays` = 2 × 8 Haarstrahlen (Ergebnis der Intro-Faltung), `solid` = zwei volle Strahlen.
 * Kein Verlauf, kein Glühen. Die Geometrie ist exportiert, damit Canvas und SVG identisch sind.
 */
import type { CSSProperties } from "react";

const deg = Math.PI / 180;

export const MARK_GEOMETRY = {
  VIEWBOX: 512,
  CENTER: 256,
  RING_R: 168,
  CORE_R: 44,
  RAY_IN: 56,
  /** äußeres Strahlende je Haarstrahl k = 0…7 */
  RAY_OUT: (k: number) => 246 - 44 * ((k - 3.5) / 3.5) ** 2,
  /** Abstand der Haarstrahlen (Grad) */
  RAY_SPREAD: 1.6,
  /** Strahlrichtungen im Uhrzeigersinn ab senkrecht (Grad) */
  BEAM_ANGLES: [35, 215] as const,
  RAYS_PER_BEAM: 8,
  /** Ringstrich im viewBox-Maß, abhängig von der Darstellungsgröße (px) */
  ringStroke: (size: number, variant: "solid" | "rays" = "rays") => Math.max(variant === "solid" ? 14 : 8, (1.5 * 512) / size),
  /** Strahlstrich im viewBox-Maß */
  rayStroke: (size: number) => Math.max(3.2, 512 / size),
  /** voller Strahl (`solid`), senkrecht nach oben; wird um 35° bzw. 215° gedreht */
  BEAM_PATH: "M256 256 L236 92 Q256 10 276 92 Z",
} as const;

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
          <g stroke={accent} strokeWidth={g.rayStroke(size)} strokeLinecap="round" opacity={beams}>
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
