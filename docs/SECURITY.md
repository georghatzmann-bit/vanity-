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
- **Quarantäne-Schlüssel:** liegt als Datei `vault.key` im Datenordner (DACL: SYSTEM +
  Administratoren), unter Windows seit P5 zusätzlich per DPAPI an den Rechner gebunden
  (`CRYPTPROTECT_LOCAL_MACHINE`, eigene Entropie); ein alter, roher Schlüssel wird beim Start
  geprüft umgeschrieben. Die Verschlüsselung verhindert, dass Funde versehentlich ausgeführt,
  von anderen Scannern gemeldet oder auf einem anderen Rechner gelesen werden – nicht, dass ein
  Admin dieses Rechners sie liest.
- **Parser im Kindprozess (P3.2):** Fremde Dateien parst nur `aegis-scanworker` – unter Windows
  mit eingeschränktem Token des anfragenden Nutzers (keine Privilegien, Admin-Gruppen nur
  „deny“), **niedriger Integrität**, in einem Job-Objekt (2 GiB Speicher, höchstens 2 Prozesse,
  keine Zwischenablage/Desktop-Zugriffe, Ende mit dem Dienst) und mit Zeitlimit. `clamscan`
  läuft als Kind dieses Prozesses mit denselben Grenzen (nicht mehr als SYSTEM). Ist ein
  laufender `clamd` installiert (`clamdscan`), geht der Inhalt an diesen ClamAV-Dienst – der
  läuft mit den Rechten, die seine Installation ihm gibt, nicht in AEGIS’ Grenzen. Absturz oder
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
  Isolieren/Vertrauen nur über Vorschlag + Freigabe-Dialog. **Rechte (Review P3-1):** Der
  Wächter und geplante Scans lesen nie mit den Rechten des Dienstes: Dateien eines Profils mit
  dem Token der angemeldeten Sitzung des Profil-Besitzers, sonst (USB, Programme, Besitzer
  nicht angemeldet) mit einem „nur Nutzer“-Token (SYSTEM/Administratoren nur deny,
  eingeschränkt auf Everyone/Authentifizierte/Benutzer/RESTRICTED; als Dienst: Konto
  LocalService). Ein Link in einem
  Nutzerordner führt damit nicht zu fremden Dateien. Zusätzlich öffnet die Engine Dateien
  so, dass ein Austausch gegen einen Link zwischen Prüfen und Öffnen erkannt wird
  (Windows: tatsächlicher Pfad am Handle; Unix: Gerät + Inode). **Gaming-Modus** gilt je
  Konto: pausiert Hinweise und Prüfungen des eigenen Profils (gemeinsame Orte und andere
  Konten werden weiter geprüft), endet spätestens nach 4 Stunden; danach wird nachgeprüft.
  Prozessstarts gehören dem Konto, das sie gestartet hat (SID aus dem Prozess-Token); Dateien
  unter `C:\Users\<Name>` gehören immer diesem Profil – auch neu angelegte Profile werden
  binnen einer Minute beobachtet. Begrenzt: Warteschlange 4096, wartende Dateien 10 000,
  Meldungen 1000 (200 je Konto/Profil); Überlauf wird gezählt und angezeigt. Lässt eine Datei
  den Prüfprozess abstürzen, wird sie einzeln als „nicht prüfbar“ gemeldet. ETW-Sitzung mit
  eigenem Namen je Dienst-Start. Grenzen: externe USB-Festplatten (als „fest“ gemeldet) und
  Netzlaufwerke (je Nutzersitzung) überwacht der Dienst nicht.
