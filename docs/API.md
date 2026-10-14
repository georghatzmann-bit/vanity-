# PULSAR – Backend-Vertrag (Tauri-Befehle und Events)

Typen: `app/src/lib/types.ts` (TypeScript) ⇄ `app/src-tauri/src/**/types.rs` / `models.rs` (Rust, `serde(rename_all = "camelCase")`).
Aufrufe aus der Oberfläche: `app/src/lib/api.ts`. Im Browser antwortet `app/src/lib/mock.ts` mit Demo-Daten.
Fehler: Befehle liefern `Err(String)` mit einem **deutschen, verständlichen Satz** (wird direkt angezeigt).

## Grundsätze

- **Ehrlich:** Pulsar misst und optimiert lokal. Keine erfundenen „Ping-Verbesserungen“. Jede Optimierung hat eine ehrliche Wirkungsstufe.
- **Nie abstürzen:** Kein `unwrap()` auf Laufzeitdaten. Netzwerk-Zeitlimits immer setzen.
- **Ohne Adminrechte – außer auf Wunsch:** Pulsar läuft immer als normaler Benutzer. Nur der DNS-Wechsel und die zwei Netzwerk-Optimierungen (`nagle`, `netThrottle`) brauchen Adminrechte. Dafür fragt Windows **einmal pro Aktion** nach (UAC); Pulsar startet sich dann kurz selbst als Admin-Helfer (siehe „Admin-Helfer“), der nur fest erlaubte Änderungen ausführen darf, und beendet sich sofort wieder. Lehnt man ab, ändert sich nichts.
- **Rückgängig:** Jede Änderung an Windows wird vorher gesichert (kv `opt.snapshots`, DNS in kv `net.dnsBackup`) und kann exakt zurückgestellt werden – auch beim Deinstallieren (`Pulsar.exe --revert-all`). Lässt sich eine Sicherung später nicht sicher zurückstellen, ändert Pulsar nichts. Eine Sicherung wird nur entfernt, wenn nachweislich nichts (mehr) geändert ist. Pulsar meldet nur dann „geändert“ bzw. „zurückgestellt“, wenn die Nachkontrolle das bestätigt.
- **Plattform:** Ziel ist Windows 10/11. Unter Linux/macOS (Entwicklung, CI-Tests) gibt es Ersatzwege oder klare Fehlermeldungen („Nur unter Windows verfügbar.“).

## App, Daten, Spiele (Basis)

| Befehl | Zweck |
|---|---|
| `app_info()` → `AppInfo` | Version, Ordner, Plattform, `isAdmin` |
| `quit_app()` | Sitzungen speichern, beenden |
| `db_list(table)`, `db_put(table,id,value)`, `db_put_many(table,items)`, `db_delete(table,id)` | Tabellen `games`, `reports` (JSON-Objekte mit `id`) |
| `kv_get(key)`, `kv_set(key,value)` | Schlüssel/Wert, z. B. `settings`. `kv_set` lehnt die von Pulsar selbst verwalteten Einträge `net.dnsBackup`, `opt.snapshots` und `opt.recoveryUnknown` ab: „Dieser Eintrag wird von Pulsar selbst verwaltet.“ |
| `playtime_stats()`, `sessions_range(from,to)`, `sessions_for_game(gameId,limit)`, `session_delete(id)` | Spielzeit (der Tracker zeichnet automatisch auf) |
| `scan_library(options)` → `ScanResult` | Steam/Epic/GOG/Startmenü/Ordner durchsuchen |
| `inspect_paths(paths)`, `paths_exist(paths)` | Drag & Drop, Aufräumen |
| `set_tracked_games(games)` | Welche Spiele erkannt werden sollen |
| `launch_game(gameId, launch)`, `stop_game(gameId)`, `running_games()` | Starten, Beenden, laufende Spiele |
| `open_path`, `reveal_path`, `open_url` | Explorer/Browser öffnen |
| `images_fetch(request)` → `ImageFetchResult` | Cover/Hintergrund/Logo/Icon (Steam ohne Schlüssel, per Name, .exe-Icon, SteamGridDB) |
| `image_set_custom(gameId, kind, sourcePath)`, `exe_icon`, `cache_size`, `cache_clear` | Bilder |
| `system_stats()` → `SystemStats` | CPU/RAM/GPU-Last |
| `export_file(path, data)` | Datei schreiben (Roh-IPC; nur `png`, `html`, `csv`, `md`, `txt`, höchstens 10 MiB, nur lokale Pfade) – siehe „Datei-Export“ |
| `backups_list()`, `backup_now()`, `backup_restore(file)` | Datenbank-Sicherungen. Beim Wiederherstellen bleiben `net.dnsBackup`, `opt.snapshots` und `opt.recoveryUnknown` auf dem aktuellen Stand (auch „keine Sicherung“) – sie beschreiben den aktuellen Zustand von Windows, keine Nutzerdaten. Ist die aktuelle Datenbank nicht geöffnet, wird nichts überschrieben: „Die aktuelle Datenbank ist nicht geöffnet – Wiederherstellen ist gerade nicht möglich.“ |
| `apply_native_settings(settings)` | Schließen→Tray, Overlay-Kürzel, Sprache |
| `overlay_toggle()` → `bool` | Ping-Overlay ein/aus |
| `tray_set_recent(items)` | Zuletzt gespielt im Tray |
| `update_check()`, `update_install(setupUrl, sha256)` | Updates |

Events: `game://started` `GameStartedEvent`, `game://stopped` `GameStoppedEvent`, `tray://action` `{action}`, `update://progress`.

**Beschädigte Datenbank (Start der App):** Sie wird als `pulsar.db.broken-<Zeit>` beiseitegelegt und das neueste gültige tägliche Backup eingespielt (sonst eine leere Datenbank). Ein Backup von gestern kennt neuere Sicherungen von Windows-Änderungen nicht oder enthält längst erledigte – deshalb werden `net.dnsBackup` und `opt.snapshots` vorher nur lesend aus der beschädigten Datei geholt und danach genau so eingetragen (auch „keine“). Lassen sie sich nicht lesen, bleibt der Stand des Backups und Pulsar setzt die Marke kv `opt.recoveryUnknown` = `{ at, file }` (Pulsar weiß nicht sicher, ob alles zurückgestellt werden kann; `--revert-all` endet dann mit 1).

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

Weitere Netzwerk-Befehle und das Event **`net://lag`**: siehe „Netzwerk-Verlauf und die 7 Netzwerk-Funktionen (Teil 2)“ am Ende (`net_if_counters`, `net_lag_snapshot`, `net_lag_recent`, `net_session_timeline`, `net_history_hourly`, `net_events_list`, `net_events_summary`, `net_history_clear`, `net_wifi_scan`, `net_wifi_state`, `net_metered`). `running_games()` liefert dort zusätzlich `sessionId`, `net_speedtest` protokolliert jeden erfolgreichen Test.

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

Zustand lesen geht ohne Adminrechte (auch HKLM). `nagle`: „on“, wenn beide Werte am Schlüssel der Hauptverbindung 1 sind; ohne Hauptverbindung „unknown“. Sicherung wie bei den anderen in kv `opt.snapshots`: `nagle` speichert `adapter` (GUID als Text), `TcpAckFrequency`, `TCPNoDelay`; `netThrottle` speichert `NetworkThrottlingIndex` (fehlende Werte als `null`). „Aus“ ohne Sicherung: `nagle` löscht beide Werte (Windows-Standard = Wert fehlt), `netThrottle` setzt 10. `nagle` wird beim Zurückstellen immer am **gesicherten** Adapter zurückgestellt, auch wenn inzwischen eine andere Verbindung die Hauptverbindung ist. Gibt es den Schlüssel des gesicherten Adapters nicht mehr, wird die Sicherung beim Zurückstellen still verworfen (es gibt nichts mehr zurückzustellen). Einschalten wird abgelehnt, solange eine `nagle`-Sicherung für einen **anderen** Adapter besteht: „„Nagle“ ist noch an einer anderen Verbindung eingestellt – bitte erst zurückstellen.“ (so bleibt nie ein Adapter ohne Sicherung verändert).

| Befehl | Verhalten |
|---|---|
| `opt_tweaks()` → `Tweak[]` | Liest den aktuellen Zustand (6 Einträge in der Reihenfolge der Tabelle) |
| `opt_apply(ids, enable)` → `ApplyReport` | Einschalten bzw. zurück auf den gesicherten Originalwert (sonst Windows-Standard). Sichert vor der ersten Änderung den Originalwert in kv `opt.snapshots`. Admin-Optimierungen eines Aufrufs laufen gesammelt über **eine** Windows-Abfrage. Abgelehnt → jede Admin-ID steht in `failed` mit „Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.“, ihre in diesem Aufruf neu angelegten Sicherungen werden wieder entfernt. Scheitert eine Admin-ID im bzw. nach dem Helfer und bleibt ihre Sicherung stehen (Windows kann schon teilweise geändert sein), endet ihr Fehlertext mit „Zurückstellen ist weiter möglich.“. Läuft noch ein Admin-Helfer (siehe „Admin-Helfer“), steht jede Admin-ID mit „Der Admin-Helfer läuft noch – bitte gleich noch einmal versuchen.“ in `failed` und es wird nichts vorbereitet. |
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
| `otherBackups` | Namen der **anderen** Verbindungen mit einer Sicherung in kv `net.dnsBackup` (z. B. das Kabel, während jetzt WLAN die Hauptverbindung ist). Die Oberfläche zeigt dann einen Hinweis und „Zurückstellen“ – `net_dns_restore` stellt alle gesicherten Verbindungen zurück. |
| `canChange` | Pulsar kann den DNS hier ändern (Windows 10 2004 oder neuer, Adapter-GUID bekannt). Sonst zeigt die Oberfläche die Anleitung zum Selbsteinstellen. |

**Sicherung** kv `net.dnsBackup` = `{ "<adapterId>": { "adapter": Name, "v4": { "dhcp": bool, "servers": [..] }, "v6": { "dhcp": bool, "servers": [..] }, "savedAt": ms } }`. `servers` = die fest eingetragenen Server aus `NameServer` (Tcpip bzw. Tcpip6) in üblicher Schreibweise, doppelte Einträge entfernt (Reihenfolge bleibt); `dhcp` = dort steht nichts. Eine vorhandene Sicherung wird nie überschrieben (das Original zählt). Leer → Schlüssel wird gelöscht (`null`). „Genau der gesicherte Zustand“ heißt überall: dieselben Server in **derselben Reihenfolge** (Windows fragt den ersten zuerst – vertauschte Server sind eine echte Änderung).

Pulsar ändert den DNS nur, wenn sich die Sicherung später sicher zurückstellen lässt (gleiche Grenzen wie im Admin-Helfer):
- mehr als 3 fest eingetragene Server einer Familie → „Bei dieser Verbindung sind mehr als 3 DNS-Server fest eingetragen – Pulsar ändert den DNS hier nicht, damit er sich sicher zurückstellen lässt.“
- käme eine 17. gesicherte Verbindung dazu → „Pulsar hat den DNS schon an 16 Verbindungen geändert – bitte erst zurückstellen.“

In beiden Fällen wird nichts gesichert und nichts geändert (keine Windows-Abfrage).

**`net_dns_apply(provider)`** – Ablauf:
1. `provider` muss in `PROVIDERS` stehen, sonst Fehler „Unbekannter DNS-Dienst: „…“.“
2. Hauptverbindung wie bei `net_dns_current`; keine → „Keine aktive Netzwerkverbindung gefunden.“; `canChange = false` → passende Meldung.
3. **Live-Prüfung ohne Adminrechte:** eine A-Anfrage für `cloudflare.com` an die primäre IPv4-Adresse muss innerhalb von 1,5 s beantwortet werden (`rcode` 0). Sonst „{Name} antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein.“ und es passiert nichts.
4. Sicherung anlegen (falls für diesen Adapter noch keine existiert) und vor jeder Änderung speichern – nur, wenn sie sich sicher zurückstellen lässt (siehe oben).
5. Admin-Helfer mit einem `DnsOp`: `v4` = IPv4-Adressen des Dienstes; `v6` = IPv6-Adressen des Dienstes **nur**, wenn der Adapter gerade echte IPv6-DNS-Server hat (sonst `null` = IPv6 unverändert). Fehler → Text des Helfers; besteht danach eine Sicherung für den Adapter (Fehlschlag oder Zeitüberschreitung), endet er mit „Zurückstellen ist weiter möglich.“
6. Prüfen (ohne Adminrechte): `NameServer` des Adapters enthält jetzt genau die neuen IPv4-Adressen und – falls geschickt – IPv6-Adressen, in derselben Reihenfolge; sonst „Windows hat die DNS-Änderung nicht übernommen.“ (besteht danach eine Sicherung, mit „Zurückstellen ist weiter möglich.“).
7. DNS-Zwischenspeicher leeren (wie `opt_flush_dns`), dann das neue `DnsConfig` zurückgeben.

Wurde die Sicherung in diesem Aufruf neu angelegt, wird sie nur entfernt, wenn nachweislich nichts geändert wurde: Windows-Abfrage abgelehnt, oder die Nachkontrolle zeigt am Adapter noch genau den gesicherten Zustand. Bei Zeitüberschreitung des Helfers (er könnte danach noch ändern) oder einem Teilerfolg (z. B. IPv4 gesetzt, IPv6 nicht) bleibt sie. Alle DNS-Abläufe laufen unter derselben Sperre wie die Optimierungen (siehe „Admin-Helfer“); die Live-Prüfung läuft vorher und außerhalb der Sperre.

**`net_dns_restore()`**: keine Sicherung → „Pulsar hat den DNS nicht geändert – es gibt nichts zurückzustellen.“ Sonst:
1. Einträge, deren Adapter-Schlüssel es nicht mehr gibt, still verwerfen. Einträge, deren Adapter schon genau den gesicherten Zustand hat, ohne Helfer entfernen.
2. Ein Admin-Helfer-Aufruf mit einem `DnsOp` je übrigem Adapter. Je Familie wird nur geschickt, was vom gesicherten Zustand abweicht (`[]` bei `dhcp`, sonst die gesicherten Server), sonst `null` – so wird z. B. IPv6 nicht angefasst, wenn Pulsar es nie geändert hat. Jeder `DnsOp` wird einzeln geprüft: ein ungültiger (alte Sicherung) wird nicht geschickt, bleibt stehen und wird gemeldet, blockiert aber die anderen nicht. Höchstens 16 je Aufruf; der Rest bleibt für den nächsten Versuch („Es sind noch weitere Verbindungen übrig – bitte noch einmal zurückstellen.“).
3. Abgelehnt → „Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.“, keine Sicherung wird entfernt.
4. Nach **jedem** anderen Ergebnis (auch Fehlschlag oder Zeitüberschreitung) zuerst prüfen und alle Einträge entfernen, deren Adapter jetzt den gesicherten Zustand hat, Zwischenspeicher leeren. Bleibt danach etwas übrig, ist das ein Fehler (Text des Helfers bzw. „Windows hat die DNS-Änderung nicht übernommen.“, dazu die Hinweise aus Schritt 2) – nie ein falsches „zurückgestellt“. Sonst das aktuelle `DnsConfig` zurückgeben.

**Wichtig (ehrlich):** Ein schnellerer DNS beschleunigt das Nachschlagen von Adressen (Laden, Verbinden, Shop, Matchmaking-Start). Den Ping **im** Spiel ändert er nicht.

## Netzwerk automatisch optimieren

| Befehl | Verhalten |
|---|---|
| `net_auto_optimize(provider?, tweaks)` → `AutoReport` | Alles mit **einer** Windows-Abfrage (keine, wenn nichts zu tun ist): DNS auf `provider` (gleiche Prüfungen und Sicherungsregeln wie `net_dns_apply`; `null` = DNS bleibt) plus die Optimierungen `tweaks` (Admin-IDs über den Helfer, die anderen direkt). Scheitert eine DNS-Prüfung (Live-Prüfung, Sicherung nicht sicher zurückstellbar), steht das in `dnsError`, es wird kein `DnsOp` geschickt und die Optimierungen laufen trotzdem. Nachkontrolle wie bei `net_dns_apply` (IPv4 und, falls geschickt, IPv6, gleiche Reihenfolge): Nur dann ist `dnsChanged = true` – ein Fehler, der nur die Optimierungen betrifft, ändert daran nichts. Sonst steht in `dnsError` der Text des Helfers bzw. „Windows hat die DNS-Änderung nicht übernommen.“, bei bestehender Sicherung mit „Zurückstellen ist weiter möglich.“ (dann kann sich z. B. IPv4 schon geändert haben). Außerhalb von Windows Fehler „Nur unter Windows verfügbar.“ |
| `net_auto_restore()` → `AutoReport` | Stellt mit **einer** Windows-Abfrage (keine, wenn nichts zu tun ist) den gesicherten DNS (wie `net_dns_restore`, Schritte 1–4) und die Sicherungen von `nagle` und `netThrottle` wieder her. Die anderen Optimierungen bleiben (dafür gibt es `opt_revert_all`). `dnsChanged` = mindestens ein Adapter steht danach wieder auf dem gesicherten Zustand; bleibt eine DNS-Sicherung übrig (außer bei Ablehnung), steht der Grund in `dnsError`. Außerhalb von Windows Fehler „Nur unter Windows verfügbar.“ |

`AutoReport` = `{ dns: DnsConfig | null, dnsChanged: bool, dnsError: string | null, applied: string[], failed: { id, error }[], declined: bool, restart: bool }` – `dns` = Zustand danach, `declined` = Windows-Abfrage abgelehnt (dann wurde nichts mit Adminrechten geändert), `restart` = mindestens eine angewendete Änderung wirkt erst nach einem Neustart.

Knöpfe in der Oberfläche: „Netzwerk zurückstellen“ (Automatik-Karte) = `net_auto_restore`. „Alles zurückstellen“ (oben auf der Optimieren-Seite) = `net_auto_restore` (immer; ohne Sicherung fragt Windows nicht und es passiert nichts), danach nur die Optimierungen ohne Adminrechte mit Sicherung per `opt_apply(ids, false)` – also höchstens eine Windows-Abfrage. „Zurückstellen“ im DNS-Tab = `net_dns_restore` (sichtbar bei `changedByPulsar` oder `otherBackups`).

Fehlertexte, die mit „Zurückstellen ist weiter möglich.“ enden, heißen: Windows kann schon (teilweise) geändert sein. Die Oberfläche zeigt dann „Nicht bestätigt“ statt „Nicht geändert“. Die festen Sätze des Backends übersetzt die Oberfläche für Englisch (`backendText` in `app/src/lib/netauto.ts`, Texte unter `backend.*` in den Übersetzungen).

Die Wahl des besten DNS macht die Oberfläche (`app/src/lib/netauto.ts`, `pickBestDns(results)`): `net_dns_benchmark(3)` → in Frage kommen nur Dienste mit `auto` (cloudflare, google, quad9, opendns), `failed = 0` und beiden Medianen. Punktzahl = 0,7 × `uncachedMs` + 0,3 × `cachedMs` (kleiner ist besser). Verglichen wird mit dem Eintrag `current: true` (`net_dns_benchmark` markiert nur den Dienst bzw. Eintrag zum **ersten** aktuellen Server – den fragt Windows zuerst). Fehlt ein solcher Eintrag, ist der aktuelle DNS „nicht gemessen“ (`reason: "notMeasured"`, kein Wechselvorschlag, neutraler Hinweis „Vergleiche erneut“). „Hat nicht geantwortet“ gilt nur, wenn der `current`-Eintrag existiert, aber keine Messwerte hat oder `failed > 0`. Gewechselt wird nur, wenn der beste Kandidat mindestens 15 % **und** mindestens 3 ms besser ist – sonst „Dein DNS ist schon schnell“. Ist der aktuelle DNS selbst einer der Kandidaten und am besten, wird nichts geändert.

## Admin-Helfer (`src/elevate.rs`)

- **Auftrag** `ElevatedTask { dns: DnsOp[], reg: RegOp[] }` (JSON, camelCase), höchstens 16 `dns` und 8 `reg` (auch der größte erlaubte Auftrag bleibt unter 16 KiB):
  - `DnsOp { adapter: "{GUID}", v4: string[] | null, v6: string[] | null }` – `null` = unverändert, `[]` = automatisch (DHCP), sonst höchstens 3 Adressen der passenden Familie.
  - `RegOp { key, name, value: u32 | null }` (`null` = Wert löschen). Erlaubt sind **nur**: `SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{GUID}` mit `TcpAckFrequency` oder `TCPNoDelay`, und `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile` mit `NetworkThrottlingIndex` (alles unter HKLM, Typ DWORD).
