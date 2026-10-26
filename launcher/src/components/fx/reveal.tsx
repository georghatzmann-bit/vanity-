import type { ReactNode } from "react";
import { motion, type HTMLMotionProps } from "motion/react";
import { pageTransition, revealKinds, STAGGER, staggerVariants, type RevealKind } from "@/lib/motion";

/**
 * Page wrapper for page changes: fades in, rises 12 px and un-blurs; fades up on exit.
 * Used by App.tsx inside <AnimatePresence mode="wait"> – pages don't need it.
 */
export function PageTransition({ children, ...props }: Omit<HTMLMotionProps<"div">, "variants">) {
  return (
    <motion.div variants={pageTransition} initial="initial" animate="enter" exit="exit" {...props}>
      {children}
    </motion.div>
  );
}

export interface StaggerProps extends Omit<HTMLMotionProps<"div">, "variants"> {
  /** Seconds between children (default 0.04). */
  stagger?: number;
  /** Seconds before the first child. */
  delay?: number;
  /** Start when scrolled into view instead of at once. */
  inView?: boolean;
}

/**
 * Reveals its <Reveal>/<GlowCard> children one after another.
 * PageShell already is one – use Stagger for a grid or list inside a page.
 */
export function Stagger({ stagger = STAGGER, delay = 0, inView = false, ...props }: StaggerProps) {
  const trigger = inView
    ? { whileInView: "show", viewport: { once: true, amount: 0.15 } }
    : { animate: "show" };
  return <motion.div variants={staggerVariants(stagger, delay)} initial="hidden" {...trigger} {...props} />;
}

export interface RevealProps extends Omit<HTMLMotionProps<"div">, "variants"> {
  /** How it appears: "up" (default, rises 10 px), "fade", "scale", "slide" (from the left). */
  kind?: RevealKind;
  /** Animate on its own (not inside PageShell/Stagger). */
  standalone?: boolean;
  children?: ReactNode;
}

/** One item that appears inside a PageShell or Stagger (in order with its siblings). */
export function Reveal({ kind = "up", standalone = false, ...props }: RevealProps) {
  const own = standalone ? { initial: "hidden", animate: "show" } : {};
  return <motion.div variants={revealKinds[kind]} {...own} {...props} />;
}
