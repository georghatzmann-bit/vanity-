/**
 * PULSAR – gemeinsamer Datenvertrag zwischen Oberfläche und Rust-Backend.
 * Alle Felder camelCase (Rust: #[serde(rename_all = "camelCase")]). Beschreibung der Befehle: docs/API.md
 */

// ---------------------------------------------------------------------------------------------
// Spiele
// ---------------------------------------------------------------------------------------------

export type GameKind = "game" | "app";
export type GameSource = "steam" | "epic" | "gog" | "startmenu" | "folder" | "manual";
export type LaunchType = "exe" | "url" | "shell";
export type ImageKind = "cover" | "hero" | "logo" | "icon";

export interface LaunchConfig {
  type: LaunchType;
  /** .exe-Pfad, URL (steam://…) oder Datei */
  target: string;
  args?: string;
  workingDir?: string;
  runAsAdmin?: boolean;
}

export interface GameImages {
  cover?: string;
  hero?: string;
  logo?: string;
  icon?: string;
}

export interface GamePalette {
  primary: string;
  secondary: string;
  dark: string;
}

export interface Game {
  id: string;
  name: string;
  kind: GameKind;
  source: GameSource;
  /** Steam-AppID, Epic-AppName, GOG-ID … */
  sourceId?: string;
  launch: LaunchConfig;
  installDir?: string;
  exePath?: string;
  /** Weitere Prozessnamen für die Erkennung („läuft gerade“) */
  processNames?: string[];
  images: GameImages;
  palette?: GamePalette;
  imagesCheckedAt?: number;
  favorite: boolean;
  hidden: boolean;
  addedAt: number;
  updatedAt: number;
  /** Region (Region.id), deren Ping für dieses Spiel gemessen wird */
  region?: string;
  /** Schlüssel für echte Spieleserver, z. B. "cs2", "dota2", "lol" (siehe net_game_servers) */
  serverGame?: string;
  /** Eigenes Boost-Profil (sonst gilt das allgemeine aus den Einstellungen) */
  boost?: Partial<BoostProfile>;
  /** Beim Start dieses Spiels automatisch boosten (überschreibt die allgemeine Einstellung) */
  autoBoost?: boolean;
}

export interface PlayStats {
  gameId: string;
  totalSeconds: number;
  sessions: number;
  lastPlayedAt: number | null;
  lastSessionSeconds: number | null;
  firstPlayedAt: number | null;
}

export interface Session {
  id: number;
  gameId: string;
  start: number;
  end: number;
  seconds: number;
}

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
  /** Hinweise, z. B. „Steam wurde nicht gefunden“ */
  messages: string[];
}

export interface TrackInfo {
  gameId: string;
  name: string;
  exePath?: string;
  installDir?: string;
  processNames?: string[];
}

export interface RunningGame {
  gameId: string;
  startedAt: number;
  pids: number[];
}

/** Event "game://started" */
export interface GameStartedEvent {
  gameId: string;
  startedAt: number;
}

/** Event "game://stopped" */
export interface GameStoppedEvent {
  gameId: string;
  session: Session;
}

export interface ImageFetchRequest {
  gameId: string;
  name: string;
  steamAppId?: string;
  kinds: ImageKind[];
  apiKey?: string;
  force?: boolean;
  exePath?: string;
  installDir?: string;
  lookupByName?: boolean;
}

export interface ImageFetchResult {
  images: GameImages;
  palette?: GamePalette;
  source: "steam" | "steamgriddb" | "exe" | "none";
  messages: string[];
  steamAppId?: string;
}

// ---------------------------------------------------------------------------------------------
// System & App
// ---------------------------------------------------------------------------------------------

export interface AppInfo {
  version: string;
  dataDir: string;
  cacheDir: string;
  platform: "windows" | "linux" | "macos";
  startedMinimized: boolean;
  /** Läuft Pulsar mit Adminrechten? */
  isAdmin: boolean;
}

