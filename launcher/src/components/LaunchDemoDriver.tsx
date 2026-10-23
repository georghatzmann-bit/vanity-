import { useEffect } from "react";
import { toast } from "sonner";
import { launchSteps, useUi } from "@/lib/store";

/** Wie lange jeder Vorschau-Schritt dauert (ms). */
const stepDurations = [700, 1100, 600, 1200, 1300, 1000, 700];

/**
 * Schaltet den Vorschau-Startablauf Schritt für Schritt weiter – auch wenn
 * man währenddessen die Seite wechselt. Ab Phase 2 kommen die Schritte
 * stattdessen von der Rust-Seite.
 */
export function LaunchDemoDriver() {
  const launchStep = useUi((s) => s.launchStep);
  const setLaunchStep = useUi((s) => s.setLaunchStep);
  const running = launchStep >= 0 && launchStep < launchSteps.length;

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      const next = launchStep + 1;
      setLaunchStep(next);
      if (next >= launchSteps.length) {
        toast.success("Lobby erreicht (Vorschau)", {
          description: "So läuft „Host & Play“ ab Phase 4 wirklich ab.",
        });
      }
    }, stepDurations[launchStep] ?? 800);
    return () => window.clearTimeout(timer);
  }, [launchStep, running, setLaunchStep]);

  return null;
}
