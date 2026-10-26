import { useContext, useId, type CSSProperties } from "react";
import { MotionConfigContext, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/*
 * Niobium logo: a periodic-table tile for niobium ("Nb", element 41) on an anodised-niobium
 * gradient (deep blue #2B5BFF -> violet #7A3CFF, a touch of gold #FFC857 in the bottom-right corner).
 * Every letter is a vector path, so the logo looks the same everywhere without fonts.
 * Masters: launcher/assets/app-icon.svg (rich) and app-icon-simple.svg. Brand rules: docs/brand.md.
 */

// Geometric "Nb" monogram in a 1024 box. The rich tile sits lower to make room for the "41".
const NB_RICH = "M184.5 382H276.5V750H184.5ZM408.5 382H500.5V750H408.5ZM184.5 382H288.55L500.5 750H396.45ZM537.5 382H629.5V750H537.5ZM537.5 613.84A151 136.16 0 1 1 839.5 613.84A151 136.16 0 1 1 537.5 613.84ZM629.5 613.84A59 57.04 0 1 0 747.5 613.84A59 57.04 0 1 0 629.5 613.84Z";
const NB_SIMPLE = "M184.5 336H276.5V704H184.5ZM408.5 336H500.5V704H408.5ZM184.5 336H288.55L500.5 704H396.45ZM537.5 336H629.5V704H537.5ZM537.5 567.84A151 136.16 0 1 1 839.5 567.84A151 136.16 0 1 1 537.5 567.84ZM629.5 567.84A59 57.04 0 1 0 747.5 567.84A59 57.04 0 1 0 629.5 567.84Z";
// Atomic number "41" (Inter Display Bold outlines, SIL OFL 1.1).
const ATOMIC_NUMBER = "M160 227.31H207.95V248H226.58V227.31H239.15V211.91H226.58V151.96H202.28L160 211.97ZM207.95 211.91H179.14V211.78L207.82 170.91H207.95ZM287.23 151.96H269.25L245.46 167.11V184.51L268.02 170.21H268.15V248H287.23Z";
// "Niobium" wordmark (Inter Display Bold outlines, SIL OFL 1.1).
const WORDMARK = "M0 100H15.04V66.26C15.04 63.13 14.99 56.93 14.7 49.32C18.8 56.69 22.51 62.99 24.61 66.31L45.8 100H61.67V27.25H46.68V63.23C46.68 66.31 46.73 72.31 46.92 77.93C44.04 72.71 40.92 67.19 39.21 64.45L15.82 27.25H0ZM71.17 100H85.57V48.44H71.17ZM78.35 41.94C83.08 41.94 86.55 38.67 86.55 34.28C86.55 29.88 83.08 26.61 78.35 26.61C73.61 26.61 70.14 29.88 70.14 34.28C70.14 38.67 73.61 41.94 78.35 41.94ZM118.65 101.17C134.33 101.17 144.88 90.43 144.88 74.27C144.88 58.11 134.33 47.27 118.65 47.27C103.03 47.27 92.48 58.11 92.48 74.27C92.48 90.43 103.03 101.17 118.65 101.17ZM118.65 89.5C111.67 89.5 106.98 83.84 106.98 74.27C106.98 64.65 111.72 58.94 118.65 58.94C125.64 58.94 130.37 64.65 130.37 74.27C130.37 83.84 125.69 89.5 118.65 89.5ZM181.33 101.07C194.8 101.07 203.64 90.33 203.64 74.17C203.64 58.35 194.61 47.36 181.42 47.36C174.73 47.36 169.56 50 166.24 55.57H166.19V27.25H151.79V100H165.99V92.09H166.04C169.02 98.1 174.54 101.07 181.33 101.07ZM177.62 89.36C170.34 89.36 165.51 83.4 165.51 74.17C165.51 64.99 170.34 58.98 177.62 58.98C184.6 58.98 189.14 64.5 189.14 74.17C189.14 83.84 184.6 89.36 177.62 89.36ZM210.55 100H224.96V48.44H210.55ZM217.73 41.94C222.46 41.94 225.93 38.67 225.93 34.28C225.93 29.88 222.46 26.61 217.73 26.61C212.99 26.61 209.53 29.88 209.53 34.28C209.53 38.67 212.99 41.94 217.73 41.94ZM252.23 101.07C259.65 101.07 264.87 97.75 268.34 91.89V100H282.45V48.44H268.1V77.1C268.1 85.11 263.95 88.67 257.99 88.67C251.98 88.67 248.52 85.01 248.52 78.08V48.44H234.11V80.71C234.11 93.75 241.24 101.07 252.23 101.07ZM291.66 100H306.06V69.58C306.06 62.94 310.16 59.23 315.29 59.23C320.32 59.23 323.83 62.7 323.83 68.07V100H337.7V68.95C337.7 63.18 341.17 59.23 346.73 59.23C351.67 59.23 355.47 62.26 355.47 68.46V100H369.83V65.82C369.83 54 362.46 47.36 352.54 47.36C345.07 47.36 338.73 51.12 336.04 57.42C333.89 51.12 328.08 47.36 321.15 47.36C314.61 47.36 308.6 50.73 305.52 57.71V48.44H291.66Z";
const WORDMARK_VIEWBOX = "0 26.61 369.83 74.56";
const WORDMARK_RATIO = 4.9601; // width / height

export type LogoVariant = "auto" | "rich" | "simple";

/** True when the user (OS setting or the app's "Reduce motion" option) wants less movement. */
function useCalmMotion() {
  const config = useContext(MotionConfigContext);
  const osReduced = useReducedMotion();
  return config.reducedMotion === "always" || Boolean(osReduced);
}

/** SVG ids must be unique per instance and safe inside url(#...). */
function useSvgId() {
  return "nb" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
}

export interface LogoMarkProps {
  className?: string;
  /** Size in px. Without it the size comes from className (default 32 px). */
  size?: number;
  /** "rich" shows the small "41", "simple" is the bold tile for small sizes. "auto" = rich from 64 px. */
  variant?: LogoVariant;
  /** Soft brand glow behind the tile that slowly breathes (stays still when motion is reduced). */
  glow?: boolean;
  /** Accessible name. Leave it out when text next to the logo already says "Niobium". */
  title?: string;
}

/** The "Nb" tile. */
export function LogoMark({ className, size, variant = "auto", glow = false, title }: LogoMarkProps) {
  const uid = useSvgId();
  const calm = useCalmMotion();
  const rich = variant === "rich" || (variant === "auto" && size !== undefined && size >= 64);
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const [inkTop, inkBottom] = rich ? [382, 750] : [336, 704];
  const rim = rich ? 8 : 14;
  const style: CSSProperties | undefined = size ? { width: size, height: size } : undefined;

  return (
    <span
      className={cn("relative inline-flex size-8 shrink-0", className)}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
    >
      {glow && (
        // CSS loop (.nb-loop), not Motion: it pauses with the window and while you play
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-[35%] rounded-full opacity-80 blur-xl",
            !calm && "nb-loop [animation:nb-logo-glow_3.6s_ease-in-out_infinite]",
          )}
          style={{
            background:
              "radial-gradient(closest-side, rgb(122 60 255 / 0.6), rgb(43 91 255 / 0.3) 55%, transparent 100%)",
          }}
        />
      )}
      <svg viewBox="0 0 1024 1024" className="relative block size-full" focusable="false" aria-hidden>
        <defs>
          <linearGradient id={id("base")} x1="64" y1="64" x2="960" y2="960" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#2B5BFF" />
            <stop offset="0.5" stopColor="#5546FF" />
            <stop offset="0.85" stopColor="#7A3CFF" />
          </linearGradient>
          <radialGradient id={id("bloom")} cx="229.76" cy="189.44" r="618.24" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#8FB0FF" stopOpacity="0.24" />
            <stop offset="1" stopColor="#8FB0FF" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={id("depth")} cx="64" cy="960" r="761.6" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#0B0738" stopOpacity="0.42" />
            <stop offset="1" stopColor="#0B0738" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id("gold")} x1="960" y1="960" x2="619.52" y2="619.52" gradientUnits="userSpaceOnUse">
            <stop offset="0.14" stopColor="#FFC857" />
            <stop offset="0.3" stopColor="#FFC857" stopOpacity="0.72" />
            <stop offset="0.56" stopColor="#FF6FA8" stopOpacity="0.26" />
            <stop offset="0.9" stopColor="#FF6FA8" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={id("sheen")} x1="64" y1="64" x2="960" y2="960" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.2" />
            <stop offset="0.4" stopColor="#FFFFFF" stopOpacity="0.07" />
            <stop offset="0.405" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={id("rim")} x1="0" y1="64" x2="0" y2="960" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.42" />
            <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.06" />
            <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id={id("ink")} x1="0" y1={inkTop} x2="0" y2={inkBottom} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#E6E4FF" />
          </linearGradient>
          <filter id={id("shadow")} x="-20%" y="-20%" width="140%" height="150%" colorInterpolationFilters="sRGB">
            <feDropShadow dx="0" dy="16" stdDeviation="20" floodColor="#14095A" floodOpacity="0.45" />
          </filter>
        </defs>
        {(["base", "bloom", "depth", "gold", "sheen"] as const).map((layer) => (
          <rect key={layer} x="64" y="64" width="896" height="896" rx="208" fill={url(layer)} />
        ))}
        <rect
          x={64 + rim / 2}
          y={64 + rim / 2}
          width={896 - rim}
          height={896 - rim}
          rx={208 - rim / 2}
          fill="none"
          stroke={url("rim")}
          strokeWidth={rim}
        />
        {rich && <path d={ATOMIC_NUMBER} fill="#FFFFFF" fillOpacity="0.9" />}
        <path d={rich ? NB_RICH : NB_SIMPLE} fill={url("ink")} filter={url("shadow")} />
      </svg>
    </span>
  );
}