- **Verlauf, Zeitpläne, Updates (P3.5):** Der Verlauf (Berichte) enthält nur Zusammenfassungen
  und Pfade, keine Inhalte; jedes Konto sieht nur eigene Einträge, Einträge seines Profils und
  gemeinsame (USB, Updates). Geplante Scans prüfen Downloads/Desktop/Dokumente des eigenen
  Profils im eingeschränkten Prüfprozess – nur mit den Rechten des angemeldeten Besitzers
  (sonst „nicht möglich“ im Verlauf) – und melden nur. `freshclam` startet nur vom festen
  ClamAV-Ort (nicht `PATH`), nur wenn Ordner, Programm, Konfiguration und Datenbank SYSTEM
  bzw. den Administratoren gehören, mit expliziter Konfiguration/Datenbank, in einem Job
  (Speicher, Prozesse, Ende samt Kindprozessen) und Zeitlimit; täglich, nach Fehlschlag nach
  einer Stunde erneut; abschalten können es nur Administratoren (rechnerweit). Verlauf,
  Vertrauensliste und Einstellungen: Größe beim Schreiben begrenzt (nie größer als beim
  Lesen erlaubt), Quoten je Konto, beschädigte Dateien werden beiseitegelegt
  (`*.json.corrupt`) statt den Start zu verhindern – AEGIS wird dadurch nur strenger. Der HTML-Export wird in
  Rust erzeugt (maskiert, CSP ohne Skripte) und nur an den im Speichern-Dialog gewählten Ort
  geschrieben – die Oberfläche hat keinen Schreibbefehl mit eigenem Pfad.
- **Labor (P4):** Jeder Lauf ist ein eigener Plan („Im Labor ausführen“: Stufe, Sekunden,
  Netz und SHA-256 der Probe zum Zeitpunkt des Vorschlags) und braucht „Ja“; „Vertrauen“ gibt
  es für Labor- und Einstellungs-Vorschläge nicht. Die Erlaubnis wandert in den Lauf und wird
  mit dem echten Ergebnis protokolliert. Das Original öffnet der Dienst nur im
  Identitätswechsel (ohne Links); in den Labor-Ordner kommt eine Kopie unter festem Namen
  (`probe.<endung>`), deren Prüfsumme dem Plan entsprechen muss. Gestartet wird nie mit einem
  Dienstkonto: Token nur aus dem Identitätswechsel (kein Rückfall), bei erhöhten
  Administratoren das nicht erhöhte verknüpfte Token, Umgebung des Nutzers. Stufe 2:
  AppContainer ohne Fähigkeiten, **eigenes Profil je Lauf** (als Nutzer angelegt und danach
  gelöscht), Job mit Speicher-/Prozess-/CPU-Grenzen, Arbeitsordner nur für SYSTEM/Admins,
  Nutzer und diesen AppContainer. Stufe 1: Windows Sandbox (Netz nur auf Wunsch, Zwischenablage,
  Drucker, GPU, Audio/Kamera aus, Probe-Ordner nur lesbar); AEGIS hält den Prozess, beendet ihn
  am Ende der Frist bzw. bei mehr als 64 MiB Ausgabe und liest `report.json` (≤ 1 MiB) und
  Bildschirmfotos erst danach – **nur im Identitätswechsel**, ohne Links/Hardlinks, PNG geprüft
  (Signatur, Kanten ≤ 4096), Texte und Listen begrenzt. Ehrlich: Den Bericht der Stufe 1
  erstellt die Sonde in der VM – die Probe könnte ihn verfälschen (steht im Bericht). Die Sonde
  prüft ihr Konto am Token (WDAGUtilityAccount) und die eingebundenen Ordner. Fensterfotos der
  Stufe 2 macht die App nur für Prozesse, deren AppContainer-SID der des Laufs entspricht
  (hängende Fenster übersprungen); Bilder werden auf ein Canvas gezeichnet (CSP unverändert).
  Grenzen: 2 gleichzeitige Läufe, 1 je Konto; DISM (Windows Sandbox einschalten, nur Admin)
  einmal gleichzeitig, höchstens 30 Minuten.
- **Prozess-Aktionen (P5.2):** Beenden, Anhalten und Fortsetzen sind Pläne mit den Prozessen
  (ID + Programmpfad) als Ziel; der Dienst nennt nur Prozesse, die dem anfragenden Konto
  gehören. Vor jeder Aktion wird am geöffneten Prozess erneut geprüft, ob ID und Programm noch
  passen (keine wiederverwendete ID) und ob er kritisch ist (`IsProcessCritical`) – kritische
  Systemprozesse und AEGIS selbst werden nie angefasst. Geöffnet wird im Identitätswechsel,
  also nur mit den Rechten des Nutzers.
