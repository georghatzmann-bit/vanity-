# PULSAR – Backend-Vertrag (Tauri-Befehle und Events)

Typen: `app/src/lib/types.ts` (TypeScript) ⇄ `app/src-tauri/src/**/types.rs` / `models.rs` (Rust, `serde(rename_all = "camelCase")`).
Aufrufe aus der Oberfläche: `app/src/lib/api.ts`. Im Browser antwortet `app/src/lib/mock.ts` mit Demo-Daten.
Fehler: Befehle liefern `Err(String)` mit einem **deutschen, verständlichen Satz** (wird direkt angezeigt).

## Grundsätze

- **Ehrlich:** Pulsar misst und optimiert lokal. Keine erfundenen „Ping-Verbesserungen“. Jede Optimierung hat eine ehrliche Wirkungsstufe.
- **Nie abstürzen:** Kein `unwrap()` auf Laufzeitdaten. Netzwerk-Zeitlimits immer setzen.
- **Ohne Adminrechte – außer auf Wunsch:** Pulsar läuft immer als normaler Benutzer. Nur der DNS-Wechsel und die zwei Netzwerk-Optimierungen (`nagle`, `netThrottle`) brauchen Adminrechte. Dafür fragt Windows **einmal pro Aktion** nach (UAC); Pulsar startet sich dann kurz selbst als Admin-Helfer (siehe „Admin-Helfer“), der nur fest erlaubte Änderungen ausführen darf, und beendet sich sofort wieder. Lehnt man ab, ändert sich nichts.
- **Rückgängig:** Jede Änderung an Windows wird vorher gesichert (kv `opt.snapshots`, DNS in kv `net.dnsBackup`) und kann exakt zurückgestellt werden – auch beim Deinstallieren (`Pulsar.exe --revert-all`).
- **Plattform:** Ziel ist Windows 10/11. Unter Linux/macOS (Entwicklung, CI-Tests) gibt es Ersatzwege oder klare Fehlermeldungen („Nur unter Windows verfügbar.“).

## App, Daten, Spiele (Basis)

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
| `net_monitor_start(targets, intervalMs=1000)` | Startet/ersetzt den Live-Monitor (ein Hintergrund-Task). Jeder Takt misst alle Ziele **parallel** und sendet Event **`net://ping`** `MonitorUpdate` (neue Samples + Statistik der letzten 60 Messungen je Ziel). Intervall 250–10000 ms. Leere Zielliste stoppt den Monitor. |
| `net_monitor_stop()` | Stoppt den Monitor |
| `net_regions()` → `Region[]` | Fester Katalog von Rechenzentren weltweit (AWS-Regionen per TCP:443 auf `dynamodb.<region>.amazonaws.com`), mindestens: Frankfurt, Paris, London, Stockholm, Mailand, Irland, Spanien, Zürich, US-Ost, US-Ost 2, US-West, Kanada, São Paulo, Singapur, Tokio, Seoul, Mumbai, Sydney, Bahrain, Kapstadt. IDs stabil (z. B. `aws-eu-central-1`). |
| `net_regions_ping(ids?, count=4)` → `RegionPing[]` | Mehrere Regionen gleichzeitig (max. 8 parallel) |
| `net_game_servers(game)` → `Region[]` | Echte Spielserver: `cs2`/`dota2`/`deadlock` = Valve-Relays aus `https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=…` (pro POP eine Adresse, ICMP), Ergebnis 6 h im Speicher; `lol` = Riot-Ping-Adressen (EUW, EUNE, NA, …), sonst leere Liste |
| `net_traceroute(host, maxHops=30)` → `TraceResult` | ICMP mit steigender TTL (3 Versuche je Station, 1 s Zeitlimit). Sendet je Station Event **`net://trace`** `TraceHop`. `zone`: private Adressen = `lan`, die ersten öffentlichen Stationen bis zum Netz des Anbieters = `isp`, danach `internet`, Ziel = `target`. Rückwärts-DNS nur, wenn schnell (≤ 300 ms). |
| `net_dns_benchmark(rounds=3)` → `DnsResult[]` | Vergleicht Cloudflare (1.1.1.1/1.0.0.1), Google (8.8.8.8/8.8.4.4), Quad9 (9.9.9.9/149.112.112.112), OpenDNS (208.67.222.222/208.67.220.220), AdGuard (94.140.14.14/94.140.15.15), DNS0.eu (193.110.81.0/185.253.5.0), Mullvad (194.242.2.2) und den aktuell eingestellten DNS. Eigene DNS-Anfragen per UDP:53 (Typ A) für steampowered.com, epicgames.com, riotgames.com, cloudflare.com, discord.com; Runde 1 = „neu“ (`uncachedMs`), weitere Runden = „bekannt“ (`cachedMs`, bei `rounds=1` null). Median; `failed` zählt Timeouts/Fehlerantworten. Fortschritt per **`net://dns`** (`total` = Dienste × Domains × Runden). Sortiert nach `uncachedMs`, dann `cachedMs`. |
| `net_dns_current()` → `DnsConfig?` | DNS der Hauptverbindung (Details unter „DNS automatisch einstellen“) |
| `net_dns_apply(provider)` → `DnsConfig` | Stellt den DNS-Dienst `provider` (ID aus der Liste oben) für die Hauptverbindung ein – mit Windows-Abfrage. Ablauf siehe unten. |
| `net_dns_restore()` → `DnsConfig?` | Stellt den gesicherten DNS wieder her (automatisch vom Router oder die vorher fest eingetragenen Server) – mit Windows-Abfrage. |
| `net_adapters()` → `AdapterInfo[]` | Netzwerkadapter (nur aktive, ohne Loopback/virtuelle, wenn erkennbar) |
| `net_wifi()` → `WifiInfo?` | WLAN-Verbindung (Signal, Band, Kanal, Standard, Datenrate) oder `null` |
| `net_speedtest()` → `SpeedResult` | Cloudflare-Speedtest (`speed.cloudflare.com/__down`, `__up`): Ruhe-Latenz (10 Messungen), Download ~8 s mit 4 parallelen Strömen, Upload ~6 s, gleichzeitig Latenz unter Last → Bufferbloat. Note: Anstieg < 5 ms = A+, < 30 = A, < 60 = B, < 200 = C, < 400 = D, sonst F. Fortschritt per **`net://speed`**. Nur ein Test gleichzeitig. |
| `net_speedtest_cancel()` | Bricht einen laufenden Test ab |

