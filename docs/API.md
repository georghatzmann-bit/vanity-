# PULSAR – Backend-Vertrag (Tauri-Befehle und Events)

Typen: `app/src/lib/types.ts` (TypeScript) ⇄ `app/src-tauri/src/**/types.rs` / `models.rs` (Rust, `serde(rename_all = "camelCase")`).
Aufrufe aus der Oberfläche: `app/src/lib/api.ts`. Im Browser antwortet `app/src/lib/mock.ts` mit Demo-Daten.
Fehler: Befehle liefern `Err(String)` mit einem **deutschen, verständlichen Satz** (wird direkt angezeigt).

## Grundsätze

- **Ehrlich:** Pulsar misst und optimiert lokal. Keine erfundenen „Ping-Verbesserungen“. Jede Optimierung hat eine ehrliche Wirkungsstufe.
- **Nie abstürzen:** Kein `unwrap()` auf Laufzeitdaten. Netzwerk-Zeitlimits immer setzen.
- **Ohne Admin starten:** Pulsar läuft als normaler Benutzer. Admin-Schritte laufen gebündelt über den Admin-Helfer (eine UAC-Abfrage).
- **Rückgängig:** Jede Änderung an Windows wird vorher gesichert (kv `opt.snapshots`) und kann exakt zurückgestellt werden.
- **Plattform:** Ziel ist Windows 10/11. Unter Linux/macOS (Entwicklung, CI-Tests) gibt es Ersatzwege oder klare Fehlermeldungen („Nur unter Windows verfügbar.“).

## App, Daten, Spiele (aus NOVA übernommen)

| Befehl | Zweck |
|---|---|
| `app_info()` → `AppInfo` | Version, Ordner, Plattform, `isAdmin` |
| `quit_app()` | Sitzungen speichern, beenden |
| `db_list(table)`, `db_put(table,id,value)`, `db_put_many(table,items)`, `db_delete(table,id)` | Tabellen `games`, `reports` (JSON-Objekte mit `id`) |
| `kv_get(key)`, `kv_set(key,value)` | Schlüssel/Wert, z. B. `settings` |
| `playtime_stats()`, `sessions_range(from,to)`, `sessions_for_game(gameId,limit)`, `session_delete(id)` | Spielzeit (der Tracker zeichnet automatisch auf) |
| `scan_library(options)` → `ScanResult` | Steam/Epic/GOG/Startmenü/Ordner durchsuchen |
| `inspect_paths(paths)`, `paths_exist(paths)` | Drag & Drop, Aufräumen |
| `set_tracked_games(games)` | Welche Spiele erkannt werden sollen |
| `launch_game(gameId, launch)`, `stop_game(gameId)`, `running_games()` | Starten, Beenden, laufende Spiele |
| `open_path`, `reveal_path`, `open_url` | Explorer/Browser öffnen |
| `images_fetch(request)` → `ImageFetchResult` | Cover/Hintergrund/Logo/Icon (Steam ohne Schlüssel, per Name, .exe-Icon, SteamGridDB) |
| `image_set_custom(gameId, kind, sourcePath)`, `exe_icon`, `cache_size`, `cache_clear` | Bilder |
| `system_stats()` → `SystemStats` | CPU/RAM/GPU-Last |
| `backups_list()`, `backup_now()`, `backup_restore(file)` | Datenbank-Sicherungen |
| `apply_native_settings(settings)` | Schließen→Tray, Overlay-Kürzel, Sprache |
| `overlay_toggle()` → `bool` | Ping-Overlay ein/aus |
| `tray_set_recent(items)` | Zuletzt gespielt im Tray |
| `update_check()`, `update_install(setupUrl, sha256)` | Updates |

Events: `game://started` `GameStartedEvent`, `game://stopped` `GameStoppedEvent`, `tray://action` `{action}`, `update://progress`.

## Netzwerk (`src/net/`)