- **Ransomware-Schutz (P5.3):** Köderdateien sind ein eigener Plan (Dateien als Ziele), werden
  mit den Rechten des Nutzers und ohne Links nur **neu** angelegt und nur entfernt, solange
  sie noch genau den AEGIS-Inhalt haben. Erkannt werden Änderungen an Ködern sowie viele
  Änderungen/Umbenennungen/Löschungen in kurzer Zeit im eigenen Profil (je Profil gezählt,
  laute Ordner wie Browser-Caches ausgenommen, Pause nach einer Warnung). Ehrlich: ohne
  Treiber erst, wenn der Angriff läuft; Gegenmaßnahmen (Panic-Button, Beenden, Isolieren) nur
  nach „Ja“.
- **Panic-Button (P5.4):** „Netz trennen“ legt zwei feste Sperrregeln der Windows-Firewall an
  (`netsh` vom festen Systempfad, feste Argumente, Zeitlimit 30 s); „Wieder verbinden“ ist ein
  eigener Plan und löscht genau diese Regeln. Der Plan nennt die rechnerweite Wirkung
  (alle Konten, Firewall bleibt an).
- **Speicher-Scan (P5.5):** liest nur Prozesse des anfragenden Kontos, im Identitätswechsel
  (Module und ausführbarer privater Speicher, je Bereich und Anfrage begrenzt – 10 MiB je
  Anfrage an den Prüfprozess). Geprüft wird ausschließlich im eingeschränkten Prüfprozess
  (YARA/EICAR); gemeldet wird nur.