## Optimieren (`src/opt/`)

Feste Optimierungen (`TweakId`), Texte in den Übersetzungen. `admin` = Windows fragt nach, `restart` = wirkt erst nach einem Neustart:

| id | Kategorie | Was | Wirkung | admin | restart |
|---|---|---|---|---|---|
| `powerPlan` | power | Energieplan „Höchstleistung“ (bzw. „Ultimative Leistung“, falls vorhanden) per `powercfg` | mittel | – | – |
| `gameMode` | windows | Windows-Spielmodus an (`HKCU\Software\Microsoft\GameBar\AutoGameModeEnabled=1`) | klein | – | – |
| `gameDvr` | windows | Game-Bar-Hintergrundaufnahme aus (`HKCU\System\GameConfigStore\GameDVR_Enabled=0`, `HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR\AppCaptureEnabled=0`) | mittel | – | – |
| `mouseAccel` | input | Mausbeschleunigung aus („Zeigerpräzision verbessern“), sofort wirksam | mittel (Zielen) | – | – |
| `nagle` | network | TCP-Pakete sofort senden und bestätigen („Nagle aus“) für die Hauptverbindung: `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}\TcpAckFrequency=1` und `TCPNoDelay=1` (DWORD). Hilft nur Spielen, die TCP nutzen – die meisten Shooter nutzen UDP. | klein | ja | ja |
| `netThrottle` | network | Netzwerk-Drosselung bei Multimedia aus: `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\NetworkThrottlingIndex=0xFFFFFFFF` (Windows-Standard: 10) | klein | ja | ja |

Zustand lesen geht ohne Adminrechte (auch HKLM). `nagle`: „on“, wenn beide Werte am Schlüssel der Hauptverbindung 1 sind; ohne Hauptverbindung „unknown“. Sicherung wie bei den anderen in kv `opt.snapshots`: `nagle` speichert `adapter` (GUID als Text), `TcpAckFrequency`, `TCPNoDelay`; `netThrottle` speichert `NetworkThrottlingIndex` (fehlende Werte als `null`). „Aus“ ohne Sicherung: `nagle` löscht beide Werte (Windows-Standard = Wert fehlt), `netThrottle` setzt 10. `nagle` wird beim Zurückstellen immer am **gesicherten** Adapter zurückgestellt, auch wenn inzwischen eine andere Verbindung die Hauptverbindung ist.

