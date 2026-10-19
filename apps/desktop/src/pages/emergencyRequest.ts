/**
 * „Notfall-Scan“ von Dashboard oder Befehlspalette: öffnet die Scan-Seite und merkt vor, dass
 * der (nur lesende) Notfall-Scan dort sofort startet. Isoliert wird erst nach „Ja“.
 */
import { hashFor } from '../router/routes.ts';

let requested = false;

/** Merkt den Notfall-Scan vor und öffnet die Scan-Seite. */
export function requestEmergencyScan(): void {
  requested = true;
  window.location.hash = hashFor('scan');
}

/** Ist ein Notfall-Scan vorgemerkt? (ohne ihn zu verbrauchen) */
export function hasEmergencyRequest(): boolean {
  return requested;
}

/** Wurde der Notfall-Scan angefordert? (einmalig) */
export function takeEmergencyRequest(): boolean {
  const value = requested;
  requested = false;
  return value;
}