- **Datei-Safe (P5.6):** Ordner im Profil des Nutzers; alle Zugriffe im Identitätswechsel und
  ohne Links (der Safe-Ordner muss ohne Umweg über Verknüpfungen erreichbar sein). Zufälliger
  256-Bit-Datenschlüssel, verpackt mit Argon2id (64 MiB, 3 Durchläufe) + AES-256-GCM; Inhalte
  im Quarantäne-Containerformat, Name/Herkunft verschlüsselt je Eintrag. Das Passwort kommt
  nur über die Pipe (`Password`: nie in `Debug`, beim Verwerfen überschrieben), wird nie
  gespeichert – nicht im Plan, Protokoll oder Verlauf (Test prüft das Prüfprotokoll). Der
  entsperrte Schlüssel liegt nur im Speicher des Dienstes je Konto und verfällt nach 10 min
  ohne Nutzung, beim Sperren und beim Neustart. 5 Fehlversuche → 60 s Pause. Hineinlegen:
  Original erst nach geprüfter Kopie entfernt; Herausholen: nie überschreiben, SHA-256
  geprüft, erst danach aus dem Safe entfernt. Ehrlich: Wer das Konto oder den Dienst
  kontrolliert, während der Safe entsperrt ist, kann mitlesen; ein vergessenes Passwort kann
  niemand ersetzen.
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
| 2026-10-19 | P4: Labor (Dienst, winffi-Sandbox, Sonde, App-Befehle, Labor-Seite). 1 Prüfer | 1 hoch: P4-1 Absturz des Dienstes über einen Bildnamen mit Mehrbyte-Zeichen (Byte-Slicing, `panic = abort`) → reine ASCII-/Byteprüfung vor allem anderen, Test. 6 mittel: P4-2 Ausgabe der Stufe 1 als SYSTEM unter der Dienst-Sperre gelesen → Identitätswechsel, Hardlink-Prüfung, außerhalb der Sperre; P4-3 VM nicht kontrolliert, erster Bericht vertraut → Prozess gehalten, Frist/Größengrenze, Lesen erst nach Ende, Hinweise vom Dienst; P4-4 gemeinsames, bleibendes AppContainer-Profil → Profil je Lauf, danach gelöscht, kein SYSTEM-Rückfall; P4-5 Erlaubnis vor der Arbeit als „erfolgreich“ protokolliert → Erlaubnis im Lauf, echtes Ergebnis; P4-6 „Vertrauen“ auf Labor-Vorschläge → abgelehnt (Dienst + UI); P4-7 Berichtsgrößen → 1 MiB, Textgrenzen, Bericht nur je Lauf. 8 niedrig/Kleinigkeiten (stiller Token-Rückfall, Ordnerrechte Stufe 2, Zählung aktiver Läufe, Dateiname der Kopie, Sonde per Umgebungsvariable, Fensterfotos ohne AppContainer-/Hänger-Prüfung, PNG ungeprüft, Prüfsumme nicht verglichen, DISM ohne Frist, Netz-Text) – alle behoben, Tests ergänzt |
| 2026-10-19 | P3: Prüfprozess/Token, Vertrauensliste, Wächter, Verlauf/Zeitpläne/Updates, HTML-Export. 2 Durchgänge (der erste brach nach dem ersten Fund ab) | 2 hoch: P3-1 Hintergrundprüfungen mit SYSTEM-abgeleitetem Token (→ Profil-Besitzer bzw. LocalService, Öffnen mit Prüfung am Handle), P3-2 Verlauf/Vertrauensliste konnten den Dienststart blockieren (→ Größen- und Längengrenzen, Quoten, Beiseitelegen). 8 mittel (Aushungern/Warteschlange, Abstürze verstecken Dateien, rechnerweite Schalter für jeden Nutzer → Gaming je Konto + Admin-Pflicht, gemeinsame Grenzen → Quoten, Dateizugriffe unter der Sperre, freshclam als SYSTEM ohne Job, Zuordnung „gemeinsam“ nach Pfad → SID/Profil-Wurzel, LocalService statt eingeschränktem SYSTEM). 6 niedrig (Rückfall auf Dienst-Token, gemeinsame „unbekannt“-Kennung, Pfadvergleich, Termine, USB/ETW, Export überschreibt). Alle behoben bzw. Grenzen dokumentiert, Tests ergänzt (Windows-Test „nur Nutzer“-Token) |
| 2026-10-19 | P2.5-Nachprüfung (separater Agent): Korrekturen + neue Fehler im FFI | Alte Funde geschlossen bzw. teilweise; neu: 1 hoch (Server-Prüfung für Standardnutzer kaputt → Pipe-Besitzer), 6 mittel (Namenslücke, Leerlauf/Grenzen je Konto, Einträge ohne Konto, schreibgeschützt, Analysepunkte, ClamAV als SYSTEM → P3.2), 5 niedrig. Behoben (außer ClamAV-Token → P3.2, Pfad-Textvergleich nur dokumentiert), Tests ergänzt |
| 2026-10-19 | P2: Quarantäne, Dienst/Pipe, winffi, Engine-Anbindung, App-Client. 1 Prüfer, 4 Funde per Test nachgestellt | 1 kritisch (jeder Nutzer konnte über den SYSTEM-Dienst ohne UI isolieren/wiederherstellen → Identitätswechsel + Pfadregeln), 3 hoch (Links in Zwischenordnern/Überschreiben, Pipe-Instanzen durch Nutzer, vorab angelegter Datenordner), 3 mittel (Ausführung trotz Protokollausfall, Überlastung, ClamAV über PATH), 2 niedrig (Bidi in Plan-Texten, Unix-Rechte, fehlende Sperren). Alle behoben, Regressionstests in `crates/quarantine/tests`, `crates/service/tests`, Windows-Test für Identitätswechsel |
| 2026-10-19 | P1: Freigabe-Dialog, Fenster-/Tray-Rechte, Startprotokoll, Einstellungen, Barrierefreiheit, CI. 4 Prüfer + Gegenprüfung (vor Abschluss der Desktop-Korrekturen abgebrochen, Rest selbst geprüft) | 2 hoch (Sperrzeit-Umgehung, gestapelte Dialoge), 7 mittel (u. a. Bidi in Plan-Texten, Fokus bei Seitenwechsel, Windows-CI-Zeitlimit) – behoben mit Tests |
| 2026-10-19 | P0: `crates/core` (Freigabe, Protokoll, Mutations-Wächter), Tauri/CSP/CI, Design-System. 4 unabhängige Prüfer + adversarielle Gegenprüfung | 48 Funde bestätigt (0 kritisch, 0 hoch, 15 mittel, 24 niedrig, 9 Kleinigkeiten). 46 behoben, jeweils mit Regressionstest. Offen: Antwort-Nonce (→ P2, siehe Bedrohungsmodell), Meldung bei Startfehler der App (→ P1) |