| Befehl | Verhalten |
|---|---|
| `opt_tweaks()` → `Tweak[]` | Liest den aktuellen Zustand (6 Einträge in der Reihenfolge der Tabelle) |
| `opt_apply(ids, enable)` → `ApplyReport` | Einschalten bzw. zurück auf den gesicherten Originalwert (sonst Windows-Standard). Sichert vor der ersten Änderung den Originalwert in kv `opt.snapshots`. Admin-Optimierungen eines Aufrufs laufen gesammelt über **eine** Windows-Abfrage. Abgelehnt → jede Admin-ID steht in `failed` mit „Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.“, ihre in diesem Aufruf neu angelegten Sicherungen werden wieder entfernt. |
| `opt_revert_all()` | Stellt alle gesicherten Originalwerte wieder her (Admin-Optimierungen gesammelt mit einer Windows-Abfrage) |
| `opt_power_plans()`, `opt_power_set(guid)` | Energiepläne |
| `opt_flush_dns()` | DNS-Zwischenspeicher leeren |
| `boost_start(profile, gameId?, pid?)` → `BoostState` | Energieplan „Höchstleistung“, Priorität des Spiels (`pid` bzw. Prozesse des laufenden Spiels), DNS-Zwischenspeicher leeren. Merkt sich alles für `boost_stop`. Sendet **`boost://state`**. |
| `boost_stop()` → `BoostState` | Stellt den vorherigen Energieplan wieder her |
| `boost_state()` | Aktueller Zustand |

## DNS automatisch einstellen (`src/net/dns.rs`, `src/net/mod.rs`)

**Dienste** (`dns::PROVIDERS`, je Eintrag: id, Name, IPv4 primär/sekundär, IPv6-Adressen, `auto`):

| id | IPv4 | IPv6 | `auto` | Hinweis |
|---|---|---|---|---|
| `cloudflare` | 1.1.1.1, 1.0.0.1 | 2606:4700:4700::1111, 2606:4700:4700::1001 | ja | |
| `google` | 8.8.8.8, 8.8.4.4 | 2001:4860:4860::8888, 2001:4860:4860::8844 | ja | |
| `quad9` | 9.9.9.9, 149.112.112.112 | 2620:fe::fe, 2620:fe::9 | ja | blockiert bekannte Schadseiten |
| `opendns` | 208.67.222.222, 208.67.220.220 | 2620:119:35::35, 2620:119:53::53 | ja | |
| `adguard` | 94.140.14.14, 94.140.15.15 | 2a10:50c0::ad1:ff, 2a10:50c0::ad2:ff | nein | blockiert Werbung – nur von Hand |
| `dns0` | 193.110.81.0, 185.253.5.0 | 2a0f:fc80::, 2a0f:fc81:: | nein | nur von Hand |
| `mullvad` | 194.242.2.2 | 2a07:e340::2 | nein | meist nur verschlüsselt erreichbar – nur von Hand |

`auto` = darf von „Automatisch optimieren“ gewählt werden.

**`DnsConfig`** (Antwort von `net_dns_current`, `net_dns_apply`, `net_dns_restore`):

| Feld | Bedeutung |
|---|---|
| `adapterId`, `adapter` | GUID (`{…}`) und Name der Hauptverbindung |
| `servers` | IPv4-DNS-Server, die Windows gerade benutzt |
| `ipv6Servers` | IPv6-DNS-Server, die Windows gerade benutzt (ohne die veralteten Platzhalter `fec0:0:0:ffff::1/2/3`) |
| `dhcp` | IPv4-DNS kommt automatisch vom Router (in `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}\NameServer` steht nichts) |
| `provider` | ID des bekannten Dienstes, wenn `servers[0]` dessen primäre oder sekundäre IPv4-Adresse ist, sonst `null` |
| `changedByPulsar` | Für diesen Adapter gibt es eine Sicherung in kv `net.dnsBackup` → „Zurückstellen“ möglich |
| `canChange` | Pulsar kann den DNS hier ändern (Windows 10 2004 oder neuer, Adapter-GUID bekannt). Sonst zeigt die Oberfläche die Anleitung zum Selbsteinstellen. |

