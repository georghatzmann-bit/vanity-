import { create } from "zustand";
import { toast } from "sonner";
import {
  api,
  appVersion,
  defaultClientSettings,
  defaultSettings,
  inTauri,
  onEvent,
  onEventReady,
  DEMO_APP_VERSION,
  type ClientSettings,
  type CloseRequested,
  type TrickshotPreset,
  type Config,
  type LogLine,
  type Services,
  type ServiceStatus,
  type Settings,
  type PlayerBotsEvent,
  type LivingWorldEvent,
  type Toast,
} from "./api";
import { botsText } from "./bots";
import { demoLogScript } from "./demo-data";
import { livingWorldText } from "./livingworld";

export type { ServiceStatus };

export type PageId =
  | "start"
  | "library"
  /** "Download a version" – a sub-page of the Library (not in the sidebar itself). */
  | "download"
  | "servers"
  | "match"
  | "ingame"
  | "profiles"
  | "logs"
  | "crashes"
  | "settings"
  | "about";

const PAGE_IDS: readonly PageId[] = ["start", "library", "download", "servers", "match", "ingame", "profiles", "logs", "crashes", "settings", "about"];

/** Steps of a "Host & Play" launch – same order as in engine.rs. */
export const launchSteps = [
  { label: "Backend", hint: "Port 3551" },
  { label: "Server", hint: "Fortnite with no graphics" },
  { label: "Redirect", hint: "everything to 127.0.0.1" },
  { label: "Login", hint: "the server logs in" },
  { label: "Your game", hint: "starts alongside" },
  { label: "Game server", hint: "loads the map, port 7777" },
  { label: "Lobby", hint: "press Play in the game" },
] as const;

/**
 * The last step ("Lobby"): Rust sends it when the game server is ready, and then the start is done.
 * Steps 0 up to this one minus 1 mean a start is in progress ("Cancel start"); -1 = idle.
 */
export const LAUNCH_DONE_STEP = launchSteps.length - 1;

/** True while a start is in progress (not yet done, not idle). */
export function isStarting(step: number): boolean {
  return step >= 0 && step < LAUNCH_DONE_STEP;
}

/** What to show on top of the app after start: nothing, the full welcome, or the "What's new" card. */
export type WelcomeMode = "none" | "full" | "whatsnew";

const emptyConfig: Config = {
  configVersion: 1,
  settings: defaultSettings,
  builds: [],
  profiles: [],
  activeProfileId: "",
  friends: [],
  trickshotPresets: [],
};

interface AppState {
  /** Config loaded (or failed to load) – the UI can draw. */
  ready: boolean;
  page: PageId;
  setPage: (page: PageId) => void;

  config: Config;
  setConfig: (config: Config) => void;
  reload: () => Promise<void>;
  /** Changes some settings, saves them and shows a toast if saving fails. */
  saveSettings: (patch: Partial<Settings>) => Promise<void>;

  services: Services;
  /** -1 = nothing runs; 0..n-1 = current step; n = done */
  launchStep: number;

  logs: LogLine[];
  pushLog: (line: LogLine) => void;
  clearLogs: () => void;

  clientSettings: ClientSettings;
  saveClientSettings: (patch: Partial<ClientSettings>) => Promise<void>;
  saveTrickshotPresets: (presets: TrickshotPreset[]) => Promise<void>;

  /** Version of the launcher, e.g. "0.1.0". */
  appVersion: string;
  welcome: WelcomeMode;
  /** Closes the welcome / "What's new" and remembers this version (plus optional setting changes). */
  finishWelcome: (patch?: Partial<Settings>) => Promise<void>;

  /** Set when the window was asked to close while something still runs (event "app:close-requested"). */
  closeRequest: CloseRequested | null;
  dismissCloseRequest: () => void;

  /** The server's answer about AI bots for this match (event "server:playerBots"); null = none yet. */
  playerBots: PlayerBotsEvent | null;

  /** How "Bosses & NPCs" go this match (event "server:livingWorld"); null = no answer yet. */
  livingWorld: LivingWorldEvent | null;

