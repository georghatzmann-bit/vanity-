# Entscheidungen (ADR-Kurzform)

## D-001 – Entwicklung im Linux-Container, Windows-Verifikation über CI
**Kontext:** Der Entwicklungs-Container hat weder WebView2 noch MSVC/Windows-SDK.
**Entscheidung:** Plattformneutraler Code wird lokal gebaut und getestet. Windows-Code steht
hinter `cfg(windows)` und wird lokal mit `cargo clippy --target x86_64-pc-windows-msvc`
(ohne Linken) geprüft. Echte Windows-Builds, Tests und der NSIS-Installer laufen in GitHub
Actions (`windows-latest`). Das Windows-SDK wird **nicht** per `xwin` in den Container geladen,
weil dafür Microsofts Lizenzbedingungen akzeptiert werden müssten.

## D-002 – Monorepo mit pnpm + Cargo-Workspace
`@aegis/ui` wird als Quellpaket (TypeScript direkt) von Vite eingebunden – kein eigener
Build-Schritt, schnelle Iteration. Rust-Abhängigkeiten zentral in `[workspace.dependencies]`.

## D-003 – Zusätzliches Crate `crates/core` für die Goldene Regel
**Kontext:** Die Ordnerstruktur sieht kein gemeinsames Crate vor, aber jedes Fachmodul braucht
dieselben Freigabe-Typen. **Entscheidung:** `aegis-core` enthält `ActionPlan`, `ConsentGate`,
`Approval`, Prüfprotokoll, Risikostufen und Test-Hilfen. Verändernde APIs nehmen
`Approval` als Wert – die Regel wird damit vom Compiler erzwungen, nicht nur per Konvention.

## D-004 – Design-Tokens: Tailwind 4 CSS-first + TypeScript-Spiegel
Tokens liegen als CSS-Variablen (`@theme`) vor; ein TS-Spiegel dient Canvas/Motion.
Ein Test stellt sicher, dass beide übereinstimmen und alle Text/Hintergrund-Paare WCAG AA erfüllen.

## D-005 – Schriften lokal gebündelt
Inter Variable (UI) und JetBrains Mono (Hashes/Technik), beide SIL OFL 1.1, über
`@fontsource-variable/*` lokal eingebunden. Keine CDN-Abrufe (offline, keine Telemetrie).

## D-006 – TypeScript 6.0 statt 7.0
`typescript-eslint` 8.71 unterstützt TypeScript `<6.1`. Wechsel auf 7.x, sobald unterstützt.

## D-007 – Playwright 1.56.1 gepinnt
Passt zum vorinstallierten Chromium im Container; in CI identisch. Update bewusst später.

## D-008 – Tauri-Härtung
Strikte CSP ohne `unsafe-inline`, `withGlobalTauri: false`, `freezePrototype: true`, keine
Capabilities (`permissions: []`) bis ein IPC-Befehl sie braucht, Navigationswächter.
Installation pro Nutzer (NSIS `currentUser`); der Windows-Dienst bekommt einen eigenen,
UAC-pflichtigen Installationsschritt.

## D-009 – Bezeichner `app.aegissuite.desktop`
Vorläufiger Tauri-Identifier (keine Domain registriert). Änderung vor dem ersten Release möglich.

## D-010 – Projektlizenz offen
Rechtliche Entscheidung des Nutzers. Bis dahin keine Lizenzangabe, `publish = false`/`private`.

## D-011 – Ausführende Funktionen nehmen `ExecutionPermit`, nicht `Approval`
Die Erlaubnis enthält eine Kopie des freigegebenen Plans; Ausführer lesen Ziele und Parameter
nur daraus. So kann man einer Ausführung keinen anderen Plan unterschieben.

## D-012 – Versiegelte Uhr
`redeem` prüft Fristen mit der Uhr des Tors statt mit einem übergebenen Zeitpunkt. `Clock` ist
versiegelt: außerhalb von `aegis-core` gibt es nur `SystemClock` (und `ManualClock` im
Test-Feature). Produktionscode kann Fristen nicht mit erfundenen Zeiten umgehen.

## D-013 – Plan-Parameter sind Teil des Digests
`ActionPlan` hat eine sortierte Parameter-Tabelle (z. B. `destination`, `new_name`). Ohne sie
müssten Ausführer Werte von außerhalb des freigegebenen Plans nehmen.

## D-014 – Freigabe-Tor ohne I/O
`ConsentGate` sammelt Audit-Ereignisse; der Dienst holt sie ab und schreibt das Protokoll.
Der Kern bleibt deterministisch und ohne Dateizugriff testbar.

## D-015 – Mutations-Sperre per Clippy + Allowlist-Test
Statt einer reinen Konvention sperrt `clippy.toml` verändernde std-APIs. `OpenOptions::open`
bleibt erlaubt (Lesen braucht es), gesperrt sind die Schreib-/Anlege-/Kürz-Schalter.
Ausnahmen brauchen Markierung + Eintrag in `crates/core/mutation-allowlist.txt`.

## D-016 – Design-Quellen
`tokens.css` ist die Quelle, `tokens.ts` wird per Test dagegen geprüft. Logo-Assets
(`packages/ui/assets/*.svg`) erzeugt `scripts/export-logo.mjs` aus `geometry.ts`; App-Icons
werden mit `tauri icon` aus `logo-mark.svg` erzeugt.

## D-017 – CSP-Einzelquelle und lokale Schriften
`tauri.conf.json` ist die einzige CSP-Quelle; `vite preview` sendet dieselbe Richtlinie
(`apps/desktop/src/csp.ts`), damit Playwright unter App-Bedingungen testet. Schriften werden
nie als `data:` eingebettet (`font-src 'self'`).

## D-018 – Start-Klang und Autoplay
Vor der ersten Nutzergeste (`navigator.userActivation`) wird kein AudioContext erzeugt – der
Start-Klang beim Kaltstart bleibt still, ohne Browser-Warnung. Ob die App Autoplay in WebView2
erlauben soll, damit der Start-Klang hörbar ist, wird in P1 mit den Einstellungen entschieden.

