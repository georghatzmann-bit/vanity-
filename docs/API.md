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
