# Architektur – wie die Teile zusammenhängen

Diese Datei ist der Vertrag zwischen Launcher, Backend und Spiel-DLLs. Wer eine Schnittstelle
ändert, ändert sie auch hier.

## Ordner

```
launcher/core/            Rust-Logik ohne Fenster (Version, Log, Absturz, Profile, Startargumente) – überall testbar
launcher/src-tauri/       Tauri-App: Fenster, Prozesse, DLL laden, Backend, Server-Pipe (Windows)
launcher/src/             React-Oberfläche
launcher/src/data/parkours.json   die fertigen Trickshot-Parkours (eine Datei für Oberfläche, Rust, Server und F9-Menü)
backend/                  Backend (Node 22 + TypeScript), Basis LawinServer → backend/dist/
native/                   C++20, Visual Studio 2022, x64 – eine Lösung: native/Vanity.sln
  third_party/minhook     MinHook (BSD-2) als Quellcode → statische Lib (Projekt „minhook“)
  third_party/imgui       Dear ImGui v1.93.0 (MIT) als Quellcode
  redirect/               Umleitung, Basis Tellurium (BSD-3)          → vanity_redirect.dll
  server/                 Game Server, Basis Magnesium (BSD-3)         → vanity_server.dll
  client/                 Ingame-Menü F9, Basis ATLAS Console          → vanity_client.dll
  client/third_party/nlohmann   JSON for Modern C++ 3.11.2 (MIT), unveränderte Kopie von server/json.hpp
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
| `%LOCALAPPDATA%\Vanity\server\parkours.json` | Trickshot-Parkours – schreibt der Launcher, lesen Game Server und F9-Menü (siehe unten) |
| `%LOCALAPPDATA%\Vanity\logs\` | Logs der DLLs: `redirect.log` (Umleitung), `client-diagnostics.log` (Ingame-Menü). Der Game Server schreibt in `stdout.log` im Build-Ordner |

Vanity ändert nichts im Build-Ordner und nichts in den Ordnern anderer Launcher.

## Versionen

Vanity startet **jede Version von 1.7 bis 30.x** (Chapter 1 bis Chapter 5 Season 3). Die Grenzen kommen
aus dem Quellcode der Bauteile, nicht aus Vermutungen – recherchiert in Reboot Launcher, Erbium/Magnesium,
Tellurium, ATLAS Console und LawinServer (Oktober 2026):

| Stufe (`Support`) | Bedeutung | Anzeige |
|---|---|---|
| `supported` | wirklich getestet (`TESTED` in `launcher/core/src/version.rs`, derzeit 19.10) | „Getestet“ |
| `experimental` | 1.7 bis 30.x, ungetestet – wird gestartet, mit Hinweis im Log und auf der Build-Karte | „Ungetestet“ |
| `unsupported` | älter als 1.7, unlesbar, oder **ab 31.00**: der Game Server (Erbium/Magnesium) lehnt solche Builds selbst ab (`SDK/Offsets.h`, Grenze 31.00) | „Nicht startbar“ |

Was je Version anders läuft (`launcher/core/src/launchargs.rs`, `VersionRules`):

| Versionen | Regel | Quelle |
|---|---|---|
| alle | gleiche Startargumente wie bei Reboot: Platzhalter-Anmeldung, `-fltoken`/`-caldera` als feste öffentliche Platzhalter, Hilfsprogramme pausiert, `-nobe`, kein BattlEye | Reboot `game_metadata.dart` |
| alle | Umleitung sofort nach dem Start laden; schlägt das fehl, wird der Prozess beendet (nie zu Epic) | Tellurium |
| 1.x – 10.40 | Speicherleck-Fix der Umleitung an (`-vanityversion=` sagt der DLL die Version); ab 11 aus | Reboot (`< 10`), Tellurium |
| 5.00 – 6.xx | Server-DLL **sofort** nach der Anmeldung laden (Unreal 4.21 stürzt ohne Fenster sonst ab) | Magnesium `dllmain.cpp` |
| ab 20.00 | Ingame-Menü 8 s statt 6 s nach der Anmeldung laden (Engine-Objekte brauchen länger) | ATLAS `dllmain.cpp` |
| ab 33.00 | kein DirectX 11 – `-d3d11` wird entfernt (derzeit ohnehin nicht startbar) | Epic |
| 9.40 – 10.40 | Backend liefert keine Hotfix-Dateien (Absicht in LawinServer) → kein Party-System/XMPP, Spielen geht | LawinServer `cloudstorage.js` |
| ab 23 | Backend schaltet Netz-Verschlüsselung aus; Server und Menü machen dasselbe | LawinServer, Erbium, ATLAS |
| ab 24.00 | Menü schaltet Verschlüsselung aus; ab UE 5.3 (ca. 27) Iris-Netzwerk – Server und Menü sind sich einig | ATLAS, Magnesium |
| ab 28.00 | Chapter-5-Bewegung (Tac-Sprint, Hürde, Rutschen) ist in Menü und Server aus | ATLAS, Magnesium |

Playlists (Steuer-Pipe, wie die Knöpfe im Server-Fenster): Trios ab 7.40, Turnier ab 6.10, Arena ab 8.20,
Zero Build und Arena Zero Build ab 20.00, Playground 4.5 bis 11.3. Zu frühe Versionen lehnt der Server mit Hinweis ab.

Ingame-Menü je Version (aus dem ATLAS-Code, Namen wie im Reiter „Start“): „Edit beim Loslassen“ bis 10.40
(Unreal < 4.24), „Keine Vorschau-Edits“ bis 15.1x, „Zurücksetzen beim Loslassen“ bis 24.2x, „Immer sprinten“
bis 4.x, „Freie Kamera“ bis 10.40, Arena-Anzeige 8.20 bis 30.x; Sichtfeld, Ich-Perspektive, Konsole,
„Wieder einsteigen“ und der Reiter „Trickshot“ in allen Versionen. Ausgeblendete Schalter fehlen einfach.

Die Umleitung schreibt `%LOCALAPPDATA%\Vanity\logs\redirect.log`: welches Muster gepasst hat, ob die
Umleitung steht, ob der Speicherleck-Fix lief. Passt eine Version nicht, steht dort „FEHLER“ und das Spiel wird beendet.

Wenn du eine Version getestet hast und sie läuft, kommt sie in `TESTED` und wird „Getestet“.

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
2. `parkours.json` frisch nach `%LOCALAPPDATA%\Vanity\server\` schreiben (macht der Launcher auch schon beim
   eigenen Start). Server-Fortnite starten: Hilfsprogramme `FortniteLauncher.exe` und `…_EAC.exe` pausiert
   (laufen nie), dann `FortniteClient-Win64-Shipping.exe` mit den Argumenten aus
   `launcher/core/src/launchargs.rs` (`-AUTH_LOGIN=<name>@vanity.local`, `-nosplash -nosound`,
   bei „ohne Grafik“ `-nullrhi`, immer `-log`), Umgebung `OPENSSL_ia32cap=~0x20000000`.
3. **Sofort** `vanity_redirect.dll` laden. Die DLL wartet selbst, bis Fortnites HTTP-Teil da ist.
4. Nach ca. 8 s `vanity_server.dll` laden. **Die DLL muss selbst warten**, bis Engine und Welt bereit
   sind (Magnesium tut das bereits in `SDK::Init`), und darf bei frühem Laden nicht abstürzen.
5. Launcher verbindet sich mit der Steuer-Pipe (bis zu 90 s), schickt der Reihe nach `bEnableCheats` = true,
   `playlist` (falls im Profil gesetzt) und `bLateGame`, und wartet auf `ready`.
6. Spiel-Fortnite starten (ohne `-nullrhi`, mit `-d3d11` aus dem Profil), Umleitung sofort, nach
   ca. 12 s `vanity_client.dll`. Auch sie wartet selbst auf die Engine.

Logs: Der Launcher liest stdout/stderr jeder Instanz (deshalb `-log`). Zusätzlich schreiben die DLLs
in `%LOCALAPPDATA%\Vanity\logs\`.

## Steuer-Pipe des Game Servers

`\\.\pipe\vanity-server` – der Server erstellt sie, der Launcher ist der einzige Client.
Zeilen mit je einem JSON-Objekt (UTF-8, `\n`). Code: Server `native/server/Erbium/Private/VanityControl.cpp`,
Launcher `launcher/src-tauri/src/pipe.rs` und `engine.rs`.

Launcher → Server:

| Nachricht | Wirkung |
|---|---|
| `{"id":1,"cmd":"exec","text":"startaircraft"}` | führt einen Cheat-Befehl im Spiel-Takt aus – so, als hätte der **Spieler am Host-PC** (verbunden über 127.0.0.1; sonst der erste verbundene Spieler) `cheat startaircraft` getippt (ein `cheat ` am Anfang wird entfernt). Es gelten dieselben Prüfungen wie im Spiel. `ok:true` heißt nur „übergeben“; was der Befehl antwortet, sieht dieser Spieler im Spiel. Ist noch niemand verbunden: `ok:false` mit „Noch niemand im Spiel. Tritt zuerst dem Match bei, dann klappt es.“ |
| `{"id":2,"cmd":"config","key":"bInfiniteAmmo","value":true}` | setzt einen Wert aus `FConfiguration` (Schlüssel siehe unten) |
| `{"id":3,"cmd":"startmatch"}` | wie START SERVER im Server-Fenster; läuft der Server schon: `ok:false` |
| `{"id":4,"cmd":"status"}` | Server antwortet mit `status` (mit derselben `id`) |

Schlüssel für `config` – genau die, die `ApplyConfig` kennt. Jeder andere Schlüssel → `ok:false`
(„Einstellung „…“ kennt der Server nicht“), Zahlen außerhalb des Bereichs ebenso:

| Schlüssel | Wert |
|---|---|
| `playlist` | Text: Kurzname wie `Playlist_DefaultSolo` oder voller `/Game/`-Pfad – nur vor dem Start |
| `bLateGame`, `bEnableCheats`, `bTrickshotDetection` | true/false |
| `bEnableTrickshotTab` | true/false – **`false` setzt alle Trickshot-Schalter des Servers zurück**, darum schickt der Launcher ihn nie |
| `bAutoReloadOnWaypointTP`, `bRemoveIceOnWaypointTP`, `bDisableJumpFatigue`, `bPlayerMapIcons` | true/false (Trickshot-Schalter wie im Server-Fenster) |
| `AutoGodModeType` | 0 oder 1 |
| `bAutoBusStart` | true/false – danach gilt diese Wahl statt der Vorgabe der Playlist |
| `bMovingBus` | true/false |
| `BusStartDelay` | 0–600 (Kommazahl) |
| `LateGameZone` | 1–12 |
| `bLateGameLongZone` | true/false |
| `bForceRespawns`, `bKeepInventory`, `bMidZoneRespawning`, `PermanentRespawn` | true/false |
| `RespawnTime` | 1–60 (Sekunden) |
| `RespawnHeight` | 1000–50000 |
| `bInfiniteAmmo`, `bInfiniteMats`, `bSiphon`, `bHasPickaxe` | true/false |
| `SiphonAmount` | 0–200 |
| `BotHealth` / `BotShield` | 1–1000 / 0–1000 – gilt für Bots, die danach erscheinen |
| `UseCustomBotNames`, `bAutoGodMode`, `bGliderRedeploy`, `bAutoStartEvent`, `bJoinInProgress` | true/false |

`bAutoRestart`, `bNoFallDamage` und `bInstantReload` gibt es **nicht** (standen früher hier).

Was der Launcher schickt:

- Beim Verbinden, der Reihe nach: `bEnableCheats` = true, `playlist` (falls im Profil gesetzt), `bLateGame`.
- Vor jedem `startmatch` nochmal `bEnableCheats` = true. Ebenso, sobald `status.ready` von false auf true springt
  (Start über START SERVER oder den Auto-Host-Countdown – „Toggle Auto Host“ im Server-Fenster schaltet die
  Cheats sonst aus).
- Von der Seite „Match-Steuerung“: `playlist`, `bLateGame`, `bForceRespawns`, `RespawnTime`, `bInfiniteAmmo`,
  `bInfiniteMats`, `bTrickshotDetection`, `bDisableJumpFatigue`, `bAutoReloadOnWaypointTP`, `BotHealth`, `BotShield`;
  als `exec` die Befehle der Knöpfe (`startaircraft`, `pausesafezone`, `resumesafezone`, `skipsafezone`, `give …`,
  `givetoall …`, `parkour …`, `targetbot …`, `bot <n>`, `tpbot`, `delbot`, `demospeed …`, `gravity …`, `god`,
  `s vanity o`, `w vanity`, `l 2500`, `givetraps`, `giveammo`, `regen`) und die eigenen Presets
  (ein `cheat ` oder `/` am Anfang wird weggelassen).

Server → Launcher:

| Nachricht | Bedeutung |
|---|---|
| `{"event":"hello","fortnite":19.1,"engine":5.0}` | gleich nach dem Verbinden: Version des Builds |
| `{"event":"ready","port":7777}` | Server lauscht, Spieler können kommen (einmal pro Verbindung, ab Phase `joinable`) |
| `{"event":"reply","id":1,"ok":true,"message":"Ausgeführt: startaircraft"}` | Antwort auf einen Befehl (Text deutsch, kurz). Bei `ok:false` zeigt der Launcher den Text als Hinweis „Server“ |
| `{"event":"status","phase":"joinable","ready":true,"players":1,"lategame":false,"playlist":"/Game/…","port":7777}` | alle 2 s. `phase`: `notReady`, `ready`, `joinable`, `started`, `ended`. `ready` = der Start wurde ausgelöst |
| `{"event":"trickshot","player":"georg","victim":"Bot 3","meters":87}` | Trickshot erkannt (siehe unten). Der Launcher zeigt „TRICKSHOT! georg“ mit „gegen Bot 3 · 87 m“ |
| `{"event":"matchEnd"}` | Match vorbei – Launcher-Hinweis „Match beendet“ |

Unbekannte Befehle → `reply` mit `ok:false`. Die Pipe-Threads fassen keine Spiel-Objekte an; sie legen
Befehle in eine Warteschlange, die im Spiel-Takt (Game-Thread) abgearbeitet wird.

### Wer darf Cheat-Befehle schicken?

Alles, was F9-Menü und Launcher schicken, läuft über Magnesiums `ServerCheat`
(`native/server/FortniteGame/Private/FortPlayerControllerAthena.cpp`). Der Server führt einen Befehl nur aus,
wenn `bEnableCheats` an ist – oder wenn der Spieler vom selben PC kommt (127.0.0.1) und die Playlist nicht
„Only Up“ ist. Sonst antwortet er „Commands are currently disabled for this session.“ Darum schaltet der
Launcher `bEnableCheats` ein (siehe oben). Es ist dein eigener Server: Dann dürfen alle Spieler darauf Befehle schicken.

## Vanity-Befehle im Game Server (`parkour`, `targetbot`)

Code: `native/server/Erbium/Private/VanityParkour.cpp` (eigener Vanity-Code), angeschlossen in `ServerCheat`
(markiert mit `VANITY:`). Getippt als `cheat parkour …` (Konsole, F9-Knöpfe) oder über die Pipe als `exec`.
Alles läuft im Spiel-Takt, Fehler werden abgefangen. Die Antworten gehen auf Deutsch, mit „[Vanity] “ davor,
als `ClientMessage` an den Spieler, der den Befehl geschickt hat. Ohne Spielfigur (z. B. im Bus oder tot):
„Du brauchst dafür eine Spielfigur. Warte, bis du im Spiel stehst.“

| Befehl | Wirkung |
|---|---|
| `parkour <id>` | baut den Parkour aus `parkours.json` um dich: alten Vanity-Parkour wegräumen → Blickrichtung auf 90° runden → Start-Platten `height` m über deinen Füßen → Sprung-Objekte (mit eigener Platte, falls angegeben) → Ziel-Bots, jeder auf seiner Platte → dich auf den Start stellen (Blick nach vorne) → erste Sniper aus `snipers` geben, die die Version kennt. Stehst du noch auf dem alten Start, baut er von der alten Boden-Höhe aus (sonst landet jeder neue Parkour höher). |
| `parkour retry` | zurück zum Start, Blick nach vorne, Leben und Schild voll, Waffen nachgeladen; erledigte Ziel-Bots dieses Parkours kommen an ihren Platz zurück |
| `parkour clear` | entfernt alle Platten, Objekte und Ziel-Bots – auch die von `targetbot` |
| `parkour sniper` | nur die Sniper geben |
| `parkour list` | zeigt alle ids |
| `parkour` | kurze Hilfe |
| `targetbot <leben> <meter>` | ein stehender Bot genau in deiner Blickrichtung, `<meter>` vor dir auf deiner Fuß-Höhe, auf einer Platte. Ohne Zahlen: 50 Leben, 30 m. Grenzen: 1–500 Leben, 5–200 m |

Einzelheiten:

- Ziel-Bots entstehen über den vorhandenen Befehl `bot X Y Z`. Nur für diesen einen Bot gilt `BotHealth` = Leben
  und `BotShield` = 0, danach wieder die alten Werte. Die englischen Meldungen von `bot` sind dabei stumm.
  `delbot` entfernt Ziel-Bots wie alle anderen Bots.
- Platten: `woodfloor`, gebaut wie beim Laden eines Trickshot-Presets. Sie gehören dem Spieler und sind fest
  gestützt, damit sie in der Luft nicht einstürzen.
- **Annahme zum Boden-Ursprung:** Eine Fortnite-Boden-Platte hat ihren Ursprung auf Lauf-Höhe in der Mitte ihrer
  linken Kante (lokal −Y), nicht in der Mitte. `SpawnFloorTile` setzt sie darum eine halbe Platte (256 cm) nach
  links versetzt (`kFloorOriginLeftOfCenterCm`). Beleg: das Preset
  `native/server/Erbium/Resources/TrickshotPresets/BlockWinner_15Bandit.json` (echte Bauten aus 10.40). In anderen
  Versionen ist das ungeprüft – liegt eine Platte beim Test halb daneben, ist das die Stelle.
- Neue Welt (neues Match) → alles Gemerkte (Start, gebaute Teile, Ziel-Bots) wird vergessen.

## Trickshot-Parkours (`parkours.json`)

Eine Datei für alle: `launcher/src/data/parkours.json`. Sie steckt fest im Launcher (Rust: `include_str!` in
`launcher/core/src/parkours.rs`, Oberfläche: `launcher/src/lib/parkours.ts`). Der Launcher schreibt sie beim
eigenen Start und direkt vor jedem Server-Start nach `%LOCALAPPDATA%\Vanity\server\parkours.json` – jedes Mal neu,
sicher über eine Hilfsdatei mit Umbenennen. Klappt das nicht, steht es nur im Log.

- Game Server: liest die Datei bei jedem `parkour …` neu (höchstens 2 MB, UTF-8, BOM erlaubt).
- F9-Menü: schaut höchstens alle 2 s auf die Änderungszeit und liest dann neu. Es braucht nur `id`, `name`,
  `description` und `level`. Ist die Datei kaputt, bleibt die letzte gute Liste stehen.

```json
{
  "version": 1,
  "kinds": {
    "trampoline": { "label": "Trampolin", "summon": ["tire", "umbrella"] }
  },
  "snipers": ["reaper_sr", "hunterbolt_sr", "heavy_sr", "bolt_sr", "hunting_sr", "semi"],
  "parkours": [
    {
      "id": "erster-sprung",
      "name": "Erster Sprung",
      "level": 1,
      "description": "Lauf übers Trampolin, flieg hoch und triff den Bot vor dir.",
      "height": 25,
      "platform": [3, 3],
      "elements": [ { "kind": "trampoline", "at": [9, 0, -1] } ],
      "bots": [ { "at": [40, 0, 0], "hp": 50 } ]
    }
  ]
}
```

| Feld | Bedeutung |
|---|---|
| `kinds.<art>.label` | Name, den der Spieler sieht – z. B. in „Gibt es in dieser Version nicht (weggelassen): Trampolin.“ |
| `kinds.<art>.summon` | Objekt-Namen wie bei `cheat summon` (Kurzname aus `native/server/Erbium/Private/Misc.cpp` oder Klassen-Pfad). Der Server nimmt den ersten, den die Version kennt; kennt sie keinen, fehlt das Teil |
| `snipers` | Item-Namen wie bei `cheat give`; der erste, den die Version kennt, kommt ins Inventar |
| `id` | nur a–z, 0–9 und „-“, höchstens 40 Zeichen; nicht `retry`, `clear`, `sniper`, `list` |
| `level` | 1–3 (leicht, mittel, schwer) |
| `height` | Start so viele Meter über deinen Füßen (0 = am Boden) |
| `platform` | `[breite, tiefe]` in Boden-Platten zu je 5,12 m, je 0–9; `[0, 0]` = keine Platte |
| `elements[].at`, `bots[].at` | `[vorne, rechts, oben]` in Metern vom Startpunkt; vorne = Blickrichtung (auf 90° gerundet), oben zählt ab der Start-Höhe |
| `elements[].platform` | freiwillig; ohne Angabe keine Platte unter dem Objekt |
| `bots[].hp` | 1–500 Leben (kein Schild) |
| `bots[].platform` | freiwillig; ohne Angabe eine Platte (`[1, 1]`) unter dem Bot |

Grenzen prüft `validate` in `launcher/core/src/parkours.rs` (`cargo test` prüft damit die echte Datei): höchstens
64 Parkours (mehr zeigt das F9-Menü nicht), 48 Teile und 12 Bots pro Parkour, je Richtung höchstens 1000 m,
`height` 0–300, und kein Teil und kein Bot näher als 3 m (waagerecht) am Startpunkt – dort landet der Spieler.
Der Server prüft das nicht noch einmal: Er kürzt still, was über seinen Grenzen liegt, und baut den Rest.

## Trickshot-Erkennung

`VanityParkour::OnElimination` wird aus `ClientOnPawnDied` für jedes Ausscheiden aufgerufen (auch von Bots, auch
mit Respawn). Es ist ein Trickshot, wenn der Schütze ein echter Spieler ist (kein Bot, eine echte Verbindung,
nicht er selbst) und seine Spielfigur gerade in der Luft ist (im Sprung, im Fall oder im Fallschirmsprung). Dann:

- bekommen alle Spieler die `ClientMessage` „[Vanity] TRICKSHOT! <Name> – <Meter> m“
  (Meter = Abstand vom Schützen zum Opfer). Das F9-Menü macht daraus das Banner (siehe unten);
- bekommt der Launcher `{"event":"trickshot","player":…,"victim":…,"meters":N}`;
- wird dasselbe Opfer innerhalb von 1,5 s nur einmal gemeldet.

An/aus: Pipe-Schlüssel `bTrickshotDetection` (Standard: an; im Launcher „Trickshot-Anzeige“). Das ist unabhängig
vom Trickshot-Reiter im Server-Fenster.

## Ingame-Menü (Client-DLL)

- Liest beim Laden `%APPDATA%\Vanity\client.json`, schreibt Änderungen zurück. Format (von ATLAS Console übernommen,
  der Launcher schreibt dasselbe): `{ "hotkey": 120, "joinHotkey": 116, "consoleMode": 0,
  "preferences": { "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true, "respawnsEnabled": true,
  "firstPerson": false, "sprintByDefault": true, "inGameFog": true, "mobileBuilds": false, "slashKey": true,
  "saveTogglePreferences": true }, "commands": [], "macros": [] }` (Tasten = Windows-VK-Codes).
  Trickshot-Presets liegen **nicht** hier, sondern in der Launcher-`config.json` (`trickshotPresets`). Ausgeführt
  werden sie auf der Seite „Match-Steuerung“ → Reiter „Trickshot“ → „Deine Presets“ (Befehl für Befehl über die Pipe).
- Alles, was Spiel-Objekte anfasst, läuft im Spiel-Takt. Eigene Threads legen nur Befehle in eine Warteschlange.
- Fenstertitel „Vanity | Menü“, alle Texte deutsch (`native/client/ATLAS/Private/GUI.cpp`). Reiter:

| Reiter | Inhalt |
|---|---|
| Start | Server beitreten, Editieren, Grafik, Laufen, Sichtfeld, Nach dem Tod, Sonstiges |
| Befehle | eigene Befehle und Befehls-Ketten, jeweils mit eigener Taste |
| Optionen | Welche Konsole?, Konsole mit Taste … öffnen, Schalter merken, Menü- und Beitreten-Taste, Alles zurücksetzen |
| Trickshot | Vanity: Parkour laden, Ziel-Bot, Ausrüstung, Üben (`ATLAS/Private/VanityTrickshotTab.cpp`) |
| Credits | Nennung von Erbium und ATLAS Console; der Lizenz-Satz „Vanity is based on ATLAS Console …“ bleibt englisch |

- Schalter, die es in einer Version nicht gibt, werden ausgeblendet (siehe „Versionen“).
- Konsole: **F8**. In der Vanity-Konsole zusätzlich `VK_OEM_3` (US-Tastatur `~`, deutsche Tastatur Ö) und – wenn
  „Konsole mit Taste … öffnen“ an ist – `VK_OEM_2` (US `/`, deutsch `#`); dann geht sie mit „/“ vorbelegt auf.
