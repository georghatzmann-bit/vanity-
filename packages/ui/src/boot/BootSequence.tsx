import { motion, type Transition } from 'motion/react';
import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react';
import { prefersReducedMotion } from '../hooks/useReducedMotionPreference.ts';
import { AegisWordmark } from '../logo/AegisWordmark.tsx';
import {
  fillShape,
  innerMark,
  markSize,
  markStrokeWidth,
  markViewBox,
  outline,
  reveal,
  scanLine,
  scanLineSpan,
} from '../logo/geometry.ts';
import { MASK_VISIBLE, MarkGraphic } from '../logo/LogoParts.tsx';
import { useSvgId } from '../logo/useSvgId.ts';
import { isSoundEnabled } from '../sound/preference.ts';
import { getUiSound } from '../sound/synth.ts';
import { colorVar, easings } from '../tokens/tokens.ts';
import {
  BOOT_FALLBACK_MS,
  BOOT_SKIP_FADE_MS,
  bootTimeline,
  hasReached,
  normalizeDurationScale,
  reducedBootTimeline,
  runTimeline,
  type BootPhase,
} from './timeline.ts';

export interface BootSequenceProps {
  /** Wird genau einmal aufgerufen – nach natürlichem Ende, Überspringen oder Obergrenze. */
  readonly onComplete: () => void;
  /**
   * Zeitfaktor (1 = ≈ 1,5 s). Begrenzt auf 0–2,5; 0 = sofort fertig. Bei „Bewegung
   * reduzieren“ höchstens 1 – die Blende bleibt dann bei ≤ 300 ms.
   */
  readonly durationScale?: number;
  /** Beschriftung des Überspringen-Buttons. */
  readonly skipLabel?: string;
  /** Statusmeldung für Screenreader. */
  readonly statusLabel?: string;
  /** Start-Klang abspielen (zusätzlich gilt die globale Klang-Einstellung). Standard: an. */
  readonly sound?: boolean;
  readonly className?: string;
}

/** Tasten, die die Animation überspringen. */
const SKIP_KEYS = new Set(['Escape', 'Enter', ' ', 'Spacebar']);

/** Zustands-Updater: Phasen laufen nur vorwärts. */
function reach(target: BootPhase): (current: BootPhase) => BootPhase {
  return (current) => (hasReached(current, target) ? current : target);
}

/**
 * Start-Animation im Stil einer Hardware-Konsole: Der Schild zeichnet sich, eine Lichtlinie
 * prüft das Zeichen, der Schriftzug erscheint, dann gibt die Ebene die App frei.
 *
 * Barrierefreiheit (bewusste Entscheidungen):
 * - Eine Statusregion (role="status") meldet „AEGIS wird gestartet“; die Grafik selbst ist
 *   dekorativ (aria-hidden), weil sie keine weitere Information trägt.
 * - Kein Fokus-Diebstahl beim Start und keine Fokusfalle: Escape, Enter und Leertaste
 *   überspringen global. Das erste Tab führt zum sichtbaren Button „Überspringen“ (auch wenn
 *   der Fokus noch in der verdeckten App liegt), danach gilt die normale Tab-Reihenfolge.
 * - Pflicht für Einbindende: den App-Inhalt bis onComplete `inert` und `aria-hidden` halten.
 *   Die DOM-Reihenfolge allein reicht nicht – sonst führt Tab nach „Überspringen“ auf
 *   verdeckte Elemente (WCAG 2.4.11) und Screenreader lesen die Seite dahinter. Den Fokus
 *   erst setzen, wenn `inert` aufgehoben ist (z. B. in einem Effekt nach onComplete).
 * - Bei „Bewegung reduzieren“: kein Zeichnen, kein Lichtstreifen – statisches Logo mit
 *   kurzer Deckkraft-Blende (≤ 300 ms).
 *
 * Performance: animiert werden ausschließlich transform/opacity sowie die Strich-Länge
 * (pathLength) in SVG-Masken; keine Filter, keine Layout-Eigenschaften.
 */
