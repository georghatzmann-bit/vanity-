/**
 * Verbindung zum Installer-Backend (Rust). Im Browser simuliert ein Demo-Backend
 * den kompletten Ablauf, damit die Oberfläche auch ohne Tauri getestet werden kann.
 */
import { isTauri } from "@shared/lib/env";

export type SetupMode = "install" | "maintenance" | "update" | "uninstall";
export interface InstallOptions {
  dir: string;
  desktopShortcut: boolean;
  startMenu: boolean;
  autostart: boolean;
  launchAfter: boolean;
}
export interface SetupInfo {
  mode: SetupMode;
  setupVersion: string;
  appName: string;
  defaultDir: string;
  installed?: { dir: string; version: string };
  elevated: boolean;
  systemLang: "de" | "en";
  preset?: InstallOptions;
  manifestUrl: string;
}
export interface Manifest {
  version: string;
  notes?: string;
  pubDate?: string;
  app: { url: string; sha256?: string; size?: number };
}
export interface DiskInfo {
  path: string;
  free: number;
  total: number;
  required: number;
  exists: boolean;
  writable: boolean;
  needsAdmin: boolean;
  valid: boolean;
  message?: string;
}
export type Phase = "connect" | "download" | "verify" | "install" | "shortcuts" | "register" | "done";
export interface Progress {
  phase: Phase;
  downloaded: number;
  total: number;
  speed: number;
  eta: number;
  percent: number;
}
export type ErrorCode = "network" | "checksum" | "disk" | "permission" | "manifest" | "running" | "cancelled" | "unknown";
export interface InstallError {
  phase: Phase;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}
export interface InstallDone {
  dir: string;
  exePath: string;
  version: string;
  verified: boolean;
}
export interface UninstallProgress {
  step: "stop" | "shortcuts" | "registry" | "files" | "data" | "done";
  percent: number;
}
/** `revertOk: false` = Windows-Einstellungen nicht vollständig zurückgestellt; dann ist `dataKept` immer `true`. */
export interface UninstallDone {
  revertOk: boolean;
  dataKept: boolean;
}

type Handler = (p: unknown) => void;
const mockListeners = new Map<string, Set<Handler>>();
const mockEmit = (e: string, p: unknown) => mockListeners.get(e)?.forEach((h) => h(p));
let mockRun = 0;
let mockFailOnce = new URLSearchParams(location.search).has("fail");

async function mock<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const params = new URLSearchParams(location.search);
  const r = (v: unknown) => v as T;
  await new Promise((res) => setTimeout(res, 120));
  switch (cmd) {
    case "setup_info":
      return r({
        mode: (params.get("mode") as SetupMode) ?? "install",
        setupVersion: "1.0.0",
        appName: "Pulsar",
        defaultDir: "C:\\Users\\Georg\\AppData\\Local\\Programs\\Pulsar",
        installed: params.get("mode") === "maintenance" || params.get("mode") === "update" ? { dir: "C:\\Users\\Georg\\AppData\\Local\\Programs\\Pulsar", version: "0.9.0" } : undefined,
        elevated: false,
        systemLang: "de",
        manifestUrl: "https://github.com/…/latest.json",
      });
    case "fetch_manifest":
      return r({ version: "1.0.0", notes: "Erste Version", app: { url: "https://example/Pulsar.exe", sha256: "ab12…", size: 11_800_000 } });
    case "disk_space": {
      const p = String(args.path ?? "");
      return r({ path: p, free: 182_400_000_000, total: 512_000_000_000, required: 13_000_000, exists: true, writable: !/program files/i.test(p), needsAdmin: /program files/i.test(p), valid: /^[a-z]:\\/i.test(p), message: /^[a-z]:\\/i.test(p) ? undefined : "Bitte einen vollständigen Pfad angeben." });
    }
    case "start_install": {
      const run = ++mockRun;
      const total = 11_800_000;
      let done = 0;
      const tick = () => {
        if (run !== mockRun) return;
        if (mockFailOnce && done > total * 0.45) {
          mockFailOnce = false;
          mockEmit("install://error", { phase: "download", code: "network", message: "Verbindung unterbrochen (Demo)", retryable: true });
          return;
        }
        done = Math.min(total, done + 260_000 + Math.random() * 120_000);
        const percent = (done / total) * 85;
        mockEmit("install://progress", { phase: "download", downloaded: done, total, speed: 4_300_000 + Math.random() * 600_000, eta: (total - done) / 4_500_000, percent });
        if (done < total) setTimeout(tick, 90);
        else {
          const steps: Phase[] = ["verify", "install", "shortcuts", "register"];
          steps.forEach((ph, i) => setTimeout(() => run === mockRun && mockEmit("install://progress", { phase: ph, downloaded: total, total, speed: 0, eta: 0, percent: 86 + i * 4 }), 400 + i * 450));
          setTimeout(() => run === mockRun && mockEmit("install://done", { dir: (args.options as InstallOptions).dir, exePath: "…\\Pulsar.exe", version: "1.0.0", verified: true }), 400 + steps.length * 450);
        }
      };
      setTimeout(() => mockEmit("install://progress", { phase: "connect", downloaded: 0, total, speed: 0, eta: 0, percent: 0 }), 50);
      setTimeout(tick, 600);
      return r(undefined);
    }
    case "cancel_install":
      mockRun++;
      setTimeout(() => mockEmit("install://error", { phase: "download", code: "cancelled", message: "", retryable: true }), 100);
      return r(undefined);
    case "start_uninstall": {
      const steps: UninstallProgress["step"][] = ["stop", "shortcuts", "registry", "files", "data", "done"];
      steps.forEach((s, i) => setTimeout(() => mockEmit("uninstall://progress", { step: s, percent: ((i + 1) / steps.length) * 100 }), 500 + i * 650));
      // Demo: `?revertfail` zeigt den Fall, dass nicht alles zurückgestellt werden konnte.
      const revertOk = !params.has("revertfail");
      const done: UninstallDone = { revertOk, dataKept: !revertOk || Boolean(args.keepData) };
      setTimeout(() => mockEmit("uninstall://done", done), 500 + steps.length * 650);
      return r(undefined);
    }
    case "app_running":
      return r(false);
    default:
      return r(undefined);
  }
}

export async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    }
  }
  return mock<T>(cmd, args);
}

export async function on<T>(event: string, handler: (p: T) => void): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(event, (e) => handler(e.payload));
  }
  if (!mockListeners.has(event)) mockListeners.set(event, new Set());
  mockListeners.get(event)!.add(handler as Handler);
  return () => mockListeners.get(event)?.delete(handler as Handler);
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isTauri()) return window.prompt("Ordner", defaultPath ?? "C:\\Spiele\\Pulsar") || null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, defaultPath });
  return typeof r === "string" ? r : null;
}

export const api = {
  setupInfo: () => call<SetupInfo>("setup_info"),
  fetchManifest: () => call<Manifest>("fetch_manifest"),
  diskSpace: (path: string) => call<DiskInfo>("disk_space", { path }),
  startInstall: (options: InstallOptions) => call<void>("start_install", { options }),
  cancelInstall: () => call<void>("cancel_install"),
  relaunchElevated: (options: InstallOptions) => call<void>("relaunch_elevated", { options }),
  appRunning: () => call<boolean>("app_running"),
  closeApp: () => call<void>("close_app"),
  launchApp: () => call<void>("launch_app"),
  startUninstall: (keepData: boolean) => call<void>("start_uninstall", { keepData }),
  openUrl: (url: string) => call<void>("open_url", { url }),
  quit: () => call<void>("quit"),
};
