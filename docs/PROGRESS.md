# AEGIS Suite – Fortschritt

Stand: 2026-10-20 · **P0–P12 abgeschlossen**, P13 im Abschluss (Review) · danach optional **P14**

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
| P7 | Netzwerk, Firewall-Übersicht, Web-Schutz, Heimnetz, Leck-Check | erledigt |
| P8 | Defender-Schalter | erledigt |
| P9 | Tresor + Erweiterung | erledigt |
| P10 | Tools 1–11 | erledigt |
| P11 | Tools 12–22 + Animations-Feinschliff | erledigt |
| P12 | Privacy-Browser | erledigt |
| P13 | Setup-Bootstrapper, Uninstaller, Updater, Abschlusstests, deutsches README | in Arbeit (Review) |
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
- 16-px-Icon: eigene Kleinst-Variante seit P11.3 (`logo-mark-16.svg`, Tray + 16/24 px im ICO).
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
3. [x] P7.3 Web-Schutz-Erweiterung `extensions/webshield` (MV3, declarativeNetRequest): gebündelte
       Ransomware-/Betrugsliste + täglich nachgeladene Phishing-/Betrugslisten (abschaltbar),
       Warnseite mit „Trotzdem öffnen“ nur nach Häkchen (Sitzung), Seitenhinweise (Marke,
       Punycode, Passwort ohne HTTPS), Download-Hinweise; Optionen-Seite; Unit- und
       Chromium-E2E-Tests (inkl. axe). App: Abschnitt „Web-Schutz“ mit Anleitung und DoH-Hinweis
       (D-050).
4. [x] P7.4 Heimnetz-Scanner in der App (nur eigenes privates Subnetz, Ping + ARP + zehn
       Dienste + UPnP + WLAN-Sicherheit), Hinweise zu Router/WLAN, neue Geräte (D-051).
5. [x] P7.5 Leck-Check: Passwort per HIBP-Range (nur 5 Zeichen des SHA-1-Werts verlassen das
       WebView), E-Mail nur mit eigenem HIBP-Schlüssel (nicht gespeichert); HTTPS über WinHTTP
       (D-052).
6. [x] P7.6 Sicherheits-Review (separater Prüfer): 2 mittel, 4 niedrig, 3 Kleinigkeiten – alle
       behoben bzw. dokumentiert (SECURITY, Review-Protokoll).

**DoD P7:** Verbindungen je Programm mit Land/Verlauf, Firewall-Übersicht und eigene Regeln nur
nach „Ja“; Web-Schutz-Erweiterung mit Listen, Warnseite, Hinweisen und E2E-Tests; Heimnetz nur im
eigenen LAN/WLAN; Leck-Check mit k-Anonymität; alle Prüfungen grün.

## P8 – Defender-Schalter

1. [x] P8.1 `crates/defender-switch` (rein): Status einordnen, Änderungen (Echtzeitschutz aus/an,
       Funde nur melden/Standard), feste `Set-/Remove-MpPreference`-Befehle, Sperre bei
       Manipulationsschutz, passivem Defender, Richtlinie; Nachprüfung nach dem Befehl.
2. [x] P8.2 Dienst: Status per WMI außerhalb der Sperre, Vorschlag nur aus frischem Status, nur
       Administratoren, Ausführung über den Härtungs-Weg (Rückgängig), danach echter Stand;
       Protokoll aus dem Verlauf (D-053).
3. [x] P8.3 App: Seite „Defender-Schalter“ (Stand, großer Schalter, „Wieder AN“ mit einem Klick,
       nur melden, Anleitung Manipulationsschutz + Windows-Sicherheit öffnen, Protokoll).
4. [x] P8.4 Sicherheits-Review (separater Prüfer): 2 mittel, 4 niedrig – behoben (siehe
       Review-Protokoll).

**DoD P8:** Stand vor/nach dem Umschalten kommt von Windows (WMI) und wird nach jedem Befehl
nachgeprüft; „Wieder AN“ mit einem Klick; Manipulationsschutz nie umgangen (Anleitung +
Windows-Sicherheit öffnen); jede Umschaltung im Prüfprotokoll und Verlauf; nur Virenschutz.