## D-019 – Eigener Router und eigenes i18n
Hash-Router und typisiertes i18n (de als Quelle, en typgeprüft) ohne Fremdabhängigkeit.
Einstellungen unter `aegis.settings` (v1) im localStorage; Daten einer neueren Version werden
nie überschrieben.

## D-020 – Freigabe-Dialog: Schutz vor versehentlichem „Ja“
Fokus startet auf „Nein“, Esc = Nein, kein Schließen-X, Klick daneben tut nichts. „Ja“,
„Vertrauen“ und „Ignorieren“ sind nach dem Öffnen (und bei Planwechsel/Wechsel des obersten
Dialogs) 600 ms gesperrt; ein Druck, der während der Sperre beginnt, zählt nicht. Endgültiges
Löschen: zweiter Dialog mit Countdown statt Bestätigungswort.

## D-021 – Schließen und Infobereich
Ob in den Infobereich versteckt wird, entscheidet Rust (`hide_to_tray`) – nur wenn das
Tray-Symbol existiert. Alt+F4/Taskleiste beenden AEGIS immer. Der Schutz-Dienst (ab P2) läuft
unabhängig von der Oberfläche.

## D-022 – Fehlerdialog über `rfd`
Statt eigenem `unsafe`-FFI (MessageBoxW) nutzt die App `rfd` (MIT) – weniger eigenes unsafe.

## D-023 – Eigenes Crate `aegis-winffi` für `unsafe`
Alle Bibliotheken unter `crates/` tragen `#![forbid(unsafe_code)]`. Die einzige Ausnahme ist
`aegis-winffi` (Named Pipe mit SDDL, Datenordner-DACL): jede `unsafe`-Stelle mit
`// SAFETY:` und `// aegis-unsafe:`-Markierung in der Allowlist. So bleibt FFI an einer
prüfbaren Stelle.

## D-024 – Nur der Dienst nimmt Nutzerantworten an
`ConsentGate::decide`/`confirm_second` sind per `clippy.toml` gesperrt; einzige Ausnahme ist
der Handler in `crates/service`. Die App gibt die Antwort nur weiter (mit Plan-ID, Digest,
Nonce). Die App hält kein eigenes Tor.

## D-025 – Eigener Pipe-Client in der App
Die App spricht das Dienstprotokoll mit einem kleinen eigenen Client (`src-tauri/src/service.rs`),
statt das Dienst-Crate einzubinden – die App zieht so weder Engine noch Quarantäne nach und
prüft Eingaben selbst, bevor sie etwas sendet.

## D-026 – Dateiauswahl über `tauri-plugin-dialog`
Pfade wählt der Nutzer im System-Dialog (nur `dialog:allow-open`). Die Oberfläche bekommt
keinen Dateisystem-Zugriff; sie reicht nur die gewählten Pfade an den Dienst.

## D-027 – Quarantäne-Format
AES-256-GCM in 1-MiB-Blöcken (Nonce = 7-Byte-Präfix + Zähler + Letzter-Block-Flag, Kopf als
AAD) – große Dateien ohne ganzen Inhalt im Speicher, Abschneiden/Umordnen fällt auf.
Wiederherstellen schreibt erst eine versteckte Teil-Datei neben dem Ziel, prüft SHA-256 und
Größe und legt sie erst dann an den ursprünglichen Ort; ein belegtes Ziel wird nicht überschrieben.

## D-028 – Vertrauensliste als JSON statt SQLite (vorerst)
Die Vertrauensliste ist klein (höchstens 10 000 Einträge) und wird selten geändert. Eine
JSON-Datei im Datenordner, atomar ersetzt, braucht keinen C-Code (SQLite) im Dienst und
keine zusätzliche Angriffsfläche. SQLite kommt erst, wenn Datenmengen es verlangen (z. B.
Zeitleiste mit vielen Funden). Einträge gelten je Konto (SID) und nur für Hash **und** Pfad.

## D-029 – Prüfprozess statt Parsen im Dienst
Fremde Dateien parst ausschließlich `aegis-scanworker` mit eingeschränktem, vom Nutzer
abgeleitetem Token, niedriger Integrität und Job-Objekt. Fehlt das Programm, startet der Dienst
nicht – kein stiller Rückfall auf das Parsen als SYSTEM.

## D-030 – Verlauf getrennt vom Prüfprotokoll
Berichte und Zeitleiste lesen einen eigenen Verlauf (`history.json`, höchstens 2000 Einträge,
je Konto bzw. Profil sichtbar), nicht das Prüfprotokoll. Das Prüfprotokoll (Hash-Kette) bleibt
der fälschungssichere Nachweis jeder Freigabe; der Verlauf ist eine lesbare Zusammenfassung,
deren Speicherfehler nichts blockiert (er wird nur angezeigt).

## D-031 – HTML-Bericht entsteht in Rust, Ort nur über den Speichern-Dialog
`export_report` holt den Verlauf selbst vom Dienst, erzeugt die Seite (alle Texte maskiert,
CSP `default-src 'none'`, keine Skripte/externen Quellen) und speichert sie dort, wo der
Nutzer es im System-Dialog wählt. Die Oberfläche kann weder Inhalt noch Pfad vorgeben – kein
allgemeiner Schreibbefehl. PDF entsteht über Drucken („Als PDF speichern“) mit Druck-CSS.

## D-032 – Geplante Scans und Signatur-Updates im Dienst
Zeitpläne gelten je Konto für Downloads, Desktop und Dokumente des Profils, laufen im
eingeschränkten Prüfprozess und melden nur (wie der Wächter). Die Stunde speichert der Dienst
in UTC; die App rechnet aus der Ortszeit um (Sommerzeit verschiebt um eine Stunde – bewusst
hingenommen). `freshclam` läuft täglich vom festen ClamAV-Ort, ist abschaltbar und ändert nur
die ClamAV-Datenbank.

