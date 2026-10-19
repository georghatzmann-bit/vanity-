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
  Admin dieses Rechners sie liest. Genauer: Ein `CRYPTPROTECT_LOCAL_MACHINE`-Blob ist für
  jeden Prozess dieses Rechners entschlüsselbar, der ihn lesen kann – die eigentliche Sperre ist
  die Zugriffsliste des Ordners; aus einem vollständigen Abbild samt SYSTEM/SECURITY-Hives ist er
  auch offline entschlüsselbar. Ein alter, roher Schlüssel kann in freien Sektoren bzw.
  Schattenkopien weiterleben. Scheitert die Umstellung, bleibt der alte Schlüssel in Gebrauch
  (Hinweis im Dienstprotokoll) – die Quarantäne bleibt erreichbar.
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
  (ID + Programmpfad) als Ziel; der Dienst nennt nur Prozesse des anfragenden Kontos – auch für
  Administratoren. Vor jeder Aktion wird am geöffneten Prozess erneut geprüft, ob ID und
  Programm noch passen (keine wiederverwendete ID) und ob er kritisch ist
  (`IsProcessCritical`) – kritische Systemprozesse und AEGIS selbst (alle Programme im
  AEGIS-Programmordner) werden nie angefasst. Geöffnet wird im Identitätswechsel. Anhalten
  prüft je Thread, dass er noch zum Prozess gehört (Thread-IDs werden wiederverwendet), und
  sucht mehrmals nach neu gestarteten Threads; startet ein Programm laufend neue, meldet AEGIS
  „nur teilweise angehalten“.
- **Ransomware-Schutz (P5.3):** Köderdateien sind ein eigener Plan (Dateien als Ziele), werden
  mit den Rechten des Nutzers und ohne Links nur **neu** angelegt und nur entfernt, solange
  sie noch genau den AEGIS-Inhalt haben. Erkannt werden Änderungen an Ködern sowie viele
  Änderungen/Umbenennungen/Löschungen in kurzer Zeit im eigenen Profil (je Profil gezählt,
  laute Ordner wie Temp/AppData unterhalb des Profils ausgenommen). Pausen getrennt:
  Massenänderungen je Profil 10 min, Köder je Datei – ein anderer Köder warnt sofort; neue
  Köder machen bekannte nicht unscharf. **Geschützte Ordner (P5.9):** Desktop, Dokumente,
  Bilder und eigene Ordner (höchstens 20; nur Ordner, die das Konto selbst lesen kann, nicht
  ganze Laufwerke und keine, die den AEGIS-Datenordner enthalten) werden nur für diese
  Erkennung beobachtet, nicht jede Datei geprüft. Außerhalb der Profile nennt eine Meldung nur
  den Schutzordner, nie die Datei – sonst erführe ein Konto Dateinamen aus Unterordnern, die es
  nicht lesen darf. Schützen mehrere Konten denselben Ordner, wird jedes gewarnt; entfernt eines
  ihn, bleiben die anderen (und die Standardordner) beobachtet. **Entropie:** Bei geänderten, sonst „lesbaren“ Dateien
  (Text, CSV, alte Office-Formate …) und Umbenennungen auf ungewöhnliche Endungen misst der
  eingeschränkte Prüfprozess die Entropie der ersten 64 KiB – mit den Rechten des angemeldeten
  Profil-Besitzers, sonst gar nicht; höchstens 40 Stichproben je Profil und 20 s. Wirken 8
  Dateien in 2 min wie verschlüsselt, warnt AEGIS („Gefährlich“). Im Alarm bietet AEGIS an,
  kürzlich (30 min) gestartete eigene Programme **einzufrieren** (anhalten, Plan + „Ja“).
  Windows „Überwachter Ordnerzugriff“ wird nur gelesen, erklärt und die Windows-Sicherheit
  geöffnet – einschalten tut der Nutzer selbst. Ehrlich: ohne Treiber erst, wenn der Angriff
  läuft; Gegenmaßnahmen (Einfrieren, Netz trennen, Beenden, Isolieren) nur nach „Ja“.
