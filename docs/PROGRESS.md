# AEGIS Suite – Fortschritt

Stand: 2026-10-19 · **P0–P3 abgeschlossen** · nächste Phase: **P4 – Labor (Sandbox)**

## Werkzeug-Check (Entwicklungs-Container)

| Werkzeug | Gefunden | Bewertung |
| --- | --- | --- |
| Rust / Cargo | 1.97.0 (gepinnt) + Ziel `x86_64-pc-windows-msvc` | ok – Windows-Code lokal per `cargo clippy --target …` (ohne Linken) |
| Node / pnpm | 22.22.0 / 10.28.0 | ok |
| Tauri CLI | 2.12.3 (npm `@tauri-apps/cli`) | ok |
| WebKitGTK (Tauri unter Linux) | 2.52.6 nachinstalliert | ok – App läuft im Container unter Xvfb |
| WebView2 | nicht vorhanden (Linux-Container) | Windows-Teil → GitHub Actions `windows-latest`; Installer lädt WebView2 bei Bedarf |
| MSVC Build Tools / Windows SDK | nicht vorhanden | bewusst nicht per `xwin` geladen (Microsoft-Lizenz) → CI |
| NSIS | nicht vorhanden | Tauri lädt NSIS im Windows-CI-Build selbst |
| Chromium (Playwright) | 1194 (= Playwright 1.56.1) | ok – Playwright gepinnt |
| cargo-llvm-cov / cargo-deny | installiert / in CI | Abdeckung bzw. Lieferkette |
| ClamAV | nicht installiert | optional: Engine nutzt `clamscan`, wenn vorhanden; Tests ohne |
| YARA | YARA-X 1.21 als Crate | ok – keine Systeminstallation nötig |

## Phasen-Übersicht

| Phase | Inhalt | Status |
| --- | --- | --- |
| P0 | Fundament, Design-Tokens, Logo, Start-Animation | **erledigt** |
| P1 | Shell, Dashboard, Design-System | **erledigt** |
| P2 | Dienst + Pipe + Engine-Kern (ClamAV, Hashes, YARA-X, statische Analyse), Quarantäne | **erledigt** |
| P3 | Echtzeit-Wächter, Heuristik, Cheat-Logik, Whitelist, Dokument/Skript/Archiv, Berichte | **erledigt** |
| P4 | Sandbox Stufe 1+2 + Verhaltensbericht | **erledigt** (Windows-CI wird bestätigt) |
| P5 | Panic-Button, Speicher-Scan, Ransomware-Schutz, Datei-Safe | **erledigt** |
| P6 | Härtung, Persistenz, Treiber-Check, Kamera/Mikro/Zwischenablage/USB-Wächter | erledigt |
| P7 | Netzwerk, Firewall-Übersicht, Web-Schutz, Heimnetz, Leck-Check | in Arbeit |
| P8 | Defender-Schalter | offen |
| P9 | Tresor + Erweiterung | offen |
| P10 | Tools 1–11 | offen |
| P11 | Tools 12–22 + Animations-Feinschliff | offen |
| P12 | Privacy-Browser | offen |
| P13 | Setup-Bootstrapper, Uninstaller, Updater, Abschlusstests, deutsches README | offen |
| P14 | optional: ML-Modell, AMSI-Beobachter, Browser-Sandbox | offen |

## P0 – erledigt

1. [x] Werkzeuge geprüft, Linux-Abhängigkeiten für Tauri nachinstalliert
2. [x] Monorepo: pnpm-Workspace, Cargo-Workspace (Edition 2024, strikte Lints), Ordnerstruktur
3. [x] Tauri-2-App: CSP nur `'self'`, keine Capabilities, Navigationswächter, NSIS pro Nutzer (DE/EN)
4. [x] CLAUDE.md und Docs (ARCHITECTURE, SECURITY, DECISIONS D-001–D-018, LICENSES)
5. [x] `crates/core`: Goldene Regel als Typen – `ActionPlan`, `ConsentGate`, `Approval` →
       `ExecutionPermit`, zweite Bestätigung fürs endgültige Löschen, Ablauf = nichts tun,
       Prüfprotokoll mit Hash-Kette, Risikostufen, `DirSnapshot` für „Nichts ohne Ja“-Tests,
       EICAR zur Laufzeit, Mutations-Sperre (Clippy + Wächter-Test)
