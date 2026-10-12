# NOVA – Vertrag zwischen Oberfläche und Backend

Typen: siehe `app/src/lib/types.ts` (Quelle der Wahrheit). Rust-Structs spiegeln diese Typen mit
`#[serde(rename_all = "camelCase")]`; optionale Felder sind `Option<T>` mit `#[serde(skip_serializing_if = "Option::is_none", default)]`.
Alle Befehle geben `Result<T, String>` zurück. Fehlertexte sind kurz, verständlich und **deutsch**
(die Oberfläche zeigt sie direkt an). Kein Befehl darf paniken – Fehler immer als `Err(String)`.

Tauri-Befehle werden aus JS mit camelCase-Argumentnamen aufgerufen
(Rust `fn foo(game_id: String)` ⇄ JS `invoke("foo", { gameId })`).

## Datenablage

| Was | Ort |
|---|---|
| Profile-Liste | `<app_data_dir>/profiles.json` → `{ profiles: Profile[], activeId }` |
| Datenbank pro Profil | `<app_data_dir>/profiles/<id>/nova.db` (SQLite, WAL) |
| Automatische DB-Backups | `<app_data_dir>/profiles/<id>/backups/nova-YYYYMMDD-HHMMSS.db` (max. 10) |
| Spielstand-Backups | `<app_data_dir>/profiles/<id>/savegames/<gameId>/<YYYYMMDD-HHMMSS>.zip` |
| Bild-Cache | `<app_local_data_dir>/cache/images/<gameId>/<kind>-<hash8>.<ext>` |
| Vorschaubilder | `<app_local_data_dir>/cache/thumbs/<hash>.jpg` |

`app_data_dir` = `%APPDATA%\com.nova.launcher`, `app_local_data_dir` = `%LOCALAPPDATA%\com.nova.launcher`.

### SQLite-Schema (PRAGMA user_version = 1)

```sql
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE games (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE collections (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE wishlist (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  seconds INTEGER NOT NULL
);
CREATE INDEX idx_sessions_game ON sessions(game_id);
CREATE INDEX idx_sessions_start ON sessions(start);
```

`data` enthält das JSON-Objekt unverändert (Backend validiert nur, dass es ein Objekt mit `id` ist).

## Befehle

### App & Profile
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `app_info` | – | `AppInfo` |
| `profiles_list` | – | `ProfilesState` |
| `profile_create` | `name, color, avatar?` | `Profile` |
| `profile_update` | `profile: Profile` | `()` |
| `profile_delete` | `id` (nicht das aktive, nicht das letzte) | `()` |
| `profile_switch` | `id` | `()` – schließt DB, öffnet DB des Profils |
| `quit_app` | – | beendet die App sauber (Sitzungen speichern) |

### Datenbank
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `db_list` | `table: "games" \| "collections" \| "wishlist"` | `Value[]` |
| `db_put` | `table, id, value` | `()` |
| `db_put_many` | `table, items: { id, value }[]` | `()` (eine Transaktion) |
| `db_delete` | `table, id` | `()` (bei `games` auch dessen Sitzungen) |
| `kv_get` | `key` | `Value \| null` |
| `kv_set` | `key, value` | `()` |

### Spielzeit
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `playtime_stats` | – | `PlayStats[]` (eine Zeile pro Spiel mit Sitzungen) |
| `sessions_range` | `from, to` (ms) | `Session[]` (Sitzungen, die im Bereich beginnen) |
| `sessions_for_game` | `gameId, limit` | `Session[]` neueste zuerst |
| `session_delete` | `id` | `()` |
| `playtime_add` | `gameId, seconds, at` | `Session` (manuell nachgetragene Zeit) |

### Bibliothek scannen
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `scan_library` | `options: ScanOptions` | `ScanResult` |
| `inspect_paths` | `paths: string[]` (Drag & Drop) | `ScannedEntry[]` |
| `paths_exist` | `paths: string[]` | `bool[]` |

### Starten & Spielzeit-Erkennung
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `set_tracked_games` | `games: TrackInfo[]` | `()` – Liste der zu überwachenden Spiele |
| `launch_game` | `gameId, launch: LaunchConfig` | `()` |
| `stop_game` | `gameId` | `u32` Anzahl beendeter Prozesse |
| `running_games` | – | `RunningGame[]` |
| `launch_tool` | `path, args?` | `()` |
| `open_path` | `path` | `()` Ordner/Datei im Explorer öffnen |
| `reveal_path` | `path` | `()` Datei im Explorer markieren |
| `open_url` | `url` | `()` |

Events: `game://started` (`GameStartedEvent`), `game://stopped` (`GameStoppedEvent`), `tray://launch` (`{ gameId }`),
`tray://action` (`{ action: "bigpicture" \| "overlay" \| "dice" }`), `app://second-instance` (`{}`).

### Bilder
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `images_fetch` | `request: ImageFetchRequest` | `ImageFetchResult` |
| `sgdb_search` | `query, apiKey` | `SgdbGame[]` |
| `sgdb_images` | `sgdbId, kind, apiKey` | `SgdbImage[]` |
| `image_download` | `url, gameId, kind` | `{ path, palette? }` |
| `image_set_custom` | `gameId, kind, sourcePath` | `{ path, palette? }` |
| `image_palette` | `path` | `GamePalette` |
| `exe_icon` | `exePath, gameId` | `string \| null` (PNG-Pfad, nur Windows) |
| `cache_size` | – | `u64` Bytes |
| `cache_clear` | – | `u64` freigegebene Bytes |

### System & Widgets
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `system_stats` | – | `SystemStats` |
| `weather` | `lat, lon, place` | `WeatherNow` (Open-Meteo, kein Key) |
| `geocode` | `query, lang` | `GeoPlace[]` |

### Screenshots, Spielstände, Backups
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `screenshots_list` | `gameId, name, steamAppId?, folder?` | `Screenshot[]` neueste zuerst (max. 500) |
| `thumbnail` | `path, size` | `string` Pfad zum JPG-Vorschaubild |
| `save_backup_create` | `gameId, folder` | `SaveBackup` |
| `save_backup_list` | `gameId` | `SaveBackup[]` |
| `save_backup_restore` | `gameId, backupId, folder` | `()` (sichert vorher den aktuellen Stand) |
| `save_backup_delete` | `gameId, backupId` | `()` |
| `library_export` | `path` | `()` JSON-Datei mit allem |
| `library_import` | `path, mode: "merge" \| "replace"` | `ImportReport` |
| `backups_list` | – | `LibraryBackup[]` |
| `backup_now` | – | `LibraryBackup` |
| `backup_restore` | `file` | `()` |

### Native Integration
| Befehl | Argumente | Rückgabe |
|---|---|---|
| `apply_native_settings` | `settings: NativeSettings` | `()` Tray-Verhalten, Overlay-Kürzel |
| `overlay_toggle` | – | `bool` sichtbar? |
| `tray_set_recent` | `items: TrayRecent[]` | `()` |
| `update_check` | – | `UpdateInfo` |
| `update_install` | `setupUrl, sha256?` | `()` lädt Setup, startet `--update`, beendet App |
