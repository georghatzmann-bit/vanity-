# PULSAR – Testbericht

Ehrliche Übersicht: Was wurde wie geprüft, was läuft automatisch auf einem echten Windows-Rechner (GitHub-CI),
und was konnte bisher nicht geprüft werden.

## 1. Automatisch bei jedem Push (GitHub Actions, Windows)

Workflow `.github/workflows/windows.yml` auf `windows-latest`:

| Schritt | Was wird geprüft |
|---|---|
| Typprüfung | `tsc` für App und Installer – 0 Fehler |
| Oberflächen-Tests | `vitest`: Verbindungsnote, Ping-Statistik (Jitter, Verlust, Spitzen, Verdichtung), Bufferbloat-Note, Suche, Doppelte, Einstellungen-Reparatur, Spielserver-Erkennung, Übersetzungen (Schlüssel + Platzhalter DE/EN) |
| Rust-Tests | `cargo test` für App und Installer auf Windows: Datenbank, Scanner, Bilder, Netzwerk-Logik (Statistik, DNS-Pakete, SDR-JSON, Regionen, Routen-Zonen), Optimierer (powercfg-Parsing, Registry-Sicherungen, Tweaks an/aus/rückgängig, Boost start/stop), Installer (Manifest, Pfade, Prüfsummen) |
| Bauen | `npm run build:all` → `Pulsar.exe`, `Pulsar-Setup.exe`, `latest.json`, `SHA256SUMS.txt` |
| App-Starttest | Startet `Pulsar.exe`, wartet 18 s, zwei Screenshots, prüft, dass sie nicht abstürzt |
| Installer-Starttest | Startet `Pulsar-Setup.exe`, Screenshot nach 9 s |
| Installer-Selbsttest | `--selftest`: lädt die App von einem lokalen Testserver, prüft SHA-256, installiert, legt Verknüpfungen und den Eintrag in „Apps & Features“ an, deinstalliert wieder |
| App-Selbsttest | `Pulsar.exe --selftest`: Steam-Scan (nachgebaute Steam-Installation), Startmenü/Epic/GOG-Scan, Steam-Bilder (Cover, Hintergrund, Logo, Icon), Bilder per Name, Exe-Icon, Icon aus Ordner, PC-Auslastung, **Regionenliste, TCP-Ping, ICMP-Ping, Regionen-Ping, CS2-Spielserver (Valve-API), DNS-Vergleich, aktueller DNS, Adapter, WLAN, Route, Tweaks lesen, Energiepläne, Boost an → Boost aus (alter Energieplan muss zurück sein)**, Programm starten, „läuft gerade“ erkennen, beenden, Spielzeit gespeichert |
| Release | Nur wenn alles grün ist: Dateien ins Release `pulsar-latest` |

Ergebnis des letzten Laufs: siehe `https://github.com/georghatzmann-bit/vanity-/actions` (Eintrag „Windows Build & Test“) –
die Selbsttest-Berichte (`selftest.json`, `app-selftest.json`) und Screenshots liegen im Artefakt `pulsar-windows-<version>`.

Echte Screenshots vom Windows-Rechner der CI (1024×768, englische Systemsprache, noch keine Spiele installiert – darum das „Spiele finden“-Banner):

![Pulsar auf Windows](screenshots/windows-app-cockpit.png)
![Pulsar Setup auf Windows](screenshots/windows-setup-willkommen.png)

### Was der App-Selbsttest auf dem GitHub-Windows-Rechner wirklich gemessen hat (13.10.2026)

| Prüfung | Ergebnis |
|---|---|
| Steam-Scan | Portal 2 gefunden (nachgebaute Steam-Installation) |
| Startmenü/Epic/GOG-Scan | 46 Einträge (7-Zip, Firefox, …) |
| Steam-Bilder | Cover, Hintergrund, Logo, Icon geladen; Bilder per Name: Hades II → Steam-ID 1145350 |
| Exe-Icon, Icon aus Ordner | ok |
| PC-Auslastung | CPU 40 %, RAM 16 GB, GPU-Wert vorhanden |
| Regionen | 29 Regionen, alle 7 Erdteile |
| TCP-Ping (1.1.1.1:443) | Ø 19 ms, Schwankung 0,7 ms, 0 % Verlust |
| ICMP-Ping | 100 % Verlust – die Azure-Firewall des Runners blockt ICMP; der Aufruf bleibt sauber (kein Absturz) |
| Regionen-Ping | 3/3 Regionen geantwortet |
| Echte Spielserver (CS2) | 44 Valve-Standorte live von der Steam-API geladen |
| DNS-Vergleich | 5/7 Dienste geantwortet (UDP 53 teilweise geblockt) |
| Adapter | im ersten Lauf 0 (Hyper-V-Adapter wurde als „virtuell“ aussortiert) → behoben: in VMs zählt der virtuelle Adapter mit Gateway |
| WLAN | kein WLAN (erwartet) |
| Route | 8 Stationen, Ziel nicht erreicht (ICMP-TTL-Antworten geblockt) – Aufruf sauber |
| Tweaks lesen | powerPlan=on, gameMode=unknown, gameDvr=unknown (Werte auf frischem Windows nicht vorhanden), mouseAccel=off |
| Energiepläne | Balanced, High performance (aktiv), Power saver |
| Boost an | Energieplan ok, Priorität „kein Spiel“ (ehrlich gemeldet), DNS geleert |
| Boost aus | Energieplan vorher = nachher (8c5e7fda-…) – Rückstellung funktioniert |
| Starten / erkannt / beenden / Spielzeit | PING.EXE gestartet, nach 0,5 s erkannt, beendet, 13 s in 1 Sitzung gespeichert |

