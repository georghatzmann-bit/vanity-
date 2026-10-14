/**
 * Reine Ablauf-Logik des Setups (ohne React, ohne Tauri) – testbar in node.
 * Der Hook `useSetupFlow` baut darauf auf.
 */
import type { ErrorCode, InstallOptions, Phase, Progress, SetupInfo, UninstallProgress } from "../api";

export type Step = "intro" | "welcome" | "maintenance" | "folder" | "options" | "install" | "done" | "un-confirm" | "un-run" | "un-done";
export type InstallPhase = Exclude<Phase, "done">;
export type UninstallStep = Exclude<UninstallProgress["step"], "done">;

/** Schrittskala der normalen Installation */
export const RAIL: Step[] = ["welcome", "folder", "options", "install", "done"];
export const PHASES: InstallPhase[] = ["connect", "download", "verify", "install", "shortcuts", "register"];
export const UNINSTALL_STEPS: UninstallStep[] = ["stop", "shortcuts", "registry", "files", "data"];

/** Zeiten des Ablaufs (ms bzw. s) – unverändert gegenüber der alten App, Tipps neu 8000 ms */
export const TIP_COUNT = 5;
export const TIP_INTERVAL_MS = 8000;
export const COUNTDOWN_S = 5;
export const UPDATE_RESTART_MS = 2600;
export const DONE_DELAY_MS = 650;
export const UNDONE_DELAY_MS = 500;
export const RESUME_NOTE_MS = 8000;
export const DISK_DEBOUNCE_MS = 250;

/** Ersatz, falls `setup_info` scheitert (wie bisher) */
export const FALLBACK_INFO: SetupInfo = { mode: "install", setupVersion: "1.0.0", appName: "Pulsar", defaultDir: "", elevated: false, systemLang: "de", manifestUrl: "" };

export function defaultOpts(si: SetupInfo): InstallOptions {
  return { dir: si.installed?.dir ?? si.defaultDir, desktopShortcut: true, startMenu: true, autostart: false, launchAfter: true };
}

/** Ziel nach dem Intro: entweder ein Schritt oder sofort die Installation (`start`). */
export interface IntroTarget {
  step: Step;
  start?: InstallOptions;
}

export function nextStepAfterIntro(si: SetupInfo): IntroTarget {
  if (si.mode === "uninstall") return { step: "un-confirm" };
  if (si.mode === "update") return { step: "install", start: { ...defaultOpts(si), dir: si.installed?.dir ?? si.defaultDir } };
  if (si.preset) return { step: "install", start: si.preset };
  if (si.mode === "maintenance") return { step: "maintenance" };
  return { step: "welcome" };
}

/** „Zurück“ nach einem Fehler: Platz- und Rechteprobleme → Speicherort, sonst Optionen */
export function errorBackTarget(code: ErrorCode): "folder" | "options" {
  return code === "disk" || code === "permission" ? "folder" : "options";
}

/** Index der aktuellen Phase (0…6; 6 = alles erledigt) */
export function phaseIndexOf(progress: Progress | null): number {
  if (!progress) return 0;
  return progress.phase === "done" ? PHASES.length : PHASES.indexOf(progress.phase);
}

/** Index des aktuellen Deinstallationsschritts (−1 = noch keiner, 5 = fertig) */
export function uninstallIndexOf(p: UninstallProgress | null): number {
  if (!p) return -1;
  return p.step === "done" ? UNINSTALL_STEPS.length : UNINSTALL_STEPS.indexOf(p.step);
}

/** Gewählter Ordner aus dem Dialog: ohne „Pulsar“ im Pfad wird `\Pulsar` angehängt (wie bisher). */
export function withPulsarSuffix(p: string): string {
  return /pulsar/i.test(p) ? p : `${p.replace(/[\\/]+$/, "")}\\Pulsar`;
}

/** Phasendauern im Client: Zeit zwischen den Phasenwechseln (ms). */
export type PhaseDurations = Partial<Record<InstallPhase, number>>;
export interface PhaseClock {
  phase: Phase | null;
  since: number;
  durations: PhaseDurations;
}
export const emptyPhaseClock = (): PhaseClock => ({ phase: null, since: 0, durations: {} });

/** Neuer Phasenstand → neue Uhr (rein). Gleiche Phase ändert nichts. */
export function advancePhaseClock(c: PhaseClock, phase: Phase, now: number): PhaseClock {
  if (c.phase === phase) return c;
  const durations = { ...c.durations };
  if (c.phase && c.phase !== "done") durations[c.phase] = Math.max(0, now - c.since);
  return { phase, since: now, durations };
}