- **Übergabe:** JSON → Hex-Text → ein Argument: `Pulsar.exe --elevated <hex>` (höchstens 16 KiB). Kein `cmd.exe`, keine Skripte, keine temporären Dateien. Der Helfer prüft den Auftrag selbst noch einmal vollständig (GUID-Muster, Adressfamilien, erlaubte Schlüssel), bevor er etwas ändert.
- **Start:** Läuft Pulsar schon mit Adminrechten (`is_elevated()`), wird der Auftrag direkt im eigenen Prozess ausgeführt. Sonst `ShellExecuteExW` mit Verb `runas` auf die eigene Exe (`std::env::current_exe()`), verborgen, mit Prozess-Handle; danach höchstens 60 s auf das Ende warten. Abbruch der Windows-Abfrage (`ERROR_CANCELLED`) → Fehler „Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.“ Zeitüberschreitung → „Der Admin-Helfer hat nicht rechtzeitig geantwortet.“ (eigene Fehlerart, Anzeige wie ein Fehler): Der Helfer könnte danach noch etwas ändern, deshalb bleiben alle Sicherungen stehen und Pulsar behält das Prozess-Handle. Solange dieser Helfer noch läuft, startet kein neuer Helfer und kein Ablauf liest Sicherungen (sonst könnte eine Sicherung als „schon zurückgestellt“ verschwinden, kurz bevor der Helfer doch noch ändert): `net_dns_apply`, `net_dns_restore`, `net_auto_optimize` und `net_auto_restore` enden mit „Der Admin-Helfer läuft noch – bitte gleich noch einmal versuchen.“, bei `opt_apply`/`opt_revert_all` steht das bei jeder Admin-ID in `failed`. Es läuft immer nur ein Helfer gleichzeitig.
- **Sperre:** Eine prozessweite Sperre umfasst jeweils den ganzen Ablauf „Sicherungen laden → Admin-Helfer → Nachkontrolle → Sicherungen speichern“ in `opt_apply`, `opt_revert_all`, `net_dns_apply`, `net_dns_restore`, `net_auto_optimize`, `net_auto_restore`, `--revert-all` und `backup_restore`. So arbeitet nie ein zweiter Ablauf mit einem veralteten Stand von `opt.snapshots`/`net.dnsBackup` weiter. Die asynchrone Live-Prüfung läuft außerhalb der Sperre.
- **Exit-Codes:** 0 = alles erledigt, 10 = mindestens eine Änderung fehlgeschlagen, 20 = ungültiger Auftrag, 30 = auf diesem System nicht möglich.
- **Im Helfer:** DNS über `SetInterfaceDnsSettings` (iphlpapi, ab Windows 10 2004) – zur Laufzeit per `GetProcAddress` geladen, damit Pulsar auch auf älteren Systemen startet (fehlt die Funktion → Exit 30 bzw. „Dafür braucht es Windows 10 Version 2004 oder neuer.“). `NameServer` = Adressen mit Komma getrennt, leerer Text = automatisch (DHCP); IPv6 mit `DNS_SETTING_IPV6`. Registrierung über `winreg` (HKLM, DWORD).
- **Erkennung:** `Pulsar.exe --elevated …` und `Pulsar.exe --revert-all` werden ganz am Anfang von `run()` erkannt – vor Tauri, Fenster und Einzelinstanz-Sperre. Es öffnet sich kein Fenster. Gleich danach wird die DLL-Suche des Prozesses auf System32 beschränkt (`SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)`). Das schützt nur später nachgeladene DLLs: Bei einer Installation pro Benutzer können andere Programme unter demselben Konto die Pulsar-Dateien verändern – wer DNS oder die Netzwerk-Optimierungen nutzt, installiert besser nach „Programme“.
- Der Aufrufer prüft danach selbst (ohne Adminrechte) durch erneutes Lesen, ob alles angekommen ist – der Exit-Code allein reicht nicht.

## Deinstallieren: `Pulsar.exe --revert-all`

Ohne Fenster: Gibt es keine Datenbank, endet es sofort mit 0 und legt nichts an. Sonst öffnet es die Datenbank im normalen Datenordner – ohne Wiederherstellung aus einem Backup (das kennt neuere Sicherungen nicht): Lässt sie sich nicht öffnen (z. B. beschädigt), endet es mit 1. Danach stellt es den gesicherten DNS und **alle** Sicherungen aus `opt.snapshots` wieder her (normale direkt, Admin-Optimierungen und DNS gesammelt mit einem Admin-Helfer-Aufruf – also höchstens eine Windows-Abfrage, keine, wenn schon Adminrechte bestehen oder nichts zu tun ist) und entfernt die erledigten Sicherungen. Der DNS-Teil folgt denselben Regeln wie `net_dns_restore` (nach jedem Ergebnis außer Ablehnung erst aufräumen, dann einen Rest melden). Exit-Code 0 = alles zurückgestellt oder nichts zu tun, 1 = etwas ist übrig geblieben, die Datenbank ließ sich nicht öffnen oder die Marke `opt.recoveryUnknown` ist gesetzt (Pulsar weiß nicht sicher, ob alles zurückgestellt ist).

Der Deinstaller ruft das vor dem Löschen der Dateien auf (nach dem Beenden laufender Pulsar-Prozesse) – aber nur, wenn `install.json` die Marke `"revertAll": true` trägt (schreibt das neue Setup beim Installieren). Er wartet höchstens 120 s und beendet den Prozess sonst. Läuft die Deinstallation mit Adminrechten eines **anderen** Windows-Kontos (Standardkonto gibt bei der Windows-Abfrage ein Admin-Konto ein), startet er `--revert-all` nicht – es würde den Datenordner des falschen Kontos lesen – und wertet das wie „nicht alles zurückgestellt“ (siehe `docs/INSTALLER.md`, `--user-data`). Konnte `--revert-all` nicht alles zurückstellen (Exit-Code ≠ 0, Zeitüberschreitung, Startfehler, anderes Konto), läuft die Deinstallation weiter, aber die Pulsar-Daten werden **nicht** gelöscht – auch nicht, wenn „Daten löschen“ gewählt wurde –, damit die Sicherungen erhalten bleiben; der Deinstaller sagt das ehrlich in einer Warnung.

---

# Netzwerk-Verlauf und die 7 Netzwerk-Funktionen (Teil 2)

Gilt für: Lag-Detektiv, Match-Zeitleiste, Pulsar-Kalender, Hör dein Netz, WLAN-Scanner/Raum-Scan, „Warum laggt es?“, Anbieter-Protokoll – und die gemeinsamen Grundlagen „Hauptverbindung und Netz“, „Datenbank v2“ und „Datei-Export“. Alles läuft **ohne Adminrechte**, ändert **nichts** an Windows (keine neuen Optimierungen) und bewertet nur, was Pulsar selbst gemessen hat. Ursachen und Diagnosen sind **Einschätzungen**, keine Gewissheit; Pulsar verspricht nirgends „weniger Ping“. Wo die Messung keine Aussage hergibt, heißt es „unklar“ bzw. „nicht bewertbar“ – nie geraten.

Neue Befehle stehen in `generate_handler!` (`app/src-tauri/src/lib.rs`), in `app/src/lib/api.ts` (TS-Name in Klammern; Teile in `app/src/lib/api/<funktion>.ts`) und als Demo im Demo-Backend (`app/src/lib/mock.ts`, Teile in `app/src/lib/mock/<funktion>.ts`). Neue Texte stehen in `app/src/locales/de.ts` und `en.ts` (Namensräume `lag`, `timeline`, `calendar`, `sonar`, `wifiScan`, `diagnose`, `ispLog`, `history`; Fehlersätze unter `backend.*`; je Namensraum eigene Dateien `locales/<ns>.de.ts`/`<ns>.en.ts`). Jeder neue feste Fehlersatz des Backends kommt in `BACKEND_TEXTS` bzw. `BACKEND_PATTERNS` (`app/src/lib/netauto.ts`), damit `backendText` ihn ins Englische übersetzt.

## Grundlagen für alle 7 Funktionen

### Hauptverbindung, Netz und Verbindungsart (`src/net/link.rs`)

`NetState.link: Mutex<Option<PrimaryLink>>` – zwischengespeichert, damit der Monitor-Takt nie `GetAdaptersAddresses` aufruft:

| Feld | Bedeutung |
|---|---|
| `luid`, `if_index`, `adapter_id` | Hauptverbindung (`RawAdapter` bekommt dafür `luid: u64` aus `IP_ADAPTER_ADDRESSES_LH.Luid.Value` und `if_index`) |
| `kind` | `wifi` \| `ethernet` \| `other` (USB-Tethering, LTE-Stick, unbekannte Adapter) |
| `gateway` | `Option<Ipv4Addr>` (nur IPv4; ein reines IPv6-Gateway gilt als „kein Gateway“ für die Router-Messung) |
| `net_id` | Kennung des Netzes, siehe unten (`""` = unbekannt) |
| `vpn` | Verkehr läuft vermutlich über ein VPN, siehe unten |
| `at` | Zeitpunkt der Ermittlung |

- **Erneuern:** höchstens alle **30 s**, ausgelöst vom Monitor-Hook, ausgeführt per `tauri::async_runtime::spawn_blocking`, nie zwei gleichzeitig (`AtomicBool`). Zusätzlich sofort bei der Umfangsprüfung eines Aussetzers. Außerhalb von Windows: `kind = other`, kein Gateway, `net_id = ""`, `vpn = false`.
- **`net_id`** (ohne Adminrechte): MAC-Adresse des Gateways aus `GetIpNetTable2(AF_INET)` (Eintrag mit `Address = gateway` auf der `InterfaceLuid` der Hauptverbindung, `State` nicht `Unreachable`/`Incomplete`) → die ersten 12 Hex-Zeichen von SHA-256 über `"pulsar-net-v1|" + MAC` (Crate `sha2` ist vorhanden). Ist die MAC nicht lesbar: SHA-256 über `adapter_id + "|" + gateway`. Kein Gateway → `""`. **Bewusst ohne Adapter-GUID** (abweichend vom Prüfvorschlag): Derselbe Router per WLAN und per Kabel muss dasselbe Netz ergeben, sonst ließe sich der WLAN-Anteil eines Anschlusses nicht ausweisen. Die MAC selbst wird nie gespeichert.
- **VPN** (ohne Adminrechte): `vpn = true`, wenn `GetBestInterfaceEx(<IPv4 des Messziels>)` (ohne Ziel: `1.1.1.1`) einen anderen Schnittstellen-Index als die Hauptverbindung liefert, **oder** ein aktiver Adapter (`OperStatus = Up`) mit `IfType` 53 (`IF_TYPE_PROP_VIRTUAL`) oder 131 (`IF_TYPE_TUNNEL`) bzw. einer Beschreibung, die `WireGuard`, `Wintun`, `TAP-Windows`, `OpenVPN`, `NordLynx` oder `AnyConnect` enthält, ein Standard-Gateway hat. Reine Funktion `link::vpn_from(best_index, primary_index, adapters)` mit Fixture-Tests (`link::tests::vpn_detected_by_best_interface`, `…::tunnel_adapter_with_gateway`, `…::tunnel_without_gateway_is_not_vpn`).
- **Getaktete Verbindung** (`src/net/cost.rs`): `net_metered()` (`metered`) → `boolean | null` über `INetworkCostManager::GetCost` (COM, `Win32_Networking_NetworkListManager` – dieses Cargo-Feature kommt neu dazu), in `spawn_blocking` mit eigenem `CoInitializeEx`. `true` bei `NLM_CONNECTION_COST_FIXED`/`VARIABLE` oder gesetztem Roaming-/Limit-Bit, `false` bei `UNRESTRICTED`, sonst bzw. außerhalb von Windows `null`.

### Eigener Datenverkehr von Pulsar („Ruhezeit“)

`NetState.quiet_until: AtomicI64` (ms). `speed::run` setzt beim Start `now + 60 s` und beim Ende (auch Abbruch/Fehler, über den vorhandenen `RunGuard`) `now + 5 s`; `net_wifi_scan(refresh = true)` setzt für die Scan-Dauer + 2 s. Solange `now < quiet_until`: **keine** Ereignisse (`spike`, `slow`, `loss`, `outage`), **keine** Momentaufnahme, keine Ruhe-Messung. Messwerte zählen weiter in Zeitleiste und Stunden-Summen; der Zeitraum wird als Ereignis `quiet` (`detail.reason = "speedtest" | "wifiScan"`) protokolliert, damit Lücken im Protokoll erklärbar bleiben. Ehrlich festgehalten: **Während Pulsars eigenem Speedtest bzw. WLAN-Scan wird nichts protokolliert.**

### Aktuelle Spielsitzung

`NetState.current_session: Mutex<Option<(i64 /*session_id*/, i64 /*started_at*/)>>`. Der **Tracker schiebt** den Wert, der Recorder fragt nicht ab: `Tracker::apply` und `finalize_all` berechnen am Ende aus ihrem Zustand die aktuelle Sitzung (laufen mehrere Spiele: die zuletzt gestartete mit `session_id`; keine → `None`) und geben sie zurück; der Tracker-Thread setzt sie **nach** Freigabe der Tracker-Sperre (gleich neben `emit`). So sind auch nachträglich angelegte oder nach einer Wiederherstellung neu vergebene Sitzungs-IDs abgedeckt. Zusätzlich bekommt `RunningGame` das Feld `session_id: Option<i64>` (TS `sessionId: number | null`) – nur für die Oberfläche.

### Sperr-Reihenfolge und Laufzeit (verbindlich)

- Im **Monitor-Task** (tokio) niemals `tracker.state` oder `core.db` sperren und nie blockierende Systemaufrufe außer den kurzen Zählern (`GetIfEntry2`, CPU-Auffrischung, zusammen < 1 ms).
- Reihenfolge: `recorder` → freigeben → `db`. Nie `db` halten und dann `recorder` oder `tracker` sperren. `link`, `quiet_until`, `current_session` sind eigene kleine Sperren bzw. Atomics, die nie zusammen mit `db` gehalten werden.
- `tokio::spawn`/`spawn_blocking` startet nur der Hook in `monitor.rs` bzw. der jeweilige Befehl – nie die reinen Recorder-Funktionen (so bleiben sie in `#[test]` ohne Laufzeit testbar).

### Datenschutz (alle Funktionen)

- SSIDs und BSSIDs **fremder** Netze werden nie gespeichert, nie exportiert und nie geloggt (kein `eprintln!` mit SSID/BSSID) – nur die Live-Liste im Speicher.
- Gespeichert werden höchstens: die BSSID des **eigenen** Zugangspunkts in kv `wifi.rooms`, abgeleitete Werte in kv `diagnose.last` (eigenes Band, Kanal, RSSI, Empfehlung, Befunde – kein WLAN-Scan, keine Stationsadressen), `net_id` als Hash.
- `net_events.detail` speichert Stationen nur als `[ttl, rtt, zone]` ohne Adressen; öffentliche Adressen gibt es nur in der Live-Anzeige (`net://lag`, `net_lag_recent`).
- Exporte (PNG-Karte, HTML, CSV) enthalten keine SSID, BSSID, MAC oder Stations-IP. Geprüft per vitest (`cardexport.test.ts`, `isplog.test.ts`: kein MAC-, IPv4- oder SSID-Muster der Testdaten im Ergebnis).

## Datenbank v2 (`src/db.rs`, Aufzeichnung `src/net/recorder/`)

**Migration:** `SCHEMA_VERSION = 2`. In `Db::migrate` nach dem v1-Block: Ist `version == 1` und enthält die Datei schon Sitzungen, wird **vorher** eine Kopie `backups/pulsar-vor-v2-<JJJJMMTT-HHMMSS>.db` angelegt (`backup_into`, best effort – Fehler nur loggen). Dann `if version < 2 { tx.execute_batch(SCHEMA_V2); PRAGMA user_version = 2 }` in **einer** Transaktion. Eine v1-Datenbank (auch ein altes Backup beim Wiederherstellen) wird beim Öffnen migriert; `check_backup_db` bleibt unverändert. Die Whitelist `table_name()` wird **nicht** erweitert – die neuen Tabellen haben nur eigene Befehle. **Ehrlich:** Nach dem Update startet eine ältere Pulsar-Version mit dieser Datenbank nicht mehr („stammt aus einer neueren Pulsar-Version“) – zurück geht es nur über die Kopie `pulsar-vor-v2-…`.

```sql
CREATE TABLE IF NOT EXISTS session_samples (
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  chunk_start  INTEGER NOT NULL,           -- ms UTC, Zeit des ersten Messwerts im Block
  target_key   TEXT    NOT NULL,           -- PingTarget.id
  target_label TEXT    NOT NULL,           -- PingTarget.label beim Schreiben
  method       TEXT    NOT NULL,           -- "icmp" | "tcp" (tatsächlich benutzt, siehe effective_method)
  n            INTEGER NOT NULL,           -- Anzahl Messwerte im Block
  data         BLOB    NOT NULL,           -- siehe „Block-Format“
  PRIMARY KEY (session_id, chunk_start)
);
CREATE TABLE IF NOT EXISTS ping_hourly (
  hour_start  INTEGER NOT NULL,           -- ms UTC, auf die volle Stunde abgerundet
  target_key  TEXT    NOT NULL,
  net_id      TEXT    NOT NULL,           -- PrimaryLink.net_id ("" = unbekannt)
  connection  TEXT    NOT NULL,           -- "wifi" | "ethernet" | "other" | "vpn" (vpn hat Vorrang)
  kind        TEXT    NOT NULL,           -- "region" | "server" | "other"
  label       TEXT    NOT NULL,           -- PingTarget.label (zuletzt geschrieben)
  method      TEXT    NOT NULL,           -- "icmp" | "tcp"
  n           INTEGER NOT NULL,           -- Messungen
  lost        INTEGER NOT NULL,           -- davon verloren
  sum_rtt     REAL    NOT NULL,           -- Summe der Antwortzeiten (nur Antworten)
  sum_jitter  REAL    NOT NULL,           -- Summe |rtt_i − rtt_i−1| aufeinanderfolgender Antworten
  n_jitter    INTEGER NOT NULL,           -- Anzahl dieser Differenzen
  max_rtt     REAL,                       -- größte Antwortzeit (NULL = keine Antwort)
  spikes      INTEGER NOT NULL,           -- Ausreißer nach der Live-Ausreißer-Regel
  covered_ms  INTEGER NOT NULL,           -- echte Messzeit, siehe „Datenbasis“
  PRIMARY KEY (hour_start, target_key, net_id, connection)
);
CREATE TABLE IF NOT EXISTS net_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  t            INTEGER NOT NULL,          -- Beginn, ms UTC
  end_t        INTEGER,                   -- Ende (NULL bei spike und speedtest)
  kind         TEXT    NOT NULL,          -- "outage" | "loss" | "slow" | "spike" | "speedtest" | "quiet"
  target_key   TEXT,                      -- NULL bei speedtest und quiet
  target_label TEXT,
  method       TEXT,                      -- "icmp" | "tcp" | NULL
  net_id       TEXT    NOT NULL DEFAULT '',
  connection   TEXT,                      -- wie in ping_hourly
  value        REAL,                      -- Bedeutung je kind, siehe „Anbieter-Protokoll“
  cause        TEXT,                      -- nur spike: LagCause
  scope        TEXT,                      -- nur outage: OutageScope
  session_id   INTEGER,                   -- laufende Spielsitzung oder NULL (kein Fremdschlüssel: Ereignisse bleiben, auch wenn die Sitzung gelöscht wird)
  detail       TEXT                       -- JSON, höchstens 1 KiB, siehe NetEvent
);
CREATE INDEX IF NOT EXISTS idx_net_events_t ON net_events(t);
CREATE INDEX IF NOT EXISTS idx_net_events_kind_t ON net_events(kind, t);
CREATE INDEX IF NOT EXISTS idx_net_events_session ON net_events(session_id);
```

`kind` in `ping_hourly` folgt aus der Ziel-ID: `aws-…` = `region`, `valve-…` und `riot-…` = `server`, sonst `other`.

**Block-Format** (`session_samples.data`, reine Funktionen `encode_chunk`/`decode_chunk` in `recorder/chunk.rs`): Byte 0 = Formatversion `1`, danach je Messwert **9 Byte** Little Endian:

| Feld | Typ | Bedeutung |
|---|---|---|
| `off` | u16 | ms seit `chunk_start` (0–60000), berechnet mit `u16::try_from(t − chunk_start).ok()` – nie per `as` |
| `rtt` | u16 | Antwortzeit × 10, gerundet, höchstens 65534 (= 6553,4 ms); `0xFFFF` = verloren |
| `cpu` | u8 | CPU-Last 0–100 %; `0xFF` = unbekannt |
| `rx` | u16 | empfangener Datenverkehr des Adapters in Mbit/s × 10, höchstens 65534; `0xFFFF` = unbekannt |
| `tx` | u16 | gesendeter Datenverkehr, wie `rx` (Upload-Last, z. B. Cloud-Backup) |