## D-033 – Labor: zwei Stufen, ehrlich benannt
Stufe 1 ist die Windows Sandbox (eigene, wegwerfbare VM; Netz aus, nur auf ausdrücklichen
Wunsch an). Gibt es sie nicht (Home) oder ist sie aus, nutzt das Labor Stufe 2: ein
AppContainer ohne Fähigkeiten (kein Netz, niedrige Integrität) mit Job-Grenzen. Die Oberfläche
sagt klar, dass Stufe 2 schwächer als eine VM ist (gleicher Kernel und Desktop). Jeder Lauf
braucht einen eigenen Plan („Im Labor ausführen“, Stufe/Sekunden/Netz im Plan) und „Ja“; das
Original wird nur gelesen (Kopie mit SHA-256 im Labor-Ordner). Einschalten der Windows Sandbox
ist ein eigener Plan (nur Administratoren, DISM ohne Neustart).

## D-034 – Bildschirmfotos ohne Lockerung der CSP
Bilder kommen als PNG-Bytes über IPC und werden per `createImageBitmap` auf ein Canvas
gezeichnet – `img-src` bleibt `'self'` (kein `data:`/`blob:`). Fotos der Mini-Sandbox macht
die App (der Dienst läuft in Sitzung 0 und sieht den Desktop nicht), aber nur für die
Prozess-IDs, die der Dienst für einen laufenden eigenen Lauf nennt.

## D-035 – Prozess-Aktionen nur für eigene Prozesse
Der Dienst schlägt Beenden/Anhalten/Fortsetzen nur für Prozesse des anfragenden Kontos vor und
führt sie im Identitätswechsel aus. So kann ein Nutzer über den SYSTEM-Dienst nichts beenden,
was er nicht ohnehin beenden dürfte; kritische Systemprozesse sind ausgeschlossen.

## D-036 – Notfall „Netz trennen“ über die Windows-Firewall
Netz trennen per zwei eigene Sperrregeln (ein-/ausgehend, alle Profile) statt Adapter
abschalten: wirkt sofort, ist genau rückgängig zu machen (nur die AEGIS-Regeln) und braucht
keinen Treiber. Laufende Programme werden nicht automatisch beendet (Goldene Regel) – das geht
einzeln über „Beenden …“. **Wer darf:** Trennen darf jedes angemeldete Konto – im Ernstfall
(Ransomware im eigenen Konto) zählt Schutz mehr als die Gefahr, dass jemand den Rechner kurz
vom Netz nimmt; der Plan nennt die Wirkung für alle Konten. Wieder verbinden dürfen nur das
trennende Konto und Administratoren, damit Schadsoftware in einem anderen Konto die Trennung
nicht aufheben kann. Der eigentliche **Panic-Button** der Spezifikation ist der Notfall-Scan
(D-039).

## D-037 – Datei-Safe im Profil, Schlüssel nur aus dem Passwort
Der Safe liegt im Profil des Nutzers (nicht im Datenordner des Dienstes), damit Rechte und
Sicherungen des Kontos gelten. Der Schlüssel entsteht nur aus dem Passwort (Argon2id) – kein
Wiederherstellungsweg, auch nicht für AEGIS; das steht im Plan und auf der Seite. Der Dienst
hält den entsperrten Schlüssel höchstens 10 min ohne Nutzung im Speicher.

## D-038 – Eigene Seite „Datei-Safe“ unter „Schutz“
Der Safe ist kein Passwort-Tresor (P9) und keine Quarantäne – er bekommt eine eigene Seite in
der Gruppe „Schutz“ mit eigenem Symbol.

## D-039 – Panic-Button = Notfall-Scan
Laut Spezifikation (Modul G) ist der Panic-Button ein sofortiger, nur lesender Notfall-Scan mit
anschließendem Sammel-Isolieren (vorausgewählt nur „Gefährlich“) und „Alles rückgängig“. Er
liegt auf der Scan-Seite und ist über Dashboard und Befehlspalette erreichbar. „Netz trennen“
bleibt als zusätzliche Notfall-Maßnahme beim Ransomware-Schutz.

## D-040 – Geschützte Ordner nur beobachten, nicht prüfen
Dokumente, Bilder und eigene Schutzordner werden nur für die Ransomware-Erkennung beobachtet
(Köder, Massenänderungen, Entropie-Stichproben) – nicht jede geänderte Datei wird geprüft;
das bliebe bei großen Ordnern zu teuer. Geprüft werden weiter Downloads, Desktop, Temp,
Wechseldatenträger und Programmstarts. Eigene Schutzordner sind eine Einstellung (wie der
Zeitplan), kein Plan: Sie ändern nur, was AEGIS beobachtet, nicht die Ordner.

## D-041 – Rückfall-Kopien im Datenordner des Dienstes
Die Spezifikation nennt „versionierten AEGIS-Ordner/externes Laufwerk“. Standard ist der
Datenordner des Dienstes: Ransomware mit Nutzerrechten kann ihn weder lesen noch verschlüsseln
oder löschen. Gelesen wird mit den Rechten des Nutzers, geschrieben nur in AEGIS-eigene Dateien.
Für das externe Laufwerk gibt es den Export (eigener Plan): normale Kopien der neuesten Versionen
in einen gewählten Ordner – nach dem Abziehen offline geschützt. Ausdünnen ist „Endgültig
löschen“ mit zweiter Bestätigung; die neueste Version bleibt.

## D-042 – Rückfall-Kopien: feste Grenzen und Index als Zeilenprotokoll

Status: angenommen (P5.11). Eine volle Systemplatte würde das Prüfprotokoll und damit jede
Aktion von AEGIS lahmlegen. Darum: je Konto die gewählte Grenze, über alle Konten 200 GiB, und auf
dem Laufwerk bleiben immer mindestens 10 GiB bzw. 10 % frei – sonst pausieren die Kopien. Gelesen
wird nur die beim Sammeln geprüfte Größe (wächst die Datei, wird die Kopie verworfen);
Cloud-Platzhalter (OneDrive „nur online“) werden nicht gesichert, weil Lesen sie herunterladen
würde. Der Index ist ein Zeilenprotokoll (eine Zeile je Version, angehängt): ein Lauf liest ihn
einmal, beschädigte Zeilen kosten nur diese Version, und Ausdünnen schreibt ihn neu und räumt
verwaiste Kopien mit auf. Export und Ausdünnen laufen nach dem „Ja“ außerhalb der Dienst-Sperre,
Sicherungsläufe in einem eigenen Faden, der beim Beenden des Dienstes zwischen Dateien abbricht.

