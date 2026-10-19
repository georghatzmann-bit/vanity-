import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useReducedMotionPreference } from '../../hooks/useReducedMotionPreference.ts';
import { durations, easings } from '../../tokens/tokens.ts';

export interface PageTransitionProps {
  /** Wechselt der Schlüssel (z. B. die Route), blendet der Inhalt neu ein. */
  readonly transitionKey: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/**
 * Seitenwechsel: Deckkraft plus 6 px Hub (nur transform/opacity). Kein Warten auf das
 * Ausblenden der alten Seite – der Inhalt ist sofort da. Bei „Bewegung reduzieren“ gar keine
 * Animation.
 */
export function PageTransition({ transitionKey, children, className }: PageTransitionProps) {
  const reduced = useReducedMotionPreference();
  return (
    <motion.div
      key={transitionKey}
      className={className}
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: durations.base / 1000, ease: easings.enter }}
      data-transition-key={transitionKey}
    >
      {children}
    </motion.div>
  );
}
