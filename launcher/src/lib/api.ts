/*
 * Bridge between the UI and the Rust logic.
 * In the real launcher every call goes through Tauri. In the browser preview (pnpm dev in a browser)
 * a stand-in answers with sample data, so the design can be looked at and screenshotted.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { bubbleInfoFor, type BubbleBuildsInfo } from "./bubble";
import { botsSupportFor } from "./bots";
import { demoBuilds, demoCatalog, demoCrashes, demoFriends, demoProfiles } from "./demo-data";

export type { BubbleBuildsInfo, BubbleLevel } from "./bubble";

export const inTauri = isTauri();

/** App version shown in the browser preview (the real one comes from tauri.conf.json). */
export const DEMO_APP_VERSION = "0.1.0";

// ---- Types (match the Rust structs in launcher/core) -------------------------------------

/** supported = tested, experimental = untested but starts, unsupported = too old/new */
export type Support = "supported" | "experimental" | "unsupported";

export interface BuildInfo {
  id: string;
  version: string;
  changelist: number | null;
  season: string;
  engine: string;
  path: string;
  binaries: string;
  support: Support;
  /** Plain-words explanation of the level (comes from Rust) */
  supportNote?: string;
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
  /** Infinite ammo on the server. Off = Classic match. */
  infiniteAmmo: boolean;
  /** Infinite building materials on the server. Off = Classic match. */
  infiniteMats: boolean;
  /** Play with AI bots (only 19.10-CL-18675304 for now, see `botsSupport`). */
  bots: boolean;
  /** Number of AI bots, 1–99. */
  botCount: number;
  botSkill: BotSkill;
}

/** How good the AI bots are (Rust maps it to a skill rating: easy 500, normal 1000, hard 2000). */
export type BotSkill = "easy" | "normal" | "hard";

/** Can AI bots be switched on for a version? `note` is one plain English sentence. */
export interface BotsSupport {
  level: "experimental" | "unavailable";
  note: string;
}

/** Payload of the event "server:playerBots": the server's answer once it knows if bots can run. */
export interface PlayerBotsEvent {
  state: "active" | "unavailable";
  reason: string;
}

export interface Friend {
  id: string;
  name: string;
  address: string;
  via: string;
}

/** The game's redirect only talks to this port, so the backend always runs on it. */
export const BACKEND_PORT = 3551;
/** The game server always listens on this port (the launcher can't move it). */
export const GAME_SERVER_PORT = 7777;

export interface Settings {
  playerName: string;
  launchArgs: string;
  headlessServer: boolean;
  /** Not used (nothing restarts the server). Kept so saved settings stay compatible. */
  autoRestart: boolean;
  /** Always BACKEND_PORT – kept for compatibility, not changeable. */
  backendPort: number;
  matchmakerPort: number;
  /** Always GAME_SERVER_PORT – kept for compatibility, not changeable. */
  gameServerPort: number;
  shareBackendLan: boolean;
  glass: boolean;
  reduceMotion: boolean;
  animatedBackground: boolean;
  /** Start the player's game in Performance Mode on versions that show the bubble build look. */
  bubbleBuilds: boolean;
  /** App version the user last saw (welcome / "What's new"). null or "" = never opened. */
  lastSeenVersion?: string | null;
}

