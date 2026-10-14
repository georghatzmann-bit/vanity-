/**
 * Aufzeichnung einer Spielsitzung aus dem Puffer des Live-Monitors (`useNet.samples`, höchstens 900 Werte).
 *
 * Neue Messwerte werden über die **Zeit** erkannt, nicht über die Länge des Puffers: Früher lieferte
 * `slice(prev.length)` nach 900 Werten nichts mehr (beide Längen 900) – Runden über 15 Minuten wurden
 * abgeschnitten. Ein Zielwechsel (Puffer wird geleert) verliert so ebenfalls nichts.
 */
import type { PingSample } from "./types";

/** So weit vor dem Spielstart zählen Messwerte noch zur Runde (ms) */
export const START_GRACE_MS = 2000;

/**
 * Neue Werte aus `buffer`: nur `t > lastT` (keine doppelten) und `t >= start − 2000`.
 * Liefert die neuen Werte in Pufferreihenfolge und das neue `lastT`.
 */
export function appendFresh(buffer: readonly PingSample[], lastT: number, start: number): { fresh: PingSample[]; lastT: number } {
  const fresh = buffer.filter((s) => s.t > lastT && s.t >= start - START_GRACE_MS);
  const newest = fresh.reduce((m, s) => Math.max(m, s.t), lastT);
  return { fresh, lastT: newest };
}
