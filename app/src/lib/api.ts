/**
 * Zugriff auf das Rust-Backend. Im Browser (Vorschau, Tests) springt automatisch
 * ein Demo-Backend ein (./mock), damit die Oberfläche auch ohne Tauri vollständig funktioniert.
 * Vertrag: ./types.ts und docs/API.md
 */
import { isTauri } from "@shared/lib/env";
import { calendarApi } from "./api/calendar";
import { diagnoseApi } from "./api/diagnose";
import { exportApi } from "./api/export";
import { isplogApi } from "./api/isplog";
import { lagApi } from "./api/lag";
import { timelineApi } from "./api/timeline";
import { wifiApi } from "./api/wifi";
import type {
  AdapterInfo,
  AppInfo,
  ApplyReport,
  AutoReport,
  BoostProfile,
  BoostState,
  DnsConfig,
  DnsResult,
  ImageFetchRequest,
  ImageFetchResult,
  ImageKind,
  LaunchConfig,
  LibraryBackup,
  NativeSettings,
  PingStats,
  PingTarget,
  PlayStats,
  PowerPlan,
  Region,
  RegionPing,
  RunningGame,
  ScanOptions,
  ScannedEntry,
  ScanResult,
  Session,
  SpeedResult,
  SystemStats,
  TraceResult,
  TrackInfo,
  TrayRecent,
  Tweak,
  UpdateInfo,
  WifiInfo,
} from "./types";

type Args = Record<string, unknown>;

/** Fehler als lesbaren Text (Backend liefert deutsche Sätze als String) */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Unlisten = () => void;

let mockModule: Promise<typeof import("./mock")> | null = null;
const loadMock = () => (mockModule ??= import("./mock"));

/** Zusätzliche Angaben für einen Aufruf (z. B. Header bei Roh-IPC) */
export interface CallOptions {
  headers?: Record<string, string>;
}

/**
 * Einen Backend-Befehl aufrufen. `args` als Objekt (JSON) oder als Bytes (Roh-IPC, z. B. `export_file`).
 * Im Browser bekommt das Demo-Backend Bytes als `{ bytes, headers }`.
 */
export async function call<T>(cmd: string, args?: Args | Uint8Array, options?: CallOptions): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<T>(cmd, args, options?.headers ? { headers: options.headers } : undefined);
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    }
  }
  const mock = await loadMock();
  const mockArgs: Args = args instanceof Uint8Array ? { bytes: args, headers: options?.headers ?? {} } : (args ?? {});
  return mock.mockInvoke<T>(cmd, mockArgs);
}

/**
 * Auf Backend-Events hören. Events:
 * "net://ping" MonitorUpdate · "net://trace" TraceHop · "net://dns" DnsProgress · "net://speed" SpeedProgress · "net://lag" LagEvent
 * "boost://state" BoostState · "game://started" GameStartedEvent · "game://stopped" GameStoppedEvent
 * "tray://action" { action } · "update://progress" ProgressEvent
 */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<Unlisten> {
  if (isTauri()) {
    const ev = await import("@tauri-apps/api/event");
    return ev.listen<T>(event, (e) => handler(e.payload));
  }
  const mock = await loadMock();
  return mock.mockListen(event, handler as (p: unknown) => void);
}

/** Lokalen Dateipfad in eine anzeigbare Bild-URL umwandeln */
let convert: ((p: string) => string) | null = null;
if (isTauri()) {
  void import("@tauri-apps/api/core").then((m) => {
    convert = (p: string) => m.convertFileSrc(p);
  });
}
export function imgSrc(path?: string | null): string | undefined {
  if (!path) return undefined;
  if (/^(https?:|data:|blob:|asset:)/.test(path)) return path;
  return convert ? convert(path) : path;
}
/** Sicherstellen, dass imgSrc bereit ist (vor dem ersten Rendern aufrufen) */
export async function initImgSrc(): Promise<void> {
  if (isTauri() && !convert) {
    const m = await import("@tauri-apps/api/core");
    convert = (p: string) => m.convertFileSrc(p);
  }
}

export type DbTable = "games" | "reports";