## D-043 – Sicherheits-Score: ehrlich statt schön

Status: angenommen (P6.1). Zwölf feste Prüfungen mit Gewichten (Summe 100); „in Ordnung“ zählt
voll, „verbesserbar“ halb, „Risiko“ nichts. Was der Dienst nicht lesen kann, ist „unbekannt“ und
fällt aus der Rechnung – statt als gut oder schlecht geraten zu werden. Liegen weniger als 50
Gewichtspunkte vor, gibt es keinen Score („Kein Messwert“). Die Fakten liest der Dienst (SYSTEM,
nur lesend), weil BitLocker/TPM ohne erhöhte Rechte nicht lesbar sind; die App bleibt ohne
Admin-Rechte. Verlauf: ein Wert je Tag, 90 Tage, im Einstellungsspeicher des Dienstes.

## D-044 – Härtung beheben: Schritte im Plan, Rückgängig gemerkt, keine Richtlinien

Status: angenommen (P6.2). Ein „Beheben“ ist immer ein Plan „Einstellung ändern“, dessen Ziele
jeden einzelnen Schritt im Klartext nennen (z. B. `HKLM\…\SMB1 = 0 (DWORD)`). Beim Ausführen
werden die Schritte neu bestimmt und mit dem Plan verglichen – so bindet das „Ja“ genau diese
Änderung. Der alte Stand wird roh gemerkt; „Rückgängig“ ist ein eigener Plan. Rechnerweite
Schritte dürfen nur Administratoren vorschlagen und ausführen lassen; der Proxy gehört dem
Konto. Gruppenrichtlinien ändert AEGIS nie (sie gehören der IT bzw. dem Besitzer des PCs).
BitLocker, Updates und Virenschutz schaltet AEGIS nicht selbst – die App öffnet dafür nur die
passende Windows-Seite aus einer festen Liste.

## D-045 – Persistenz-Check: erklären statt raten, deaktivieren statt löschen

Status: angenommen (P6.3). Autostarts werden gelesen, mit nachvollziehbaren Merkmalen bewertet
und die Programmdateien im Prüfprozess geprüft – „unauffällig“ heißt nicht „sicher“. Deaktivieren
entfernt nur den Autostart (Run-Wert, Aufgabe, Dienst-Start), nie die Programmdatei, und ist mit
Rückgängig gemerkt. Dateien im Autostart-Ordner gehen den bekannten Weg über die Quarantäne.
Winlogon, WMI-Abos, COM-Einträge und Browser-Erweiterungen zeigt AEGIS mit Erklärung an,
ändert sie aber nicht selbst (zu leicht zu beschädigen bzw. Sache des Browsers).

## D-046 – Treiber-Check: LOLDrivers gebündelt, Boot-Treiber nie anfassen

Status: angenommen (P6.4). Kernel-Treiber sind ein Teil des Persistenz-Checks (Art `driver`):
Dienst-Einträge mit Typ 1/2 plus geladene Treiber ohne Eintrag (`EnumDeviceDrivers`). Abgleich mit
der LOLDrivers-Liste (Apache-2.0) über SHA-256 der Datei **und** Authenticode-Hash (findet neu
signierte Fassungen); die Liste ist gebündelt (≈ 400 KB, kein Netz zur Laufzeit) und wird mit
`scripts/update-loldrivers.mjs` erneuert – später über die signierten Updates (P13). Treiber im
Windows-Ordner prüft nur der Listenabgleich (Hunderte Systemdateien), andere zusätzlich der
Prüfprozess. Deaktivieren (Start = 4, wirkt nach Neustart, mit Rückgängig) bietet AEGIS nur für
Treiber mit Start „automatisch“/„manuell“ an; Boot-/System-Treiber nie, weil Windows sonst evtl.
nicht mehr startet – dort empfiehlt AEGIS Hersteller-Update bzw. Deinstallation. Neue Score-Prüfung
„Schutz vor verwundbaren Treibern“ (Gewicht 4; Updates, Secure Boot, Firewall, Virenschutz je 1
weniger): Speicher-Integrität an = in Ordnung; nur Microsoft-Sperrliste = verbesserbar (öffnet
Kernisolierung); Sperrliste aus = Risiko mit Plan `VulnerableDriverBlocklistEnable = 1`
(nicht, wenn eine Device-Guard-Richtlinie die Treiber-Regeln festlegt).

## D-047 – Software-Updates über winget im Dienst, je Paket ein Plan

Status: angenommen (P6.5). Neue Aktionsart `update_software` (Ziel: Beschreibung, Pflicht-Parameter
`package_id` und `package_version`, im Core geprüft: nur Buchstaben, Ziffern, `.-_+`, kein
Schalter). Die Liste holt der Dienst nur auf Knopfdruck mit `winget upgrade --source winget`
(Netz, abschaltbar durch Nicht-Benutzen; nichts läuft im Hintergrund). Gelesen wird die Tabelle
über die Spaltenanfänge der Kopfzeile; unplausible Zeilen werden verworfen, gekürzte Kennungen
nicht angeboten. Ein Vorschlag geht nur aus der höchstens 60 Minuten alten Liste und nur für
Administratoren (der Dienst installiert als SYSTEM für alle Konten). Nach „Ja“ läuft
`winget upgrade --id <id> --exact --version <ver> --source winget --silent …` außerhalb der
Dienst-Sperre (aufgeschobene Arbeit wie beim Export), höchstens ein Update gleichzeitig, Frist
30 Minuten. winget liegt im geschützten `WindowsApps` (App-Installer, höchste Version); AEGIS
bündelt nichts. Rückgängig gibt es nicht automatisch – der Plan sagt das und nennt den
winget-Befehl für die alte Version. Nur für ein Konto installierte Programme meldet winget als
SYSTEM oft nicht; die UI sagt das.

## D-049 – Netzwerk-Monitor ohne Netz, Firewall nur mit eigenen Regeln