| Befehl | Verhalten |
|---|---|
| `net_ping_once(target, count=4)` → `PingStats` | `count` Messungen (Abstand 200 ms), Zeitlimit je Messung 1 s |
| `net_monitor_start(targets, intervalMs=1000)` | Startet/ersetzt den Live-Monitor (ein Hintergrund-Task). Jeder Takt misst alle Ziele **parallel** und sendet Event **`net://ping`** `MonitorUpdate` (neue Samples + Statistik der letzten 60 Messungen je Ziel). Intervall 250–5000 ms. |
| `net_monitor_stop()` | Stoppt den Monitor |
| `net_regions()` → `Region[]` | Fester Katalog von Rechenzentren weltweit (AWS-Regionen per TCP:443 auf `dynamodb.<region>.amazonaws.com`), mindestens: Frankfurt, Paris, London, Stockholm, Mailand, Irland, Spanien, Zürich, US-Ost, US-Ost 2, US-West, Kanada, São Paulo, Singapur, Tokio, Seoul, Mumbai, Sydney, Bahrain, Kapstadt. IDs stabil (z. B. `aws-eu-central-1`). |
| `net_regions_ping(ids?, count=4)` → `RegionPing[]` | Mehrere Regionen gleichzeitig (max. 8 parallel) |
| `net_game_servers(game)` → `Region[]` | Echte Spielserver: `cs2`/`dota2`/`deadlock` = Valve-Relays aus `https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=…` (pro POP eine Adresse, ICMP), Ergebnis 6 h im Speicher; `lol` = Riot-Ping-Adressen (EUW, EUNE, NA, …), sonst leere Liste |
| `net_traceroute(host, maxHops=30)` → `TraceResult` | ICMP mit steigender TTL (3 Versuche je Station, 1 s Zeitlimit). Sendet je Station Event **`net://trace`** `TraceHop`. `zone`: private Adressen = `lan`, die ersten öffentlichen Stationen bis zum Netz des Anbieters = `isp`, danach `internet`, Ziel = `target`. Rückwärts-DNS nur, wenn schnell (≤ 300 ms). |
| `net_dns_benchmark(rounds=5)` → `DnsResult[]` | Vergleicht Cloudflare (1.1.1.1/1.0.0.1), Google (8.8.8.8/8.8.4.4), Quad9 (9.9.9.9/149.112.112.112), OpenDNS (208.67.222.222/208.67.220.220), AdGuard (94.140.14.14/94.140.15.15), Control D (76.76.2.0/76.76.10.0), DNS.WATCH (84.200.69.80/84.200.70.40), und den aktuell eingestellten DNS. Eigene DNS-Anfragen per UDP:53 (Typ A); „bekannt“ = `google.com`, „neu“ = zufällige Subdomain eines großen Dienstes. Median über `rounds`. Fortschritt per **`net://dns`**. Sortiert nach `uncachedMs`. |
| `net_dns_current()` → `DnsConfig?` | DNS der Hauptverbindung |
| `net_dns_apply(primary, secondary?)` | Setzt DNS der Hauptverbindung über den Admin-Helfer; sichert vorher den alten Zustand |
| `net_dns_restore()` | Stellt den gesicherten Zustand wieder her (DHCP oder alte Adressen) |
| `net_adapters()` → `AdapterInfo[]` | Netzwerkadapter (nur aktive, ohne Loopback/virtuelle, wenn erkennbar) |
| `net_wifi()` → `WifiInfo?` | WLAN-Verbindung (Signal, Band, Kanal, Standard, Datenrate) oder `null` |
| `net_speedtest()` → `SpeedResult` | Cloudflare-Speedtest (`speed.cloudflare.com/__down`, `__up`): Ruhe-Latenz (10 Messungen), Download ~8 s mit 4 parallelen Strömen, Upload ~6 s, gleichzeitig Latenz unter Last → Bufferbloat. Note: Anstieg < 5 ms = A+, < 30 = A, < 60 = B, < 200 = C, < 400 = D, sonst F. Fortschritt per **`net://speed`**. Nur ein Test gleichzeitig. |
| `net_speedtest_cancel()` | Bricht einen laufenden Test ab |

