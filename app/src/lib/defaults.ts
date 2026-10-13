import { detectLanguage } from "./i18n";
import type { Game, Settings } from "./types";

export const defaultSettings = (): Settings => ({
  theme: "nova",
  accent: "",
  dynamicBackground: true,
  motion: "full",
  parallax: true,
  particles: true,
  soundVolume: 0.6,
  soundMuted: false,
  hoverSounds: true,
  language: detectLanguage(),
  steamGridDbKey: "",
  scan: { steam: true, epic: true, gog: true, startMenu: true, folders: [] },
  scanOnStart: true,
  minimizeOnLaunch: true,
  closeToTray: true,
  autostart: false,
  startMinimized: true,
  breakReminder: true,
  breakReminderMinutes: 120,
  notifications: true,
  dailyGoalMode: "limit",
  dailyGoalMinutes: 180,
  weatherPlace: null,
  overlayShortcut: "Alt+Shift+N",
  showDock: true,
  librarySort: "lastPlayed",
  librarySortDesc: true,
  libraryView: "grid",
  cardSize: 188,
  checkUpdates: true,
  introAnimation: true,
  launchRitual: true,
});

/** Fehlende Felder ergänzen (z. B. nach einem Update mit neuen Einstellungen) */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const d = defaultSettings();
  if (!stored || typeof stored !== "object") return d;
  return { ...d, ...stored, scan: { ...d.scan, ...(stored.scan ?? {}) } };
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 1e6;
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}${counter.toString(36)}`;
}

/** Fehlende Felder eines gespeicherten Spiels ergänzen - alte oder kaputte Daten dürfen nie abstürzen */
export function normalizeGame(raw: Partial<Game> & { id: string }): Game {
  const now = Date.now();
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name : "Unbenannt",
    kind: raw.kind === "app" ? "app" : "game",
    source: raw.source ?? "manual",
    sourceId: raw.sourceId,
    launch: raw.launch && typeof raw.launch.target === "string" ? raw.launch : { type: "exe", target: "" },
    installDir: raw.installDir,
    exePath: raw.exePath,
    processNames: Array.isArray(raw.processNames) ? raw.processNames : undefined,
    images: raw.images ?? {},
    palette: raw.palette,
    imagesCheckedAt: typeof raw.imagesCheckedAt === "number" ? raw.imagesCheckedAt : undefined,
    favorite: !!raw.favorite,
    hidden: !!raw.hidden,
    status: raw.status ?? "none",
    rating: typeof raw.rating === "number" ? Math.min(5, Math.max(0, raw.rating)) : 0,
    notes: raw.notes ?? "",
    genre: raw.genre,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    collectionIds: Array.isArray(raw.collectionIds) ? raw.collectionIds : [],
    links: { tools: [], ...(raw.links ?? {}) },
    inDock: raw.inDock,
    addedAt: raw.addedAt ?? now,
    updatedAt: raw.updatedAt ?? now,
  };
}
