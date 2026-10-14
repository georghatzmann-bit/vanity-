/**
 * Reduzierte Bewegung (H): `prefers-reduced-motion` live per matchMedia-Listener, dazu `?motion=reduced`.
 */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** `?motion=reduced` erzwingt reduzierte Bewegung (Tour, Prüfer) */
export function forcedReducedMotion(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("motion") === "reduced";
  } catch {
    return false;
  }
}

/** Aktueller Wert ohne Hook (z. B. für Ton-Zeitpläne) */
export function prefersReducedMotion(): boolean {
  if (forcedReducedMotion()) return true;
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (forcedReducedMotion()) return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
