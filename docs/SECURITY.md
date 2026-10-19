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
| `clippy.toml` `disallowed-methods` für verändernde APIs (std, tokio, tempfile) + Allowlist-Test | Jede neue Veränderungsstelle fällt im Review auf |
| `ConsentGate::decide`/`confirm_second` ebenfalls gesperrt (Markierung `aegis-consent`) | Im Betrieb darf nur der Pipe-Handler des Dienstes Nutzerantworten annehmen – kein Hintergrundcode „genehmigt sich selbst“ |
| Einlösen nur am ausgebenden Tor; abgelehnte Einlösungen werden protokolliert | Manipulierte Pläne, fremde Tore und Fristüberschreitungen hinterlassen eine Spur |
| Mutations-Wächter liest Manifeste über `cargo metadata`/TOML, prüft `.cargo/config`, `cfg(clippy)`, Doctests, `unsafe`-Ausnahmen | Die Sperre lässt sich nicht still per Konfiguration aushebeln |
| Prüfprotokoll mit Hash-Kette | Nachträgliche Manipulation des Protokolls wird erkannt |
| „Nichts ohne Ja“-Tests (Zustands-Schnappschuss byte-genau) | Scans/Wächter/Panic ohne Bestätigung ändern nachweislich nichts |

## Bedrohungsmodell (ehrlich)

- **Kein Kernel-Treiber.** AEGIS erkennt, warnt und isoliert auf Wunsch; es blockiert keine
  Programme vor dem Start. Das steht so in der UI.
- **Wiederholte Antworten (offen bis P2):** Eine Entscheidung ist an Plan-ID + Digest gebunden,
  noch nicht an eine Vorschlags-Nonce. Legt der Dienst denselben gespeicherten Plan in einem
  neuen Tor erneut vor, würde ein wiederholtes „Ja“ angenommen. P2 bindet Antworten im
  Pipe-Protokoll an eine Nonce, die die UI zurückschickt.
- **Gleichrangige Schadsoftware:** Läuft Schadcode bereits mit den Rechten des Nutzers, kann er
  theoretisch die UI fernsteuern oder Pipe-Nachrichten senden. Gegenmaßnahmen (geplant):
  Pipe-ACL nur für den interaktiven Nutzer + SYSTEM, Prüfung der Client-Prozess-Identität
  (Pfad + Signatur der AEGIS-App), für besonders folgenreiche Aktionen optional
  Windows-Hello/UAC-Bestätigung. Admin-Schadsoftware kann AEGIS grundsätzlich aushebeln.
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
| 2026-10-19 | P1: Freigabe-Dialog, Fenster-/Tray-Rechte, Startprotokoll, Einstellungen, Barrierefreiheit, CI. 4 Prüfer + Gegenprüfung (vor Abschluss der Desktop-Korrekturen abgebrochen, Rest selbst geprüft) | 2 hoch (Sperrzeit-Umgehung, gestapelte Dialoge), 7 mittel (u. a. Bidi in Plan-Texten, Fokus bei Seitenwechsel, Windows-CI-Zeitlimit) – behoben mit Tests |
| 2026-10-19 | P0: `crates/core` (Freigabe, Protokoll, Mutations-Wächter), Tauri/CSP/CI, Design-System. 4 unabhängige Prüfer + adversarielle Gegenprüfung | 48 Funde bestätigt (0 kritisch, 0 hoch, 15 mittel, 24 niedrig, 9 Kleinigkeiten). 46 behoben, jeweils mit Regressionstest. Offen: Antwort-Nonce (→ P2, siehe Bedrohungsmodell), Meldung bei Startfehler der App (→ P1) |