Status: angenommen (P7.1/P7.2). Verbindungen liest der Dienst (TCP-Tabelle mit Prozess, Programm,
Konto) – ein Konto sieht nur seine eigenen Programme, Administratoren alle. Länder kommen aus
einer gebündelten, gemeinfreien Tabelle (iptoasn.com, 1,6 MB) – keine GeoIP- oder
Reverse-DNS-Abfrage im Netz. „Neu“ heißt: dieses Programm kontaktiert dieses Internet-Ziel zum
ersten Mal seit Dienststart (Verlauf je Konto nur im Speicher, 30 Tage, 2000 Ziele; die erste
Abfrage ist Grundlinie). Firewall: Regeln werden aus der Registrierung gelesen; AEGIS schlägt nur
eigene Regeln `AEGIS-Block-<Prüfsumme des Pfads>` vor (ausgehend blockieren, Programmpfad geprüft,
per `netsh` nach „Ja“, Administrator, Rückgängig über den bekannten Härtungs-Weg) und entfernt nur
solche Regeln. Fremde Regeln und Profile fasst AEGIS hier nie an.

## D-048 – Geräte & Privatsphäre: melden statt blockieren, Zwischenablage nur in der App

Status: angenommen (P6.6). Ohne Treiber kann AEGIS Kamera, Mikrofon oder USB nicht sperren – es
meldet. Kamera/Mikrofon: Windows protokolliert jede Nutzung im `ConsentStore` des Kontos
(`LastUsedTimeStart/Stop`); der Dienst liest das je Profil (nur lesend) und meldet alle
10 Sekunden neu beginnende Nutzung an genau dieses Konto (Programme aus Download-/Temp-Ordnern als
„verdächtig“). Laufende Nutzung beim Dienststart wird nicht gemeldet. USB: Tastaturen und
USB-Laufwerke per WMI; eine neue externe Tastatur wird an alle Konten gemeldet (BadUSB-Hinweis),
die erste Abfrage legt nur die Grundlinie fest (in den Dienst-Einstellungen). Zwischenablage: Der
Dienst (SYSTEM, Sitzung 0) sieht die Zwischenablage des Nutzers nicht – der Wächter läuft in der
App, nur nach Einschalten (Standard aus), liest nach jeder Änderung höchstens 200 Zeichen, hält
nur die letzte Krypto-Adresse 3 Sekunden im Speicher und meldet einen Austausch gegen eine andere
Adresse desselben Typs (BTC, ETH, LTC, DOGE, TRX, XMR) samt Programm, dem die Zwischenablage danach
gehört. Er verändert die Zwischenablage nie.

## D-050 – Web-Schutz als MV3-Erweiterung mit declarativeNetRequest

Status: angenommen (P7.3). Ohne Treiber oder Proxy sieht AEGIS den Browser-Verkehr nicht; der
Schutz liegt deshalb in einer Erweiterung für Edge/Chrome (`extensions/webshield`). Sperren
geschieht über `declarativeNetRequest`: Der Browser vergleicht die Adressen selbst, die
Erweiterung bekommt keinen Verlauf. Eine gelistete Seite wird (nur Hauptseiten-Aufrufe) auf die
eigene Warnseite umgeleitet; „Trotzdem öffnen“ verlangt ein ausdrückliches Häkchen und gilt nur
für diesen Host in dieser Browser-Sitzung (Sitzungsregel). Dafür merkt sich der Hintergrund je
Tab nur die zuletzt aufgerufene Adresse im Sitzungsspeicher (`storage.session`, gelöscht beim
Schließen von Tab/Browser). Listen: klein und gebündelt (Block List Project ransomware + scam,
≈10 000 Domains, statische Regeln); groß und täglich nachgeladen (Phishing.Database, Block List
Project phishing + fraud, zusammen höchstens 900 000 Domains als dynamische Regeln in Stücken zu
50 000). Das Nachladen ist abschaltbar (dann gilt nur die gebündelte Liste); scheitert eine
Quelle, bleibt die alte Liste ihrer Kategorie aktiv. URLhaus wurde wegen Anmeldepflicht und
unklarer Weitergabe-Bedingungen nicht genommen. Seitenhinweise (Markenname in fremder Domain,
Punycode, Passwortfeld ohne HTTPS) zeigt ein Inhaltsskript in einem geschlossenen Schatten-Baum,
ohne Eingaben zu lesen. Downloads werden nur per Benachrichtigung markiert, nie abgebrochen oder
gelöscht (Goldene Regel). DoH stellt AEGIS nicht um – die App zeigt nur, wo man es einschaltet.
Bis zur Veröffentlichung in den Erweiterungs-Stores wird die Erweiterung „entpackt“ geladen (P13
legt den Ordner mit aus); die App sagt das offen.

## D-051 – Heimnetz-Scanner in der App, nur eigenes privates Subnetz

Status: angenommen (P7.4). Der Scan braucht keine Administratorrechte und läuft deshalb in der
App (Nutzerrechte), nicht im Dienst – nur auf Knopfdruck. Geprüft wird ausschließlich das eigene
private Subnetz (RFC 1918) der Schnittstelle mit Standard-Gateway; ist es größer als /22, nur das
/24 um die eigene Adresse. Ablauf: ICMP-Echo an jede Adresse (64 Threads, 600 ms), Nachbartabelle
(ARP) für MAC-Adressen, bei höchstens 64 Geräten je ein TCP-Verbindungsversuch auf zehn bekannte
Ports (FTP, SSH, Telnet, HTTP/HTTPS, NetBIOS, SMB, RDP, VNC, 8080 – sofort wieder geschlossen,
nichts gesendet), eine SSDP-Suche (UPnP am Router) und die WLAN-Sicherheit der aktuellen
Verbindung (WLAN-API, nur lesend). Daraus entstehen Hinweise (Telnet/FTP am Router, Oberfläche
nur HTTP, UPnP an, RDP/VNC/Telnet an Geräten, offenes/WEP/WPA/TKIP-WLAN). Keine Anmeldung, kein
Passwort-Probieren, keine Herstellerlisten (MAC-Hersteller würde eine Lizenzprüfung brauchen).
„Neu“ heißt: MAC (sonst Adresse) war beim letzten Scan auf diesem PC nicht dabei – gemerkt im
Speicher der App (WebView), der erste Scan ist Grundlinie. Router-Einstellungen ändert der Nutzer
selbst.

