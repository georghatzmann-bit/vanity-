import { useId } from "react";
import { motion } from "motion/react";
import { cn } from "../lib/cn";

export interface NovaLogoProps {
  size?: number;
  /** "intro": zeichnet sich auf, "idle": sanftes Pulsieren, "static": keine Bewegung */
  mode?: "intro" | "idle" | "static";
  glow?: boolean;
  className?: string;
  /** Verzögerung der Intro-Animation in Sekunden */
  delay?: number;
}

const STAR = "M256 92 C 268 206, 306 244, 420 256 C 306 268, 268 306, 256 420 C 244 306, 206 268, 92 256 C 206 244, 244 206, 256 92 Z";
const STAR_INNER = "M256 150 C 262 224, 288 250, 362 256 C 288 262, 262 288, 256 362 C 250 288, 224 262, 150 256 C 224 250, 250 224, 256 150 Z";

/** Das NOVA-Zeichen: vierzackiger Stern in einer Umlaufbahn */
export function NovaLogo({ size = 40, mode = "static", glow = true, className, delay = 0 }: NovaLogoProps) {
  const raw = useId();
  const id = raw.replace(/[^a-zA-Z0-9]/g, "");
  const intro = mode === "intro";
  const idle = mode === "idle";

  return (
    <motion.svg
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={cn("overflow-visible", className)}
      style={glow ? { filter: "drop-shadow(0 0 calc(var(--nv-glow-strength) * 10px) color-mix(in oklab, var(--nv-accent) 55%, transparent))" } : undefined}
      aria-label="NOVA"
      role="img"
    >
      <defs>
        <linearGradient id={`${id}s`} x1="0.15" y1="0.1" x2="0.85" y2="0.95">
          <stop offset="0" stopColor="#FFB27A" />
          <stop offset="0.28" stopColor="var(--nv-accent-2)" />
          <stop offset="0.58" stopColor="var(--nv-accent)" />
          <stop offset="1" stopColor="var(--nv-accent-3)" />
        </linearGradient>
        <linearGradient id={`${id}o`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--nv-accent-3)" />
          <stop offset="0.5" stopColor="var(--nv-accent)" />
          <stop offset="1" stopColor="var(--nv-accent-2)" />
        </linearGradient>
        <radialGradient id={`${id}c`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="1" />
          <stop offset="0.35" stopColor="#FFE3D0" stopOpacity="0.85" />
          <stop offset="1" stopColor="var(--nv-accent)" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}f`}>
          <rect x="0" y="256" width="512" height="256" />
        </clipPath>
        <clipPath id={`${id}b`}>
          <rect x="0" y="0" width="512" height="256" />
        </clipPath>
      </defs>

      {/* hintere Hälfte der Umlaufbahn */}
      <g transform="rotate(-24 256 256)">
        <motion.ellipse
          cx="256"
          cy="256"
          rx="214"
          ry="70"
          fill="none"
          stroke={`url(#${id}o)`}
          strokeWidth="13"
          opacity={0.45}
          clipPath={`url(#${id}b)`}
          initial={intro ? { pathLength: 0 } : false}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, delay: delay + 0.25, ease: [0.65, 0, 0.35, 1] }}
        />
      </g>

      {/* Stern */}
      <motion.g
        style={{ transformOrigin: "256px 256px" }}
        initial={intro ? { scale: 0, rotate: -90, opacity: 0 } : false}
        animate={idle ? { scale: [1, 1.04, 1], rotate: 0, opacity: 1 } : { scale: 1, rotate: 0, opacity: 1 }}
        transition={
          idle
            ? { duration: 4, repeat: Infinity, ease: "easeInOut" }
            : { type: "spring", stiffness: 140, damping: 14, mass: 1.1, delay: delay + 0.1 }
        }
      >
        <path d={STAR} fill={`url(#${id}s)`} />
        <path d={STAR_INNER} fill="#FFFFFF" opacity="0.18" />
      </motion.g>

      {/* glühender Kern */}
      <motion.circle
        cx="256"
        cy="256"
        r="58"
        fill={`url(#${id}c)`}
        style={{ transformOrigin: "256px 256px" }}
        initial={intro ? { scale: 0, opacity: 0 } : false}
        animate={idle ? { scale: [1, 1.25, 1], opacity: [0.85, 1, 0.85] } : { scale: [0, 2.2, 1], opacity: [0, 1, 1] }}
        transition={idle ? { duration: 3, repeat: Infinity, ease: "easeInOut" } : { duration: 1.2, delay: delay + 0.35, times: [0, 0.4, 1] }}
      />

      {/* vordere Hälfte der Umlaufbahn + Planet */}
      <g transform="rotate(-24 256 256)">
        <motion.ellipse
          cx="256"
          cy="256"
          rx="214"
          ry="70"
          fill="none"
          stroke={`url(#${id}o)`}
          strokeWidth="13"
          clipPath={`url(#${id}f)`}
          initial={intro ? { pathLength: 0 } : false}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, delay: delay + 0.25, ease: [0.65, 0, 0.35, 1] }}
        />
        <motion.circle
          cx="420"
          cy="301"
          r="17"
          fill="#FFD9C2"
          initial={intro ? { scale: 0, opacity: 0 } : false}
          animate={{ scale: 1, opacity: 1 }}
          style={{ transformOrigin: "420px 301px" }}
          transition={{ type: "spring", stiffness: 300, damping: 12, delay: delay + 1.1 }}
        />
      </g>
    </motion.svg>
  );
}
