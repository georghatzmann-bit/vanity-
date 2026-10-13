import { useId } from "react";
import { motion } from "motion/react";
import { cn } from "../lib/cn";

export interface PulsarLogoProps {
  size?: number;
  /** "intro": baut sich auf, "idle": Strahlen drehen sich und senden Pulse aus, "static": keine Bewegung */
  mode?: "intro" | "idle" | "static";
  glow?: boolean;
  className?: string;
  /** Verzögerung der Intro-Animation in Sekunden */
  delay?: number;
}

/** Ein Lichtstrahl vom Kern nach außen (nach oben gezeichnet, wird gedreht) */
const BEAM = "M256 256 L 236 92 Q 256 10 276 92 Z";

/** Das PULSAR-Zeichen: leuchtender Kern, zwei gegenüberliegende Strahlen, Ring und Druckwellen */
export function PulsarLogo({ size = 40, mode = "static", glow = true, className, delay = 0 }: PulsarLogoProps) {
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
      style={glow ? { filter: "drop-shadow(0 0 calc(var(--nv-glow-strength) * 10px) color-mix(in oklab, var(--nv-accent) 60%, transparent))" } : undefined}
      aria-label="PULSAR"
      role="img"
    >
      <defs>
        <linearGradient id={`${id}b`} x1="0.5" y1="1" x2="0.5" y2="0">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="0.35" stopColor="var(--nv-accent)" stopOpacity="0.9" />
          <stop offset="1" stopColor="var(--nv-accent-3)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--nv-accent-2)" />
          <stop offset="0.5" stopColor="var(--nv-accent)" />
          <stop offset="1" stopColor="var(--nv-accent-3)" />
        </linearGradient>
        <radialGradient id={`${id}c`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.45" stopColor="#D9FAFF" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--nv-accent)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Druckwellen (nur idle) */}
      {idle &&
        [0, 1].map((i) => (
          <motion.circle
            key={i}
            cx="256"
            cy="256"
            r="150"
            fill="none"
            stroke="var(--nv-accent)"
            strokeWidth="6"
            style={{ transformOrigin: "256px 256px" }}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: [0.5, 1.55], opacity: [0.55, 0] }}
            transition={{ duration: 2.6, repeat: Infinity, delay: delay + i * 1.3, ease: "easeOut" }}
          />
        ))}

      {/* Ring */}
      <motion.circle
        cx="256"
        cy="256"
        r="168"
        fill="none"
        stroke={`url(#${id}r)`}
        strokeWidth="14"
        strokeLinecap="round"
        style={{ transformOrigin: "256px 256px", rotate: -90 }}
        initial={intro ? { pathLength: 0, opacity: 0 } : false}
        animate={{ pathLength: 1, opacity: 0.9 }}
        transition={{ duration: 1.1, delay: delay + 0.15, ease: [0.65, 0, 0.35, 1] }}
      />

      {/* Strahlen */}
      <motion.g
        style={{ transformOrigin: "256px 256px" }}
        initial={intro ? { rotate: -120, scale: 0.2, opacity: 0 } : { rotate: 35 }}
        animate={idle ? { rotate: [35, 395], scale: 1, opacity: 1 } : { rotate: 35, scale: 1, opacity: 1 }}
        transition={
          idle
            ? { rotate: { duration: 9, repeat: Infinity, ease: "linear" }, default: { duration: 0.6 } }
            : { type: "spring", stiffness: 110, damping: 15, mass: 1.1, delay: delay + 0.35 }
        }
      >
        <path d={BEAM} fill={`url(#${id}b)`} />
        <path d={BEAM} fill={`url(#${id}b)`} transform="rotate(180 256 256)" />
      </motion.g>

      {/* Kern */}
      <motion.circle
        cx="256"
        cy="256"
        r="64"
        fill={`url(#${id}c)`}
        style={{ transformOrigin: "256px 256px" }}
        initial={intro ? { scale: 0, opacity: 0 } : false}
        animate={idle ? { scale: [1, 1.18, 1], opacity: [0.9, 1, 0.9] } : { scale: [0, 2.4, 1], opacity: [0, 1, 1] }}
        transition={idle ? { duration: 1.3, repeat: Infinity, ease: "easeInOut" } : { duration: 1.1, delay: delay + 0.25, times: [0, 0.45, 1] }}
      />
      <circle cx="256" cy="256" r="22" fill="#FFFFFF" />
    </motion.svg>
  );
}