  init: () => Promise<void>;
}

const MAX_LOG_LINES = 3000;

/** A toast from Rust (event "toast" or `pending_toasts`). An empty description is left out. */
function showToast(t: Toast) {
  const fn = t.kind === "error" ? toast.error : t.kind === "success" ? toast.success : t.kind === "warning" ? toast.warning : toast;
  fn(t.title, t.description ? { description: t.description } : undefined);
}

/**
 * Reasons of "Bosses & NPCs aren't available" pop-ups already shown this match: each reason pops up at
 * most once per match (like the live-log line in Rust). Emptied at the end of a match and when the game
 * server stops.
 */
const livingWorldWarned = new Set<string>();

/** The bot and Bosses & NPCs answers belong to one match: forget them (end of match, server stopped). */
function forgetMatchAnswers() {
  livingWorldWarned.clear();
  const s = useApp.getState();
  if (s.playerBots || s.livingWorld) useApp.setState({ playerBots: null, livingWorld: null });
}

/** "Always sprint" was removed: an old client.json may still have it on, but it always stays off. */
function withoutSprint(settings: ClientSettings): ClientSettings {
  return { ...settings, preferences: { ...settings.preferences, sprintByDefault: false } };
}

/**
 * Browser preview only: ?page=library, ?welcome=1, ?whatsnew=1, ?gusrestored=1, ?closeconfirm=1,
 * ?botsoff=1, ?livingworld=active|unavailable, ?dl=running (see downloads.ts) – for screenshots. Always
 * null in the real launcher.
 */
