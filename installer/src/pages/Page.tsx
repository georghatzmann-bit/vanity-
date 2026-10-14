/**
 * Bausteine des Bedienfelds (C.0/B.8): Seite in Fensterkoordinaten, Blöcke ab x 468 (472 breit)
 * an festen y-Lagen, Fußleiste mit Haarlinie bei y 536 und Knöpfen y 548–588.
 * Seitenwechsel: Blöcke gestaffelt im Abstand von 24 ms von oben nach unten, je Deckkraft 0→1 und
 * y 6→0 in 180 ms; Ausblenden 80 ms, überlappend mit dem Einblenden der neuen Seite (kein leeres
 * Bedienfeld, der Fokus springt sofort auf die neue H1). Reduzierte Bewegung: nur Deckkraft 120 ms,
 * ohne Staffelung. `HoldEnter`: Die erste Seite wartet, bis das Intro ausgeblendet ist.
 */
import { createContext, useContext, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { motion, useIsPresent, type Variants } from "motion/react";
import { cn } from "@shared/lib/cn";
import { useReducedMotion } from "../hooks/useReducedMotion";

const EASE = [0.2, 0, 0, 1] as const;
const Reduced = createContext(false);
/** true = Seite noch nicht auftreten lassen (Intro liegt noch darüber) */
export const HoldEnter = createContext(false);
/** Ausblenden der alten Seite (s) */
export const PAGE_EXIT_S = 0.08;

export interface PageProps {
  /** Verzögerung der Staffelung (s), z. B. 0,45 auf „Fertig“ (G.1) */
  delay?: number;
  children: ReactNode;
  testId?: string;
}

export function Page({ delay = 0, children, testId }: PageProps) {
  const reduced = useReducedMotion();
  const hold = useContext(HoldEnter);
  // Ausgehende Seite (Exit-Animation 80 ms): nicht mehr bedienbar, kein Fokus, kein Doppelklick
  const present = useIsPresent();
  const variants: Variants = {
    hidden: { opacity: 1 },
    show: { opacity: 1, transition: reduced ? { delayChildren: delay } : { staggerChildren: 0.024, delayChildren: delay } },
    exit: { opacity: 0, transition: { duration: PAGE_EXIT_S, ease: EASE } },
  };
  return (
    <Reduced.Provider value={reduced}>
      <motion.div className="pointer-events-none absolute inset-0" data-testid={testId} data-leaving={present ? undefined : "1"} inert={!present} variants={variants} initial="hidden" animate={hold ? "hidden" : "show"} exit="exit">
        {children}
      </motion.div>
    </Reduced.Provider>
  );
}

const blockVariants = (reduced: boolean): Variants =>
  reduced
    ? { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.12 } } }
    : { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE } } };

export interface BlockProps {
  /** obere Kante in Fensterkoordinaten (Spec-y) */
  y: number;
  x?: number;
  w?: number;
  /** eigener Auftritt nach dieser Zeit (s) statt der Staffelung */
  selfDelay?: number;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function Block({ y, x = 468, w = 472, selfDelay, className, style, children }: BlockProps) {
  const reduced = useContext(Reduced);
  const pos: CSSProperties = { top: y, left: x, width: w, ...style };
  if (selfDelay !== undefined) {
    return (
      <motion.div className={cn("pointer-events-auto absolute", className)} style={pos} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: selfDelay, duration: reduced ? 0.12 : 0.18, ease: EASE }}>
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div className={cn("pointer-events-auto absolute", className)} style={pos} variants={blockVariants(reduced)}>
      {children}
    </motion.div>
  );
}

/** Waagerechte Haarlinie im Bedienfeld (x 468–940) */
export function Rule({ y, x = 468, w = 472 }: { y: number; x?: number; w?: number }) {
  return <div aria-hidden className="absolute h-px bg-obs-rule" style={{ top: y, left: x, width: w }} />;
}

/**
 * Seitentitel (H1). Nach dem Seitenwechsel bekommt er den Fokus (tabIndex −1, ohne Ring),
 * außer `autoFocus` ist aus (dann hat ein Knopf `autoFocus`).
 */
export function Title({ children, small, autoFocus = true, id }: { children: ReactNode; small?: boolean; autoFocus?: boolean; id?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Unter dem Intro vorab gemountet: Fokus erst, wenn die Seite auftritt
  const hold = useContext(HoldEnter);
  useEffect(() => {
    if (!autoFocus || hold) return;
    const el = ref.current;
    if (!el) return;
    // nicht in einen offenen Dialog o. Ä. hineinfunken
    const active = document.activeElement;
    if (active && active !== document.body && active.closest("[role=alertdialog],[role=dialog]")) return;
    el.focus({ preventScroll: true });
  }, [autoFocus, hold]);
  return (
    <h1 ref={ref} id={id} tabIndex={-1} className={small ? "obs-h1-sm" : "obs-h1"}>
      {children}
    </h1>
  );
}

/** Fußleiste: Haarlinie bei y 536 über die ganze Bedienfeld-Breite, Knöpfe y 548–588. Ohne Inhalt keine Leiste. */
export function Footer({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  const reduced = useContext(Reduced);
  if (!left && !right) return null;
  return (
    <>
      <div aria-hidden className="absolute top-[536px] left-[421px] h-px w-[559px] bg-obs-rule" />
      <motion.div className="pointer-events-auto absolute top-[548px] left-[468px] flex h-10 w-[472px] items-center justify-between gap-4" variants={blockVariants(reduced)}>
        <div className="flex min-w-0 items-center gap-2">{left}</div>
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      </motion.div>
    </>
  );
}

/** Platzhalter für leere Werte (Gedankenstrich, B.4: im Plex-latin-Subset vorhanden) */
export const DASH = "—";