- **Notfall „Netz trennen“ (P5.4):** legt zwei feste Sperrregeln der Windows-Firewall an
  (`netsh` vom festen Systempfad, feste Argumente, Zeitlimit 30 s); scheitert ein Schritt,
  werden angelegte Regeln sofort wieder entfernt. „Wieder verbinden“ ist ein eigener Plan,
  löscht genau diese Regeln und ist immer möglich (räumt auch Reste auf). Trennen darf jedes
  angemeldete Konto (Schutz im Ernstfall, siehe D-036); wieder verbinden nur das trennende
  Konto und Administratoren. Der Plan nennt die rechnerweite Wirkung (alle Konten,
  Fernzugriffe, Firewall bleibt an). `netsh` läuft unter der Dienst-Sperre (meist unter 1 s).
- **Notfall-Scan / Panic-Button (P5.8):** nur lesend – Autostarts (Run-Schlüssel,
  Autostart-Ordner), Downloads, Desktop, Temp (vollständig), AppData (nur ausführbare Dateien,
  Skripte, Verknüpfungen; ohne Caches, höchstens 20 000), eigene Programme samt Speicher; alles
  mit den Rechten des Nutzers, geprüft im Prüfprozess, außerhalb der Dienst-Sperre. Ein
  Signatur-Update wird angestoßen (nicht, wenn ein Administrator es abgeschaltet hat). Isolieren
  aller gewählten Funde ist **ein** Plan; „Alles rückgängig“ ebenso (je Ziel genau eine
  Eintrags-Kennung, alle vorab geprüft).
- **Speicher-Scan (P5.5):** liest nur Prozesse des anfragenden Kontos, im Identitätswechsel
  (Module und ausführbarer privater Speicher, je Bereich und Anfrage begrenzt – 10 MiB je
  Anfrage an den Prüfprozess, insgesamt höchstens 128 MiB). Speicher wird paketweise geprüft,
  sobald ein Paket voll ist – der Dienst hält nie mehr als etwa eine Anfrage im Speicher.
  Geprüft wird ausschließlich im eingeschränkten Prüfprozess (YARA/EICAR); gemeldet wird nur.
- **Rückfall-Kopien (P5.10, nur nach Opt-in):** Einschalten ist ein Plan (Ordner, Grenze,
  Wirkung stehen darin); danach sichert der Zeitplaner alle 30 min geänderte Dateien aus
  Desktop/Dokumente/Bilder/eigenen Schutzordnern – **gelesen** mit den Rechten des angemeldeten
  Besitzers (geteilte Öffnung, ohne Links, Köder/laute Ordner ausgenommen, Dateien ≤ 200 MiB),
  **gespeichert** verschlüsselt (eigener, an den Rechner gebundener Schlüssel) im Datenordner
  des Dienstes (nur SYSTEM/Administratoren) – dorthin kommt Ransomware mit Nutzerrechten nicht.
  Je Konto ein eigener Unterordner (Kennung aus der SID, ohne Pfadteile). Grenze erreicht →
  nichts mehr hinzu; **gelöscht wird nie automatisch**. Nach einer Ransomware-Warnung pausiert
  die Sicherung eine Stunde. Zurückholen: Plan, neu angelegt mit Nutzerrechten, nie
  überschrieben, SHA-256 geprüft. Export auf ein Laufwerk: Plan, normale Kopien der neuesten
  Versionen in einen neuen Unterordner des gewählten Ordners (mit Nutzerrechten, nie
  überschrieben). Ausdünnen: Plan „Endgültig löschen“ mit zweiter Bestätigung; die neueste
  Version jeder Datei bleibt immer. **Grenzen (P5.11):** je Konto die gewählte Grenze und
  höchstens 100 000 Versionen, über alle Konten 200 GiB, und auf dem Laufwerk bleiben immer
  mindestens 10 GiB bzw. 10 % frei – eine volle Platte würde sonst das Prüfprotokoll und damit
  jede Aktion lahmlegen. Gelesen wird höchstens die beim Sammeln geprüfte Größe (wächst die Datei,
  wird die Kopie verworfen); Cloud-Platzhalter werden nicht gelesen (kein Herunterladen). Der
  Index ist ein Zeilenprotokoll (beschädigte Zeilen kosten nur diese Version; Ausdünnen räumt
  verwaiste Kopien mit auf). Export und Ausdünnen laufen nach dem „Ja“ außerhalb der
  Dienst-Sperre, Sicherungsläufe in einem eigenen Faden (bricht beim Beenden zwischen Dateien
  ab). Der Hintergrund-Identitätswechsel prüft neben dem Profil auch die SID des Kontos. Ist der
  Speicher nicht einrichtbar, startet der Dienst trotzdem (Funktion „nicht verfügbar“).
  Der Startcheck des Datenordners durchläuft diesen Ordner
  nicht (sehr viele eigene Dateien) – er prüft nur den Ordner selbst. Ehrlich: Administratoren
  dieses Rechners können die Kopien lesen; die Pfade stehen im Klartext-Index im Datenordner.