export function previewParam(name: string): string | null {
  if (inTauri) return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

export const useApp = create<AppState>()((set, get) => ({
  ready: false,
  page: "start",
  setPage: (page) => set({ page }),

  config: emptyConfig,
  setConfig: (config) => set({ config }),
  reload: async () => {
    const config = await api.getConfig();
    set({ config });
  },
  saveSettings: async (patch) => {
    const settings = { ...get().config.settings, ...patch };
    set((s) => ({ config: { ...s.config, settings } }));
    try {
      await api.updateSettings(settings);
    } catch (e) {
      toast.error("Couldn't save", { description: String(e) });
    }
  },

  services: { backend: "stopped", server: "stopped", game: "stopped" },
  launchStep: -1,

  logs: [],
  pushLog: (line) => set((s) => ({ logs: [...s.logs, line].slice(-MAX_LOG_LINES) })),
  clearLogs: () => set({ logs: [] }),

  clientSettings: defaultClientSettings,
  saveClientSettings: async (patch) => {
    const cur = get().clientSettings;
    const next = withoutSprint({ ...cur, ...patch, preferences: { ...cur.preferences, ...(patch.preferences ?? {}) } });
    set({ clientSettings: next });
    try {
      await api.setClientSettings(next);
    } catch (e) {
      toast.error("Couldn't save", { description: String(e) });
    }
  },
  saveTrickshotPresets: async (presets) => {
    try {
      const config = await api.setTrickshotPresets(presets);
      set({ config });
    } catch (e) {
      toast.error("Couldn't save", { description: String(e) });
    }
  },

  appVersion: DEMO_APP_VERSION,
  welcome: "none",
  finishWelcome: async (patch = {}) => {
    set({ welcome: "none" });
    await get().saveSettings({ ...patch, lastSeenVersion: get().appVersion });
  },


  closeRequest: null,
  dismissCloseRequest: () => set({ closeRequest: null }),

  playerBots: null,

  livingWorld: null,

  init: async () => {
    if (get().ready) return;
    let config = emptyConfig;
    let clientSettings = defaultClientSettings;
    try {
      [config, clientSettings] = await Promise.all([api.getConfig(), api.getClientSettings()]);
    } catch (e) {
      toast.error("Couldn't load your settings", { description: String(e) });
    }
    const version = await appVersion().catch(() => DEMO_APP_VERSION);

    // First start → full welcome; new version → short "What's new"
    let welcome: WelcomeMode = "none";
    const lastSeen = config.settings.lastSeenVersion ?? "";
    if (inTauri) {
      welcome = !lastSeen ? "full" : lastSeen !== version ? "whatsnew" : "none";
    } else if (previewParam("welcome")) {
      welcome = "full";
    } else if (previewParam("whatsnew")) {
      welcome = "whatsnew";
    }
    const startPage = previewParam("page");
    const page = PAGE_IDS.includes(startPage as PageId) ? (startPage as PageId) : get().page;

    set({ config, clientSettings: withoutSprint(clientSettings), appVersion: version, welcome, page, ready: true });

    onEvent<Services>("services", (services) => set({ services }));
    onEvent<number>("launch:step", (launchStep) => set({ launchStep }));
    // Lines written before this listener existed wait in Rust. Fetch them once the listener is
    // really registered (so nothing falls in between) and put them before any newer lines.
    void onEventReady<LogLine>("log:line", (line) => get().pushLog(line))
      .then(() => api.pendingLogLines())
      .then((early) => {
        if (early.length > 0) set((s) => ({ logs: [...early, ...s.logs].slice(-MAX_LOG_LINES) }));
      })
      .catch(() => {});
    // Toasts sent before this listener existed (e.g. "Fortnite's graphics settings were put back."
    // right at start) wait in Rust, like the early log lines.
    void onEventReady<Toast>("toast", showToast)
      .then(() => api.pendingToasts())
      .then((early) => early.forEach(showToast))
      .catch(() => {});
    // From the server: {"event":"trickshot","player":…,"victim":…,"meters":N} – a kill in the air
    onEvent<{ player?: string; victim?: string; meters?: number }>("trickshot", (t) => {
      const who = t.player || "Someone";
      const parts = [t.victim ? `on ${t.victim}` : "", typeof t.meters === "number" ? `${t.meters} m` : ""].filter(Boolean);
      toast.success(`TRICKSHOT! ${who}`, { description: parts.join(" · ") || "A kill in the air" });
    });
    // The server decided whether AI bots can run in this match. Only "unavailable" needs a message.
    onEvent<PlayerBotsEvent>("server:playerBots", (payload) => {
      const state = payload?.state === "active" ? "active" : "unavailable";
      const reason = typeof payload?.reason === "string" ? payload.reason : "";
      set({ playerBots: { state, reason } });
      if (state === "unavailable") toast.warning(botsText.unavailableTitle, { description: reason || botsText.noteNotYet });
    });
    // How Bosses & NPCs go this match (the status chip on Match Control). "off" (the switch is off) changes
    // nothing you can see: no chip. Only "unavailable" needs a message, once per match for each reason.
    onEvent<LivingWorldEvent>("server:livingWorld", (payload) => {
      const state = payload?.state === "active" || payload?.state === "unavailable" ? payload.state : "off";
      if (state === "off") {
        if (get().livingWorld) set({ livingWorld: null });
        return;
      }
      const reason = typeof payload?.reason === "string" ? payload.reason : "";
      const spawned = typeof payload?.spawned === "number" && payload.spawned > 0 ? Math.floor(payload.spawned) : 0;
      set({ livingWorld: { state, reason, spawned } });
      if (state === "unavailable" && !livingWorldWarned.has(reason)) {
        livingWorldWarned.add(reason);
        toast.warning(livingWorldText.unavailableTitle, reason ? { description: reason } : undefined);
      }
    });
    // The match is over (the server can stay open for the next one): its bot and Bosses & NPCs answers go
    onEvent<{ event?: string }>("server:event", (payload) => {
      if (payload?.event === "matchEnd") forgetMatchAnswers();
    });
    // The window was asked to close (X, Alt+F4, taskbar) while something runs: Rust waits for the answer
    onEvent<CloseRequested>("app:close-requested", (payload) =>
      set({
        closeRequest: {
          running: Array.isArray(payload?.running) ? payload.running.filter((n) => typeof n === "string") : [],
          id: typeof payload?.id === "number" ? payload.id : undefined,
        },
      }),
    );

    if (!inTauri) {
      if (previewParam("gusrestored")) {
        // What Rust sends after a game with Bubble Builds
        window.setTimeout(() => showToast({ kind: "success", title: "Fortnite's graphics settings were put back.", description: "" }), 600);
      }
      if (previewParam("closeconfirm")) {
        set({ closeRequest: { running: ["Your game", "Game server", "Backend"] } });
      }
      if (previewParam("botsoff")) {
        // What the server sends when its safety checks don't match this copy of 19.10
        const reason = "Bots aren't available for this copy of 19.10.";
        set({ playerBots: { state: "unavailable", reason } });
        window.setTimeout(() => toast.warning(botsText.unavailableTitle, { description: reason }), 600);
      }
      const lw = previewParam("livingworld");
      if (lw === "active") set({ livingWorld: { state: "active", reason: "", spawned: 12 } });
      if (lw === "unavailable") set({ livingWorld: { state: "unavailable", reason: "not built yet for this version", spawned: 0 } });
      startDemoLog();
    }
  },
}));

// The bot and Bosses & NPCs answers belong to one match: forget them when the game server stops
// (the end of a match does the same, see "server:event" in init)
useApp.subscribe((s, prev) => {
  if (prev.services.server !== "stopped" && s.services.server === "stopped") forgetMatchAnswers();
});

/** Sample lines in the browser preview, so the log page isn't empty. */
function startDemoLog() {
  let i = 0;
  const tick = () => {
    if (i >= demoLogScript.length) return;
    const line = demoLogScript[i++];
    const now = new Date();
    useApp.getState().pushLog({
      ...line,
      time: now.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0"),
    });
    window.setTimeout(tick, 260 + Math.random() * 380);
  };
  window.setTimeout(tick, 400);
}

/** Active profile (or the first one). */
export function activeProfile(config: Config) {
  return config.profiles.find((p) => p.id === config.activeProfileId) ?? config.profiles[0] ?? null;
}

/** Build of a profile. */
export function buildOf(config: Config, buildId: string | undefined) {
  return config.builds.find((b) => b.id === buildId) ?? config.builds[0] ?? null;
}

/** Readable name of a Windows virtual-key code, e.g. 120 → "F9". */
export function keyName(vk: number): string {
  if (vk >= 112 && vk <= 135) return `F${vk - 111}`;
  const named: Record<number, string> = {
    8: "Backspace", 9: "Tab", 13: "Enter", 16: "Shift", 17: "Ctrl", 18: "Alt", 20: "Caps Lock",
    27: "Esc", 32: "Space", 33: "Page Up", 34: "Page Down", 35: "End", 36: "Home",
    37: "←", 38: "↑", 39: "→", 40: "↓", 45: "Insert", 46: "Delete", 192: "^", 226: "<",
  };
  if (named[vk]) return named[vk];
  if (vk >= 48 && vk <= 90) return String.fromCharCode(vk);
  if (vk >= 96 && vk <= 105) return `Num ${vk - 96}`;
  return `Key ${vk}`;
}

/** Browser key event → Windows virtual-key code (for client.json). */
export function vkFromEvent(e: KeyboardEvent): number | null {
  if (/^F\d{1,2}$/.test(e.key)) return 111 + Number(e.key.slice(1));
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (k.length === 1 && /[A-Z0-9]/.test(k)) return k.charCodeAt(0);
  const map: Record<string, number> = {
    Escape: 27, " ": 32, Enter: 13, Tab: 9, Backspace: 8, Insert: 45, Delete: 46, Home: 36, End: 35,
    PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Control: 17, Shift: 16, Alt: 18, CapsLock: 20,
  };
  if (e.code === "Backquote") return 192;
  if (e.code.startsWith("Numpad") && /^\d$/.test(e.code.slice(6))) return 96 + Number(e.code.slice(6));
  return map[e.key] ?? null;
}
