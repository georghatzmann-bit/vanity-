# Sicherheit

## Grundsatz: Goldene Regel

AEGIS verändert, verschiebt, beendet oder löscht nichts ohne ausdrückliche Bestätigung.
Technisch umgesetzt in `crates/core` (siehe `docs/ARCHITECTURE.md`, Abschnitt „Ablauf“):

| Maßnahme | Wirkung |
| --- | --- |
| `Approval` nur in `aegis-core` erzeugbar (private Felder, kein `Clone`/`Copy`/`Default`/`Deserialize`) | Kein anderes Crate kann eine Freigabe „basteln“ (Compile-Fail-Tests) |
| Freigabe an Plan-Digest gebunden, einmalig, mit Ablauf | Kein Wiederverwenden, kein Unterschieben eines anderen Plans |
| Keine Reaktion = Plan verfällt | Standard ist „nichts tun“ |
| Endgültiges Löschen: zweite getrennte Bestätigung mit Mindestabstand | Kein versehentlicher Doppelklick |
| `clippy.toml` `disallowed-methods` für verändernde APIs (std, tokio, tempfile, windows-sys) + Allowlist-Test | Jede neue Veränderungsstelle fällt im Review auf |
| `ConsentGate::decide`/`confirm_second` ebenfalls gesperrt (Markierung `aegis-consent`) | Im Betrieb darf nur der Pipe-Handler des Dienstes Nutzerantworten annehmen – kein Hintergrundcode „genehmigt sich selbst“ |
| Einlösen nur am ausgebenden Tor; abgelehnte Einlösungen werden protokolliert | Manipulierte Pläne, fremde Tore und Fristüberschreitungen hinterlassen eine Spur |
| Mutations-Wächter liest Manifeste über `cargo metadata`/TOML, prüft `.cargo/config`, `cfg(clippy)`, Doctests, `unsafe`-Ausnahmen | Die Sperre lässt sich nicht still per Konfiguration aushebeln |
| Prüfprotokoll mit Hash-Kette | Nachträgliche Manipulation des Protokolls wird erkannt |
| `unsafe` nur in `crates/winffi` (alle anderen Bibliotheken `forbid(unsafe_code)`, Test erzwingt das) | Windows-FFI an einer Stelle, jede `unsafe`-Stelle mit `SAFETY` + Allowlist |
| Pipe: Einmal-Nonce je Vorschlag, `deny_unknown_fields`, Rahmenlimit, nur absolute Pfade (≤ 1000) | Keine wiederholten oder untergeschobenen Antworten, keine Speicher-Erschöpfung |
| Engine nur lesend (Links werden nicht verfolgt, Byte-Schnappschuss-Test) | Ein Scan verändert nachweislich nichts |
| „Nichts ohne Ja“-Tests (Zustands-Schnappschuss byte-genau) | Scans/Wächter/Panic ohne Bestätigung ändern nachweislich nichts |

## Bedrohungsmodell (ehrlich)

- **Kein Kernel-Treiber.** AEGIS erkennt, warnt und isoliert auf Wunsch; es blockiert keine
  Programme vor dem Start. Das steht so in der UI.
- **Wiederholte Antworten (geschlossen in P2):** Jede Antwort muss Plan-ID, Digest und die
  Einmal-Nonce des Vorschlags tragen (Vergleich in konstanter Zeit); die zweite Bestätigung
  beim Löschen hat eine eigene Nonce. Eine mitgeschnittene Antwort passt auf keinen neuen
  Vorschlag.
- **Rechte des Nutzers (P2.5):** Der Dienst läuft als SYSTEM, fasst Nutzerdateien aber nur
  mit der Identität des anfragenden Pipe-Clients an (`ImpersonateNamedPipeClient`): Scannen,
  Öffnen des Originals, Anlegen beim Wiederherstellen. Ein normaler Nutzer kann über den Dienst
  also nichts lesen, löschen oder schreiben, was er nicht ohnehin dürfte. Nur Laufwerkspfade
  (`C:\…`), keine Netzwerk-/Gerätepfade, keine `.`/`..`, nichts im AEGIS-Datenordner.
- **Keine Links:** Originale werden exklusiv und ohne Link-Auflösung geöffnet, der tatsächliche
  Pfad muss dem angezeigten entsprechen (Abzweigungen in Zwischenordnern werden erkannt),
  Dateien mit mehreren Hardlinks werden abgelehnt, gelöscht wird über das Handle.
  Wiederherstellen legt nur neue Dateien an (nie überschreiben, keine fehlenden Ordner).
