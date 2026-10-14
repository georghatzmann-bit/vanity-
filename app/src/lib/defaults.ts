import { detectLanguage } from "./i18n";
import { defaultHistory, mergeHistory } from "./settings/history";
import { defaultIspLog, mergeIspLog } from "./settings/isplog";
import { defaultLag, mergeLag } from "./settings/lag";
import { defaultSonar, mergeSonar } from "./settings/sonar";
import type { BoostProfile, Game, Settings } from "./types";

export const defaultBoostProfile = (): BoostProfile => ({ powerPlan: true, gamePriority: "high", flushDns: true });

export const defaultSettings = (): Settings => ({
  theme: "pulsar",
  accent: "",
  motion: "full",
  language: detectLanguage(),
  introAnimation: true,
  sound: true,
  volume: 0.6,
  hoverSounds: true,

  closeToTray: true,
  autostart: false,

  monitorRegion: "aws-eu-central-1",
  pingIntervalMs: 1000,
  pingAlertMs: 120,
  notifications: true,
  favoriteRegions: ["aws-eu-central-1", "aws-eu-west-3", "aws-eu-west-2", "aws-us-east-1"],

  autoBoost: true,
  boostProfile: defaultBoostProfile(),

  overlayEnabled: true,
  overlayShortcut: "Alt+Shift+P",
  overlayCorner: "tr",
  overlayOpacity: 0.85,
  overlayItems: ["ping", "jitter", "loss", "cpu", "gpu"],

  scanOnStartup: true,
  steamGridDbKey: "",

  lag: defaultLag(),
  sonar: defaultSonar(),
  ispLog: defaultIspLog(),
  history: defaultHistory(),
});

/** Fehlende Felder ergänzen (z. B. nach einem Update mit neuen Einstellungen) */
export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const d = defaultSettings();
  if (!stored || typeof stored !== "object") return d;
  const s = { ...d, ...stored, boostProfile: { ...d.boostProfile, ...(stored.boostProfile ?? {}) } };
  if (!["pulsar", "ember", "toxic", "frost"].includes(s.theme)) s.theme = "pulsar";
  const items: Settings["overlayItems"] = ["ping", "jitter", "loss", "cpu", "gpu", "ram", "clock"];
  s.overlayItems = Array.isArray(s.overlayItems) ? s.overlayItems.filter((i) => items.includes(i)) : d.overlayItems;
  if (!Array.isArray(s.favoriteRegions)) s.favoriteRegions = d.favoriteRegions;
  if (!["full", "reduced", "off"].includes(s.motion)) s.motion = "full";
  if (!["tl", "tr", "bl", "br"].includes(s.overlayCorner)) s.overlayCorner = d.overlayCorner;
  if (!["normal", "above", "high"].includes(s.boostProfile.gamePriority)) s.boostProfile.gamePriority = d.boostProfile.gamePriority;
  s.volume = Math.min(1, Math.max(0, Number(s.volume) || 0));
  s.pingIntervalMs = Math.min(5000, Math.max(250, Number(s.pingIntervalMs) || 1000));
  s.pingAlertMs = Math.min(1000, Math.max(20, Number(s.pingAlertMs) || d.pingAlertMs));
  s.overlayOpacity = Math.min(1, Math.max(0.3, Number(s.overlayOpacity) || 0.85));
  // Netzwerk-Funktionen (Teil 2): je Namensraum eigene Ergänzung/Kappung (lib/settings/*)
  s.lag = mergeLag(stored.lag);
  s.sonar = mergeSonar(stored.sonar);
  s.ispLog = mergeIspLog(stored.ispLog);
  s.history = mergeHistory(stored.history);
  return s;
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 1e6;
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}${counter.toString(36)}`;
}

/** Fehlende Felder eines gespeicherten Spiels ergänzen – alte oder kaputte Daten dürfen nie abstürzen */
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
    addedAt: raw.addedAt ?? now,
    updatedAt: raw.updatedAt ?? now,
    region: typeof raw.region === "string" ? raw.region : undefined,
    serverGame: typeof raw.serverGame === "string" ? raw.serverGame : undefined,
    boost: raw.boost && typeof raw.boost === "object" ? raw.boost : undefined,
    autoBoost: typeof raw.autoBoost === "boolean" ? raw.autoBoost : undefined,
  };
}

/** Steam-AppID → Schlüssel für echte Spieleserver (siehe net_game_servers) */
const SERVER_GAMES: Record<string, string> = { "730": "cs2", "570": "dota2", "1422450": "deadlock" };
export function guessServerGame(game: Pick<Game, "name" | "sourceId" | "source">): string | undefined {
  if (game.source === "steam" && game.sourceId && SERVER_GAMES[game.sourceId]) return SERVER_GAMES[game.sourceId];
  const n = game.name.toLowerCase();
  if (n.includes("counter-strike")) return "cs2";
  if (n.includes("dota")) return "dota2";
  if (n.includes("deadlock")) return "deadlock";
  if (n.includes("league of legends")) return "lol";
  return undefined;
}
