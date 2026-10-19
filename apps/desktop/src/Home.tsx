import { AegisLogo, colorVar, durations, easings, msToSeconds } from '@aegis/ui';
import { motion } from 'motion/react';
import type { CSSProperties, Ref } from 'react';

export interface HomeProps {
  /**
   * `false`, solange die Start-Animation läuft: Der Inhalt liegt dann schon unter der
   * Start-Ebene (damit er beim Ausblenden sichtbar wird), ist aber `inert` und vor
   * Hilfstechnologien verborgen.
   */
  readonly ready: boolean;
  /** Ziel für den Fokus nach dem Start. */
  readonly headingRef?: Ref<HTMLHeadingElement>;
}

/** Eckmarken um das Zeichen – wie ein Sucher-/Scan-Rahmen. */
const frameCorners = [
  'top-0 left-0 border-t border-l',
  'top-0 right-0 border-t border-r',
  'bottom-0 left-0 border-b border-l',
  'bottom-0 right-0 border-b border-r',
] as const;

/** Ruhiger Verlauf, verwandt mit der Start-Ebene – der Übergang wirkt dadurch nahtlos. */
const backdrop: CSSProperties = {
  backgroundColor: colorVar('bg'),
  backgroundImage: `radial-gradient(60% 55% at 50% 45%, ${colorVar('surface-1')} 0%, ${colorVar('bg')} 72%)`,
};

/**
 * Platzhalter-Startseite (Phase P0). Die echte App-Shell folgt in P1.
 * Nur Design-Tokens, keine hart codierten Farben.
 */
export function Home({ ready, headingRef }: HomeProps) {
  return (
    <main
      className="relative isolate flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 text-center"
      style={backdrop}
      inert={!ready}
      aria-hidden={ready ? undefined : true}
      data-testid="home"
      data-state={ready ? 'ready' : 'booting'}
    >
      <div className="relative grid size-24 place-items-center">
        {frameCorners.map((corner) => (
          <span
            key={corner}
            aria-hidden="true"
            className={`absolute size-3 border-border-strong ${corner}`}
          />
        ))}
        <AegisLogo size={44} decorative />
      </div>

      <h1
        ref={headingRef}
        // Nur programmatisch fokussierbar (nach dem Start), nicht in der Tab-Reihenfolge;
        // als nicht bedienbares Element ohne Fokusring.
        tabIndex={-1}
        className="mt-8 text-xl font-semibold tracking-tight text-text shadow-none outline-none"
      >
        AEGIS Suite
      </h1>

      <motion.p
        className="mt-3 inline-flex items-center gap-2 font-mono text-2xs tracking-caps text-text-muted uppercase"
        initial={{ opacity: 0, y: 4 }}
        animate={ready ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
        transition={{
          duration: msToSeconds(durations.slow),
          delay: msToSeconds(durations.instant),
          ease: easings.enter,
        }}
        data-testid="home-status"
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
        Fundament bereit · Phase P0
      </motion.p>
    </main>
  );
}
