import { useEffect, useState } from 'react';
import { MAX_TIMEOUT_MS, readNow } from '../utils/time.ts';

/**
 * Aktuelle Zeit als Zustand. Aktualisiert sich alle `tickMs` (oder gar nicht bei `null`),
 * sofort nach jeder (Neu-)Anmeldung und zusätzlich exakt zu den angegebenen Fristen – damit
 * z. B. eine Freigabe genau zum Ablaufzeitpunkt gesperrt wird, nicht erst beim nächsten Takt.
 */
export function useNow(
  tickMs: number | null,
  firstDeadline?: number,
  secondDeadline?: number,
): number {
  const [now, setNow] = useState(readNow);
  useEffect(() => {
    const update = (): void => setNow(Date.now());
    const interval = tickMs === null ? undefined : setInterval(update, tickMs);
    const current = Date.now();
    // Sofort nachziehen (nächster Takt): nach dem Wiederanmelden – etwa beim erneuten
    // Öffnen eines Dialogs – darf keine veraltete Zeit stehen bleiben.
    const timeouts: ReturnType<typeof setTimeout>[] = [setTimeout(update, 0)];
    for (const deadline of [firstDeadline, secondDeadline]) {
      if (deadline !== undefined && Number.isFinite(deadline) && deadline > current) {
        timeouts.push(setTimeout(update, Math.min(deadline - current, MAX_TIMEOUT_MS)));
      }
    }
    return () => {
      if (interval !== undefined) {
        clearInterval(interval);
      }
      for (const id of timeouts) {
        clearTimeout(id);
      }
    };
  }, [tickMs, firstDeadline, secondDeadline]);
  return now;
}
