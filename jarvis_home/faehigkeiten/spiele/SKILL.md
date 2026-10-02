---
name: spiele
description: Ein Spiel starten, das nicht im Startmenü steht (Steam, Epic), installierte Spiele auflisten oder ein hängendes Spiel beenden.
---

# Spiele starten und beenden

Erst den normalen Weg: `python -m jarvis.tool oeffnen "<spiel>"` findet alles im Startmenü. Klappt das nicht:

Steam:
1. Steam-Ordner: `(Get-ItemProperty HKCU:\Software\Valve\Steam).SteamPath`.
2. Bibliotheken: In `<SteamPath>\steamapps\libraryfolders.vdf` stehen weitere Ordner ("path").
3. In jedem `<bibliothek>\steamapps\appmanifest_*.acf` stehen "appid" und "name". Such den Namen, der am besten passt.
4. Starten: `Start-Process "steam://rungameid/<appid>"`.

Epic Games: Die Manifeste liegen in `C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON mit "DisplayName" und "AppName"). Starten: `Start-Process "com.epicgames.launcher://apps/<AppName>?action=launch&silent=true"`.

Installierte Spiele auflisten: Steam- und Epic-Namen aus den Manifesten, kurz zusammengefasst.

Ein Spiel hängt: Mit `Get-Process` den Prozess finden (oft der Spielname ohne Leerzeichen) und mit `python -m jarvis.tool schliessen "<name>"` beenden. Vorher kurz sagen, welches Programm du schließt.

Gaming-Modus gehört dazu: `python -m jarvis.tool gaming an` (volle Leistung, keine Einblendungen).