export interface Config {
  configVersion: number;
  settings: Settings;
  builds: BuildInfo[];
  profiles: Profile[];
  activeProfileId: string;
  friends: Friend[];
  trickshotPresets: TrickshotPreset[];
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

/** Switches the in-game menu (ATLAS Console based) saves under "preferences". */
export interface ClientPreferences {
  saveTogglePreferences: boolean;
  slashKey: boolean;
  editOnRelease: boolean;
  resetOnRelease: boolean;
  disablePreEdits: boolean;
  mobileBuilds: boolean;
  inGameFog: boolean;
  firstPerson: boolean;
  /**
   * Removed ("Always sprint" is gone). Older client.json files may still have it, so it stays
   * readable, but it is always off: the launcher writes false and nothing sends its command.
   */
  sprintByDefault?: boolean;
  respawnsEnabled: boolean;
  /** "Bubble look" (F9 > Main > Graphics): softer build blueprint textures. Older files don't have it. */
  bubbleLook?: boolean;
  /** "Bubble strength", 1–8 (default 5). */
  bubbleStrength?: number;
  /** "Reset builds" (F9 > Options): aim at an edited build and press the key. */
  resetBuilds?: boolean;
  /** Its key (Windows key code), 0 = none. Never the left or right mouse button. */
  resetBuildsKey?: number;
}

/** Contents of %APPDATA%\Niobium\client.json – the launcher and the F9 menu share this file. */
export interface ClientSettings {
  /** Key for the menu (Windows virtual-key code), default F9 */
  hotkey: number;
  /** Key for "quick join", default F5 */
  joinHotkey: number;
  /** 0 = Niobium console, 1 = original Unreal console */
  consoleMode: number;
  preferences: ClientPreferences;
  /** Own command keys and macros – created in the game, only passed through here */
  commands: unknown[];
  macros: unknown[];
}

export interface TrickshotPreset {
  name: string;
  commands: string[];
}

// ---- Build downloader (match launcher/core/src/epic/catalog.rs and src-tauri/src/download) ----

export type SeasonStatus = "available" | "notFromEpic" | "notOfferedYet";

export interface CatalogBuild {
  /** "18.30-CL-17882303" */
  key: string;
  version: string;
  cl: number;
  downloadBytes: number;
  installedBytes: number;
  badge: "tested" | "experimental";
  /** Extra line, e.g. "Very big: about 97 GB on disk" ("" = none). */
  note: string;
}

export interface CatalogSeason {
  season: number;
  /** "Season 3", "Season X", "Season OG" */
  label: string;
  /** "13.x" */
  versions: string;
  status: SeasonStatus;
  /** Card text for "notFromEpic" / "notOfferedYet" ("" when available). */
  note: string;
  builds: CatalogBuild[];
}

export interface CatalogChapter {
  chapter: number;
  /** "Chapter 2" */
  label: string;
  seasons: CatalogSeason[];
}

export interface Catalog {
  /** Day the list was checked against Epic's servers, e.g. "2026-10-26". */
  checkedOn: string;
  chapters: CatalogChapter[];
}

export type DownloadPhase = "checking" | "downloading" | "verifying" | "importing";
export type DownloadState = "running" | "paused" | "error" | "done" | "cancelled";

/** Payload of "download:progress" (every 500 ms while a download runs). */
export interface DownloadProgress {
  key: string;
  phase: DownloadPhase;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  /** Bytes per second (5 s average); 0 outside "downloading". */
  speedBps: number;
  /** Seconds left in this phase (null while unknown). */
  etaSecs: number | null;
  currentFile: string;
}

/** `{ code, message }` – "download:error", or a refused download_start / download_resume. */
export interface DownloadError {
  code: string;
  message: string;
}

/** One entry of download_status. */
export interface DownloadJob {
  key: string;
  version: string;
  cl: number;
  folder: string;
  state: DownloadState;
  progress: DownloadProgress;
  error: DownloadError | null;
  buildId: string | null;
  /** Files of this build are in the folder already ("Remove" then offers to delete them). */
  filesKept: boolean;
}

/** Folders the launcher uses (Settings / Logs pages). */
export interface NiobiumPaths {
  config: string;
  logs: string;
  crashes: string;
  fortniteLogs: string;
}

/**
 * Payload of the event "app:close-requested": the window was asked to close while something
 * still runs or starts. `running` holds plain names like "Your game", "Game server", "Backend".
 * `id` = the question's number: the dialog answers `close_prompt_shown(id)` once it is on screen,
 * otherwise Rust stops everything and closes after a few seconds (missing in the browser preview).
 */
export interface CloseRequested {
  running: string[];
  id?: number;
}

export const defaultSettings: Settings = {
  playerName: "Player",
  launchArgs: "-d3d11",
  headlessServer: true,
  autoRestart: false,
  backendPort: BACKEND_PORT,
  matchmakerPort: 80,
  gameServerPort: GAME_SERVER_PORT,
  shareBackendLan: false,
  glass: true,
  reduceMotion: false,
  animatedBackground: true,
  bubbleBuilds: false,
  lastSeenVersion: null,
};

export const defaultClientSettings: ClientSettings = {
  hotkey: 120,
  joinHotkey: 116,
  consoleMode: 0,
  preferences: {
    saveTogglePreferences: true,
    slashKey: true,
    editOnRelease: true,
    resetOnRelease: true,
    disablePreEdits: true,
    mobileBuilds: false,
    inGameFog: true,
    firstPerson: false,
    sprintByDefault: false,
    respawnsEnabled: true,
    bubbleLook: false,
    bubbleStrength: 5,
    resetBuilds: false,
    resetBuildsKey: 0,
  },
  commands: [],
  macros: [],
};

// ---- Stand-in for the browser preview ----------------------------------------------------

let demoConfig: Config = {
  configVersion: 1,
  // The preview counts as "already seen", so the welcome only shows with ?welcome=1
  settings: { ...defaultSettings, playerName: "georg", lastSeenVersion: DEMO_APP_VERSION },
  builds: demoBuilds,
  profiles: demoProfiles,
  activeProfileId: demoProfiles[0].id,
  friends: demoFriends,
  trickshotPresets: [
    { name: "Trickshot training", commands: ["parkour sniper", "givetraps", "regen"] },
    { name: "Up in the air", commands: ["l 4000"] },
  ],
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
          { ok: true, text: "Found FortniteClient-Win64-Shipping.exe" },
          { ok: true, text: "Version read: 19.10 (CL-18675304)" },
          { ok: true, text: "Game files are there (42 .pak files)" },
          { ok: true, text: "This version is supported" },
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
        ["This PC only", "127.0.0.1:7777"],
        ["Tailscale", "100.88.41.3:7777"],
        ["Radmin VPN", "26.120.7.55:7777"],
      ];
    case "set_trickshot_presets":
      demoConfig = { ...demoConfig, trickshotPresets: (args?.presets ?? []) as TrickshotPreset[] };
      return demoConfig;
    case "get_client_settings":
      return demoClient;
    case "set_client_settings":
      demoClient = args.value as ClientSettings;
      return null;
    case "bubble_builds_support":
      return bubbleInfoFor(String(args.version ?? ""));
    case "bots_support":
      return botsSupportFor(String(args.version ?? ""), typeof args.cl === "number" ? args.cl : null);
    case "catalog_list":
      return demoCatalog;
    case "default_download_folder":
      return `D:\\Niobium\\Builds\\${String(args.key)}`;
    case "pending_toasts":
      return [];
    case "app_ready":
      return null;
    case "quit_app":
      // Nothing to close in the browser – the dialog shows a toast instead
      console.info("[Preview] quit_app");
      return null;
    case "close_prompt_shown":
      return null;
    case "pending_log_lines":
      return [] satisfies LogLine[];
    // Server commands: there is no server in the preview – we pretend everything arrived.
    case "server_exec":
    case "server_config":
    case "server_start_match":
    case "spawn_bots":
    case "remove_bots":
      console.info("[Preview]", cmd, args);
      return null;
    case "niobium_paths":
      return {
        config: "%APPDATA%\\Niobium",
        logs: "%LOCALAPPDATA%\\Niobium\\logs",
        crashes: "%LOCALAPPDATA%\\FortniteGame\\Saved\\Crashes",
        fortniteLogs: "%LOCALAPPDATA%\\FortniteGame\\Saved\\Logs",
      } satisfies NiobiumPaths;
    default:
      // Anything that needs Fortnite doesn't exist in the preview
      throw new Error("Not available in the browser preview – only in the real launcher on Windows.");
  }
}