- **Vor** dem Anhängen eines Werts wird geprüft: `t < last_t` (Uhr zurückgestellt) **oder** `t − chunk_start > 60 000` **oder** Ziel/Methode/Sitzung gewechselt → Block schließen, neuer Block ab `t`. Ein Block wird außerdem beim Schreiben geschlossen.
- **Takt unter 1 s:** Gespeichert wird je volle Sekunde **ein** Punkt (Zeit = erster Wert der Sekunde, Ping = Mittel der Antworten, verloren, wenn mehr als die Hälfte verloren ging; CPU/rx/tx = letzter Wert). Die Live-Anzeige ist davon nicht betroffen.
- Ein Block mit falscher Version oder Länge ≠ 1 + 9·n wird beim Lesen übersprungen (nie Absturz).

| Tabelle | Inhalt | Größe (ehrlich gerechnet) | Aufräumen (`Db::cleanup_history(now)`) |
|---|---|---|---|
| `session_samples` | Messwerte des Hauptziels während einer Spielsitzung | 540 B je Minute (1 Punkt/s) → 2 h ≈ 65 KB, auch bei 250 ms Takt (Verdichtung auf 1 s) | nur die **50 neuesten Sitzungen** mit Messwerten, höchstens **90 Tage** und insgesamt höchstens **8 MB** (`SUM(length(data))`; darüber fallen die ältesten Sitzungen heraus). Sitzung gelöscht → `ON DELETE CASCADE` (`foreign_keys=ON`). Der Bericht (`reports`) bleibt. |
| `ping_hourly` | eine Zeile je Stunde, Ziel, Netz und Verbindungsart | ≈ 90 B je Zeile → ≈ 0,8 MB je Jahr und Dauer-Ziel | älter als **400 Tage** löschen |
| `net_events` | Aussetzer, Verlust, langsam, Ausreißer, Speedtests, Ruhezeiten | kompaktes `detail` (Kurzschlüssel, Stationen ohne Adressen) ≈ 250–400 B je `spike`, ≈ 150 B sonst | `spike`: höchstens **10 000** Zeilen und **180 Tage**, ab **30 Tagen** `detail = NULL` (Zeile, Zeit, Ursache und Zählung bleiben). `outage`/`loss`/`slow`/`speedtest`/`quiet`: **365 Tage**, je Art höchstens **20 000** Zeilen (älteste zuerst). Ausreißer-Fluten verdrängen so nie Aussetzer oder Speedtests. |

**Gesamtgröße ehrlich:** typisch 2–6 MB, im ungünstigsten Fall etwa 15 MB (8 MB Rohdaten + 4 MB Ausreißer + Rest). Die Backups (`VACUUM INTO`, bis zu 10) sind **Kopien der ganzen Datei** – im ungünstigsten Fall also bis zu elfmal so viel Platz. Aufgeräumt wird in `Db::open` (neben `cleanup_empty_sessions`) und stündlich im Backup-Thread **vor** `auto_backup_if_due` (`backup.rs`), damit die Kopien klein bleiben.

### Aufzeichnung (`net::recorder::Recorder`, in `NetState.recorder: Mutex<Recorder>`)

Aufteilung in Untermodule (damit mehrere Leute parallel arbeiten können): `recorder/mod.rs` (Kern: Takt, Puffer, Lückenregel, Schreiben), `recorder/chunk.rs` (Block-Format, Match-Zeitleiste), `recorder/hourly.rs` (Stunden-Summen, Kalender), `recorder/spike.rs` (Live-Ausreißer, Momentaufnahme-Anforderung, Lag-Detektiv), `recorder/events.rs` (outage/loss/slow, Anbieter-Protokoll).

**Ein Hook** in `monitor::run`, direkt nach dem Bau von `samples` (vor `app.emit(EVENT_PING, …)`):

```rust
// monitor.rs – einzige Änderung am Monitor
if let Some(core) = app.try_state::<Shared>() {
    let load = core.net.load.lock_safe().sample(now);           // GetIfEntry2 + CPU, < 1 ms, außerhalb der Recorder-Sperre
    let actions = core.net.recorder.lock_safe().ingest(now, interval_ms, &targets, &ips, &samples, &load, ctx);
    hook::run_actions(&app, core.inner().clone(), actions);       // spawn/spawn_blocking: Momentaufnahme, Umfangsprüfung, Schreiben, Link erneuern
}
```

- Signatur: `fn ingest(&mut self, now: i64, interval_ms: u64, targets: &[PingTarget], ips: &[Option<IpAddr>], samples: &[PingSample], load: &LoadSample, ctx: IngestCtx) -> IngestActions`. `IngestCtx` = `{ quiet: bool, session: Option<(i64,i64)>, link: Option<PrimaryLinkLite> }` (vom Hook vorher aus den Atomics/Mini-Sperren gelesen). `IngestActions` = `{ snapshot: Option<SnapshotRequest { dst: Ipv4Addr, target: PingTarget, rtt, baseline, limit, at }>, scope_check: Option<ScopeRequest>, flush_due: bool, refresh_link: bool, lag_update: Option<LagEvent> }`. `ingest` ist rein (keine Ein-/Ausgabe, keine Sperren, kein Spawn).
- `LoadSampler` (`NetState.load`, `src/net/ifstats.rs`): eigene `sysinfo::System`-Instanz (nur `refresh_cpu_usage`), Byte-Zähler per `GetIfEntry2` über die zwischengespeicherte LUID, Ringpuffer (siehe Lag-Detektiv). Das Dashboard-`system_stats` bleibt unberührt.
- **Hauptziel** = `targets[0]` (die Oberfläche schickt genau ein Ziel). Stunden-Summen gibt es für jedes Ziel, Sitzungs-Messwerte und Ereignisse nur für das Hauptziel.
- **Eigenes Fenster:** Der Recorder führt sein eigenes Fenster der letzten 60 Werte des Hauptziels (`RollingWindow` bleibt privat) und leert es, wenn Ziel-ID, Host oder Methode wechseln (neuer `net_monitor_start`) – Test `recorder::tests::window_resets_on_target_change`.
- **Lückenregel (Standby, Ruhezustand, Uhr):** Liegen zwischen zwei Takten mehr als `max(3 × Intervall, 5 s)` oder ist `now < letztes t`, werden offene Ereignisse am letzten `t` geschlossen, der offene Block geschlossen und das Fenster geleert. Die Lücke zählt **weder als Verlust noch als Aussetzer** und auch nicht als Messzeit. Tests `recorder::tests::sleep_gap_is_not_outage`, `…::clock_backwards_starts_new_chunk`.
- **Sitzung:** aus `ctx.session`. Messwerte vor `started_at` gehören nicht zur Sitzung. Die Zeitleiste kappt beim Lesen zusätzlich auf `[sessions.start, sessions.end]`.
- **Einstellungen:** `Recorder::apply_settings(&serde_json::Value)` liest tolerant (`history.record`, `ispLog.slowMs`, `lag.snapshots`; fehlender oder falscher Typ = Standardwert, nie Fehler). Aufgerufen beim ersten Schreiben (kv `settings` im `spawn_blocking`) und sofort in `kv_set("settings", …)` (`library.rs`) – so wirkt `history.record = false` sofort. `history.record = false` → nichts wird in die Datenbank geschrieben, die Puffer werden verworfen; die Live-Anzeige (`net://lag`) läuft weiter.

**Schreiben (Flush):**
1. Auslöser: spätestens alle **60 s** (`flush_due`), `stop_monitor`, vor jedem Lesebefehl dieses Abschnitts, nach jedem protokollierten Speedtest, in `native::finalize`.
2. Unter der Recorder-Sperre die fertigen Daten **herausnehmen** (Blöcke, Stunden-Deltas, neue/geänderte Ereignisse), Sperre freigeben, dann **eine** Transaktion über `core.db.with` (in `spawn_blocking`). Höchstens ein Hintergrund-Flush gleichzeitig (`flush_in_flight: AtomicBool`); Lesebefehle warten auf einen laufenden Flush (`Recorder.write_lock: Mutex<()>` um „herausnehmen + schreiben“), damit nichts doppelt oder gar nicht gezählt wird.
3. **Sitzungs-Blöcke** fremdschlüsselsicher: `INSERT INTO session_samples(...) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM sessions WHERE id = ?1) ON CONFLICT(session_id, chunk_start) DO NOTHING`. Ein Block einer inzwischen gelöschten Sitzung wird so still verworfen, Stunden-Summen und Ereignisse werden trotzdem geschrieben (Test `recorder::tests::orphan_session_does_not_block_flush`).
4. **Stunden-Summen** per Upsert: `ON CONFLICT(hour_start, target_key, net_id, connection) DO UPDATE SET n = n + excluded.n, lost = lost + excluded.lost, sum_rtt = sum_rtt + excluded.sum_rtt, sum_jitter = sum_jitter + excluded.sum_jitter, n_jitter = n_jitter + excluded.n_jitter, spikes = spikes + excluded.spikes, covered_ms = covered_ms + excluded.covered_ms, max_rtt = CASE WHEN max_rtt IS NULL THEN excluded.max_rtt WHEN excluded.max_rtt IS NULL THEN max_rtt ELSE max(max_rtt, excluded.max_rtt) END, kind = excluded.kind, label = excluded.label, method = excluded.method` (SQLites `max(a, NULL)` wäre NULL).
5. **Offene Ereignisse** (`spike` im 10-s-Fenster, `loss`/`slow` mit Folgeminuten, laufender `outage`, `quiet`): beim ersten Flush per `INSERT` mit dem aktuellen Stand (`end_t`, `value`, `detail.count`) angelegt; der Recorder merkt sich `last_insert_rowid`. Jeder weitere Flush aktualisiert per `UPDATE net_events SET end_t=?, value=?, scope=?, detail=? WHERE id=?`. Geschlossen ist es erst danach bzw. beim Stopp/Beenden mit dem letzten Stand. Kein Duplikat, keine falschen Zahlen (Test `recorder::tests::open_event_written_then_updated`).
6. Schlägt das Schreiben fehl, werden die herausgenommenen Daten **vorne** wieder eingereiht; höchstens 10 Minuten bleiben im Speicher, danach wird das Älteste verworfen (nie Absturz, nie `unwrap`). Bei einem Absturz gehen höchstens die letzten 60 s verloren.
7. **Datenbank-Epoche:** `Recorder.epoch: u64`. `backup::restore_db` ruft vor `copy_over` `Recorder::discard_session_data()` auf (verwirft gepufferte Blöcke und gemerkte rowids, erhöht die Epoche); Daten mit alter Epoche werden nie geschrieben – nach einer Wiederherstellung können Sitzungs-IDs neu vergeben sein. Ebenso, wenn der Tracker eine Kurz-Sitzung (< 10 s) löscht (`finalize`): Blöcke dieser Sitzung verwerfen.

**Stopp und Beenden:**
- `NetState::stop_monitor()` (synchron, auch bei jedem Zielwechsel in `net_monitor_start` aufgerufen) meldet nur `recorder.on_stop(now)` (offene Ereignisse und Block schließen) und plant den Flush per `tauri::async_runtime::spawn_blocking`, **ohne** zu warten.
- `native::finalize` (läuft bei `quit_app`, beim Beenden über den Infobereich und bei `RunEvent::Exit` – also allen Beenden-Wegen) in dieser Reihenfolge: `core.net.stop_monitor()` → `core.net.flush_now(core)` synchron (Main-Thread, erlaubt) → `opt::shutdown` → `tracker.shutdown` → `db.replace(None)`.

**Datenbasis (ehrlich):** Gemessen wird nur, solange Pulsar läuft **und** der Live-Monitor an ist. `covered_ms` = Summe der echten Abstände zwischen aufeinanderfolgenden Messungen eines Ziels, je Abstand höchstens `2 × Intervall` (Lücken zählen nicht), zugeordnet der Stunde der späteren Messung. Angezeigt wird überall „{hours} Stunden Messzeit an {days} Tagen“ (`hours` = Σ`covered_ms` / 3 600 000, auf 0,1 gerundet). Eine **Messstunde** (für Tage, Fächer, Tageswerte) ist eine Zeile bzw. Stundengruppe mit `covered_ms >= 30 min`. Tests `recorder::tests::covered_ms_caps_gaps` (250 ms, 1 s, 10 s Takt).

| Befehl | Verhalten |
|---|---|
| `net_history_clear(scope)` (`historyClear`) → `number` | Löscht Messverlauf: `scope = "events"` nur `net_events`, `"all"` alle drei Tabellen. Leert **zuerst** den passenden Puffer des Recorders (bei `events` nur die Ereignisse) und vergisst gemerkte rowids, dann `DELETE`. Liefert die Zahl gelöschter Zeilen. Anderer Wert → „Unbekannter Bereich.“ Die Berichte (`reports`) bleiben. |

Lesebefehle: `net_session_timeline` (Match-Zeitleiste), `net_history_hourly` (Pulsar-Kalender), `net_events_list` und `net_events_summary` (Anbieter-Protokoll, Ausreißer). Zeiträume (`from`, `to`, ms UTC) müssen `from <= to` und höchstens 400 Tage umfassen, sonst „Ungültiger Zeitraum.“ Alle schreiben zuerst den offenen Puffer.

**`NetEvent`** (gemeinsamer Ereignistyp):

| Feld | Bedeutung |
|---|---|
| `id` | laufende Nummer |
| `t`, `endT` | Beginn und Ende (ms UTC); `endT = null` bei `spike` und `speedtest` |
| `kind` | `"outage"` \| `"loss"` \| `"slow"` \| `"spike"` \| `"speedtest"` \| `"quiet"` |
| `targetKey`, `targetLabel`, `method` | Messziel und Messart (`"icmp"` \| `"tcp"`), bei `speedtest`/`quiet` `null` |
| `netId`, `connection` | Netz und Verbindungsart (`"wifi"` \| `"ethernet"` \| `"other"` \| `"vpn"` \| `null`) |
| `value` | siehe „Anbieter-Protokoll“ |
| `cause` | nur `spike`: `LagCause`, sonst `null` |
| `scope` | nur `outage`: `OutageScope` (`"pc"` \| `"homeNetwork"` \| `"internet"` \| `"targetOnly"` \| `"unknown"`), sonst `null` |
| `sessionId` | Spielsitzung oder `null` |
| `detail` | geparstes JSON oder `null`. `spike` = `{ count, baseline, limit, cpuHigh, reasons, snap }` mit `snap = { conn, vpn, hops: [ttl, rtt \| null, zone \| null][], gw, gwB, tgt, rssi, sig, rx, tx, cpu }` · `loss` = `{ lost, n }` · `slow` = `{ threshold, minutes }` · `outage` = `{ checks: { link, gw, ext } }` · `speedtest` = `SpeedResult` + `{ connection, localMbps }` · `quiet` = `{ reason }` |

`detail` über 1 KiB: erst `snap.hops` kürzen, dann `snap` weglassen – nie zu ungültigem JSON abschneiden (Test `recorder::tests::detail_capped_1kib`).

**Tests (cargo):** `db::tests::schema_version_and_wal` (erwartet jetzt 2), `db::tests::migrates_v1_to_v2` (vorhandene v1-Datei mit Sitzungen → v2, Daten bleiben, Kopie `pulsar-vor-v2-*` existiert), `db::tests::samples_cascade_on_session_delete`, `db::tests::history_cleanup_rules` (50 Sitzungen/90 Tage/8 MB; 400 Tage; Ausreißer-Flut mit 15 000 `spike` → Aussetzer und Speedtests bleiben, `detail` ab 30 Tagen `NULL`), `db::tests::hourly_upsert_adds_up` (inkl. NULL-Fälle bei `max_rtt`), `recorder::tests::chunk_roundtrip` (inkl. Verlust, CPU/rx/tx unbekannt, Kappung bei 6553,4 ms), `…::bad_chunk_is_skipped`, `…::chunk_closes_after_60s_or_target_change`, `…::sub_second_interval_stores_1s_points`, `…::flush_writes_one_transaction`, `…::record_off_writes_nothing`, `…::orphan_session_does_not_block_flush`, `…::open_event_written_then_updated`, `…::flush_failure_requeues_max_10min`, `…::restore_epoch_discards_buffer`, `…::history_clear_empties_buffer`, `…::sleep_gap_is_not_outage`, `…::clock_backwards_starts_new_chunk`, `…::covered_ms_caps_gaps`, `…::window_resets_on_target_change`, `…::detail_capped_1kib`, `…::no_events_during_own_speedtest`, `…::no_events_during_wifi_scan`. **Selbsttest:** Schritt `messwerte-speichern` gegen eine **temporäre** Datenbank (`Db::open(temp_dir/pulsar-selftest-<zeit>.db)` mit eigenem Recorder, danach gelöscht) – feste Testwerte landen nie im echten Kalender oder Protokoll.

**Wichtig (ehrlich):** Der Verlauf ist nur so vollständig wie die Zeit, in der Pulsar lief und gemessen hat. Lücken sind Lücken – Pulsar füllt sie nicht auf und rechnet nichts hoch. Gespeichert wird nur lokal; nichts verlässt den PC.

## Datei-Export (`src/export.rs`)

| Befehl | Verhalten |
|---|---|
| `export_file(path, data)` (`exportFile(path, bytes: Uint8Array)`) → `()` | Schreibt die Bytes nach `path`. **Übertragung als Roh-IPC** (`invoke("export_file", bytes, { headers: { "x-pulsar-path": encodeURIComponent(path) } })`; Rust: `fn export_file(request: tauri::ipc::Request<'_>) -> CmdResult<()>` mit `InvokeBody::Raw`) – kein JSON-Zahlen-Array. Prüfungen in dieser Reihenfolge: Größe höchstens **10 MiB** (10 485 760 Byte, geprüft an der Länge des Rohkörpers), sonst „Datei ist zu groß.“; Endung nur `png`, `html`, `csv`, `md`, `txt` (Groß-/Kleinschreibung egal), sonst „Dateityp nicht erlaubt.“; Pfad: absolut, mit Dateinamen, kein `:` außer an Position 1 (Laufwerk; schließt NTFS-Datenströme wie `x.txt:y.png` aus), kein Präfix `\\?\`, `\\.\` oder `\\` (Geräte- und Netzwerkpfade), kein reservierter Name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, auch mit Endung), der Ordner existiert (`parent.is_dir()`), sonst „Ungültiger Speicherort.“ Geschrieben wird mit einer **eigenen** Funktion (kein `util::write_atomic`, das Ordner anlegt): temporäre Datei `.<name>.<zufall>.tmp` im Zielordner, `sync_all`, dann umbenennen; eine vorhandene Datei wird ersetzt (der Speichern-Dialog hat schon gefragt). Ein-/Ausgabefehler → „Datei konnte nicht gespeichert werden: {value}“. Keine Adminrechte, kein `plugin-fs`, keine neue Capability. |

Ablauf in der Oberfläche (`app/src/lib/exportfile.ts`, `exportBytes(defaultName, filter, bytes)` und `exportText(defaultName, filter, text)` mit `TextEncoder`, UTF-8; CSV mit BOM):
1. `saveFile(defaultName, [filter])` aus `lib/dialog.ts` öffnet den Windows-Speichern-Dialog; Abbruch → nichts passiert, kein Fehler.
2. `api.exportFile(path, bytes)`; danach Toast „Gespeichert“ mit Knopf „Im Ordner zeigen“ (`reveal_path`).
3. **Demo/Browser:** kein Dialog, sondern Download über einen Blob-Link mit `<a download>` (Dateiname = `defaultName`); `export_file` im Demo-Backend tut dasselbe mit dem Dateinamen aus `path`.

Dateinamen: `pulsar-match-<spiel>-<JJJJ-MM-TT-HHMM>.png`, `pulsar-anbieter-protokoll-<von>_bis_<bis>.html` bzw. `.csv` (`<spiel>` = Name in Kleinbuchstaben, nur `a–z`, `0–9`, `-`, höchstens 40 Zeichen).

**Tests:** cargo `export::tests::rejects_exe_and_no_extension`, `…::extension_case_insensitive`, `…::rejects_too_large`, `…::rejects_relative_or_missing_dir`, `…::rejects_ads_unc_device_reserved`, `…::writes_atomically_and_replaces`, `…::tmp_name_never_hits_user_file` (Prüfung der Pfadregeln über die reine Funktion `check_path(&str) -> Result<PathBuf, &'static str>`); vitest `exportfile.test.ts` (Dateinamen, Slug, Filter). **Selbsttest:** Schritt `export-datei` (in den Temp-Ordner schreiben, Datei existiert mit gleichem Inhalt, `.exe` wird abgelehnt).

**Wichtig (ehrlich):** Der Befehl schreibt nur die erlaubten Dateitypen, aber an jeden lokalen Ort, an dem der angemeldete Benutzer schreiben darf – die Oberfläche ruft ihn nur mit dem Pfad aus dem Speichern-Dialog auf.

## Lag-Detektiv (`src/net/lag.rs`, `src/net/ifstats.rs`, `src/net/quickhops.rs`, `src/net/recorder/spike.rs`)

