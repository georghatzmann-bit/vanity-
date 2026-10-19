import { MotionConfig } from 'motion/react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  AegisLogo,
  BootSequence,
  Button,
  CommandPalette,
  IconDashboard,
  IconKey,
  IconMoon,
  IconPlay,
  IconQuarantine,
  IconSearch,
  IconSoundOff,
  IconSun,
  IconTrash,
  Kbd,
  SegmentedControl,
  ToastProvider,
  isSoundEnabled,
  setSoundEnabled,
  themes,
  useToast,
  type CommandItem,
  type ThemeName,
} from '../src/index.ts';
import {
  ButtonsSection,
  EmptySection,
  IconsSection,
  InputsSection,
  OverlaysSection,
  StatusSection,
  SurfacesSection,
} from './componentSections.tsx';
import {
  ConsentSection,
  DashboardDemo,
  PaletteSection,
  idleConsentFlow,
  openConsentExample,
  type ConsentFlow,
} from './patterns.tsx';
import { cx } from './primitives.tsx';
import {
  ColorSection,
  LogoSection,
  MotionSection,
  RiskSection,
  SoundSection,
  TypeSection,
} from './sections.tsx';

type DemoParam = 'palette' | 'quarantine' | 'terminate' | 'delete' | 'deadline' | null;

/**
 * URL-Parameter für Prüfzwecke: ?theme=light, ?boot=1 (beim Laden abspielen), ?bootScale=2,
 * ?demo=palette|quarantine|terminate|delete|deadline (Overlay beim Laden öffnen).
 */
function readParams(): {
  theme: ThemeName;
  autoBoot: boolean;
  bootScale: number | undefined;
  demo: DemoParam;
} {
  const params = new URLSearchParams(window.location.search);
  const scale = Number.parseFloat(params.get('bootScale') ?? '');
  const demo = params.get('demo');
  const demos = ['palette', 'quarantine', 'terminate', 'delete', 'deadline'] as const;
  return {
    theme: params.get('theme') === 'light' ? 'light' : 'dark',
    autoBoot: params.get('boot') === '1',
    bootScale: Number.isFinite(scale) ? scale : undefined,
    demo: demos.find((value) => value === demo) ?? null,
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
  {
    group: 'Muster',
    items: [
      ['dashboard', 'Dashboard'],
      ['freigabe', 'Freigabe-Dialog'],
    ],
  },
  {
    group: 'Komponenten',
    items: [
      ['buttons', 'Buttons'],
      ['flaechen', 'Flächen & Tasten'],
      ['status', 'Status & Score'],
      ['eingaben', 'Schalter & Reiter'],
      ['overlays', 'Tooltip, Meldung, Dialog'],
      ['palette', 'Befehlspalette'],
      ['icons', 'Icons'],
      ['leer', 'Platzhalter & Laden'],
    ],
  },
  {
    group: 'Tokens',
    items: [
      ['farben', 'Farben'],
      ['risiko', 'Risikostufen'],
      ['typografie', 'Typografie'],
      ['bewegung', 'Bewegung'],
      ['logo', 'Logo'],
      ['klang', 'Klang'],
    ],
  },
] as const;

function jumpTo(id: string): void {
  const section = document.getElementById(id);
  section?.scrollIntoView({ block: 'start' });
  document.getElementById(`${id}-heading`)?.focus({ preventScroll: true });
}

function isDialogOpen(): boolean {
  return document.querySelector('[data-aegis-dialog-root][data-state="open"]') !== null;
}

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

  return (
    <MotionConfig reducedMotion="user">
      {booting && (
        <BootSequence
          key={bootRun}
          onComplete={() => setBooting(false)}
          {...(params.bootScale === undefined ? {} : { durationScale: params.bootScale })}
        />
      )}
      {/*
       * Referenz-Einbindung: Solange die Start-Ebene liegt, ist die ganze Seite darunter
       * `inert` und vor Hilfstechnologien verborgen. Die Reihenfolge im DOM allein reicht
       * nicht – sonst führt Tab nach „Überspringen“ auf verdeckte Elemente (WCAG 2.4.11).
       */}
      <div inert={booting} aria-hidden={booting ? true : undefined} data-testid="showcase-content">
        <ToastProvider>
          <ShowcaseContent
            theme={theme}
            setTheme={setTheme}
            booting={booting}
            startBoot={startBoot}
            replayRef={replayRef}
            demo={params.demo}
          />
        </ToastProvider>
      </div>
    </MotionConfig>
  );
}