export interface SystemStats {
  /** CPU-Last 0–100 */
  cpu: number;
  /** Bytes */
  ramUsed: number;
  ramTotal: number;
  /** GPU-Last 0–100 (nur Windows) */
  gpu: number | null;
  cpuName: string | null;
  gpuName: string | null;
  uptimeSeconds: number | null;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest: string | null;
  notes: string | null;
  setupUrl: string | null;
  setupSha256: string | null;
}

export interface LibraryBackup {
  file: string;
  path: string;
  createdAt: number;
  size: number;
}

export interface NativeSettings {
  closeToTray: boolean;
  /** z. B. "Alt+Shift+P" – blendet das Ping-Overlay ein/aus */
  overlayShortcut: string;
  minimizeOnLaunch: boolean;
  language: Language;
}

export interface TrayRecent {
  gameId: string;
  name: string;
}

// ---------------------------------------------------------------------------------------------
// Netzwerk
// ---------------------------------------------------------------------------------------------

export type PingMethod = "icmp" | "tcp";

export interface PingTarget {
  id: string;
  label: string;
  host: string;
  /** Nur bei "tcp" (Standard 443) */
  port?: number;
  method: PingMethod;
}

/** rtt = null: Paket verloren */
export interface PingSample {
  targetId: string;
  t: number;
  rtt: number | null;
}

export interface PingStats {
  targetId: string;
  last: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  jitter: number | null;
  /** 0–1 */
  loss: number;
  samples: number;
}

/** Event "net://ping" (ein Takt des Live-Monitors) */
export interface MonitorUpdate {
  samples: PingSample[];
  /** Über die letzten 60 Messungen je Ziel */
  stats: PingStats[];
}

export type Area = "eu" | "na" | "sa" | "asia" | "oce" | "me" | "af";

export interface Region {
  id: string;
  name: string;
  /** ISO-Ländercode */
  country: string;
  area: Area;
  /** z. B. "AWS", "Valve", "Riot" */
  provider: string;
  target: PingTarget;
}

export interface RegionPing {
  id: string;
  stats: PingStats;
}

/** Auch Event "net://trace" (eine Station nach der anderen) */
export interface TraceHop {
  hop: number;
  address: string | null;
  hostname: string | null;
  /** 3 Messungen in ms, null = keine Antwort */
  rtts: (number | null)[];
  zone: "lan" | "isp" | "internet" | "target";
}

export interface TraceResult {
  target: string;
  address: string | null;
  hops: TraceHop[];
  reached: boolean;
}

export interface DnsResult {
  id: string;
  name: string;
  primary: string;
  secondary: string | null;
  /** Bekannte Adresse (zwischengespeichert), Median ms */
  cachedMs: number | null;
  /** Neue Adresse (muss nachgeschlagen werden), Median ms */
  uncachedMs: number | null;
  failed: number;
  current: boolean;
}

/** Event "net://dns" */
export interface DnsProgress {
  done: number;
  total: number;
}

export interface DnsConfig {
  adapterId: string;
  adapter: string;
  servers: string[];
  dhcp: boolean;
  changedByPulsar: boolean;
}

export interface AdapterInfo {
  id: string;
  name: string;
  description: string;
  kind: "ethernet" | "wifi" | "other";
  up: boolean;
  speedMbps: number | null;
  ipv4: string[];
  gateway: string | null;
  dns: string[];
  primary: boolean;
}

export interface WifiInfo {
  ssid: string;
  /** 0–100 */
  signal: number;
  rssi: number | null;
  band: "2.4" | "5" | "6" | null;
  channel: number | null;
  phy: string;
  rxMbps: number | null;
  txMbps: number | null;
}

/** Event "net://speed" */
export interface SpeedProgress {
  phase: "latency" | "download" | "upload" | "done";
  progress: number;
  mbps: number | null;
  latencyMs: number | null;
}