**Zweck:** Bei jedem Ping-Ausreißer sofort eine Momentaufnahme (Ziel noch einmal, erste Stationen der Route, Router, WLAN-Signal, Datenverkehr des Adapters, CPU-Last) machen und daraus eine **eingeschätzte** Ursache ableiten – live und in den Berichten. Lässt sich die Ursache nicht sauber feststellen, heißt sie „unklar“.

**Ausreißer-Regel** (identisch zu `countSpikes` in `app/src/lib/grade.ts`; in Rust `lag::spike_limit`/`lag::count_spikes`/`lag::is_live_spike`):
- `ok` = alle Messwerte mit Antwort, `base` = Median von `ok` (gerade Anzahl → Mittel der beiden mittleren), `limit = max(2 × base, base + 40)`.
- Ein Wert ist ein Ausreißer, wenn `rtt > limit` (echt größer). Verluste sind nie Ausreißer.
- **Live:** Fenster = die letzten höchstens 60 Werte des Hauptziels **einschließlich** des neuen Werts; beurteilt wird erst ab **10** Antworten im Fenster. In TS gleichlautend `isLiveSpike(window: (number|null)[]): boolean` in `lib/grade.ts` (für „Hör dein Netz“).
- Gleiche Prüfdaten in beiden Sprachen: `app/src/lib/fixtures/spikes.json` = `{ count: [{ name, rtts, limit, spikes }], live: [{ name, window, spike }] }`, gelesen von vitest (`grade.test.ts`) und cargo per `include_str!("../../../src/lib/fixtures/spikes.json")` (`lag::tests::spike_rule_matches_fixtures`, `lag::tests::live_rule_matches_fixtures`). Pflichtfälle: leer, nur Verlust, ungerade/gerade Anzahl, Wert genau auf `limit`, kleiner Grundwert (`+40` greift: 20 → 60), großer Grundwert (`×2` greift: 50 → 100), Verluste gemischt; live: 9 Antworten (nie), 10 Antworten, Fenster > 60 (nur die letzten 60 zählen).

| Befehl | Verhalten |
|---|---|
| `net_if_counters()` (`ifCounters`) → `IfCounters?` | Byte-Zähler der Hauptverbindung über `GetIfEntry2` (`MIB_IF_ROW2 { InterfaceLuid: NET_LUID_LH { Value: luid }, ..Default::default() }`, LUID aus `PrimaryLink`; ohne Adminrechte). `null` ohne Hauptverbindung, bei Fehler (z. B. `ERROR_FILE_NOT_FOUND`, Adapter weg – dann beginnt der Ringpuffer neu) und außerhalb von Windows. Synchron und kurz (kein Netz). |
| `net_lag_snapshot(target: PingTarget)` (`lagSnapshot`) → `LagCheck` | Momentaufnahme auf Wunsch (Selbsttest, Schritt `router` von „Warum laggt es?“). Namensauflösung höchstens **300 ms** (sonst ohne Ziel- und Stationsmessung), danach derselbe Ablauf wie beim Ausreißer mit `limit = null` (Ziel nur gemessen, nicht bewertet). Fehlende Teile bleiben `null` → eher `unknown`; **nie** ein Fehler. |
| `net_lag_recent()` (`lagRecent`) → `LagEvent[]` | Die letzten höchstens 20 Ausreißer-Ereignisse seit dem Start von Pulsar (aus dem Speicher, neueste zuerst) – damit die Anzeige nach dem Neuladen des Fensters nicht leer ist. |

Event **`net://lag`** `LagEvent` – einmal, sobald die Momentaufnahme fertig ist (≤ 1,5 s nach dem Ausreißer), und bei `count > 1` ein zweites Mal am Ende des 10-s-Fensters mit demselben `at`/`targetId` und dem endgültigen `count` (die Oberfläche ersetzt per `at` + `targetId`).

**Ablauf beim Ausreißer** (vom Hook per `tauri::async_runtime::spawn`, der Monitor-Takt wartet nie darauf; ganze Momentaufnahme in `tokio::time::timeout(1500 ms)`, verspätete Teilergebnisse werden verworfen – ICMP-Threads laufen höchstens 600 ms weiter):
1. **Drosselung:** höchstens **eine Momentaufnahme je 10 s** und nie zwei gleichzeitig; keine während der Ruhezeit (`quiet_until`). Weitere Ausreißer innerhalb dieser 10 s erhöhen nur `count` (ein `spike`-Eintrag in `net_events` je 10 s).
2. Gleichzeitig, alles mit Zeitlimit, Ziel = die vom Monitor schon aufgelöste IPv4 (`SnapshotRequest.dst`; keine neue Namensauflösung):
   - **Ziel erneut:** 3 Messungen im Abstand von 100 ms mit derselben Methode und demselben Zeitlimit wie der Monitor (`ping::probe`) → `targetMs` = Median der Antworten (`null` ohne Antwort), `targetLost` = Zahl der Verluste.
   - **Teilroute** `quickhops::quick_hops(dst, 3, 600 ms)`: TTL 1, 2, 3 **parallel**, je 2 ICMP-Echos per `spawn_blocking(icmp::send_echo(dst, Some(ttl), 600 ms))`, ohne Reverse-DNS; `rtt` = kleinere Antwort. Zonen nach der **Zonenregel der Teilroute** (unten). `trace::win::run` und `ZoneTracker` bleiben unverändert. Außerhalb von Windows und bei IPv6 → leere Liste.
   - **Router-Ping:** 2 ICMP-Echos (ohne TTL) an `PrimaryLink.gateway`, 600 ms (ICMP, weil TCP auf einen geschlossenen Port als Verlust zählt). Antwortet das Gateway nicht, aber TTL 1, gilt TTL 1 als Router-Wert.
   - **WLAN:** nur bei `kind = wifi`: `adapters::wifi_state()` (siehe WLAN-Scanner). Gesperrt (24H2-Standortsperre) → `wifi = null`, `wifiState = "locked"`, Reason `wifiLocked`.
   - **Datenverkehr und CPU:** aus dem Ringpuffer bzw. der eigenen `sysinfo`-Instanz (kein neuer Aufruf).
3. Ursache bestimmen (unten), `LagEvent` senden, für die Datenbank vormerken.

**Zonenregel der Teilroute** (reine Funktion `quickhops::zones(addrs: &[Option<IpAddr>], gateway) -> Vec<Option<Zone>>`; gleiche Regel in TS `lib/zones.ts` für `routeJump`, gemeinsame Prüfdaten `app/src/lib/fixtures/zones.json`): Stationen in TTL-Reihenfolge.
- Gateway-Adresse oder TTL 1 mit privater Adresse → `lan`.
- `100.64.0.0/10` → `isp` mit `cgnat = true` (Anzeige „Anbieter (CGNAT)“).
- private Adresse **nach** der ersten öffentlichen oder CGNAT-Station → `isp` (`cgnat = true`).
- private Adresse hinter dem Gateway, aber vor jeder öffentlichen/CGNAT-Station (doppeltes NAT: eigener Router hinter dem Anbieter-Router, Mesh) → `lan`.
- die ersten 3 öffentlichen Stationen → `isp`, danach `internet`; das Ziel → `target`.
- stumme Station → Zone `null` (in der Oberfläche „keine Antwort“, ohne Zone).
Tests `quickhops::tests::zones_in_ttl_order` (normal, CGNAT bei TTL 2, doppeltes NAT 192.168.178.1 → 192.168.0.1 → 100.64.x, stumme TTL 1), vitest `zones.test.ts` mit denselben Fixtures.

**Ringpuffer Datenverkehr (`ifstats`):** In jedem Monitor-Takt wird der Zähler gelesen und mit Zeit gespeichert; **zeitbegrenzt**: Einträge der letzten **6 Minuten**, höchstens 1 440 Stück. `Mbit/s = Δbytes × 8 / Δt / 1 000 000`. „Datenverkehr vor dem Ausreißer“ = Zähler-Differenz über das Fenster `max(3 s, die letzten 2 Einträge)`, nur mit `Δt >= 0,5 s`, sonst `null`. Sinkt ein Zähler, wechselt die Hauptverbindung oder scheitert `GetIfEntry2`, beginnt die Reihe neu (kein Wert statt eines falschen). Nur die **Summe des Adapters** („Datenverkehr auf diesem PC“), keine Aufteilung nach Programmen (die bräuchte ETW bzw. Adminrechte). Zusätzlich liefert `GetIfEntry2` `OperStatus`/`MediaConnectState` (für die Umfangsprüfung von Aussetzern).

**Grundwerte (Ruhe-Messung):** Läuft der Monitor, ist keine Ruhezeit und gab es 10 s lang keinen Ausreißer, macht der Detektiv höchstens **alle 60 s** dieselbe Momentaufnahme ohne Anlass (6 + 2 ICMP-Pakete, ohne Zielmessung). Grundwert je TTL, Router und WLAN-Signal = Median der letzten 5 Ruhe-Messungen (je TTL neu, wenn sich die Adresse ändert). Grundwert Datenverkehr = Median der Ringpuffer-Werte der letzten 5 Minuten ohne die letzten 10 s. **Bezug** für „Leitung voll“ = letzter Speedtest der letzten 30 Tage, sonst die eingetragenen Maximal-Werte (`ispLog.contractDownMbps`/`contractUpMbps`), sonst keiner. Der Bezug liegt im Recorder (einmal beim ersten Schreiben aus `net_events` geladen, nach jedem protokollierten Speedtest aktualisiert) – keine Datenbankabfrage aus der Momentaufnahme.

**Ursachen-Entscheidung** (`lag::classify_cause(&LagInput) -> (LagCause, Vec<Reason>)`, rein, erste passende Zeile gewinnt):

Begriffe: `gw` = Router-Wert, `gwBase` = Grundwert. **Router auffällig** = (`gwBase` vorhanden und (`gw` fehlt oder `gw > max(2 × gwBase, gwBase + 15)`)) oder (`gwBase` fehlt und `gw > 30`). **Router unauffällig** = `gw` vorhanden und nicht auffällig (ein Router, der nie geantwortet hat, ist „nicht bewertbar“). **Ziel noch gestört** = `targetLost >= 2` oder `targetMs > limit`. **Ziel wieder normal** = mindestens 2 Antworten und `targetMs <= limit`. Ohne `limit` (Momentaufnahme auf Wunsch) oder ohne Zielmessung (keine IPv4, Namensauflösung zu langsam) ist das Ziel „nicht prüfbar“ – die Zeilen 2, 6 und 7 greifen dann nicht (`noTargetCheck`). **Anbieter auffällig** = eine Station k mit `zone = isp`, Antwort und Grundwert hat `rtt > Grundwert + 30` **und die Verzögerung bleibt bestehen**: jede spätere antwortende Station mit Grundwert liegt über ihrem Grundwert + 20 und das Ziel ist noch gestört (wie „bleibt erhöht“ bei `routeJump`; eine einzelne langsame Station ist meist nur nachrangig beantwortetes ICMP). **Anbieter unauffällig** = mindestens eine `isp`-Station mit Antwort und Grundwert, keine auffällig nach dieser Regel.

| # | Bedingung | `cause` | `reasons` |
|---|---|---|---|
| 0 | Momentaufnahmen aus · VPN aktiv (`viaVpn`) | `unknown` | `snapshotsOff` · `vpnActive` |
| 1 | `rxMbps > 0,7 × Bezug-Download` oder `txMbps > 0,7 × Bezug-Upload`; ohne Bezug: `rxMbps + txMbps > max(5 × Grundwert, 20)` (Datenverkehr **vor** dem Ausreißer) | `localTraffic` | `trafficHigh` |
| 2 | Ziel wieder normal (der Ausreißer war schon vorbei) | `unknown` | `spikeGone` (+ ggf. `rssiLow`/`signalDrop` als Zusatz) |
| 3 | Hauptverbindung WLAN und (Router auffällig oder ((`rssi < −70 dBm` oder Signal ≤ Grundwert − 15) und Router **nicht** unauffällig)) | `wifi` | `gatewaySlow` / `gatewayLost` / `rssiLow` / `signalDrop` |
| 4 | Hauptverbindung **Ethernet** und Router auffällig | `router` | `gatewaySlow` / `gatewayLost` |
| 5 | Hauptverbindung `other` und Router auffällig | `unknown` | `connectionOther` |
| 6 | Router unauffällig und Anbieter auffällig (Ziel noch gestört) | `isp` | `ispHopSlow` + `lineBusyPossible`, wenn der letzte Speedtest Bufferbloat ≥ 60 ms hatte oder es keinen gibt (+ ggf. `rssiLow`) |
| 7 | Router unauffällig, Anbieter unauffällig und Ziel noch gestört | `internet` | `pathOk` (+ ggf. `rssiLow`) |
| 8 | sonst | `unknown` | `ispHopOnly` (eine Station erhöht, danach normal) / `wifiLocked` / `noHops` / `noBaseline` / `noTargetCheck` |

Zusätzlich `cpuHigh = cpu >= 90` (keine Ursache, nur Hinweis; `reasons` enthält dann `cpuHigh`). `LagCause` = `"wifi" | "router" | "isp" | "internet" | "localTraffic" | "unknown"`; `Reason` = `"trafficHigh" | "spikeGone" | "rssiLow" | "signalDrop" | "gatewaySlow" | "gatewayLost" | "ispHopSlow" | "ispHopOnly" | "lineBusyPossible" | "pathOk" | "vpnActive" | "wifiLocked" | "connectionOther" | "noHops" | "noBaseline" | "noTargetCheck" | "snapshotsOff" | "cpuHigh"`.

**Anzeigenamen** (`lag.cause.*`): `wifi` = „WLAN“, `router` = „Heimnetz/Router“, `isp` = „Anschluss/Anbieter“ mit festem Untertitel „auch möglich: Leitung durch andere Geräte im Haushalt ausgelastet“, `internet` = „Internet (hinter dem Anbieter)“ (Zusatz „– Spielserver-Netz“ nur, wenn das Messziel `kind = server` hat), `localTraffic` = „Datenverkehr auf diesem PC“, `unknown` = „unklar“. `cpuHigh`: „PC stark ausgelastet – fühlt sich wie Lag an (Ruckler), ist aber kein Netzproblem“. Überall mit dem Wort „vermutlich“ bzw. „Einschätzung“.

**Zählungen anzeigen** (Karte, Detail, `LagSection`, PNG-Bildkarte gleich, reine Funktion `causeSummary(counts)` in `lib/lagtext.ts`): immer Gesamtzahl und „unklar“: „5 Ausreißer untersucht – vermutlich: 3× WLAN, 1× Anschluss/Anbieter; 1× unklar“.

**`IfCounters`**

| Feld | Bedeutung |
|---|---|
| `adapterId`, `adapter` | GUID und Name der Hauptverbindung |
| `rxBytes`, `txBytes` | Zähler seit Windows-Start (`InOctets`/`OutOctets`, u64) |
| `at` | Zeitpunkt (ms) |
| `rxMbps`, `txMbps` | aus dem Ringpuffer (Fenster wie oben), `null`, wenn der Monitor nicht läuft |

**`QuickHop`** = `{ ttl, address: string|null, rtt: number|null, zone: "lan"|"isp"|"internet"|"target"|null, cgnat: boolean, baseMs: number|null }`.

**`LagSnapshot`**

| Feld | Bedeutung |
|---|---|
| `at` | Zeitpunkt (ms) |
| `connection` | `"wifi"` \| `"ethernet"` \| `"other"` \| `null` (Art der Hauptverbindung) |
| `viaVpn` | `boolean` |
| `targetMs`, `targetLost` | Ziel bei der Momentaufnahme (Median der Antworten bzw. Verluste von 3) |
| `hops` | `QuickHop[]` (TTL 1–3, auch ohne Antwort) |
| `gatewayMs`, `gatewayBaseMs` | Router-Wert und Grundwert |
| `wifi`, `wifiState` | `{ signal, rssi, band }` oder `null`; `"ok"` \| `"locked"` \| `"none"` \| `null` |
| `signalBase` | Grundwert Signal oder `null` |
| `rxMbps`, `txMbps`, `trafficBaseMbps`, `refDownMbps`, `refUpMbps` | Datenverkehr, Grundwert, Bezug (`null` = unbekannt) |
| `cpu` | CPU-Last % oder `null` |
| `tookMs` | Dauer der Momentaufnahme |

**`LagCheck`** = `{ at, cause: LagCause, cpuHigh, reasons: Reason[], snapshot: LagSnapshot }`.
**`LagEvent`** = `LagCheck` + `{ targetId, targetLabel, targetKind, rtt, baseline, limit, count, sessionId: number|null }` (`baseline` = Median, `limit` = Ausreißer-Grenze, `count` = Ausreißer in diesen 10 s). Bei `lag.snapshots = false` hat `snapshot` alle Felder `null`, `hops = []`, `viaVpn = false`, `tookMs = 0`.

**Einstellungen** (`Settings.lag`): `snapshots: true` (Momentaufnahmen und Ruhe-Messungen; aus → `net://lag` kommt trotzdem, mit `cause = "unknown"`, `reasons = ["snapshotsOff"]`, keine zusätzlichen Pakete). Ort: Einstellungen › Monitor „Momentaufnahmen bei Ausreißern“.

**Oberfläche:**
- **Cockpit** (Live-Ping-Karte): `components/net/LagBadge.tsx` zeigt den letzten Ausreißer der letzten 60 s: „182 ms · vermutlich WLAN“ mit Symbol und dem Zusatz „Einschätzung“; Klick → Netzwerk › Verbindung. Mit `cpuHigh` zusätzlich der `cpuHigh`-Satz.
- **Netzwerk › Verbindung:** Karte „Lag-Detektiv“ (`components/net/LagCard.tsx`) mit den letzten 20 Ereignissen (`net_lag_recent` + `net://lag`), aufklappbar: Ziel bei der Momentaufnahme, Stationen mit Zone (stumm = „keine Antwort“) und Grundwert, Router, WLAN, Datenverkehr, CPU, die `reasons` als Sätze.
- **Berichte:** Kopf/Karte zeigen die Ursachen mit `causeSummary`; Abschnitt „Ausreißer“ (`components/reports/LagSection.tsx`, Route `section: "lag"`) zählt die Ursachen der letzten 30 Tage aus `net_events_summary` (Summe von `countSum` je `cause`).
- `SessionReport.lagCauses?: Partial<Record<LagCause, number>>` – in `onStopped` aus `net_events_list(start, end + 5000, ["spike"])`, gefiltert auf `sessionId = session.id`, Summe von `detail.count`; schlägt das fehl, fehlt das Feld.

**Demo (Demo-Backend):** Die Demo-Hauptverbindung ist Ethernet (vorhandene Werte). Der Demo-Monitor erzeugt deterministisch (`rand()`, Seed 1337) **genau alle 30 Takte** einen Ausreißer im `net://ping` und 1 s später `net://lag`; die Ursachen wechseln reihum `router`, `isp` (mit `lineBusyPossible`), `localTraffic`, `internet`, `unknown` (`spikeGone`) – alle mit `snapshot.connection = "ethernet"`. Mit Demo-Schalter `__pulsarWifiPrimary` (WLAN als Hauptverbindung, siehe WLAN-Scanner) ersetzt `wifi` die Ursache `router`. `net_lag_recent` liefert 4 feste, dazu passende Ereignisse, `net_if_counters` steigende Zähler (≈ 2–4 Mbit/s), `net_lag_snapshot` eine feste Momentaufnahme mit `cause = "internet"`.

**Tests:** cargo `lag::tests::spike_rule_matches_fixtures`, `…::live_rule_matches_fixtures`, `…::cause_table` (je Zeile mindestens ein Fall plus Grenzwerte −70 dBm, +15/+30/+20 ms, 70 %; Pflichtfälle „Ausreißer vorbei → unknown/spikeGone“, „eine `isp`-Station langsam, Ziel normal → nicht isp“, „eine `isp`-Station langsam, danach normal → unknown/ispHopOnly“, „schwaches WLAN, Router ok, Anbieter bleibt erhöht → isp mit rssiLow“, „VPN → unknown/vpnActive“, „`other` + Router auffällig → unknown/connectionOther“, „WLAN gesperrt → wifiLocked“), `…::router_never_answered_is_not_bad`, `…::cpu_high_flag`, `…::line_busy_possible_rules`, `recorder::tests::throttle_10s_merges_count` (inkl. zweites `net://lag` mit endgültigem `count`), `…::snapshots_off_shape`, `ifstats::tests::throughput_from_ring`, `…::counter_reset_gives_none`, `…::baseline_5min_at_250ms_and_10s`, `…::window_at_10s_interval`, `quickhops::tests::zones_in_ttl_order`, `link::tests::*` (VPN). vitest `grade.test.ts` (beide Fixture-Teile), `zones.test.ts`, `lag.test.ts` (jeder `LagCause`- und `Reason`-Wert hat einen Text in de und en; `causeSummary` mit Gesamtzahl und „unklar“). **Selbsttest:** `adapter-zaehler`, `teilroute`, `lag-momentaufnahme` (siehe „Gemeinsam“). **Screenshots:** `02c-cockpit-lag-detektiv`, `20a-netzwerk-lag-detektiv`, `23b-berichte-ausreisser-ursachen`. **Doku:** `docs/FUNKTIONEN.md` (Cockpit, Netzwerk), `docs/ANLEITUNG.md` (Seitenübersicht, FAQ „Wie sicher ist die Ursache?“).