interface ContentProps {
  readonly theme: ThemeName;
  readonly setTheme: (theme: ThemeName) => void;
  readonly booting: boolean;
  readonly startBoot: () => void;
  readonly replayRef: RefObject<HTMLButtonElement | null>;
  readonly demo: DemoParam;
}

function ShowcaseContent({ theme, setTheme, booting, startBoot, replayRef, demo }: ContentProps) {
  const toast = useToast();
  const [paletteOpen, setPaletteOpen] = useState(demo === 'palette');
  const [flow, setFlow] = useState<ConsentFlow>(() =>
    demo === null || demo === 'palette' ? idleConsentFlow : openConsentExample(demo),
  );

  // Strg+K / ⌘K öffnet die Palette (nicht während der Start-Animation oder über einem Dialog).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || event.altKey) {
        return;
      }
      if (booting || isDialogOpen()) {
        return;
      }
      event.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [booting]);

  const commands: CommandItem[] = [
    ...navigation.flatMap(({ items }) =>
      items.map(([id, label]): CommandItem => ({
        id: `nav-${id}`,
        label,
        group: 'Abschnitte',
        keywords: [id],
        onSelect: () => jumpTo(id),
      })),
    ),
    {
      id: 'theme',
      label: theme === 'dark' ? 'Helles Farbschema' : 'Dunkles Farbschema',
      group: 'Darstellung',
      keywords: ['theme', 'hell', 'dunkel', 'farbschema', 'light', 'dark'],
      icon: theme === 'dark' ? <IconSun /> : <IconMoon />,
      onSelect: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    },
    {
      id: 'sound',
      label: 'Klänge ein/aus',
      group: 'Darstellung',
      keywords: ['sound', 'ton', 'stumm'],
      icon: <IconSoundOff />,
      onSelect: () => {
        const next = !isSoundEnabled();
        setSoundEnabled(next);
        toast.show({ title: next ? 'Klänge an' : 'Klänge aus', tone: 'info' });
      },
    },
    {
      id: 'boot',
      label: 'Start-Animation abspielen',
      group: 'Beispiele',
      keywords: ['boot', 'logo', 'intro'],
      icon: <IconPlay />,
      onSelect: startBoot,
    },
    {
      id: 'consent',
      label: 'Freigabe-Beispiel: Quarantäne',
      group: 'Beispiele',
      keywords: ['freigabe', 'consent', 'dialog', 'eicar'],
      icon: <IconQuarantine />,
      onSelect: () => setFlow(openConsentExample('quarantine')),
    },
    {
      id: 'delete',
      label: 'Freigabe-Beispiel: Endgültig löschen',
      group: 'Beispiele',
      keywords: ['löschen', 'delete', 'zweite bestätigung'],
      icon: <IconTrash />,
      onSelect: () => setFlow(openConsentExample('delete')),
    },
    {
      id: 'vault',
      label: 'Tresor öffnen',
      group: 'Module',
      keywords: ['vault', 'passwort'],
      icon: <IconKey />,
      hint: 'Folgt in P9',
      disabled: true,
      onSelect: () => undefined,
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      group: 'Module',
      icon: <IconDashboard />,
      shortcut: ['Strg', '1'],
      onSelect: () => jumpTo('dashboard'),
    },
  ];

  return (
    <>
      <a
        href="#inhalt"
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Zum Inhalt springen
      </a>
      <header className="glass sticky top-0 z-40 border-b border-border">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <AegisLogo variant="full" size={24} className="text-text" title="AEGIS Design-System" />
          <span className="hidden font-mono text-2xs tracking-caps text-text-subtle uppercase sm:inline">
            @aegis/ui
          </span>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden sm:block">
              <Button
                variant="ghost"
                size="sm"
                iconStart={<IconSearch />}
                onClick={() => setPaletteOpen(true)}
              >
                <span className="mr-1">Befehle</span>
                <Kbd keys={['Strg', 'K']} size="sm" />
              </Button>
            </span>
            <SegmentedControl
              label="Farbschema"
              size="sm"
              value={theme}
              onValueChange={setTheme}
              options={[
                { value: 'dark', label: 'Dunkel', icon: <IconMoon /> },
                { value: 'light', label: 'Hell', icon: <IconSun /> },
              ]}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:grid lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-10">
        <nav
          aria-label="Abschnitte"
          className="sticky top-14 z-30 -mx-4 overflow-x-auto border-b border-border bg-bg/90 px-4 py-2 lg:top-14 lg:mx-0 lg:h-[calc(100dvh-3.5rem)] lg:overflow-y-auto lg:border-b-0 lg:bg-transparent lg:px-0 lg:py-10"
        >
          <div className="flex gap-6 lg:flex-col">
            {navigation.map(({ group, items }) => (
              <div key={group} className="shrink-0">
                <p className="hidden px-2.5 pb-2 font-mono text-2xs tracking-caps text-text-subtle uppercase lg:block">
                  {group}
                </p>
                <ul className="flex gap-1 lg:flex-col lg:gap-0.5">
                  {items.map(([id, label]) => (
                    <li key={id}>
                      <a
                        href={`#${id}`}
                        className="block rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap text-text-muted hover:bg-surface-2 hover:text-text"
                      >
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <main id="inhalt" className="min-w-0">
          <section
            aria-labelledby="hero-heading"
            className="relative grid grid-cols-1 items-center gap-10 border-b border-border py-14 sm:py-16 md:grid-cols-[minmax(0,1fr)_auto]"
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
                Tokens, Logo, Start-Animation, Klang und die Komponenten der AEGIS Suite – dunkel
                als Standard, Cyan als Akzent, Bernstein und Rot nur für Warnungen. Kontraste nach
                WCAG AA, alles per Tastatur bedienbar.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button
                  ref={replayRef}
                  variant="primary"
                  iconStart={<IconPlay />}
                  onClick={startBoot}
                >
                  Start-Animation abspielen
                </Button>
                <span className="text-xs text-text-subtle">
                  Überspringen mit <Kbd size="sm">Esc</Kbd>, <Kbd size="sm">Enter</Kbd>,{' '}
                  <Kbd size="sm">Leertaste</Kbd> oder Klick
                </span>
              </div>
            </div>
            <div className="relative mx-auto grid size-48 place-items-center sm:size-56">
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

          <DashboardDemo />
          <ConsentSection flow={flow} setFlow={setFlow} />
          <ButtonsSection />
          <SurfacesSection />
          <StatusSection />
          <InputsSection />
          <OverlaysSection />
          <PaletteSection onOpen={() => setPaletteOpen(true)} />
          <IconsSection />
          <EmptySection />
          <ColorSection theme={theme} />
          <RiskSection theme={theme} />
          <TypeSection />
          <MotionSection />
          <LogoSection />
          <SoundSection />
        </main>
      </div>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-xs text-text-subtle sm:px-6">
          <span>
            AEGIS Suite · Design-System @aegis/ui · Beispiele und Demo-Daten sind erfunden
          </span>
          <span>
            Schriften: Inter, JetBrains Mono (SIL OFL 1.1, lokal) · Hintergrund{' '}
            <code className="text-text-muted">{themes[theme].colors.bg}</code>
          </span>
        </div>
      </footer>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} items={commands} />
    </>
  );
}
