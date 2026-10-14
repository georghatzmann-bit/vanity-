/**
 * Marken als SVG (B.4): Dreiecke, Pfeil, Haken, Kreuz fehlen in Plex Mono und sind nie Schriftzeichen.
 */
export type GlyphName = "tri-down" | "tri-up" | "tri-right" | "arrow-right" | "check" | "cross";

export interface GlyphProps {
  name: GlyphName;
  /** Breite in px (Dreiecke 7 × 5 laut B.5) */
  size?: number;
  className?: string;
  title?: string;
}

export function Glyph({ name, size, className, title }: GlyphProps) {
  const common = { className, "aria-hidden": title ? undefined : true, role: title ? "img" : undefined, "aria-label": title } as const;
  switch (name) {
    case "tri-down":
    case "tri-up": {
      const w = size ?? 7;
      const h = (w * 5) / 7;
      return (
        <svg width={w} height={h} viewBox="0 0 7 5" {...common}>
          <path d={name === "tri-down" ? "M0 0H7L3.5 5Z" : "M0 5H7L3.5 0Z"} fill="currentColor" />
        </svg>
      );
    }
    case "tri-right": {
      const h = size ?? 7;
      return (
        <svg width={(h * 5) / 7} height={h} viewBox="0 0 5 7" {...common}>
          <path d="M0 0V7L5 3.5Z" fill="currentColor" />
        </svg>
      );
    }
    case "arrow-right": {
      const w = size ?? 12;
      return (
        <svg width={w} height={(w * 8) / 12} viewBox="0 0 12 8" fill="none" {...common}>
          <path d="M0 4H11M8 1L11 4L8 7" stroke="currentColor" strokeWidth={1.25} strokeLinecap="square" />
        </svg>
      );
    }
    case "check": {
      const w = size ?? 10;
      return (
        <svg width={w} height={w} viewBox="0 0 10 10" fill="none" {...common}>
          <path d="M1.5 5.2L4 7.6L8.6 2.6" stroke="currentColor" strokeWidth={1.75} />
        </svg>
      );
    }
    case "cross": {
      const w = size ?? 10;
      return (
        <svg width={w} height={w} viewBox="0 0 10 10" fill="none" {...common}>
          <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth={1.5} />
        </svg>
      );
    }
  }
}
