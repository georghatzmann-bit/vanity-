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
export {
  useControllableState,
  type ControllableStateOptions,
} from './hooks/useControllableState.ts';
export { useNow } from './hooks/useNow.ts';
export { usePresence } from './hooks/usePresence.ts';

export * from './icons/index.ts';
export * from './components/index.ts';

export { cx, type ClassValue } from './utils/cx.ts';
export { mergeRefs } from './utils/refs.ts';
export { focusElement, getTabbableElements } from './utils/focus.ts';
export {
  MAX_TIMEOUT_MS,
  formatCountdown,
  formatSecondsShort,
  toEpochMs,
  type TimeInput,
} from './utils/time.ts';
export {
  containsRightToLeft,
  formatCodePoint,
  hasInvisibleCharacters,
  invisibleCharacterName,
  invisibleMarker,
  middleTruncateUnits,
  revealInvisibleCharacters,
  splitInvisibleCharacters,
  toSafeTextUnits,
  type MiddleTruncation,
  type SafeTextSegment,
  type SafeTextUnit,
} from './utils/text.ts';
export {
  foldForSearch,
  foldWithMap,
  scoreSearchable,
  tokenizeQuery,
  type FoldedText,
  type SearchResult,
  type SearchableText,
  type TextMatch,
  type TextRange,
} from './utils/search.ts';
