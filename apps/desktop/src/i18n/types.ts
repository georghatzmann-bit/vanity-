/**
 * Typen der eigenen, kleinen Übersetzungsschicht.
 *
 * `de.ts` ist die Quelle (deutsch zuerst). `en.ts` ist gegen deren *Form* typisiert
 * (`Messages<typeof de>`): Fehlt ein Schlüssel oder kommt einer hinzu, scheitert die
 * Typprüfung. Mehrzahl-Formen sind Objekte mit genau `one` und `other`; ein Test stellt
 * sicher, dass kein gewöhnlicher Unterbaum diese Schlüssel benutzt.
 */

/** Mehrzahl-Form (Intl.PluralRules: „one“ / alles andere). `{count}` wird ersetzt. */
export interface PluralMessage {
  readonly one: string;
  readonly other: string;
}

/** Baum aus Texten und Mehrzahl-Formen. */
export interface MessageTree {
  readonly [key: string]: string | PluralMessage | MessageTree;
}

/** Gleiche Form wie `T`, aber jeder Text als `string` (für die zweite Sprache). */
export type Messages<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : Messages<T[K]>;
};

type Join<Prefix extends string, Key extends string> = Prefix extends '' ? Key : `${Prefix}.${Key}`;

/** Alle Pfade zu einfachen Texten, z. B. `nav.dashboard`. */
export type TextKeyOf<T, Prefix extends string = ''> = {
  readonly [K in keyof T & string]: T[K] extends string
    ? Join<Prefix, K>
    : T[K] extends PluralMessage
      ? never
      : TextKeyOf<T[K], Join<Prefix, K>>;
}[keyof T & string];

/** Alle Pfade zu Mehrzahl-Formen, z. B. `dashboard.activity.count`. */
export type PluralKeyOf<T, Prefix extends string = ''> = {
  readonly [K in keyof T & string]: T[K] extends string
    ? never
    : T[K] extends PluralMessage
      ? Join<Prefix, K>
      : PluralKeyOf<T[K], Join<Prefix, K>>;
}[keyof T & string];

/** Werte für Platzhalter `{name}`. */
export type MessageParams = Readonly<Record<string, string | number>>;
