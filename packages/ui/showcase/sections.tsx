import { motion } from 'motion/react';
import { useState } from 'react';
import appIconUrl from '../assets/logo-mark.svg';
import {
  AegisLogo,
  AegisWordmark,
  Button,
  RiskBadge,
  Toggle,
  contrastRatio,
  durations,
  easings,
  formatContrastRatio,
  getUiSound,
  riskDescriptions,
  riskLevels,
  springs,
  themes,
  typeScale,
  useSoundEnabled,
  type ColorToken,
  type EasingToken,
  type ThemeName,
  type TypeScaleToken,
} from '../src/index.ts';
import { Card, Pass, Section, cx } from './primitives.tsx';

/* ------------------------------------------------------------------- Farben */

interface ContrastCheck {
  readonly label: string;
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  /** 4,5 für Text, 3 für Bedienelemente/Grafik (WCAG 1.4.11). */
  readonly minimum: number;
}

interface SwatchSpec {
  readonly token: ColorToken;
  readonly name: string;
  readonly checks: readonly ContrastCheck[];
}

const onSurface = (token: ColorToken): readonly ContrastCheck[] => [
  { label: 'Text', foreground: 'text', background: token, minimum: 4.5 },
  { label: 'Gedämpft', foreground: 'text-muted', background: token, minimum: 4.5 },
];

const swatchGroups: readonly {
  readonly title: string;
  readonly swatches: readonly SwatchSpec[];
}[] = [
  {
    title: 'Flächen',
    swatches: [
      { token: 'bg', name: 'Hintergrund', checks: onSurface('bg') },
      { token: 'surface-1', name: 'Fläche 1', checks: onSurface('surface-1') },
      { token: 'surface-2', name: 'Fläche 2', checks: onSurface('surface-2') },
      { token: 'surface-3', name: 'Fläche 3', checks: onSurface('surface-3') },
      {
        token: 'border-strong',
        name: 'Rahmen kräftig',
        checks: [
          { label: 'auf Hintergrund', foreground: 'border-strong', background: 'bg', minimum: 3 },
          {
            label: 'auf Fläche 3',
            foreground: 'border-strong',
            background: 'surface-3',
            minimum: 3,
          },
        ],
      },
      { token: 'border', name: 'Rahmen (Haarlinie)', checks: [] },
    ],
  },
  {
    title: 'Text',
    swatches: [
      {
        token: 'text',
        name: 'Text',
        checks: [{ label: 'auf Hintergrund', foreground: 'text', background: 'bg', minimum: 4.5 }],
      },
      {
        token: 'text-muted',
        name: 'Text gedämpft',
        checks: [
          {
            label: 'auf Fläche 3',
            foreground: 'text-muted',
            background: 'surface-3',
            minimum: 4.5,
          },
        ],
      },
      {
        token: 'text-subtle',
        name: 'Text dezent',
        // Dezenter Text trägt kleine Beschriftungen (11–12 px) → volle AA-Schwelle 4,5 : 1;
        // Fläche 3 ist in beiden Themes der ungünstigste Fall.
        checks: [
          { label: 'auf Hintergrund', foreground: 'text-subtle', background: 'bg', minimum: 4.5 },
          {
            label: 'auf Fläche 3',
            foreground: 'text-subtle',
            background: 'surface-3',
            minimum: 4.5,
          },
        ],
      },
    ],
  },
  {
    title: 'Akzent & Status',
    swatches: [
      {
        token: 'accent',
        name: 'Akzent',
        checks: [
          { label: 'auf Hintergrund', foreground: 'accent', background: 'bg', minimum: 4.5 },
          { label: 'Schrift darauf', foreground: 'on-accent', background: 'accent', minimum: 4.5 },
        ],
      },
      {
        token: 'accent-strong',
        name: 'Akzent kräftig',
        checks: [
          {
            label: 'Schrift darauf',
            foreground: 'on-accent',
            background: 'accent-strong',
            minimum: 4.5,
          },
        ],
      },
      {
        token: 'focus',
        name: 'Fokusring',
        checks: [
          { label: 'auf Fläche 3', foreground: 'focus', background: 'surface-3', minimum: 3 },
        ],
      },
      {
        token: 'success',
        name: 'Erfolg',
        checks: [
          { label: 'auf Hintergrund', foreground: 'success', background: 'bg', minimum: 4.5 },
        ],
      },
      {
        token: 'warn',
        name: 'Warnung',
        checks: [{ label: 'auf Hintergrund', foreground: 'warn', background: 'bg', minimum: 4.5 }],
      },
      {
        token: 'danger',
        name: 'Gefahr',
        checks: [
          { label: 'auf Hintergrund', foreground: 'danger', background: 'bg', minimum: 4.5 },
        ],
      },
    ],
  },
];