6. [x] `packages/ui`: Tokens dunkel/hell (WCAG AA geprüft), eigenes SVG-Logo, Start-Animation
       (~1,5 s, überspringbar, reduzierte Bewegung), WebAudio-Sounds (abschaltbar), Showcase
7. [x] `apps/desktop`: Start-Animation → Platzhalter-Startseite, Icons aus dem Logo,
       Vitest + Playwright (CSP wie in Tauri, keine Konsolenfehler, nur lokale Anfragen)
8. [x] CI: Linux (Frontend, Rust, Windows-Clippy, Release-Clippy) + `windows-latest`
       (Clippy, Tests, NSIS-Installer als Artefakt) + Lieferkette (cargo-deny, pnpm audit)
9. [x] Security-Review durch separate Agenten: 48 Funde bestätigt, 46 behoben (siehe SECURITY.md)
10. [x] Definition of Done P0 geprüft (siehe unten)

### Testergebnisse P0 (2026-10-19)

| Bereich | Ergebnis |
| --- | --- |
| Rust (`cargo test --workspace`) | 187 Tests grün (aegis-core 180 inkl. 16 Compile-Fail-Fälle, Proptest, Mutations-Wächter, Doctests; Desktop 7) |
| Abdeckung aegis-core | 97,7 % Zeilen, 98,7 % Regionen (consent 99,6 %, tokens 100 %, plan 99,9 %, audit 93,4 %) |
| Vitest | @aegis/ui 154 Tests (99,8 % Zeilen) · @aegis/desktop 46 Tests |
| Playwright | 11 E2E-Tests grün (Boot, Überspringen, Tastatur, reduzierte Bewegung, CSP, freezePrototype, nur lokale Anfragen) |
| Clippy `-D warnings` | Linux + Windows-Ziel, Debug + Release, alle Features: 0 Warnungen |
| GitHub Actions | CI-Lauf grün inkl. `windows-latest` (Tests unter Windows, NSIS-Installer gebaut) |

### Definition of Done – Stand P0

| Kriterium | Stand |
| --- | --- |
| Build ohne Warnungen, alle Tests grün | ✅ |
| ≥ 80 % Abdeckung für kritische Module | ✅ für das, was existiert (Freigabe/Risiko 97–100 %); Krypto, Quarantäne, Panic, Sortierer folgen in ihren Phasen |
| „Nichts ohne Ja“-Test | Grundlage steht (`DirSnapshot`, Typsystem, Mutations-Sperre); Scan/Wächter/Sandbox/Panic-Läufe werden ab P2 damit geprüft |
| EICAR erkennen, isolieren, wiederherstellen | P2 (EICAR-Erzeugung zur Laufzeit ist vorbereitet) |
| Sandbox, Defender-Schalter, Setup.exe | P4 / P8 / P13 |
| UI flüssig, keine Konsolenfehler | ✅ (Playwright prüft Konsole, CSP, Netz; reale App unter WebKitGTK geprüft) |
| PROGRESS.md aktuell | ✅ |

## Offen / bekannt

- Manuell auf Windows prüfen: Doppelklick auf Titelleiste, Tray-Symbol, Startzeit mit GPU.
- ClamAV-Installation im Setup (P13).
- ✅ Quarantäne-Schlüssel per DPAPI (Maschine) gebunden (P5.1).
- Pipe: Identität des Client-Prozesses prüfen (Pfad + Signatur, braucht Code-Signing → P13).
  Bis dahin begrenzt der Identitätswechsel alles auf die Rechte des anfragenden Nutzers.
- Sicherheits-Score bleibt „noch nicht bewertet“, bis die Systemprüfungen (P6) da sind.
- Wächter: externe USB-Festplatten und Netzlaufwerke werden nicht überwacht (Dienst sieht sie nicht je Sitzung).
- 16-px-Icon: Schild gut erkennbar, die A-Aussparung verschwimmt → eigene 16-px-Variante (P11).
- Optional: Dependabot für Action-Pins (öffnet automatisch PRs – nur auf deinen Wunsch).

## Offene Fragen an dich (Richtungsentscheidungen)

- **Projektlizenz** (z. B. proprietär, MIT, GPL-3.0)? Bis dahin: keine Lizenzangabe, `publish = false`.
- **Code-Signing-Zertifikat** (kostet Geld) – wird vorbereitet, nicht vorausgesetzt (P13).
- **Online-Dienste mit API-Schlüssel** (abuse.ch MalwareBazaar-Hashlisten, VirusTotal): brauchen
  deinen eigenen Schlüssel und senden Hashes ins Netz – nur abschaltbar und erst nach deinem
  Ja. Bis dahin: lokale Hash-Listen (eigene Dateien).
