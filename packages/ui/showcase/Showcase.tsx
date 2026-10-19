import { MotionConfig } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { AegisLogo, BootSequence, themes, type ThemeName } from '../src/index.ts';
import { Button, Segmented, cx } from './primitives.tsx';
import {
  ColorSection,
  LogoSection,
  MotionSection,
  RiskSection,
  SoundSection,
  TypeSection,
} from './sections.tsx';

/** URL-Parameter für Prüfzwecke: ?theme=light, ?boot=1 (beim Laden abspielen), ?bootScale=2 */
function readParams(): { theme: ThemeName; autoBoot: boolean; bootScale: number | undefined } {
  const params = new URLSearchParams(window.location.search);
  const scale = Number.parseFloat(params.get('bootScale') ?? '');
  return {
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
    autoBoot: params.get('boot') === '1',
    bootScale: Number.isFinite(scale) ? scale : undefined,
  };
}

/** Eckmarken um das Hero-Zeichen (wie ein Sucher/Scan-Rahmen). */
const heroCorners = [
  'top-0 left-0 border-t border-l',
  'top-0 right-0 border-t border-r',
  'bottom-0 left-0 border-b border-l',
  'bottom-0 right-0 border-b border-r',
] as const;

const navigation = [
  ['farben', 'Farben'],
  ['risiko', 'Risikostufen'],
  ['typografie', 'Typografie'],
  ['bewegung', 'Bewegung'],
  ['logo', 'Logo'],
  ['klang', 'Klang'],
] as const;

export function Showcase() {
  const [params] = useState(readParams);
  const [theme, setTheme] = useState<ThemeName>(params.theme);
  const [bootRun, setBootRun] = useState(params.autoBoot ? 1 : 0);
  const [booting, setBooting] = useState(params.autoBoot);
  const replayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Fokus zurück zum Auslöser, damit Tastaturnutzer nicht am Seitenanfang landen – erst
  // jetzt, nachdem `inert` aufgehoben ist (in einem inerten Teil verwirft der Browser ihn).
  useEffect(() => {
    if (!booting && bootRun > 0) {
      replayRef.current?.focus({ preventScroll: true });
    }
  }, [booting, bootRun]);

  const startBoot = (): void => {
    setBootRun((run) => run + 1);
    setBooting(true);
  };

  const finishBoot = (): void => {
    setBooting(false);
  };

  return (
    <MotionConfig reducedMotion="user">
      {booting && (
        <BootSequence
          key={bootRun}
          onComplete={finishBoot}
          {...(params.bootScale === undefined ? {} : { durationScale: params.bootScale })}
        />
      )}
      {/*
       * Referenz-Einbindung: Solange die Start-Ebene liegt, ist die ganze Seite darunter
       * `inert` und vor Hilfstechnologien verborgen. Die Reihenfolge im DOM allein reicht
       * nicht – sonst führt Tab nach „Überspringen“ auf verdeckte Elemente (WCAG 2.4.11).
       */}
      <div inert={booting} aria-hidden={booting ? true : undefined} data-testid="showcase-content">
        <a
          href="#inhalt"
          className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Zum Inhalt springen
        </a>
        <header className="glass sticky top-0 z-40 border-b border-border">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
            <AegisLogo variant="full" size={24} className="text-text" title="AEGIS Design-System" />
            <nav aria-label="Abschnitte" className="hidden flex-1 md:block">
              <ul className="flex gap-1">
                {navigation.map(([id, label]) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      className="rounded-md px-2.5 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="ml-auto">
              <Segmented
                label="Farbschema"
                value={theme}
                onChange={setTheme}
                layoutId="theme-indicator"
                options={[
                  { value: 'dark', label: 'Dunkel' },
                  { value: 'light', label: 'Hell' },
                ]}
              />
            </div>
          </div>
        </header>

        <main id="inhalt" className="mx-auto max-w-6xl px-4 sm:px-6">
          <section
            aria-labelledby="hero-heading"
            className="relative grid grid-cols-1 items-center gap-10 border-b border-border py-14 sm:py-20 md:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div>
              <p className="font-mono text-2xs tracking-caps text-accent uppercase">
                AEGIS Suite · Design-System
              </p>
              <h1
                id="hero-heading"
                className="mt-3 text-3xl font-semibold tracking-tight text-text sm:text-display"
              >
                Präzise. Ruhig. Geschützt.
              </h1>
              <p className="mt-4 max-w-xl text-md text-text-muted">
                Tokens, Logo, Start-Animation und Klang für die AEGIS Suite – dunkel als Standard,
                Cyan als Akzent, Bernstein und Rot nur für Warnungen. Kontraste nach WCAG AA, alles
                per Tastatur bedienbar.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button ref={replayRef} variant="primary" onClick={startBoot}>
                  Start-Animation abspielen
                </Button>
                <span className="text-xs text-text-subtle">
                  Überspringen mit <kbd className="font-mono text-text-muted">Esc</kbd>,{' '}
                  <kbd className="font-mono text-text-muted">Enter</kbd>,{' '}
                  <kbd className="font-mono text-text-muted">Leertaste</kbd> oder Klick
                </span>
              </div>
            </div>
            <div className="relative mx-auto grid size-52 place-items-center sm:size-64">
              <div
                aria-hidden="true"
                className="absolute inset-0 rounded-full opacity-60"
                style={{
                  background: `radial-gradient(closest-side, var(--aegis-accent-glow), transparent)`,
                }}
              />
              {heroCorners.map((corner) => (
                <span
                  key={corner}
                  aria-hidden="true"
                  className={cx('absolute size-5 border-border-strong', corner)}
                />
              ))}
              <AegisLogo size="62%" decorative className="relative" />
              <span
                aria-hidden="true"
                className="absolute inset-x-0 -bottom-7 text-center font-mono text-2xs tracking-caps text-text-subtle uppercase"
              >
                Raster 64 · Strich 4
              </span>
            </div>
          </section>

          <ColorSection theme={theme} />
          <RiskSection theme={theme} />
          <TypeSection />
          <MotionSection />
          <LogoSection />
          <SoundSection />
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-text-subtle sm:px-6">
            <span>AEGIS Suite · Design-System @aegis/ui</span>
            <span>
              Schriften: Inter, JetBrains Mono (SIL OFL 1.1, lokal) · Hintergrund{' '}
              <code className="text-text-muted">{themes[theme].colors.bg}</code>
            </span>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
