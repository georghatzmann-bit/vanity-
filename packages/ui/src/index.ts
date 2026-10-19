// Öffentliche API des AEGIS Design-Systems (@aegis/ui).
// Stile separat einbinden: `import '@aegis/ui/styles.css';`

export * from './tokens/index.ts';

export { AegisLogo, type AegisLogoProps } from './logo/AegisLogo.tsx';
export { AegisWordmark, type AegisWordmarkProps } from './logo/AegisWordmark.tsx';
export type { LogoAppearance, LogoTone } from './logo/LogoParts.tsx';
export {
  fillShape,
  innerMark,
  lockup,
  lockupViewBox,
  markGeometry,
  markSize,
  markStrokeWidth,
  markViewBox,
  outline,
  outlineLeft,
  outlineRight,
  reveal,
  scanLine,
  scanLineSpan,
  wordmarkCapHeight,
  wordmarkFill,
  wordmarkStroke,
  wordmarkStrokeWidth,
  wordmarkViewBox,
  wordmarkWidth,
} from './logo/geometry.ts';

export { BootSequence, type BootSequenceProps } from './boot/BootSequence.tsx';
export {
  BOOT_FALLBACK_MS,
  BOOT_SKIP_FADE_MS,
  MAX_DURATION_SCALE,
  bootTimeline,
  reducedBootTimeline,
  type BootPhase,
  type TimelineStep,
} from './boot/timeline.ts';

export * from './sound/index.ts';

export {
  REDUCED_MOTION_QUERY,
  prefersReducedMotion,
  useReducedMotionPreference,
} from './hooks/useReducedMotionPreference.ts';