**Wichtig (ehrlich):** Die Ursache ist eine **Einschätzung** aus einer Momentaufnahme von etwa einer Sekunde, keine Gewissheit. War der Ausreißer bei der Momentaufnahme schon vorbei, heißt es „unklar“. Über WLAN lassen sich WLAN und Router nicht sauber trennen (beides heißt dann „WLAN“). Pulsar sieht **andere Geräte im Haushalt nicht**: Lädt oder streamt ein anderes Gerät, staut sich die Leitung am Router – das sieht aus wie „Anschluss/Anbieter“. Mit aktivem VPN gehören die Stationen zum VPN-Weg, deshalb dann „unklar“. Viele Router und Anbieter beantworten TTL-Anfragen gar nicht oder nachrangig. Der Datenverkehr ist die Summe des Adapters; welches Programm ihn verursacht, sieht Pulsar nicht. Pulsar behebt keine Ursache selbst.

## Match-Zeitleiste (`src/net/history_timeline.rs`, `src/net/recorder/chunk.rs`, Oberfläche `pages/ReportDetail.tsx`, `lib/cardexport.ts`)

**Zweck:** Jede Spielsitzung als scrollbare Zeitleiste (Ping, Schwankung, Verlust, Ausreißer mit Ursache, Last) zeigen und als Bildkarte (PNG) exportieren.

| Befehl | Verhalten |
|---|---|
| `net_session_timeline(sessionId)` (`sessionTimeline`) → `SessionTimeline` | Schreibt zuerst den offenen Puffer des Recorders, liest dann alle Blöcke der Sitzung aus `session_samples` (nach `chunk_start` sortiert, Punkte gekappt auf `[sessions.start, sessions.end]`) und die Ereignisse aus `net_events` mit dieser `session_id` bzw. (`quiet`) im Zeitraum der Sitzung. Keine Blöcke (unbekannte Sitzung, aufgeräumt, nie gemessen) → „Für diese Sitzung gibt es keine Messwerte.“ Mehr als **43 200** Punkte (12 h bei 1 s) → je `merged` aufeinanderfolgende Punkte werden zusammengefasst (Zeit = erster Punkt, Ping = Mittel der Antworten oder `null`, wenn mehr als die Hälfte verloren ging – wie `compressTimeline`; CPU, rx, tx = Mittel). Reine Datenbank, kein Netz; läuft in `spawn_blocking`. |

**`SessionTimeline`**

| Feld | Bedeutung |
|---|---|
| `sessionId`, `gameId`, `start`, `end` | aus `sessions` |
| `targets` | `{ key, label, method }[]` in der Reihenfolge ihres ersten Auftretens (aus `session_samples.target_label`/`method`) |
| `targetChanges` | `{ t, key }[]` – Zeitpunkte, an denen das Messziel wechselte (z. B. Spielserver gefunden) |
| `merged` | 1 = gespeicherte Punkte, sonst Anzahl zusammengefasster Punkte je Punkt |
| `points` | `[t, rtt \| null, cpu \| null, rxMbps \| null, txMbps \| null][]` |
| `events` | `NetEvent[]` der Sitzung (`spike`, `outage`, `loss`, `slow`, `quiet`), nach `t` sortiert |

**Berichte (`store/boost.ts`):**
- `SessionReport.sessionId?: number` = `GameStoppedEvent.session.id` (neu ab dieser Version; ältere Berichte haben kein Feld).
- **Fehler behoben:** In `useNet.subscribe` werden neue Messwerte nicht mehr über die Länge des Puffers erkannt (`slice(prev.length)` lieferte nach 900 Werten nichts mehr), sondern über die Zeit: die Aufzeichnung merkt sich `lastT` und übernimmt nur `s.t > lastT` und `s.t >= start − 2000` (reine Hilfsfunktion `appendFresh` in `lib/recording.ts`). So bleiben auch Runden über 15 Minuten vollständig, und ein Zielwechsel (Puffer wird geleert) verliert nichts.
- `spikes` bleibt `countSpikes` über die aufgezeichneten Werte; `timeline` bleibt die auf 600 Punkte verdichtete Kurve (Rückfall für alte Berichte und wenn die Rohdaten aufgeräumt sind).

**Ausreißer-Zahlen (eindeutig, reine Funktion `headerModel(report, timeline)` in `lib/timeline.ts`):**
- Der Kopf zeigt `report.spikes` als „Ausreißer“ (Regel über die ganze Runde).
- Die Ursachen heißen „Momentaufnahmen (je 10 s zusammengefasst)“: `causeSummary` über die `spike`-Ereignisse plus „{n} von {spikes} Ausreißern untersucht“ (`n` = Summe `detail.count`, höchstens `spikes`).
- Die Ping-Spur markiert **alle** Punkte über der Grenze aus `countSpikes` über die Punkte der Zeitleiste; ein Ursachen-Symbol erscheint nur an Punkten, die zu einem `spike`-Ereignis gehören (gleiche Sekunde ± 1 Takt).

**Darstellung (`components/reports/Timeline*.tsx`, Canvas 2D oder SVG, Farben aus `var(--nv-*)`):**
- **Einstiege:** Klick auf `ReportCard` → `{ page: "reports", id: report.id }`; zusätzlich aus Spiel › Berichte bzw. der Sitzungsliste (`sessions_for_game`) → `{ page: "reports", section: "session", id: <sessionId> }` – so sind auch Sitzungen ohne Bericht erreichbar (dann baut `ReportDetail` den Kopf aus `SessionTimeline` mit `summarize` über die Punkte). `App.tsx` reicht `route.id`/`route.section` an `ReportDetail` weiter.
- Kopf: Spiel, Datum, Dauer, Note (`GradeRing`), Ø/Min/Max, Schwankung, Verlust, Ausreißer, Messziel(e), Ursachen (siehe oben).
- Spuren untereinander, gemeinsame Zeitachse, waagerecht scrollbar: **Ping** (Linie, Farbe nach `pingColor`), **Schwankung** (gleitendes Mittel |Δrtt| über die letzten 10 Antworten), **Verlust** (rote Striche; `outage`/`loss`-Ereignisse als Band), **Ausreißer** (Markierung, Ursachen-Symbol, Tooltip mit Momentaufnahme), **Last** (CPU als Fläche, Datenverkehr rx/tx als dünne Linien), `slow`-Ereignisse als Band, `quiet` als graues Band („Pulsar-Speedtest/WLAN-Scan“), Zielwechsel als senkrechte Linie.
- Zoom: „ganze Runde“ (Standard), „5 min“, „1 min“; Mausrad + Umschalt scrollt. Bei 960×600 (Mindestfenster) bleiben alle Spuren sichtbar (Ping ≥ 120 px, andere ≥ 36 px).
- Ohne `sessionId` oder bei „Für diese Sitzung gibt es keine Messwerte.“: nur die Ping-Spur aus `report.timeline` mit dem Hinweis „Für diesen Bericht gibt es nur die verdichtete Kurve.“

**Bildkarte PNG (`lib/cardexport.ts`):** `renderMatchCard(report, timeline | null, game | null): Promise<Blob>`, Inhalt aus der reinen Funktion `cardModel(report, timeline)`:
1. Canvas 2D, **1200 × 630** logische Pixel, Maßstab 2 (Datei 2400 × 1260 px).
2. Farben über `getComputedStyle(document.documentElement).getPropertyValue("--nv-…")` (aktuelles Design), Spiel-Farben aus `Game.palette` als Verlauf; Schriften erst nach `document.fonts.ready`.
3. **Keine Bilder** (keine Cover, keine fremden `https:`-Quellen) – das Canvas bleibt so immer exportierbar.
4. Inhalt: Spielname, Datum/Uhrzeit, Dauer, Note, Ø-Ping, Schwankung, Verlust, Ausreißer, Ping-Kurve mit Ausreißer-Punkten, Ursachen mit `causeSummary` (Gesamtzahl und „unklar“), Name des Messziels (keine Adresse), Schriftzug „PULSAR“, Fußzeile „Gemessen von Pulsar zu {target} · Ursachen sind Einschätzungen“.
5. `canvas.toBlob("image/png")` → `exportBytes("pulsar-match-<spiel>-<datum>.png", { name: "PNG", extensions: ["png"] }, bytes)` (siehe „Datei-Export“).
Vorschau im Detail vor dem Speichern (Knopf „Als Bild speichern“).

**Demo (Demo-Backend):** Demo-Berichte bekommen eine `sessionId`; `net_session_timeline` erzeugt dazu deterministische Rohdaten (1 s Takt, ein Zielwechsel nach 40 s, 3 Ausreißer mit Ursachen `router`, `isp`, `unknown`, ein kurzer Aussetzer, CPU 20–70 %, rx/tx). Unbekannte ID → „Für diese Sitzung gibt es keine Messwerte.“

**Tests:** cargo `history_timeline::tests::points_in_order_across_chunks`, `…::merges_above_43200`, `…::unknown_session_errors`, `…::events_of_session_only`, `…::targets_with_label_and_method`, `…::points_clamped_to_session`. vitest `recording.test.ts` („nimmt nach 900 Messwerten weiter auf“, „keine doppelten Werte“, „Zielwechsel verliert nichts“), `timeline.test.ts` (gleitende Schwankung, Zoom-Bereiche, `headerModel`: Kopf = `report.spikes`, „n von m untersucht“, Markierungen aus den Punkten), `cardexport.test.ts` (`cardModel`: Texte, `causeSummary` mit Gesamtzahl und „unklar“, keine Adresse/SSID im Modell; Canvas selbst ist in vitest/Node nicht vorhanden). **Screenshots:** `23c-berichte-zeitleiste`, `23d-berichte-bildkarte`. **Doku:** `docs/FUNKTIONEN.md` (Berichte), `docs/ANLEITUNG.md` (Seitenübersicht).

**Wichtig (ehrlich):** Die Zeitleiste zeigt, was Pulsar während der Runde zu **seinem Messziel** gemessen hat (Region oder nächstgelegener Spielserver) – nicht die Verbindung, die das Spiel selbst benutzt. Rohdaten gibt es nur für die 50 neuesten Sitzungen (höchstens 90 Tage, höchstens 8 MB) und nur, solange der Monitor lief; bei Takt unter 1 s ist ein Punkt je Sekunde gespeichert.

## Pulsar-Kalender (`src/net/history_hourly.rs`, `src/net/recorder/hourly.rs`, Oberfläche `lib/calendar.ts`, `components/charts/Heatmap.tsx`)

**Zweck:** Aus allen gespeicherten Messungen eine Heatmap Wochentag × Stunde zeigen und – nur bei genug Daten und deutlichem Unterschied – die bisher ruhigste Zeit nennen.

| Befehl | Verhalten |
|---|---|
| `net_history_hourly(from, to, targetKey?, netId?)` (`historyHourly`) → `HourlyRow[]` | Schreibt zuerst den offenen Puffer, liefert dann alle Zeilen aus `ping_hourly` mit `from <= hourStart <= to` (optional nur ein Ziel bzw. ein Netz), nach `hourStart` sortiert. Höchstens 400 Tage, sonst „Ungültiger Zeitraum.“ Keine Daten → leere Liste. Reine Datenbank. |

**`HourlyRow`** = `{ hourStart, targetKey, netId, connection: "wifi"|"ethernet"|"other"|"vpn", kind: "region"|"server"|"other", label, method, n, lost, sumRtt, sumJitter, nJitter, maxRtt: number|null, spikes, coveredMs }` (Rohsummen, damit die Oberfläche richtig gewichtet).

**Rechnung in der Oberfläche (`lib/calendar.ts`, Ortszeit):**
- Zeitzone über die gemeinsame reine Hilfsfunktion `localParts(ms, timeZone) → { year, month, day, weekday, hour }` in `lib/localtime.ts` (`Intl.DateTimeFormat` mit `timeZone`); `timeZone` ist Parameter mit Standard `Intl.DateTimeFormat().resolvedOptions().timeZone`. Wochentag Montag = 0 … Sonntag = 6 (wie `startOfWeek`). Tests übergeben `"Europe/Berlin"` ausdrücklich (unabhängig von der Zeitzone der CI-Maschine).
- **Filter:** Ziel (Standard: das Ziel mit der meisten Messzeit), **Netz** (Standard: das Netz mit der meisten Messzeit) und **Verbindungsart** (Standard „alle außer VPN“; umschaltbar „nur Kabel“, „nur WLAN“). Verschiedene Ziele und Netze werden nie gemischt; Auswahlliste mit Name, Art, Messzeit. Netze heißen „Netz 1, 2 …“ nach Messzeit mit Zeitraum („vom 3. Mai bis 12. Okt.“) – Pulsar speichert keinen Netznamen.
- Je Fach `(wochentag, stunde)`: `n = Σn`, `lost = Σlost`, `avg = ΣsumRtt / (n − lost)`, `jitter = ΣsumJitter / ΣnJitter`, `loss = lost / n`, `spikeRate = Σspikes / (n − lost)`, `covered = ΣcoveredMs`, `days` = verschiedene Kalendertage mit einer Messstunde (`coveredMs >= 30 min`).
- **Bewertung je Fach:** `pingGrade(avg, jitter, loss)` aus `lib/grade.ts`; bei `spikeRate > 0,02` eine Note schlechter (F bleibt F). Farbe = `gradeColor`, Zahl für Vergleiche = `gradeValue`.
- **Fach gültig** (eingefärbt) = mindestens 2 Messstunden an mindestens **2** verschiedenen Tagen (unabhängig vom Takt). **Fach empfehlbar** = gültig und an mindestens **3** Tagen. Ungültige Fächer blass/schraffiert („wenig Daten“), leere ohne Farbe.
- **Ruhigste Zeit:** nur wenn insgesamt mindestens **20 Stunden Messzeit** an mindestens **7 Tagen** vorliegen **und** mindestens **12** Fächer gültig sind. Gesucht wird der beste Block aus **2 aufeinanderfolgenden empfehlbaren Stunden** am selben Wochentag (Mittel der beiden `gradeValue`; bei Gleichstand kleinerer Ø-Ping, dann früher), ebenso der schlechteste („eher meiden“). Genannt werden beide **nur**, wenn der Unterschied mindestens **eine Notenstufe** beträgt **und** (Δ Ø-Ping ≥ 10 ms oder Δ Verlust ≥ 1 Prozentpunkt oder Δ Ausreißerquote ≥ 1 Prozentpunkt). Sonst: „Kein deutlicher Unterschied – zu jeder gemessenen Zeit ähnlich.“
- Sonst ehrlich: „Zu wenig Daten für eine Empfehlung – bisher {hours} Stunden Messzeit an {days} Tagen.“ (gebraucht: 20 Stunden an 7 Tagen).
- **Datenbasis** immer sichtbar: „{hours} Stunden Messzeit an {days} Tagen“ (Σ`coveredMs`, 0,1 h).
- **Zeitraum:** 30 / 90 (Standard) / 365 Tage.

**Oberfläche:** Berichte › Abschnitt „Kalender“ (`components/reports/CalendarSection.tsx`, Route `{ page: "reports", section: "calendar" }`; auch ohne Berichte erreichbar): Filter (Ziel, Netz, Verbindungsart, Zeitraum), 7 Zeilen × 24 Spalten (Fächer ≥ 18 px, passt bei 960 px), Tooltip je Fach (Ø-Ping, Schwankung, Verlust, Ausreißer, Messzeit, Tage), Karte „Bisher am ruhigsten: Di 20–22 Uhr (Ø 23 ms, an 4 Dienstagen gemessen)“ mit der Unterzeile „bisher am ruhigsten gemessen – keine Vorhersage“, bzw. „kein deutlicher Unterschied“ oder „zu wenig Daten“.

**Demo (Demo-Backend):** Demo-Zeilen als Funktion von (lokalem Wochentag, Stunde, Seed 1337) – unabhängig vom Aufnahmetag –, 60 Tage für `aws-eu-central-1` in einem Netz per Kabel (abends deutlich höherer Ping und mehr Ausreißer, nachts Lücken), wenige Tage für `valve-cs2-fra`; so zeigt die Demo stabil eine Empfehlung und beim zweiten Ziel „zu wenig Daten“.

**Tests:** cargo `history_hourly::tests::range_filter_and_order`, `…::invalid_range_errors`, `…::net_filter`, `recorder::tests::hourly_sums_and_jitter_across_flush`, `…::hourly_split_by_net_and_connection`. vitest `localtime.test.ts` (Sommerzeit-Grenzen Europe/Berlin, letzte März-/Oktoberwoche), `calendar.test.ts`: Wochentag/Stunde (Montag = 0), Gewichtung über Rohsummen, `spikeRate`-Abwertung, Messstunde (29:59/30:00 min), Gültigkeit (1/2 Messstunden, 1/2 Tage), empfehlbar (2/3 Tage), Mindestbasis (19,9/20 h, 6/7 Tage, 11/12 Fächer), Mindestunterschied (gleiche Note → „kein deutlicher Unterschied“; eine Stufe + 9/10 ms), Gleichstand-Regeln, Netz-/Verbindungsfilter, Demo-Daten ergeben eine stabile Empfehlung. **Screenshot:** `23e-berichte-kalender`. **Doku:** `docs/FUNKTIONEN.md` (Berichte).

**Wichtig (ehrlich):** Der Kalender zeigt deine bisherigen Messungen, **keine Vorhersage**. Gemessen wurde nur, wenn Pulsar lief – Stunden, in denen du nie spielst, bleiben leer. Messungen per WLAN, per Kabel, mit VPN und in anderen Netzen werden getrennt, weil sie sich nicht vergleichen lassen. Bei Zeitzonen mit halbstündigem Versatz landet eine Messstunde im Fach ihrer vollen Ortsstunde.

## Hör dein Netz (Oberfläche `store/sonar.ts`, `lib/sonar.ts`, Klang `shared/sound/engine.ts`)

**Zweck:** Den Live-Ping als Pulsar-Ton hörbar machen (gleichmäßig = stabil, stolpernd = Schwankung, Lücken = Verlust) und optional bei Ausreißern im Spiel einen sehr leisen Warnton spielen.

Kein neuer Rust-Befehl. Quelle: `net://ping` (über `useNet.subscribe`, Hauptziel) und `net://lag` (nur für den Warnton). Gespielt wird **nur im Hauptfenster** (nie im Overlay), damit nichts doppelt klingt.

**Benötigte Engine-Funktionen** (gegen die neue Klang-Engine „Pulsar-Sonifikation“ in `shared/sound/engine.ts`; Namen legt die Engine fest):
- eine wiederverwendbare **Puls-Stimme**, die selbstständig im Takt pulst; höchstens eine für „Hör dein Netz“;
- **Periode** setzen (250–10 000 ms, wirkt ab dem nächsten Puls);
- **Zittern** 0–1 setzen (0 = exakt im Takt, 1 = jeder Puls um bis zu ±35 % der Periode verschoben);
- **Aussetzer**: den nächsten Puls auslassen (Stille statt Ton);
- **Pegel** 0–1 setzen, weich (Rampe ≥ 20 ms, keine Knackser), und einen einzelnen Puls **betonen**;
- optional **Tonhöhe/Stufe** (pentatonisch, wie die übrige Klangwelt) – fehlt das, läuft „Hör dein Netz“ ohne Tonhöhe und die Einstellung `sonar.pitch` wird ausgeblendet;
- **start/stop** mit kurzem Ein-/Ausblenden (≤ 150 ms), Knoten werden beim Stopp freigegeben;
- ein kurzer, sanfter **Einzelton** mit eigenem Pegel für den Warnton;
- alles hört auf die globale Lautstärke und Stummschaltung (`settings.sound`, `settings.volume`), nutzt den gemeinsamen `AudioContext` und startet erst nach einer Nutzeraktion (Autoplay-Regel).

**Abbildung Ping → Klang** (`lib/sonar.ts`, reine Funktion `sonarParams(sample, window, stats, settings)`):

| Messung | Klang |
|---|---|
| Takt | Periode = `settings.pingIntervalMs` (ein Puls je Messung) |
| Antwort | Puls. Tonhöhe (wenn `sonar.pitch`): < 20 ms Stufe 5 (hell) · 20–34 → 4 · 35–59 → 3 · 60–99 → 2 · 100–179 → 1 · ≥ 180 → 0 (dunkel) – gleiche Grenzen wie die Ø-Ping-Stufen von `pingGrade` (als gemeinsame Konstante `PING_GRADE_LIMITS = [20, 35, 60, 100, 180]` aus `lib/grade.ts` exportiert) |
| Schwankung | Zittern = `clamp(stats.jitter / 30, 0, 1)` (`PingStats.jitter` der letzten 60 Messungen; 0 ms = gleichmäßig, ≥ 30 ms = stark stolpernd) |
| Verlust (`rtt = null`) | Aussetzer: dieser Puls fällt aus |
| Ausreißer (`isLiveSpike(window)`, gleiche Regel und Fixtures wie im Backend) | Puls betont (Pegel × 1,5, höchstens 1) |
| Lautstärke | `sonar.volume × settings.volume`; `settings.sound = false` → stumm |

