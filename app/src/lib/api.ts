/**
 * Zugriff auf das Rust-Backend. Im Browser (Vorschau, Tests) springt automatisch
 * ein Demo-Backend ein, damit die Oberfläche auch ohne Tauri vollständig funktioniert.
 */
import { isTauri } from "@shared/lib/env";
import type {
  AppInfo,
  Collection,
  GamePalette,
  GeoPlace,
  ImageFetchRequest,
  ImageFetchResult,
  ImageKind,
  ImportReport,
  LaunchConfig,
  LibraryBackup,
  NativeSettings,
  PlayStats,
  Profile,
  ProfilesState,
  RunningGame,
  SaveBackup,
  ScanOptions,
  ScannedEntry,
  ScanResult,
  Screenshot,
  Session,
  SgdbGame,
  SgdbImage,
  SystemStats,
  TrackInfo,
  TrayRecent,
  UpdateInfo,
  WeatherNow,
  WishItem,
  Game,
} from "./types";

type Args = Record<string, unknown>;
type Unlisten = () => void;

let mockModule: Promise<typeof import("./mock")> | null = null;
const loadMock = () => (mockModule ??= import("./mock"));

async function call<T>(cmd: string, args?: Args): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
    }
  }
  const mock = await loadMock();
  return mock.mockInvoke<T>(cmd, args ?? {});
}

/** Auf Backend-Events hören (z. B. "game://started") */
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

type DbTable = "games" | "collections" | "wishlist";

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  quit: () => call<void>("quit_app"),

  profilesList: () => call<ProfilesState>("profiles_list"),
  profileCreate: (name: string, color: string, avatar?: string) => call<Profile>("profile_create", { name, color, avatar }),
  profileUpdate: (profile: Profile) => call<void>("profile_update", { profile }),
  profileDelete: (id: string) => call<void>("profile_delete", { id }),
  profileSwitch: (id: string) => call<void>("profile_switch", { id }),

  dbList: <T>(table: DbTable) => call<T[]>("db_list", { table }),
  dbPut: (table: DbTable, id: string, value: unknown) => call<void>("db_put", { table, id, value }),
  dbPutMany: (table: DbTable, items: { id: string; value: unknown }[]) => call<void>("db_put_many", { table, items }),
  dbDelete: (table: DbTable, id: string) => call<void>("db_delete", { table, id }),
  kvGet: <T>(key: string) => call<T | null>("kv_get", { key }),
  kvSet: (key: string, value: unknown) => call<void>("kv_set", { key, value }),

  games: () => call<Game[]>("db_list", { table: "games" }),
  collections: () => call<Collection[]>("db_list", { table: "collections" }),
  wishlist: () => call<WishItem[]>("db_list", { table: "wishlist" }),

  playtimeStats: () => call<PlayStats[]>("playtime_stats"),
  sessionsRange: (from: number, to: number) => call<Session[]>("sessions_range", { from, to }),
  sessionsForGame: (gameId: string, limit = 50) => call<Session[]>("sessions_for_game", { gameId, limit }),
  sessionDelete: (id: number) => call<void>("session_delete", { id }),
  playtimeAdd: (gameId: string, seconds: number, at: number) => call<Session>("playtime_add", { gameId, seconds, at }),

  scanLibrary: (options: ScanOptions) => call<ScanResult>("scan_library", { options }),
  inspectPaths: (paths: string[]) => call<ScannedEntry[]>("inspect_paths", { paths }),
  pathsExist: (paths: string[]) => call<boolean[]>("paths_exist", { paths }),

  setTrackedGames: (games: TrackInfo[]) => call<void>("set_tracked_games", { games }),
  launchGame: (gameId: string, launch: LaunchConfig) => call<void>("launch_game", { gameId, launch }),
  stopGame: (gameId: string) => call<number>("stop_game", { gameId }),
  runningGames: () => call<RunningGame[]>("running_games"),
  launchTool: (path: string, args?: string) => call<void>("launch_tool", { path, args }),
  openPath: (path: string) => call<void>("open_path", { path }),
  revealPath: (path: string) => call<void>("reveal_path", { path }),
  openUrl: (url: string) => call<void>("open_url", { url }),

  imagesFetch: (request: ImageFetchRequest) => call<ImageFetchResult>("images_fetch", { request }),
  sgdbSearch: (query: string, apiKey: string) => call<SgdbGame[]>("sgdb_search", { query, apiKey }),
  sgdbImages: (sgdbId: number, kind: ImageKind, apiKey: string) => call<SgdbImage[]>("sgdb_images", { sgdbId, kind, apiKey }),
  imageDownload: (url: string, gameId: string, kind: ImageKind) => call<{ path: string; palette?: GamePalette }>("image_download", { url, gameId, kind }),
  imageSetCustom: (gameId: string, kind: ImageKind, sourcePath: string) =>
    call<{ path: string; palette?: GamePalette }>("image_set_custom", { gameId, kind, sourcePath }),
  imagePalette: (path: string) => call<GamePalette>("image_palette", { path }),
  exeIcon: (exePath: string, gameId: string) => call<string | null>("exe_icon", { exePath, gameId }),
  cacheSize: () => call<number>("cache_size"),
  cacheClear: () => call<number>("cache_clear"),

  systemStats: () => call<SystemStats>("system_stats"),
  weather: (lat: number, lon: number, place: string) => call<WeatherNow>("weather", { lat, lon, place }),
  geocode: (query: string, lang: string) => call<GeoPlace[]>("geocode", { query, lang }),

  screenshotsList: (gameId: string, name: string, steamAppId?: string, folder?: string) =>
    call<Screenshot[]>("screenshots_list", { gameId, name, steamAppId, folder }),
  thumbnail: (path: string, size: number) => call<string>("thumbnail", { path, size }),

  saveBackupCreate: (gameId: string, folder: string) => call<SaveBackup>("save_backup_create", { gameId, folder }),
  saveBackupList: (gameId: string) => call<SaveBackup[]>("save_backup_list", { gameId }),
  saveBackupRestore: (gameId: string, backupId: string, folder: string) => call<void>("save_backup_restore", { gameId, backupId, folder }),
  saveBackupDelete: (gameId: string, backupId: string) => call<void>("save_backup_delete", { gameId, backupId }),

  libraryExport: (path: string) => call<void>("library_export", { path }),
  libraryImport: (path: string, mode: "merge" | "replace") => call<ImportReport>("library_import", { path, mode }),
  backupsList: () => call<LibraryBackup[]>("backups_list"),
  backupNow: () => call<LibraryBackup>("backup_now"),
  backupRestore: (file: string) => call<void>("backup_restore", { file }),

  applyNativeSettings: (settings: NativeSettings) => call<void>("apply_native_settings", { settings }),
  overlayToggle: () => call<boolean>("overlay_toggle"),
  traySetRecent: (items: TrayRecent[]) => call<void>("tray_set_recent", { items }),
  updateCheck: () => call<UpdateInfo>("update_check"),
  updateInstall: (setupUrl: string, sha256?: string) => call<void>("update_install", { setupUrl, sha256 }),
};

/** Fehlermeldung für die Anzeige aufbereiten */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}