## D-052 – Leck-Check mit k-Anonymität, HTTPS über WinHTTP

Status: angenommen (P7.5). Passwörter: Die Oberfläche bildet den SHA-1-Wert (WebCrypto) und gibt
nur die ersten fünf Hex-Zeichen an die App weiter; die App fragt `api.pwnedpasswords.com/range/`
mit `Add-Padding: true` ab und liefert die Einträge zurück, verglichen wird in der Oberfläche –
Passwort und vollständiger Hash verlassen das WebView nie. E-Mail-Adressen: nur mit dem eigenen
HIBP-API-Schlüssel des Nutzers (HIBP verlangt ihn, kostenpflichtig); der Schlüssel wird nicht
gespeichert und nach der Abfrage aus dem Feld gelöscht. Beides nur auf Knopfdruck. HTTPS läuft
über einen kleinen WinHTTP-Wrapper in `winffi` (Windows-Zertifikate und System-Proxy, nur `GET`,
nur Port 443, keine Weiterleitungen, TLS 1.2/1.3, Antwort höchstens 2 MiB) statt über eine
zusätzliche TLS-Bibliothek; die CSP der App bleibt ohne fremde Ziele. Namensnennung (CC BY 4.0)
steht in der App.

## D-053 – Defender-Schalter: nur Set-MpPreference, Manipulationsschutz nie umgehen

Status: angenommen (P8). Umgeschaltet wird nur der Virenschutz und nur über die dokumentierten
Cmdlets `Set-MpPreference -DisableRealtimeMonitoring` bzw. `-…ThreatDefaultAction NoAction` und
`Remove-MpPreference` (feste Befehle aus dem Plan, PowerShell aus `System32`, ohne Profil). Keine
Gruppenrichtlinien schreiben, keine Dienste anfassen, kein TrustedInstaller, kein abgesicherter
Modus. Ist der Manipulationsschutz an, gibt es keinen Plan zum Abschalten – nur die Anleitung und
„Windows-Sicherheit öffnen“. Statt einer UAC-Abfrage (der Dienst hat bereits Systemrechte)
verlangt der Dienst Administratorrechte des Anfragenden und ein ausdrückliches „Ja“; ein Vorschlag
entsteht nur aus einem höchstens 10 Minuten alten, gerade gelesenen Status, der danach verworfen
wird. Nach jedem Befehl liest der Dienst den echten Stand; hat Windows ihn nicht übernommen, gilt
der Schritt als fehlgeschlagen. „Wieder einschalten“ ist immer ein eigener Ein-Klick-Vorschlag
(auch bei Manipulationsschutz); ein allgemeines „Rückgängig“ gibt es bewusst nicht, weil es die
Defender-Prüfungen umginge. Vor dem Ausführen liest der Dienst den Stand erneut und prüft wie
beim Vorschlag. Jede Umschaltung steht im
Prüfprotokoll und im Verlauf (Protokoll auf der Seite). Passiver Defender (anderes Antivirus) und
eine Richtlinie, die den Echtzeitschutz abschaltet, werden ehrlich gemeldet statt umgangen.

## D-054 – Passwort-Tresor in der App, nicht im Dienst

Status: angenommen (P9). Der Tresor gehört dem Konto, nicht dem Rechner: Datei
`vault.aegisvault` im App-Datenordner des Kontos, Ver- und Entschlüsselung im App-Prozess
(Nutzerrechte). Der SYSTEM-Dienst sieht weder Datei noch Schlüssel. Format: Argon2id (64 MiB,
3 Durchläufe, Parameter + Salz in der Datei; beim Öffnen 64 MiB–1 GiB, 3–20 Durchläufe erlaubt)
verpackt einen zufälligen 256-Bit-Datenschlüssel (bei jedem Wechsel des Master-Passworts neu,
die Sicherung wird dann durch die neue Fassung ersetzt); jeder Eintrag einzeln AES-256-GCM mit
neuer Nonce bei jedem Speichern, in der AAD Kennung, Position, Anzahl und eine zufällige
Speicherkennung (Entfernen, Vertauschen, Verdoppeln, Einmischen alter Einträge fällt auf). Im Speicher `Zeroize`; die Oberfläche bekommt
Passwörter nur auf Klick („Anzeigen“, „Bearbeiten“, Leck-Check). Auto-Sperre nach 1–60 Minuten
Untätigkeit (Standard 5), Fehlversuche verzögern ab dem dritten (bis 60 s). „Kopieren“ setzt
die Zwischenablage mit den Windows-Hinweisen „nicht in den Verlauf/die Cloud, nicht überwachen“
und leert sie nach 30 s, wenn nichts anderes kopiert wurde. Speichern: Hilfsdatei → ersetzen,
vorige Fassung als `.bak`. Löschen eines Eintrags fragt in der Oberfläche nach (Nutzerdaten,
nicht Schutzbereich – keine Dienst-Freigabe nötig). CSV-Import nur aus einer vom Nutzer gewählten
Exportdatei (Chrome/Edge, Firefox, Bitwarden) mit Hinweis, sie danach zu löschen. Leck-Check je
Eintrag über die HIBP-Range-API (nur Präfix, D-052). Es gibt bewusst keinen Klartext-Export.

## D-055 – Tresor-Erweiterung: Native Messaging → Host → Pipe der App

