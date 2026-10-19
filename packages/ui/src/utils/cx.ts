/** Ein Klassen-Baustein: Text oder ein „falscher“ Wert, der übersprungen wird. */
export type ClassValue = string | false | null | undefined;

/** Verbindet CSS-Klassen; leere und falsche Werte entfallen. */
export function cx(...parts: readonly ClassValue[]): string {
  return parts.filter(Boolean).join(' ');
}
