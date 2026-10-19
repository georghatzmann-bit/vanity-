# AEGIS Suite – Fortschritt

Stand: 2026-10-19 · **P0–P1 abgeschlossen, P2 im Review** · danach: **P3 – Echtzeit-Wächter, Whitelist, Berichte**

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
| P3 | Echtzeit-Wächter, Heuristik, Cheat-Logik, Whitelist, Dokument/Skript/Archiv, Berichte | als Nächstes |
| P4 | Sandbox Stufe 1+2 + Verhaltensbericht | offen |
| P5 | Panic-Button, Speicher-Scan, Ransomware-Schutz, Datei-Safe | offen |
| P6 | Härtung, Persistenz, Treiber-Check, Kamera/Mikro/Zwischenablage/USB-Wächter | offen |
| P7 | Netzwerk, Firewall-Übersicht, Web-Schutz, Heimnetz, Leck-Check | offen |
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
- Parser (goblin, YARA-X) in Kindprozesse mit niedriger Integrität + Job-Objekt auslagern (P3).
- ClamAV-Signaturen aktualisieren (`freshclam`) und Zeitpläne (P3); ClamAV-Installation im Setup (P13).
- Quarantäne-Schlüssel per DPAPI (Maschine) binden statt nur Ordner-ACL (P5).
- Pipe: Identität des Client-Prozesses prüfen (Pfad + Signatur, braucht Code-Signing → P13).
- „Vertrauen“ legt noch keinen Whitelist-Eintrag an – der Dienst meldet das ehrlich (P3).
- 16-px-Icon: Schild gut erkennbar, die A-Aussparung verschwimmt → eigene 16-px-Variante (P11).
- Optional: Dependabot für Action-Pins (öffnet automatisch PRs – nur auf deinen Wunsch).

## Offene Fragen an dich (Richtungsentscheidungen)

- **Projektlizenz** (z. B. proprietär, MIT, GPL-3.0)? Bis dahin: keine Lizenzangabe, `publish = false`.
- **Code-Signing-Zertifikat** (kostet Geld) – wird vorbereitet, nicht vorausgesetzt (P13).
- **Online-Dienste mit API-Schlüssel** (abuse.ch MalwareBazaar-Hashlisten, VirusTotal): brauchen
  deinen eigenen Schlüssel und senden Hashes ins Netz – nur abschaltbar und erst nach deinem
  Ja. Bis dahin: lokale Hash-Listen (eigene Dateien).
- Hinweis: Das Repo ist öffentlich → GitHub Actions (auch `windows-latest`) ist kostenlos.

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
5. [ ] P2.5 Sicherheits-Review (separater Agent), Korrekturen, Docs.

### Definition of Done – Stand P2

| Kriterium | Status |
| --- | --- |
| EICAR wird erkannt, isoliert, wiederhergestellt, endgültig gelöscht (Ende-zu-Ende über das echte Tor) | ✅ `crates/quarantine/tests/eicar_end_to_end.rs`, `crates/service/tests/flow.rs` |
| „Nichts ohne Ja“: Scan ändert nichts (Byte-Schnappschuss), „Nein/Ignorieren/keine Antwort“ ändern nichts | ✅ `crates/engine/tests/scan_readonly.rs`, `crates/service/tests/flow.rs` |
| Wiederholte/fremde Antworten werden abgewiesen (Nonce, Digest) | ✅ `crates/service/tests/flow.rs` |
| Pipe unter Windows (ACL, erste Instanz) | ✅ CI `windows-latest` (`tests/transport.rs`) |
| `pnpm check` + E2E grün | ✅ lokal; CI Linux + Windows |
| Review dokumentiert | ⏳ läuft |

## Nächster Schritt

P3: Echtzeit-Wächter (notify; ETW wo ohne Treiber möglich), Whitelist (Hash + Pfad + Grund +
Datum, SQLite) für „Vertrauen“, Parser in Kindprozessen, Dokument-/Skript-/Archiv-Analyse
(Limits gegen Zip-Bomben), Cheat-Logik-Erkennung (nur melden), Berichte (Export), Zeitpläne.
