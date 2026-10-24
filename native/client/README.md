# vanity_client.dll – Ingame-Menü

Das Menü im Spiel (F9) kommt aus **ATLAS Console** (https://github.com/Ralzify/ATLAS-Client),
© ralz, cipherfps und Mitwirkende, Lizenz: *ATLAS Console Attribution License v1.0* (siehe `LICENSE-ATLAS.txt`).
ATLAS Console baut wiederum auf dem **Erbium**-SDK (GPL-3.0, `LICENSE-Erbium.txt`) und **Memcury** (MIT, `LICENSE-Memcury.txt`) auf.

> Vanity basiert beim Ingame-Menü auf ATLAS Console von cipherfps, ralz und Mitwirkenden.

## Was Vanity geändert hat

Alle Änderungen sind in den Dateien mit `// [Vanity]` markiert.

| Bereich | Original | Vanity |
|---|---|---|
| Einstellungen | `%APPDATA%\ATLAS\console.json` | `%APPDATA%\Vanity\client.json` |
| Diagnose-Protokoll | `%APPDATA%\ATLAS\diagnostics.log` | `%LOCALAPPDATA%\Vanity\logs\client-diagnostics.log` |
| MinHook | fertige `minhook.lib` | aus Quellcode, Projekt `native/minhook` |
| Sichtbare Namen | „ATLAS“ | „Vanity“, mit Nennung von ATLAS Console im Info-Reiter |
| Projektdatei | `ATLAS.vcxproj` | `client.vcxproj` (statische Laufzeit, gemeinsame Ausgabeordner) |

Nicht geändert: Spiel-Logik (Edit on Release, Reset on Release, Pre-Edits, Respawns, FOV, Konsole,
Hotkeys, Arena-HUD, Hotfix-Reload). Interne Kennungen wie `ATLAS_ARENA_*` bleiben, weil der Game Server
dieselben Texte erwartet.

## Was das Menü kann

- **Bearbeiten:** Edit on Release, Reset on Release, Pre-Edits aus
- **Respawn:** Immer wieder einsteigen, Wartezeit und Höhe einstellbar
- **Konsole:** F8 oder `^` – Befehle, Verlauf, Tab-Vervollständigung, `/give`, `/startaircraft`
- **Grafik:** FOV-Regler, Nebel an/aus, Mobile-Builds, „Kartoffel-Grafik“, Auflösung (Stretched)
- **Kamera:** First Person
- **Hotkeys:** Menü (F9), Beitreten (F5), eigene Befehle und Makros
- **Netzwerk:** Beitreten per IP, Hotfixes vom Backend live übernehmen

Die DLL wird vom Launcher nach der Anmeldung in das Spiel geladen (`-nullrhi`-Prozesse erkennen sich
selbst als Server ohne Fenster und schalten die Eingabe ab).