## P13 – Setup, Updater, Deinstallation, README

1. [x] P13.1 Installer für den Rechner mit Hooks: Dienst registrieren/entfernen
       (`aegis-service install|uninstall`), Prüfprozess, Tresor-Host + Manifeste (HKLM, Chrome/
       Edge/Brave), Erweiterungen; Deinstallation löscht Daten nur nach zwei Bestätigungen.
       Signierte Updates (`crates/update`, Release-Werkzeug `aegis-release`), Bereich „Updates“
       auf „Über AEGIS“ (Suche nur auf Klick, Installation nach Bestätigung), WinHTTP mit
       selbst geprüften Weiterleitungen. D-059.
2. [x] P13.2 `AEGIS-Setup.exe` (`apps/setup`): Assistent mit eigener Animation (Schild im
       Fortschrittsring) und Klang, Datenschutz-Seite, Ordner und Pakete (Browser optional),
       Laden mit Fortschritt, Signatur- und SHA-256-Prüfung, Installation erst nach Klick (still,
       UAC durch Windows, erneute Prüfung, Exit-Code), AEGIS starten; WebView2-Prüfung mit
       Hinweis auf die Microsoft-Seite. Browser- und Setup-Build in der Windows-CI. D-060.
3. [ ] P13.3 README (Deutsch), Endtests, Sicherheits-Review P13, DoD.

## P12 – Privacy-Browser

1. [x] P12.1 `crates/browser-core` (Adresszeile → Adresse/Suche, HTTPS-only, gesperrte Schemata,
       Blocker auf Filterlisten mit `adblock`, Einstellungen + WebView2-Schalter für DoH/WebRTC,
       Lesezeichen) und `apps/browser` (eigenes Tauri-Fenster: Leiste in React, je Tab ein WebView,
       Rechte nur für die Leiste, Pop-ups als Tabs, HTTP nur nach Klick, Listen nur auf Wunsch,
       Ghost-Fenster InPrivate, optional über laufenden Tor/Arti); Windows: Prüfung jeder Anfrage
       in WebView2 (`aegis_winffi::webview`). D-058.
2. [x] P12.2 Sicherheits-Review (separater Agent): 1 kritisch, 2 hoch, 6 mittel, Niedriges –
       behoben bzw. ehrlich benannt (Tor-Proxy wirklich gesetzt, kein wirkungsloser DoH-Schalter,
       iframes und Worker im Blocker, Filter vor der ersten Seite, Pop-ups im Hintergrund und
       begrenzt, iframes/externe Programme geprüft, feste Schalter je Profil) – siehe
       `docs/SECURITY.md`. Dazu Windows: 8.3-Kurznamen in der Pfadprüfung (P11.5).

**DoD P12:** eigene App mit Rechten nur für die Leiste; nur http/https, HTTPS-only mit Ausnahme
nur nach Klick (je Host und Fenster-Bereich); Blocker auf EasyList/EasyPrivacy (nur auf Klick
geladen) für Seiten, iframes und Worker; Ghost-Fenster InPrivate, optional über einen laufenden
SOCKS5-Proxy (Tor/Arti) samt DNS; ehrliche Texte (reduziert Tracking, anonymisiert nicht; Seiten
erkennen WebView2; kein Beweis für Tor). Offen: Tabs als rohe WebView2-Controller (ohne
Tauri-Kennung im Seitenkontext).

## P11 – Windows-Tools 12–22 + Animations-Feinschliff

1. [x] P11.1 Werkzeuge 12 Datei-Shredder (einmal Zufall, umbenennen, löschen – nur nach
       zweiter, getrennter Bestätigung; ehrlicher SSD/BitLocker-Hinweis), 15 Batch-Umbenenner
       (Muster, Suchen/Ersetzen, Zählung, Groß/klein, Vorschau), 16 Explorer-Tweaks und
       19 Datenschutz-Schalter (nur bekannte `HKCU`-Werte, Rückgängig auf den vorigen Wert),
       18 Hosts-Datei-Ansicht (nur lesend, verdächtige Umleitungen), 22 Systeminfo & Gesundheit
       (nur lesend); 13 Programm-Updates, 14 Treiber, 20 Prozess-/Netzwerk-Monitor und
       21 Gaming-/Fokus-Modus verweisen auf die vorhandenen Seiten.
