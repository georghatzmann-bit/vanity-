import { toast } from "sonner";
import { launchSteps, useApp } from "@/lib/store";

/** How long each preview step takes (ms). */
const stepDurations = [700, 1100, 600, 1200, 1300, 1000, 700];

let timer: number | undefined;

/**
 * Browser preview only: plays the launch as an animation.
 * In the real launcher the steps arrive as events from Rust.
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
      toast.success("You're in the lobby (preview)", { description: "In the real launcher, Fortnite runs now." });
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
