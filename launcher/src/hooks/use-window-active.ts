import { useEffect, useState } from "react";
import { watchMinimized } from "@/lib/window";

/**
 * Is the launcher window on screen? false while it is minimized or the page is hidden.
 * `focused` tells whether the window has keyboard focus (false while you play Fortnite).
 */
export function useWindowActivity(): { visible: boolean; focused: boolean } {
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  const [minimized, setMinimized] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    const stop = watchMinimized(setMinimized);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      stop();
    };
  }, []);

  return { visible: !hidden && !minimized, focused };
}
