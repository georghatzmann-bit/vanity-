import { toast } from "sonner";
import { launchSteps, useApp } from "@/lib/store";

/** Wie lange jeder Vorschau-Schritt dauert (ms). */
const stepDurations = [700, 1100, 600, 1200, 1300, 1000, 700];

let timer: number | undefined;

/**
 * Nur für die Browser-Vorschau: spielt den Startablauf als Animation ab.
 * Im echten Launcher kommen die Schritte als Ereignisse aus Rust.
 */
export function runDemoLaunch() {
  window.clearTimeout(timer);
  const set = useApp.setState;
  const run = (step: number) => {
    set({ launchStep: step });
    set({
      services: {
        backend: step >= 1 ? "running" : "starting",
        server: step < 1 ? "stopped" : step >= 6 ? "running" : "starting",
        game: step < 4 ? "stopped" : step >= 5 ? "running" : "starting",
      },
    });
    if (step >= launchSteps.length) {
      toast.success("Lobby erreicht (Vorschau)", { description: "Im echten Launcher läuft hier Fortnite." });
      return;
    }
    timer = window.setTimeout(() => run(step + 1), stepDurations[step] ?? 800);
  };
  run(0);
}

export function stopDemoLaunch() {
  window.clearTimeout(timer);
  useApp.setState({ launchStep: -1, services: { backend: "stopped", server: "stopped", game: "stopped" } });
}