// ---- Calls -------------------------------------------------------------------------------

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
  setTrickshotPresets: (presets: TrickshotPreset[]) => call<Config>("set_trickshot_presets", { presets }),
  paths: () => call<NiobiumPaths>("niobium_paths"),

  /** Can this Fortnite version show Bubble Builds? `{ level, note }` with an English note. */
  bubbleBuildsSupport: (version: string) => call<BubbleBuildsInfo>("bubble_builds_support", { version }),
  /** Can AI bots be switched on for this version? `{ level, note }` with an English note. */
  botsSupport: (version: string, cl: number | null) => call<BotsSupport>("bots_support", { version, cl }),
  /** The UI has drawn its first frame: show the main window and close the splash. */
  appReady: () => call<void>("app_ready"),
  /** Launcher log lines from before the UI listened (oldest first). Only the first call returns lines. */
  pendingLogLines: () => call<LogLine[]>("pending_log_lines"),
  /** Toasts from before the UI listened (e.g. Fortnite's settings put back at start). Only the first call returns them. */
  pendingToasts: () => call<Toast[]>("pending_toasts"),

  hostAndPlay: (profileId: string) => call<void>("host_and_play", { profileId }),
  /** Stops everything. During a start it also cancels the start (Rust resets the steps to -1). */
  stopAll: () => call<void>("stop_all"),
  /** Stops everything (game, game server, backend, helpers) and then closes the launcher. */
  quitApp: () => call<void>("quit_app"),
  /** Tells Rust the "Close Niobium?" dialog is on screen (else it closes by itself after a few seconds). */
  closePromptShown: (id: number) => call<void>("close_prompt_shown", { id }),
  joinIp: (address: string) => call<void>("join_ip", { address }),
  serverExec: (text: string) => call<void>("server_exec", { text }),
  serverConfig: (key: string, value: unknown) => call<void>("server_config", { key, value }),
  serverStartMatch: () => call<void>("server_start_match"),
  spawnBots: (count: number) => call<void>("spawn_bots", { count }),
  removeBots: () => call<void>("remove_bots"),

  // Build downloader. In the browser preview src/lib/downloads.ts plays a download instead.
  /** Chapters → seasons → builds that can be downloaded. */
  catalogList: () => call<Catalog>("catalog_list"),
  /** Starts a download. Rejects with `{ code, message }` when the folder can't be used. */
  downloadStart: (key: string, folder: string) => call<void>("download_start", { key, folder }),
  downloadPause: (key: string) => call<void>("download_pause", { key }),
  /** Continues a paused or stopped download. Rejects with `{ code, message }`. */
  downloadResume: (key: string) => call<void>("download_resume", { key }),
  /** Stops it (a running one stops within seconds) and forgets it; `deleteFiles` removes only the build's files. */
  downloadCancel: (key: string, deleteFiles: boolean) => call<void>("download_cancel", { key, deleteFiles }),
  downloadStatus: () => call<DownloadJob[]>("download_status"),
  /** `<drive with the most free space>:\Niobium\Builds\<key>` */
  defaultDownloadFolder: (key: string) => call<string>("default_download_folder", { key }),
};