### Neues Setup „Radioteleskop“ auf Windows (CI-Lauf 38565471990, 14.10.2026, Commit `de91e53`)

Lauf: <https://github.com/georghatzmann-bit/vanity-/actions/runs/38565471990> – alle Schritte grün, Release `pulsar-latest`
aktualisiert. Installer-Selbsttest 9/9 (Manifest, Download, SHA-256, Installation, Dateien, Verknüpfungen, „Apps & Features“,
Deinstallation mit `--revert-all`, alles entfernt), App-Selbsttest 29/29. Der Screenshot oben zeigt das neue Setup nach 9 s
auf Windows Server 2025 (englische Systemsprache). Dort sind die Windows-Animationen ausgeschaltet – das Setup zeigt deshalb
richtig das **Standbild** („Still image“) statt des drehenden Sterns: „Bewegung reduzieren“ wird beachtet.

### DNS-Automatik und Netzwerk-Optimierungen auf Windows (CI-Lauf 38478061410, 13.10.2026, Commit `1a375a5`)

Lauf: <https://github.com/georghatzmann-bit/vanity-/actions/runs/38478061410> – alle Schritte grün, auch die Rust-Tests
auf Windows (seit das Manifest in die Test-Programme eingebettet wird). Werte aus `app-selftest.json` im Artefakt:

| Prüfung | Ergebnis |
|---|---|
| Admin-Helfer per Kommandozeile | ungültiger Auftrag → Exit-Code 20 (abgelehnt), gültiger Auftrag → Exit-Code 0 |
| DNS-Vergleich | 6 von 8 Diensten haben geantwortet |
| Aktueller DNS vorher | „Ethernet 3“, automatisch vom Router (DHCP), Server 168.63.129.16 (Azure) |
| DNS einstellen (`net_dns_apply("cloudflare")`) | 1.1.1.1 + 1.0.0.1 eingetragen, als Cloudflare erkannt, Sicherung angelegt, Namensauflösung danach ok |
| DNS zurückstellen (`net_dns_restore`) | wieder automatisch (DHCP), 168.63.129.16, keine Sicherung mehr übrig |
| Netzwerk-Optimierungen | „Nagle aus“ und „Netzwerk-Drosselung aus“ angewendet, danach per `Pulsar.exe --revert-all` zurückgestellt: beide wieder „aus“ wie vorher, keine Sicherung übrig |
| TCP-Ping (1.1.1.1:443) | Ø 10 ms, Schwankung 1,2 ms, 0 % Verlust |

Ehrlich dazu: Der GitHub-Rechner läuft schon mit Adminrechten. Die **Windows-Abfrage (UAC) selbst** und das
**Ablehnen** der Abfrage wurden deshalb dort nicht durchgespielt – der Helfer lief direkt im eigenen Prozess.
Der Knopf „Netzwerk automatisch optimieren“ (`net_auto_optimize`/`net_auto_restore`) wird im Selbsttest nicht als
Ganzes aufgerufen; geprüft sind seine Bausteine (DNS einstellen/zurückstellen, Admin-Optimierungen, `--revert-all`)
und die Auswahl des besten DNS per `vitest` (`netauto.test.ts`).

## 2. Lokal geprüft (Linux-Entwicklungsumgebung)

