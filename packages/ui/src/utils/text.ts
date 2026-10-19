/**
 * Sichere Darstellung fremder Texte (Datei-, Prozess- und Registrierungsnamen).
 *
 * Namen stammen vom System bzw. von fremden Dateien und können unsichtbare Zeichen
 * enthalten – etwa Unicode-Bidi-Overrides (U+202E), die `Rechnung_\u202Efdp.exe`
 * als `Rechnung_exe.pdf` erscheinen lassen. Vor einer Freigabe muss der Nutzer genau das sehen,
 * worauf später zugegriffen wird. Daher werden alle Steuer-, Format- und
 * „Default-Ignorable“-Zeichen sowie ungewöhnliche Leerzeichen als sichtbare Marke
 * `⟨U+202E⟩` dargestellt – nie roh ausgegeben.
 */

/**
 * Zeichen, die nicht roh angezeigt werden:
 * - `Cc` Steuerzeichen (C0/C1, auch Tab und Zeilenumbruch)
 * - `Cf` Formatzeichen (Bidi-Steuerung, Nullbreite-Zeichen, BOM, weiches Trennzeichen, Tags)
 * - `Zl`/`Zp` Zeilen-/Absatztrenner
 * - Default-Ignorable-Code-Points (z. B. Variantenselektoren, Hangul-Füller, CGJ)
 * - Leerzeichen-Varianten außer U+0020 (NBSP, Geviert-, Schmal-, Ideogramm-Leerzeichen …)
 * - nicht zugewiesene Code-Points und einzelne Surrogate (`Cn`, `Cs`)
 * - sichtbare Zeichen, die leer gezeichnet werden: U+2800 (leeres Braille-Muster) und
 *   U+1D159 (Noten-Nullkopf) – sie täuschen sonst Leerraum ohne Hinweis vor
 */
const INVISIBLE_PATTERN =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u{1D159}]|(?! )\p{Zs}/u;

/** Schriften mit Leserichtung rechts-nach-links (starke RTL-Zeichen). */
const RTL_PATTERN =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Mende_Kikakui}]/u;

/** Kurznamen bekannter unsichtbarer Zeichen (international üblich, daher englisch). */
const SHORT_NAMES: Readonly<Record<number, string>> = {
  0x0000: 'NUL',
  0x0009: 'TAB',
  0x000a: 'LF',
  0x000d: 'CR',
  0x001b: 'ESC',
  0x007f: 'DEL',
  0x00a0: 'NBSP',
  0x00ad: 'SHY',
  0x034f: 'CGJ',
  0x061c: 'ALM',
  0x180e: 'MVS',
  0x200b: 'ZWSP',
  0x200c: 'ZWNJ',
  0x200d: 'ZWJ',
  0x200e: 'LRM',
  0x200f: 'RLM',
  0x2028: 'LSEP',
  0x2029: 'PSEP',
  0x202a: 'LRE',
  0x202b: 'RLE',
  0x202c: 'PDF',
  0x202d: 'LRO',
  0x202e: 'RLO',
  0x202f: 'NNBSP',
  0x2060: 'WJ',
  0x2066: 'LRI',
  0x2067: 'RLI',
  0x2068: 'FSI',
  0x2069: 'PDI',
  0x3000: 'IDSP',
  0x3164: 'HF',
  0xfeff: 'BOM',
};

/** Ein Stück normaler Text oder ein maskiertes unsichtbares Zeichen. */
export type SafeTextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'invisible';
      readonly codePoint: number;
      /** Sichtbare Marke, z. B. `⟨U+202E⟩`. */
      readonly marker: string;
      /** Kurzname, falls bekannt (z. B. `RLO`). */
      readonly name: string | undefined;
    };

/** `U+202E` – Code-Point in üblicher Schreibweise (mindestens vier Hex-Stellen). */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Sichtbare Marke für ein unsichtbares Zeichen: `⟨U+202E⟩`. */
export function invisibleMarker(codePoint: number): string {
  return `⟨${formatCodePoint(codePoint)}⟩`;
}

/** Kurzname eines unsichtbaren Zeichens (z. B. `RLO`), sonst `undefined`. */
export function invisibleCharacterName(codePoint: number): string | undefined {
  return SHORT_NAMES[codePoint];
}