- Hinweis: Das Repo ist öffentlich → GitHub Actions (auch `windows-latest`) ist kostenlos.

## P6 – Härtung & Systemzustand

1. [x] P6.1 Sicherheits-Score: zwölf (seit P6.4 dreizehn) gewichtete Prüfungen (Updates, Secure Boot, TPM, BitLocker,
       UAC, SMBv1, Remotedesktop, Gastkonto, Firewall, Virenschutz, Proxy/DNS/Hosts, Ports),
       Fakten nur lesend (Registrierung, WMI, Hosts-Datei, Port-Tabellen) außerhalb der
       Dienst-Sperre; „unbekannt“ zählt nicht, ohne genug Bewertbares kein Score. Seite „Härtung“
       mit Verlauf je Tag, Dashboard zeigt den Score.
2. [x] P6.2 Beheben mit Vorschau, Rückgängig und „Ja“: UAC, SMBv1, Remotedesktop/NLA,
       Gastkonto, Firewall (rechnerweit nur für Administratoren), Proxy (nur eigenes Konto);
       jeder Schritt steht im Plan, alter Stand gemerkt, „Rückgängig“ als eigener Plan;
       Gruppenrichtlinien werden nie geändert; Update/Verschlüsselung/Virenschutz öffnen nur die
       Windows-Einstellungen.
3. [x] P6.3 Persistenz-Check: Run-Schlüssel, Autostart-Ordner, Aufgaben, Dienste, Winlogon,
       IFEO, AppInit, WMI-Abos, COM, Browser-Erweiterungen – bewertet (Merkmale + Prüfprozess),
       Deaktivieren per Plan mit Rückgängig, Autostart-Dateien über die Quarantäne (D-045).
       Außerdem P6-Review (P6.1/P6.2) umgesetzt: 0 kritisch/hoch, 3 mittel, Rest niedrig.
4. [x] P6.4 Treiber-Check: Treiber-Dienste + geladene Treiber gegen LOLDrivers (Apache-2.0,
       gebündelt, SHA-256 + Authenticode), Deaktivieren nur automatisch/manuell startender
       Treiber per Plan; neue Score-Prüfung „Schutz vor verwundbaren Treibern“ (Speicher-
       Integrität, Microsoft-Sperrliste – einschalten per Plan) (D-046).
5. [x] P6.5 Software-Updates über winget: Liste auf Knopfdruck, je Paket ein Plan (neue
       Aktionsart `update_software`, genau Kennung + Version), Installieren nur nach „Ja“ als
       Administrator, außerhalb der Dienst-Sperre, kein automatisches Rückgängig (D-047).
6. [x] P6.6 Geräte & Privatsphäre: Kamera-/Mikrofon-Nutzung je Konto (Windows-Protokoll) mit
       Wächter-Meldung bei Beginn, Tastaturen/USB-Laufwerke mit BadUSB-Hinweis bei neuer
       Tastatur, Zwischenablage-Wächter für Krypto-Adressen in der App (opt-in, nur lesend)
       (D-048).
7. [x] P6.7 Sicherheits-Review P6.3–P6.6 (separater Agent): 0 kritisch/hoch, 2 mittel, 4 niedrig,
       3 Kleinigkeiten – alle behoben (siehe `docs/SECURITY.md`).

### Definition of Done – Stand P6

| Kriterium | Status |
| --- | --- |
| Score nur aus gelesenen Fakten, „unbekannt“ zählt nicht | ✅ `crates/hardening/src/checks.rs` (Tests), `flow.rs` (`haertung_nur_lesend_…`) |
| Beheben/Deaktivieren/Update nur nach „Ja“, Prüfsumme bindet die Schritte, geänderter Stand bricht ab | ✅ `flow.rs` (`haertung_…`, `persistenz_…`, `treiber_sperrliste_…`, `software_updates_…`) |
| Rechnerweites nur für Administratoren, Fremdkonten nie | ✅ `flow.rs`, `handler/persistence.rs`-Tests |
| Boot-/System-Treiber und wichtige Dienste nie deaktivierbar | ✅ `handler/persistence.rs`-Tests |
| Treiberliste lizenziert und gebündelt, Authenticode-Hash geprüft | ✅ `docs/LICENSES.md`, `crates/hardening/src/drivers.rs`-Tests |
| Geräte/Kamera/Zwischenablage nur lesend; Meldungen kontogetrennt; Zwischenablage opt-in | ✅ `handler/devices.rs`-, `clipboard_guard.rs`-Tests, Vitest |
| Review dokumentiert, Funde behoben | ✅ `docs/SECURITY.md` → Review-Protokoll |
| `pnpm check` + E2E grün; CI Linux + Windows | ✅ lokal; Windows-CI siehe GitHub Actions |

