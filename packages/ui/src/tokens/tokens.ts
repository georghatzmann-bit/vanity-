/**
 * Typisierter Spiegel der Design-Tokens aus `tokens.css`.
 *
 * Die CSS-Datei ist die Quelle für Tailwind und das Theming per `data-theme`; dieser Spiegel
 * dient Stellen, an denen CSS-Variablen nicht greifen (Canvas, Motion-Übergänge, generierte
 * SVG-Assets, Kontrast-Tests). `tokens.test.ts` stellt sicher, dass beide Dateien exakt
 * übereinstimmen – Änderungen also immer in beiden Dateien vornehmen.
 */

export const themeNames = ['dark', 'light'] as const;
export type ThemeName = (typeof themeNames)[number];

/** Standard-Theme der App (dunkel). */
export const defaultTheme: ThemeName = 'dark';

export const colorTokenNames = [
  'bg',
  'surface-1',
  'surface-2',
  'surface-3',
  'surface-glass',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-subtle',
  'accent',
  'accent-strong',
  'accent-glow',
  'on-accent',
  'success',
  'warn',
  'danger',
  'focus',
  'focus-glow',
  'risk-clean',
  'risk-clean-subtle',
  'risk-info',
  'risk-info-subtle',
  'risk-game',
  'risk-game-subtle',
  'risk-risky',
  'risk-risky-subtle',
  'risk-suspicious',
  'risk-suspicious-subtle',
  'risk-dangerous',
  'risk-dangerous-subtle',
] as const;
export type ColorToken = (typeof colorTokenNames)[number];
export type ThemeColors = Readonly<Record<ColorToken, string>>;

export const shadowTokenNames = ['sm', 'md', 'lg', 'bevel', 'glow'] as const;
export type ShadowToken = (typeof shadowTokenNames)[number];
export type ThemeShadows = Readonly<Record<ShadowToken, string>>;

export interface ThemeTokens {
  readonly colors: ThemeColors;
  readonly shadows: ThemeShadows;
}

/** Dunkles Theme (Standard): kühle, fast schwarze Flächen, Cyan als Akzent. */
const dark: ThemeTokens = {
  colors: {
    bg: '#07090c',
    'surface-1': '#0d1116',
    'surface-2': '#131820',
    'surface-3': '#1a212b',
    'surface-glass': 'rgb(19 24 32 / 0.72)',
    border: '#232c38',
    'border-strong': '#56637a',
    text: '#e7edf4',
    'text-muted': '#9ba8b7',
    'text-subtle': '#6e7a89',
    accent: '#22d3ee',
    'accent-strong': '#67e8f9',
    'accent-glow': 'rgb(34 211 238 / 0.35)',
    'on-accent': '#031418',
    success: '#34d399',
    warn: '#fbbf24',
    danger: '#f87171',
    focus: '#22d3ee',
    'focus-glow': 'rgb(34 211 238 / 0.28)',
    'risk-clean': '#34d399',
    'risk-clean-subtle': '#122c28',
    'risk-info': '#60a5fa',
    'risk-info-subtle': '#192636',
    'risk-game': '#a78bfa',
    'risk-game-subtle': '#232236',
    'risk-risky': '#facc15',
    'risk-risky-subtle': '#2e2b16',
    'risk-suspicious': '#fb923c',
    'risk-suspicious-subtle': '#2e231b',
    'risk-dangerous': '#f87171',
    'risk-dangerous-subtle': '#2e1e23',
  },
  shadows: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.45)',
    md: '0 6px 16px -4px rgb(0 0 0 / 0.6), 0 2px 4px -2px rgb(0 0 0 / 0.5)',
    lg: '0 18px 40px -12px rgb(0 0 0 / 0.7), 0 6px 12px -6px rgb(0 0 0 / 0.5)',
    bevel: 'inset 0 1px 0 0 rgb(255 255 255 / 0.05)',
    glow: '0 0 0 1px rgb(34 211 238 / 0.35), 0 0 24px -4px rgb(34 211 238 / 0.45)',
  },
};

/** Helles Theme: gleiche Semantik, Farben für weiße Flächen abgedunkelt (WCAG AA). */
const light: ThemeTokens = {
  colors: {
    bg: '#f5f7fa',
    'surface-1': '#ffffff',
    'surface-2': '#f0f3f7',
    'surface-3': '#e6ebf1',
    'surface-glass': 'rgb(255 255 255 / 0.72)',
    border: '#d5dce5',
    'border-strong': '#7c899b',
    text: '#0b1220',
    'text-muted': '#475467',
    'text-subtle': '#6b7789',
    accent: '#0b6a84',
    'accent-strong': '#0a5368',
    'accent-glow': 'rgb(11 106 132 / 0.25)',
    'on-accent': '#ffffff',
    success: '#05704f',
    warn: '#a04a06',
    danger: '#b91c1c',
    focus: '#0b6a84',
    'focus-glow': 'rgb(11 106 132 / 0.22)',
    'risk-clean': '#05704f',
    'risk-clean-subtle': '#e6f1ed',
    'risk-info': '#1d4ed8',
    'risk-info-subtle': '#e8edfb',
    'risk-game': '#6d28d9',
    'risk-game-subtle': '#f0eafb',
    'risk-risky': '#875c00',
    'risk-risky-subtle': '#f3efe6',
    'risk-suspicious': '#b13a0a',
    'risk-suspicious-subtle': '#f7ebe7',
    'risk-dangerous': '#b91c1c',
    'risk-dangerous-subtle': '#f8e8e8',
  },
  shadows: {
    sm: '0 1px 2px 0 rgb(15 23 42 / 0.08)',
    md: '0 6px 16px -4px rgb(15 23 42 / 0.12), 0 2px 4px -2px rgb(15 23 42 / 0.08)',
    lg: '0 18px 40px -12px rgb(15 23 42 / 0.18), 0 6px 12px -6px rgb(15 23 42 / 0.1)',
    bevel: 'inset 0 1px 0 0 rgb(255 255 255 / 0.7)',
    glow: '0 0 0 1px rgb(11 106 132 / 0.3), 0 0 20px -4px rgb(11 106 132 / 0.3)',
  },
};

