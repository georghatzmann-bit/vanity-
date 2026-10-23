import { useSyncExternalStore } from "react";

/** true, solange die CSS-Media-Query zutrifft, z. B. "(min-width: 1200px)". */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", notify);
      return () => mql.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