- **Datei-Safe (P5.6):** Ordner im Profil des Nutzers; alle Zugriffe im Identitätswechsel und
  ohne Links (der Safe-Ordner muss ohne Umweg über Verknüpfungen erreichbar sein). Zufälliger
  256-Bit-Datenschlüssel, verpackt mit Argon2id (64 MiB, 3 Durchläufe) + AES-256-GCM; Inhalte
  im Quarantäne-Containerformat, Name/Herkunft verschlüsselt je Eintrag. Das Passwort kommt
  nur über die Pipe (`Password`: nie in `Debug`, beim Verwerfen überschrieben; der Rahmen der
  Anfrage wird nach dem Lesen überschrieben), wird nie gespeichert – nicht im Plan, Protokoll
  oder Verlauf (Test prüft das Prüfprotokoll). Die Ableitung läuft **außerhalb** der
  Dienst-Sperre (höchstens 2 gleichzeitig, je Konto eine); Parameter aus einem Safe-Kopf über
  denen, mit denen AEGIS anlegt, werden abgelehnt (der Kopf liegt im Profil und könnte sonst den
  Dienst Speicher und Zeit kosten). Der entsperrte Schlüssel liegt nur im Speicher des Dienstes
  je Konto und verfällt nach 10 min ohne Nutzung, beim Sperren und beim Neustart. 5 falsche
  Passwörter → 60 s Pause. Dateien des Safes selbst lassen sich nicht hineinlegen. Hineinlegen:
  Original erst nach geprüfter Kopie entfernt; Herausholen: nie überschreiben, SHA-256 geprüft,
  erst danach aus dem Safe entfernt (beides unter der Dienst-Sperre, wie die Quarantäne).
  Ehrlich: Pfade der hineingelegten bzw. herausgeholten Dateien stehen im **Plan** und damit im
  Prüfprotokoll (die Freigabe ist an sie gebunden); der Verlauf nennt nur Anzahlen. Wer das
  Konto oder den Dienst kontrolliert, während der Safe entsperrt ist, kann mitlesen; ein
  vergessenes Passwort kann niemand ersetzen.