export interface WordmarkProps {
  className?: string;
  /** Height in px (the width follows). Without it use a height class, e.g. "h-5". */
  height?: number;
  /** Accessible name; pass "" when the wordmark sits inside something that is already labelled. */
  title?: string;
}

/** "Niobium" in the brand lettering. Uses the current text colour. */
export function Wordmark({ className, height, title = "Niobium" }: WordmarkProps) {
  return (
    <svg
      viewBox={WORDMARK_VIEWBOX}
      className={cn("block h-5 w-auto shrink-0 fill-current", className)}
      style={height ? { height, width: height * WORDMARK_RATIO } : undefined}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={WORDMARK} />
    </svg>
  );
}

export interface LogoProps {
  className?: string;
  /** Tile size in px; the wordmark scales with it. */
  size?: number;
  glow?: boolean;
  /** Show "old seasons, new shine." under the name. */
  tagline?: boolean;
}

/** Tile + wordmark lock-up, e.g. for the splash, welcome and about screens. */
export function Logo({ className, size = 40, glow = false, tagline = false }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center", className)} style={{ gap: size * 0.3 }} role="img" aria-label="Niobium">
      <LogoMark size={size} glow={glow} />
      <span className="flex flex-col" style={{ gap: size * 0.12 }}>
        <Wordmark height={size * 0.5} title="" className="text-foreground" />
        {tagline && <span className="text-xs text-muted-foreground">old seasons, new shine.</span>}
      </span>
    </span>
  );
}
