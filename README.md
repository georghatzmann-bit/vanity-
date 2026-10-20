# AEGIS Suite

Moderner, ehrlicher Virenschutz mit Sicherheits- und Windows-Werkzeugen für **Windows 10/11
(64 Bit)**. Rein defensiv, ohne Telemetrie, ohne Konto. Gebaut mit Tauri 2 (Rust) und React.

> **Goldene Regel:** AEGIS verändert, verschiebt, beendet oder löscht nichts, bevor du es
> ausdrücklich bestätigt hast. Ohne dein „Ja“ wird nur gescannt, gemeldet und erklärt.

Jede verändernde Aktion beginnt mit einem Aktionsplan – **Was genau? Warum? Was passiert dann?
Wie mache ich es rückgängig?** – und den Antworten _Ja, ausführen_ / _Nein_ / _Ignorieren_ /
_Vertrauen_. Keine Antwort heißt: nichts tun. Endgültiges Löschen verlangt eine zweite,
getrennte Bestätigung; es gibt kein automatisches Löschen nach Fristen, nur Erinnerungen.

## Ehrlich vorweg

- AEGIS hat **keinen Kernel-Treiber**. Es erkennt, warnt und isoliert auf Wunsch – es kann
  Programme aber **nicht vor dem Start blockieren** wie ein Treiber-basierter Virenschutz.
  Microsoft Defender bleibt deshalb sinnvoll; AEGIS kann ihn ergänzen (Seite „Defender“).
- Erkennung: ClamAV (als getrennter Prozess, falls installiert), Hash-Listen, YARA-X-Regeln,
  statische Analyse (PE, Dokumente, Skripte, Archive, LNK, ISO, PDF) und Heuristik. Keine
  Erkennung ist vollständig; Einschätzungen nennen ihre Gründe und eine Sicherheit in Prozent.
- Getestet wird nur mit der harmlosen EICAR-Testdatei, selbst erzeugten Dummy-Dateien und
  harmlosen Simulatoren – nie mit echter Schadsoftware.
- Solange AEGIS kein Code-Signing-Zertifikat hat, warnt Windows SmartScreen beim Start der
  Installationsprogramme.

## Funktionen

| Bereich                        | Was es tut                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard**                  | Sicherheits-Score, Zustand aller Module, letzte Funde – nur echte Werte.                                                                                                          |
| **Scan**                       | Dateien/Ordner prüfen (auch per Drag & Drop), Funde mit Erklärung, Isolieren nur nach „Ja“.                                                                                       |
| **Echtzeit-Wächter**           | Meldet neue Dateien und Programmstarts, Gaming-Modus, Angebot „Im Labor prüfen“.                                                                                                  |
| **Quarantäne**                 | Verschlüsselter Tresor: isolieren, wiederherstellen, endgültig löschen (zweite Bestätigung).                                                                                      |
| **Labor**                      | Unbekannte Programme in der Windows Sandbox (Stufe 1) oder Mini-Sandbox (Stufe 2) beobachten, mit Verhaltensbericht.                                                              |
| **Notfall**                    | Panic-Button: Netz trennen per Firewall-Plan, verdächtige Prozesse beenden, alles rückgängig – jeweils nach „Ja“.                                                                 |
| **Ransomware-Schutz**          | Köderdateien, Massen-Änderungs- und Entropie-Erkennung, optional versionierte Rückfall-Kopien.                                                                                    |
| **Speicher-Scan & Datei-Safe** | Laufende Programme mit YARA prüfen; passwortgeschützter Safe (Argon2id + AES-GCM).                                                                                                |
| **Härtung**                    | Prüfungen mit Score, Beheben per Plan mit Rückgängig, Autostart-/Persistenz-Check, Treiber-Check, Wiederherstellungspunkte.                                                       |
| **Netzwerk**                   | Verbindungen je Programm, Firewall-Übersicht, Regel vorschlagen, Heimnetz-Scanner, Leck-Check (HIBP, k-Anonymität).                                                               |
| **Defender**                   | Status und Schalter für Microsoft Defender – Manipulationsschutz wird nie umgangen.                                                                                               |
| **Tresor**                     | Passwort-Tresor mit Browser-Erweiterung (Chrome/Edge/Brave) über einen Native-Messaging-Host.                                                                                     |
| **Tools**                      | 22 Windows-Werkzeuge (Aufräumen, Duplikate, Sortierer, Umbenenner, Shredder, Explorer-/Datenschutz-Schalter, Hosts, Systeminfo …) – immer mit Vorschau, Protokoll und Rückgängig. |
| **AEGIS Browser**              | Privacy-Browser: HTTPS-only, Tracker-Blocker (EasyList/EasyPrivacy auf Wunsch), Ghost-Fenster, optional über Tor/Arti. Reduziert Tracking – anonymisiert nicht.                   |
| **Web-Schutz**                 | Browser-Erweiterung mit Warnseite für bekannte Schadseiten und Phishing-Hinweisen.                                                                                                |

