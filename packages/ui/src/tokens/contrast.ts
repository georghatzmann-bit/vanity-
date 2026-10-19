/**
 * WCAG-2.x-Kontrastberechnung (relative Leuchtdichte + Kontrastverhältnis).
 * Grundlage: https://www.w3.org/TR/WCAG22/#dfn-relative-luminance
 *
 * Unterstützte Farbangaben: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`
 * (Komma- und Leerzeichen-Syntax, Alpha als Zahl oder Prozent).
 */

export interface Rgba {
  /** Rot 0–255 */
  readonly r: number;
  /** Grün 0–255 */
  readonly g: number;
  /** Blau 0–255 */
  readonly b: number;
  /** Deckkraft 0–1 */
  readonly a: number;
}

export type WcagLevel = 'AA' | 'AAA';
export type TextSize = 'normal' | 'large';

const HEX_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_PATTERN = /^rgba?\(\s*([^)]*)\)$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHex(input: string): Rgba | null {
  const match = HEX_PATTERN.exec(input);
  const digits = match?.[1];
  if (digits === undefined) {
    return null;
  }
  const full =
    digits.length <= 4
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  const channel = (index: number): number => Number.parseInt(full.slice(index, index + 2), 16);
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: full.length === 8 ? channel(6) / 255 : 1,
  };
}

function parseChannel(raw: string): number {
  const value = raw.endsWith('%') ? (Number.parseFloat(raw) / 100) * 255 : Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Ungültiger Farbkanal: „${raw}“`);
  }
  return clamp(value, 0, 255);
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined) {
    return 1;
  }
  const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`Ungültiger Alpha-Wert: „${raw}“`);
  }
  return clamp(value, 0, 1);
}

function parseRgbFunction(input: string): Rgba | null {
  const body = RGB_PATTERN.exec(input)?.[1];
  if (body === undefined) {
    return null;
  }
  // Moderne Syntax „r g b / a“ oder klassische „r, g, b, a“.
  const [channelPart = '', alphaPart] = body.includes('/') ? body.split('/') : [body, undefined];
  const parts = channelPart
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  let alphaRaw = alphaPart?.trim();
  if (alphaRaw === undefined && parts.length === 4) {
    alphaRaw = parts.pop();
  }
  const [r, g, b] = parts;
  if (parts.length !== 3 || r === undefined || g === undefined || b === undefined) {
    throw new TypeError(`Ungültige rgb()-Angabe: „${input}“`);
  }
  return { r: parseChannel(r), g: parseChannel(g), b: parseChannel(b), a: parseAlpha(alphaRaw) };
}

/** Wandelt eine Farbangabe in RGBA um; wirft `TypeError` bei unbekannten Formaten. */
export function parseColor(input: string): Rgba {
  const value = input.trim();
  const parsed = parseHex(value) ?? parseRgbFunction(value);
  if (parsed === null) {
    throw new TypeError(`Nicht unterstütztes Farbformat: „${input}“`);
  }
  return parsed;
}

/** Legt eine (teil-)transparente Farbe über einen deckenden Hintergrund. */
export function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  if (background.a < 1) {
    throw new RangeError('Der Hintergrund muss deckend sein (Alpha = 1).');
  }
  const a = foreground.a;
  return {
    r: foreground.r * a + background.r * (1 - a),
    g: foreground.g * a + background.g * (1 - a),
    b: foreground.b * a + background.b * (1 - a),
    a: 1,
  };
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toRgba(color: string | Rgba): Rgba {
  return typeof color === 'string' ? parseColor(color) : color;
}

/** Relative Leuchtdichte (0 = Schwarz, 1 = Weiß) einer deckenden Farbe. */
export function relativeLuminance(color: string | Rgba): number {
  const { r, g, b, a } = toRgba(color);
  if (a < 1) {
    throw new RangeError(
      'Leuchtdichte nur für deckende Farben definiert – vorher compositeOver().',
    );
  }
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Kontrastverhältnis (1–21) zwischen Vorder- und Hintergrund. Eine transparente
 * Vordergrundfarbe wird zuvor über den (deckenden) Hintergrund gelegt.
 */
export function contrastRatio(foreground: string | Rgba, background: string | Rgba): number {
  const bg = toRgba(background);
  const fg = compositeOver(toRgba(foreground), bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Mindestkontrast laut WCAG 2.x (1.4.3 / 1.4.6). */
export function minimumContrast(level: WcagLevel = 'AA', size: TextSize = 'normal'): number {
  if (level === 'AAA') {
    return size === 'large' ? 4.5 : 7;
  }
  return size === 'large' ? 3 : 4.5;
}

/** Prüft, ob ein Farbpaar die WCAG-Stufe erfüllt. */
export function meetsContrast(
  foreground: string | Rgba,
  background: string | Rgba,
  level: WcagLevel = 'AA',
  size: TextSize = 'normal',
): boolean {
  return contrastRatio(foreground, background) >= minimumContrast(level, size);
}

/** Formatiert ein Verhältnis für die Anzeige, z. B. „11,03 : 1“ (deutsches Komma). */
export function formatContrastRatio(ratio: number): string {
  const rounded = Math.floor(ratio * 100) / 100;
  return `${rounded.toFixed(2).replace('.', ',')} : 1`;
}
