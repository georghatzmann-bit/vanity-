# apps/setup – AEGIS-Setup (P13)

Kleiner Installations-Assistent (`AEGIS-Setup.exe`, eine einzelne Datei ohne Installation):
Willkommen (eigene Animation, Klang abschaltbar) → Datenschutz → Ordner und Pakete → Laden und
Prüfen → Installieren → Fertig.

- Lädt `latest.json` von den GitHub-Releases und prüft die Ed25519-Signatur mit dem
  eingebauten Schlüssel (`release/update-public.key`); ohne Schlüssel lädt das Setup nichts.
- Lädt nur die gewählten Pakete (AEGIS Suite immer, AEGIS Browser auf Wunsch), prüft Größe und
  SHA-256 und startet sie erst nach „Installieren“ (still: `/S /D=<Ordner>`; Windows fragt
  nach Administratorrechten). Vor dem Start wird jede Datei erneut geprüft.
- Fehlt WebView2, fragt das Setup, ob es die offizielle Microsoft-Seite öffnen soll.
- Keine Telemetrie; Verbindungen nur zu GitHub (und auf Wunsch zu Microsoft).
- Deinstallieren: über Windows (Einstellungen → Apps), das NSIS-Deinstallationsprogramm
  entfernt Dienst und Registrierungen; Daten nur nach zwei Bestätigungen.

```bash
pnpm --filter @aegis/setup tauri dev
```
