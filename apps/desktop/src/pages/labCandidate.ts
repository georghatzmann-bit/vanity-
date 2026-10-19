/**
 * Übergabe „Im Labor prüfen“ von einer anderen Seite (z. B. Echtzeit-Wächter) an die
 * Labor-Seite: nur ein vorgemerkter Pfad – gestartet wird erst nach Vorschlag und „Ja“.
 */
import { hashFor } from '../router/routes.ts';

let candidate: string | null = null;

/** Merkt einen Pfad vor und öffnet die Labor-Seite. */
export function offerToLab(path: string): void {
  candidate = path;
  window.location.hash = hashFor('lab');
}

/** Holt den vorgemerkten Pfad (einmalig). */
export function takeLabCandidate(): string | null {
  const path = candidate;
  candidate = null;
  return path;
}

/** Dateien, für die das Labor angeboten wird (ausführbare Programme und Skripte). */
const LAB_EXTENSIONS = ['.exe', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.scr', '.com'];

/** Lohnt sich das Labor-Angebot für diesen Pfad? */
export function isLabCandidate(path: string): boolean {
  const lower = path.toLowerCase();
  return LAB_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