## Optimieren (`src/opt/`)

Feste Optimierungen (`TweakId`), Texte in den Übersetzungen:

| id | Was | Admin | Wirkung |
|---|---|---|---|
| `powerPlan` | Energieplan „Höchstleistung“ (bzw. „Ultimative Leistung“, falls vorhanden) | nein | mittel |
| `gameMode` | Windows-Spielmodus an (`HKCU\Software\Microsoft\GameBar\AutoGameModeEnabled=1`) | nein | klein |
| `gameDvr` | Game-Bar-Hintergrundaufnahme aus (`HKCU\System\GameConfigStore\GameDVR_Enabled=0`, `HKCU\…\GameDVR\AppCaptureEnabled=0`) | nein | mittel |
| `mouseAccel` | Mausbeschleunigung aus („Zeigerpräzision verbessern“) – sofort wirksam | nein | mittel (Zielen) |
| `networkThrottling` | Netzwerkdrosselung für Multimedia aus (`NetworkThrottlingIndex=0xFFFFFFFF`) | ja | klein |
| `systemResponsiveness` | Mehr CPU-Zeit für Spiele (`SystemResponsiveness=10`) | ja | klein |
| `nagle` | Nagle-Algorithmus aus auf der Hauptverbindung (`TcpAckFrequency=1`, `TCPNoDelay=1`) | ja | klein |
| `powerThrottling` | Energiedrosselung von Hintergrundprozessen aus | ja | klein |
| `hags` | Hardwarebeschleunigte GPU-Planung (`HwSchMode=2`), Neustart nötig | ja | mittel |

| Befehl | Verhalten |
|---|---|
| `opt_tweaks()` → `Tweak[]` | Liest den aktuellen Zustand aller Optimierungen |
| `opt_apply(ids, enable)` → `ApplyReport` | Schaltet ein (`enable=true`) oder zurück auf Windows-Standard bzw. gesicherten Originalwert. Sichert vor dem ersten Ändern den Originalwert. Admin-Optimierungen werden in **einem** Admin-Helfer-Aufruf erledigt; abgelehnte UAC → `cancelled=true`. |
| `opt_revert_all()` | Stellt alle gesicherten Originalwerte wieder her |
| `opt_power_plans()`, `opt_power_set(guid)` | Energiepläne |
| `opt_flush_dns()` | DNS-Zwischenspeicher leeren |
| `opt_trim_memory()` → `TrimReport` | Arbeitsspeicher von Hintergrundprozessen des Benutzers verkleinern (ehrlich: kleiner Effekt) |
| `opt_processes()` → `ProcInfo[]` | Prozesse des Benutzers (nach Speicher sortiert), Systemprozesse `closable=false` |
| `opt_kill(names)` → geschlossene Namen | Nur `closable` Programme |
| `boost_start(profile, gameId?, pid?)` → `BoostState` | Führt das Profil aus (Energieplan, Spiel-Priorität für `pid` bzw. Prozesse des Spiels, Apps schließen, RAM, DNS-Cache) und merkt sich alles für `boost_stop`. Sendet **`boost://state`**. |
| `boost_stop()` → `BoostState` | Stellt alles zurück (alter Energieplan, geschlossene Apps wieder öffnen, falls gewünscht) |
| `boost_state()` | Aktueller Zustand |

### Admin-Helfer

`Pulsar.exe --elevated <aufgaben.json> --result <ergebnis.json>` wird mit `ShellExecuteExW` und dem Verb `runas` gestartet (eine UAC-Abfrage) und beendet sich danach.
Er führt **nur** eine feste Liste erlaubter Aufgaben aus (bestimmte Registry-Werte, DNS einer Verbindung setzen/zurücksetzen) und prüft jeden Pfad gegen eine Erlaubt-Liste. Ergebnis: JSON mit Erfolg/Fehler je Aufgabe. Läuft Pulsar bereits als Admin, werden die Aufgaben direkt ausgeführt.
