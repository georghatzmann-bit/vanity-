import { useContext, useId, type CSSProperties } from "react";
import { MotionConfigContext, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/*
 * Rift logo: a portal ring (violet #8B5CF6 -> cyan #22D3EE) torn open by a jagged, glowing rift
 * (cyan edges, white-hot core). The rift cuts through the ring at the top and bottom.
 * Every shape is a vector path, so the logo looks the same everywhere without fonts.
 * Masters: launcher/assets/app-icon.svg (rich) and app-icon-simple.svg. Brand rules: docs/brand.md.
 */

// The rift in a 1024 box: outer body + white core. The simple variant is a little wider for small sizes.
const RIFT_RICH = "M598 30L555.67 200.86L565.49 291.69L421.27 478.47L485.79 548.64L397.96 719L451.35 790.19L420.23 897.33L420 994L420 994L439.77 902.67L508.65 789.81L498.04 725L638.21 531.36L562.73 461.53L630.51 300.31L584.33 199.14L598 30Z";
const CORE_RICH = "M598 30L562.83 200.43L581.75 293.85L456.63 474.23L523.89 544.32L422.98 720.5L465.68 790.09L425.11 898.67L420 994L420 994L434.89 901.33L494.32 789.91L473.02 723.5L600.11 535.68L527.37 465.77L614.25 298.15L577.17 199.57L598 30Z";
const RIFT_SIMPLE = "M598 30L553.95 200.97L561.59 291.18L412.78 479.48L476.64 549.68L391.96 718.64L447.92 790.21L419.05 897.01L420 994L420 994L440.95 902.99L512.08 789.79L504.04 725.36L647.36 530.32L571.22 460.52L634.41 300.82L586.05 199.03L598 30Z";
const CORE_SIMPLE = "M598 30L561.97 200.48L579.8 293.59L452.39 474.74L519.32 544.84L419.98 720.32L463.96 790.11L424.53 898.51L420 994L420 994L435.47 901.49L496.04 789.89L476.02 723.68L604.68 535.16L531.61 465.26L616.2 298.41L578.03 199.52L598 30Z";
// Hair-line side cracks (rich only).
const BRANCHES = "M563.13 548.44L667.66 504.93L720 528L720 528L668.34 495.07L556.87 531.56ZM468.43 492.16L371 515.72L326 486L326 486L369 524.28L471.57 507.84ZM449.43 716.58L372 760L372 760L454.57 727.42Z";
// "RIFT" wordmark (Inter Display Bold outlines, SIL OFL 1.1).
const WORDMARK = "M0 100H15.04V74.56H28.22C28.27 74.56 28.32 74.56 28.37 74.56L41.26 100H57.37L42.77 71.73C50.93 67.97 55.76 60.74 55.76 51.12C55.76 36.47 45.51 27.25 29.1 27.25H0ZM15.04 62.5V39.75H28.17C36.13 39.75 41.06 44.19 41.06 51.12C41.06 58.06 36.13 62.5 28.22 62.5ZM86.08 27.25H71.04V100H86.08ZM102.92 100H117.96V70.51H151.06V58.01H117.96V40.14H153.5V27.25H102.92ZM163.85 40.14H185.92V100H200.96V40.14H222.98V27.25H163.85Z";
const WORDMARK_VIEWBOX = "0 27.25 222.98 72.75";
const WORDMARK_RATIO = 3.0649; // width / height

// Ring geometry (1024 box): outer radius 448, 62 wide; the portal inside has radius 386.
const RING_R = 417;
const RING_W = 62;
const PORTAL_R = 386;

export type LogoVariant = "auto" | "rich" | "simple";

/** True when the user (OS setting or the app's "Reduce motion" option) wants less movement. */
function useCalmMotion() {
  const config = useContext(MotionConfigContext);
  const osReduced = useReducedMotion();
  return config.reducedMotion === "always" || Boolean(osReduced);
}

/** SVG ids must be unique per instance and safe inside url(#...). */
function useSvgId() {
  return "rf" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
}

export interface LogoMarkProps {
  className?: string;
  /** Size in px. Without it the size comes from className (default 32 px). */
  size?: number;
  /** "rich" adds the portal depth rings and side cracks, "simple" is the bold mark for small sizes. "auto" = rich from 64 px. */
  variant?: LogoVariant;
  /** Soft violet/cyan glow behind the mark that slowly breathes (stays still when motion is reduced). */
  glow?: boolean;
  /** Accessible name. Leave it out when text next to the logo already says "Niobium". */
  title?: string;
}

/** The portal mark. */
export function LogoMark({ className, size, variant = "auto", glow = false, title }: LogoMarkProps) {
  const uid = useSvgId();
  const calm = useCalmMotion();
  const rich = variant === "rich" || (variant === "auto" && size !== undefined && size >= 64);
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const rift = rich ? RIFT_RICH : RIFT_SIMPLE;
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
              "radial-gradient(closest-side, rgb(139 92 246 / 0.62), rgb(34 211 238 / 0.26) 55%, transparent 100%)",
          }}
        />
      )}
      <svg viewBox="0 0 1024 1024" className="relative block size-full" focusable="false" aria-hidden>
        <defs>
          <linearGradient id={id("ring")} x1="64" y1="64" x2="960" y2="960" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#B69CFF" />
            <stop offset="0.3" stopColor="#8B5CF6" />
            <stop offset="0.62" stopColor="#7C6CF6" />
            <stop offset="0.86" stopColor="#22D3EE" />
          </linearGradient>
          <radialGradient id={id("portal")} cx="512" cy="512" r={PORTAL_R} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#2A1766" />
            <stop offset="0.55" stopColor="#140D33" />
            <stop offset="1" stopColor="#0B0A1A" />
          </radialGradient>
          <radialGradient id={id("bloom")} cx="512" cy="512" r={PORTAL_R} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#8B5CF6" stopOpacity="0.55" />
            <stop offset="0.6" stopColor="#8B5CF6" stopOpacity="0.12" />
            <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id("core")} x1="0" y1="40" x2="0" y2="990" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#22D3EE" />
            <stop offset="0.5" stopColor="#67E8F9" />
            <stop offset="1" stopColor="#A78BFA" />
          </linearGradient>
          <mask id={id("cut")} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
            <rect width="1024" height="1024" fill="#fff" />
            <path d={rift} fill="#000" stroke="#000" strokeWidth="44" strokeLinejoin="round" />
          </mask>
          <filter id={id("glow-wide")} x="-60%" y="-30%" width="220%" height="160%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="70" />
          </filter>
          <filter id={id("glow")} x="-60%" y="-30%" width="220%" height="160%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation="26" />
          </filter>
          <clipPath id={id("inside")}>
            <circle cx="512" cy="512" r={PORTAL_R + 1} />
          </clipPath>
        </defs>
        <circle cx="512" cy="512" r={RING_R} fill={url("portal")} />
        <circle cx="512" cy="512" r={PORTAL_R} fill={url("bloom")} />
        {rich && (
          <>
            <circle cx="512" cy="512" r="308.8" fill="none" stroke="#A78BFA" strokeOpacity="0.16" strokeWidth="6" />
            <circle cx="512" cy="512" r="223.88" fill="none" stroke="#A78BFA" strokeOpacity="0.11" strokeWidth="6" />
          </>
        )}
        <g clipPath={url("inside")}>
          <path d={rift} fill="#8B5CF6" opacity="0.95" filter={url("glow-wide")} />
        </g>
        <circle cx="512" cy="512" r={RING_R} fill="none" stroke={url("ring")} strokeWidth={RING_W} mask={url("cut")} />
        <circle
          cx="512"
          cy="512"
          r="445"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.22"
          strokeWidth="5"
          strokeDasharray="774.09 2040.78"
          transform="rotate(-200 512 512)"
          mask={url("cut")}
        />
        <path d={rift} fill="#22D3EE" filter={url("glow")} />
        {rich && <path d={BRANCHES} fill="#67E8F9" opacity="0.85" />}
        <path d={rift} fill={url("core")} />
        <path d={rich ? CORE_RICH : CORE_SIMPLE} fill="#FFFFFF" />
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

/** "RIFT" in the brand lettering. Uses the current text colour. */
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
  /** Mark size in px; the wordmark scales with it. */
  size?: number;
  glow?: boolean;
  /** Show "old seasons, new shine." under the name. */
  tagline?: boolean;
}

/** Mark + wordmark lock-up, e.g. for the splash, welcome and about screens. */
export function Logo({ className, size = 40, glow = false, tagline = false }: LogoProps) {
  return (
    <span className={cn("inline-flex items-center", className)} style={{ gap: size * 0.3 }} role="img" aria-label="Niobium">
      <LogoMark size={size} glow={glow} />
      <span className="flex flex-col" style={{ gap: size * 0.12 }}>
        <Wordmark height={size * 0.42} title="" className="text-foreground" />
        {tagline && <span className="text-xs text-muted-foreground">old seasons, new shine.</span>}
      </span>
    </span>
  );
}