export const themes: Readonly<Record<ThemeName, ThemeTokens>> = { dark, light };

/** Eckenradien – präzise, eher knapp (Hardware-Anmutung). */
export const radii = {
  xs: '2px',
  sm: '4px',
  md: '6px',
  lg: '8px',
  xl: '12px',
  '2xl': '16px',
} as const;
export type RadiusToken = keyof typeof radii;

/** Schriftfamilien (lokal gebündelt über @fontsource-variable, keine CDNs). */
export const fonts = {
  sans: "'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  mono: "'JetBrains Mono Variable', 'Cascadia Mono', Consolas, ui-monospace, monospace",
} as const;
export type FontToken = keyof typeof fonts;

export interface TypeStep {
  /** Schriftgröße (CSS-Länge). */
  readonly size: string;
  /** Zeilenhöhe (CSS-Länge oder Faktor). */
  readonly lineHeight: string;
}

/** Typografie-Skala; Basis für Desktop-UI ist 14 px (`base`). */
export const typeScale = {
  '2xs': { size: '0.6875rem', lineHeight: '1rem' },
  xs: { size: '0.75rem', lineHeight: '1.125rem' },
  sm: { size: '0.8125rem', lineHeight: '1.25rem' },
  base: { size: '0.875rem', lineHeight: '1.375rem' },
  md: { size: '1rem', lineHeight: '1.5rem' },
  lg: { size: '1.125rem', lineHeight: '1.625rem' },
  xl: { size: '1.375rem', lineHeight: '1.875rem' },
  '2xl': { size: '1.75rem', lineHeight: '2.25rem' },
  '3xl': { size: '2.25rem', lineHeight: '2.625rem' },
  display: { size: '3rem', lineHeight: '3.25rem' },
} as const satisfies Record<string, TypeStep>;
export type TypeScaleToken = keyof typeof typeScale;

/** Laufweiten; `wordmark` ist die weite Sperrung des AEGIS-Schriftzugs. */
export const tracking = {
  tight: '-0.015em',
  normal: '0em',
  wide: '0.04em',
  caps: '0.08em',
  wordmark: '0.32em',
} as const;
export type TrackingToken = keyof typeof tracking;

/** Animationsdauern in Millisekunden. */
export const durations = {
  instant: 80,
  fast: 150,
  base: 220,
  slow: 360,
  slower: 560,
} as const;
export type DurationToken = keyof typeof durations;

/** Kubische Bézier-Kurve als Tupel (direkt für Motion `ease` nutzbar). */
export type CubicBezier = readonly [number, number, number, number];

/** Easing-Kurven: `standard` für Zustandswechsel, `enter`/`exit` für Ein-/Ausblenden. */
export const easings = {
  standard: [0.2, 0, 0, 1],
  enter: [0.05, 0.7, 0.1, 1],
  exit: [0.3, 0, 0.8, 0.15],
  draw: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, CubicBezier>;
export type EasingToken = keyof typeof easings;

export interface SpringPreset {
  readonly type: 'spring';
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

/** Feder-Voreinstellungen für Motion (nur für `transform`/`opacity` verwenden). */
export const springs = {
  /** Knackig, minimal überschwingend – Buttons, Schalter. */
  snappy: { type: 'spring', stiffness: 520, damping: 34, mass: 1 },
  /** Weich, ohne sichtbares Überschwingen – Panels, Karten. */
  gentle: { type: 'spring', stiffness: 220, damping: 28, mass: 1 },
} as const satisfies Record<string, SpringPreset>;
export type SpringToken = keyof typeof springs;

/** Millisekunden in Sekunden (Motion erwartet Sekunden). */
export function msToSeconds(ms: number): number {
  return ms / 1000;
}

/** CSS-Darstellung einer Bézier-Kurve, z. B. `cubic-bezier(0.2, 0, 0, 1)`. */
export function cubicBezierToCss(curve: CubicBezier): string {
  return `cubic-bezier(${curve.join(', ')})`;
}

/** Name der CSS-Variable eines Farb-Tokens, z. B. `--aegis-surface-1`. */
export function colorVarName(token: ColorToken): `--aegis-${ColorToken}` {
  return `--aegis-${token}`;
}

/**
 * `var(...)`-Ausdruck für ein Farb-Token mit dem Wert des Standard-Themes als Rückfall –
 * so bleiben Komponenten auch ohne geladenes `tokens.css` sichtbar.
 */
export function colorVar(token: ColorToken): string {
  return `var(${colorVarName(token)}, ${themes[defaultTheme].colors[token]})`;
}
