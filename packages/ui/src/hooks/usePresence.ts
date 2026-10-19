import { useEffect, useState } from 'react';

/**
 * Hält ein Element nach dem Schließen noch `exitMs` eingehängt, damit es ausblenden kann.
 * Gibt `true` zurück, solange es sichtbar oder am Ausblenden ist. Rein timer-basiert (kein
 * Warten auf Animations-Callbacks) – dadurch mit Fake-Timern exakt testbar.
 */
export function usePresence(open: boolean, exitMs: number): boolean {
  const [previousOpen, setPreviousOpen] = useState(open);
  const [exiting, setExiting] = useState(false);
  if (previousOpen !== open) {
    // Abgeleiteter Zustand beim Prop-Wechsel (React-Muster „state from props“).
    setPreviousOpen(open);
    setExiting(!open && exitMs > 0);
  }
  useEffect(() => {
    if (!exiting) {
      return undefined;
    }
    const id = setTimeout(() => setExiting(false), exitMs);
    return () => clearTimeout(id);
  }, [exiting, exitMs]);
  return open || exiting;
}
