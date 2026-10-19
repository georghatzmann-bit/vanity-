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
| `clippy.toml` `disallowed-methods` für verändernde APIs + Allowlist-Test | Jede neue Veränderungsstelle fällt im Review auf |
| Prüfprotokoll mit Hash-Kette | Nachträgliche Manipulation des Protokolls wird erkannt |
| „Nichts ohne Ja“-Tests (Zustands-Schnappschuss byte-genau) | Scans/Wächter/Panic ohne Bestätigung ändern nachweislich nichts |

## Bedrohungsmodell (ehrlich)

- **Kein Kernel-Treiber.** AEGIS erkennt, warnt und isoliert auf Wunsch; es blockiert keine
  Programme vor dem Start. Das steht so in der UI.
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

- Strikte CSP (`default-src 'self'`, keine Remote-Skripte, keine Frames, `object-src 'none'`).
  `style-src 'unsafe-inline'` ist nötig für Motion-Inline-Transforms – nur Stile, keine Skripte.
- `withGlobalTauri: false`, `freezePrototype: true`, Capabilities minimal (`core:default`).
  Jede zusätzliche Berechtigung wird hier begründet.
- Keine Remote-Inhalte im App-Fenster, keine CDNs, keine Telemetrie.
- Installation pro Nutzer (NSIS `currentUser`), Admin nur für den Dienst.

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
| – | – | – |
