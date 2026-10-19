import { colorVar } from '../tokens/tokens.ts';
import {
  fillShape,
  innerMark,
  markSize,
  markStrokeWidth,
  outline,
  scanLine,
  wordmarkFill,
  wordmarkStroke,
  wordmarkStrokeWidth,
} from './geometry.ts';

export type LogoAppearance = 'line' | 'solid';
export type LogoTone = 'accent' | 'mono';

/** Masken arbeiten mit Leuchtdichte: Weiß = sichtbar, Schwarz = ausgespart (keine Designfarben). */
export const MASK_VISIBLE = 'white';
export const MASK_HIDDEN = 'black';

interface MarkGraphicProps {
  readonly appearance: LogoAppearance;
  readonly tone: LogoTone;
  /** Eindeutiges Präfix für Verlauf/Maske (siehe useSvgId). */
  readonly idPrefix: string;
}

/**
 * Inhalt des Bildzeichens im 64er-Raster (ohne <svg>-Hülle), damit Logo, Lockup und
 * Start-Animation exakt dieselbe Darstellung teilen.
 */
export function MarkGraphic({ appearance, tone, idPrefix }: MarkGraphicProps) {
  const gradientId = `${idPrefix}-gradient`;
  const maskId = `${idPrefix}-cutout`;
  const accent = tone === 'accent';
  const paint = accent ? `url(#${gradientId})` : 'currentColor';

  return (
    <>
      <defs>
        {accent && (
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={markSize / 2}
            y1={2}
            x2={markSize / 2}
            y2={62}
          >
            <stop offset="0" style={{ stopColor: colorVar('accent-strong') }} />
            <stop offset="1" style={{ stopColor: colorVar('accent') }} />
          </linearGradient>
        )}
        {appearance === 'solid' && (
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={markSize}
            height={markSize}
          >
            <path
              d={fillShape}
              fill={MASK_VISIBLE}
              stroke={MASK_VISIBLE}
              strokeWidth={markStrokeWidth}
              strokeLinejoin="miter"
            />
            <path d={innerMark} fill={MASK_HIDDEN} />
            <path d={scanLine} fill={MASK_HIDDEN} />
          </mask>
        )}
      </defs>
      {appearance === 'solid' ? (
        <path
          d={fillShape}
          mask={`url(#${maskId})`}
          style={{ fill: paint, stroke: paint }}
          strokeWidth={markStrokeWidth}
          strokeLinejoin="miter"
        />
      ) : (
        <>
          <path
            d={fillShape}
            style={{ fill: accent ? colorVar('accent') : 'currentColor' }}
            fillOpacity={0.08}
          />
          <path
            d={outline}
            fill="none"
            style={{ stroke: paint }}
            strokeWidth={markStrokeWidth}
            strokeLinejoin="miter"
            strokeMiterlimit={4}
          />
          <path d={innerMark} style={{ fill: paint }} />
          <path
            d={scanLine}
            style={{ fill: accent ? colorVar('accent-strong') : 'currentColor' }}
          />
        </>
      )}
    </>
  );
}

/** Schriftzug „AEGIS“ als Pfade in eigener Einheit (Versalhöhe 20), Farbe = currentColor. */
export function WordmarkGraphic() {
  return (
    <>
      <path d={wordmarkFill} fill="currentColor" />
      <path
        d={wordmarkStroke}
        fill="none"
        stroke="currentColor"
        strokeWidth={wordmarkStrokeWidth}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </>
  );
}