export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface SpeedResult {
  downloadMbps: number;
  uploadMbps: number;
  idleLatencyMs: number;
  idleJitterMs: number;
  loadedLatencyDownMs: number | null;
  loadedLatencyUpMs: number | null;
  /** Größter Anstieg der Antwortzeit unter Last (ms) */
  bufferbloatMs: number;
  grade: Grade;
  server: string;
  at: number;
}

// ---------------------------------------------------------------------------------------------
// Optimieren & Boost
// ---------------------------------------------------------------------------------------------

/** Feste IDs der Optimierungen (Texte kommen aus den Übersetzungen). Alle ohne Adminrechte. */
export type TweakId = "powerPlan" | "gameMode" | "gameDvr" | "mouseAccel";

export interface Tweak {
  id: TweakId;
  category: "power" | "windows" | "input";
  impact: "high" | "medium" | "low";
  /** on = optimiert, off = Windows-Standard */
  state: "on" | "off" | "unknown" | "unsupported";
  detail: string | null;
  canRevert: boolean;
}

export interface ApplyReport {
  applied: string[];
  failed: { id: string; error: string }[];
}

export interface PowerPlan {
  guid: string;
  name: string;
  active: boolean;
}

export interface BoostProfile {
  powerPlan: boolean;
  gamePriority: "normal" | "above" | "high";
  flushDns: boolean;
}

export interface BoostAction {
  id: "powerPlan" | "priority" | "flushDns";
  ok: boolean;
  detail: string;
}

/** Auch Event "boost://state" */
export interface BoostState {
  active: boolean;
  since: number | null;
  gameId: string | null;
  actions: BoostAction[];
}

// ---------------------------------------------------------------------------------------------
// Berichte (Tabelle "reports" über db_put/db_list)
// ---------------------------------------------------------------------------------------------

export interface SessionReport {
  id: string;
  gameId: string | null;
  gameName: string;
  start: number;
  end: number;
  /** Gemessenes Ziel, z. B. „Frankfurt (AWS)“ */
  targetLabel: string;
  avgPing: number | null;
  minPing: number | null;
  maxPing: number | null;
  jitter: number | null;
  /** 0–1 */
  loss: number;
  /** Anzahl Ping-Spitzen */
  spikes: number;
  /** [Zeit, ms|null] – auf höchstens 600 Punkte verdichtet */
  timeline: [number, number | null][];
  boosted: boolean;
  grade: Grade;
}

// ---------------------------------------------------------------------------------------------
// Einstellungen (in kv "settings")
// ---------------------------------------------------------------------------------------------

export type ThemeId = "pulsar" | "ember" | "toxic" | "frost";
export type MotionLevel = "full" | "reduced" | "off";
export type Language = "de" | "en";
export type OverlayItem = "ping" | "jitter" | "loss" | "cpu" | "gpu" | "ram" | "clock";
export type Corner = "tl" | "tr" | "bl" | "br";

export interface Settings {
  theme: ThemeId;
  /** Eigene Akzentfarbe (#rrggbb) oder "" */
  accent: string;
  motion: MotionLevel;
  language: Language;
  introAnimation: boolean;
  sound: boolean;
  /** 0–1 */
  volume: number;
  hoverSounds: boolean;

  closeToTray: boolean;
  autostart: boolean;

  /** Ziel für den Live-Ping im Cockpit (Region.id) */
  monitorRegion: string;
  pingIntervalMs: number;
  /** Ab diesem Ping (ms) warnt Pulsar */
  pingAlertMs: number;
  notifications: boolean;
  favoriteRegions: string[];

  autoBoost: boolean;
  boostProfile: BoostProfile;

  overlayEnabled: boolean;
  overlayShortcut: string;
  overlayCorner: Corner;
  /** 0.3–1 */
  overlayOpacity: number;
  overlayItems: OverlayItem[];

  scanOnStartup: boolean;
  steamGridDbKey: string;
}
