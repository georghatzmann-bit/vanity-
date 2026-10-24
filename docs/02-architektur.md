# Architektur – wie die Teile zusammenhängen

Diese Datei ist der Vertrag zwischen Launcher, Backend und Spiel-DLLs. Wer eine Schnittstelle
ändert, ändert sie auch hier.

## Ordner

```
launcher/core/            Rust-Logik ohne Fenster (Version, Log, Absturz, Profile, Startargumente) – überall testbar
launcher/src-tauri/       Tauri-App: Fenster, Prozesse, DLL laden, Backend, Server-Pipe (Windows)
launcher/src/             React-Oberfläche
backend/                  Backend (Node 22 + TypeScript), Basis LawinServer → backend/dist/
native/                   C++20, Visual Studio 2022, x64 – eine Lösung: native/Vanity.sln
  third_party/minhook     MinHook (BSD-2) als Quellcode → statische Lib (Projekt „minhook“)
  third_party/imgui       Dear ImGui v1.93.0 (MIT) als Quellcode
  redirect/               Umleitung, Basis Tellurium (BSD-3)          → vanity_redirect.dll
  server/                 Game Server, Basis Magnesium (BSD-3)         → vanity_server.dll
  client/                 Ingame-Menü F9 (eigener Code, GPL-3.0)         → vanity_client.dll
  scripts/check-build.sh  Probe-Kompilieren unter Linux (clang-cl + MSVC-Header aus /opt/xwin)
```

MSBuild-Ausgabe aller DLLs: `native/bin/Release/`. Der Launcher erwartet sie zur Laufzeit in
seinem Ressourcen-Ordner unter `dlls/`, das Backend unter `backend/main.js`, Node unter `node/node.exe`.

## Laufzeit-Ordner auf dem PC

