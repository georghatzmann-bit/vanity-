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
| Sichtbare Namen | „ATLAS“ | „Vanity“ (Fenstertitel „Vanity \| Menü“), mit Nennung von ATLAS Console im Reiter „Credits“ |
| Projektdatei | `ATLAS.vcxproj` | `client.vcxproj` (statische Laufzeit, gemeinsame Ausgabeordner) |
| Reiter | Main, Commands, Config, Credits | **Start, Befehle, Optionen, Trickshot, Credits** – „Trickshot“ ist neu (neue Dateien `ATLAS/Private/VanityTrickshotTab.cpp` und `ATLAS/Public/VanityTrickshotTab.h`) |
| Sprache | Englisch | Deutsch, kurz und in Du-Form, mit grauen Erklärungen unter den Schaltern. `GUI.cpp` bleibt reines ASCII (wird ohne `/utf-8` gebaut): Umlaute und Sonderzeichen kommen aus UTF-8-Makros wie `DE_ae`, `DE_ue`, `DE_ss`, `DE_DASH`. Der Lizenz-Satz im Reiter „Credits“ bleibt englisch |
| Server-Nachrichten | nur in die Konsole | zusätzlich Trickshot-Banner bei `[Vanity] TRICKSHOT…` (in `Client.cpp` markiert) |

Nicht geändert: Spiel-Logik (Edit on Release, Reset on Release, Pre-Edits, Respawns, FOV, Konsole,
Hotkeys, Arena-HUD, Hotfix-Reload). Interne Kennungen wie `ATLAS_ARENA_*` bleiben, weil der Game Server
dieselben Texte erwartet.

## Was das Menü kann

Reiter im F9-Menü (Namen wie im Spiel):

- **Start:** „Server beitreten“ (auf diesem PC oder per IP), „Editieren“ (Edit beim Loslassen, Zurücksetzen
  beim Loslassen, Keine Vorschau-Edits – je nach Version), „Grafik“ (Einfache Bauteile, Nebel im Spiel,
  Texturen vereinfachen), „Laufen“ (Immer sprinten, nur alte Versionen), „Sichtfeld“, „Nach dem Tod“
  (Wieder einsteigen), „Sonstiges“ (Ich-Perspektive, Freie Kamera, Ziel-Infos)
- **Befehle:** eigene Befehle und Befehls-Ketten, jeweils mit eigener Taste
- **Optionen:** Welche Konsole?, Konsole mit Taste … öffnen, Schalter merken, Menü-Taste (F9) und
  Beitreten-Taste (F5) ändern, Alles zurücksetzen
- **Trickshot (Vanity):** vier Bereiche, alles auf Deutsch:
  - „Parkour laden“: eine Karte pro Strecke aus `%LOCALAPPDATA%\Vanity\server\parkours.json` (schreibt der
    Launcher), Knopf „Laden“; darunter „Nochmal von vorne“ und „Alles wegräumen“
  - „Ziel-Bot“: Regler „Leben“ (1–200) und „Abstand“ (5–100 m), „Bot vor mich stellen“, „Alle Bots weg“, „Bots zu mir“
  - „Ausrüstung“: Sniper, Sprungpads, Munition, Leben
  - „Üben“: Position merken, Zurück zur Position, Hochschießen, Zeitlupe, wenig/normale Schwerkraft,
    Unverwundbar, Sturm anhalten

  Jeder Knopf schickt einen `cheat …`-Befehl an den Vanity-Server (`parkour …`, `targetbot …` und vorhandene
  Magnesium-Befehle – die Liste steht in `docs/02-architektur.md`). In der Lobby zeigt der Reiter oben einen Hinweis.
- **Credits:** Nennung von Erbium und ATLAS Console (mit Link)
- **Konsole:** F8 – Befehle, Verlauf, Tab-Vervollständigung, `/give`, `/startaircraft`, `/god`
- **Trickshot-Banner (Vanity):** großes „TRICKSHOT!“ oben in der Bildmitte für 3,5 s, auch bei geschlossenem
  Menü und in beiden Konsolen-Modi.

`ATLAS/Private/VanityTrickshotTab.cpp` kommt ohne `pch.h` und ohne Spiel-Header aus (nur ImGui und
`third_party/nlohmann/json.hpp`, MIT, unverändert aus `native/server/json.hpp`, Lizenz in
`third_party/nlohmann/LICENSE.MIT`). Sie wird mit `/utf-8` gebaut und lässt sich auch unter Linux für
Menü-Vorschaubilder kompilieren.

Die DLL wird vom Launcher nach der Anmeldung in das Spiel geladen (`-nullrhi`-Prozesse erkennen sich
selbst als Server ohne Fenster und schalten die Eingabe ab).