- **Gleichrangige Schadsoftware:** Ein Programm, das bereits mit den Rechten des Nutzers läuft,
  kann Vorschläge anfordern und selbst beantworten – es könnte dieselben Dateien aber ohnehin
  selbst löschen. Eine Prüfung der Client-Identität (Pfad + Signatur der App) folgt mit dem
  Code-Signing (P13); optional Windows-Hello/UAC für besonders folgenreiche Aktionen.
  Admin-Schadsoftware kann AEGIS grundsätzlich aushebeln.
- **Pipe:** Interaktive Nutzer dürfen lesen/schreiben, aber **keine eigenen Server-Instanzen**
  anlegen (`0x12019b` statt `GRGW`). Der Dienst trägt SYSTEM als Besitzer der Pipe ein
  (`O:SY`); die App prüft vor dem ersten Senden Besitzer und Sitzung 0 – das kann ein normales
  Programm nicht vortäuschen und funktioniert auch für Standardnutzer. Es gibt immer eine
  freie Instanz, bevor eine andere freigegeben wird (keine Lücke zum Übernehmen des Namens).
- **Konten getrennt:** Vorschläge, zweite Rückfragen und Quarantäne-Einträge gehören dem Konto
  (SID), das sie angefordert hat. Nur dieses Konto sieht, beantwortet, stellt wieder her oder
  löscht. Grenzen gelten je Konto. Ein Programm **desselben** Kontos kann Vorschläge
  anfordern und beantworten (Nonce mitlesen) – es könnte dieselben Dateien aber ohnehin
  selbst verändern; die Prüfung der Client-Identität folgt mit Code-Signing (P13).
- **Datenordner:** wird mit Zugriffsliste angelegt; ein vorhandener Ordner muss SYSTEM oder den
  Administratoren gehören und darf kein Link sein – sonst startet der Dienst nicht.
- **Protokoll vor Ausführung:** Freigabe-Ereignisse werden geschrieben und mit `sync_data`
  gesichert, **bevor** etwas verändert wird; gelingt das nicht, verfällt die Freigabe.
- **Leerlauf:** Verbindungen, die länger als 30 s auf eine Anfrage warten, trennt der Dienst.
- **Analysepunkte:** Nur Links/Abzweigungen (Namens-Ersatz) gelten als Link; komprimierte
  Systemdateien, Deduplizierung und Cloud-Platzhalter werden geprüft und können isoliert
  werden. Schreibgeschützte Dateien werden über `FileDispositionInfoEx` entfernt. Pfade
  werden wie im Dateisystem verglichen (`CompareStringOrdinal`, UTF-16).
- **Datenordner-Inhalt:** Beim Start müssen auch alle vorhandenen Dateien im Datenordner SYSTEM
  oder den Administratoren gehören und dürfen keine Links sein.
- **Kein Sicherheitsgrenze:** Die Ablehnung von Pfaden im Datenordner ist ein Textvergleich
  (Kurznamen, Abzweigungen umgehen ihn); den Schutz liefern Identitätswechsel und die
  Zugriffsliste SYSTEM/Administratoren.
- **Überlastung:** höchstens 16 Verbindungen, 2 gleichzeitige Scans (außerhalb der Sperre des
  Dienst-Zustands), 64 offene Vorschläge, 60 Vorschläge/Minute, 256 KiB Pfade pro Anfrage,
  Rahmen werden schrittweise gelesen. ClamAV: nur feste Installationsorte (nicht `PATH`),
  Inhalt über die Standardeingabe, Zeitlimit 120 s.
- **Quarantäne-Schlüssel:** liegt als Datei `vault.key` im Datenordner, geschützt nur durch die
  DACL (SYSTEM + Administratoren). Die Verschlüsselung verhindert, dass Funde versehentlich
  ausgeführt oder von anderen Scannern gemeldet werden – nicht, dass ein Admin sie liest.
  DPAPI-Bindung (Maschinenschlüssel) ist für P5 vorgesehen.