2. [x] P11.2 17 Wiederherstellungspunkte über den Dienst: Liste (WMI `SystemRestore`, außerhalb
       der Dienst-Sperre), neuer Punkt nur als Plan nach „Ja“, nur Administratoren, bereinigte
       Beschreibung, `Checkpoint-Computer` vom festen Systemort, danach nachgeprüft; AEGIS löscht
       und spielt keine Punkte zurück. Bereich auf der Seite „Härtung“ (vor dem Beheben).
3. [x] P11.3 Animations-Feinschliff: kreisender Scan-Ring während Prüfungen, hochzählende
       Ergebnisse der Werkzeuge, eigene 16-px-Variante des Logos (`logo-mark-16.svg`: Schild
       ohne feines Λ, kräftiger Scan-Balken) für die 16/24-px-Bilder in `icon.ico` und das
       Tray-Symbol.
4. [x] P11.4 Sicherheits-Review P11 (separater Agent): 5 mittel, 5 niedrig behoben (Shredder
       über ein Handle ohne Links und ohne Hardlinks, Fenster des Systems als letzte Bestätigung,
       kein falsches „Rückgängig“, Wiederherstellungspunkt ohne Dienst-Sperre) – siehe
       `docs/SECURITY.md`. Dazu Windows-CI: Papierkorb-Eintrag über die Langform des Pfads.

**DoD P11:** 22 Werkzeuge vorhanden (13/14/20/21 als Verweise auf die Seiten der App), jedes
mit Vorschau; verändernde nur nach „Ausführen“, mit Protokoll und Rückgängig – außer dem
Shredder, der nur nach zweiter, getrennter Bestätigung (samt Fenster des Systems) endgültig
löscht und das ehrlich sagt; Wiederherstellungspunkte nur über den Dienst nach „Ja“;
Animationen nur über transform/opacity, reduzierte Bewegung respektiert.

## P10 – Windows-Tools 1–11

1. [x] P10.1 `crates/tools`: Vorschau (`Plan`, Prüfsumme), Freigabe (`Approved::by_user` /
       `by_rule`), Ausführen mit Lageprüfung, Protokoll, Rückgängig, Systemorte tabu, ohne Links;
       Windows: Papierkorb der Shell + Wiederfinden über `$I…`, Verschieben ohne Überschreiben,
       Hintergrundbild, Autostart-Schalter (`StartupApproved`), Desktop-Symbole (`IFolderView`).
       Werkzeuge 1 Sortierer, 2 Quellen-Ordner (Mark-of-the-Web), 3 Regeln + Hintergrund-
       Überwachung, 4 Desktop-Layout, 5 Hintergrundbild, 6 Duplikate, 7 Speicherplatz, 8 Große &
       alte Dateien, 9 Leere Ordner, 10 Cleaner (nur sichere Orte), 11 Autostart. App-Befehle
       `tools_*`, Seite „Tools“ mit Vorschau/Abwählen/Ausführen/Rückgängig und Protokoll (D-057).
2. [x] P10.2 Sicherheits-Review (separater Agent): 1 kritisch, 1 hoch, 7 mittel, 8 niedrig
       behoben (Papierkorb ohne stilles Löschen, Duplikat-Identität, keine Links in Pfaden,
       nur angezeigte Schritte, `watch_since`, Protokoll-Sperre) – siehe `docs/SECURITY.md`.

**DoD P10:** Jedes Werkzeug zeigt zuerst eine Vorschau und tut ohne „Ausführen“ (bzw. eine
eingeschaltete Regel mit „im Hintergrund“) nichts; nur angezeigte, nicht abgewählte Schritte
laufen; nichts wird überschrieben oder endgültig gelöscht; jeder Lauf steht im Protokoll und
lässt sich zurücknehmen; Systemorte und Links sind tabu.

## P9 – Passwort-Tresor

1. [x] P9.1 `crates/vault-core`: Format `AEGIS-VAULT-1` (Argon2id ≥ 64 MiB/3 Durchläufe,
       Parameter + Salz in der Datei, AES-256-GCM, neue Nonce je Eintrag und Speichern, Kennung
       als AAD), Zeroize, Generator, Stärke, Wiederverwendung, CSV-Import (Chrome/Edge, Firefox,
       Bitwarden), Adressvergleich fürs Ausfüllen.