const baseApi = {
  // App
  appInfo: () => call<AppInfo>("app_info"),
  quit: () => call<void>("quit_app"),

  // Datenbank
  dbList: <T>(table: DbTable) => call<T[]>("db_list", { table }),
  dbPut: (table: DbTable, id: string, value: unknown) => call<void>("db_put", { table, id, value }),
  dbPutMany: (table: DbTable, items: { id: string; value: unknown }[]) => call<void>("db_put_many", { table, items }),
  dbDelete: (table: DbTable, id: string) => call<void>("db_delete", { table, id }),
  kvGet: <T>(key: string) => call<T | null>("kv_get", { key }),
  kvSet: (key: string, value: unknown) => call<void>("kv_set", { key, value }),

  // Spielzeit
  playtimeStats: () => call<PlayStats[]>("playtime_stats"),
  sessionsRange: (from: number, to: number) => call<Session[]>("sessions_range", { from, to }),
  sessionsForGame: (gameId: string, limit = 50) => call<Session[]>("sessions_for_game", { gameId, limit }),
  sessionDelete: (id: number) => call<void>("session_delete", { id }),

  // Spiele finden
  scanLibrary: (options: ScanOptions) => call<ScanResult>("scan_library", { options }),
  inspectPaths: (paths: string[]) => call<ScannedEntry[]>("inspect_paths", { paths }),
  pathsExist: (paths: string[]) => call<boolean[]>("paths_exist", { paths }),

  // Starten & Erkennung
  setTrackedGames: (games: TrackInfo[]) => call<void>("set_tracked_games", { games }),
  launchGame: (gameId: string, launch: LaunchConfig) => call<void>("launch_game", { gameId, launch }),
  stopGame: (gameId: string) => call<number>("stop_game", { gameId }),
  runningGames: () => call<RunningGame[]>("running_games"),
  openPath: (path: string) => call<void>("open_path", { path }),
  revealPath: (path: string) => call<void>("reveal_path", { path }),
  openUrl: (url: string) => call<void>("open_url", { url }),

  // Bilder
  imagesFetch: (request: ImageFetchRequest) => call<ImageFetchResult>("images_fetch", { request }),
  imageSetCustom: (gameId: string, kind: ImageKind, sourcePath: string) => call<{ path: string }>("image_set_custom", { gameId, kind, sourcePath }),
  exeIcon: (exePath: string, gameId: string) => call<string | null>("exe_icon", { exePath, gameId }),
  cacheSize: () => call<number>("cache_size"),
  cacheClear: () => call<number>("cache_clear"),

  // System
  systemStats: () => call<SystemStats>("system_stats"),

  // Netzwerk
  pingOnce: (target: PingTarget, count = 4) => call<PingStats>("net_ping_once", { target, count }),
  monitorStart: (targets: PingTarget[], intervalMs = 1000) => call<void>("net_monitor_start", { targets, intervalMs }),
  monitorStop: () => call<void>("net_monitor_stop"),
  regions: () => call<Region[]>("net_regions"),
  regionsPing: (ids?: string[], count = 4) => call<RegionPing[]>("net_regions_ping", { ids, count }),
  gameServers: (game: string) => call<Region[]>("net_game_servers", { game }),
  traceroute: (host: string, maxHops = 30) => call<TraceResult>("net_traceroute", { host, maxHops }),
  dnsBenchmark: (rounds = 5) => call<DnsResult[]>("net_dns_benchmark", { rounds }),
  dnsCurrent: () => call<DnsConfig | null>("net_dns_current"),
  /** DNS-Dienst (ID wie in net_dns_benchmark) einstellen – Windows fragt nach */
  dnsApply: (provider: string) => call<DnsConfig>("net_dns_apply", { provider }),
  /** Gesicherten DNS wiederherstellen – Windows fragt nach */
  dnsRestore: () => call<DnsConfig | null>("net_dns_restore"),
  /** DNS (null = bleibt) und Optimierungen mit einer Windows-Abfrage einstellen */
  autoOptimize: (provider: string | null, tweaks: string[]) => call<AutoReport>("net_auto_optimize", { provider, tweaks }),
  /** DNS, nagle und netThrottle mit einer Windows-Abfrage zurückstellen */
  autoRestore: () => call<AutoReport>("net_auto_restore"),
  adapters: () => call<AdapterInfo[]>("net_adapters"),
  wifi: () => call<WifiInfo | null>("net_wifi"),
  speedtest: () => call<SpeedResult>("net_speedtest"),
  speedtestCancel: () => call<void>("net_speedtest_cancel"),

  // Optimieren & Boost
  tweaks: () => call<Tweak[]>("opt_tweaks"),
  tweaksApply: (ids: string[], enable: boolean) => call<ApplyReport>("opt_apply", { ids, enable }),
  tweaksRevertAll: () => call<ApplyReport>("opt_revert_all"),
  powerPlans: () => call<PowerPlan[]>("opt_power_plans"),
  powerSet: (guid: string) => call<void>("opt_power_set", { guid }),
  flushDns: () => call<void>("opt_flush_dns"),
  boostStart: (profile: BoostProfile, gameId?: string | null, pid?: number | null) => call<BoostState>("boost_start", { profile, gameId, pid }),
  boostStop: () => call<BoostState>("boost_stop"),
  boostState: () => call<BoostState>("boost_state"),

  // Sicherungen
  backupsList: () => call<LibraryBackup[]>("backups_list"),
  backupNow: () => call<LibraryBackup>("backup_now"),
  backupRestore: (file: string) => call<void>("backup_restore", { file }),

  // Native Integration
  applyNativeSettings: (settings: NativeSettings) => call<void>("apply_native_settings", { settings }),
  overlayToggle: () => call<boolean>("overlay_toggle"),
  traySetRecent: (items: TrayRecent[]) => call<void>("tray_set_recent", { items }),
  updateCheck: () => call<UpdateInfo>("update_check"),
  updateInstall: (setupUrl: string, sha256?: string | null) => call<void>("update_install", { setupUrl, sha256 }),
};

/** Alle Befehle: Basis plus die Teile der 7 Netzwerk-Funktionen (`lib/api/<funktion>.ts`) */
export const api = {
  ...baseApi,
  ...exportApi,
  ...lagApi,
  ...timelineApi,
  ...calendarApi,
  ...wifiApi,
  ...diagnoseApi,
  ...isplogApi,
};