- **Parser im Kindprozess (P3.2):** Fremde Dateien parst nur `aegis-scanworker` – unter Windows
  mit eingeschränktem Token des anfragenden Nutzers (keine Privilegien, Admin-Gruppen nur
  „deny“), **niedriger Integrität**, in einem Job-Objekt (2 GiB Speicher, höchstens 2 Prozesse,
  keine Zwischenablage/Desktop-Zugriffe, Ende mit dem Dienst) und mit Zeitlimit. ClamAV läuft
  als Kind dieses Prozesses mit denselben Grenzen (nicht mehr als SYSTEM). Absturz oder
  Zeitüberschreitung = „nicht prüfbar“, der Nutzer kann trotzdem isolieren. Ohne das
  Prüfprogramm startet der Dienst nicht. Grenze: Netzwerk sperrt erst die AppContainer-
  Sandbox (P4). Konsolenbetrieb ohne SYSTEM (Entwicklung/CI) nutzt das eigene, eingeschränkte
  Token.
- **Echtzeit-Wächter (P3.4):** meldet nur, verändert nichts. Beobachtet Downloads, Desktop
  und Temp jedes Profils sowie Wechseldatenträger (`notify`, ReadDirectoryChangesW) und
  Programmstarts (ETW `Microsoft-Windows-Kernel-Process`, ohne Treiber – das Programm läuft
  dann bereits). Geprüft wird im eingeschränkten Prüfprozess (Token des Dienstes ohne
  Privilegien, niedrige Integrität, Job-Objekt); Dateien über 64 MiB, der eigene Datenordner
  und bereits geprüfte Stände (Pfad + Zeit + Größe) werden übersprungen, höchstens 10 000
  wartende Dateien (Überlauf wird gezählt und angezeigt). Meldungen sieht nur das Konto, in
  dessen Profil die Datei liegt (Profilordner des Pipe-Clients); gemeinsame Orte (USB,
  Programme-Ordner) sehen alle. Vertraute Dateien (Hash + Pfad) werden nicht gemeldet.
  Isolieren/Vertrauen nur über Vorschlag + Freigabe-Dialog. **Gaming-Modus** pausiert Prüfen
  und Hinweise rechnerweit und endet spätestens nach 4 Stunden von selbst; danach wird
  nachgeprüft. Grenze: Neue Profile werden erst nach einem Dienst-Neustart überwacht.
- **Verlauf, Zeitpläne, Updates (P3.5):** Der Verlauf (Berichte) enthält nur Zusammenfassungen
  und Pfade, keine Inhalte; jedes Konto sieht nur eigene Einträge, Einträge seines Profils und
  gemeinsame (USB, Updates). Geplante Scans prüfen Downloads/Desktop/Dokumente des eigenen
  Profils im eingeschränkten Prüfprozess und melden nur. `freshclam` startet nur vom festen
  ClamAV-Ort (nicht `PATH`), mit Zeitlimit, täglich und abschaltbar. Der HTML-Export wird in
  Rust erzeugt (maskiert, CSP ohne Skripte) und nur an den im Speichern-Dialog gewählten Ort
  geschrieben – die Oberfläche hat keinen Schreibbefehl mit eigenem Pfad.
- **YARA-X/wasmtime-Hinweise:** `cargo deny` ignoriert begründet einzelne wasmtime-Hinweise
  (betreffen WASI/Komponenten, die YARA-X nicht nutzt), `rsa` (Marvin, nur Signaturprüfung
  in Authenticode) und `bincode` (unmaintained) – erneute Prüfung bis 2027-01-31.
- **Fremde Dateien parsen ist riskant:** Parser laufen isoliert (Kindprozess, niedrige
  Integrität, Job-Objekt, kein Netz). Größen-/Tiefenlimits gegen Zip-Bomben.
- **Selbstschutz ist begrenzt:** Dienst-ACLs, Integritätsprüfung eigener Dateien, signierte
  Updates, Warnung bei Manipulation – aber kein Schutz gegen Admin-Angreifer.

## Desktop-App (Tauri)

- Strikte CSP: alles `'self'` (Skripte, Stile, Bilder, Schriften), keine Frames,
  `object-src 'none'`, kein `unsafe-inline`. Motion setzt nur Inline-`style`-Attribute über das
  DOM, die CSP nicht betreffen. Der Build bettet keine Dateien als `data:` ein.
- `withGlobalTauri: false`, `freezePrototype: true` (auch in den E2E-Tests nachgebildet).
- Capabilities: nur einzeln begründete Fenster-/Event-Rechte (Liste und Begründung in
  `apps/desktop/README.md`), keine `:default`-Bündel. App-Befehle (`app_info`, `hide_to_tray`)
  brauchen über das AppManifest eine eigene Berechtigung; ein Laufzeit-Test prüft, dass jeder
  Aufruf der Oberfläche gewährt ist und nichts darüber hinaus. Verstecken in den Infobereich
  entscheidet Rust (nur wenn das Tray-Symbol existiert – kein unsichtbarer Prozess).