**Warnton im Spiel:** nur wenn `sonar.alertInGame = true` (Standard **aus**), ein Spiel läuft (`useLibrary.running` nicht leer) und `net://lag` (erste Meldung, nicht die `count`-Aktualisierung) kommt; höchstens **alle 10 s**; Pegel `sonar.alertVolume × settings.volume` mit `alertVolume` 0,05–0,3 (Standard 0,15 – sehr leise). Unabhängig davon, ob „Hör dein Netz“ gerade läuft.

**Einstellungen** (`Settings.sonar`): `volume: 0.5` (0–1), `pitch: true`, `alertInGame: false`, `alertVolume: 0.15` (0,05–0,3). Ob „Hör dein Netz“ läuft, wird **nicht** gespeichert: Es startet nur per Klick und stoppt beim Ausschalten, beim Verlassen des Fensters in den Infobereich (`document.hidden`) und wenn der Monitor stoppt.

**Oberfläche:** Cockpit › Live-Ping-Karte: Knopf mit Kopfhörer-Symbol „Hör dein Netz“ (an/aus, kleine Pegelanzeige). Einstellungen › Ton: Unterabschnitt „Hör dein Netz“ (Lautstärke, Tonhöhe folgt dem Ping, Warnton im Spiel, Warnton-Lautstärke, Probe-Knöpfe „Stabil“, „Schwankung“, „Verlust“, „Warnton“ – spielen je 4 s Beispielwerte ab).

**Demo (Demo-Backend):** keine eigenen Befehle; der Demo-Monitor (`net://ping`) und das Demo-`net://lag` treiben den Ton im Browser genauso.

**Tests:** vitest `sonar.test.ts`: Tonstufen an allen Grenzen (19,9/20/34,9/35/…/180) gegen `PING_GRADE_LIMITS`, Zittern-Kappung (0, 15 → 0,5, ≥ 30 → 1), Verlust → Aussetzer, Ausreißer über `isLiveSpike` → Betonung, stumm bei `sound = false`, Warnton standardmäßig aus, nur mit laufendem Spiel, höchstens alle 10 s, nicht bei der `count`-Aktualisierung, Pegelgrenzen 0,05–0,3; `mergeSettings` ergänzt/kappt `sonar`. **Screenshots:** `02c-cockpit-lag-detektiv` (Knopf „Hör dein Netz“ sichtbar), `24b-einstellungen-hoer-dein-netz` (zeigt Schalter und Zustand – Ton ist nicht sichtbar). **Doku:** `docs/FUNKTIONEN.md` (Cockpit, Einstellungen), `docs/TESTBERICHT.md` „Nicht geprüft“ (Klang prüft die CI nicht).

**Wichtig (ehrlich):** Der Ton macht die Messung hörbar, er verbessert nichts. Das Stolpern ist eine Übersetzung der gemessenen Schwankung in Klang, nicht das echte Timing einzelner Pakete. Ob WebView2 Ton spielt, während Pulsar im Infobereich versteckt ist, hängt von Windows und WebView2 ab – der Warnton kann dann ausbleiben (von Hand auf Windows prüfen). Der Warnton reagiert auf Pulsars Messziel, nicht auf die Verbindung des Spiels.

## WLAN-Scanner und Raum-Scan (`src/net/wifiscan.rs`, Oberfläche `lib/wifichan.ts`, `lib/rooms.ts`, `pages/network/WifiPanel.tsx`)

**Zweck:** WLAN-Netze in der Nähe und die Kanalbelegung für 2,4/5/6 GHz zeigen, einen Router-Kanal empfehlen und per „Raum-Scan“ das Signal je Raum vergleichen.

**WLAN-Zustand und Standortsperre (Windows 11 24H2):** `adapters::wifi()` wird zu `adapters::wifi_state() -> WifiState` erweitert: `Connected(WifiInfo)` · `NotConnected` · `NoService` (`WlanOpenHandle` scheitert, z. B. `ERROR_SERVICE_NOT_ACTIVE` 1062) · `Locked` (`ERROR_ACCESS_DENIED` 5 bei `WlanQueryInterface`, `WlanScan` oder `WlanGetNetworkBssList`). Reine Funktion `wlan_error_kind(code)` (1062/1068 → `NoService`, 5 → `Locked`, sonst `NotConnected`). `net_wifi()` bleibt unverändert (`Locked` → `null`, rückwärtskompatibel).

| Befehl | Verhalten |
|---|---|
| `net_wifi_state()` (`wifiState`) → `WifiStateInfo` | `{ state: "connected" \| "notConnected" \| "noService" \| "locked", wifi: WifiInfo \| null }`. Außerhalb von Windows `noService`. Für Raum-Scan, Diagnose und WLAN-Tab – unterscheidet „kein WLAN“ von „gesperrt“. |
| `net_wifi_scan(refresh=false)` (`wifiScan`) → `WifiScan` | `WlanOpenHandle` → `WlanEnumInterfaces`; bei `refresh = true` je Schnittstelle `WlanScan` und danach höchstens **4 s** warten (ohne Adminrechte); dann `WlanGetNetworkBssList(h, &guid, None, dot11_BSS_type_any, false)` und **alle** `WLAN_BSS_ENTRY` lesen. Gesamtzeit höchstens 6 s, in `spawn_blocking`. Gleiche BSSID auf mehreren Schnittstellen → der stärkste Eintrag; höchstens 512 Einträge, nach RSSI absteigend. Kein WLAN-Dienst oder keine WLAN-Schnittstelle → `interfaces = 0`, leere Liste (kein Fehler). Schlägt nur `WlanScan` fehl, wird die Liste aus dem Windows-Zwischenspeicher geliefert (`fresh = false`). `ERROR_ACCESS_DENIED` → Fehler `backend.wifiLocked` (Text unten). **Gleichzeitigkeit:** `refresh = false` liest immer sofort den Windows-Zwischenspeicher (nie blockiert). `refresh = true` ist serialisiert: Läuft schon ein aktiver Scan, **wartet** ein zweiter Aufruf darauf und bekommt dasselbe Ergebnis (`tokio::sync::Mutex` + gemeinsames Ergebnis), kein Fehler. Ein aktiver Scan setzt die Ruhezeit (`quiet_until`, Scan-Dauer + 2 s). Außerhalb von Windows `Ok({ at, fresh: false, interfaces: 0, networks: [] })`. |

**Lesen der Einträge (Speichersicherheit, verbindlich):** `let base = entries.add(j) as *const u8;` Felder einzeln mit `addr_of!((*p).lRssi).read_unaligned()` usw. lesen – nie die ganze Struktur kopieren (`bInRegDomain` ist ein Rust-`bool`; ein Byte ≠ 0/1 wäre undefiniertes Verhalten). Informationselemente: `ie = base.add(ulIeOffset)` relativ zum Eintrag **im Windows-Puffer**; vorher prüfen, dass `(base − list_start) + ulIeOffset + ulIeSize <= (*bss).dwTotalSize`, sonst `widthMhz = null`. `parse_width(&[u8]) -> Option<u16>` arbeitet nur auf dem geprüften Slice und prüft jedes Längenbyte (HT Operation 61, VHT Operation 192, HE Operation 255/36, EHT Operation 255/106 → 320 MHz). Pro Netz `ageS` aus `ullHostTimestamp` (Sekunden seit dem letzten Empfang, `null`, wenn nicht lesbar).

Reine Hilfsfunktionen aus `adapters.rs` (`band_from_khz`, `band_from_channel`, `phy_name`, `rssi_from_quality`) werden wiederverwendet; neue reine Funktionen in `wifiscan.rs`: `channel_from_khz` (Sonderfall 5935 MHz → 6-GHz-Kanal 2), `bssid_text`, `parse_width`, `secured(capability)` (Bit 0x0010 „Privacy“), `wlan_error_kind`.

**`WifiScan`** = `{ at, fresh: bool, interfaces: number, networks: WifiNetwork[] }`.

**`WifiNetwork`**

| Feld | Bedeutung |
|---|---|
| `ssid` | Netzname (`""` = verstecktes Netz) – nur im Speicher, nie gespeichert/exportiert |
| `bssid` | `aa:bb:cc:dd:ee:ff` – ebenso |
| `rssi` | dBm (`lRssi`) |
| `signal` | Qualität 0–100 (`uLinkQuality`) |
| `channel`, `band`, `centerKhz` | Kanal, `"2.4"` \| `"5"` \| `"6"`, Mittenfrequenz |
| `widthMhz` | 20/40/80/160/320 oder `null` (unbekannt → für die Belegung wie 20 MHz) |
| `phy` | z. B. „Wi-Fi 6 (802.11ax)“ |
| `secured` | verschlüsselt (Privacy-Bit) |
| `connected` | BSSID der aktuellen Verbindung |
| `ageS` | Sekunden seit dem letzten Empfang oder `null` |

**Kanal-Empfehlung** (`lib/wifichan.ts`, reine Funktion `channelAdvice(networks, own, opts)`; `own` = verbundenes Netz; `opts = { wiredPrimary: boolean }`):
- **Eigene Netze** (zählen nicht als Fremdlast): gleiche SSID wie das eigene Netz; außerdem **virtuelle Zugangspunkte desselben Funkteils**: gleicher Kanal und BSSID-Familie des verbundenen Zugangspunkts (`sameRadio(a, b)`: Oktette 2–5 gleich, im 1. und 6. Oktett nur die unteren 4 Bit verschieden – deckt Gast-, Hotspot- und Mesh-Backhaul-SSIDs wie „Vodafone Homespot“/„Telekom_FON“ ab), auch versteckte. Werden solche erkannt: Hinweis `ownExtraSsids` („Gast-/Hotspot-Netze deines Routers zählen nicht“). Heuristik, im Zweifel zählt ein Netz als fremd.
- Gewicht je Netz nach Stärke: `w = clamp((rssi + 95) / 35, 0,05, 1)` (−60 dBm → 1, −77,5 → 0,5, −95 → 0,05).
- **2,4 GHz:** empfohlen werden **nur 1, 6 oder 11**. Last(k) = Σ w × max(0, 1 − d / 5) mit d = |k − Kanal| (bei `widthMhz = 40` d − 2, nicht unter 0) – Kanäle mit weniger als 5 Abstand überlappen. Steht das eigene Netz auf einem anderen Kanal (z. B. 3), Hinweis `overlap` („überlappt 1 und 6“). Immer Hinweis `nonWifiInterference` („Störungen außerhalb des WLANs – Mikrowelle, Bluetooth, Funk-Kameras – sieht der Scan nicht“).
- **5 GHz:** bewertet werden 80-MHz-Blöcke 36–48, 52–64, 100–112, 116–128 (Last = Σ w aller Netze, deren belegter Bereich den Block berührt). 52–64 und 100–128 sind **DFS**-Kanäle (`dfs`: Der Router muss bei Radar kurz wechseln, dann sind kurze Aussetzer möglich). 116–128 enthält in der EU die Wetterradar-Kanäle 120/124/128 (bis zu 10 min Kanalprüfung beim Umstellen): nur empfohlen, wenn er um mindestens 1,0 besser ist als jeder andere Block, dann mit Hinweis `dfsWeather`. 36–48 wird bevorzugt, wenn seine Last höchstens 0,5 über dem besten Block liegt. Kanäle ab 149 werden nicht empfohlen (je nach Land und Router eingeschränkt).
- **6 GHz:** nur die PSC-Kanäle des in der EU freigegebenen unteren Teils: **5, 21, 37, 53, 69, 85**; Last je Kanal wie bei 5 GHz.
- Bewertung: `improvement = "clear"`, wenn Last(aktuell) − Last(empfohlen) ≥ 1,0 und Last(empfohlen) ≤ ½ Last(aktuell); `"small"` ab 0,3; sonst `"none"` („Dein Kanal ist schon gut gewählt.“). Gleichstand → aktueller Kanal, sonst der kleinere.
- Ohne WLAN-Verbindung: Belegung für alle Bänder mit Netzen, beschriftet „falls dein Router in diesem Band funkt“ (`noConnection`).
- Hauptverbindung per Kabel (`wiredPrimary`): Hinweis `wiredPrimary` („Du spielst per Kabel – der WLAN-Kanal betrifft nur deine anderen Geräte.“).
- `ChannelAdvice` = `{ band, current: number|null, recommended, widthMhz, dfs: bool, loadCurrent: number|null, loadRecommended, alternatives: number[], improvement: "none"|"small"|"clear", notes: ("overlap"|"dfs"|"dfsWeather"|"noConnection"|"band24Crowded"|"cacheOnly"|"ownExtraSsids"|"wiredPrimary"|"nonWifiInterference")[] }`.

**Raum-Scan** (nur Oberfläche, `lib/rooms.ts` rein, `store/wifiscan.ts`): kv `wifi.rooms` = `{ v: 1, rooms: [{ id, name, samples: [{ t, rssi, signal, bssid /*nur eigener Zugangspunkt*/, band, channel, linkMbps, gatewayMs, gatewayLoss }] }] }`, höchstens **20 Räume** (Name ≤ 40 Zeichen) mit je **10 Messungen** (älteste fällt heraus). „Hier messen“: 5 × `net_wifi_state()` im Abstand von 1 s (Median von RSSI/Signal/Verbindungsrate `linkMbps` = `WifiInfo.rxMbps`) und `net_ping_once({ id: "gateway", label: "Router", host: <Gateway>, method: "icmp" }, 4)` zum Router; Dauer ≈ 6 s. Bewertung eines Raums = Median-RSSI seiner letzten 3 Messungen: ≥ −60 „sehr gut“, ≥ −67 „gut“, ≥ −75 „mäßig“, darunter „schwach“. Je Raum wird das **Band** angezeigt; Rangliste **je Band**; „Bester Platz“ = höchster Median-RSSI innerhalb eines Bands, bei Gleichstand höhere `linkMbps`, dann kleinerer Router-Ping. Gemischte Bänder → Hinweis „verschiedene Bänder – Datenrate vergleichen“. Fester Hinweis: „Werte gelten für dieses Gerät; Konsole/Handy haben andere Antennen. Sinnvoll mit einem Laptop.“ Ohne WLAN-Verbindung ist der Knopf gesperrt („Nur mit WLAN-Verbindung“); bei `state = "locked"` Erklärung der Standortsperre.

**Oberfläche:** Netzwerk › neuer Tab **„WLAN“** (`wifi`): Netzliste (Name, Signal-Balken, dBm, Kanal, Band, Breite, Standard, Schloss, Alter), Kanalbelegung je Band als Balken (eigenes Netz markiert), Karte „Empfehlung für deinen Router“ mit den Hinweisen, Abschnitt „Raum-Scan“ (Räume anlegen/umbenennen/löschen, messen, Rangliste mit „Bester Platz“). **Standortsperre:** Erklärung + Knopf „Windows-Einstellungen öffnen“ (`open_url("ms-settings:privacy-location")`); dazu: „Beim ersten Mal fragt Windows ggf. einmal nach. Ist der Schalter grau, regelt das deine Organisation (verwaltetes Gerät).“ **Aktualisieren:** aktiver Scan (`refresh = true`) nur beim Öffnen des Tabs und per Knopf – **nie**, solange ein Spiel läuft (`running_games` nicht leer; dann nur Zwischenspeicher mit Hinweis „Kein aktiver Scan während eines Spiels“); solange der Tab sichtbar ist zusätzlich alle 30 s `refresh = false`.

**Demo (Demo-Backend):** 14 feste Netze (2,4 GHz auf 1, 1, 3, 6, 6, 6, 11; 5 GHz 36/80 MHz, 44, 100 DFS; 6 GHz 37; ein verstecktes Netz und ein „Gast“-Netz mit BSSID-Familie des eigenen Routers). Eigenes Netz „FRITZ!Box 7590 XK“ auf **5 GHz, Kanal 44**, mit derselben BSSID wie Demo-`net_wifi` (verbunden), dieselbe SSID zusätzlich auf 2,4 GHz Kanal 6 (−60 dBm). Demo-Schalter `__pulsarWifiPrimary` → Hauptverbindung WLAN und verbunden mit dem 2,4-GHz-Zugangspunkt (Kanal 6, −60 dBm; `net_wifi`/`net_wifi_state` passend) – für die Screenshots 20b–20e. `__pulsarWifiLocked` → `state = "locked"` und Sperr-Fehler, `__pulsarNoWifi` → `noService`/`interfaces = 0`. Mock-kv `wifi.rooms` vorbelegt mit 3 Räumen („Schreibtisch“ −52, „Wohnzimmer“ −63, „Balkon“ −78, alle 5 GHz); neue Messungen variieren deterministisch je Raumname (Hash → RSSI-Versatz).

**Tests:** cargo `wifiscan::tests::channel_from_khz_all_bands` (inkl. 5935 MHz → 2), `…::parse_width_ht_vht_he_eht`, `…::parse_width_bad_lengths_none`, `…::ie_bounds_check`, `…::secured_bit`, `…::dedupe_strongest_bssid`, `…::wlan_error_kind_codes` (1062 → noService, 5 → locked), `…::access_denied_text`. vitest `wifichan.test.ts`: nur 1/6/11 bei 2,4 GHz, Überlappung (Kanal 3), Gewichte an den Grenzen, eigene SSID zählt nicht, Gast-/Hotspot-SSID derselben BSSID-Familie zählt nicht (`ownExtraSsids`), fremde BSSID zählt, DFS-Vorzug 36–48, `dfsWeather`, keine Empfehlung ≥ 149, 6 GHz nur PSC 5–85, `improvement`-Grenzen, Gleichstand, `wiredPrimary`, `nonWifiInterference`, jede Note hat Texte in de und en; `rooms.test.ts`: Bewertungsgrenzen, Rangliste je Band, Gleichstand über `linkMbps`, gemischte Bänder, Grenzen 20/10, Namen kürzen, Router-Ziel `satisfies PingTarget` (mit `label`). **Selbsttest:** `wlan-netze` (`net_wifi_scan(false)` und `net_wifi_state()`: `Ok` oder Sperr-Fehler gelten als sauber; Detail „n Netze“, „kein WLAN-Dienst“ oder „Ortung gesperrt“). **Screenshots:** `20b-netzwerk-wlan-scanner`, `20c-netzwerk-raum-scan`. **Doku:** `docs/ANLEITUNG.md` FAQ „Warum braucht der WLAN-Scanner die Ortung?“.

**Wichtig (ehrlich):** Pulsar stellt keinen Kanal um – **den Kanal stellst du im Router selbst um** (meist unter WLAN › Funkkanal). Viele Router wählen den Kanal automatisch; eine feste Einstellung lohnt nur, wenn die Automatik schlecht wählt. Die Liste ist eine Momentaufnahme an diesem Ort (Nachbarnetze ändern sich), ohne frischen Scan kann sie veraltet sein. Ein aktiver Scan kann auf manchen Treibern kurz den Ping erhöhen – deshalb nie während eines Spiels. Seit Windows 11 24H2 gibt Windows WLAN-Daten nur mit Standortzugriff frei – Pulsar ermittelt damit keinen Standort und sendet nichts.

## „Warum laggt es?“ (Oberfläche `lib/diagnose.ts`, `store/diagnose.ts`, `pages/network/DiagnosePanel.tsx`)

**Zweck:** Eine geführte Prüfung (Verbindung, Router, Server, Route, Datenverkehr, Speedtest/Bufferbloat) mit klarer, regelbasierter Diagnose und konkreten Schritten.

Kein neuer Rust-Befehl außer den gemeinsamen (`net_wifi_state`, `net_metered`, `net_lag_snapshot`); der Ablauf benutzt vorhandene Befehle. Nur eine Prüfung gleichzeitig (Oberfläche): „Es läuft schon eine Prüfung.“ Abbrechen jederzeit (laufender Speedtest per `net_speedtest_cancel`; eine laufende Routen-Analyse wird abgewartet, ihr Ergebnis verworfen).

| Schritt (`DiagnoseStepId`) | Aufruf | Zeitlimit |
|---|---|---|
| `connection` | `net_adapters()`, `net_wifi_state()`, bei WLAN `net_wifi_scan(false)` (Zwischenspeicher), `net_metered()` | 8 s |
| `router` | `net_ping_once({ id: "gateway", label: "Router", host: <Gateway der Hauptverbindung>, method: "icmp" }, 20)` und `net_lag_snapshot(<Messziel>)` (Teilroute, VPN, Verbindungsart – als Zusatzauskunft „Erste Stationen“) | 10 s |
| `server` | Läuft der Live-Monitor auf demselben Ziel und hat ≥ 50 Messungen: dessen `PingStats` (letzte 60). Sonst `net_ping_once(<Messziel>, 20)` dreimal nacheinander (20 + 20 + 10 = **50** Messungen, `mergeStats` gewichtet nach Messungen). Dazu `net_regions_ping(<Lieblingsregionen>, 4)` | 20 s |
| `route` | `net_traceroute(<Host des Messziels>, 15)` | 45 s |
| `local` | `system_stats()` und `net_if_counters()` zweimal im Abstand von 2 s (Datenverkehr **vor** dem Speedtest) | 5 s |
| `speed` | `net_speedtest()` (Schalter „mit Speedtest“) | 40 s |

