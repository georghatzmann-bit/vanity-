import { toast } from "sonner";
import { isStarting, LAUNCH_DONE_STEP, useApp } from "@/lib/store";

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
    // Like Rust: the last step ("Lobby") means the server is ready and the start is done
    if (step >= LAUNCH_DONE_STEP) {
      toast.success("You're in the lobby (preview)", { description: "In the real launcher, Fortnite runs now." });
      return;
    }
    timer = window.setTimeout(() => run(step + 1), stepDurations[step] ?? 800);
  };
  run(0);
}

/** Stops the preview launch. Returns true when a start was still in progress (= it was cancelled). */
export function stopDemoLaunch(): boolean {
  window.clearTimeout(timer);
  const { launchStep, pushLog } = useApp.getState();
  const cancelled = isStarting(launchStep);
  useApp.setState({ launchStep: -1, services: { backend: "stopped", server: "stopped", game: "stopped" } });
  if (cancelled) {
    // Same line the real launcher writes when a start is cancelled
    const now = new Date();
    pushLog({
      source: "launcher",
      level: "info",
      category: "Rift",
      message: "Start cancelled.",
      time: now.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0"),
    });
  }
  return cancelled;
}

/** true when something runs or starts in the preview (decides if closing asks first). */
export function demoBusy(): boolean {
  const { launchStep, services } = useApp.getState();
  return launchStep >= 0 || Object.values(services).some((st) => st !== "stopped");
}