**P6 erledigt.**

## P7 – Netzwerk & Web-Schutz

1. [x] P7.1 Netzwerk-Monitor: Verbindungen je Programm (eigenes Konto, Administratoren alle),
       Land aus gebündelter Tabelle (iptoasn, gemeinfrei), Dienst, neue Ziele hervorgehoben,
       Verlauf je Konto (im Speicher, 30 Tage) – Seite „Netzwerk“ (D-049).
2. [x] P7.2 Firewall-Übersicht (Regeln lesen, auffällige Regeln, eigene Regeln) und
       „Netz sperren …“ als Plan mit „Ja“ (AEGIS-Regel, Rückgängig).
3. [ ] P7.3 Web-Schutz-Erweiterung (MV3, Listen mit Lizenz, Warnseite, Downloads), DoH-Hinweis.
4. [ ] P7.4 Heimnetz-Scanner (nur eigenes Subnetz) + Router-Hinweise.
5. [ ] P7.5 Leck-Check (HIBP Range, k-Anonymität; E-Mail nur mit eigenem Schlüssel).
6. [ ] P7.6 Sicherheits-Review, Doku, DoD.

**Nächster Schritt:** P7.3 Web-Schutz-Erweiterung.

## P5 – Schutz-Werkzeuge

1. [x] P5.1 Quarantäne-Schlüssel per DPAPI (Maschine) gebunden, alter Schlüssel geprüft umgestellt.
2. [x] P5.2 Prozess-Aktionen: Beenden/Anhalten/Fortsetzen eigener Prozesse nur per Plan (ID +
       Programm am Handle geprüft, nie kritische Prozesse), Knöpfe im Wächter.
3. [x] P5.3 Ransomware-Schutz: Köderdateien per Plan, Erkennung von Köder-Zugriffen und
       Massenänderungen je Profil, Warnung im Wächter, Dashboard-Modul live.
4. [x] P5.4 Panic-Button: Netz trennen/wieder verbinden per Firewall-Plan, Leiste solange getrennt.
5. [x] P5.5 Speicher-Scan: eigene Programme, Module, ausführbarer privater Speicher – geprüft im
       Prüfprozess, nur Meldung.
6. [x] P5.6 Datei-Safe: Argon2id + AES-256-GCM, Anlegen/Hineinlegen/Herausholen nur per Plan,
       Passwort nie gespeichert, Sperre nach 10 min bzw. Fehlversuchen; eigene Seite.
7. [x] P5.7 Sicherheits-Review (separater Agent): 0 kritisch/hoch, 3 mittel, 6 niedrig,
       3 Kleinigkeiten – alle behoben.
8. [x] P5.8 Notfall-Scan (der Panic-Button der Spezifikation) mit Sammel-Isolieren und
       „Alles rückgängig“; Dashboard/Befehlspalette starten ihn.
9. [x] P5.9 Ransomware-Ergänzungen: geschützte Ordner (Dokumente/Bilder/eigene – vorher wurden
       Köder in Dokumente/Bilder nicht beobachtet), Entropie-Stichproben im Prüfprozess,
       „Einfrieren“ im Alarm, Windows „Überwachter Ordnerzugriff“ erklären/öffnen.
10. [x] P5.10 Rückfall-Kopien (Opt-in-Plan, versioniert, verschlüsselt im Datenordner des
        Dienstes, alle 30 min), Zurückholen, Export aufs Laufwerk, Ausdünnen mit zweiter
        Bestätigung; Panel auf der Echtzeit-Seite.
11. [x] P5.11 Nachprüfung der neuen Teile (separater Agent): 0 kritisch, 1 hoch (Rückfall-Kopien
        konnten die Platte füllen), 4 mittel, 5 niedrig, Kleinigkeiten – alle behoben (D-042).

**P5 erledigt.** **Nächster Schritt:** P6 (Härtung & Score, Persistenz, Treiber-Check,
Software-Updates, Kamera/Mikro/Zwischenablage/USB-Wächter).

## P1 – erledigt