export function ColorSection({ theme }: { readonly theme: ThemeName }) {
  const colors = themes[theme].colors;
  return (
    <Section
      id="farben"
      eyebrow="Tokens"
      title="Farben"
      description="Semantische Tokens statt Rohfarben. Die Kontrastwerte werden für das aktive Farbschema berechnet (WCAG 2.2: Text ≥ 4,5 : 1, Bedienelemente ≥ 3 : 1)."
    >
      <div className="space-y-8">
        {swatchGroups.map((group) => (
          <div key={group.title}>
            <h3 className="mb-3 text-xs font-semibold tracking-caps text-text-subtle uppercase">
              {group.title}
            </h3>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.swatches.map((swatch) => (
                <li key={swatch.token}>
                  <Card className="flex h-full gap-3 p-3">
                    <span
                      aria-hidden="true"
                      className="size-14 shrink-0 rounded-lg border border-border"
                      style={{ background: `var(--aegis-${swatch.token})` }}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text">{swatch.name}</p>
                      <p className="truncate font-mono text-2xs text-text-subtle">
                        --aegis-{swatch.token} · {colors[swatch.token]}
                      </p>
                      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                        {swatch.checks.map((check) => {
                          const ratio = contrastRatio(
                            colors[check.foreground],
                            colors[check.background],
                          );
                          return (
                            <li key={check.label} className="flex items-center gap-1.5 text-2xs">
                              <span className="text-text-muted">{check.label}</span>
                              <span className="font-mono text-text tabular">
                                {formatContrastRatio(ratio)}
                              </span>
                              <Pass ok={ratio >= check.minimum}>
                                {check.minimum >= 4.5 ? 'AA' : 'AA 3:1'}
                              </Pass>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------- Risikostufen */

export function RiskSection({ theme }: { readonly theme: ThemeName }) {
  const colors = themes[theme].colors;
  return (
    <Section
      id="risiko"
      eyebrow="Tokens"
      title="Risikostufen"
      description="Sechs Stufen mit eigener Farbe und dezenter Fläche. Farbe ist nie die einzige Information – die Stufe steht immer als Text daneben."
    >
      <Card className="divide-y divide-border">
        {riskLevels.map((level) => {
          const onSubtle = contrastRatio(colors[`risk-${level}`], colors[`risk-${level}-subtle`]);
          const onBg = contrastRatio(colors[`risk-${level}`], colors.bg);
          return (
            <div
              key={level}
              className="grid grid-cols-1 items-center gap-2 px-4 py-3 sm:grid-cols-[11rem_minmax(0,1fr)_auto] sm:gap-4"
            >
              <div>
                <RiskBadge level={level} />
              </div>
              <p className="text-sm text-text-muted">{riskDescriptions[level]}</p>
              <p className="flex flex-wrap items-center gap-2 font-mono text-2xs text-text-subtle tabular">
                <span>Fläche {formatContrastRatio(onSubtle)}</span>
                <span>Hintergrund {formatContrastRatio(onBg)}</span>
                <Pass ok={onSubtle >= 4.5 && onBg >= 4.5}>AA</Pass>
              </p>
            </div>
          );
        })}
      </Card>
    </Section>
  );
}

/* --------------------------------------------------------------- Typografie */

const typeSamples: Readonly<Record<TypeScaleToken, string>> = {
  display: 'Geschützt.',
  '3xl': 'Echtzeitschutz aktiv',
  '2xl': 'Letzter Scan: vor 3 Minuten',
  xl: 'Quarantäne enthält 2 Objekte',
  lg: 'Aktion bestätigen',
  md: 'Was passiert dann? Die Datei wird verschlüsselt verschoben.',
  base: 'Standard für Fließtext in der App – ruhig, gut lesbar, 14 px.',
  sm: 'Sekundäre Informationen und Tabellenzeilen.',
  xs: 'Hinweise, Zeitstempel, Fußnoten.',
  '2xs': 'MINI-LABELS · STATUSZEILEN',
};

const typeClasses: Readonly<Record<TypeScaleToken, string>> = {
  display: 'text-display font-semibold tracking-tight',
  '3xl': 'text-3xl font-semibold tracking-tight',
  '2xl': 'text-2xl font-semibold tracking-tight',
  xl: 'text-xl font-semibold',
  lg: 'text-lg font-medium',
  md: 'text-md',
  base: 'text-base',
  sm: 'text-sm',
  xs: 'text-xs',
  '2xs': 'text-2xs tracking-caps',
};

const scaleOrder: readonly TypeScaleToken[] = [
  'display',
  '3xl',
  '2xl',
  'xl',
  'lg',
  'md',
  'base',
  'sm',
  'xs',
  '2xs',
];

export function TypeSection() {
  return (
    <Section
      id="typografie"
      eyebrow="Tokens"
      title="Typografie"
      description="Inter Variable für die Oberfläche, JetBrains Mono für Hashes, Pfade und Technik – beide lokal gebündelt."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="divide-y divide-border">
          {scaleOrder.map((token) => (
            <div key={token} className="flex items-baseline gap-4 px-4 py-3">
              <span className="w-24 shrink-0 font-mono text-2xs text-text-subtle tabular">
                {token} · {Math.round(Number.parseFloat(typeScale[token].size) * 16)}px
              </span>
              <span className={cx('min-w-0 truncate text-text', typeClasses[token])}>
                {typeSamples[token]}
              </span>
            </div>
          ))}
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="p-4">
            <p className="text-xs font-semibold tracking-caps text-text-subtle uppercase">Mono</p>
            <p className="mt-2 font-mono text-sm break-all text-text">
              SHA-256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
            </p>
            <p className="mt-1 font-mono text-xs text-text-muted">
              C:\Users\Anna\Downloads\setup_v2.4.1.exe
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-semibold tracking-caps text-text-subtle uppercase">
              Tabellarische Ziffern
            </p>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted">
                  <th className="pb-1 text-right font-normal">Proportional</th>
                  <th className="pb-1 text-right font-normal">Tabellarisch</th>
                </tr>
              </thead>
              <tbody className="text-text">
                {['1.111.111', '8.884.003', '10.240.517'].map((n) => (
                  <tr key={n}>
                    <td className="text-right">{n}</td>
                    <td className="text-right tabular">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card className="p-4">
            <p className="text-xs font-semibold tracking-caps text-text-subtle uppercase">
              Gewichte
            </p>
            <p className="mt-2 flex flex-wrap gap-x-4 text-md text-text">
              <span className="font-normal">Normal 400</span>
              <span className="font-medium">Mittel 500</span>
              <span className="font-semibold">Halbfett 600</span>
              <span className="font-bold">Fett 700</span>
            </p>
          </Card>
        </div>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------- Bewegung */

const easingLabels: Readonly<Record<EasingToken, string>> = {
  standard: 'standard – Zustandswechsel',
  enter: 'enter – Einblenden',
  exit: 'exit – Ausblenden',
  draw: 'draw – Linien zeichnen',
};

export function MotionSection() {
  const [played, setPlayed] = useState(false);
  return (
    <Section
      id="bewegung"
      eyebrow="Tokens"
      title="Bewegung"
      description="Animiert werden nur transform und opacity (Ausnahme: SVG-Linien zeichnen). Bei „Bewegung reduzieren“ entfallen Bewegungen."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card className="flex flex-col items-start gap-5 p-5">
          <div>
            <p className="text-sm font-medium text-text">Feder „snappy“ + Leuchten beim Hover</p>
            <p className="mt-1 text-xs text-text-muted">
              Steifigkeit {springs.snappy.stiffness}, Dämpfung {springs.snappy.damping}. Das
              Leuchten liegt auf einer eigenen Ebene und wird nur überblendet.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="primary">Jetzt prüfen</Button>
            <Button variant="secondary">Details</Button>
            <Button variant="ghost">Ignorieren</Button>
          </div>
          <dl className="grid w-full grid-cols-5 gap-2 border-t border-border pt-4">
            {Object.entries(durations).map(([name, ms]) => (
              <div key={name}>
                <dt className="font-mono text-2xs text-text-subtle">{name}</dt>
                <dd className="font-mono text-sm text-text tabular">{ms} ms</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card className="p-5">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm font-medium text-text">Easing-Kurven ({durations.slower} ms)</p>
            <Button variant="secondary" onClick={() => setPlayed((p) => !p)} aria-pressed={played}>
              {played ? 'Zurück' : 'Abspielen'}
            </Button>
          </div>
          <ul className="mt-4 space-y-3">
            {(Object.keys(easings) as EasingToken[]).map((name) => (
              <li key={name}>
                <p className="mb-1 font-mono text-2xs text-text-subtle">
                  {easingLabels[name]} · [{easings[name].join(', ')}]
                </p>
                <div className="relative h-3 rounded-full bg-surface-2">
                  <motion.span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 block w-[calc(100%-0.75rem)]"
                    initial={false}
                    animate={{ x: played ? '100%' : '0%' }}
                    transition={{ duration: durations.slower / 1000, ease: easings[name] }}
                  >
                    <span className="block size-3 rounded-full bg-accent shadow-glow" />
                  </motion.span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Section>
  );
}

/* --------------------------------------------------------------------- Logo */

const logoSizes = [16, 32, 64, 128] as const;

export function LogoSection() {
  return (
    <Section
      id="logo"
      eyebrow="Marke"
      title="Logo"
      description="Facettierter Schild aus zwei gespiegelten Strichen, darin ein spitzes Λ mit Scan-Balken – zusammen das A von AEGIS. Raster 64 × 64, pixelgenau bei 16 und 32 px."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <p className="text-xs font-semibold tracking-caps text-text-subtle uppercase">
            Größen – Strich, gefüllt, einfarbig
          </p>
          <div className="mt-4 space-y-4">
            {(['line', 'solid'] as const).map((appearance) => (
              <div key={appearance} className="flex items-end gap-6">
                {logoSizes.map((size) => (
                  <figure key={size} className="flex flex-col items-center gap-2">
                    <AegisLogo
                      size={size}
                      appearance={appearance}
                      title={`AEGIS-Logo ${appearance === 'line' ? 'Strich' : 'gefüllt'} ${size} px`}
                    />
                    <figcaption className="font-mono text-2xs text-text-subtle tabular">
                      {size}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ))}
            <div className="flex items-end gap-6 text-text">
              {logoSizes.map((size) => (
                <AegisLogo key={size} size={size} tone="mono" decorative />
              ))}
            </div>
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-6 p-5">
            <p className="text-xs font-semibold tracking-caps text-text-subtle uppercase">
              Lockup & Schriftzug
            </p>
            <AegisLogo variant="full" size={48} className="text-text" />
            <AegisWordmark height={16} className="text-text" />
          </Card>
          <Card className="flex items-center gap-5 p-5">
            <img src={appIconUrl} width={96} height={96} alt="AEGIS App-Icon" />
            <div>
              <p className="text-sm font-medium text-text">App-Icon</p>
              <p className="mt-1 text-xs text-text-muted">
                assets/logo-mark.svg (1024 × 1024) – Quelle für <code>tauri icon</code>. Erzeugt aus
                derselben Geometrie wie die Komponenten.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------------------------- Klang */

export function SoundSection() {
  const [enabled, setEnabled] = useSoundEnabled();
  const sound = getUiSound();
  return (
    <Section
      id="klang"
      eyebrow="Feedback"
      title="Klang"
      description="Winziger WebAudio-Synthesizer ohne Audiodateien. Sehr leise, abschaltbar, die Wahl wird lokal gespeichert."
    >
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <Toggle checked={enabled} onCheckedChange={setEnabled} label="UI-Klänge" />
        <span aria-hidden="true" className="h-6 w-px bg-border" />
        <Button onClick={() => sound.bootChime()} disabled={!enabled}>
          Start-Klang
        </Button>
        <Button onClick={() => sound.click()} disabled={!enabled}>
          Klick
        </Button>
        <Button onClick={() => sound.alert()} disabled={!enabled}>
          Warnton
        </Button>
      </Card>
    </Section>
  );
}