- **Härtung / Sicherheits-Score (P6.1):** nur lesend – Registrierung (HKLM; den Proxy nur im
  Zweig des anfragenden Kontos), WMI (BitLocker/TPM mit verschlüsselten Aufrufen, Defender,
  Sicherheitscenter inkl. Firewalls anderer Hersteller, Updates), Gastkonto über `NetUserEnum`,
  Hosts-Datei (am tatsächlichen Ort aus `DataBasePath`, höchstens 1 MiB, Einträge über 255
  Zeichen verworfen) und Port-Tabellen. Läuft außerhalb der Dienst-Sperre; die rechnerweiten
  Fakten werden höchstens alle 30 Sekunden neu gelesen (für alle Konten), der Proxy je Konto.
  Ein Ergebnis gilt je Konto 10 Minuten; der Score-Verlauf ist je Konto (90 Tage, nur bei
  Änderung geschrieben). **COM:** Der Dienst legt beim Start selbst eine restriktive
  COM-Sicherheit fest (Zugriff nur SYSTEM/Administratoren, `PKT_PRIVACY`, Identitätswechsel
  „Impersonate“) – sonst täte es die WMI-Bibliothek prozessweit ohne Zugriffsprüfung. Was nicht
  lesbar ist, bleibt „unbekannt“; liegt weniger als die Hälfte der Gewichte vor, gibt es keinen
  Score (D-043). Ein gestoppter Firewall-Dienst zählt als „Firewall aus“.
- **Härtung beheben (P6.2):** jeder Vorschlag ist ein Plan, dessen Ziele genau die Schritte
  nennen; der Plan-Wert trägt zusätzlich eine SHA-256-Prüfsumme der Schritte. Beim Ausführen
  bestimmt der Dienst die Schritte neu – weichen Text oder Prüfsumme ab, passiert nichts. Was
  schon in Ordnung (oder strenger) ist, wird abgelehnt – ein Beheben kann nie lockern. Rechnerweite
  Schritte nur für Administratoren: geprüft **vor** jedem Lesen, beim Vorschlag und beim
  Ausführen; der Stand wird außerhalb der Dienst-Sperre gelesen (gezielt je Schritt, ohne WMI).
  Werte im Profil des Kontos (`HKU\<SID>`, Proxy) liest und schreibt der Dienst nur im
  Identitätswechsel des Kontos. Vor dem Ändern merkt er den alten Wert roh (nur `DWORD`/Text
  bis 2 KiB, Binär bis 4 KiB; sonst wird nichts geändert), höchstens 10 Stände je Konto – andere
  Konten verdrängen nie fremde Stände. „Rückgängig“ ist ein eigener Plan des Kontos, das behoben
  hat; er wird als schwächend gekennzeichnet („Verdächtig“, Warnung im Text). Schlägt ein Schritt
  fehl, werden die schon ausgeführten zurückgenommen; gelingt das nicht ganz, meldet AEGIS
  „teilweise“, nennt, was noch gilt, und merkt dafür einen Rückgängig-Stand. Entfernen öffnet
  Schlüssel nur (legt nichts an). Gruppenrichtlinien werden nie geändert. `netsh`/`net`/`schtasks`
  laufen vom Systemordner (`GetSystemDirectoryW`), mit festen Argumenten (Kontoname geprüft),
  höchstens 30 s – unter der Dienst-Sperre (selten, nach „Ja“). Updates, BitLocker und Virenschutz
  öffnet die App nur als Windows-Seite (feste Liste) – den Manipulationsschutz von Defender fasst
  AEGIS nie an. Ehrlich: Rechnerweite Punkte brauchen eine als Administrator gestartete App.