function isInvisible(character: string): boolean {
  return INVISIBLE_PATTERN.test(character);
}

/** Zerlegt einen Text in normale Abschnitte und maskierte unsichtbare Zeichen. */
export function splitInvisibleCharacters(value: string): SafeTextSegment[] {
  const segments: SafeTextSegment[] = [];
  let buffer = '';
  for (const character of value) {
    if (isInvisible(character)) {
      if (buffer !== '') {
        segments.push({ kind: 'text', text: buffer });
        buffer = '';
      }
      const codePoint = character.codePointAt(0) ?? 0;
      segments.push({
        kind: 'invisible',
        codePoint,
        marker: invisibleMarker(codePoint),
        name: invisibleCharacterName(codePoint),
      });
    } else {
      buffer += character;
    }
  }
  if (buffer !== '') {
    segments.push({ kind: 'text', text: buffer });
  }
  return segments;
}

/** Enthält der Text Zeichen, die maskiert werden müssen? */
export function hasInvisibleCharacters(value: string): boolean {
  for (const character of value) {
    if (isInvisible(character)) {
      return true;
    }
  }
  return false;
}

/** Text mit allen unsichtbaren Zeichen als `⟨U+…⟩` (z. B. für Kopieren oder Protokolle). */
export function revealInvisibleCharacters(value: string): string {
  return splitInvisibleCharacters(value)
    .map((segment) => (segment.kind === 'text' ? segment.text : segment.marker))
    .join('');
}

/** Enthält der Text Schrift mit Leserichtung rechts-nach-links? */
export function containsRightToLeft(value: string): boolean {
  return RTL_PATTERN.test(value);
}

/** Eine Anzeige-Einheit: ein Graphem normalen Texts oder ein maskiertes Zeichen. */
export type SafeTextUnit =
  | { readonly kind: 'text'; readonly text: string }
  | Extract<SafeTextSegment, { kind: 'invisible' }>;

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
      (part) => part.segment,
    );
  }
  return Array.from(text);
}

/** Zerlegt in Anzeige-Einheiten (Grapheme bzw. Marken) – Basis der Kürzung. */
export function toSafeTextUnits(value: string): SafeTextUnit[] {
  const units: SafeTextUnit[] = [];
  for (const segment of splitInvisibleCharacters(value)) {
    if (segment.kind === 'invisible') {
      units.push(segment);
    } else {
      for (const grapheme of graphemes(segment.text)) {
        units.push({ kind: 'text', text: grapheme });
      }
    }
  }
  return units;
}

export interface MiddleTruncation {
  /** Einheiten vor der Auslassung. */
  readonly head: readonly SafeTextUnit[];
  /** Einheiten nach der Auslassung (leer, wenn nicht gekürzt). */
  readonly tail: readonly SafeTextUnit[];
  readonly truncated: boolean;
}

const PATH_SEPARATORS = new Set(['\\', '/']);

/**
 * Kürzt in der Mitte auf höchstens `maxUnits` Einheiten (inklusive Auslassungszeichen).
 * Bei Pfaden bleibt der Dateiname möglichst vollständig sichtbar – dort steckt die
 * entscheidende Information (Endung). Marken unsichtbarer Zeichen werden nie zerteilt.
 */
export function middleTruncateUnits(
  units: readonly SafeTextUnit[],
  maxUnits: number,
): MiddleTruncation {
  const limit = Math.max(5, Math.floor(maxUnits));
  if (units.length <= limit) {
    return { head: units, tail: [], truncated: false };
  }
  const budget = limit - 1;
  let lastSeparator = -1;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit?.kind === 'text' && PATH_SEPARATORS.has(unit.text)) {
      lastSeparator = index;
      break;
    }
  }
  const nameLength = lastSeparator >= 0 ? units.length - lastSeparator : 0;
  let tailLength: number;
  if (nameLength > 0 && nameLength <= Math.floor(budget * 0.7)) {
    tailLength = nameLength;
  } else {
    tailLength = budget - Math.ceil(budget * 0.4);
  }
  const headLength = budget - tailLength;
  return {
    head: units.slice(0, headLength),
    tail: units.slice(units.length - tailLength),
    truncated: true,
  };
}