- Startfehler: eine Zeile in `%LOCALAPPDATA%\AEGIS\logs\startup.log` (keine Links, keine
  Netzpfade, Steuerzeichen entfernt, Größe begrenzt; Allowlist-Einträge) + Fehlerdialog.
- Navigationswächter (`src-tauri/src/navigation.rs`): Das Fenster darf nur die gebündelte UI
  laden; externe Seiten werden blockiert. Keine CDNs, keine Telemetrie.
- Installation pro Nutzer (NSIS `currentUser`, Deutsch/Englisch), Admin nur für den Dienst.

## Lieferkette

- Alle GitHub Actions auf volle Commit-SHAs gepinnt (offizielle Repos, Version im Kommentar).
- `cargo deny` (Hinweise, Lizenzen – GPL ausgeschlossen, Quellen) und `pnpm audit` laufen bei
  jedem Push und wöchentlich (`.github/workflows/supply-chain.yml`).
- Cargo-Aufrufe in CI mit `--locked`, npm mit `--frozen-lockfile`; Clippy auch für Release.

## Tests mit Schadcode-Ersatz

Nur EICAR (zur Laufzeit aus Teilen erzeugt, nie als Datei eingecheckt – sonst schlägt
Windows Defender schon beim Klonen an), selbst erzeugte harmlose Dummy-Dateien und harmlose
Verhaltens-Simulatoren in Temp-/Test-Ordnern. Niemals echte Malware.

## Review-Pflicht

Änderungen an `crates/core`, Quarantäne, Krypto (`vault-core`, Datei-Safe), Dienst/Pipe,
Sandbox und Defender-Schalter werden von einem separaten Review-Agenten geprüft; die
Prüfung „kein Code-Pfad ändert etwas ohne Freigabe“ ist fester Bestandteil.

## Review-Protokoll

| Datum | Umfang | Ergebnis |
| --- | --- | --- |
| 2026-10-19 | P2.5-Nachprüfung (separater Agent): Korrekturen + neue Fehler im FFI | Alte Funde geschlossen bzw. teilweise; neu: 1 hoch (Server-Prüfung für Standardnutzer kaputt → Pipe-Besitzer), 6 mittel (Namenslücke, Leerlauf/Grenzen je Konto, Einträge ohne Konto, schreibgeschützt, Analysepunkte, ClamAV als SYSTEM → P3.2), 5 niedrig. Behoben (außer ClamAV-Token → P3.2, Pfad-Textvergleich nur dokumentiert), Tests ergänzt |
| 2026-10-19 | P2: Quarantäne, Dienst/Pipe, winffi, Engine-Anbindung, App-Client. 1 Prüfer, 4 Funde per Test nachgestellt | 1 kritisch (jeder Nutzer konnte über den SYSTEM-Dienst ohne UI isolieren/wiederherstellen → Identitätswechsel + Pfadregeln), 3 hoch (Links in Zwischenordnern/Überschreiben, Pipe-Instanzen durch Nutzer, vorab angelegter Datenordner), 3 mittel (Ausführung trotz Protokollausfall, Überlastung, ClamAV über PATH), 2 niedrig (Bidi in Plan-Texten, Unix-Rechte, fehlende Sperren). Alle behoben, Regressionstests in `crates/quarantine/tests`, `crates/service/tests`, Windows-Test für Identitätswechsel |
| 2026-10-19 | P1: Freigabe-Dialog, Fenster-/Tray-Rechte, Startprotokoll, Einstellungen, Barrierefreiheit, CI. 4 Prüfer + Gegenprüfung (vor Abschluss der Desktop-Korrekturen abgebrochen, Rest selbst geprüft) | 2 hoch (Sperrzeit-Umgehung, gestapelte Dialoge), 7 mittel (u. a. Bidi in Plan-Texten, Fokus bei Seitenwechsel, Windows-CI-Zeitlimit) – behoben mit Tests |
| 2026-10-19 | P0: `crates/core` (Freigabe, Protokoll, Mutations-Wächter), Tauri/CSP/CI, Design-System. 4 unabhängige Prüfer + adversarielle Gegenprüfung | 48 Funde bestätigt (0 kritisch, 0 hoch, 15 mittel, 24 niedrig, 9 Kleinigkeiten). 46 behoben, jeweils mit Regressionstest. Offen: Antwort-Nonce (→ P2, siehe Bedrohungsmodell), Meldung bei Startfehler der App (→ P1) |