1. [x] `packages/ui` Komponenten: Button (Feder-Animation), IconButton, Panel/Card, StatusRing,
       ScoreGauge, CountUp, RiskBadge, Toggle, SegmentedControl, Tabs, Tooltip, Toast,
       Dialog + **Freigabe-Dialog** (Was? Warum? Was passiert dann? Rückgängig? – Ja, ausführen /
       Nein / Ignorieren / Vertrauen; Standard-Fokus nie auf „Ja“), Befehlspalette, eigene Icons
2. [x] Rust-Seite der App: rahmenloses Fenster + eigene Titelleiste (einzeln begründete
       Fenster-Rechte), Tray mit Menü, nur eine Instanz, sichtbare Startfehler, `app_info`
3. [x] Shell: Titelleiste, Navigation, Seitenübergänge, Dashboard (ehrliche Zustände – keine
       erfundenen Werte), Platzhalterseiten je Modul, Einstellungen (Sprache, Hell/Dunkel,
       Klang, Bewegung, Schließen-Verhalten), Befehlspalette Strg+K, Deutsch/Englisch
4. [x] Tests: Vitest, Playwright inkl. axe (Barrierefreiheit) in beiden Themes, Tastatur-Bedienung
5. [x] Review (Sicherheit der Fenster-/Tray-Rechte, UI/Barrierefreiheit), Korrekturen, DoD, Commit

## P2 – erledigt

1. [x] P2.1 `crates/engine` (nur lesend): EICAR, SHA-256-Hash-Listen, YARA-X mit eigenen
       Regeln (`rules/yara/aegis-builtin.yar`), statische PE-Analyse (goblin: Sektionen,
       Entropie, Importe, Signaturhinweis), ClamAV als getrennter Prozess. „Gefährlich“ nur bei
       eindeutigem Treffer; Heuristik höchstens „Verdächtig“.
2. [x] P2.2 `crates/quarantine`: AES-256-GCM-Container, Isolieren → Wiederherstellen →
       endgültig Löschen (zweite Bestätigung), Rückgängig-Einträge; Abdeckung 88,8 %.
3. [x] P2.3 `crates/service`: Protokoll (Länge + JSON, Einmal-Nonce), Handler als einzige
       Antwort-Stelle, Named Pipe mit SDDL (`crates/winffi`), Windows-Dienst (SCM),
       Prüfprotokoll-Datei mit Hash-Kette (Fortsetzen, abgerissene letzte Zeile kürzen).
4. [x] P2.4 App: Pipe-Client, Scan-Seite (Dateien/Ordner wählen, Funde, Ampel), Quarantäne-Seite
       (Wiederherstellen, endgültig Löschen mit zweitem Dialog), Freigabe-Dialog für jede Aktion.
5. [x] P2.5 Sicherheits-Review (separater Agent): 1 kritisch, 3 hoch, 3 mittel, 2 niedrig – alle
       behoben mit Regressionstests (Identitätswechsel auf den Client, keine Links, Pipe-ACL,
       Datenordner-Besitzer, Protokoll vor Ausführung, Grenzen, ClamAV nur fest + Zeitlimit).

### Definition of Done – Stand P2

| Kriterium | Status |
| --- | --- |
| EICAR wird erkannt, isoliert, wiederhergestellt, endgültig gelöscht (Ende-zu-Ende über das echte Tor) | ✅ `crates/quarantine/tests/eicar_end_to_end.rs`, `crates/service/tests/flow.rs` |
| „Nichts ohne Ja“: Scan ändert nichts (Byte-Schnappschuss), „Nein/Ignorieren/keine Antwort“ ändern nichts | ✅ `crates/engine/tests/scan_readonly.rs`, `crates/service/tests/flow.rs` |
| Wiederholte/fremde Antworten werden abgewiesen (Nonce, Digest) | ✅ `crates/service/tests/flow.rs` |
| Pipe unter Windows (ACL, erste Instanz) | ✅ CI `windows-latest` (`tests/transport.rs`) |
| `pnpm check` + E2E grün | ✅ lokal; CI Linux + Windows |
| Review dokumentiert | ✅ `docs/SECURITY.md` → Review-Protokoll |

## P3 – erledigt

1. [x] P3.1 Engine: Skripte, Office-Makros, PDF, LNK, ISO, Archive (zip/7z/cab/gz/tar) rekursiv
       mit Budget gegen Zip-Bomben; Merkmals-Kombination („Gefährlich“ erst ab zwei
       Schadmerkmalen); Spiel-Tool-/Cheat-Logik (nur melden); Authenticode als Entlastung.