Status: angenommen (P9.3). Die Erweiterung „AEGIS Tresor“ (MV3) hat nur das Recht
`nativeMessaging` – keinen Speicher, keine Tabs, keine Host-Rechte – und behält nichts. Ihre ID
ist über den `key` im Manifest fest (`mfhpbiifllddbcddpanidjedgmbglhon`, Test). Der Browser
startet `aegis-vault-host.exe` (Registrierung unter HKCU, `allowed_origins` nur diese ID; der
Host prüft das Aufrufer-Argument zusätzlich). Der Host prüft jede Nachricht
(`vault_core::bridge::parse`, ≤ 8 KiB, keine unbekannten Felder) und reicht sie über die Pipe
`\\.\pipe\aegis-vault-<SID>` an die laufende App weiter. Die Pipe gehört dem Konto (DACL nur
dessen SID, Besitzer geprüft, der Name ist nie frei); beide Seiten prüfen die Gegenstelle per
Programmpfad im selben Ordner (App ↔ Host), die App zusätzlich das Konto. Das ist keine Grenze
gegen Programme desselben Kontos (die können den Host selbst starten) – die bleibt das Konto.
Die Seitenadresse setzt der Hintergrund der Erweiterung aus dem Absender (nur Hauptrahmen,
http/https, Herkunft = Adresse) – die Webseite kann keine Adresse vorgeben. Die App liefert nur
Logins, deren gespeicherte Adresse zur Seite passt (Host oder Unteradresse, gleicher Port, wie im
Browser zerlegt; einzelne Wörter und geteilte Endungen wie `github.io` nie), Passwörter nur einzeln auf Abruf, höchstens
30 je Minute, und nur bei entsperrtem Tresor. Das Inhaltsskript läuft nur im Hauptrahmen, zeigt
seinen Knopf in einem geschlossenen Schatten-Baum in der obersten Ebene (Popover) und füllt erst
nach einem echten Klick genau auf den sichtbaren Eintrag (`isTrusted`, Treffer-Prüfung, 500 ms
Pause, Wächter gegen Veränderungen) bzw. Alt+↓ – und nur in deutlich sichtbare Felder; Fokus
allein fragt AEGIS nicht. Auf HTTP-Seiten warnt es. Grenze:
Ausgefüllte Werte stehen danach in der Seite – wie bei jedem Passwort-Manager.

## D-056 – Tresor-Erweiterung: „Speichern?“ nach dem Anmelden

Status: angenommen (P9.5). Beim Absenden eines Login-Formulars (Formular-Absenden, echter Klick
auf einen Absende-Knopf oder Enter im Passwortfeld) liest das Inhaltsskript Benutzername und
Passwort und gibt sie an den Hintergrund der Erweiterung – dort warten sie **nur im Speicher**,
je Tab, höchstens 2 Minuten. AEGIS erfährt vorher nur den SHA-256 des Passworts, um „neu“,
„geändert“ oder „schon gespeichert“ zu erkennen (Antwort ohne Geheimnisse). Die Frage
„Speichern?“/„Aktualisieren?“ erscheint auf derselben Website (auch nach Weiterleitung) mit den
Schutzmaßnahmen des Ausfüll-Menüs (oberste Ebene, Wächter, echte Klickstelle, 500 ms Pause,
kein Vorfokus); erst ein Klick bzw. Enter auf „Speichern“ schickt den Klartext an die App. Die
App legt einen Eintrag (Titel = Host, Adresse = Seite) an oder ersetzt nur das Passwort des
passenden Eintrags (Adresse + Benutzername), höchstens 10 Mal je Minute, nur entsperrt, und
speichert sofort. „Nicht jetzt“ verwirft. Die Erweiterung speichert weiterhin nichts dauerhaft.

## D-057 – Windows-Tools: Vorschau, Freigabe genau dieser Vorschau, Protokoll, Rückgängig

Status: angenommen (P10). Die Werkzeuge (Modul J) laufen in der App mit den Rechten des
angemeldeten Nutzers, nicht im SYSTEM-Dienst – sie arbeiten an dessen eigenen Dateien und
Einstellungen (`HKCU`). Jedes Werkzeug erstellt zuerst nur lesend eine Vorschau (`aegis_tools::
plan::Plan`, feste Schrittliste, SHA-256-Prüfsumme, 30 Minuten gültig). Ausgeführt wird nur
genau diese Vorschau: nach „Ausführen“ mit Kennung + Prüfsumme (die App verbraucht die
Vorschau, abgewählte Schritte bleiben) oder durch eine vom Nutzer angelegte und eingeschaltete
Regel mit „im Hintergrund“ (`Approved::by_rule`, nur Vorschauen dieser Regel). Jeder Schritt
prüft vor dem Ausführen, ob die Lage noch der Vorschau entspricht (Größe, Änderungszeit, Ziel
frei) – sonst wird er übersprungen. Nichts wird überschrieben (unter Windows `MoveFileExW` ohne
REPLACE), nichts endgültig gelöscht (Papierkorb der Shell mit `FOF_ALLOWUNDO`; „Rückgängig“
findet den Eintrag über die `$I…`-Begleitdatei wieder), Links und Abzweigungen werden nie
verfolgt, Systemorte (Windows, Programme, ProgramData, Laufwerkswurzeln, Papierkorb) sind tabu.
Jeder Lauf kommt ins Protokoll (`tools-journal.json`, 300 Läufe) und lässt sich zurücknehmen
(umgekehrte Reihenfolge, nie überschreibend). Autostart: nur Einträge des Kontos über den
Schalter `StartupApproved` wie im Task-Manager (rechnerweite nur Anzeige → Persistenz-Check im
Dienst). Desktop-Symbole: dokumentierte Shell-Schnittstelle (`IFolderView`), keine fremden
Prozesse. Hintergrund-Überwachung: alle 30 s, nur eingeschaltete Regeln mit „im Hintergrund“,
neue Dateien erst nach 60 s Ruhe.

Nachtrag P10.2 (Review): Papierkorb über `IFileOperation` mit Wächter – geht ein Element nicht
in den Papierkorb, passiert nichts (endgültiges Löschen gibt es nur im Shredder mit zweiter
Bestätigung). Kein vorhandener Teil eines Pfads darf ein Link oder eine Junction sein (Cloud-
Platzhalter zählen nicht); Zielordner entstehen Ebene für Ebene. Ausgeführt werden nur
Schritte, die die Vorschau angezeigt hat. „Im Hintergrund“ gilt ab dem Einschalten
(`watch_since`), der Bestand nur per Vorschau. Bewusst offen: Ein Skript im eigenen App-Fenster
könnte Vorschau und „Ausführen“ selbst aufrufen (anders als beim Dienst gibt es keine Einmal-
Kennung im Dialog); dagegen stehen CSP, SafeText und keine HTML-Einfügungen. Der Shredder
verlangt zusätzlich die nur im zweiten Dialog gezeigte Kennung.

