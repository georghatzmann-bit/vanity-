import type { ReactNode } from 'react';
import { cx } from '../../utils/cx.ts';
import {
  formatCodePoint,
  middleTruncateUnits,
  toSafeTextUnits,
  type SafeTextUnit,
} from '../../utils/text.ts';

export interface SafeTextProps {
  /** Der fremde Text (Pfad, Prozess-, Registrierungsname …) – wird nie roh ausgegeben. */
  readonly value: string;
  /**
   * Höchstzahl sichtbarer Zeichen; länger → Kürzung in der Mitte (Dateiname bleibt).
   * Der volle Text steht Screenreadern immer zur Verfügung. Ohne Angabe: keine Kürzung.
   */
  readonly maxLength?: number | undefined;
  /** Monospace (Standard: an – Pfade, Hashes). */
  readonly mono?: boolean | undefined;
  /**
   * Beschreibung einer Marke für Screenreader. Standard: „Steuerzeichen U+202E (RLO)“.
   */
  readonly describeInvisible?:
    ((codePoint: string, name: string | undefined) => string) | undefined;
  readonly className?: string | undefined;
}

function defaultDescribe(codePoint: string, name: string | undefined): string {
  return name === undefined ? `Steuerzeichen ${codePoint}` : `Steuerzeichen ${codePoint} (${name})`;
}

function renderUnits(units: readonly SafeTextUnit[], keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buffer = '';
  units.forEach((unit, index) => {
    if (unit.kind === 'text') {
      buffer += unit.text;
      return;
    }
    if (buffer !== '') {
      nodes.push(buffer);
      buffer = '';
    }
    nodes.push(
      <mark
        key={`${keyPrefix}-${index}`}
        className="mx-px inline-block rounded-xs border border-risk-risky/50 bg-risk-risky-subtle px-0.5 font-mono text-[0.85em] leading-tight font-semibold whitespace-nowrap text-risk-risky"
        data-codepoint={formatCodePoint(unit.codePoint)}
      >
        {unit.marker}
      </mark>,
    );
  });
  if (buffer !== '') {
    nodes.push(buffer);
  }
  return nodes;
}

function spokenText(
  units: readonly SafeTextUnit[],
  describe: (codePoint: string, name: string | undefined) => string,
): string {
  return units
    .map((unit) =>
      unit.kind === 'text'
        ? unit.text
        : ` [${describe(formatCodePoint(unit.codePoint), unit.name)}] `,
    )
    .join('');
}

/**
 * Sichere Anzeige fremder Texte: unsichtbare und Bidi-Steuerzeichen erscheinen als
 * hervorgehobene Marke `⟨U+202E⟩` (der Text kann sich so nicht umdrehen oder etwas
 * verstecken), die Leserichtung ist isoliert links-nach-rechts, lange Werte werden in der
 * Mitte gekürzt – der volle Text bleibt für Screenreader lesbar.
 */
export function SafeText({
  value,
  maxLength,
  mono = true,
  describeInvisible = defaultDescribe,
  className,
}: SafeTextProps) {
  const units = toSafeTextUnits(value);
  const hasMarkers = units.some((unit) => unit.kind === 'invisible');
  const truncation =
    maxLength === undefined
      ? { head: units, tail: [], truncated: false }
      : middleTruncateUnits(units, maxLength);

  const classes = cx('[unicode-bidi:isolate] break-all', mono && 'font-mono', className);

  if (!hasMarkers && !truncation.truncated) {
    return (
      <span dir="ltr" className={classes}>
        {value}
      </span>
    );
  }

  return (
    <span dir="ltr" className={classes} data-truncated={truncation.truncated || undefined}>
      <span aria-hidden="true">
        {renderUnits(truncation.head, 'h')}
        {truncation.truncated && <span className="text-text-subtle">…</span>}
        {renderUnits(truncation.tail, 't')}
      </span>
      <span className="sr-only">{spokenText(units, describeInvisible)}</span>
    </span>
  );
}