2. [x] P3.2 Prüfprozess `aegis-scanworker`: eingeschränktes Token, niedrige Integrität,
       Job-Objekt, Zeitlimits; ClamAV als dessen Kind.
3. [x] P3.3 Vertrauensliste (Hash + Pfad + Grund + Datum, je Konto, widerrufbar) aus der
       Entscheidung „Vertrauen“; Anzeige in Scan und Quarantäne.
4. [x] P3.4 Echtzeit-Wächter: Downloads/Desktop/Temp je Profil, Wechseldatenträger,
       Programmstarts (ETW); Meldungen je Konto, Gaming-Modus (max. 4 h), Hinweise in der App
       mit Isolieren / Vertrauen (Freigabe-Dialog) / Ignorieren / Mehr Infos.
5. [x] P3.5 Berichte & Zeitleiste (Verlauf je Konto, Filter, nach Tagen), Export als HTML
       (in Rust erzeugt, Speichern-Dialog) und Drucken/PDF; geplante Scans (1/7/30 Tage) und
       tägliches `freshclam` (abschaltbar); Dashboard zeigt echte Zustände von Engine und Wächter.
6. [x] P3.6 Sicherheits-Review P3 (separater Agent, 2 Durchgänge): 2 hoch, 8 mittel, 6 niedrig –
       alle behoben (siehe SECURITY.md → Review-Protokoll).

### Definition of Done – Stand P3

| Kriterium | Status |
| --- | --- |
| Wächter meldet EICAR, verändert nichts; Kontotrennung; Gaming-Modus je Konto | ✅ `crates/service/src/watch.rs` (Tests), `crates/service/tests/flow.rs` |
| Dokumente/Skripte/Archive/LNK/ISO/PDF, Cheat-Logik, Zip-Bomben-Grenzen | ✅ `crates/engine/tests/content_and_containers.rs` |
| „Nichts ohne Ja“: Scan, Wächter, geplanter Scan, Vertrauen ändern nichts (Schnappschuss) | ✅ `flow.rs` (`waechter_meldungen_…`, `verlauf_zeitplan_und_update`, `vertrauen_widerrufen`) |
| Prüfprozess eingeschränkt; Hintergrund nie mit Dienst-Rechten | ✅ `tests/worker.rs` (Windows: „nur Nutzer“-Token) |
| Berichte: Zeitleiste, HTML-Export maskiert, Drucken/PDF | ✅ `report.rs`-Tests, Vitest `Berichte` |
| Review dokumentiert, Funde behoben | ✅ `docs/SECURITY.md` → Review-Protokoll |
| `pnpm check` + E2E grün; CI Linux + Windows | ✅ lokal; CI siehe GitHub Actions |

## Nächster Schritt

P4: Labor – Stufe 1 (Windows Sandbox mit Sonde, Einschalten nach Bestätigung), Stufe 2
(Mini-Sandbox im AppContainer), Verhaltensbericht mit Einschätzung, Labor-Seite (Drag & Drop,
Angebot für unbekannte Downloads – nie automatisch).

- ✅ P4.1: `aegis-sandbox` (`.wsb`, Sonde, Mini-Sandbox, Beobachtung, Bericht + Einschätzung, PNG),
  `aegis-winffi` (AppContainer, Job, Registry/Prozesse/TCP lesen, Bildschirmfotos).
- ✅ P4.2: Dienst – Labor-Lauf nur über Vorschlag + „Ja“ (`RunInSandbox`, Stufe/Sekunden/Netz im
  Plan), Kopie mit SHA-256 im eigenen Labor-Ordner (Original unverändert), Stufe 1 als Nutzer
  gestartet, Stufe 2 im AppContainer; Windows Sandbox einschalten nur Admin + Bestätigung (DISM);
  Reste beim Start verworfen; Verlaufsart „Labor“.
- ✅ P4.3: Labor-Seite in der App (Drag & Drop, Stufe, Dauer, Netz nur VM, Bericht mit
  Einschätzung, Bildschirmfotos), Angebot „Im Labor prüfen“ im Wächter.
- ✅ P4-Review (1 hoch, 6 mittel, 8 niedrig) behoben – siehe `docs/SECURITY.md`.
- ⏳ Windows-CI für die Mini-Sandbox (Simulator) bestätigen, dann DoD P4.