| Pfad | Inhalt |
|---|---|
| `%APPDATA%\Vanity\config.json` | Einstellungen, Profile, Builds, Freunde (schreibt nur der Launcher) |
| `%APPDATA%\Vanity\client.json` | Einstellungen des Ingame-Menüs |
| `%LOCALAPPDATA%\Vanity\backend\` | Daten des Backends (Spind usw.) |
| `%LOCALAPPDATA%\Vanity\server\` | alles, was der Game Server schreibt (`auto_hosting.json`, Wegpunkte, Dumps) |
| `%LOCALAPPDATA%\Vanity\logs\` | Logs der DLLs (`client.log`, `server.log`, `redirect.log`) |

Vanity ändert nichts im Build-Ordner und nichts in den Ordnern anderer Launcher.

## Ports

| Port | Wer | Wofür |
|---|---|---|
| 3551/TCP | Backend | alle umgeleiteten Anfragen + `/vanity/*` |
| 80/TCP (änderbar) | Backend | Matchmaker-WebSocket + XMPP |
| 7777/UDP | Game Server | Spieler verbinden sich mit dem Match |

## Backend

Start: `node.exe <ressourcen>\backend\main.js` mit `VANITY_BACKEND_PORT`, `VANITY_MATCHMAKER_PORT`,
`VANITY_BIND`, `VANITY_DATA_DIR`, `VANITY_GAMESERVER`. Bereit, wenn `GET /vanity/health` → `{"ok":true}`.
`POST /vanity/gameserver {ip,port}` setzt das Matchmaker-Ziel (Beitreten per IP). Details: `backend/README.md`.

## Startablauf („Host & Play“) – so macht es `launcher/src-tauri/src/engine.rs`

1. Backend starten, auf `/vanity/health` warten.
2. Server-Fortnite starten: Hilfsprogramme `FortniteLauncher.exe` und `…_EAC.exe` pausiert
   (laufen nie), dann `FortniteClient-Win64-Shipping.exe` mit den Argumenten aus
   `launcher/core/src/launchargs.rs` (`-AUTH_LOGIN=<name>@vanity.local`, `-nosplash -nosound`,
   bei „ohne Grafik“ `-nullrhi`, immer `-log`), Umgebung `OPENSSL_ia32cap=~0x20000000`.
3. **Sofort** `vanity_redirect.dll` laden. Die DLL wartet selbst, bis Fortnites HTTP-Teil da ist.
4. Nach ca. 8 s `vanity_server.dll` laden. **Die DLL muss selbst warten**, bis Engine und Welt bereit
   sind (Magnesium tut das bereits in `SDK::Init`), und darf bei frühem Laden nicht abstürzen.
5. Launcher verbindet sich mit der Steuer-Pipe (bis zu 90 s) und wartet auf `ready`.
6. Spiel-Fortnite starten (ohne `-nullrhi`, mit `-d3d11` aus dem Profil), Umleitung sofort, nach
   ca. 12 s `vanity_client.dll`. Auch sie wartet selbst auf die Engine.

Logs: Der Launcher liest stdout/stderr jeder Instanz (deshalb `-log`). Zusätzlich schreiben die DLLs
in `%LOCALAPPDATA%\Vanity\logs\`.

## Steuer-Pipe des Game Servers

`\\.\pipe\vanity-server` – der Server erstellt sie, der Launcher ist der einzige Client.
Zeilen mit je einem JSON-Objekt (UTF-8, `\n`). Der Launcher-Code dazu: `launcher/src-tauri/src/pipe.rs`.

Launcher → Server:

| Nachricht | Wirkung |
|---|---|
| `{"id":1,"cmd":"exec","text":"startaircraft"}` | führt einen Magnesium-Cheat-Befehl im Spiel-Takt aus, als käme er vom Host (ohne das Wort `cheat`) |
| `{"id":2,"cmd":"config","key":"bInfiniteAmmo","value":true}` | setzt einen Wert aus `FConfiguration`; Schlüssel mindestens: `playlist` (String, Playlist-Pfad oder Kurzname wie `Playlist_DefaultSolo`), `bLateGame`, `bInfiniteAmmo`, `bInfiniteMats`, `bForceRespawns`, `RespawnTime`, `RespawnHeight`, `bEnableCheats`, `BotHealth`, `BotShield`, `bAutoRestart`, `bTrickshotDetection`, `bNoFallDamage`, `bInstantReload` |
| `{"id":3,"cmd":"startmatch"}` | wie der Knopf „Start Match“ in Magnesiums Fenster |
| `{"id":4,"cmd":"status"}` | Server antwortet mit `status` |

Server → Launcher:

| Nachricht | Bedeutung |
|---|---|
| `{"event":"ready","port":7777}` | Server lauscht, Spieler können kommen |
| `{"event":"reply","id":1,"ok":true,"message":"…"}` | Antwort auf einen Befehl (Text deutsch, kurz) |
| `{"event":"status","players":3,"phase":"Warmup","playlist":"…"}` | Zustand |
| `{"event":"trickshot","player":"georg","text":"in der Luft","distance":128}` | erkannter Trickshot |
| `{"event":"matchEnd"}` | Match vorbei |

Unbekannte Befehle → `reply` mit `ok:false`. Die Pipe-Threads fassen keine Spiel-Objekte an; sie legen
Befehle in eine Warteschlange, die im Spiel-Takt (Game-Thread) abgearbeitet wird.

## Ingame-Menü (Client-DLL)

- Liest beim Laden `%APPDATA%\Vanity\client.json`, schreibt Änderungen zurück. Format (von ATLAS Console übernommen,
  der Launcher schreibt dasselbe): `{ "hotkey": 120, "joinHotkey": 116, "consoleMode": 0,
  "preferences": { "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true, "respawnsEnabled": true,
  "firstPerson": false, "sprintByDefault": true, "inGameFog": true, "mobileBuilds": false, "slashKey": true,
  "saveTogglePreferences": true }, "commands": [], "macros": [] }` (Tasten = Windows-VK-Codes).
  Trickshot-Presets liegen **nicht** hier, sondern in der Launcher-`config.json` (`trickshotPresets`).
- Alles, was Spiel-Objekte anfasst, läuft im Spiel-Takt. Eigene Threads legen nur Befehle in eine Warteschlange.
- Host-Funktionen (Bus, Sturm, Bots, Items, Wegpunkte) schickt das Menü als `cheat <befehl>` an den Server;
  der Server prüft selbst, ob der Absender der Host ist.
- Trickshot-Anzeige: Server-Nachrichten, die mit `[Vanity] Trickshot: ` beginnen, werden als Banner gezeigt.
- Jede Funktion hat eine Versionsliste. Nicht geprüfte Versionen → ausgegraut statt Absturz.