**Speedtest-Schalter:** Standard an; bei getakteter Verbindung (`net_metered() = true`) Standard **aus** mit Hinweis „Getaktete Verbindung – der Speedtest verbraucht Datenvolumen“. Am Schalter steht immer der ungefähre Verbrauch: „verbraucht je nach Leitung bis zu ≈ {mb} MB“ (`mb` = obere Grenze aus den festen Download-/Upload-Mengen von `speed.rs`, als Konstante `SPEEDTEST_MAX_MB` in `lib/diagnose.ts`, beim Bauen gegen `speed.rs` abgeglichen). Vom Nutzer abgewählt → Status `off` (zählt nicht als „unvollständig“).

Ein Schritt mit Fehler oder Zeitüberschreitung wird `failed` (Text angezeigt), ein nicht möglicher (`router` ohne Gateway, `route` außerhalb von Windows) `skipped`. Ein Teilergebnis zählt: Scheitert im Schritt `connection` nur der WLAN-Scan (z. B. gesperrt), fällt nur `wifiChannel`/`wifiBand24` weg, nicht `wifiWeak`. Gesamtzeit typisch 50–80 s. **Linux (Entwicklung):** ICMP wird dort zu TCP:443 (`effective_method`) – der Router-Ping ist dort „nicht bewertbar“.

**Routen-Auswertung** (`routeJump(hops, gateway)`): Zonen neu nach der **Zonenregel der Teilroute** (`lib/zones.ts`, CGNAT/doppeltes NAT – nicht die `zone` aus `net_traceroute`). `base` = kleinste Antwort der ersten antwortenden Station. Gesucht ist die erste Station k mit `min(rtts) − base >= 30` ms, nach der mindestens 2 weitere antwortende Stationen (inklusive Ziel) nicht mehr als 10 ms darunter liegen („bleibt erhöht“). Ergebnis: `home` (k in der Zone `lan` hinter dem Gateway – zweiter Router/Mesh), `isp`, `internet`, `target`, sonst `none`; ohne Antworten außer im LAN `notMeasurable`.

**Diagnose-Regeln** (`diagnose(input): DiagnoseResult`, rein; Schwellen exakt; „{x} von {n} Paketen“ = Verlust als Anzahl):

| Befund (`id`) | Bedingung | Diagnose | Schwere | Konkrete Schritte |
|---|---|---|---|---|
| `noLink` | keine Hauptverbindung oder kein Gateway | „Keine Netzwerkverbindung gefunden.“ | hoch | Kabel bzw. WLAN-Verbindung prüfen · Flugmodus aus · Router eingeschaltet? (Lämpchen) |
| `offline` | Gateway antwortet, aber Server, alle Regionen und Speedtest scheitern | „Hinter deinem Router kommt keine Verbindung zustande.“ | hoch | Internet-Lämpchen bzw. Status-Seite des Routers prüfen · Störungsseite des Anbieters per Handy ansehen · Router neu starten |
| `localTraffic` | Datenverkehr vor dem Speedtest `rx + tx > 5 Mbit/s` oder `> 30 %` des gemessenen Downloads | „Auf diesem PC läuft gerade Datenverkehr ({mbps} Mbit/s).“ | hoch | Downloads/Updates (Steam, Windows Update, Cloud-Sync) pausieren · im Ressourcenmonitor (`resmon`) › Netzwerk das Programm suchen · erneut prüfen |
| `bufferbloat` | `bufferbloatMs >= 60` (Note C oder schlechter); hoch ab 200 | „Unter Last steigt dein Ping um {ms} ms (Bufferbloat).“ | mittel/hoch | prüfen, ob andere Geräte gerade laden, streamen oder Backups hochladen · Downloads und Streams beim Spielen pausieren · im Router „SQM“, „Smart Queue“ oder QoS-Priorisierung einschalten, falls vorhanden · Upload-Grenzen in Backup-/Cloud-Programmen setzen |
| `wifiWeak` | WLAN und (`rssi < −70` oder `signal < 50`); hoch bei `rssi < −75` | „Dein WLAN-Signal ist schwach ({rssi} dBm).“ | mittel/hoch | näher an den Router oder freie Sicht · Router höher und frei aufstellen · LAN-Kabel, Powerline oder Mesh · Raum-Scan nutzen |
| `wifiBand24` | WLAN auf 2,4 GHz **und** der Scan zeigt das eigene Netz (gleiche SSID oder `sameRadio`-Familie) auf 5/6 GHz mit `rssi >= −70` | „Dein Router funkt hier auch auf 5 GHz ({rssi} dBm) – dort ist meist mehr Platz.“ | mittel | mit dem 5- oder 6-GHz-Netz verbinden (ggf. eigener Netzname) · Kanal im WLAN-Tab prüfen |
| `wifiChannel` | Kanal-Empfehlung für das eigene Band `improvement = "clear"` | „Dein WLAN-Kanal {current} ist stark belegt.“ | mittel | im Router Kanal {recommended} einstellen (WLAN › Funkkanal) · danach erneut prüfen |
| `routerSlow` | Router antwortet und (`avg > 10` ms per Kabel bzw. `> 20` ms per WLAN oder `jitter > 10` oder mindestens 2 von 20 verloren); hoch bei ≥ 2 verlorenen **und** `loss >= 0,1` oder `avg > 50` | „Schon die Strecke zum Router ist langsam/instabil.“ | mittel/hoch | Router neu starten · Kabel/Anschluss tauschen (per Kabel) bzw. WLAN-Schritte (per WLAN) · Router-Firmware aktualisieren · Geräte mit großer Last im Heimnetz prüfen |
| `homeRouterJump` | `routeJump = home` | „Die Verzögerung entsteht in deinem Heimnetz hinter dem ersten Router (zweiter Router oder Mesh).“ | mittel | Verbindung zwischen den Routern/Mesh-Knoten prüfen (Kabel statt Funk) · zweiten Router testweise umgehen |
| `serverLoss` | Server: mindestens **2** verloren und `loss >= 0,03` (bei 50 Messungen) **und** Router `loss = 0` **oder** Router nicht bewertbar (Textvariante ohne „Heimnetz ruhig“) | „Pakete gehen auf dem Weg zum Server verloren ({lost} von {n} Paketen).“ | mittel; hoch ab `loss >= 0,05` | prüfen, ob andere Geräte gerade laden, streamen oder Backups hochladen – pausieren und erneut prüfen · zu anderer Tageszeit wiederholen (Kalender) · Störung beim Anbieter melden: Uhrzeiten und Anbieter-Protokoll beifügen, Ticketnummer notieren · betrifft es nur einen Server, liegt es eher am Server |
| `ispPath` | `routeJump = isp`; hoch bei Sprung ≥ 60 ms | „Die Verzögerung entsteht vermutlich am Anschluss bzw. im Netz deines Anbieters – auch möglich: Leitung durch andere Geräte im Haushalt ausgelastet.“ | mittel/hoch | prüfen, ob andere Geräte gerade laden, streamen oder Backups hochladen – pausieren und erneut prüfen · zu anderer Tageszeit wiederholen (Kalender) · Störung beim Anbieter melden: Uhrzeiten und Anbieter-Protokoll beifügen, Ticketnummer notieren |
| `internetPath` | `routeJump = internet` oder `target` | „Die Verzögerung entsteht hinter deinem Anbieter (gemessen zu {target}, nicht zur Verbindung des Spiels).“ | mittel | im Tab „Regionen“ vergleichen · falls dein Spiel nähere Server hat, sie im Spiel wählen · Entfernung zum Server lässt sich nicht wegoptimieren |
| `serverFar` | Server `avg > 80` und eine Lieblingsregion ≥ 30 ms schneller | „{region} antwortet schneller ({ms} ms statt {cur} ms).“ | mittel | falls dein Spiel Server in dieser Gegend hat, wähle sie im Spiel · im Tab „Regionen“ vergleichen |
| `jitterHigh` | Server `jitter >= 12` (aus ≥ 50 Messungen) **und** (Router `jitter < 5` **oder** Router nicht bewertbar – Textvariante) | „Der Ping schwankt stark ({ms} ms), dein Heimnetz ist ruhig.“ | mittel | prüfen, ob andere Geräte gerade laden, streamen oder Backups hochladen – pausieren und erneut prüfen · zu anderer Zeit prüfen (Kalender) · Störung beim Anbieter melden: Uhrzeiten und Anbieter-Protokoll beifügen |
| `slowLine` | Maximal-Geschwindigkeit eingetragen und Download `< 0,5 ×` diese → mittel; per WLAN gemessen oder `localTraffic` → nur Hinweis mit Zusatz „per WLAN gemessen – WLAN ist oft der Engpass“; ohne Eintrag Download `< 10` Mbit/s → Hinweis | „{pct} % der eingetragenen Maximal-Geschwindigkeit ({mbps} Mbit/s).“ bzw. ohne Eintrag „Dein Download ist sehr niedrig ({mbps} Mbit/s).“ | mittel/Hinweis | per LAN-Kabel erneut messen · andere Geräte im Haushalt pausieren · Router neu starten · für Ansprüche: Breitbandmessung der Bundesnetzagentur (breitbandmessung.de) |
| `cpuHigh` | `cpu >= 90` | „Dein PC ist stark ausgelastet ({pct} %) – das kann sich wie Lag anfühlen (Ruckler), ist aber kein Netzproblem.“ | mittel | Hintergrundprogramme schließen · im Spiel ein FPS-Limit setzen bzw. CPU-lastige Optionen senken (Sichtweite, Physik) · Boost (räumt Hintergrundlast auf, ändert den Ping nicht) |
| `vpnActive` | `net_lag_snapshot` meldet `viaVpn` | „Ein VPN ist aktiv. Route- und Serverwerte gelten für den VPN-Weg.“ | Hinweis | VPN testweise trennen und erneut prüfen · VPN-Server in deiner Nähe wählen |
| `wifiLocked` | Hauptverbindung WLAN und `net_wifi_state` meldet `locked` | „WLAN-Werte gesperrt – die WLAN-Prüfungen fehlen.“ | Hinweis | Windows-Einstellungen öffnen (`ms-settings:privacy-location`) und den Standortzugriff für Desktop-Apps erlauben · danach erneut prüfen |
| `routerNoAnswer` | Router antwortet auf keinen der 20 Pings | „Dein Router beantwortet keine Pings – nicht bewertbar.“ | Hinweis | – (viele Router blocken Ping; kein Fehler) |
| `wifiBand24Maybe` | WLAN auf 2,4 GHz, eigenes 5/6-GHz-Netz im Scan nicht sichtbar (oder Scan nicht möglich) | „Falls dein Router 5 GHz anbietet, verbinde dich testweise damit.“ | Hinweis | im WLAN-Tab nachsehen, welche Bänder dein Router zeigt |
| `incomplete` | mindestens 2 der Schritte `router`, `server`, `route`, `speed` sind `failed`/`skipped` | „Prüfung unvollständig – {liste} ließ sich nicht messen, daher keine sichere Aussage.“ | Hinweis | Verbindung prüfen und erneut starten · ggf. später wiederholen |
| `allGood` | kein Befund mit Schwere hoch oder mittel und kein `incomplete` | „Keine klare Ursache gefunden.“ | ok | Lag-Detektiv im Spiel laufen lassen · Anbieter-Protokoll führen · die Netzgrafik des Spiels ansehen |

Bei ICMP-Messzielen (Valve/Riot) steht bei `serverLoss`/`jitterHigh` zusätzlich: „Manche Server drosseln Ping-Antworten.“ Bei `ispPath`/`jitterHigh`/`serverLoss` optional der Satz: „Ping und Paketverlust sind meist nicht vertraglich zugesichert.“ Die Breitbandmessung wird **nur** bei `slowLine` genannt (sie prüft Bandbreite, nicht Ping).

**Ergebnis:** `DiagnoseResult` = `{ at, verdict: FindingId, findings: { id, severity: "high"|"medium"|"info"|"ok", values: Record<string, number|string> }[], steps: { id: DiagnoseStepId, status: "done"|"skipped"|"failed"|"off", error?: string }[], input: DiagnoseInput }`. Sortierung: hoch vor mittel vor Hinweis vor ok, bei gleicher Schwere wie in der Tabelle. **`verdict`** = erster Befund mit Schwere hoch oder mittel; gibt es keinen: `incomplete`, falls vorhanden, sonst `allGood`. Hinweise stehen unter dem verdict und zählen zu den höchstens **4** angezeigten Befunden. Texte: `diagnose.finding.<id>` (Varianten `…<id>.noRouter`, `…slowLine.noContract`, `…slowLine.wifi`) und Schritte `diagnose.fix.<id>.<n>` (2–4 je Befund) in de und en. **`localTraffic` hier ≠ Lag-Detektiv:** Die Diagnose misst in Ruhe vor dem Speedtest (deshalb strenger, feste 5 Mbit/s), der Detektiv während des Spiels relativ zu Grundwert und Leitung (in `docs/FUNKTIONEN.md` in einem Satz erklärt).

**Letztes Ergebnis** in kv `diagnose.last` = `DiagnoseResult` **ohne** `input` (nur abgeleitete Werte in `findings[].values`, eigenes Band/Kanal/RSSI; kein WLAN-Scan, keine Adressen) – wird beim Öffnen gezeigt („Letzte Prüfung: …“). Der Speedtest landet wie jeder Speedtest im Anbieter-Protokoll (`net_events` `speedtest`).

**Oberfläche:** Netzwerk › neuer Tab **„Warum laggt es?“** (`diagnose`): Start-Knopf, Schalter „mit Speedtest“ (mit Verbrauchsangabe), Schrittliste mit Fortschritt (Speedtest-Fortschritt aus `net://speed`, Route aus `net://trace`), danach die Diagnose-Karte (große Aussage, Werte, nummerierte Schritte mit Verweisen wie „WLAN-Tab öffnen“, „Anbieter-Protokoll“, „Windows-Einstellungen öffnen“), darunter die Hinweise. Einstiege zusätzlich im Cockpit (Schnellzugriff) und in der Befehlspalette.

**Demo (Demo-Backend):** keine eigenen Befehle. Ohne Schalter (Hauptverbindung Ethernet, Demo-Speedtest mit Bufferbloat 34,6 ms) ergeben die Demo-Antworten **`allGood`** (die Screenshots 19/20 bleiben unverändert). Für die Screenshots setzt `scripts/feature-shots.mjs` `__pulsarWifiPrimary` (WLAN 2,4 GHz, −60 dBm, eigenes Netz auf 5 GHz mit −66 dBm sichtbar, Kanal 6 stark belegt) und `__pulsarDiagnoseDemo` (nächster Demo-Speedtest mit Latenz unter Last +78 ms) → deterministisch **`bufferbloat`, `wifiBand24`, `wifiChannel`** (verdict `bufferbloat`).

**Tests:** vitest `diagnose.test.ts`: je Regel ein Treffer und ein knapper Nicht-Treffer an jeder Schwelle (z. B. −70/−70,1 dBm, 60 ms Bufferbloat, 5 Mbit/s, 1 bzw. 2 von 50 verloren, 1 bzw. 2 von 20 beim Router), `routeJump` (bleibt erhöht / nur ein Ausreißer-Hop / nicht messbar / CGNAT bei TTL 2 = `isp` / Sprung hinter doppeltem NAT = `home`), `wifiBand24` mit und ohne sichtbares eigenes 5-GHz-Netz, `serverLoss`/`jitterHigh` bei Router ohne Antwort, `slowLine` mit/ohne Eintrag und per WLAN, `incomplete` (1 bzw. 2 fehlgeschlagene Schritte; `off` zählt nicht), `offline`, `noLink`, `vpnActive`, `wifiLocked` (Scan gesperrt → `wifiWeak` bleibt möglich), Sortierung und `verdict` („nur `routerNoAnswer` → verdict `allGood`, Befunde [`routerNoAnswer`, `allGood`]“), höchstens 4 Befunde, getaktete Verbindung → Speedtest-Standard aus, jeder `FindingId` hat Text und mindestens 2 Schritte in de und en, Demo-Antworten (mit Mock) → erwartete Befunde mit und ohne Demo-Schalter, Router-Ziel `satisfies PingTarget` (mit `label`); `store/diagnose` (mit Mock) bricht sauber ab, `diagnose.last` enthält kein `input`. **Screenshots:** `20d-netzwerk-warum-laggt-es-laeuft`, `20e-netzwerk-warum-laggt-es-diagnose` (Wartezeiten wie beim Speedtest). **Doku:** `docs/ANLEITUNG.md` (Schritt-für-Schritt „Warum laggt es?“), `docs/FUNKTIONEN.md`.

**Wichtig (ehrlich):** Die Diagnose ist eine regelbasierte Einschätzung aus einer Prüfung von etwa einer Minute – Lag, der nur zu bestimmten Zeiten auftritt, kann sie verpassen (dafür gibt es Lag-Detektiv und Anbieter-Protokoll). Pulsar sieht andere Geräte im Haushalt nicht. Lag kann auch vom Spielserver selbst kommen (Serverlast, Tickrate) – das kann Pulsar nicht messen. Pulsar ändert bei der Prüfung nichts an Windows oder am Router.

## Anbieter-Protokoll (`src/net/history_events.rs`, `src/net/recorder/events.rs`, `src/net/scope.rs`, Oberfläche `lib/isplog.ts`, `components/reports/IspLogSection.tsx`)

**Zweck:** Aussetzer, Paketverlust und langsame Messungen mit Uhrzeit dauerhaft protokollieren und als Bericht exportieren – mit dem ehrlichen Hinweis auf die offizielle Breitbandmessung der Bundesnetzagentur. Das Protokoll ist ein **Indiz, kein Nachweis**, und bewertet nichts juristisch.

| Befehl | Verhalten |
|---|---|
| `net_events_list(from, to, kinds?, netId?, limit=5000)` (`eventsList`) → `{ events: NetEvent[], truncated: boolean }` | Schreibt zuerst den offenen Puffer, liefert dann Ereignisse mit `from <= t <= to` (optional nur bestimmte `kind`, nur ein Netz), aufsteigend nach `t`; mehr als `limit` (höchstens 20 000) → die neuesten `limit` und `truncated = true`. Unbekannte `kind`-Werte werden ignoriert. Zeitraum höchstens 400 Tage, sonst „Ungültiger Zeitraum.“ Reine Datenbank. |
| `net_events_summary(from, to, netId?)` (`eventsSummary`) → `EventSummaryRow[]` | Zählungen ohne Grenze, gruppiert je UTC-Stunde: `{ hourStart, kind, cause, scope, connection, netId, rows, countSum, durationS }` (`countSum` = Summe von `detail.count` bzw. 1, `durationS` = Σ(`end_t − t`)/1000). Für Tageswerte (Ortszeit in der Oberfläche), Ausreißer nach Ursache und `LagSection`. |
| `net_history_clear("events")` | Protokoll leeren (siehe „Datenbank v2“) |
| `net_speedtest()` (vorhanden, **ergänzt**) | Nach jedem erfolgreichen Test schreibt das Backend zusätzlich ein Ereignis `speedtest` (`value` = Download, `detail` = `SpeedResult` + `{ connection, localMbps }` mit dem Datenverkehr vor dem Test, `net_id`/`connection` aus `PrimaryLink`); bei `history.record = false` wird nichts gespeichert. Schlägt das Speichern fehl, bleibt der Test trotzdem erfolgreich. Rückgabe unverändert. Setzt die Ruhezeit (siehe Grundlagen). |

**Ereignis-Definitionen** (Recorder, Hauptziel, rein testbar; nie während der Ruhezeit):

