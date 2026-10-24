/*
 * Brücke zwischen Oberfläche und Rust-Logik.
 * Im echten Launcher laufen alle Aufrufe über Tauri. In der Browser-Vorschau (pnpm dev im Browser)
 * antwortet ein Platzhalter mit Beispieldaten, damit man das Design anschauen kann.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { demoBuilds, demoCrashes, demoFriends, demoProfiles } from "./demo-data";

export const inTauri = isTauri();

// ---- Typen (entsprechen den Rust-Strukturen in launcher/core) ----------------------------

export type Support = "supported" | "planned" | "unsupported";

export interface BuildInfo {
  id: string;
  version: string;
  changelist: number | null;
  season: string;
  engine: string;
  path: string;
  binaries: string;
  support: Support;
  launchArgs: string;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  buildId: string;
  playerName: string;
  launchArgs: string;
  headlessServer: boolean;
  playlist: string;
  lategame: boolean;
  tags: string[];
}

export interface Friend {
  id: string;
  name: string;
  address: string;
  via: string;
}

export interface Settings {
  playerName: string;
  launchArgs: string;
  headlessServer: boolean;
  autoRestart: boolean;
  backendPort: number;
  matchmakerPort: number;
  gameServerPort: number;
  shareBackendLan: boolean;
  glass: boolean;
  reduceMotion: boolean;
  animatedBackground: boolean;
}

export interface Config {
  configVersion: number;
  settings: Settings;
  builds: BuildInfo[];
  profiles: Profile[];
  activeProfileId: string;
  friends: Friend[];
}

export interface DetectReport {
  build: BuildInfo | null;
  checks: { ok: boolean; text: string }[];
  hasAftermath: boolean;
}

export interface CrashReport {
  id: string;
  folder: string;
  time: number;
  version: string;
  title: string;
  severity: "high" | "medium";
  whatHappened: string;
  likelyCause: string;
  whatToDo: string[];
  technical: [string, string][];
  callstack: string[];
}

export type ServiceStatus = "stopped" | "starting" | "running" | "error";
export interface Services {
  backend: ServiceStatus;
  server: ServiceStatus;
  game: ServiceStatus;
}

export interface LogLine {
  source: "game" | "server" | "backend" | "launcher";
  level: "info" | "warning" | "error";
  category: string;
  message: string;
  detected?: string | null;
  time: string;
}

export interface Toast {
  kind: "success" | "info" | "warning" | "error";
  title: string;
  description: string;
}

export interface ClientSettings {
  menuKey: number;
  joinKey: number;
  consoleKey: number;
  editOnRelease: boolean;
  resetOnRelease: boolean;
  disablePreEdits: boolean;
  fov: number;
  console: boolean;
  joinIp: string;
  presets: { name: string; commands: string[] }[];
}

export const defaultSettings: Settings = {
  playerName: "Player",
  launchArgs: "-d3d11",
  headlessServer: true,
  autoRestart: false,
  backendPort: 3551,
  matchmakerPort: 80,
  gameServerPort: 7777,
  shareBackendLan: false,
  glass: true,
  reduceMotion: false,
  animatedBackground: true,
};

export const defaultClientSettings: ClientSettings = {
  menuKey: 120,
  joinKey: 116,
  consoleKey: 119,
  editOnRelease: true,
  resetOnRelease: true,
  disablePreEdits: false,
  fov: 80,
  console: true,
  joinIp: "",
  presets: [],
};

// ---- Platzhalter für die Browser-Vorschau ------------------------------------------------

let demoConfig: Config = {
  configVersion: 1,
  settings: { ...defaultSettings, playerName: "georg" },
  builds: demoBuilds,
  profiles: demoProfiles,
  activeProfileId: demoProfiles[0].id,
  friends: demoFriends,
};
let demoClient: ClientSettings = { ...defaultClientSettings };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return invoke<T>(cmd, args);
  return demo(cmd, args) as T;
}

function demo(cmd: string, args: Record<string, unknown> = {}): unknown {
  switch (cmd) {
    case "get_config":
      return demoConfig;
    case "platform":
      return "browser";
    case "update_settings":
      demoConfig = { ...demoConfig, settings: args.settings as Settings };
      return null;
    case "detect_build":
      return {
        build: { ...demoBuilds[0], path: String(args.path) },
        checks: [
          { ok: true, text: "FortniteClient-Win64-Shipping.exe gefunden" },
          { ok: true, text: "Version gelesen: 19.10 (CL-18675304)" },
          { ok: true, text: "Spieldaten vorhanden (42 .pak-Dateien)" },
          { ok: true, text: "Version wird unterstützt" },
        ],
        hasAftermath: true,
      } satisfies DetectReport;
    case "add_build": {
      const b = args.build as BuildInfo;
      demoConfig = { ...demoConfig, builds: [...demoConfig.builds.filter((x) => x.id !== b.id), b] };
      return demoConfig;
    }
    case "remove_build":
      demoConfig = { ...demoConfig, builds: demoConfig.builds.filter((b) => b.id !== args.id) };
      return demoConfig;
    case "add_profile":
      demoConfig = { ...demoConfig, profiles: [...demoConfig.profiles, args.profile as Profile] };
      return demoConfig;
    case "update_profile": {
      const p = args.profile as Profile;
      demoConfig = { ...demoConfig, profiles: demoConfig.profiles.map((x) => (x.id === p.id ? p : x)) };
      return demoConfig;
    }
    case "remove_profile": {
      const profiles = demoConfig.profiles.filter((p) => p.id !== args.id);
      demoConfig = {
        ...demoConfig,
        profiles,
        activeProfileId: demoConfig.activeProfileId === args.id ? (profiles[0]?.id ?? "") : demoConfig.activeProfileId,
      };
      return demoConfig;
    }
    case "set_active_profile":
      demoConfig = { ...demoConfig, activeProfileId: String(args.id) };
      return null;
    case "add_friend":
      demoConfig = { ...demoConfig, friends: [...demoConfig.friends, args.friend as Friend] };
      return demoConfig;
    case "remove_friend":
      demoConfig = { ...demoConfig, friends: demoConfig.friends.filter((f) => f.id !== args.id) };
      return demoConfig;
    case "list_crashes":
      return demoCrashes;
    case "share_addresses":
      return [
        ["Nur dieser PC", "127.0.0.1:7777"],
        ["Tailscale", "100.88.41.3:7777"],
        ["Radmin VPN", "26.120.7.55:7777"],
      ];
    case "get_client_settings":
      return demoClient;
    case "set_client_settings":
      demoClient = args.value as ClientSettings;
      return null;
    case "vanity_paths":
      return { config: "%APPDATA%\\Vanity", logs: "%LOCALAPPDATA%\\Vanity\\logs", crashes: "%LOCALAPPDATA%\\FortniteGame\\Saved\\Crashes", fortniteLogs: "%LOCALAPPDATA%\\FortniteGame\\Saved\\Logs" };
    default:
      // Aktionen, die Fortnite brauchen, gibt es in der Vorschau nicht
      throw new Error("In der Browser-Vorschau nicht verfügbar – nur im echten Launcher unter Windows.");
  }
}

// ---- Aufrufe ------------------------------------------------------------------------------

export const api = {
  getConfig: () => call<Config>("get_config"),
  platform: () => call<string>("platform"),
  updateSettings: (settings: Settings) => call<void>("update_settings", { settings }),
  detectBuild: (path: string) => call<DetectReport>("detect_build", { path }),
  addBuild: (build: BuildInfo) => call<Config>("add_build", { build }),
  removeBuild: (id: string) => call<Config>("remove_build", { id }),
  addProfile: (profile: Profile) => call<Config>("add_profile", { profile }),
  updateProfile: (profile: Profile) => call<Config>("update_profile", { profile }),
  removeProfile: (id: string) => call<Config>("remove_profile", { id }),
  setActiveProfile: (id: string) => call<void>("set_active_profile", { id }),
  addFriend: (friend: Friend) => call<Config>("add_friend", { friend }),
  removeFriend: (id: string) => call<Config>("remove_friend", { id }),
  listCrashes: () => call<CrashReport[]>("list_crashes"),
  shareAddresses: () => call<[string, string][]>("share_addresses"),
  getClientSettings: () => call<ClientSettings>("get_client_settings"),
  setClientSettings: (value: ClientSettings) => call<void>("set_client_settings", { value }),
  paths: () => call<{ config: string; logs: string; crashes: string; fortniteLogs: string }>("vanity_paths"),

  hostAndPlay: (profileId: string) => call<void>("host_and_play", { profileId }),
  stopAll: () => call<void>("stop_all"),
  joinIp: (address: string) => call<void>("join_ip", { address }),
  serverExec: (text: string) => call<void>("server_exec", { text }),
  serverConfig: (key: string, value: unknown) => call<void>("server_config", { key, value }),
  serverStartMatch: () => call<void>("server_start_match"),
  spawnBots: (count: number) => call<void>("spawn_bots", { count }),
  removeBots: () => call<void>("remove_bots"),
};

/** Ordner-Auswahl über den System-Dialog. In der Vorschau: Eingabe per Hand. */
export async function pickFolder(): Promise<string | null> {
  if (!inTauri) return window.prompt("Build-Ordner (Vorschau):", "C:\\Users\\georg\\Downloads\\windows-19.10");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false, title: "Build-Ordner wählen" });
  return typeof result === "string" ? result : null;
}

/** Öffnet einen Ordner im Explorer. */
export async function openFolder(path: string): Promise<void> {
  if (!inTauri) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}

// ---- Ereignisse aus Rust ---------------------------------------------------------------------

export type EventName = "services" | "launch:step" | "log:line" | "toast" | "server:event" | "trickshot" | "detect";

export function onEvent<T>(name: EventName, handler: (payload: T) => void): () => void {
  if (!inTauri) return () => {};
  let unlisten: UnlistenFn | undefined;
  let disposed = false;
  listen<T>(name, (e) => handler(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