| Was | Ergebnis |
|---|---|
| `npm run typecheck` (App + Installer) | 0 Fehler |
| `npm test` | App 53 Tests, Installer 237 Tests bestanden (Stand 14.10.2026) – Installer: Klang-Engine (Dispersions-Sweep, Pegelgesetz, Rhythmus→Ton-Überblendung, Pulsplanung mit Zittern/Aussetzern, **Melodie-Test**: alle Tonhöhen sind Obertöne von 173,7 Hz, keine nacheinander gespielten Töne verschiedener Höhe), Drehmodell, Fortschritt→Periode, Katalog/Koordinaten, Zahlenformate, Stern-Geometrie, Intro-Zeitachse (zwei Pulse genau 1337,3 ms auseinander), Ablauf-Logik, Texte de/en |
| `cargo test` App (Linux) | 205 Tests bestanden (Datenbank, Scanner, Bilder, Optimierer, Netzwerk, Admin-Helfer, DNS) |
| `cargo test` Installer (Linux) | 35 Tests bestanden (unverändert – das neue Setup ändert nur die Oberfläche) |
| `cargo xwin check --target x86_64-pc-windows-msvc` | Windows-Code (ICMP, IP Helper, WLAN, Registry, powercfg) kompiliert ohne Fehler |
| Browser-Rundgang App (Playwright, Demo-Backend) | Alle Seiten (Cockpit, Spiele, Spiel, Netzwerk ×5, Optimieren, Berichte, Einstellungen, Palette, Boost, 4 Themes, Overlay) ohne Konsolenfehler; 33 Screenshots |
| Browser-Rundgang Installer (Playwright, Demo-Backend, `scripts/installer-tour.mjs`) | Neues Setup „Radioteleskop“: Intro (Suche, Echtzeit, Zeitraffer, Signal erfasst), Überspringen per Taste (Willkommen nach 0,8 s), Willkommen, Ordner (auch ungültig), Optionen, Installation bei 5/42/66/90 %, Fertig mit Countdown, Fehler + Fortsetzen, Abbrechen + Fortsetzen, Update, Wartung, Deinstallation bis „Signal verloren“, Zurückstellen unvollständig, Deinstallations-Fehler, reduzierte Bewegung, Englisch, Ton aus (gespeichert), 150 % Skalierung – alle Szenen erreicht, keine Konsolenfehler. Intro ohne Überspringen: Willkommen nach 5,6 s |
| Strenge Prüfung des Setups | 3 unabhängige Prüfer (Art Director „wirkt generisch/billig?“, Bewegung Bild für Bild, Code) in 2 Runden; 107 Rohbefunde, davon 68 bestätigt und behoben (26 verworfen nach Prüfung) (u. a. Strahlen bei schneller Drehung als saubere hohle Kegel statt „Propeller“, ruhigere Polkappen, weicher Übergang der Belichtung, Fehlerdarstellung ohne Gelb, Typografie und Abstände) |

Dabei gefunden und behoben: eine Endlosschleife durch Store-Selektoren, die bei jedem Rendern neue Listen erzeugten
(Spiel-Seite, Seitenleiste), und ein verschachtelter Button im Cockpit.

## 3. Nicht geprüft (ehrlich)

- **Echte Windows-Laufzeit außerhalb der CI:** Ob `IcmpSendEcho` in deiner Firewall durchkommt, wie `powercfg` auf
  deinem Windows antwortet (Sprache/Codepage), ob dein Anti-Cheat die Priorität zulässt – das zeigt sich erst auf
  deinem PC. Alle diese Stellen melden Fehler als Text statt abzustürzen.
- **WLAN:** Der GitHub-Rechner hat kein WLAN. Der WLAN-Code wird dort nur „sauber antworten“ geprüft, nicht mit echten Werten.
- **Overlay über Vollbild-Spielen:** Funktioniert nur im Fenster-/randlosen Modus (technische Grenze ohne Grafik-Hook).
- **Speedtest-Zahlen:** hängen vom Cloudflare-Server und deiner Leitung ab; die Bufferbloat-Note ist eine Einschätzung, keine Labormessung.
- **Windows-Benachrichtigungen und Autostart** wurden nur per Code geprüft, nicht per Klick.
- **Klang des Setups und der App:** Die CI hört nichts. Geprüft sind Rezepte, Pegel und Zeitpunkte rechnerisch (vitest) und
  die Pegel einmal im Chromium-Browser gemessen. Wie es auf deinen Lautsprechern klingt (z. B. der Übergang vom Rhythmus
  zum Ton zwischen 24 und 48 Hz, der Abschluss-Akkord), ist nur von Hand auf Windows prüfbar.
- **Leistung des Sterns auf schwachen PCs:** Die automatische Qualitätsstufe (L2/L1/L0) ist eingebaut, aber nicht auf einer
  Windows-VM ohne Grafikkarte durchgemessen; die CI macht nur einen Screenshot des Setups nach 9 s.

## 4. Grenzen, die Pulsar offen nennt

- Kein eigenes Servernetz → kein „Ping-Umleiten“.
- Kein FPS-Zähler (kein Grafik-Hook, kein Anti-Cheat-Risiko).
- Keine Adminrechte → keine TCP-Stack-Tweaks, keine Dienste. Dafür: nichts, was dein System „kaputtoptimiert“.