| `kind` | Wann | `t` / `endT` | `value` |
|---|---|---|---|
| `outage` (Aussetzer) | mindestens **3 Verluste in Folge** und mindestens **3 s** ohne Antwort (Lücken nach der Lückenregel zählen nicht) | erster Verlust / erste Antwort danach (stoppt der Monitor oder kommt eine Lücke: letzter Verlust) | Dauer in s |
| `loss` (Verlust) | am Ende jeder Kalenderminute bewertet über das Fenster der letzten **max(60 s, 20 Messungen)** ohne Aussetzer-Messungen und ohne Zeiten mit getrennter Verbindung: mindestens **20** Messungen, mindestens **2** verloren und Verlust **> 5 %**; direkt folgende Treffer verlängern das Ereignis | Beginn des ersten Fensters / Ende des letzten | höchster Fensterwert in %; `detail = { lost, n }` dieses Fensters |
| `slow` (langsam) | eine Kalenderminute mit mindestens **5** Antworten und Durchschnitt **> Schwelle**; Schwelle = `max(ispLog.slowMs, Median des Ziels der letzten 14 Tage + 50 ms)` (Median über die Stunden-Ø dieses Ziels und Netzes; weniger als 5 Messstunden → nur `slowMs`); folgende Minuten verlängern | Minutenbeginn / Ende der letzten Minute | höchster Minuten-Durchschnitt in ms; `detail = { threshold, minutes }` |
| `spike` (Ausreißer) | Live-Ausreißer-Regel; höchstens **ein** Eintrag je 10 s (`detail.count`) | Zeit des ersten Ausreißers / `null` | Antwortzeit in ms |
| `speedtest` | erfolgreicher `net_speedtest` | Zeitpunkt / `null` | Download in Mbit/s |
| `quiet` | Ruhezeit wegen Pulsars eigenem Speedtest/WLAN-Scan | Beginn / Ende | `null` |

**Umfang eines Aussetzers** (`OutageScope`, `src/net/scope.rs`): Beim dritten Verlust in Folge fordert der Recorder eine **Umfangsprüfung** an (`IngestActions.scope_check`, höchstens eine je Aussetzer, ≤ 2 s, in `spawn`/`spawn_blocking`): `PrimaryLink` frisch ermitteln, `GetIfEntry2` (`OperStatus`, `MediaConnectState`), 2 ICMP-Echos an das Gateway (600 ms) und je 2 ICMP-Echos an zwei unabhängige Hosts (`1.1.1.1`, `9.9.9.9`, 800 ms). Reine Entscheidung `scope::classify(&ScopeInput) -> OutageScope`:
- `pc` – Verbindung getrennt (`OperStatus ≠ Up` oder `MediaConnectState` getrennt), keine Hauptverbindung/kein Gateway, Hauptverbindung oder `net_id` hat sich während des Aussetzers geändert (WLAN-Wechsel, VPN verbunden, Adapter neu gestartet) – zählt **nie** als Aussetzer der Internetverbindung;
- `homeNetwork` – das Gateway antwortet nicht, obwohl es sonst antwortet (Router-Grundwert vorhanden);
- `internet` – Gateway antwortet (oder ist nicht bewertbar) und beide externen Hosts antworten nicht;
- `targetOnly` – mindestens ein externer Host antwortet (nur das Messziel ist weg, z. B. Server oder ICMP-Drosselung);
- `unknown` – Prüfung nicht möglich (kein Windows, Zeitlimit).
Wird während des Aussetzers eine Trennung erkannt (Zähler im Takt), wird `scope` auf `pc` gesetzt. Mit aktivem VPN steht `connection = "vpn"`; der Bericht markiert diese Einträge.

**Bericht (`lib/isplog.ts`, rein):** `buildIspLog({ events, summary, hourly, from, to, netId, contract, lang, timeZone })` → `{ header, days, html, csv }` (Ortszeit über `localParts`):
- **Netz:** Der Bericht gilt für **ein Netz** (Standard: das Netz mit der meisten Messzeit im Zeitraum, umschaltbar); Hinweis „Messungen aus {x} anderen Netzen sind nicht enthalten.“
- **Kopf:** Zeitraum, Zeitzone (z. B. „Europe/Berlin, UTC+2“), gemessene Ziele mit Messart (ICMP oder TCP:443), **Datenbasis** „{hours} Stunden Messzeit an {days} Tagen“, **Anteil per WLAN** („62 % der Messzeit per WLAN – Aussetzer können am WLAN liegen; für Aussagen zum Anschluss per Kabel messen“; ab 1 % immer genannt), Anteil mit VPN, eingetragene Vertragswerte („Maximal-Geschwindigkeit laut Vertrag (Produktinformationsblatt)“, optional „normalerweise verfügbar“, „minimal“), fester Satz „Pulsar sieht andere Geräte im Haushalt nicht – ihre Downloads und Streams können Verlust und Verzögerung verursachen.“
- **Je Tag** (Ortszeit): **Aussetzer der Internetverbindung** (nur `scope = internet`: Anzahl, Gesamtdauer); getrennt davon „Heimnetz/WLAN“ (`homeNetwork`), „nur Messziel“ (`targetOnly`), „PC getrennt/Standby“ (`pc`), „unklar“ (`unknown`); Verlust-Fenster („3 von 60 Paketen (5 %)“); langsame Minuten **je Ziel** mit Hinweis „Entfernung zum Server ist kein Anbieterfehler“; Ausreißer **nach Ursache**: „davon vermutlich Heimnetz/WLAN/PC: x · Anschluss/Anbieter: y · Internet: z · unklar: u“; Messstunden; Speedtests (niedrigster/Median-Download und -Upload, je Test Verbindungsart WLAN/Kabel und Cloudflare-Standort `server`; bei Eintrag zusätzlich „{pct} % der eingetragenen Maximal-Geschwindigkeit“ – **nur als Zahl**, ohne Bewertung).
- **Liste** aller Ereignisse außer `spike` mit lokaler Uhrzeit, Art, Umfang/Ursache, Verbindungsart (HTML höchstens 2 000 Zeilen mit Hinweis „weitere in der CSV“; CSV alle). Ausreißer erscheinen nur gezählt (nach Ursache), nicht als Zeilen. War `truncated`, steht im Bericht „Es wurden nicht alle Ereignisse geladen.“
- **Hinweis-Kasten** (immer, wörtlich in de/en unter `ispLog.bnetza.*`, Stand-Datum als Konstante `BNETZA_STAND = "2026-10"`): „Dieses Protokoll ist ein Indiz, kein Nachweis. Als Nachweis für Minderung oder Sonderkündigung (§ 57 Abs. 4 TKG) ist in Deutschland für **Festnetz-Anschlüsse** ein Messverfahren der Bundesnetzagentur vorgesehen – derzeit die Desktop-App der Breitbandmessung (breitbandmessung.de): PC per LAN-Kabel am Router, VPN aus, andere Geräte möglichst ungenutzt, eine Messkampagne aus 30 Messungen an 3 verschiedenen Kalendertagen (je 10, mit mindestens einem Tag Abstand zwischen den Messtagen) innerhalb von 14 Kalendertagen. Genaue, aktuelle Regeln stehen auf breitbandmessung.de (Stand: {stand}). Für Mobilfunk gibt es ein eigenes Verfahren. Pulsar gibt keine Rechtsberatung; Rat gibt es z. B. bei der Verbraucherzentrale, bei Streit bei der Schlichtungsstelle Telekommunikation der Bundesnetzagentur. Pulsar misst vor allem die Antwortzeit zu Spiel- und Rechenzentrums-Servern, nicht die vertraglich zugesicherte Bandbreite; Pulsars Speedtest nutzt Cloudflare und ist kein zertifiziertes Messverfahren.“ Englisch mit ausdrücklichem Länderbezug („in Germany …“). Bei Aussetzern der Internetverbindung zusätzlich: „Störung beim Anbieter melden und Ticketnummer notieren.“ (ohne Anspruchsbewertung).
- **HTML:** eine Datei, druckbar (A4, `@media print`), alles inline (CSS, keine Skripte, keine externen Bilder/Schriften); der einzige Link ist `https://breitbandmessung.de`. Speichern über „Datei-Export“; als PDF über „Drucken“ im Browser.
- **CSV:** UTF-8 mit BOM, Trennzeichen `;`, Spalten `zeit_lokal;zeit_utc;ende_lokal;art;umfang;ziel;messart;verbindung;wert;einheit;verloren;messungen;ursache;sitzung` (de) bzw. englische Spaltennamen (en), Zeiten ISO 8601 mit Versatz, Zahlen mit Punkt; Felder mit `;`, `"` oder Zeilenumbruch in Anführungszeichen (`"` verdoppelt). Keine Netz-Kennung, keine Adressen.

**Daten holen (`components/reports/IspLogSection.tsx`):** `net_events_list(from, to, ["outage","loss","slow","speedtest","quiet"], netId, 20000)` (ohne Ausreißer – die zählt `net_events_summary`), `net_events_summary(from, to, netId)`, `net_history_hourly(from, to, undefined, netId)`.

**Einstellungen** (`Settings.ispLog`): `slowMs: 100` (30–1000), `contractDownMbps: null` (Maximal-Geschwindigkeit Download), `contractUpMbps: null` (Maximal Upload), `contractDownNormalMbps: null`, `contractDownMinMbps: null` (je 1–10 000 oder `null`). (`Settings.history`): `record: true` („Messverlauf dauerhaft speichern“).

**Oberfläche:** Berichte › Abschnitt „Anbieter-Protokoll“ (Route `{ page: "reports", section: "isp" }`, auch ohne Berichte erreichbar): Netz-Auswahl, Zeitraum 7 / 30 (Standard) / 90 Tage, Kennzahlen (Aussetzer der Internetverbindung, andere Aussetzer, Verlust-Fenster, langsame Minuten, Speedtests), WLAN-Anteil, Tagesbalken, Ereignisliste, Knöpfe „Bericht speichern (HTML)“ und „Als CSV speichern“, Hinweis-Kasten mit Knopf „breitbandmessung.de öffnen“ (`open_url`). Einstellungen › Monitor: „Momentaufnahmen bei Ausreißern“, „Langsam ab … ms“, „Maximal-Geschwindigkeit laut Vertrag (Produktinformationsblatt): Download/Upload (Mbit/s)“, optional „normalerweise verfügbar“/„minimal“, „Messverlauf dauerhaft speichern“ und die Zeile „Gespeichert wird lokal: Ping-Statistik je Stunde (400 Tage), Ereignisse (bis 365 Tage), Rohdaten der letzten 50 Runden (90 Tage). Nichts verlässt den PC.“ Einstellungen › Daten: „Messverlauf löschen“ (`net_history_clear("all")`) mit Rückfrage: „Ältere Datenbank-Sicherungen enthalten den Verlauf noch, bis sie ersetzt werden (spätestens nach 10 weiteren Sicherungen).“

**Demo (Demo-Backend):** 30 Tage deterministische Ereignisse als Funktion von (lokalem Wochentag, Stunde, Seed 1337), ein Netz per Kabel mit 8 % WLAN-Anteil: 4 Aussetzer (2 `internet`, 1 `homeNetwork`, 1 `pc`), 9 Verlust-Fenster, 12 langsame Minuten, 40 Ausreißer (gemischte Ursachen inkl. `unknown`), 6 Speedtests mit **410–470 Mbit/s** bei eingetragener Maximal-Geschwindigkeit **500** (Demo-Einstellungen `ispLog.contractDownMbps = 500`, passend zum Demo-Speedtest 412–472 Mbit/s) und passende `ping_hourly`-Daten; Speedtests im Demo-Backend werden ebenfalls protokolliert; `net_history_clear` leert die Demo-Daten (localStorage).

**Tests:** cargo `recorder::tests::outage_needs_3_losses_and_3s` (auch 250-ms-Takt), `…::outage_suppressed_after_sleep_gap`, `…::link_down_outage_is_pc`, `…::loss_needs_2_lost_and_20_samples` (Takte 250 ms, 1 s, 10 s), `…::loss_excludes_outage`, `…::slow_threshold_relative_to_target`, `…::consecutive_minutes_extend_event`, `…::spike_one_row_per_10s`, `scope::tests::outage_scope_gateway_down`, `…::scope_internet_vs_target_only`, `…::scope_link_change_is_pc`, `recorder::tests::speedtest_is_logged` (ohne Netz mit eingespeistem Ergebnis), `history_events::tests::kinds_filter_limit_order_truncated`, `…::summary_counts_by_hour_cause_scope`. vitest `isplog.test.ts`: Tageswerte in Ortszeit über die Sommerzeit-Grenze (`timeZone = "Europe/Berlin"`), nur `scope = internet` zählt als „Aussetzer der Internetverbindung“, Ausreißer nach Ursache mit „vermutlich“, Netzfilter mit Hinweis auf andere Netze, WLAN-Anteil im Kopf, Verlust als „x von n Paketen“, langsame Minuten je Ziel, Vertragsprozent nur mit Eintrag und nur als Zahl, CSV-Maskierung, BOM und Spalte `verbindung`, HTML enthält den Hinweis-Kasten wörtlich (de/en, mit Festnetz, Abstand der Messtage, Stand), keine `<script>` und keine externen Quellen außer dem Link, die Wörter „Beweis“/„proof“ kommen nicht vor, kein MAC-/IPv4-/SSID-Muster, `truncated`-Hinweis. **Screenshot:** `23f-berichte-anbieter-protokoll`. **Doku:** `docs/FUNKTIONEN.md` (Berichte), `docs/ANLEITUNG.md` FAQ „Kann ich damit meinem Anbieter etwas nachweisen?“.

**Wichtig (ehrlich):** Pulsar bewertet nichts juristisch und nennt das Protokoll nie „Beweis“. Es zeigt nur, was Pulsar gemessen hat, solange es lief – mit Messziel, Messart, Netz und Verbindungsart. Aussetzer am PC (Standby, Kabel gezogen, WLAN-Wechsel, VPN) und nur des Messziels werden getrennt ausgewiesen; nur Aussetzer, bei denen auch zwei unabhängige Internet-Hosts nicht antworteten, heißen „Aussetzer der Internetverbindung“. Pulsar sieht andere Geräte im Haushalt nicht. Ein Protokoll per WLAN ist ein schwaches Indiz für den Anschluss. Für Ansprüche gegenüber dem Anbieter zählt die offizielle Breitbandmessung.

## Gemeinsam für die 7 Funktionen

**Neue feste Fehlersätze des Backends** (wörtlich; in `BACKEND_TEXTS`/`BACKEND_PATTERNS` mit Schlüssel `backend.*`):
- „Für diese Sitzung gibt es keine Messwerte.“ (`backend.noSamples`)
- „Ungültiger Zeitraum.“ (`backend.badRange`)
- „Unbekannter Bereich.“ (`backend.badScope`)
- „WLAN-Daten gesperrt: Windows gibt sie nur mit Standortzugriff frei. Bitte unter Einstellungen › Datenschutz und Sicherheit › Standort die Standortdienste und „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.“ (`backend.wifiLocked`)
- „Dateityp nicht erlaubt.“ (`backend.fileType`), „Datei ist zu groß.“ (`backend.fileTooBig`), „Ungültiger Speicherort.“ (`backend.badPath`)
- „Datei konnte nicht gespeichert werden: {value}“ (`backend.saveFailed`, Muster)
- vorhanden und weiter benutzt: „Nur unter Windows verfügbar.“ (`backend.notWindows`; **nicht** für `net_wifi_scan` – der liefert außerhalb von Windows eine leere Liste)

Texte nur der Oberfläche (de/en, kein Backend-Satz): „Es läuft schon eine Prüfung.“, „Zu wenig Daten für eine Empfehlung …“, „Kein deutlicher Unterschied …“, „Keine WLAN-Schnittstelle gefunden.“, „Für diesen Bericht gibt es nur die verdichtete Kurve.“, „Kein aktiver Scan während eines Spiels“.

**Neue Befehle (Übersicht):** `export_file`, `net_if_counters`, `net_lag_snapshot`, `net_lag_recent`, `net_session_timeline`, `net_history_hourly`, `net_events_list`, `net_events_summary`, `net_history_clear`, `net_wifi_scan`, `net_wifi_state`, `net_metered`. Event `net://lag`. Geändert: `running_games()` (+`sessionId`), `net_speedtest` (protokolliert, setzt Ruhezeit), `kv_set("settings")` (spiegelt in den Recorder), `PingTarget.label` bekommt `#[serde(default)]` (rückwärtskompatibel; die Oberfläche schickt trotzdem immer ein `label`).

**Einstellungen** (`Settings`, je Unterobjekt eigene Ergänzung/Kappung in `mergeSettings` über `lib/settings/<ns>.ts`, fehlende Felder = Standard):

| Schlüssel | Standard | Bereich | Ort in den Einstellungen |
|---|---|---|---|
| `lag.snapshots` | `true` | – | Monitor |
| `sonar.volume` | `0.5` | 0–1 | Ton › Hör dein Netz |
| `sonar.pitch` | `true` | – | Ton › Hör dein Netz |
| `sonar.alertInGame` | `false` | – | Ton › Hör dein Netz |
| `sonar.alertVolume` | `0.15` | 0,05–0,3 | Ton › Hör dein Netz |
| `ispLog.slowMs` | `100` | 30–1000 | Monitor |
| `ispLog.contractDownMbps`, `ispLog.contractUpMbps` | `null` | 1–10 000 oder `null` | Monitor (Maximal-Geschwindigkeit laut Vertrag) |
| `ispLog.contractDownNormalMbps`, `ispLog.contractDownMinMbps` | `null` | 1–10 000 oder `null` | Monitor (optional) |
| `history.record` | `true` | – | Monitor |

kv (schreibt die Oberfläche, nicht in `MANAGED_KV_KEYS`): `wifi.rooms`, `diagnose.last`.

**Platz in der Oberfläche:** `NetworkTab` (`store/ui.ts`) und `TABS` (`pages/Network.tsx`) um `wifi` und `diagnose` erweitert, **hinter** `connection` in dieser Reihenfolge; `components/ui/Tabs.tsx` scrollt waagerecht (`overflow-x-auto`), damit 7 Tabs bei 960 px passen. Berichte: `route.section` = `rounds` (Standard, bisherige Ansicht), `calendar`, `isp`, `lag`, `session` (Detail per Sitzungs-ID); Detail eines Berichts über `route.id`. Die Seite zeigt Kalender, Protokoll und Ausreißer auch ohne Berichte. Mindestfenster 960 × 600 bleibt.

**Selbsttest** (`selftest.rs`, Block „6) Netzwerk“, ohne Adminrechte, CI-sicher):
- `adapter-zaehler`: zweimal `net_if_counters` im Abstand von ≈ 1 s mit einer TCP-Messung dazwischen. Unter Windows `Some` und `rxBytes` nicht kleiner – **nur**, wenn `net_adapters` eine Hauptverbindung meldet; sonst `Ok` mit Detail „keine Hauptverbindung“.
- `teilroute`: `quick_hops` bis 3 Stationen, `Ok` auch bei leerer Liste; Detail mit Zahl der antwortenden Stationen.
- `lag-momentaufnahme`: `net_lag_snapshot`, `cause` ist ein gültiger Wert, kein Fehler.
- `wlan-netze`: `net_wifi_scan(false)` und `net_wifi_state()`; `Ok` oder Sperr-Fehler gelten als sauber; Detail „n Netze“, „kein WLAN-Dienst“ oder „Ortung gesperrt“.
- `getaktet`: `net_metered()` antwortet (`Ok`, Wert egal).
- `messwerte-speichern`: gegen eine temporäre Datenbank (siehe „Datenbank v2“).
- `export-datei`: siehe „Datei-Export“.
Der Name des CI-Schritts in `.github/workflows/windows.yml` wird ergänzt.

**Screenshots** (`scripts/feature-shots.mjs`, Einschübe ohne Umnummerierung, Demo-Daten deterministisch, keine Konsolenfehler): `02c-cockpit-lag-detektiv` (mit Knopf „Hör dein Netz“), `20a-netzwerk-lag-detektiv` (Karte unter Verbindung, aufgeklappt), `20b-netzwerk-wlan-scanner`, `20c-netzwerk-raum-scan`, `20d-netzwerk-warum-laggt-es-laeuft`, `20e-netzwerk-warum-laggt-es-diagnose`, `23b-berichte-ausreisser-ursachen`, `23c-berichte-zeitleiste`, `23d-berichte-bildkarte`, `23e-berichte-kalender`, `23f-berichte-anbieter-protokoll`, `24b-einstellungen-hoer-dein-netz`, `25b-einstellungen-messverlauf-vertrag`.

**Doku:** je Funktion `docs/FUNKTIONEN.md` und `docs/ANLEITUNG.md` (siehe Abschnitte); außerdem `README.md` („Funktionen auf einen Blick“ `:15-25`, `--selftest`-Beschreibung `:57`), `docs/TESTBERICHT.md` (neue cargo-/vitest-Anzahlen, Selbsttest-Tabelle, Zahl der Screenshots, „Nicht geprüft“: WLAN-Scan auf echter Hardware, 24H2-Standortsperre, Raum-Scan, Ton im versteckten Fenster, TTL-Antworten der Teilroute im echten Heimnetz, Getaktet-Erkennung auf Mobilfunk).

**Texte-Tests:** Der vorhandene Übersetzungstest prüft nur wörtliche `t("…")`-Aufrufe; für dynamische Schlüssel (`lag.cause.*`, `lag.reason.*`, `diagnose.finding.*`, `diagnose.fix.*`, `wifiScan.note.*`, `ispLog.kind.*`, `ispLog.scope.*`) hat jede Funktion einen eigenen Test, der alle Werte in de und en prüft.
