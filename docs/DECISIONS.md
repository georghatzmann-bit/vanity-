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