/** Version of the launcher app (from tauri.conf.json). Browser preview: "0.1.0". */
export async function appVersion(): Promise<string> {
  if (!inTauri) return DEMO_APP_VERSION;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Folder picker via the Windows dialog. In the preview: typed in by hand. */
export async function pickFolder(
  options: { title?: string; defaultPath?: string } = {},
): Promise<string | null> {
  const title = options.title ?? "Choose your build folder";
  if (!inTauri) return window.prompt(`${title} (preview):`, options.defaultPath ?? "C:\\Users\\georg\\Downloads\\windows-19.10");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({ directory: true, multiple: false, title, defaultPath: options.defaultPath || undefined });
  return typeof result === "string" ? result : null;
}

/** Text of a rejected call: `{ code, message }` objects give their message, everything else its text. */
export function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

/** Opens a folder in Explorer. Shows a short message if Windows can't open it (e.g. it was deleted). */
export async function openFolder(path: string): Promise<void> {
  if (!inTauri) return;
  try {
    await openPath(path);
  } catch {
    toast.error("Couldn't open the folder", { description: path });
  }
}

// ---- Events from Rust ----------------------------------------------------------------------

export type EventName =
  | "services"
  | "launch:step"
  | "log:line"
  | "toast"
  | "server:event"
  | "trickshot"
  | "detect"
  | "app:close-requested"
  | "server:playerBots"
  | "download:progress"
  | "download:done"
  | "download:error"
  | "download:state";

/** Like `onEvent`, but resolves only once the listener is really registered (preview: at once). */
export async function onEventReady<T>(name: EventName, handler: (payload: T) => void): Promise<() => void> {
  if (!inTauri) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}

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