2. [x] P9.2 App: Tresor-Backend (Datei im App-Datenordner, Auto-Sperre, Fehlversuche,
       Zwischenablage ohne Verlauf + 30 s, Sicherung `.bak`) und Seite „Tresor“ (anlegen,
       entsperren, Suche, Ordner, Favoriten, Schlagwörter, Generator, Stärke, Mehrfach-/Leck-Check,
       CSV-Import, Master-Passwort ändern) (D-054).
3. [x] P9.3 Browser-Erweiterung `extensions/vault` (MV3, einziges Recht `nativeMessaging`,
       speichert nichts) + Host `aegis-vault-host.exe` (nur unsere feste Erweiterungs-ID) +
       Pipe der App nur fürs eigene Konto (Gegenstelle per Programmpfad geprüft); Adresse immer
       aus dem Absender des Hauptrahmens; Knopf im geschlossenen Schatten-Baum, Ausfüllen nur
       nach echtem Klick/Alt+↓; Popup; E2E mit harmlosem Test-Host (D-055).
4. [x] P9.4 Sicherheits-Review (separater Agent, P9-R1…R13 behoben, siehe SECURITY
       Review-Protokoll), Doku, DoD.

5. [x] P9.5 „Speichern?“ nach dem Anmelden: Erkennung beim Absenden, Prüfung per SHA-256,
       Frage mit Klick-Schutz, Anlegen/Aktualisieren in der App (D-056, Tests + E2E).

**DoD P9:** Tresor nur im App-Prozess des Kontos, Argon2id + AES-256-GCM mit gebundener Menge der
Einträge, neuer Schlüssel bei jedem Master-Wechsel; Auto-Sperre, Fehlversuche, Zwischenablage
ohne Verlauf (30 s, beim Sperren/Beenden geleert); CSV-Import nur aus eigener Exportdatei, nie
fremde Browser-Passwörter; Erweiterung nur `nativeMessaging`, speichert nichts dauerhaft, Logins nur für
die passende Seite, Ausfüllen nur auf echten, sichtbaren Klick, „Speichern?“ erst nach Klick; Host + Pipe nur fürs eigene Konto.
Registrierung des Hosts und Auslieferung der Erweiterung folgen mit dem Setup (P13).

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

## P4 – Labor (Sandbox)

Stufe 1 (Windows Sandbox mit Sonde, Einschalten nach Bestätigung), Stufe 2 (Mini-Sandbox im
AppContainer), Verhaltensbericht mit Einschätzung, Labor-Seite (Drag & Drop, Angebot für
unbekannte Downloads – nie automatisch).

- ✅ P4.1: `aegis-sandbox` (`.wsb`, Sonde, Mini-Sandbox, Beobachtung, Bericht + Einschätzung, PNG),
  `aegis-winffi` (AppContainer, Job, Registry/Prozesse/TCP lesen, Bildschirmfotos).
- ✅ P4.2: Dienst – Labor-Lauf nur über Vorschlag + „Ja“ (`RunInSandbox`, Stufe/Sekunden/Netz im
  Plan), Kopie mit SHA-256 im eigenen Labor-Ordner (Original unverändert), Stufe 1 als Nutzer
  gestartet, Stufe 2 im AppContainer; Windows Sandbox einschalten nur Admin + Bestätigung (DISM);
  Reste beim Start verworfen; Verlaufsart „Labor“.
- ✅ P4.3: Labor-Seite in der App (Drag & Drop, Stufe, Dauer, Netz nur VM, Bericht mit
  Einschätzung, Bildschirmfotos), Angebot „Im Labor prüfen“ im Wächter.
- ✅ P4-Review (1 hoch, 6 mittel, 8 niedrig) behoben – siehe `docs/SECURITY.md`.
- ✅ Windows-CI grün (Pipe-Transport, Prüfprozess-Token im Identitätswechsel) – DoD P4 erfüllt.

## Nächster Schritt

P13.2 Setup-Assistent, P13.3 README + Review.
