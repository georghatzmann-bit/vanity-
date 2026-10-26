import { useReducedMotionConfig } from "motion/react";

/**
 * true when the user wants less movement: the app's "Reduce motion" option (MotionConfig
 * reducedMotion="always") or the Windows setting "Show animations" turned off.
 * Use it to skip endless loops and movement; short fades are still fine.
 */
export function useCalmMotion(): boolean {
  return Boolean(useReducedMotionConfig());
}
