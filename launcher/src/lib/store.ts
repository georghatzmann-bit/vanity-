import { create } from "zustand";
import { toast } from "sonner";
import {
  api,
  defaultClientSettings,
  defaultSettings,
  inTauri,
  onEvent,
  type ClientSettings,
  type Config,
  type LogLine,
  type Services,
  type ServiceStatus,
  type Toast,
} from "./api";
import { demoLogScript } from "./demo-data";

export type { ServiceStatus };

export type PageId =
  | "start"
  | "library"
  | "servers"
  | "match"
  | "ingame"
  | "profiles"
  | "logs"
  | "crashes"
  | "settings"
  | "about";

/** Schritte beim „Host & Play“-Start – gleiche Reihenfolge wie in engine.rs. */
export const launchSteps = [
  { label: "Backend", hint: "Port 3551" },
  { label: "Server-Fortnite", hint: "ohne Grafik" },
  { label: "Umleitung", hint: "alles an 127.0.0.1" },
  { label: "Anmeldung", hint: "im Log erkannt" },
  { label: "Game Server", hint: "Port 7777" },
  { label: "Dein Spiel", hint: "mit -d3d11" },
  { label: "Lobby", hint: "bereit zum Spielen" },
] as const;

const emptyConfig: Config = {
  configVersion: 1,
  settings: defaultSettings,
  builds: [],
  profiles: [],
  activeProfileId: "",
  friends: [],
};

interface AppState {
  ready: boolean;
  page: PageId;
  setPage: (page: PageId) => void;

  config: Config;
  setConfig: (config: Config) => void;
  reload: () => Promise<void>;

  services: Services;
  /** -1 = nichts läuft; 0..n-1 = aktueller Schritt; n = fertig */
  launchStep: number;

  logs: LogLine[];
  pushLog: (line: LogLine) => void;
  clearLogs: () => void;

  clientSettings: ClientSettings;
  saveClientSettings: (patch: Partial<ClientSettings>) => Promise<void>;

  init: () => Promise<void>;
}

const MAX_LOG_LINES = 3000;

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

  services: { backend: "stopped", server: "stopped", game: "stopped" },
  launchStep: -1,

  logs: [],
  pushLog: (line) => set((s) => ({ logs: [...s.logs, line].slice(-MAX_LOG_LINES) })),
  clearLogs: () => set({ logs: [] }),

  clientSettings: defaultClientSettings,
  saveClientSettings: async (patch) => {
    const next = { ...get().clientSettings, ...patch };
    set({ clientSettings: next });
    try {
      await api.setClientSettings(next);
    } catch (e) {
      toast.error("Konnte nicht speichern", { description: String(e) });
    }
  },

  init: async () => {
    if (get().ready) return;
    const [config, clientSettings] = await Promise.all([api.getConfig(), api.getClientSettings()]);
    set({ config, clientSettings, ready: true });

    onEvent<Services>("services", (services) => set({ services }));
    onEvent<number>("launch:step", (launchStep) => set({ launchStep }));
    onEvent<LogLine>("log:line", (line) => get().pushLog(line));
    onEvent<Toast>("toast", (t) => {
      const fn = t.kind === "error" ? toast.error : t.kind === "success" ? toast.success : t.kind === "warning" ? toast.warning : toast;
      fn(t.title, { description: t.description });
    });
    onEvent<{ player?: string; text?: string; distance?: number }>("trickshot", (t) => {
      toast.success(`Trickshot: ${t.player ?? ""}`, { description: `${t.text ?? ""}${t.distance ? ` · ${t.distance} m` : ""}` });
    });

    if (!inTauri) startDemoLog();
  },
}));

/** Beispiel-Zeilen in der Browser-Vorschau, damit die Log-Seite nicht leer ist. */
function startDemoLog() {
  let i = 0;
  const tick = () => {
    if (i >= demoLogScript.length) return;
    const line = demoLogScript[i++];
    const now = new Date();
    useApp.getState().pushLog({
      ...line,
      time: now.toLocaleTimeString("de-DE", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0"),
    });
    window.setTimeout(tick, 260 + Math.random() * 380);
  };
  window.setTimeout(tick, 400);
}

/** Aktives Profil (oder das erste). */
export function activeProfile(config: Config) {
  return config.profiles.find((p) => p.id === config.activeProfileId) ?? config.profiles[0] ?? null;
}

/** Build zu einem Profil. */
export function buildOf(config: Config, buildId: string | undefined) {
  return config.builds.find((b) => b.id === buildId) ?? config.builds[0] ?? null;
}

export function keyName(vk: number): string {
  if (vk >= 112 && vk <= 135) return `F${vk - 111}`;
  const named: Record<number, string> = {
    8: "Rücktaste", 9: "Tab", 13: "Enter", 16: "Umschalt", 17: "Strg", 18: "Alt", 20: "Feststell",
    27: "Esc", 32: "Leertaste", 33: "Bild ↑", 34: "Bild ↓", 35: "Ende", 36: "Pos1",
    37: "←", 38: "↑", 39: "→", 40: "↓", 45: "Einfg", 46: "Entf", 192: "^", 226: "<",
  };
  if (named[vk]) return named[vk];
  if (vk >= 48 && vk <= 90) return String.fromCharCode(vk);
  if (vk >= 96 && vk <= 105) return `Num ${vk - 96}`;
  return `Taste ${vk}`;
}

/** Browser-Tastencode → Windows-VK-Code (für client.json). */
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