- Host-Funktionen schickt das Menü als `cheat <befehl>` an den Server (siehe „Wer darf Cheat-Befehle schicken?“).

Die Knöpfe im Reiter „Trickshot“:

| Knopf | Befehl |
|---|---|
| Parkour-Karte → Laden | `cheat parkour <id>` |
| Nochmal von vorne / Alles wegräumen | `cheat parkour retry` / `cheat parkour clear` |
| Bot vor mich stellen | `cheat targetbot <leben> <meter>` (Regler 1–200 Leben, 5–100 m; Start 50 / 30) |
| Alle Bots weg / Bots zu mir | `cheat delbot` / `cheat tpbot` |
| Sniper geben / Sprungpads geben | `cheat parkour sniper` / `cheat givetraps` |
| Munition auffüllen / Leben auffüllen | `cheat giveammo` / `cheat regen` |
| Position merken / Zurück zur Position | `cheat s vanity o` / `cheat w vanity` |
| Hochschießen | `cheat l 2500` |
| Zeitlupe (Schalter) | einschalten: `cheat demospeed 0.5`, ausschalten: `cheat demospeed 1` |
| Wenig Schwerkraft / Normale Schwerkraft | `cheat gravity 0.4` / `cheat gravity 1` |
| Unverwundbar umschalten | `cheat god` |
| Sturm anhalten / Sturm weiterlaufen lassen (Schalter) | `cheat pausesafezone` / `cheat resumesafezone` |

Nach einem Klick steht unter dem Bereich (bei „Laden“ in der Karte) kurz „Gesendet: …“ – oder „Geht gerade
nicht – bist du schon im Match?“, wenn der Befehl nicht abgeschickt werden konnte. Die eigentliche Antwort des
Servers steht in der Konsole (Einstellung „Vanity-Konsole“). „Zeitlupe“ und „Sturm“ merkt sich das Menü selbst;
bei einem neuen Match springen sie zurück auf „aus“. In der Lobby steht oben ein Hinweis, dass die Knöpfe erst
im Match klappen.

**Trickshot-Banner:** `Client.cpp` schaut sich jede `ClientMessage` an (in beiden Konsolen-Modi). Beginnt sie mit
`[Vanity] TRICKSHOT`, zeigt `VanityToast_Draw` (jeden Frame, auch bei geschlossenem Menü) oben in der Bildmitte
groß „TRICKSHOT!“ und darunter den Rest der ersten Zeile (Name und Meter), 3,5 s lang. Die Nachricht selbst
läuft unverändert weiter in die Konsole.