**Sicherung** kv `net.dnsBackup` = `{ "<adapterId>": { "adapter": Name, "v4": { "dhcp": bool, "servers": [..] }, "v6": { "dhcp": bool, "servers": [..] }, "savedAt": ms } }`. `servers` = die fest eingetragenen Server aus `NameServer` (Tcpip bzw. Tcpip6), `dhcp` = dort steht nichts. Eine vorhandene Sicherung wird nie überschrieben (das Original zählt). Leer → Schlüssel wird gelöscht (`null`).

**`net_dns_apply(provider)`** – Ablauf:
1. `provider` muss in `PROVIDERS` stehen, sonst Fehler „Unbekannter DNS-Dienst: „…“.“
2. Hauptverbindung wie bei `net_dns_current`; keine → „Keine aktive Netzwerkverbindung gefunden.“; `canChange = false` → passende Meldung.
3. **Live-Prüfung ohne Adminrechte:** eine A-Anfrage für `cloudflare.com` an die primäre IPv4-Adresse muss innerhalb von 1,5 s beantwortet werden (`rcode` 0). Sonst „{Name} antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.“ und es passiert nichts.
4. Sicherung anlegen (falls für diesen Adapter noch keine existiert).
5. Admin-Helfer mit einem `DnsOp`: `v4` = IPv4-Adressen des Dienstes; `v6` = IPv6-Adressen des Dienstes **nur**, wenn der Adapter gerade echte IPv6-DNS-Server hat (sonst `null` = IPv6 unverändert).
6. Prüfen (ohne Adminrechte): `NameServer` des Adapters enthält jetzt genau die neuen IPv4-Adressen; sonst „Windows hat die DNS-Änderung nicht übernommen.“
7. DNS-Zwischenspeicher leeren (wie `opt_flush_dns`), dann das neue `DnsConfig` zurückgeben.
Wurde die Sicherung in diesem Aufruf neu angelegt und Schritt 5 abgelehnt oder fehlgeschlagen, wird sie wieder entfernt.

**`net_dns_restore()`**: keine Sicherung → „Pulsar hat den DNS nicht geändert – es gibt nichts zurückzustellen.“ Sonst ein Admin-Helfer-Aufruf mit einem `DnsOp` je gesichertem Adapter (`v4` = `[]` bei `dhcp`, sonst die gesicherten Server; `v6` genauso), prüfen, erfolgreich zurückgestellte Einträge aus der Sicherung entfernen, Zwischenspeicher leeren, aktuelles `DnsConfig` zurückgeben.

**Wichtig (ehrlich):** Ein schnellerer DNS beschleunigt das Nachschlagen von Adressen (Laden, Verbinden, Shop, Matchmaking-Start). Den Ping **im** Spiel ändert er nicht.

## Netzwerk automatisch optimieren

| Befehl | Verhalten |
|---|---|
| `net_auto_optimize(provider?, tweaks)` → `AutoReport` | Alles mit **einer** Windows-Abfrage: DNS auf `provider` (gleiche Prüfungen wie `net_dns_apply`; `null` = DNS bleibt) plus die Optimierungen `tweaks` (Admin-IDs über den Helfer, die anderen direkt). Schlägt die Live-Prüfung fehl, steht das in `dnsError` und die Optimierungen laufen trotzdem. |
| `net_auto_restore()` → `AutoReport` | Stellt mit **einer** Windows-Abfrage den gesicherten DNS und die Sicherungen von `nagle` und `netThrottle` wieder her. Die anderen Optimierungen bleiben (dafür gibt es `opt_revert_all`). |

`AutoReport` = `{ dns: DnsConfig | null, dnsChanged: bool, dnsError: string | null, applied: string[], failed: { id, error }[], declined: bool, restart: bool }` – `dns` = Zustand danach (null außerhalb von Windows), `declined` = Windows-Abfrage abgelehnt (dann wurde nichts mit Adminrechten geändert), `restart` = mindestens eine angewendete Änderung wirkt erst nach einem Neustart.

