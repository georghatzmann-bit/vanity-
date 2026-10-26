/*
 * Motion presets for the whole launcher (curves and durations from docs/brand.md).
 * Entrances ease out, exits are shorter and ease in. Springs for UI and for playful moments.
 * Everything here is used through the components in src/components/fx – pages rarely need it directly.
 */
import type { Transition, Variants } from "motion/react";

/** Entrances: fast start, soft landing. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
/** Exits: slow start, quick finish. */
export const EASE_IN = [0.7, 0, 0.84, 0] as const;
/** Small state changes (colour, size). */
export const EASE_STANDARD = [0.2, 0, 0, 1] as const;

/** Springs: SPRING_UI for indicators, toggles, panels; SPRING_PLAYFUL for logo pops and celebrations. */
export const SPRING_UI = { type: "spring", stiffness: 380, damping: 32, mass: 0.9 } as const satisfies Transition;
export const SPRING_PLAYFUL = { type: "spring", stiffness: 200, damping: 22 } as const satisfies Transition;
export const SPRING_SOFT = { type: "spring", stiffness: 140, damping: 22 } as const satisfies Transition;

/** Seconds. press = hover/press, toggle = switches/panels, page = page changes, hero = big moments. */
export const DURATION = { press: 0.12, toggle: 0.22, page: 0.42, hero: 0.6 } as const;

/** Delay between items of a list that appears. */
export const STAGGER = 0.04;

/** Container that reveals its children one after another (variant names "hidden" → "show"). */
export function staggerVariants(stagger = STAGGER, delayChildren = 0): Variants {
  return {
    hidden: {},
    show: { transition: { staggerChildren: stagger, delayChildren } },
  };
}

/** Child of a stagger container: rises 10 px and fades in. */
export const revealVariants: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE_OUT } },
};

/** Child that only fades (for things that must not move, e.g. text blocks next to a chart). */
export const fadeVariants: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3, ease: EASE_OUT } },
};

/** Child that grows from 96 % (cards, tiles). */
export const scaleVariants: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 6 },
  show: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
};

/** Child that slides in from the left (list rows). */
export const slideVariants: Variants = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { duration: 0.36, ease: EASE_OUT } },
};

export type RevealKind = "up" | "fade" | "scale" | "slide";

export const revealKinds: Record<RevealKind, Variants> = {
  up: revealVariants,
  fade: fadeVariants,
  scale: scaleVariants,
  slide: slideVariants,
};

/** Page change: fade + slight rise + un-blur in, short fade up out. */
export const pageTransition: Variants = {
  initial: { opacity: 0, y: 12, filter: "blur(6px)" },
  enter: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: DURATION.page, ease: EASE_OUT },
    transitionEnd: { filter: "none" },
  },
  exit: { opacity: 0, y: -6, filter: "blur(4px)", transition: { duration: 0.16, ease: EASE_IN } },
};

/** Overlay/dialog content: scale + fade. */
export const popVariants: Variants = {
  hidden: { opacity: 0, scale: 0.94, y: 8 },
  show: { opacity: 1, scale: 1, y: 0, transition: SPRING_UI },
  exit: { opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.14, ease: EASE_IN } },
};