## D-058 – Privacy-Browser: eigenes Tauri-Fenster, Tabs als WebViews, Blocker in WebView2

Status: angenommen (P12). Der Browser ist eine eigene App (`apps/browser`, `aegis-browser`),
nicht Teil der Schutz-App: Webseiten sind fremder Code und sollen nie in die Nähe der
App-Befehle kommen. Jedes Fenster hat oben eine Leiste (React, lokale Seite, WebView
`chrome-<fenster>`) und je Tab ein eigenes WebView darunter (Tauri „unstable“, mehrere WebViews
je Fenster). Die einzige Capability gilt nur für `chrome-*`; Tabs haben keine Rechte.
Navigation nur `http`/`https` (nie `file:`, `javascript:` …), HTTPS-only hebt `http` an, HTTP
nur nach ausdrücklichem Klick je Host und Sitzung; Pop-ups werden Tabs. Werbe-/Tracker-Blocker:
`adblock` (Brave, MPL-2.0) auf EasyList/EasyPrivacy – die Listen werden **nicht** mitgeliefert
(GPL-3.0/CC BY-SA 3.0) und nur auf Klick per HTTPS geladen; geprüft wird jede Anfrage über
WebView2 `WebResourceRequested` (`aegis_winffi::webview`), blockierte bekommen eine leere
403-Antwort. Unter Linux (Entwicklung) gibt es keinen Blocker – die Oberfläche sagt das.
WebRTC ohne lokale Adressen über Chromium-Schalter; einheitlicher Browser-Kennzeichner. Ghost-Modus: InPrivate-Fenster; „über
Tor“ nur, wenn bereits ein Tor-/Arti-SOCKS-Proxy läuft (9150/9050) – AEGIS startet kein Tor
selbst und lädt nichts nach (Arti als Beigabe wäre ein eigenes, großes Paket; später möglich).
Ehrlich in der Oberfläche: Der Browser reduziert Tracking, er anonymisiert nicht; der offizielle
Tor Browser ist stärker.

Nachtrag P12.2 (Review): DoH lässt sich in WebView2 nicht per Schalter setzen – der Browser nutzt
das DNS von Windows (dort ist DoH ab Windows 11 einstellbar), die Auswahl entfiel. Der Tor-Modus
setzt `--proxy-server` und `--host-resolver-rules` selbst (wry lässt den Proxy sonst fallen); je
Profil (normal, Ghost, Tor je Port) ein eigener Datenordner mit festen Schaltern. Tauri spritzt
`window.__TAURI_INTERNALS__` (mit der WebView-Kennung) in jedes WebView, ohne Ausschalter: Tabs
haben dadurch keine Rechte, Seiten erkennen aber eine App mit WebView2 – das sagt die Oberfläche;
Kennungen sind zufällig. Der saubere Weg (Tabs als rohe WebView2-Controller über `winffi`, ganz
ohne Tauri-IPC) bleibt als spätere Verbesserung offen. SmartScreen bleibt in normalen Fenstern an
(Schutz geht vor), Ghost-Fenster fragen Microsoft nicht.


## D-059 – Installation für den Rechner, Dienst über Installer-Hooks, signierte Updates

Status: angenommen (P13). Das NSIS-Paket installiert für den Rechner (`perMachine`), weil der
Dienst (`aegis-service`, LocalSystem), der Native-Messaging-Host des Tresors (HKLM-Einträge für
Chrome, Edge, Brave) und die Programmdateien systemweit liegen; die App läuft weiterhin als
Nutzer. Dienst, Prüfprozess und Host bringt der Installer über `windows/hooks.nsh` mit; der
Dienst registriert sich selbst (`aegis-service install` / `uninstall`, `crates/service/src/scm.rs`).
Daten in `%ProgramData%\AEGIS` (Quarantäne!) löscht die Deinstallation nur nach zwei getrennten
Bestätigungen; still nie. Updates: eigenes, kleines Format statt `tauri-plugin-updater`
(dessen Minisign-Schlüssel und automatischer Ablauf passen nicht zu „nur auf Klick, Installation
nach Ja“): `latest.json` mit Ed25519-Signatur (`ed25519-dalek`), SHA-256 und Größe je Datei,
nur eigene Release-Adressen, Weiterleitungen nur auf GitHub-Hosts. Der Schlüssel des
Herausgebers wird vom Nutzer selbst erzeugt (`cargo run -p aegis-update --features sign --bin
aegis-release -- keygen <datei>`); solange `release/update-public.key` leer ist, sind Updates
abgeschaltet. Code-Signing (Authenticode) bleibt eine offene Entscheidung des Nutzers (Kosten).

## D-060 – Setup-Assistent als kleine Tauri-App ohne eigenen Installer

Status: angenommen (P13). `AEGIS-Setup.exe` ist eine einzelne Programmdatei (`apps/setup`,
Tauri ohne Bundle): Willkommen mit eigener Animation (Schild im Fortschrittsring) und Klang
(abschaltbar), Datenschutz-Seite mit ehrlichem SmartScreen-Hinweis, Ordner und Pakete (AEGIS
Suite immer, AEGIS Browser auf Wunsch), Laden und Prüfen, Installieren, Fertig. Es nutzt
dasselbe signierte `latest.json` wie die Updates (D-059, neue Art `browser`) und folgt nur
Weiterleitungen auf GitHub-Hosts. Installiert wird erst nach „Installieren“ über die
NSIS-Pakete (`/S /D=<Ordner>`, der Ordner wird streng geprüft, weil NSIS ihn ohne
Anführungszeichen als letztes Argument nimmt); jede Datei wird direkt vor dem Start erneut
geprüft, das Setup wartet auf den Exit-Code. WebView2: Fehlt die Laufzeit, öffnet das Setup nach
„Ja“ nur die offizielle Microsoft-Seite – es lädt kein fremdes Programm selbst. Deinstallation
bleibt Sache des NSIS-Uninstallers (D-059). Ohne eingebauten Signaturschlüssel lädt das Setup
nichts und sagt das.