Die Wahl des besten DNS macht die Oberfläche (`app/src/lib/netauto.ts`, `pickBestDns(results)`): `net_dns_benchmark(3)` → in Frage kommen nur Dienste mit `auto` (cloudflare, google, quad9, opendns), `failed = 0` und beiden Medianen. Punktzahl = 0,7 × `uncachedMs` + 0,3 × `cachedMs` (kleiner ist besser). Verglichen wird mit dem Eintrag `current: true`. Gewechselt wird nur, wenn der beste Kandidat mindestens 15 % **und** mindestens 3 ms besser ist – sonst „Dein DNS ist schon schnell“. Ist der aktuelle DNS selbst einer der Kandidaten und am besten, wird nichts geändert.

## Admin-Helfer (`src/elevate.rs`)

- **Auftrag** `ElevatedTask { dns: DnsOp[], reg: RegOp[] }` (JSON, camelCase), höchstens 4 `dns` und 8 `reg`:
  - `DnsOp { adapter: "{GUID}", v4: string[] | null, v6: string[] | null }` – `null` = unverändert, `[]` = automatisch (DHCP), sonst höchstens 3 Adressen der passenden Familie.
  - `RegOp { key, name, value: u32 | null }` (`null` = Wert löschen). Erlaubt sind **nur**: `SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}` mit `TcpAckFrequency` oder `TCPNoDelay`, und `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile` mit `NetworkThrottlingIndex` (alles unter HKLM, Typ DWORD).
- **Übergabe:** JSON → Hex-Text → ein Argument: `Pulsar.exe --elevated <hex>` (höchstens 16 KiB). Kein `cmd.exe`, keine Skripte, keine temporären Dateien. Der Helfer prüft den Auftrag selbst noch einmal vollständig (GUID-Muster, Adressfamilien, erlaubte Schlüssel), bevor er etwas ändert.
- **Start:** Läuft Pulsar schon mit Adminrechten (`is_elevated()`), wird der Auftrag direkt im eigenen Prozess ausgeführt. Sonst `ShellExecuteExW` mit Verb `runas` auf die eigene Exe (`std::env::current_exe()`), verborgen, mit Prozess-Handle; danach höchstens 60 s auf das Ende warten. Abbruch der Windows-Abfrage (`ERROR_CANCELLED`) → Fehler „Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.“ Es läuft immer nur ein Helfer gleichzeitig.
- **Exit-Codes:** 0 = alles erledigt, 10 = mindestens eine Änderung fehlgeschlagen, 20 = ungültiger Auftrag, 30 = auf diesem System nicht möglich.
- **Im Helfer:** DNS über `SetInterfaceDnsSettings` (iphlpapi, ab Windows 10 2004) – zur Laufzeit per `GetProcAddress` geladen, damit Pulsar auch auf älteren Systemen startet (fehlt die Funktion → Exit 30 bzw. „Dafür braucht es Windows 10 Version 2004 oder neuer.“). `NameServer` = Adressen mit Komma getrennt, leerer Text = automatisch (DHCP); IPv6 mit `DNS_SETTING_IPV6`. Registrierung über `winreg` (HKLM, DWORD).
- **Erkennung:** `Pulsar.exe --elevated …` und `Pulsar.exe --revert-all` werden ganz am Anfang von `run()` erkannt – vor Tauri, Fenster und Einzelinstanz-Sperre. Es öffnet sich kein Fenster.
- Der Aufrufer prüft danach selbst (ohne Adminrechte) durch erneutes Lesen, ob alles angekommen ist – der Exit-Code allein reicht nicht.

## Deinstallieren: `Pulsar.exe --revert-all`

Ohne Fenster: öffnet die Datenbank im normalen Datenordner, stellt den gesicherten DNS und **alle** Sicherungen aus `opt.snapshots` wieder her (normale direkt, Admin-Optimierungen und DNS gesammelt mit einem Admin-Helfer-Aufruf – also höchstens eine Windows-Abfrage, keine, wenn schon Adminrechte bestehen) und entfernt die erledigten Sicherungen. Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben. Der Deinstaller ruft das vor dem Löschen der Dateien auf (nach dem Beenden laufender Pulsar-Prozesse), wartet höchstens 120 s und beendet den Prozess sonst; ein Fehler bricht die Deinstallation nicht ab.
