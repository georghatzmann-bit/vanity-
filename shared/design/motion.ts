/**
 * Pulsar Bewegungs-System: "Schwerkraft".
 * Elemente fliegen leicht federnd herein und kommen ruhig zum Stillstand.
 * Alle Animationen der App und des Installers benutzen diese Presets.
 */
import type { Transition, Variants } from "motion/react";

export const ease = {
  /** Standard-Kurve: schnell los, weich aus */
  out: [0.22, 1, 0.36, 1] as const,
  inOut: [0.65, 0, 0.35, 1] as const,
  /** Leichtes Überschwingen */
  spring: [0.34, 1.56, 0.64, 1] as const,
};

export const duration = {
  fast: 0.14,
  base: 0.2,
  slow: 0.38,
  cinematic: 0.9,
};

export const spring = {
  /** Für Karten, Panels: sanft, ohne Wackeln */
  gentle: { type: "spring", stiffness: 260, damping: 30, mass: 0.9 } satisfies Transition,
  /** Für Buttons, Schalter: schnell und knackig */
  snappy: { type: "spring", stiffness: 520, damping: 34, mass: 0.7 } satisfies Transition,
  /** "Schwerkraft": schwerer Körper, der sanft einrastet */
  gravity: { type: "spring", stiffness: 170, damping: 21, mass: 1.15 } satisfies Transition,
  /** Für große Flächen (Seiten, Modals) */
  smooth: { type: "spring", stiffness: 200, damping: 32, mass: 1 } satisfies Transition,
  /** Verspielt, z. B. Abzeichen-Pop-up */
  bouncy: { type: "spring", stiffness: 380, damping: 16, mass: 0.8 } satisfies Transition,
};

/** Seitenwechsel: Fade + Slide (bewusst ohne Unschärfe-Filter – der kostet auf großen Seiten zu viel Leistung) */
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 18, scale: 0.995 },
  enter: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...spring.smooth, opacity: { duration: duration.slow, ease: ease.out } },
  },
  exit: { opacity: 0, y: -10, transition: { duration: duration.base, ease: ease.inOut } },
};

/** Container, dessen Kinder gestaffelt erscheinen */
export const staggerContainer = (stagger = 0.045, delay = 0.05): Variants => ({
  initial: {},
  enter: { transition: { staggerChildren: stagger, delayChildren: delay } },
});

/** Kind-Element für gestaffeltes Erscheinen */
export const staggerItem: Variants = {
  initial: { opacity: 0, y: 22, scale: 0.97 },
  enter: { opacity: 1, y: 0, scale: 1, transition: spring.gravity },
};

export const fadeIn: Variants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: duration.slow, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: duration.base, ease: ease.inOut } },
};

export const popIn: Variants = {
  initial: { opacity: 0, scale: 0.92, y: 8 },
  enter: { opacity: 1, scale: 1, y: 0, transition: spring.snappy },
  exit: { opacity: 0, scale: 0.96, y: 4, transition: { duration: duration.fast, ease: ease.inOut } },
};

export type MotionLevel = "full" | "reduced" | "off";