## Installieren

**`AEGIS-Setup.exe`** herunterladen ([Testversion](https://github.com/georghatzmann-bit/vanity-/releases/download/testversion/AEGIS-Setup.exe), wird nach jedem grünen CI-Lauf aktualisiert) und starten – eine einzige Datei, die alles enthält (AEGIS
Suite und auf Wunsch den AEGIS Browser). Sie installiert ohne weiteren Download: Willkommen →
Datenschutz → Pakete wählen → „Installieren“. Jedes Paket wird vor dem Start gegen seine
eingebaute SHA-256-Prüfsumme geprüft und bleibt bis zum Ende gegen Austausch gesperrt.

(Wird das Setup ohne eingebettete Pakete gebaut, lädt es die Pakete stattdessen über die
signierten Angaben der Release-Seite – siehe „Release veröffentlichen“.)

Windows fragt einmal nach Administratorrechten: Der Schutzdienst (`aegis-service`) und der
Native-Messaging-Host werden für den Rechner eingerichtet – immer in
`C:\Program Files\AEGIS Suite`, weil der Dienst mit Systemrechten läuft und sein Ordner nur
für Administratoren beschreibbar sein darf. Die App selbst läuft danach als
normaler Nutzer. Fehlt die WebView2-Laufzeit (unter Windows 11 immer vorhanden), hilft das Setup
beim Nachinstallieren über die offizielle Microsoft-Seite.

**Browser-Erweiterungen** (Tresor, Web-Schutz) liegen nach der Installation unter
`C:\Program Files\AEGIS Suite\extensions\`. In Chrome/Edge/Brave: Erweiterungen →
Entwicklermodus → „Entpackte Erweiterung laden“.

## Updates

„Über AEGIS → Updates“: AEGIS sucht nur nach Updates, wenn du klickst. Angenommen werden nur
Angaben mit gültiger Signatur des Herausgebers, die nicht veraltet sind und keine ältere
Version anbieten; jede Datei bleibt bis zum Start gegen Austausch gesperrt und wird direkt vor
dem Start gegen ihre Prüfsumme geprüft. Installiert wird erst nach „Jetzt installieren“ und Bestätigung.

## Deinstallieren

Windows-Einstellungen → Apps → **AEGIS Suite** → Deinstallieren. Der Dienst wird angehalten und
entfernt, Registrierungen werden gelöscht. Quarantäne, Prüfprotokoll und Einstellungen
(`C:\ProgramData\AEGIS`) bleiben erhalten – außer du bestätigst das Löschen **zweimal**.
Dein Passwort-Tresor bleibt in jedem Fall erhalten. Updates ersetzen nur die Programmdateien.

## Datenschutz

- Keine Telemetrie, keine Werbung, kein Konto.
- Netz nur für Updates, Signaturen und optionale Dienste – alles abschaltbar und nur nach
  deinem Klick bzw. Opt-in (Updates, Filterlisten, Leck-Check, ClamAV-Signaturen).
- Schriften und alle Oberflächen-Dateien sind lokal gebündelt (keine CDNs).
- Fremde Passwörter aus Browsern werden nie ausgelesen.

## Aus dem Quelltext bauen

Voraussetzungen: Rust 1.97, Node 22, pnpm 10; für Windows-Builds MSVC Build Tools und WebView2.

```bash
pnpm install                              # Abhängigkeiten
pnpm check                                # Lint, Typen, Tests, Format, Clippy, cargo test
pnpm test:e2e                             # Playwright-Tests
pnpm --filter @aegis/desktop tauri dev    # App starten
pnpm --filter @aegis/desktop tauri build  # NSIS-Installationsprogramm (Windows)
pnpm --filter @aegis/browser tauri build  # AEGIS Browser (Windows)
pnpm --filter @aegis/setup tauri build    # AEGIS-Setup.exe (Windows)
cargo run -p aegis-service -- run         # Dienst in der Konsole (Entwicklung)
```

Unter Linux lässt sich fast alles entwickeln und testen (Dienst über einen Unix-Socket);
Windows-spezifischer Code wird mit `pnpm rust:check:windows` geprüft, echte Windows-Builds und
-Tests laufen in GitHub Actions.

### Release veröffentlichen (Herausgeber)

1. Einmalig ein Schlüsselpaar erzeugen – der geheime Schlüssel bleibt **nur** bei dir:
   ```bash
   cargo run -p aegis-update --features sign --bin aegis-release -- keygen ~/aegis-release.key
   ```
   Den ausgegebenen öffentlichen Schlüssel in `release/update-public.key` eintragen und
   committen (erst dann sind Updates und Setup-Downloads eingeschaltet).
2. Windows-Pakete bauen (oder aus dem CI-Artefakt `aegis-windows-nsis` nehmen) und benennen:
   `AEGIS-Suite-<v>-x64-setup.exe`, `AEGIS-Browser-<v>-x64-setup.exe`, `AEGIS-Setup.exe`.
3. Signierte Angaben erzeugen und mit den Dateien als GitHub-Release `v<v>` hochladen:
   ```bash
   cargo run -p aegis-update --features sign --bin aegis-release -- \
     sign ~/aegis-release.key <v> v<v> AEGIS-Suite-<v>-x64-setup.exe AEGIS-Browser-<v>-x64-setup.exe AEGIS-Setup.exe > latest.json
   ```

## Aufbau

```
apps/desktop        Tauri-App (React-Oberfläche + Rust)
apps/browser        AEGIS Browser
apps/setup          AEGIS-Setup.exe
extensions/vault    Erweiterung Passwort-Tresor (MV3)
extensions/webshield Erweiterung Web-Schutz (MV3)
crates/core         Goldene Regel: Aktionspläne, Freigaben, Prüfprotokoll
crates/engine       Erkennung (nur lesend)
crates/quarantine   verschlüsselte Quarantäne
crates/service      Schutzdienst (einzige Stelle, die Antworten annimmt)
crates/winffi       einzige Bibliothek mit unsafe (Windows-Schnittstellen)
crates/update       signierte Updates
packages/ui         Design-System
docs/               Architektur, Sicherheit, Entscheidungen, Lizenzen, Fortschritt
```

Mehr: [Architektur](docs/ARCHITECTURE.md) · [Sicherheit](docs/SECURITY.md) ·
[Entscheidungen](docs/DECISIONS.md) · [Fremdlizenzen](docs/LICENSES.md) ·
[Fortschritt](docs/PROGRESS.md)

## Lizenz

Die Projektlizenz ist noch nicht festgelegt (Entscheidung des Herausgebers). Fremde
Komponenten und ihre Lizenzen stehen in [`docs/LICENSES.md`](docs/LICENSES.md); ClamAV (GPL)
wird nur als getrennter Prozess angesprochen, nie eingelinkt.
