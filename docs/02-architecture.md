# Architecture – how the parts fit together

This file is the contract between the launcher, the backend and the game DLLs. Whoever changes an
interface changes it here too.

Niobium used to be called **Vanity**. Every name below is the new one; the section
[Moving over from Vanity](#moving-over-from-vanity) says what happens to old data.

## Names

| What | Value |
|---|---|
| Display name | Niobium (long form: "NiobiumFN — old seasons, new shine.") – brand rules in [`brand.md`](brand.md) |
| Lowercase id | `niobium` |
| Game DLLs | `niobium_redirect.dll`, `niobium_server.dll`, `niobium_client.dll` (MSBuild `TargetName`) |
| Visual Studio solution | `native/Niobium.sln` |
| Control pipe of the game server | `\\.\pipe\niobium-server` |
| Tauri app | productName `Niobium`, identifier `dev.niobium.launcher`, main binary `Niobium.exe`, window title "Niobium" |
| Packages | npm `niobium-launcher` (launcher), `niobium-backend` (backend); Cargo `niobium-launcher` (library `niobium_launcher_lib`) and `niobium-core` |
| Backend environment variables | `NIOBIUM_BACKEND_PORT`, `NIOBIUM_MATCHMAKER_PORT`, `NIOBIUM_BIND`, `NIOBIUM_DATA_DIR`, `NIOBIUM_GAMESERVER` |
| Backend routes | `/niobium/health`, `/niobium/status`, `/niobium/gameserver` |
| Login | `-AUTH_LOGIN=<name>@niobium.local`, `-AUTH_PASSWORD=niobium` |
| Version hint for the DLLs | launch argument `-niobiumversion=<version>`, e.g. `-niobiumversion=19.10` |
| Chat and console prefix | `[Niobium] ` (with the space) |
| Markers in vendored code | `// NIOBIUM:` (server, redirect, LawinServer), `// [Niobium]` (in-game menu) |
| CI | release tag `niobium-test`, release name "Niobium – test build", installer `Niobium-Setup.exe`, artifacts `niobium-backend-dist`, `niobium-dlls`, `niobium-installer` |

The GitHub repository itself is still called `vanity-`.

## Folders

```
launcher/core/            Rust logic without a window (version, logs, crashes, profiles, launch arguments,
                          parkours, Bubble Builds INI check, Vanity migration, AI bot settings in
                          src/bots.rs, the build downloader in src/epic/) – testable everywhere
launcher/core/data/build-catalog.json   the builds "Download a version" offers (manifest ids and SHA-1s)
launcher/src-tauri/       Tauri app: windows, processes, loading DLLs, backend, server pipe, downloads
                          (src/download/) (Windows)
launcher/src-tauri/windows/   installer hooks (hooks.nsh) and installer images (assets/*.bmp)
launcher/src/             React UI
launcher/splash.html      the splash window (no scripts)
launcher/src/data/parkours.json   the ready-made trickshot parkours (one file for the UI, Rust, server and F9 menu)
backend/                  backend (Node 22 + TypeScript), based on LawinServer → backend/dist/
native/                   C++ (/std:c++latest), Visual Studio 2022 (v143), x64 – one solution: native/Niobium.sln
  third_party/minhook     MinHook (BSD-2) as source → static library (project "minhook")
  third_party/imgui       Dear ImGui v1.93.0 (MIT) as source – not used by the projects right now
  redirect/               redirect, based on Tellurium (BSD-3)        → niobium_redirect.dll
  server/                 game server, based on Magnesium (BSD-3)      → niobium_server.dll
  client/                 in-game menu F9, based on ATLAS Console      → niobium_client.dll
  client/third_party/nlohmann   JSON for Modern C++ 3.11.2 (MIT), unchanged copy of server/json.hpp
  scripts/check-build.sh  test compile on Linux (clang-cl + MSVC headers from /opt/xwin)
  tools/menu-preview/     renders screenshots of the F9 menu without the game
docs/                     plan, this file, test checklists, brand
```

MSBuild puts all DLLs into `native/bin/Release/`. At runtime the launcher expects them in its
resource folder under `dlls/`, the backend under `backend/main.js` and Node under `node/node.exe`.

## Folders on the PC at runtime

| Path | Contents |
|---|---|
| `%APPDATA%\Niobium\config.json` | settings, profiles, builds, friends, trickshot presets (only the launcher writes it) |
| `%APPDATA%\Niobium\client.json` | settings of the in-game menu (the launcher's "In-game Menu" page and the F9 menu both read and write it) |
| `%APPDATA%\Niobium\downloads.json` | unfinished build downloads (build key and folder), so they come back as "Paused" after a restart |
| `<download folder>\.niobium-download\` | the downloader's notes for that folder: `job.json`, `manifest`, `journal.jsonl`, `progress.json` (see [Build downloader](#build-downloader-download-a-version)). It stays in the folder after the download |
| `%LOCALAPPDATA%\Niobium\backend-data\` | data of the backend (locker, profiles, `Config\config.ini`, friends list) |
| `%LOCALAPPDATA%\Niobium\server\` | everything the game server writes (`auto_hosting.json`, `loadouts`, `Maps`, `trickshots`) |
| `%LOCALAPPDATA%\Niobium\server\parkours.json` | trickshot parkours – the launcher writes it, the game server and the F9 menu read it (see below) |
| `%LOCALAPPDATA%\Niobium\logs\` | logs of the DLLs: `redirect.log` (redirect), `client-diagnostics.log` (in-game menu). The game server writes `stdout.log` in the build's `FortniteGame\Binaries\Win64` folder |
| `%LOCALAPPDATA%\Niobium\` (program files) | the installer's default install folder (Tauri, "current user" mode) is this same folder. The installer puts `Niobium.exe`, `backend\`, `dlls\` and `node\` there; an update replaces them and uninstalling deletes them, so nothing the launcher or backend writes goes into those folders |

Niobium changes nothing in the folder of a build you add yourself and nothing in other launchers'
folders. The one file outside its own folders it may touch is Fortnite's own `GameUserSettings.ini` –
and only two lines, only after you click "Reset" (see [Bubble Builds](#bubble-builds)). The build
downloader writes only into the folder you pick for a download: the build's own files and
`.niobium-download\`.

## Moving over from Vanity

`launcher/core/src/migrate.rs`, called once at every launcher start (`lib.rs`, before the config is read):

- If `%APPDATA%\Niobium\config.json` is missing and `%APPDATA%\Vanity\config.json` exists, it copies
  `config.json` and `client.json` over (`client.json` only if the Niobium one doesn't exist yet).
- If `%LOCALAPPDATA%\Niobium\server` is missing and `%LOCALAPPDATA%\Vanity\server` exists, it copies that
  folder's files over (sub-folders too, but no folder called `logs`).
- It never overwrites and never deletes anything. The old Vanity folders stay as they are.
  `%LOCALAPPDATA%\Vanity\backend` (the old locker) and `%LOCALAPPDATA%\Vanity\logs` are not copied.
- If something was copied, the live log gets one line (source "Niobium") once the window is shown, e.g.
  "Copied your settings from Vanity to Niobium (config.json and client.json, 3 server setting files).
  The old Vanity folders were left as they are."
- If `config.json` came over and has no `lastSeenVersion`, it gets `lastSeenVersion = "vanity"`. So the
  UI shows the short "What's new" card ("Vanity is now Niobium") instead of the full welcome.
- Every time the config is loaded (`Config::refresh_after_load`), each build's season and support note
  are worked out again (old German notes go away), and texts the old launcher wrote itself become English:
  profile `p-standard` "Standard" → "Default", "Normales Match auf deinem eigenen Server" → "A normal match
  on your own server", "Eigenes Profil" → "Custom profile", tags "Turnier Solo/Duos" → "Tournament
  Solo/Duos", friend network "Netzwerk" → "Other". Names you typed yourself stay.

The installer also removes an old Vanity *program* install (see [Installer](#installer)).

## Versions

Niobium starts **every version from 1.7 to 30.x** (Chapter 1 to Chapter 5 Season 3). The limits come
from the source code of the parts, not from guesses – researched in Reboot Launcher, Erbium/Magnesium,
Tellurium, ATLAS Console and LawinServer (October 2026):

| Level (`Support`) | Meaning | Shown as |
|---|---|---|
| `supported` | really tested (`TESTED` in `launcher/core/src/version.rs`, currently 19.10) | "Tested" |
| `experimental` | 1.7 to 30.x, untested – it is started, with a note in the log and on the build card | "Untested" |
| `unsupported` | older than 1.7, unreadable, or **31.00 and newer**: the game server (Erbium/Magnesium) refuses such builds itself (`SDK/Offsets.h`, limit 31.00) | "Can't start" |

Version numbers are compared with `version::parse_version_number`, which reads a one-digit minor
version the way Fortnite means it: "15.4" counts as 15.40, "19.1" as 19.10 (from 5.0 on; "4.5" stays 4.5).

What changes per version (`launcher/core/src/launchargs.rs`, `VersionRules`):

| Versions | Rule | Source |
|---|---|---|
| all | the same launch arguments as Reboot: placeholder login, `-fltoken`/`-caldera` as fixed public placeholders, helper programs paused, `-nobe`, no BattlEye | Reboot `game_metadata.dart` |
| all | the redirect is loaded right after the start; if that fails, the process is closed (never to Epic) | Tellurium |
| 1.x – 10.x | memory-leak fix of the redirect on (it reads the major version from `-niobiumversion=`); from 11 off | Reboot (`< 10`), Tellurium |
| 5.00 – 6.xx | server DLL **right** after the login (Unreal 4.21 crashes without a window otherwise); all other versions 3 s after the login | Magnesium `dllmain.cpp` |
| 20.00 and newer | in-game menu 8 s instead of 6 s after the login (engine objects need longer) | ATLAS `dllmain.cpp` |
| 33.00 and newer | no DirectX 11 – `-d3d11` is left out (not startable right now anyway) | Epic |
| 9.40 – 10.40 | the backend sends no hotfix files (on purpose in LawinServer) → no party system/XMPP, playing works | LawinServer `cloudstorage.js` |
| 23 and newer | the backend turns off network encryption (`net.AllowEncryption=0`); server and menu do the same | LawinServer, Erbium, ATLAS |
| 24.00 and newer | the menu turns off encryption; from UE 5.3 (about 27) Iris networking – server and menu agree | ATLAS, Magnesium |
| 28.00 and newer | Chapter 5 movement (tac sprint, hurdling, sliding) is off in menu and server | ATLAS, Magnesium |
| 15.30 – 16.40 | Bubble Builds (see [below](#bubble-builds)) | Epic patch notes, research |

Playlists (control pipe, like the buttons in the server window): Trios from 7.40, Tournament from 6.10,
Arena from 8.20, Zero Build and Arena Zero Build from 20.00, Playground from 4.50 (the server window shows
its button only up to 11.30). The server refuses a playlist that is too new for the build, with a note.

In-game menu per version (from the ATLAS code, names as in the "Main" tab): "Edit on release" only
below Unreal 4.24 (up to 10.40), "Disable pre-edits" below 15.20, "Reset on release" below 24.30, "Free
camera" up to 10.40; field of view, first person, target info, "Respawn after you die", the console and the
"Trickshot" tab on every version. Toggles a version doesn't have are simply hidden. "Always sprint" was
removed: it is off for everyone, and an old `"sprintByDefault": true` in client.json is ignored.

The redirect writes `%LOCALAPPDATA%\Niobium\logs\redirect.log`: which pattern matched, whether the
redirect is in place ("Ready - requests to Epic hosts now go to your own backend"), whether the
memory-leak fix ran. If a version doesn't fit, the line starts with `ERROR:` and the game is closed; the
launcher looks for that word and explains it ("The redirect doesn't fit this version").

When you have tested a version and it works, it goes into `TESTED` and shows "Tested".

## Ports

| Port | Who | What for |
|---|---|---|
| 3551/TCP (fixed) | backend | all redirected requests + `/niobium/*` |
| 80/TCP (can be changed) | backend | matchmaker WebSocket + XMPP |
| 7777/UDP (fixed) | game server | players connect to the match |

Only the matchmaker port can be changed (Settings → Network). The other two are fixed, and Settings only
shows them: the redirect DLL always sends requests to `http://127.0.0.1:3551` (`native/redirect/Options.h`),
and the server DLL takes its port from its own `auto_hosting.json` (default 7777), never from the launcher.
If `config.json` holds other values (from an older launcher), the launcher sets them back at start and
writes one note per port in the live log ("Backend port is fixed at 3551 …").

## Backend

Start: `node.exe <resources>\backend\main.js` with `NIOBIUM_BACKEND_PORT`, `NIOBIUM_MATCHMAKER_PORT`,
`NIOBIUM_BIND` (`0.0.0.0` when "Share the backend on your network" is on, otherwise `127.0.0.1`),
`NIOBIUM_DATA_DIR` (`%LOCALAPPDATA%\Niobium\backend-data`) and `NIOBIUM_GAMESERVER` (`127.0.0.1:7777`).
On the first start the backend copies its default data files into `backend-data` (existing files are never
overwritten). Vanity's backend data is not copied over.
Ready when `GET /niobium/health` → `{"ok":true,…}` (the launcher waits up to 20 s).
`POST /niobium/gameserver {ip,port}` sets the matchmaker target (joining by IP); `POST /niobium/status`
tells the backend the hosted version and playlist. Details: [`backend/README.md`](../backend/README.md).

## Starting the launcher

1. `lib.rs` runs the [Vanity migration](#moving-over-from-vanity), writes `parkours.json` (see below) and
   loads the config.
2. Two windows (`tauri.conf.json`): `main` (1280 × 800, no frame, **starts hidden**) and `splash`
   (`splash.html`, 440 × 300, centred, no frame, transparent, no shadow, not resizable, always on top,
   not in the taskbar, doesn't take focus). The splash shows the logo, "Niobium", "old seasons, new
   shine." and a loading line; it has no scripts.
3. The UI loads the config. Two animation frames later (or after 200 ms, whichever comes first) it calls
   the Tauri command `app_ready`: that shows and focuses `main` and closes the splash. Only the first call
   does anything. If the UI never calls it, Rust does it after 8 s as a safety net. In the browser demo
   (no Tauri) nothing of this happens.
4. First run (`settings.lastSeenVersion`): empty → the full-window **welcome** ("Welcome to Niobium" →
   "What should we call you?" → "Add your Fortnite build" → "You're all set"; "Skip setup" at the top);
   different from the app version → the short **"What's new"** card. Both end with `update_settings`,
   which stores the app version in `lastSeenVersion`.

## Launch sequence ("Host & Play") – how `launcher/src-tauri/src/engine.rs` does it

The UI shows seven steps: Backend, Server, Redirect, Login, Your game, Game server, Lobby.

1. **Backend:** start it, wait for `/niobium/health`, then `POST /niobium/status` (name "<player>'s server",
   hosting, playlist, version).
2. **Server:** write `parkours.json` fresh to `%LOCALAPPDATA%\Niobium\server\`. Start the server Fortnite:
   helper programs `FortniteLauncher.exe` and `FortniteClient-Win64-Shipping_EAC.exe` paused (they never
   run), then `FortniteClient-Win64-Shipping.exe` with the arguments from `launcher/core/src/launchargs.rs`
   (`-AUTH_LOGIN=<player name from Settings>@niobium.local`, `-nosplash -nosound`, `-nullrhi` when
   "Server with no graphics" is on, always `-log` and `-niobiumversion=<version>`), environment
   `OPENSSL_ia32cap=~0x20000000`. The server never gets Bubble Builds.
3. **Redirect:** load `niobium_redirect.dll` **right away**. The DLL waits by itself until Fortnite's HTTP
   part is there. If the DLL is missing or can't be loaded, the process is closed and the start stops.
4. **Login:** in the background, wait for the login line in the server log (`[UOnlineAccountCommon::ContinueLoggingIn]`
   with `(Completed)`, at most 3 minutes – then it loads anyway), wait 3 s (0 s on 5.x/6.x) and load
   `niobium_server.dll`. **The DLL waits by itself** until engine and world are ready (Magnesium does this
   in `SDK::Init`).
5. **Your game:** at the same time, start the player's Fortnite (no `-nullrhi`, with the profile's
   arguments, e.g. `-d3d11`, and with [Bubble Builds](#bubble-builds) if they are on), the redirect right
   away, and `niobium_client.dll` 6 s (8 s from 20.00) after its login.
6. **Game server:** connect to the control pipe (up to 4 minutes) and send the profile's match settings
   in this order: `bEnableCheats` = true, `playlist` (if the profile has one), `bLateGame`, `bInfiniteAmmo`,
   `bInfiniteMats`, `bPlayerBots`, `PlayerBotCount`, `PlayerBotTargetELO` (`niobium_core::bots::server_config_for`,
   see [Match rules and AI bots](#match-rules-classic-match-and-ai-bots)). The live log says "Connected to the
   server's control pipe – commands on, match settings sent", then the toast "The server is waiting for you".
   You start the match on "Match Control" ("Start match") or with START SERVER in the server window. The
   server loads the map only after that, so the bot settings arrive in time.
7. **Lobby:** as soon as the server log says `IpNetDriver … listening on port` (wait up to 30 minutes),
   the toast "Server ready" appears. Press Play in the game.

Logs: the launcher reads stdout/stderr of every instance (that's why `-log`) and shows it in the live
log. The DLLs also write to `%LOCALAPPDATA%\Niobium\logs\`. If Fortnite closes in the first 4 minutes,
the launcher checks `redirect.log` for an `ERROR` line of that process and explains it.

Each Fortnite comes with two paused helper programs (step 2). When that Fortnite closes – by itself, after a
crash or through "Stop all" – the launcher closes its helpers too (each PID only once, see
`launcher/core/src/helperprocs.rs`).

"Stop all" closes your game, the server Fortnite (each with its helpers) and the backend.

## Bubble Builds

**What:** the see-through "bubble wrap" build look of Chapter 2 Seasons 5–6. It only exists when the game
runs in **Performance Mode** (the ES3.1 renderer) on Fortnite **15.40 – 16.00**. Epic called it a bug and
removed it in 16.10; it came back briefly in 16.20 – 16.40 and was fixed in 16.50. It can't be switched
while playing – the renderer is picked when the game starts.

### Version gate (`VersionRules::for_version(..).bubble_builds`)

| Level | Versions | Note the UI shows |
|---|---|---|
| `supported` | 15.40 ≤ v < 16.10 | "The see-through 'bubble wrap' build look from Chapter 2 Seasons 5–6. Starts the game in Performance Mode (lower graphics). Applies on next launch." |
| `experimental` | v = 15.30, or 16.10 ≤ v < 16.50 | "Epic changed how builds look around this version. Your builds may look normal even with this on." |
| `unavailable` | everything else | "Only on Fortnite 15.40 – 16.00 (Chapter 2, Seasons 5–6). Try Mobile Builds in the F9 menu." |

"15.4" and "15.40" are the same here (see [Versions](#versions)). The Tauri command
`bubble_builds_support { version }` returns `{ level: "supported" | "experimental" | "unavailable", note }`.
The UI mirrors the same rules in `launcher/src/lib/bubble.ts` for the browser preview.

### What changes at launch

Setting: `settings.bubbleBuilds` (default `false`), the "Bubble Builds" card at the top of Settings.
Only when it is on **and** the version is `supported` or `experimental`:

- **Only the player's game** – never the server – gets `-FeatureLevelES31` (unless the profile already has
  `-FeatureLevelES31` or `-FeatureLevelES3_1`, any case).
- If the profile's arguments contain `-d3d12` or `-dx12`, they become `-d3d11` for this launch only. The
  profile itself is not changed.
- Never `-sm5`, no pak files, no console variables, nothing written into the build folder.
- The live log says "Bubble Builds on: starting in Performance Mode (-FeatureLevelES31)". On a version
  without Bubble Builds it says "Bubble Builds are on, but Fortnite <version> can't show them – starting
  normally".

With the setting off, the arguments are exactly the same as without the feature (tests in `launchargs.rs`).

### The GameUserSettings.ini check (`launcher/core/src/perfmode.rs`)

Fortnite may save Performance Mode as the default in
`%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini` – a file every build
shares. So:

1. Before the player's game starts with Bubble Builds, the launcher **reads** that file and remembers the two
   lines of `[D3DRHIPreference]`: `bPreferFeatureLevelES31` and `PreferredFeatureLevel`. If the file doesn't
   exist, nothing is remembered and nothing else happens.
2. After the game has closed (and 1 s more), it reads them again. If they were not ES3.1 before and are
   ES3.1 now (`bPreferFeatureLevelES31=True` or `PreferredFeatureLevel=es31`), it logs a warning and sends
   the Tauri event `bubble:ini-changed` with `{ path }`.
3. The UI asks: "Performance Mode is now saved" – "Fortnite saved Performance Mode as your default. This also
   affects your other builds. Reset it?" with **Keep** and **Reset**.
4. Only on **Reset** the UI calls the Tauri command `reset_performance_mode_ini`. It puts back exactly the
   two remembered lines (a line that wasn't there before is removed again) and changes nothing else in the
   file; encoding (UTF-8, UTF-8 with BOM, UTF-16) and line endings stay. The snapshot lives only in memory:
   after a launcher restart there is nothing to reset ("There is nothing to reset – …").

### Where it shows

- **Settings:** the "Bubble Builds" card with the switch, "New" or "Experimental" badge and a line about the
  active build ("Works on your active build, Fortnite 15.40." and so on).
- **Library:** every build card has a "Bubble Builds" row ("Supported", "Experimental" or "—", the note as a
  tooltip) and the stat "Bubble Builds ready".
- **Home:** a "Bubble Builds" chip next to the active build (only for supported/experimental versions).
- **In-game Menu page:** a read-only "Bubble Builds" row under "Graphics"; on versions that can show them
  it has an arrow button to Settings ("Change it in Settings").
- **F9 menu → Options → "Build look":** a read-only status row (see [In-game menu](#in-game-menu-client-dll)).

## Control pipe of the game server

`\\.\pipe\niobium-server` – the server creates it, the launcher is the only client. Lines with one JSON
object each (UTF-8, `\n`). Code: server `native/server/Erbium/Private/NiobiumControl.cpp`, launcher
`launcher/src-tauri/src/pipe.rs` and `engine.rs`.

Launcher → server:

| Message | Effect |
|---|---|
| `{"id":1,"cmd":"exec","text":"startaircraft"}` | runs a cheat command in the game thread – as if the **player at the host PC** (connected through 127.0.0.1; otherwise the first connected player) had typed `cheat startaircraft` (a leading `cheat ` is removed). The same checks apply as in the game. `ok:true` only means "handed over"; what the command answers, that player sees in the game. If nobody is connected yet: `ok:false` with "Nobody is in the game yet. Join the match first, then try again." |
| `{"id":2,"cmd":"config","key":"bInfiniteAmmo","value":true}` | sets a value of `FConfiguration` (keys below) |
| `{"id":3,"cmd":"startmatch"}` | like START SERVER in the server window; if the server is already running: `ok:false` ("The server is already running.") |
| `{"id":4,"cmd":"status"}` | the server answers with `status` (with the same `id`) |

Keys for `config` – exactly the ones `ApplyConfig` knows. Any other key → `ok:false` ("The server doesn't
know the setting "…"."), and the same for numbers out of range:

| Key | Value |
|---|---|
| `playlist` | text: short name (`solo`, `duo`, `trio`, `squad`, `arena_solo` …, `zb_solo` …, `playground`), asset name such as `Playlist_DefaultSolo`, or a full `/Game/` path – only before the start |
| `bLateGame`, `bEnableCheats`, `bTrickshotDetection` | true/false |
| `bEnableTrickshotTab` | true/false – **`false` resets all trickshot switches of the server**, so the launcher never sends it |
| `bAutoReloadOnWaypointTP`, `bRemoveIceOnWaypointTP`, `bDisableJumpFatigue`, `bPlayerMapIcons` | true/false (trickshot switches like in the server window) |
| `AutoGodModeType` | 0 or 1 |
| `bAutoBusStart` | true/false – after that this choice counts instead of the playlist default |
| `bMovingBus` | true/false |
| `BusStartDelay` | 0–600 (decimal) |
| `LateGameZone` | 1–12 |
| `bLateGameLongZone` | true/false |
| `bForceRespawns`, `bKeepInventory`, `bMidZoneRespawning`, `PermanentRespawn` | true/false |
| `RespawnTime` | 1–60 (seconds) |
| `RespawnHeight` | 1000–50000 |
| `bInfiniteAmmo`, `bInfiniteMats`, `bSiphon`, `bHasPickaxe` | true/false |
| `SiphonAmount` | 0–200 |
| `BotHealth` / `BotShield` | 1–1000 / 0–1000 – for target dummies (`bot <n>`) that appear after that |
| `UseCustomBotNames`, `bAutoGodMode`, `bGliderRedeploy`, `bAutoStartEvent`, `bJoinInProgress` | true/false |
| `bPlayerBots` | true/false – Fortnite's own AI bots, only on 19.10-CL-18675304 (see [AI bots](#ai-bots-1910-experimental)). Server default: false |
| `PlayerBotCount` | number of AI bots. Not refused when out of range: clamped to 1–99. Server default: 30 |
| `PlayerBotTargetELO` | skill rating of the AI bots. Clamped to 0–5000. Server default: 500 |

`bAutoRestart`, `bNoFallDamage` and `bInstantReload` do **not** exist.

The three bot keys are only taken **before "Start match"** (`FConfiguration::bReadyToStart`), because the
server decides about bots when the match starts. After that the answer is `ok:false` with "Bot settings
take effect next match."

What the launcher sends:

- When it connects, in this order: `bEnableCheats` = true, `playlist` (if the profile has one), `bLateGame`,
  `bInfiniteAmmo`, `bInfiniteMats`, `bPlayerBots`, `PlayerBotCount` (the profile's count, clamped to 1–99),
  `PlayerBotTargetELO` (from the profile's bot skill). All values come from the active profile.
- Before every `startmatch`, `bEnableCheats` = true again. Also as soon as `status.ready` changes from false to
  true (start through START SERVER or the auto-host countdown – "Toggle Auto Host" in the server window
  turns cheats off otherwise).
- From the "Match Control" page: `playlist`, `bLateGame`, `bForceRespawns`, `RespawnTime`, `bInfiniteAmmo`,
  `bInfiniteMats`, `bTrickshotDetection`, `bDisableJumpFatigue`, `bAutoReloadOnWaypointTP`, `BotHealth`,
  `BotShield`; as `exec` the commands of the buttons (`startaircraft`, `pausesafezone`, `resumesafezone`,
  `skipsafezone`, `give …`, `givetoall …`, `parkour …`, `targetbot …`, `bot <n>`, `tpbot`, `delbot`,
  `demospeed …`, `gravity …`, `god`, `s niobium o`, `w niobium`, `l 2500`, `givetraps`, `giveammo`, `regen`)
  and your own presets (a leading `cheat ` or `/` is left out).

Server → launcher:

| Message | Meaning |
|---|---|
| `{"event":"hello","fortnite":19.1,"engine":5.0}` | right after connecting: version of the build |
| `{"event":"ready","port":7777}` | the server listens, players can come (once per connection, from phase `joinable`) |
| `{"event":"reply","id":1,"ok":true,"message":"Done: startaircraft"}` | answer to a command (short English text, e.g. "Saved: bInfiniteAmmo", "Server is starting. Loading the map..."). With `ok:false` the launcher shows the text as a toast titled "Server" |
| `{"event":"status","phase":"joinable","ready":true,"players":1,"lategame":false,"playlist":"/Game/…","port":7777}` | every 2 s. `phase`: `notReady`, `ready`, `joinable`, `started`, `ended`. `ready` = the start was triggered |
| `{"event":"trickshot","player":"georg","victim":"Bot 3","meters":87}` | trickshot spotted (see below). The launcher shows the toast "TRICKSHOT! georg" with "on Bot 3 · 87 m" |
| `{"event":"matchEnd"}` | match over – launcher toast "Match over" |
| `{"event":"playerBots","state":"active","reason":""}` or `{"event":"playerBots","state":"unavailable","reason":"Bots aren't available for this copy of 19.10."}` | only when the profile has AI bots on: the server's decision for this match (see [AI bots](#ai-bots-1910-experimental)). The launcher writes "AI bots are on for this match." or "AI bots are off: <reason>" in the live log and sends the Tauri event `server:playerBots` `{ state, reason }`; for "unavailable" the UI shows the toast "AI bots are off for this match" with the reason |

Unknown commands → `reply` with `ok:false` ("Unknown command "…"."). The pipe threads never touch game
objects; they put commands in a queue that runs in the game thread.

### Who may send cheat commands?

Everything the F9 menu and the launcher send goes through Magnesium's `ServerCheat`
(`native/server/FortniteGame/Private/FortPlayerControllerAthena.cpp`). The server only runs a command when
`bEnableCheats` is on – or when the player comes from the same PC (127.0.0.1) and the playlist isn't
"Only Up". Otherwise it answers "Commands are currently disabled for this session." That's why the launcher
turns `bEnableCheats` on (see above). It's your own server, so every player on it may send commands.

## Niobium commands in the game server (`parkour`, `targetbot`)

Code: `native/server/Erbium/Private/NiobiumParkour.cpp` (Niobium's own code), hooked into `ServerCheat`
(marked with `NIOBIUM:`). Typed as `cheat parkour …` (console, F9 buttons) or sent through the pipe as
`exec`. Everything runs in the game thread and errors are caught ("Something went wrong. Please try
again."). The answers are English `ClientMessage`s with "[Niobium] " in front, sent to the player who sent
the command. Without a character (e.g. on the bus or eliminated): "You need your character for this. Wait
until you're in the game."

| Command | Effect |
|---|---|
| `parkour <id>` | builds the parkour from `parkours.json` around you: clear the old Niobium parkour → round your view direction to 90° → start platform `height` m above your feet → jump objects (with their own platform if given) → target bots, each on its own platform → put you on the start (looking forward) → give the first sniper from `snipers` the version knows. If you still stand on the old start, it builds from the old ground height (otherwise every new parkour would end up higher). Answer: ""First Jump" is ready! Built: 10 floors, 1 jump objects, 1 target bots." |
| `parkour retry` | back to the start, looking forward, full health and shield, weapons reloaded; eliminated target bots of this parkour come back ("Back at the start of "…". Full health, weapons reloaded. …") |
| `parkour clear` | removes all platforms, objects and target bots – also those from `targetbot` ("Removed N pieces and M target bots." or "Nothing to remove.") |
| `parkour sniper` | only gives the sniper |
| `parkour list` | shows all ids |
| `parkour` | short help |
| `targetbot <health> <metres>` | one standing bot exactly in your view direction, `<metres>` in front of you at your foot height, on a platform. Without numbers: 50 health, 30 m. Limits: 1–500 health, 5–200 m ("Target bot is 30 m in front of you (50 health). Remove it: parkour clear") |

Details:

- Target bots are made with the existing command `bot X Y Z`. Only for this one bot `BotHealth` = health
  and `BotShield` = 0, then the old values again. The usual messages of `bot` stay quiet for them.
  `delbot` removes target bots like all other bots.
- Platforms: `woodfloor`, built like when a trickshot preset is loaded. They belong to the player and are
  firmly supported, so they don't collapse in the air.
- **Assumption about the floor origin:** a Fortnite floor tile has its origin at walking height in the middle
  of its left edge (local −Y), not in the centre. That's why `SpawnFloorTile` places it shifted half a tile
  (256 cm) to the left (`kFloorOriginLeftOfCenterCm`). Evidence: the preset
  `native/server/Erbium/Resources/TrickshotPresets/BlockWinner_15Bandit.json` (real builds from 10.40). On other
  versions this is unchecked – if a platform is half off in a test, this is the place to look.
- A new world (new match) → everything remembered (start, built pieces, target bots) is forgotten.
- Other answers you may see: "Not in this version (left out): Trampoline.", "N jump objects couldn't be
  placed.", "N target bots couldn't spawn.", "None of the listed sniper rifles exist in this version.",
  "This version can't build floors, so this parkour doesn't work here.", "The parkour list is missing.
  Please start the game from the Niobium launcher."

## Trickshot parkours (`parkours.json`)

One file for everything: `launcher/src/data/parkours.json`. It is built into the launcher (Rust:
`include_str!` in `launcher/core/src/parkours.rs`, UI: `launcher/src/lib/parkours.ts`). The launcher writes it
at its own start and right before every server start to `%LOCALAPPDATA%\Niobium\server\parkours.json` – fresh
every time, safely through a helper file that is then renamed. If that fails, it only shows in the log.

- Game server: reads the file again for every `parkour …` (at most 2 MB, UTF-8, BOM allowed).
- F9 menu: looks at the file's change time at most every 2 s and then reads it again. It only needs `id`,
  `name`, `description` and `level`. If the file is broken, the last good list stays.

The 9 courses: `first-jump` "First Jump", `geyser-shot` "Geyser Shot", `trampoline-stairs` "Trampoline
Stairs", `double-target` "Double Target", `spin-360` "360 Spin", `long-shot` "Long Shot", `jump-chain`
"Jump Chain", `ground-course` "Ground Course", `free-practice` "Free Practice". Kinds: `trampoline`
"Trampoline", `launcher` "Launcher", `sideLauncher` "Side launcher".

```json
{
  "version": 1,
  "kinds": {
    "trampoline": { "label": "Trampoline", "summon": ["tire", "umbrella"] }
  },
  "snipers": ["reaper_sr", "hunterbolt_sr", "heavy_sr", "bolt_sr", "hunting_sr", "semi"],
  "parkours": [
    {
      "id": "first-jump",
      "name": "First Jump",
      "level": 1,
      "description": "Run over the trampoline, fly up and hit the bot in front of you.",
      "height": 25,
      "platform": [3, 3],
      "elements": [ { "kind": "trampoline", "at": [9, 0, -1] } ],
      "bots": [ { "at": [40, 0, 0], "hp": 50 } ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `kinds.<kind>.label` | name the player sees – e.g. in "Not in this version (left out): Trampoline." |
| `kinds.<kind>.summon` | object names like for `cheat summon` (short name from `native/server/Erbium/Private/Misc.cpp` or a class path). The server takes the first one the version knows; if it knows none, the piece is left out |
| `snipers` | item names like for `cheat give`; the first one the version knows goes into the inventory |
| `id` | only a–z, 0–9 and "-", at most 40 characters; not `retry`, `clear`, `sniper`, `list` |
| `level` | 1–3 (easy, medium, hard) |
| `height` | the start is this many metres above your feet (0 = on the ground) |
| `platform` | `[width, depth]` in floor tiles of 5.12 m each, 0–9 each; `[0, 0]` = no platform |
| `elements[].at`, `bots[].at` | `[forward, right, up]` in metres from the start point; forward = view direction (rounded to 90°), up counts from the start height |
| `elements[].platform` | optional; without it there is no platform under the object |
| `bots[].hp` | 1–500 health (no shield) |
| `bots[].platform` | optional; without it a platform (`[1, 1]`) under the bot |

`validate` in `launcher/core/src/parkours.rs` checks the limits (`cargo test` runs it on the real file): at
most 64 parkours (the F9 menu doesn't show more), 48 pieces and 12 bots per parkour, at most 1000 m per
direction, `height` 0–300, and no piece and no bot closer than 3 m (horizontally) to the start point – the
player lands there. The server doesn't check this again: it silently cuts whatever is over its limits and
builds the rest.

## Trickshot detection

`NiobiumParkour::OnElimination` is called from `ClientOnPawnDied` for every elimination (bots too, respawn
modes too). It's a trickshot when the shooter is a real player (not a bot, a real connection, not
themselves) and their character is in the air right now (jumping, falling or skydiving). Then:

- every player gets the `ClientMessage` "[Niobium] TRICKSHOT! <name> – <metres> m" (en dash; metres =
  distance from shooter to victim). The F9 menu turns it into the banner (see below);
- the launcher gets `{"event":"trickshot","player":…,"victim":…,"meters":N}`;
- the same victim is reported only once within 1.5 s.

On/off: pipe key `bTrickshotDetection` (default: on; in the launcher "Match Control" → "Trickshot" →
"Trickshot banner" → "Banner on"). This is separate from the trickshot tab in the server window.

## In-game menu (client DLL)

- On load it reads `%APPDATA%\Niobium\client.json` and writes changes back. Format (taken over from ATLAS
  Console; the launcher writes the same): `{ "hotkey": 120, "joinHotkey": 116, "consoleMode": 0,
  "preferences": { "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true, "respawnsEnabled": true,
  "firstPerson": false, "sprintByDefault": false, "inGameFog": true, "mobileBuilds": false, "slashKey": true,
  "saveTogglePreferences": true }, "commands": [], "macros": [] }` (keys = Windows VK codes; `consoleMode` 0 =
  Niobium console, 1 = original Unreal console). `sprintByDefault` stays in the file only so old files still
  load: "Always sprint" was removed, the launcher always writes `false` and the menu ignores the key.
  Trickshot presets are **not** in here but in the launcher's `config.json` (`trickshotPresets`). You make them
  on the "In-game Menu" page → "Trickshot presets" and run them on "Match Control" → "Trickshot" → "Your
  presets" (command by command through the pipe).
- Everything that touches game objects runs in the game thread. Own threads only put commands in a queue.
- `imgui.ini` is never written (`io.IniFilename = nullptr`), so nothing lands in the game folder.
- Window title "Niobium | Menu", all texts in plain English (`native/client/ATLAS/Private/GUI.cpp`), brand
  colours (violet accent `#7A3CFF`). Tabs:

| Tab | Contents |
|---|---|
| Main | Join a server, Editing, Graphics (Mobile Builds, In-game fog, Simpler textures), Movement, Field of view, Respawn, Other |
| Commands | your own commands and command chains, each with its own key |
| Options | Build look (Bubble Builds status), General (Which console?, Open the console with the … key, Remember my settings), Keys (Change menu key, Change join key, Reset everything) |
| Trickshot | Niobium: Load a parkour, Target bot, Gear, Practice (`ATLAS/Private/NiobiumTrickshotTab.cpp`) |
| Credits | names Erbium and ATLAS Console; the licence line "Niobium is based on ATLAS Console by cipherfps, ralz and contributors." |

- Toggles a version doesn't have are hidden (see [Versions](#versions)).
- Console: **F8**. In the Niobium console also `VK_OEM_3` (US keyboard `~`, German keyboard Ö) and – when
  "Open the console with the … key" is on – `VK_OEM_2` (US `/`, German `#`); then it opens with "/" already typed.
- Host features are sent by the menu as `cheat <command>` to the server (see "Who may send cheat commands?").

**Bubble Builds status row** (Options → "Build look", read-only): it looks for `-FeatureLevelES31` (or
`-FeatureLevelES3_1`) in `GetCommandLineW()` – case-insensitive, whole switch only – and uses the version the
game reports (`-niobiumversion=` from the launcher as a fallback and for the label). Same version gate as
`VersionRules`. It shows "Bubble Builds: On (set in the launcher)", "Bubble Builds: Off – turn it on in the
launcher, then restart the game." or "Bubble Builds: Not available on <version>", with an amber
"Experimental" badge where it applies and the hint "… Can't be changed while playing." The "Mobile Builds"
toggle in "Main" works on every version, right away.

The buttons in the "Trickshot" tab:

| Button | Command |
|---|---|
| Parkour card → Load | `cheat parkour <id>` |
| Start over / Clear everything | `cheat parkour retry` / `cheat parkour clear` |
| Place bot in front of me | `cheat targetbot <health> <metres>` (sliders "Health" 1–200 and "Distance" 5–100 m; start 50 / 30) |
| Remove all bots / Bring bots to me | `cheat delbot` / `cheat tpbot` |
| Give sniper / Give launch pads | `cheat parkour sniper` / `cheat givetraps` |
| Refill ammo / Refill health | `cheat giveammo` / `cheat regen` |
| Save spot / Back to spot | `cheat s niobium o` / `cheat w niobium` (the same waypoint name as on "Match Control", so a spot saved in one place works from the other) |
| Launch me up | `cheat l 2500` |
| Slow motion (toggle) | on: `cheat demospeed 0.5`, off: `cheat demospeed 1` |
| Low gravity / Normal gravity | `cheat gravity 0.4` / `cheat gravity 1` |
| Invincible on/off | `cheat god` |
| Pause storm / Resume storm (toggle) | `cheat pausesafezone` / `cheat resumesafezone` |

After a click, the line under the section (on "Load": in the card) shows "Sent: …" for a moment – or "Can't do
that right now – are you in a match?" when the command couldn't be sent. The server's real answer is in the
console (setting "Niobium console"). The menu remembers "Slow motion" and "Storm" itself; in a new match they
go back to "off". In the lobby a hint at the top says the buttons only work in a match ("You're still in the
lobby. Start a match first – then these buttons work.").

**Trickshot banner:** `Client.cpp` looks at every `ClientMessage` (in both console modes). If it starts with
`[Niobium] TRICKSHOT`, `NiobiumToast_Draw` (every frame, also with the menu closed) shows a big gold
"TRICKSHOT!" at the top centre and below it the rest of the first line (name and metres), for 3.5 s. The
message itself still goes to the console unchanged.

## Build downloader ("Download a version")

Library → **Download a version** (a button at the top next to "Add a build", and a tile under the "Add a
build" tile). It downloads an old Fortnite build and adds it to the Library like "Add a build" does. Only
builds that Epic still has **completely** and that Niobium's game server is meant to run are offered.

Code: `launcher/core/src/epic/` (formats, checks, the download engine – tested with `cargo test`),
`launcher/src-tauri/src/download/` (commands, HTTP, Windows drive facts), UI `launcher/src/pages/DownloadPage.tsx`,
`launcher/src/components/download/`, `launcher/src/lib/downloads.ts`. The manifest and chunk formats are
ported from Legendary (GPL-3.0-or-later, see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)).

### Where the files come from

- **The manifest** (a small file that lists a build's files and the pieces they are made of, 2.9–34 MB):
  Epic's CDN refuses old manifests without a token (answer 403), so it comes from the public GitHub archive
  `polynite/fn-releases`
  (`https://raw.githubusercontent.com/polynite/fn-releases/master/manifests/<id>.manifest`). Fallback:
  `VastBlast/FortniteManifestArchive` (`…/main/Fortnite/Windows/<id>.manifest`), only for the 15 builds
  where that file is byte-identical (not for 18.00-CL-17468642 and 18.20-CL-17792290). Every manifest is
  **pinned by its SHA-1** in `build-catalog.json`; any other file is refused (`MANIFEST_MISMATCH`). The
  Tectors/FortXD archive is never used (its files are damaged).
- **Every game byte** (the "chunks") comes only from Epic's official CDN hosts, path `/Builds/Fortnite/CloudDir/`,
  over HTTPS, without a login, tried in this order and rotated on every retry:
  `fastly-download.epicgames.com`, `epicgames-download1.akamaized.net`, `download.epicgames.com`,
  `cloudflare.epicgamescdn.com` (`epic/cdn.rs`, `CDN_HOSTS`). Redirects are never followed, so no other host
  is ever contacted. Niobium never uses re-uploads or mirrors of builds.
- On Windows, HTTPS uses Windows' own TLS and certificate store (ureq with native-tls).

### What it offers (`launcher/core/data/build-catalog.json`, checked on 26 Oct 2026)

17 builds. All carry the badge **Experimental** (only versions in `TESTED` get "Tested", and 19.10 can't be
downloaded). The sizes are what the UI shows (decimal GB); "free space" is on disk + 2 GiB.

| Season | Builds | Download | On disk | Note on the card |
|---|---|---|---|---|
| Chapter 2 Season 3 | 13.30-CL-13884634; 13.40-CL-14008768, -14036559, -14113327 | 45.1 / 46.1 GB | 97.2 / 99.5 GB | "Very big: about 97 GB on disk" / "about 100 GB" ("Epic made builds smaller from 14.40 on") |
| Chapter 2 Season 5 | 15.00-CL-14826719, -14835335 | 32.7 GB | 36.2 GB | – |
| Chapter 2 Season 6 | 16.00-CL-15685441 | 35.1 GB | 38.9 GB | "Has the Chapter 2 'bubble wrap' build look (Bubble Builds)." |
| Chapter 2 Season 7 | 17.21-CL-16949556, -16967001; 17.50-CL-17388565 | 38.4–40.3 GB | 42.6–44.5 GB | – |
| Chapter 2 Season 8 | 18.00-CL-17468642; 18.10-CL-17619277, -17661844; 18.20-CL-17745267, -17792290; 18.21-CL-17811397; 18.30-CL-17882303 | 40.1–41.1 GB | 44.2–45.4 GB | – |

Nothing from 31.00 on is ever offered: the catalog is filtered by `SERVER_MAX_EXCLUSIVE` (the game server's
limit), so the live game can never show up (test `new_builds_are_filtered`).

### Seasons that can't be downloaded, and why

| Seasons | Badge | Why |
|---|---|---|
| All of Chapter 1 (1.x–10.x), Chapter 2 Seasons 1, 2 and 4 (11.x, 12.x, 14.x), **Chapter 3 Seasons 1 and 2 (19.x, 20.x)** | **Not available from Epic** | Epic has deleted part of the chunks of every build of these seasons that was checked, so no download can get one complete |
| Chapter 3 Seasons 3 and 4 (21.x, 22.x), all of Chapter 4 (23.x–27.x), Chapter 5 Seasons 1–3 (28.x–30.x) | **Not offered yet** | Niobium's game server isn't tested on these yet. Epic still has many of these builds; they can come later |

The text above the cards (once per reason, Rust `NOTE_NOT_FROM_EPIC` / `NOTE_NOT_OFFERED_YET`):
"Epic has deleted part of the files for this season, so no download can get it complete. If you already have
this version on your PC, it keeps working. Add it with 'Add a build'." and "Niobium's game server isn't ready
for this season yet, so it isn't offered." The cards themselves say "Epic deleted some of its files." or "The
game server isn't ready for it yet."

**19.10 (Chapter 3 Season 1):** 19.10-CL-18675304 needs 46,040 chunks. 11,655 of them (25.3 %) are gone
from all four hosts (404). That breaks 631 of its 751 files, among them `FortniteClient-Win64-Shipping.exe`
(191 of its 192 chunks are gone). None of the 12 builds of Chapter 3 Season 1 (19.00–19.40) was complete.
So no download can get 19.10, wherever the manifest comes from. A 19.10 you already have keeps working;
if it is in your Library, the Season 1 card says "Your 19.10 keeps working." The test
`builtin_catalog_is_valid` makes sure 19.10 never gets into the catalog.

Inside the offered seasons, builds that were not complete in the check are left out too (e.g. 18.40).

### Steps of one download (`download/mod.rs` `job_steps`, `epic/install.rs`)

The UI shows four steps: **Check at Epic**, **Download**, **Check files**, **Add to Library**.

1. **File list:** the copy saved in the folder by an earlier run (if its SHA-1 still matches), or a fresh
   download from the archive (3 tries per archive). SHA-1 check, then parse (binary or JSON format; encrypted
   manifests and format 22 and newer are refused). The version and CL inside must match the catalog entry.
2. **Folder checks** (`epic/folder.rs`; the drive facts come from the Windows API in `download/disk.rs`), in
   this order: path longer than 100 characters → `PATH_TOO_LONG`; inside Niobium's own install folder →
   `OWN_FOLDER`; under Program Files or Windows → `WRITE_FAILED`; under OneDrive → `ONEDRIVE`; a network drive
   or `\\server\share` → `NETWORK_DRIVE`; FAT, FAT16 or FAT32 → `FAT32`; other files in the folder (and no
   unfinished download of this build) or an unfinished download of another build → `NOT_EMPTY`; less free
   space than the bytes still to write + 2 GiB → `NOT_ENOUGH_SPACE`. Then a write test (the folder is created,
   `.niobium-write-test` is written and deleted). `download_start` already runs the same checks with the full
   size, so a bad folder is refused before the download starts, and its text shows under the folder field.
   Default folder: `<fixed drive with the most free space, no FAT>:\Niobium\Builds\<version>-CL-<cl>`.
3. **Check at Epic:** a HEAD request for every chunk still needed, 32 at a time ("Checking that Epic still has
   every file… (about 1 min)"). The first chunk Epic no longer has (404 from two hosts) stops everything with
   `CHUNKS_MISSING` **before a single byte is written**; 403 from two hosts → `EPIC_BLOCKED`. If it stops
   here, the empty folders it made are removed again.
4. **Download:** 16 HTTP workers and 4 file writers. Each writer writes one file at a time, strictly in order,
   into `<file>.part`, with up to 8 chunks fetched ahead. Every chunk is checked against the manifest's SHA-1
   (or Epic's rolling hash when the manifest has no SHA-1). Every request: up to 7 tries over the hosts,
   waiting 0.5, 1, 2, 4, 8, 8 s; connect timeout 10 s; it gives up when no data came for 30 s (a slow line
   that keeps sending is fine); at most 15 minutes per chunk. A chunk that two files share is simply
   downloaded twice (about 1 % extra).
   - Every 64 MiB of a file: flush to disk and note the position in `progress.json`.
   - At the end of a file: check its SHA-1, rename `.part` to the real name, add a line to `journal.jsonl`.
     Wrong SHA-1: the file is downloaded once more (live log warning "A downloaded file was damaged and is
     being downloaded again. (<file>)"); wrong again → `VERIFY_FAILED`.
5. **Check files:** every file is there with the right size and is in the journal.
6. **Add to Library:** `version::detect_build` on the folder. Version and CL must match the catalog entry
   (otherwise `IMPORT_FAILED`); then the same as "Add a build". Live log "Download of 18.30 finished and added
   to your Library", toast "18.30 is ready" – "18.30 is ready. Press Play.", event `download:done`. The **Play**
   button on the card uses a profile of that build (or makes a "Classic match" profile called "Fortnite 18.30"),
   makes it active and goes to Home.

### Pause, resume, cancel, closing Niobium

- **Pause:** every worker stops between chunks; a chunk still arriving is dropped (the body is read in 64 KB
  pieces and Pause is checked between them). Everything written stays. A connection that sends nothing at all
  can hold Pause until its 30 s timeout.
- **Resume** runs all steps again in the same folder: the saved manifest is used, finished files (in the
  journal and with the right size) are skipped, a half-written `.part` continues from its last noted position,
  and "Check at Epic" only covers the chunks still needed. Starting the same build again into a folder that
  has its unfinished download does the same.
- Only **one download runs at a time** ("Another version is downloading. Pause it first, then start this one.").
- Unfinished downloads (running, paused, stopped by an error) are kept in `%APPDATA%\Niobium\downloads.json`.
  Closing Niobium pauses a running download ("Close Niobium?" lists it as "Download (18.30)"); after the next
  start it is back as **Paused**.
- **Cancel** asks "Delete the downloaded files?"; **Keep files** is the default. **Delete files** removes only the
  build's own files (finished and `.part`), `.niobium-download\` and the folders that are empty afterwards –
  nothing else. A finished build is never deleted from here.

### Error codes and texts (`epic/errors.rs`, shown as they are)

| Code | Text |
|---|---|
| `MANIFEST_UNAVAILABLE` | "Niobium couldn't get the file list for this version. Check your internet connection and try again later." |
| `MANIFEST_MISMATCH` | "The file list for this version isn't what Niobium expects, so nothing was downloaded. Please update Niobium." |
| `CHUNKS_MISSING` | "Epic no longer has all the files for this version, so it can't be downloaded. Nothing was downloaded. Pick another version, or add a copy you already have with 'Add a build'." |
| `EPIC_BLOCKED` | "Epic's download servers refused the download. Nothing is wrong with your PC. Please try again later." |
| `NETWORK` | "The connection to Epic's download servers dropped. Press Resume and Niobium continues where it stopped." |
| `NOT_ENOUGH_SPACE` | "There isn't enough free space on drive D:. This version needs 47.5 GB and 12.3 GB is free. Free up space or pick another folder." ("this drive" when the letter is unknown) |
| `FAT32` | "Drive E: can't hold files bigger than 4 GB (FAT32). Pick a folder on another drive." |
| `ONEDRIVE` | "This folder is synced by OneDrive. Pick a folder outside OneDrive, or it will try to upload about 40 GB." |
| `NOT_EMPTY` | "This folder already has other files in it. Pick an empty folder." |
| `WRITE_FAILED` | "Niobium can't write to this folder. Pick another one (not inside Program Files)." |
| `VERIFY_FAILED` | "A downloaded file was still damaged. Please try again later." |
| `IMPORT_FAILED` | "The download finished, but Niobium couldn't recognise the version in the folder." |
| `NETWORK_DRIVE` | "This folder is on a network drive. Pick a folder on a drive inside your PC." |
| `PATH_TOO_LONG` | "This folder's path is too long. Pick a shorter one, like D:\Niobium\Builds." |
| `OWN_FOLDER` | "This folder belongs to Niobium itself. Pick another one." |
| `ALREADY_RUNNING` | "This version is already downloading." |
| `ANOTHER_RUNNING` | "Another version is downloading. Pause it first, then start this one." |
| `UNKNOWN_BUILD` | "Niobium can't download this version." |

When files of the build are already in the folder (it has a journal), three codes use other texts
(`after_files_written`; `filesKept: true` in the event):

- `CHUNKS_MISSING`: "Epic no longer has all the files for this version, so the download can't be finished.
  Remove it to free the space, then pick another version or add a copy you already have with 'Add a build'."
- `MANIFEST_MISMATCH`: "The file list for this version isn't what Niobium expects, so the download can't go on.
  Please update Niobium."
- `WRITE_FAILED`: "Niobium couldn't write to the download folder. Free up space on the drive or close programs
  that use the folder, then press Resume."

The error card shows a short title (`errorTitle` in `downloads.ts`) above the text and the buttons that fit:
Resume, Try again, Pick another folder, Open folder, and Close (nothing on disk) or Remove (asks Delete/Keep).

### Tauri API

| Command | Answer |
|---|---|
| `catalog_list` | `{ checkedOn, chapters: [{ chapter, label, seasons: [{ season, label, versions, status: "available" \| "notFromEpic" \| "notOfferedYet", note, builds: [{ key, version, cl, downloadBytes, installedBytes, badge: "tested" \| "experimental", note }] }] }] }` |
| `download_start { key, folder }` | starts; refuses with `{ code, message }` (folder problems, another download running) |
| `download_pause { key }` | stops between chunks (refuses with a text) |
| `download_resume { key }` | continues in the same folder (refuses with `{ code, message }`) |
| `download_cancel { key, deleteFiles }` | stops and forgets the download; `deleteFiles` = delete what was downloaded |
| `download_status` | `[{ key, version, cl, folder, state: "running" \| "paused" \| "error" \| "done" \| "cancelled", progress, error, buildId, filesKept }]` |
| `default_download_folder { key }` | the default folder (text) |

| Event | Payload |
|---|---|
| `download:progress` | every 500 ms while running: `{ key, phase: "checking" \| "downloading" \| "verifying" \| "importing", bytesDone, bytesTotal, filesDone, filesTotal, speedBps (5 s average, only while downloading), etaSecs, currentFile }` |
| `download:done` | `{ key, buildId }` |
| `download:error` | `{ key, code, message, filesKept }` |
| `download:state` | `{ key, state }` whenever a download starts, pauses, stops, finishes or is cancelled |

## Match rules ("Classic match") and AI bots

### Match rules ("Classic match")

New fields of a profile (`launcher/core/src/profiles.rs`, camelCase in `config.json`; old configs load with
these defaults):

| Field | Default | Meaning |
|---|---|---|
| `lategame` (already there) | false | Lategame mode |
| `infiniteAmmo` | false | infinite ammo |
| `infiniteMats` | false | infinite building materials |
| `bots` | false | play with AI bots (only possible on 19.10-CL-18675304) |
| `botCount` | 30 | number of AI bots, 1–99 (clamped when sent) |
| `botSkill` | "easy" | "easy", "normal" or "hard" (any other value loads as "easy") |

All three rules off = **Classic match** ("like back then"). The profile editor shows a gold "Classic match"
badge (or "Custom", with a "Classic" button that switches all three off) and the line "Classic match = like
back then: full map, normal ammo and materials." New profiles, the "Default" profile made with the first build
and the profile the downloader's Play button makes all start as Classic match. A profile card shows "Rules:
Classic match" or what is on (e.g. "Lategame · Infinite ammo").

**Change for old profiles:** before, the launcher sent only `bLateGame`, so ammo and materials were always
infinite (the server's own default). Now it sends `bInfiniteAmmo` and `bInfiniteMats` too, and an old profile
loads them as off. So an old profile now plays with normal ammo and materials; Lategame stays as it was.
On "Match Control" → "Game" → "Infinite", the two switches start with the active profile's values and still
change them for the running match.

### AI bots (19.10, experimental)

Fortnite's own AI players ("Phoebe", the game's `AthenaAIServicePlayerBots` service), ported from Artemis
(commit 48dba08, GPL-3.0) into `native/server/FortniteGame/Private/PlayerBots_19_10.cpp` (its header maps
every part to its Artemis source). **Only on 19.10-CL-18675304.** These are not the target dummies (Match
Control → "Target dummies", command `bot <n>`), which stand still and work on every version.

**Launcher:**

- Profile editor, section "AI bots" with the badge "Experimental · 19.10 only": switch "Play with AI bots",
  slider "Number of bots" (1–99), "Bot skill" **Easy / Normal / Hard**.
- Skill → `PlayerBotTargetELO` (`BotSkill::target_elo` in `launcher/core/src/bots.rs`, unit-tested): Easy 500,
  Normal 1000, Hard 2000. These are starting values, to be tuned in game (Artemis falls back to 1100).
- `bots_support { version, cl }` → `{ level: "experimental" | "unavailable", note }`: "experimental" only for 19.10
  with CL 18675304 ("Experimental, 19.10 only. Bots may not loot, fight or build well yet."); 1.7–10.40: "AI bots
  don't exist in this Fortnite version."; everything else (also 19.10 with another or unknown CL): "AI bots aren't
  available for this version yet." The editor then greys the section out, shows "Fortnite <version>: <note>" and
  saves `bots: false`. The UI mirrors the rule in `launcher/src/lib/bots.ts`; Rust's answer wins.
- "Match Control" → "Game": the start card shows the chip "AI bots 30 · Easy" ("Off" when the server said no).
- The settings go to the server when the control pipe connects (see [Launch sequence](#launch-sequence-host--play--how-launchersrc-taurisrcenginers-does-it)).
  A change in the profile counts from the next Host & Play.

**Server** (all of it does nothing while `bPlayerBots` is off – no hooks, no patches, no event):

1. **Gate** (`Gate`, runs in `Main()` after "Start match", before the map loads). All of these must pass:
   - the version is 19.10;
   - the CL read from the engine's build string is exactly 18675304 (and was really read from the game);
   - `FortniteClient-Win64-Shipping.exe` is 198,580,704 bytes (Epic's 19.10 file);
   - the reflected layouts of the classes and structs used match Artemis' 19.10 dump;
   - byte checks at every address: each hooked function starts at an unwind-table entry right after the end
     of another function; the patched LEA is a RIP-relative LEA inside a game function that loads such a start;
     the bot limit console variable holds a sane number (-1 to 1000).

   Then the hooks are installed: "[PlayerBots] checks passed for 19.10 CL 18675304, hooks installed; 30 bots,
   ELO 500". If anything fails: "[PlayerBots] disabled: <why>" and the event `playerBots` "unavailable" with
   "Bots aren't available for this copy of 19.10." (other versions: "AI bots don't exist in this Fortnite
   version." below 11.00, else "AI bots aren't available for this version yet."). The match then runs without
   AI bots.
2. **Playlist** (`SetupPlaylist` in `FortGameMode.cpp`, or `FinishWorldInitialization` if that didn't run): the
   game mode gets the playlist's AI settings with `AthenaAIServicePlayerBots` in AI service slot 2:
   "[PlayerBots] service set up, 30 bots, ELO 500 (playlist …)" and the event "active". A playlist without AI
   settings: "unavailable" with "Bots aren't available in this playlist."
3. **Bot service:** the game's `InitializeMMRInfos` is stripped, so its LEA is pointed at our version: it picks
   the row of `PhoebeMMRSpawning` whose MMR bracket holds our ELO, and every bot gets our ELO as its skill (a
   fallback spawn entry when there is no table or bracket). Count = `PlayerBotCount`, at most the playlist's
   max players minus the humans. `WaitForMatchAssignmentReady` runs without a backend wait. Each spawned bot
   goes into the team and squad lists and `GameMode->AliveBots`. Navigation data: `bAutoSpawnMissingNavData`.
   POI and foundation caches once warmup runs. A bot whose outfit is empty gets one of the default outfits.
   In `SpawnDefaultPawnFor`, AI bots only get their pawn (none of the player set-up).
4. **Bus:** when the aircraft phase starts, every bot gets on the bus ("[PlayerBots] N bots got on the bus");
   their bus jump goes through the game's own code.
5. **Clean-up** every 500 ms: destroyed bots leave `AliveBots`; from the bus on, dying bots too (in warmup
   they come back). "[PlayerBots] all bots are out" when the last one goes. The win, kill and targeting code
   reads `AliveBots`.

Not ported on purpose: Artemis' `KickPlayer` / `ValidatePlayer` / `StoreGameSessionID` patches, its engine
rewrites, its backend, and its storm, inventory and loadout code (Niobium has its own).

**Log lines:** every `[PlayerBots] …` line goes to the server's stdout handle, so it shows in the live log
(source Server, category `bots`, without the tag). Lines with "disabled", "failed", "fail:", "unavailable", "not
available" or "error" are warnings (`logparse.rs`, `tagged_line`). Other lines you may see: "bot service started",
"MMR bracket … to …, … bot types, ELO …", "spawn amount: … bots (max players …, humans …)", "1 bots spawned" and
every 10th, "… default outfits for bots", "cached … POI volumes and … foundations", "Error: …".

## Pickups, floor loot and the loot log

### Picking up items (`FortPlayerPawnAthena.cpp`, `FortPlayerControllerAthena.cpp` `InternalPickup`)

The swap request (`bTryPickupSwap`) is only set when a swap is possible: a player (not an AI bot) with an
inventory, a slot weapon in hand (not the pickaxe), a pickup that goes into a slot, all 5 slots full, and no
stack of that item with room left. The pickup that finishes always clears it. Before, the request stayed set,
so later ammo and materials dropped back to the ground, a weapon dropped back while you held the pickaxe even
with free slots ("can't pick up"), and your held weapon was swapped out even with free slots.

| Situation | What happens now |
|---|---|
| a free slot | the item goes into it |
| all 5 slots full, a weapon in your hand | swap: your weapon is dropped in front of you, the new one goes in your hand |
| all 5 slots full, the pickaxe in your hand | the item goes back on the ground |
| a stack of that item with room left | the stack is topped up, no swap |
| ammo, materials | always go into the inventory |

Nothing is lost any more: your held weapon is only removed once it is on the ground, and anything that can't be
added (full inventory, a failed give, stack overflow, no character) goes back on the ground. This also covers
items given through `K2_GiveItemToPlayer` and mutators. AI bots keep the game's own pickup code.

Related hardening: the `(AFortPlayerControllerAthena*)Controller` casts in `FortPlayerPawnAthena.cpp`,
`BuildingSMActor.cpp`, `FortAthenaCreativePortal.cpp` and the held-object code of
`FortPlayerControllerAthena.cpp` are now `Cast<>()` with null checks, the killer pawn of an elimination is
`Cast<AFortPlayerPawnAthena>()` (null for an NPC killer), and unequipping a weapon no longer touches a missing
player controller (`FortInventory.cpp`, `RemoveWeaponAbilities`). AI bots are no player controllers.

### Floor loot (`FortLootPackage.cpp`, `SpawnFloorLootForContainer`)

Before, on 11.00 and newer the floor loot spots (`Tiered_Athena_FloorLoot_Warmup_C`, `Tiered_Athena_FloorLoot_01_C`)
were removed without spawning anything (inherited from Erbium). Now, on 11.00+ builds whose game mode has no
`OnPlaylistLootTablesAppliedDelegate` (19.x, e.g. 19.10), every spot is rolled once with Niobium's loot tables
right after the loot setup, then removed. A spot that was already rolled – also an empty "nothing here" roll – is
not rolled again, so a few empty spots are normal. Builds that still have that event keep the old path (the game
spawns its floor loot itself); below 11.00 nothing changed.

The server writes one line per spot type into `stdout.log` (not the live log):
`[FloorLoot] Tiered_Athena_FloorLoot_01_C: N spots, N filled now, N empty now, N already rolled`.

### Loot log (`FortGameMode.cpp`, `ReportLootPool`)

Once per match, right after the loot setup (every version), the server writes these lines to its stdout handle,
so they show in the live log (source Server, category `loot`, without the tag):

- `[NiobiumLoot] features: <comma list>` – the game features whose loot tables fed the pool, sorted ("none" if
  none). These are the loaded game features, not only the active ones;
- `[NiobiumLoot] items: <count>` – how many different items have a chance above 0;
- up to 400 lines `[NiobiumLoot] item <ItemDefinitionName>`, sorted.

To send it: Live Log → search "loot" → Copy.

## Installer

Tauri's NSIS installer (`tauri.conf.json` → `bundle.windows.nsis`): install mode "current user" (no admin
rights; default folder `%LOCALAPPDATA%\Niobium`), English only, no language picker, LZMA compression, the
Niobium icon for installer and uninstaller, `windows/assets/header.bmp` (150 × 57) and
`windows/assets/sidebar.bmp` (164 × 314), and the hooks in `windows/hooks.nsh`:

- dark look: background `#0A0B12`, text `#F2F3F8`, classic controls so the Finish page checkboxes use the
  text colour, link colour `#B49BFF`;
- before the wizard a fading splash (`windows/assets/splash.bmp`, AdvSplash, magenta `#FF00FF` is see-through;
  not for `/P` passive or `/UPDATE` runs);
- a dark title bar on Windows 11 (installer and uninstaller; harmless on Windows 10);
- English texts: "Welcome to Niobium", "You're ready to drop.", the checkbox "Launch Niobium now" and the link
  "Source code and help (GitHub)" → https://github.com/georghatzmann-bit/vanity-;
- after installing it goes straight to the Finish page (`SetAutoClose`);
- **old Vanity install:** if the uninstall entry `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Vanity`
  exists, the installer runs the old `uninstall.exe` silently first ("Removing the old Vanity launcher...").
  That only removes Vanity's program files and shortcuts; the folder is removed only if it is empty, so
  settings, server data and logs stay for the [migration](#moving-over-from-vanity).

The images are 24-bit uncompressed BMPs with a 40-byte header and no alpha; the workflow checks this before it
builds. Uninstalling Niobium keeps `%APPDATA%\Niobium`, the data folders in
`%LOCALAPPDATA%\Niobium` (`backend-data`, `server`, `logs`) and your Fortnite builds.

## UI ↔ Rust (Tauri commands and events)

Commands: `get_config`, `platform`, `update_settings`, `detect_build`, `add_build`, `remove_build`,
`add_profile`, `update_profile`, `remove_profile`, `set_active_profile`, `add_friend`, `remove_friend`,
`list_crashes`, `share_addresses`, `host_and_play`, `stop_all`, `join_ip`, `server_exec`, `server_config`,
`server_start_match`, `spawn_bots`, `remove_bots`, `get_client_settings`, `set_client_settings`,
`set_trickshot_presets`, `niobium_paths` (`{ config, logs, crashes, fortniteLogs }`), `app_ready`,
`pending_log_lines`, `bubble_builds_support`, `reset_performance_mode_ini`, `quit_app`, `close_prompt_shown`,
`bots_support` (`{ version, cl }` → `{ level, note }`, see [AI bots](#ai-bots-1910-experimental)), and for the
[build downloader](#build-downloader-download-a-version): `catalog_list`, `download_start`, `download_pause`,
`download_resume`, `download_cancel`, `download_status`, `default_download_folder`.

Early log lines: lines the launcher writes while it starts (e.g. "Copied your settings from Vanity …" or a
fixed-port note) come before the UI listens, so a `log:line` event then would be lost. They wait in Rust
(`launcher/core/src/earlylog.rs`, at most 500). The UI calls `pending_log_lines` once, right after its
`log:line` listener is registered, and puts them before newer lines; from then on every line comes as an
event. If the UI never asks, Rust sends them as events 10 s after the main window shows.

Events: `services`, `launch:step`, `log:line`, `toast`, `server:event`, `trickshot`, `detect`,
`bubble:ini-changed`, `app:close-requested`, `server:playerBots` (`{ state, reason }`), `download:progress`,
`download:done`, `download:error`, `download:state`.

New settings keys in `config.json`: `bubbleBuilds` (true/false, default false) and `lastSeenVersion` (text
or null). New profile keys: `infiniteAmmo`, `infiniteMats`, `bots`, `botCount`, `botSkill` (see
[Match rules](#match-rules-classic-match)).