- **Persistenz-Check (P6.3):** liest Run/RunOnce/Richtlinien-Run (HKLM, eigenes HKU),
  Autostart-Ordner (gemeinsamer als Dienst, eigener mit Nutzerrechten), geplante Aufgaben (XML
  in `System32\Tasks`, höchstens 4000), automatisch startende Dienste, Winlogon, IFEO-Debugger,
  AppInit_DLLs, WMI-Abos (`ROOT\subscription`), eigene COM-Einträge und Browser-Erweiterungen
  (Chrome/Edge/Brave, mit Nutzerrechten). Bewertung: Merkmale im Befehl (kodiertes PowerShell,
  Nachladen aus dem Netz, Skript-Hosts, rundll32/regsvr32-Missbrauch, Temp/Downloads/Öffentlich,
  Verschleierung) plus Prüfung der Programmdateien im Prüfprozess mit den Rechten des Kontos
  (höchstens 400). Deaktivieren ist ein Plan wie beim Beheben (Run-Wert entfernen, Aufgabe
  abschalten, Dienst auf „Deaktiviert“, IFEO-Debugger entfernen, AppInit nicht laden); vor dem
  Ausführen wird der Eintrag neu gelesen und muss unverändert sein. Dateien im Autostart-Ordner
  werden über die Quarantäne isoliert. Winlogon, WMI-Abos, COM und Erweiterungen werden nur
  erklärt.
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
| 2026-10-19 | P6.1/P6.2: Härtungs-Fakten, Score, Beheben mit Rückgängig (winffi-Registrierung, Port-Tabellen, Dienst, App). 1 Prüfer | 0 kritisch/hoch. 3 mittel: P6-R1 WMI/Registrierung unter der Dienst-Sperre vor Admin-Prüfung → Admin und Grenzen zuerst, Stand außerhalb der Sperre und gezielt (Gastkonto ohne WMI); P6-R2 Rückgängig-Stände rechnerweit verdrängbar, Proxy-Fix immer möglich, große Rohwerte → 10 je Konto, Proxy nur wenn gesetzt, Rohwerte begrenzt, Base64; P6-R16 Ausführungsweg ungetestet → Systemzugriff als Schnittstelle mit Ersatz, Tests für Ausführen, Abbruch, Admin, Konten, Grenze, Rücknahme. Niedrig: HKU als SYSTEM → Identitätswechsel; Rücknahmefehler verschwiegen → „teilweise“ mit Rest; UAC/SMB1/RDP/NLA konnten lockern → abgelehnt wenn schon in Ordnung; Rückgängig harmlos dargestellt → „Verdächtig“ + Warnung; Bindung nur über Texte → Prüfsumme; Entfernen legte Schlüssel an → nur öffnen; Slot-Aushungern → Fakten höchstens alle 30 s, Verlauf nur bei Änderung; Verlauf rechnerweit → je Konto; Hosts-Speicher → Längengrenzen; COM-Sicherheit der WMI-Bibliothek → eigene restriktive beim Start; Text für Nicht-Administratoren; Fakten (Firewall anderer Hersteller, gestoppter Dienst, Proxy-Verbindungseinstellungen, NLA-Standard). Kleinigkeiten: SID-Prüfung einheitlich, Meldung zum Gastnamen, Systemordner über `GetSystemDirectoryW`; Ausrichtung der Tabellenpuffer bleibt (Heap liefert 16-Byte-Ausrichtung); Registrierungs-Test unter Windows folgt mit P6.7 – alle übrigen behoben |
| 2026-10-19 | P5-Nachprüfung: Korrekturen P5.7, Notfall-Scan P5.8, Ransomware-Ergänzungen P5.9, Rückfall-Kopien P5.10. 1 Prüfer | 0 kritisch, 1 hoch: P5-S1 Rückfall-Kopien konnten die Systemplatte füllen (Größe nur beim Sammeln geprüft, keine Platz-/Gesamtgrenze) → geprüfte Größe am Handle, Lesen begrenzt, Gesamtgrenze, Mindest-Freiplatz, D-042. 4 mittel: P5-S2 Dateinamen aus nicht lesbaren Unterordnern geschützter Ordner in Meldungen → außerhalb der Profile nur der Schutzordner; P5-S3 Schutzordner nur nach Pfad (erster gewinnt, Entfernen beendete Standardbeobachtung) → je Konto, Standardordner bleiben, Grenze vor dem Beobachten; P5-S4 Index skalierte nicht/sperrte aus → Zeilenprotokoll, einmal je Lauf gelesen, Grenzen vor dem Verschlüsseln, Aufräumen verwaister Kopien; P5-S5 Export/Ausdünnen/Läufe blockierten den Dienst → außerhalb der Sperre, eigener Faden, Abbruch beim Beenden. 5 niedrig: Cloud-Platzhalter → übersprungen; Schutzordner über dem Datenordner → abgelehnt, Datenordner-Ereignisse ignoriert; Identitätswechsel nur nach Profilpfad → SID-Prüfung; teilweises Einfrieren als „fehlgeschlagen“ → „teilweise“; Speicherfehler verhinderte Dienststart → optional. Kleinigkeiten (Doku im Prüfprozess, Export-Zeitstempel, Update erst bei laufendem Notfall-Scan, Reihenfolge ohne Textvergleich, kein Verlauf bei abgemeldetem Konto, Reihenfolge D-039–D-041) – alle behoben, Tests ergänzt |
| 2026-10-19 | P5.1–P5.6: DPAPI-Schlüssel, Prozess-Aktionen, Ransomware-Schutz, Netz trennen, Speicher-Scan, Datei-Safe. 1 Prüfer | 0 kritisch/hoch. 3 mittel: P5-R1 Argon2-Parameter aus dem Safe-Kopf (bis 1 GiB) unter der Dienst-Sperre → nur AEGIS-Parameter, Ableitung außerhalb der Sperre, je Konto eine, Grenzen vor der Ableitung; P5-R2 Netz trennen/verbinden ohne Rechteregel → Wieder verbinden nur trennendes Konto/Admins, Entscheidung D-036; P5-R3 halbe Sperre ohne Zustand → Zurücknehmen bei Fehler, Wieder verbinden immer möglich. 6 niedrig: Thread-ID-Wiederverwendung/neue Threads beim Anhalten → Thread-Prüfung, mehrere Runden; Speicher-Scan Spitzenbedarf → paketweise, 128 MiB; Safe-Ordner-Prüfung Groß/Klein → gefalteter Vergleich + Test; Klartext-Pfade in Protokoll/Verlauf → Verlauf nur Anzahlen, Protokoll ehrlich dokumentiert; Ransomware-Pausen/Scharfschalten/Profilname → getrennte Pausen, Köder einzeln scharf, laute Ordner relativ zum Profil + Tests; Admin-Prozessliste → nur eigene, AEGIS-Programme ausgenommen. 3 Kleinigkeiten (DPAPI-Doku + Start bei fehlgeschlagener Umstellung, Rahmen überschreiben/Fehlversuche nur bei falschem Passwort, Köder bei Speicherfehler bewacht) – alle behoben |
| 2026-10-19 | P4: Labor (Dienst, winffi-Sandbox, Sonde, App-Befehle, Labor-Seite). 1 Prüfer | 1 hoch: P4-1 Absturz des Dienstes über einen Bildnamen mit Mehrbyte-Zeichen (Byte-Slicing, `panic = abort`) → reine ASCII-/Byteprüfung vor allem anderen, Test. 6 mittel: P4-2 Ausgabe der Stufe 1 als SYSTEM unter der Dienst-Sperre gelesen → Identitätswechsel, Hardlink-Prüfung, außerhalb der Sperre; P4-3 VM nicht kontrolliert, erster Bericht vertraut → Prozess gehalten, Frist/Größengrenze, Lesen erst nach Ende, Hinweise vom Dienst; P4-4 gemeinsames, bleibendes AppContainer-Profil → Profil je Lauf, danach gelöscht, kein SYSTEM-Rückfall; P4-5 Erlaubnis vor der Arbeit als „erfolgreich“ protokolliert → Erlaubnis im Lauf, echtes Ergebnis; P4-6 „Vertrauen“ auf Labor-Vorschläge → abgelehnt (Dienst + UI); P4-7 Berichtsgrößen → 1 MiB, Textgrenzen, Bericht nur je Lauf. 8 niedrig/Kleinigkeiten (stiller Token-Rückfall, Ordnerrechte Stufe 2, Zählung aktiver Läufe, Dateiname der Kopie, Sonde per Umgebungsvariable, Fensterfotos ohne AppContainer-/Hänger-Prüfung, PNG ungeprüft, Prüfsumme nicht verglichen, DISM ohne Frist, Netz-Text) – alle behoben, Tests ergänzt |
| 2026-10-19 | P3: Prüfprozess/Token, Vertrauensliste, Wächter, Verlauf/Zeitpläne/Updates, HTML-Export. 2 Durchgänge (der erste brach nach dem ersten Fund ab) | 2 hoch: P3-1 Hintergrundprüfungen mit SYSTEM-abgeleitetem Token (→ Profil-Besitzer bzw. LocalService, Öffnen mit Prüfung am Handle), P3-2 Verlauf/Vertrauensliste konnten den Dienststart blockieren (→ Größen- und Längengrenzen, Quoten, Beiseitelegen). 8 mittel (Aushungern/Warteschlange, Abstürze verstecken Dateien, rechnerweite Schalter für jeden Nutzer → Gaming je Konto + Admin-Pflicht, gemeinsame Grenzen → Quoten, Dateizugriffe unter der Sperre, freshclam als SYSTEM ohne Job, Zuordnung „gemeinsam“ nach Pfad → SID/Profil-Wurzel, LocalService statt eingeschränktem SYSTEM). 6 niedrig (Rückfall auf Dienst-Token, gemeinsame „unbekannt“-Kennung, Pfadvergleich, Termine, USB/ETW, Export überschreibt). Alle behoben bzw. Grenzen dokumentiert, Tests ergänzt (Windows-Test „nur Nutzer“-Token) |
| 2026-10-19 | P2.5-Nachprüfung (separater Agent): Korrekturen + neue Fehler im FFI | Alte Funde geschlossen bzw. teilweise; neu: 1 hoch (Server-Prüfung für Standardnutzer kaputt → Pipe-Besitzer), 6 mittel (Namenslücke, Leerlauf/Grenzen je Konto, Einträge ohne Konto, schreibgeschützt, Analysepunkte, ClamAV als SYSTEM → P3.2), 5 niedrig. Behoben (außer ClamAV-Token → P3.2, Pfad-Textvergleich nur dokumentiert), Tests ergänzt |
| 2026-10-19 | P2: Quarantäne, Dienst/Pipe, winffi, Engine-Anbindung, App-Client. 1 Prüfer, 4 Funde per Test nachgestellt | 1 kritisch (jeder Nutzer konnte über den SYSTEM-Dienst ohne UI isolieren/wiederherstellen → Identitätswechsel + Pfadregeln), 3 hoch (Links in Zwischenordnern/Überschreiben, Pipe-Instanzen durch Nutzer, vorab angelegter Datenordner), 3 mittel (Ausführung trotz Protokollausfall, Überlastung, ClamAV über PATH), 2 niedrig (Bidi in Plan-Texten, Unix-Rechte, fehlende Sperren). Alle behoben, Regressionstests in `crates/quarantine/tests`, `crates/service/tests`, Windows-Test für Identitätswechsel |
| 2026-10-19 | P1: Freigabe-Dialog, Fenster-/Tray-Rechte, Startprotokoll, Einstellungen, Barrierefreiheit, CI. 4 Prüfer + Gegenprüfung (vor Abschluss der Desktop-Korrekturen abgebrochen, Rest selbst geprüft) | 2 hoch (Sperrzeit-Umgehung, gestapelte Dialoge), 7 mittel (u. a. Bidi in Plan-Texten, Fokus bei Seitenwechsel, Windows-CI-Zeitlimit) – behoben mit Tests |
| 2026-10-19 | P0: `crates/core` (Freigabe, Protokoll, Mutations-Wächter), Tauri/CSP/CI, Design-System. 4 unabhängige Prüfer + adversarielle Gegenprüfung | 48 Funde bestätigt (0 kritisch, 0 hoch, 15 mittel, 24 niedrig, 9 Kleinigkeiten). 46 behoben, jeweils mit Regressionstest. Offen: Antwort-Nonce (→ P2, siehe Bedrohungsmodell), Meldung bei Startfehler der App (→ P1) |