export function BootSequence({
  onComplete,
  durationScale,
  skipLabel = 'Überspringen',
  statusLabel = 'AEGIS wird gestartet',
  sound = true,
  className,
}: BootSequenceProps) {
  const [reducedMotion] = useState(prefersReducedMotion);
  const [phase, setPhase] = useState<BootPhase>('idle');
  const [skipping, setSkipping] = useState(false);
  const [status, setStatus] = useState('');
  const completedRef = useRef(false);
  const chimePlayedRef = useRef(false);
  const tabRedirectedRef = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const skipButtonRef = useRef<HTMLButtonElement>(null);
  const scale = normalizeDurationScale(durationScale);
  // Bei „Bewegung reduzieren“ darf der Faktor nur verkürzen (0 = sofort), nie strecken:
  // die Deckkraft-Blende bleibt bei ≤ 300 ms gesamt.
  const timelineScale = reducedMotion ? Math.min(scale, 1) : scale;
  const done = phase === 'done';

  const finish = useEffectEvent(() => {
    if (completedRef.current) {
      return;
    }
    completedRef.current = true;
    onComplete();
  });

  // Phasen-Takt (stoppt beim Überspringen).
  useEffect(() => {
    if (skipping) {
      return undefined;
    }
    return runTimeline(reducedMotion ? reducedBootTimeline : bootTimeline, timelineScale, (next) =>
      setPhase(reach(next)),
    );
  }, [skipping, reducedMotion, timelineScale]);

  // Überspringen: kurze Blende, dann fertig.
  useEffect(() => {
    if (!skipping) {
      return undefined;
    }
    const id = setTimeout(() => setPhase(reach('done')), BOOT_SKIP_FADE_MS);
    return () => clearTimeout(id);
  }, [skipping]);

  // Harte Obergrenze, unabhängig von rAF und Motion.
  useEffect(() => {
    const id = setTimeout(() => setPhase(reach('done')), BOOT_FALLBACK_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (done) {
      finish();
    }
  }, [done]);

  // Statusmeldung erst nach dem Einhängen setzen, damit Screenreader sie sicher ansagen.
  useEffect(() => {
    const id = setTimeout(() => setStatus(statusLabel), 0);
    return () => clearTimeout(id);
  }, [statusLabel]);

  useEffect(() => {
    if (!sound || chimePlayedRef.current) {
      return;
    }
    chimePlayedRef.current = true;
    if (isSoundEnabled()) {
      getUiSound().bootChime();
    }
  }, [sound]);

  useEffect(() => {
    if (done) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.key === 'Tab') {
        // Erstes Tab führt zum Überspringen-Button, falls der Fokus noch in der (verdeckten)
        // App liegt. Nur einmal – danach normale Tab-Reihenfolge, also keine Fokusfalle.
        const layerElement = layerRef.current;
        if (!tabRedirectedRef.current && !layerElement?.contains(document.activeElement)) {
          tabRedirectedRef.current = true;
          event.preventDefault();
          skipButtonRef.current?.focus();
        }
        return;
      }
      if (!SKIP_KEYS.has(event.key)) {
        return;
      }
      // Die Taste gilt der Start-Animation, nicht der App darunter.
      event.preventDefault();
      event.stopPropagation();
      setSkipping(true);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [done]);

  if (done) {
    return null;
  }

  const exiting = skipping || hasReached(phase, 'exit');
  const layerTransition: Transition = skipping
    ? { duration: BOOT_SKIP_FADE_MS / 1000, ease: easings.exit }
    : { duration: reducedMotion ? 0.15 : 0.2 * scale, ease: easings.exit };

  const backdrop = {
    backgroundColor: colorVar('bg'),
    backgroundImage: `radial-gradient(60% 55% at 50% 45%, ${colorVar('surface-2')} 0%, ${colorVar('bg')} 72%)`,
  };

  return (
    <motion.div
      ref={layerRef}
      className={[
        'fixed inset-0 z-50 flex flex-col items-center justify-center text-text select-none',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={backdrop}
      initial={{ opacity: 1 }}
      animate={{ opacity: exiting ? 0 : 1 }}
      transition={layerTransition}
      onClick={() => setSkipping(true)}
      data-testid="aegis-boot"
      data-phase={phase}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
    >
      <p role="status" className="sr-only">
        {status}
      </p>

      {reducedMotion ? (
        <StaticBootContent visible={hasReached(phase, 'static')} />
      ) : (
        <AnimatedBootContent phase={phase} scale={scale} />
      )}

      <motion.button
        ref={skipButtonRef}
        type="button"
        className="absolute right-6 bottom-6 inline-flex items-center gap-2 rounded-md border border-border bg-surface-1/60 px-3 py-1.5 text-xs text-text-muted hover:border-border-strong hover:text-text"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reducedMotion ? 0.1 : 0.3, delay: reducedMotion ? 0 : 0.15 }}
        onClick={() => setSkipping(true)}
      >
        {skipLabel}
        <kbd
          aria-hidden="true"
          className="rounded-xs border border-border px-1 font-mono text-2xs text-text-muted"
        >
          Esc
        </kbd>
      </motion.button>
    </motion.div>
  );
}

const markStyle: CSSProperties = {
  width: 'clamp(96px, 17vmin, 148px)',
  height: 'clamp(96px, 17vmin, 148px)',
};
const wordmarkHeight = 'clamp(14px, 2.5vmin, 20px)';

function StaticBootContent({ visible }: { readonly visible: boolean }) {
  const idPrefix = useSvgId('aegis-boot-static');
  return (
    <motion.div
      className="flex flex-col items-center gap-7"
      initial={{ opacity: 0 }}
      animate={{ opacity: visible ? 1 : 0 }}
      transition={{ duration: 0.1, ease: 'linear' }}
    >
      <svg viewBox={markViewBox} style={markStyle} aria-hidden="true" focusable="false">
        <MarkGraphic appearance="line" tone="accent" idPrefix={idPrefix} />
      </svg>
      <AegisWordmark height={wordmarkHeight} decorative />
    </motion.div>
  );
}

interface AnimatedBootContentProps {
  readonly phase: BootPhase;
  readonly scale: number;
}

function AnimatedBootContent({ phase, scale }: AnimatedBootContentProps) {
  const id = useSvgId('aegis-boot');
  const gradientId = `${id}-gradient`;
  const outlineMaskId = `${id}-outline`;
  const innerMaskId = `${id}-inner`;
  const scanMaskId = `${id}-scan`;
  const seconds = (ms: number): number => (ms * scale) / 1000;

  const drawing = hasReached(phase, 'draw');
  const inner = hasReached(phase, 'inner');
  const sweeping = hasReached(phase, 'sweep');
  const word = hasReached(phase, 'word');

  const sweepDuration = seconds(400);
  // Der Scan-Balken wird genau dann freigelegt, wenn die Lichtlinie über ihm steht.
  const beamTravel = 1.2; // von −10 % bis 110 % der Zeichenbreite
  const beamAt = (fraction: number): number => (fraction + 0.1) / beamTravel;
  const scanDelay = sweepDuration * beamAt(scanLineSpan.start);
  const scanDuration = sweepDuration * (beamAt(scanLineSpan.end) - beamAt(scanLineSpan.start));

  const outlineReveal = {
    initial: { pathLength: 0 },
    animate: { pathLength: drawing ? 1 : 0 },
    transition: { duration: seconds(700), ease: easings.draw },
  } as const;
  const innerReveal = {
    initial: { pathLength: 0 },
    animate: { pathLength: inner ? 1 : 0 },
    transition: { duration: seconds(500), ease: easings.draw },
  } as const;

  return (
    <div className="flex flex-col items-center gap-7">
      <div className="relative" style={markStyle}>
        {/* Statisches Leuchten hinter dem Zeichen – nur die Deckkraft ändert sich. */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-[60%]"
          style={{
            background: `radial-gradient(closest-side, ${colorVar('accent-glow')}, transparent)`,
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: sweeping ? 0.55 : 0 }}
          transition={{ duration: seconds(600), ease: easings.standard }}
        />
        <svg
          viewBox={markViewBox}
          className="relative block size-full overflow-visible"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient
              id={gradientId}
              gradientUnits="userSpaceOnUse"
              x1={markSize / 2}
              y1={2}
              x2={markSize / 2}
              y2={62}
            >
              <stop offset="0" style={{ stopColor: colorVar('accent-strong') }} />
              <stop offset="1" style={{ stopColor: colorVar('accent') }} />
            </linearGradient>
            <mask
              id={outlineMaskId}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={markSize}
              height={markSize}
            >
              {[reveal.outlineLeft, reveal.outlineRight].map((d) => (
                <motion.path
                  key={d}
                  d={d}
                  fill="none"
                  stroke={MASK_VISIBLE}
                  strokeWidth={reveal.outlineWidth}
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                  {...outlineReveal}
                />
              ))}
            </mask>
            <mask
              id={innerMaskId}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={markSize}
              height={markSize}
            >
              {[reveal.innerLeft, reveal.innerRight].map((d) => (
                <motion.path
                  key={d}
                  d={d}
                  fill="none"
                  stroke={MASK_VISIBLE}
                  strokeWidth={reveal.innerWidth}
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                  {...innerReveal}
                />
              ))}
            </mask>
            <mask
              id={scanMaskId}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width={markSize}
              height={markSize}
            >
              <motion.path
                d={reveal.scanLine}
                fill="none"
                stroke={MASK_VISIBLE}
                strokeWidth={reveal.scanLineWidth}
                strokeLinecap="butt"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: sweeping ? 1 : 0 }}
                transition={{ duration: scanDuration, delay: scanDelay, ease: 'linear' }}
              />
            </mask>
          </defs>

          <motion.path
            d={fillShape}
            style={{ fill: colorVar('accent') }}
            initial={{ opacity: 0 }}
            animate={{ opacity: sweeping ? 0.08 : 0 }}
            transition={{ duration: seconds(400), ease: easings.standard }}
          />
          <path
            d={outline}
            fill="none"
            style={{ stroke: `url(#${gradientId})` }}
            strokeWidth={markStrokeWidth}
            strokeLinejoin="miter"
            strokeMiterlimit={4}
            mask={`url(#${outlineMaskId})`}
          />
          <path
            d={innerMark}
            style={{ fill: `url(#${gradientId})` }}
            mask={`url(#${innerMaskId})`}
          />
          <path
            d={scanLine}
            style={{ fill: colorVar('accent-strong') }}
            mask={`url(#${scanMaskId})`}
          />
        </svg>

        {/* Lichtlinie: wandert nur per translateX, Leuchten ist ein statischer Verlauf. */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-[-12%] left-0 w-full"
          initial={{ x: '-60%', opacity: 0 }}
          animate={sweeping ? { x: '60%', opacity: [0, 1, 1, 0] } : { x: '-60%', opacity: 0 }}
          transition={{
            x: { duration: sweepDuration, ease: 'linear' },
            opacity: { duration: sweepDuration, times: [0, 0.15, 0.85, 1], ease: 'linear' },
          }}
        >
          <div
            className="absolute inset-y-0 left-1/2 w-10 -translate-x-1/2"
            style={{
              backgroundImage: `linear-gradient(90deg, transparent, ${colorVar('accent-glow')} 35%, ${colorVar('accent-strong')} 50%, ${colorVar('accent-glow')} 65%, transparent)`,
              maskImage: `linear-gradient(180deg, transparent, ${MASK_VISIBLE} 22%, ${MASK_VISIBLE} 78%, transparent)`,
            }}
          />
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={word ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
        transition={{ duration: seconds(400), ease: easings.enter }}
      >
        <AegisWordmark height={wordmarkHeight} decorative />
      </motion.div>
    </div>
  );
}
