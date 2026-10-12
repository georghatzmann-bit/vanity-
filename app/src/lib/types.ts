/**
 * NOVA Datenmodell - gemeinsamer Vertrag zwischen Oberfläche (TypeScript) und Backend (Rust).
 * Rust serialisiert mit `#[serde(rename_all = "camelCase")]`, Felder mit `?` sind optional.
 * Zeitstempel sind immer Millisekunden seit 1970 (UTC), Dauern immer Sekunden.
 */

export type GameKind = "game" | "app";
export type GameSource = "steam" | "epic" | "gog" | "startmenu" | "folder" | "manual";
export type PlayStatus = "none" | "want" | "playing" | "paused" | "done";
export type LaunchType = "exe" | "url" | "shell";
export type ImageKind = "cover" | "hero" | "logo" | "icon";

export interface LaunchConfig {
  /** exe = Programm direkt starten, url = Protokoll-Link (steam://...), shell = Datei über Windows öffnen (.lnk, .url) */
  type: LaunchType;
  target: string;
  args?: string;
  workDir?: string;
  asAdmin?: boolean;
}

export interface GameImages {
  /** Absolute lokale Pfade (zwischengespeicherte Bilder) */
  cover?: string;
  hero?: string;
  logo?: string;
  icon?: string;
}

export interface GamePalette {
  /** Kräftige Hauptfarbe aus dem Cover, z. B. "#ff4f8b" */
  primary: string;
  secondary: string;
  /** Sehr dunkle Variante für Hintergründe */
  dark: string;
}

export interface ExtraTool {
  id: string;
  name: string;
  path: string;
  args?: string;
}

export interface GameLinks {
  saves?: string;
  config?: string;
  mods?: string;
  screenshots?: string;
  tools: ExtraTool[];
}

export interface Game {
  id: string;
  name: string;
  kind: GameKind;
  source: GameSource;
  /** Steam-AppID, Epic-AppName, GOG-ID ... */
  sourceId?: string;
  launch: LaunchConfig;
  installDir?: string;
  exePath?: string;
  /** Zusätzliche Prozessnamen für die Spielzeit-Erkennung, z. B. "eldenring.exe" */
  processNames?: string[];
  images: GameImages;
  palette?: GamePalette;
  favorite: boolean;
  hidden: boolean;
  status: PlayStatus;
  /** 0 bis 5 (halbe Sterne erlaubt) */
  rating: number;
  notes: string;
  genre?: string;
  tags: string[];
  collectionIds: string[];
  links: GameLinks;
  /** In der Schnellstart-Leiste (Dock) anzeigen */
  inDock?: boolean;
  addedAt: number;
  updatedAt: number;
}

export interface PlayStats {
  gameId: string;
  totalSeconds: number;
  sessions: number;
  lastPlayedAt?: number;
  lastSessionSeconds?: number;
  firstPlayedAt?: number;
}

export interface Session {
  id: number;
  gameId: string;
  start: number;
  end: number;
  seconds: number;
}

export interface Collection {
  id: string;
  name: string;
  /** Name eines Lucide-Icons, z. B. "Flame" */
  icon: string;
  color: string;
  description?: string;
  createdAt: number;
  order: number;
}

export interface WishItem {
  id: string;
  name: string;
  price?: string;
  targetPrice?: string;
  store?: string;
  url?: string;
  note?: string;
  priority: 1 | 2 | 3;
  cover?: string;
  addedAt: number;
}

export interface UnlockedAchievement {
  id: string;
  unlockedAt: number;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  avatar?: string;
  createdAt: number;
}

export interface ProfilesState {
  profiles: Profile[];
  activeId: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  cacheDir: string;
  profileId: string;
  platform: "windows" | "linux" | "macos" | "browser";
  startedMinimized: boolean;
}

/** Ergebnis eines Scans - noch nicht in der Bibliothek */
export interface ScannedEntry {
  name: string;
  kind: GameKind;
  source: GameSource;
  sourceId?: string;
  launch: LaunchConfig;
  installDir?: string;
  exePath?: string;
}

export interface ScanOptions {
  steam: boolean;
  epic: boolean;
  gog: boolean;
  startMenu: boolean;
  folders: string[];
}

export interface ScanResult {
  entries: ScannedEntry[];
  /** Verständliche Hinweise, z. B. "Steam wurde nicht gefunden" */
  messages: string[];
}

export interface TrackInfo {
  gameId: string;
  name: string;
  installDir?: string;
  exePath?: string;
  processNames?: string[];
}

export interface RunningGame {
  gameId: string;
  startedAt: number;
  pids: number[];
}

export interface SystemStats {
  /** Prozent 0..100 */
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  /** Prozent 0..100 oder null, wenn nicht messbar */
  gpu: number | null;
  cpuName?: string;
  gpuName?: string;
  uptimeSeconds?: number;
}

export interface WeatherNow {
  temperature: number;
  apparent: number;
  /** WMO-Wettercode */
  code: number;
  isDay: boolean;
  wind: number;
  high: number;
  low: number;
  place: string;
}

export interface GeoPlace {
  name: string;
  country?: string;
  admin?: string;
  lat: number;
  lon: number;
}

export interface ImageFetchRequest {
  gameId: string;
  name: string;
  steamAppId?: string;
  kinds: ImageKind[];
  apiKey?: string;
  force?: boolean;
}

export interface ImageFetchResult {
  images: GameImages;
  palette?: GamePalette;
  source: "steam" | "steamgriddb" | "none";
  messages: string[];
}

export interface SgdbGame {
  id: number;
  name: string;
  year?: number;
}

export interface SgdbImage {
  url: string;
  thumb: string;
  width: number;
  height: number;
}

export interface Screenshot {
  path: string;
  takenAt: number;
  source: "steam" | "gamebar" | "nvidia" | "folder";
}

export interface SaveBackup {
  id: string;
  gameId: string;
  path: string;
  createdAt: number;
  size: number;
}

export interface LibraryBackup {
  file: string;
  path: string;
  createdAt: number;
  size: number;
}

export interface ImportReport {
  games: number;
  collections: number;
  wishlist: number;
  sessions: number;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest?: string;
  notes?: string;
  setupUrl?: string;
  setupSha256?: string;
}

export interface NativeSettings {
  closeToTray: boolean;
  /** z. B. "Alt+Shift+N" (Format des Tauri-Global-Shortcut-Plugins) */
  overlayShortcut: string;
  minimizeOnLaunch: boolean;
  /** Sprache für Tray-Menü und System-Benachrichtigungen */
  language: Language;
}

export interface TrayRecent {
  id: string;
  name: string;
}

// ---------- Events vom Backend ----------
export interface GameStartedEvent {
  gameId: string;
  startedAt: number;
}
export interface GameStoppedEvent {
  gameId: string;
  session: Session;
}
export interface ProgressEvent {
  done: number;
  total: number;
  label?: string;
}

// ---------- Einstellungen (pro Profil, in kv "settings") ----------
export type ThemeId = "nova" | "polar" | "neon" | "midnight";
export type MotionLevel = "full" | "reduced" | "off";
export type Language = "de" | "en";
export type SortKey = "name" | "playtime" | "lastPlayed" | "rating" | "added";
export type ViewMode = "grid" | "list";
export type DailyGoalMode = "goal" | "limit";

export interface Settings {
  theme: ThemeId;
  /** Eigene Akzentfarbe (Hex) oder leer = Theme-Farbe */
  accent: string;
  /** Hintergrund passt sich dem gewählten Spiel an */
  dynamicBackground: boolean;
  motion: MotionLevel;
  parallax: boolean;
  particles: boolean;
  soundVolume: number;
  soundMuted: boolean;
  hoverSounds: boolean;
  language: Language;
  steamGridDbKey: string;
  scan: ScanOptions;
  scanOnStart: boolean;
  minimizeOnLaunch: boolean;
  closeToTray: boolean;
  autostart: boolean;
  startMinimized: boolean;
  breakReminder: boolean;
  breakReminderMinutes: number;
  notifications: boolean;
  dailyGoalMode: DailyGoalMode;
  dailyGoalMinutes: number;
  weatherPlace: GeoPlace | null;
  overlayShortcut: string;
  showDock: boolean;
  librarySort: SortKey;
  librarySortDesc: boolean;
  libraryView: ViewMode;
  cardSize: number;
  checkUpdates: boolean;
  introAnimation: boolean;
  launchRitual: boolean;
}
