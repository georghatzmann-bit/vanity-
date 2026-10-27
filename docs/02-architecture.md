# Architecture – how the parts fit together

This file is the contract between the launcher, the backend and the game DLLs. Whoever changes an
interface changes it here too.

Rift used to be called **Niobium**, and before that **Vanity**. Every name below is the new one; the
section [Moving over from Niobium and Vanity](#moving-over-from-niobium-and-vanity) says what happens to
old data.

## Names

| What | Value |
|---|---|
| Display name | Rift (long form: "RiftFN — Step back into any season.") – brand rules in [`brand.md`](brand.md) |
| Lowercase id | `rift` |
| Game DLLs | `rift_redirect.dll`, `rift_server.dll`, `rift_client.dll` (MSBuild `TargetName`) |
| Visual Studio solution | `native/Rift.sln` |
| Control pipe of the game server | `\\.\pipe\niobium-server` |
| Tauri app | productName `Rift`, identifier `dev.rift.launcher`, main binary `Rift.exe`, window title "Rift" |
| Packages (internal, unchanged) | npm `niobium-launcher` (launcher), `niobium-backend` (backend); Cargo `niobium-launcher` (library `niobium_launcher_lib`) and `niobium-core` |
| Backend environment variables | `NIOBIUM_BACKEND_PORT`, `NIOBIUM_MATCHMAKER_PORT`, `NIOBIUM_BIND`, `NIOBIUM_DATA_DIR`, `NIOBIUM_GAMESERVER` |
| Backend routes | `/niobium/health`, `/niobium/status`, `/niobium/gameserver` |
| Login | `-AUTH_LOGIN=<name>@niobium.local`, `-AUTH_PASSWORD=niobium` |
| Version hint for the DLLs | launch argument `-niobiumversion=<version>`, e.g. `-niobiumversion=19.10` |
| Chat and console prefix | `[Rift] ` (with the space) |
| Markers in vendored code | `// NIOBIUM:` (server, redirect, LawinServer), `// [Rift]` (in-game menu) |
| CI | release tag `rift-test`, release name "Rift – test build", installer `Rift-Setup.exe`, artifacts `rift-backend-dist`, `rift-dlls`, `rift-installer` |

The GitHub repository itself is still called `vanity-`.

**Internal names stay "niobium" on purpose.** They are never shown to players, and the launcher, the
backend and the DLLs already agree on them, so they were not renamed to Rift (for compatibility): the
control pipe `\\.\pipe\niobium-server`, the backend environment variables `NIOBIUM_*`, the routes
`/niobium/*`, the login domain `@niobium.local` (and password), the launch argument `-niobiumversion`, the
`nbedit:v1` wire format of "Reset builds", the CSS variables `--nb-*`, the key names in `client.json` and
`config.json`, the `[NiobiumLoot]` log tag, the package/crate names above, the `// NIOBIUM:` code markers
and code symbols and file names such as `NiobiumControl` or `niobium.js`. A download folder that Niobium
started keeps its `.niobium-download\` notes (new ones use `.rift-download\`).

## Folders

```
launcher/core/            Rust logic without a window (version, logs, crashes, profiles, launch arguments,
                          parkours, Bubble Builds INI check, Niobium/Vanity migration, AI bot settings in
                          src/bots.rs, the build downloader in src/epic/) – testable everywhere
launcher/core/data/build-catalog.json   the builds "Download a version" offers (manifest ids and SHA-1s)
launcher/src-tauri/       Tauri app: windows, processes, loading DLLs, backend, server pipe, downloads
                          (src/download/) (Windows)
launcher/src-tauri/windows/   installer hooks (hooks.nsh) and installer images (assets/*.bmp)
launcher/src/             React UI
launcher/splash.html      the splash window (no scripts)
launcher/src/data/parkours.json   the ready-made trickshot parkours (one file for the UI, Rust, server and F9 menu)
backend/                  backend (Node 22 + TypeScript), based on LawinServer → backend/dist/
native/                   C++ (/std:c++latest), Visual Studio 2022 (v143), x64 – one solution: native/Rift.sln
  third_party/minhook     MinHook (BSD-2) as source → static library (project "minhook")
  third_party/imgui       Dear ImGui v1.93.0 (MIT) as source – not used by the projects right now
  redirect/               redirect, based on Tellurium (BSD-3)        → rift_redirect.dll
  server/                 game server, based on Magnesium (BSD-3)      → rift_server.dll
  client/                 in-game menu F9, based on ATLAS Console      → rift_client.dll
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
| `%APPDATA%\Rift\config.json` | settings, profiles, builds, friends, trickshot presets (only the launcher writes it) |
| `%APPDATA%\Rift\client.json` | settings of the in-game menu (the launcher's "In-game Menu" page and the F9 menu both read and write it) |
| `%APPDATA%\Rift\downloads.json` | unfinished build downloads (build key and folder), so they come back as "Paused" after a restart |
| `<download folder>\.rift-download\` | the downloader's notes for that folder: `job.json`, `manifest`, `journal.jsonl`, `progress.json` (see [Build downloader](#build-downloader-download-a-version)). It stays in the folder after the download |
| `%LOCALAPPDATA%\Rift\backend-data\` | data of the backend (locker, profiles, `Config\config.ini`, friends list) |
| `%LOCALAPPDATA%\Rift\server\` | everything the game server writes (`auto_hosting.json`, `loadouts`, `Maps`, `trickshots`) |
| `%LOCALAPPDATA%\Rift\server\parkours.json` | trickshot parkours – the launcher writes it, the game server and the F9 menu read it (see below) |
| `%LOCALAPPDATA%\Rift\gus-backup.json` | only while a game with Bubble Builds runs: the original lines of Fortnite's `GameUserSettings.ini` that Rift changed for this game (see [Bubble Builds](#bubble-builds)). Deleted once they are back |
| `%LOCALAPPDATA%\Rift\logs\` | logs of the DLLs: `redirect.log` (redirect), `client-diagnostics.log` (in-game menu). The game server writes `stdout.log` in the build's `FortniteGame\Binaries\Win64` folder |
| `%LOCALAPPDATA%\Rift\` (program files) | the installer's default install folder (Tauri, "current user" mode) is this same folder. The installer puts `Rift.exe`, `backend\`, `dlls\` and `node\` there; an update replaces them and uninstalling deletes them, so nothing the launcher or backend writes goes into those folders |

Rift changes nothing in the folder of a build you add yourself and nothing in other launchers'
folders. The one file outside its own folders it may touch is Fortnite's own `GameUserSettings.ini` –
only with Bubble Builds on, only three lines, with a backup first, and they are put back after the game
(see [Bubble Builds](#bubble-builds)). The build
downloader writes only into the folder you pick for a download: the build's own files and
`.rift-download\`.

## Moving over from Niobium and Vanity

`launcher/core/src/migrate.rs`, called once at every launcher start (`lib.rs`, before the config is read).
For each item it uses the newest old name that has it: Niobium first, Vanity only if there is no Niobium
copy of that item.

- If `%APPDATA%\Rift\config.json` is missing and `%APPDATA%\Niobium\config.json` (or else
  `%APPDATA%\Vanity\config.json`) exists, it copies `config.json` and `client.json` from that folder
  (`client.json` only if the Rift one doesn't exist yet). In the same run – and only then – a left-over
  `gus-backup.json` of that old name comes along, so Rift still puts Fortnite's settings back after a
  crash; it is never copied a second time.
- If `%LOCALAPPDATA%\Rift\server` is missing and `%LOCALAPPDATA%\Niobium\server` (or else the Vanity one)
  exists, it copies that folder's files over (sub-folders too, but no folder called `logs`).
- If `%LOCALAPPDATA%\Rift\backend-data` is missing and `%LOCALAPPDATA%\Niobium\backend-data` exists, it
  copies it (accounts, lockers, settings of the backend; no `logs`).
- It never overwrites and never deletes anything. The old folders stay as they are. Logs, builds,
  `downloads.json` and the old program files are not copied (the config keeps the full paths of the
  builds, so builds in an old folder keep working). `%LOCALAPPDATA%\Vanity\backend` (Vanity's old
  locker) is not copied either.
- If something was copied, the live log gets one line (source "Rift") once the window is shown, e.g.
  "Copied your settings from Niobium to Rift (config.json and client.json, 3 server setting files,
  12 backend files). The old Niobium folders were left as they are."
- If `config.json` came over and has no `lastSeenVersion`, it gets `lastSeenVersion = "vanity"` (the
  marker keeps that value, so configs Niobium marked still work). So the UI shows the short "What's new"
  card ("Niobium is now Rift") instead of the full welcome. A Niobium config that has a last-seen version
  shows "What's new" anyway as soon as the version differs.
- Every time the config is loaded (`Config::refresh_after_load`), each build's season and support note
  are worked out again (old German notes go away), and texts the old launcher wrote itself become English:
  profile `p-standard` "Standard" → "Default", "Normales Match auf deinem eigenen Server" → "A normal match
  on your own server", "Eigenes Profil" → "Custom profile", tags "Turnier Solo/Duos" → "Tournament
  Solo/Duos", friend network "Netzwerk" → "Other". Names you typed yourself stay.

The installer also removes an old Niobium or Vanity *program* install (see [Installer](#installer)).

## Versions

Rift starts **every version from 1.7 to 30.x** (Chapter 1 to Chapter 5 Season 3). The limits come
from the source code of the parts, not from guesses – researched in Reboot Launcher, Erbium/Magnesium,
Tellurium, ATLAS Console and LawinServer (October 2026):

| Level (`Support`) | Meaning | Shown as |
|---|---|---|
| `supported` | really tested (`TESTED` in `launcher/core/src/version.rs`, currently 19.10) | "Tested" |
| `experimental` | 1.7 to 30.x, untested – it is started, with a note in the log and on the build card | "Untested" |
| `unsupported` | older than 1.7, unreadable, or **31.00 and newer**: the game server (Erbium/Magnesium) refuses such builds itself (`SDK/Offsets.h`, limit 31.00) | "Can't start" |

Version numbers are compared with `version::parse_version_number`, which reads a one-digit minor
version the way Fortnite means it: "15.4" counts as 15.40, "19.1" as 19.10 (from 5.0 on; "4.5" stays 4.5).

Unreal Engine per season (the server and the menu switch on the **engine** version, not the Fortnite
version): 19.x 5.0, 23.x 5.1, 25.x 5.2, 26.x 5.3, 27.x–30.x 5.4. Checked on 26 Oct 2026 in the version
resource of `FortniteClient-Win64-Shipping.exe` (ProductName "Unreal Engine", ProductVersion) of 23.40-CL-24087481
(5.1.0), 25.30-CL-26867995 (5.2.0), 26.00-CL-27424790 (5.3.0) and 27.00-CL-29072304 (5.4.0); each exe was put
together from Epic's CDN chunks and matched the SHA-1 in its manifest. 28.x–30.x: Fortnite wiki (5.5 came with
31.00).

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
| 23 and newer | the backend turns off network encryption (`net.AllowEncryption=0`); server and menu do the same from UE 5.1 (= 23.x) | LawinServer, Erbium, ATLAS |
| 26.00 and newer | Iris networking from UE 5.3 – server and menu agree. One exception: on 27.11 the Durian playlist (`Playlist_Durian`) stays on the old GenericLegacy networking. The server writes its choice into a small shared "transport manifest"; on 27.11 the menu reads it when it joins a server on the same PC | ATLAS, Magnesium (`dllmain.cpp`, `FinalizeTransportPolicy`) |
| 27.00 and newer | the menu turns off Chapter 5 movement from UE 5.4: tac sprint, hurdling, sliding and clambering | ATLAS `dllmain.cpp` |
| 27.00 and newer | the server turns off tac sprint, sliding and clambering from UE 5.4. It turns off hurdling only on 27.11 with one of the known S27 custom-map playlists (`Playlist_Arena_DefaultSolo_Respawn`, `Playlist_OnlyUp_Jett`, `Playlist_TiltedZW_Jett`) | Magnesium `dllmain.cpp`, `Configuration.h` (`IsKnownS27CustomMapPlaylist`) |
| 15.30 – 16.40 | Bubble Builds (see [below](#bubble-builds)) | Epic patch notes, research |
| 19.00 – 19.99 | Bubble Builds as "Meshes Low" (experimental, see [below](#bubble-builds)) | research |
| below 37.00 | "Reset builds" key in the F9 menu (from 37.00 Fortnite has its own "Reset Building" key) | Epic patch notes |

Playlists (control pipe, like the buttons in the server window): Trios from 7.40, Tournament from 6.10,
Arena from 8.20, Zero Build and Arena Zero Build from 20.00, Playground from 4.50 (the server window shows
its button only up to 11.30). The server refuses a playlist that is too new for the build, with a note.

In-game menu per version: "Edit on release", "Reset on release" and "Disable pre-edits" are shown on
every version. Below the version where Epic's own setting works on PC, Rift's hook does the work; from
that version on the F9 switch changes Epic's own setting instead – never both at once (see
[Edit routes](#edit-routes-edit-on-release-reset-on-release-disable-pre-edits)). "Free camera" up to 10.40;
field of view, first person, target info, "Respawn after you die", "Bubble look", the console and the
"Trickshot" tab on every version. Other toggles a version doesn't have are simply hidden. "Always sprint" was
removed: it is off for everyone, and an old `"sprintByDefault": true` in client.json is ignored.

The redirect writes `%LOCALAPPDATA%\Rift\logs\redirect.log`: which pattern matched, whether the
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
`NIOBIUM_DATA_DIR` (`%LOCALAPPDATA%\Rift\backend-data`) and `NIOBIUM_GAMESERVER` (`127.0.0.1:7777`).
On the first start the backend copies its default data files into `backend-data` (existing files are never
overwritten). Niobium's `backend-data` is copied over once (see [migration](#moving-over-from-niobium-and-vanity)); Vanity's
backend data is not.
Ready when `GET /niobium/health` → `{"ok":true,…}` (the launcher waits up to 20 s).
`POST /niobium/gameserver {ip,port}` sets the matchmaker target (joining by IP); `POST /niobium/status`
tells the backend the hosted version and playlist. Details: [`backend/README.md`](../backend/README.md).

## Starting the launcher

1. `lib.rs` runs the [Niobium/Vanity migration](#moving-over-from-niobium-and-vanity), writes `parkours.json` (see below) and
   loads the config.
2. Two windows (`tauri.conf.json`): `main` (1280 × 800, no frame, **starts hidden**) and `splash`
   (`splash.html`, 440 × 300, centred, no frame, transparent, no shadow, not resizable, always on top,
   not in the taskbar, doesn't take focus). The splash shows the logo, "Rift", "old seasons, new
   shine." and a loading line; it has no scripts.
3. The UI loads the config. Two animation frames later (or after 200 ms, whichever comes first) it calls
   the Tauri command `app_ready`: that shows and focuses `main` and closes the splash. Only the first call
   does anything. If the UI never calls it, Rust does it after 8 s as a safety net. In the browser demo
   (no Tauri) nothing of this happens.
4. First run (`settings.lastSeenVersion`): empty → the full-window **welcome** ("Welcome to Rift" →
   "What should we call you?" → "Add your Fortnite build" → "You're all set"; "Skip setup" at the top);
   different from the app version → the short **"What's new"** card. Both end with `update_settings`,
   which stores the app version in `lastSeenVersion`.

## Launch sequence ("Host & Play") – how `launcher/src-tauri/src/engine.rs` does it

The UI shows seven steps: Backend, Server, Redirect, Login, Your game, Game server, Lobby.

1. **Backend:** start it, wait for `/niobium/health`, then `POST /niobium/status` (name "<player>'s server",
   hosting, playlist, version).
2. **Server:** write `parkours.json` fresh to `%LOCALAPPDATA%\Rift\server\`. Start the server Fortnite:
   helper programs `FortniteLauncher.exe` and `FortniteClient-Win64-Shipping_EAC.exe` paused (they never
   run), then `FortniteClient-Win64-Shipping.exe` with the arguments from `launcher/core/src/launchargs.rs`
   (`-AUTH_LOGIN=<player name from Settings>@niobium.local`, `-nosplash -nosound`, `-nullrhi` when
   "Server with no graphics" is on, always `-log` and `-niobiumversion=<version>`), environment
   `OPENSSL_ia32cap=~0x20000000`. The server never gets Bubble Builds.
3. **Redirect:** load `rift_redirect.dll` **right away**. The DLL waits by itself until Fortnite's HTTP
   part is there. If the DLL is missing or can't be loaded, the process is closed and the start stops.
4. **Login:** in the background, wait for the login line in the server log (`[UOnlineAccountCommon::ContinueLoggingIn]`
   with `(Completed)`, at most 3 minutes – then it loads anyway), wait 3 s (0 s on 5.x/6.x) and load
   `rift_server.dll`. **The DLL waits by itself** until engine and world are ready (Magnesium does this
   in `SDK::Init`).
5. **Your game:** at the same time, start the player's Fortnite (no `-nullrhi`, with the profile's
   arguments, e.g. `-d3d11`, and with [Bubble Builds](#bubble-builds) if they are on), the redirect right
   away, and `rift_client.dll` 6 s (8 s from 20.00) after its login.
6. **Game server:** connect to the control pipe (up to 4 minutes) and send the profile's match settings
   in this order: `bEnableCheats` = true, `playlist` (if the profile has one), `bLateGame`, `bInfiniteAmmo`,
   `bInfiniteMats`, `bPlayerBots`, `PlayerBotCount`, `PlayerBotTargetELO`, and only when the profile has Bosses &
   NPCs on `bLivingWorld`, `LivingWorldMaxAI` (`niobium_core::bots::server_config_for`, see
   [Match rules and AI bots](#match-rules-classic-match-and-ai-bots) and
   [Bosses & NPCs](#bosses--npcs-living-world-experimental)). The live log says "Connected to the
   server's control pipe – commands on, match settings sent", then the toast "The server is waiting for you".
   You start the match on "Match Control" ("Start match") or with START SERVER in the server window. The
   server loads the map only after that, so the bot and Bosses & NPCs settings arrive in time.
7. **Lobby:** as soon as the server log says `IpNetDriver … listening on port` (wait up to 30 minutes),
   the toast "Server ready" appears. Press Play in the game.

Logs: the launcher reads stdout/stderr of every instance (that's why `-log`) and shows it in the live
log. The DLLs also write to `%LOCALAPPDATA%\Rift\logs\`. If Fortnite closes in the first 4 minutes,
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

On **19.x** (Chapter 3 Season 1) players got a similar look with Performance Mode plus **Meshes: Low**:
builds look whiter and more see-through while they go up. Rift offers that as "experimental". It is
close to the old look, not the same. For every other version there is **"Bubble look"** in the F9 menu
(Main → Graphics): it lowers the detail of the four build blueprint textures (`BluePrintTexture02`,
`BluePrintTexture04`, `BlueprintTextureMetal`, `BrickBlueprintTexture`), only on your PC, right away,
with a "Bubble strength" slider. It pauses itself while real Bubble Builds are on.

### Version gate (`VersionRules::for_version(..).bubble_builds`)

| Level | Versions | Note the UI shows |
|---|---|---|
| `supported` | 15.40 ≤ v < 16.10 | "The see-through 'bubble wrap' build look from Chapter 2 Seasons 5–6. Starts the game in Performance Mode (lower graphics). Applies on next launch." |
| `experimental` | v = 15.30, or 16.10 ≤ v < 16.50 | "Epic changed how builds look around this version. Your builds may look normal even with this on." |
| `lowMeshes` (shown as "Experimental") | 19.00 ≤ v < 20.00 | "Chapter 3 version: starts the game in Performance Mode with Meshes set to Low. Builds look whiter and more see-through while they go up, like 'bubble wrap' builds. The whole game has lower graphics. Applies on next launch." |
| `unavailable` | everything else | "Not available for <version>. Bubble Builds work on 15.40 – 16.00, and as an experiment on Chapter 3 Season 1 (19.x). On other versions, try Bubble look in the F9 menu." |

"15.4" and "15.40" are the same here (see [Versions](#versions)). The Tauri command
`bubble_builds_support { version }` returns `{ level: "supported" | "experimental" | "lowMeshes" | "unavailable", note }`.
The UI mirrors the same rules in `launcher/src/lib/bubble.ts` for the browser preview.

### What changes at launch

Setting: `settings.bubbleBuilds` (default `false`), the "Bubble Builds" card at the top of Settings.
Only when it is on **and** the version is `supported`, `experimental` or `lowMeshes`:

- **Only the player's game** – never the server – gets `-FeatureLevelES31` (unless the profile already has
  `-FeatureLevelES31` or `-FeatureLevelES3_1`, any case).
- If the profile's arguments contain `-d3d12` or `-dx12`, they become `-d3d11` for this launch only. The
  profile itself is not changed.
- On `supported` and `lowMeshes` versions Meshes is set to Low in Fortnite's settings file for this one
  game (see the next section). On `experimental` versions that file only gets the backup.
- Never `-sm5`, no pak files, no console variables, nothing written into the build folder.
- The live log says "Bubble Builds on: starting in Performance Mode (-FeatureLevelES31)". On a version
  without Bubble Builds it says "Bubble Builds are on, but Fortnite <version> can't show them – starting
  normally".

With the setting off, the arguments are exactly the same as without the feature (tests in `launchargs.rs`).

### Fortnite's settings file: backup and automatic restore (`launcher/core/src/perfmode.rs`)

Fortnite saves Performance Mode and Meshes in
`%LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\GameUserSettings.ini` – a file every build
shares. With Bubble Builds on, Rift changes it for one game and puts it back afterwards (agreed with
Georg: "Ja, mit Zurücksetzen"):

1. **Backup first.** Before the first Fortnite of a start (the server Fortnite reads the same file), the
   launcher writes `%LOCALAPPDATA%\Rift\gus-backup.json`: the file path and, for each line, the original
   line or "absent", plus whether its section existed:
   - `bPreferFeatureLevelES31` and `PreferredFeatureLevel` in `[D3DRHIPreference]`;
   - `MeshQuality` in `[PerformanceMode]` – only on `supported` and `lowMeshes` versions.
2. **Then Meshes Low.** Only after the backup is on disk, `MeshQuality` is set to `0` (if it isn't 0
   already). A missing line is added; a missing `[PerformanceMode]` section is added at the end. Nothing
   else in the file changes.
3. **Left alone:** a missing INI; a file whose bytes would not come back the same after reading (broken
   UTF-8, odd UTF-16); a file where one of these keys or its section header appears twice. The log says why.
4. **Put back** – exactly those lines (a line or section that wasn't there before is removed again);
   encoding (UTF-8, UTF-8 with BOM, UTF-16 LE) and line endings stay. Then the backup is deleted, the live
   log says "Fortnite's graphics settings were put back." and a toast shows the same. This happens:
   - when the player's game has closed and no other Fortnite runs any more (the server may also save
     the file, so it waits for that one too);
   - when a start fails before the game launches;
   - when Rift is closed during a game;
   - after a launcher crash: on the next start, before anything else – or, if Fortnite still runs, as
     soon as every Fortnite has closed.
5. If an old Fortnite is still running at a new start, the launcher waits up to 5 s (Stop all cancels the
   wait). If it still runs, the file is not changed for this game: "Another Fortnite is still running, so
   Fortnite's graphics settings were not changed for this game. …"

Live log lines: "Backed up Fortnite's graphics settings. They are put back when the game closes.",
"Meshes set to Low for this game (it was <n>).", "Meshes is already Low.", "Meshes set to Low for this
game (Fortnite's settings had no Meshes line yet).", "Fortnite's graphics settings were not changed: …".

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
| `bLivingWorld` | true/false – Bosses & NPCs (see [Bosses & NPCs](#bosses--npcs-living-world-experimental)). Server default: false |
| `LivingWorldMaxAI` | most bosses and NPCs at once. Clamped to 1–100. Server default: 40 |

`bAutoRestart`, `bNoFallDamage` and `bInstantReload` do **not** exist.

The three bot keys are only taken **before "Start match"** (`FConfiguration::bReadyToStart`), because the
server decides about bots when the match starts. After that the answer is `ok:false` with "Bot settings
take effect next match." The same goes for `bLivingWorld` and `LivingWorldMaxAI`: "Bosses & NPCs settings take
effect next match." (older server builds say "Living world settings take effect next match."). The launcher
shows such an answer as a "Server" pop-up with the server's text, whichever spelling it has.

What the launcher sends:

- When it connects, in this order: `bEnableCheats` = true, `playlist` (if the profile has one), `bLateGame`,
  `bInfiniteAmmo`, `bInfiniteMats`, `bPlayerBots`, `PlayerBotCount` (the profile's count, clamped to 1–99),
  `PlayerBotTargetELO` (from the profile's bot skill), then `bLivingWorld` = true and `LivingWorldMaxAI` (clamped
  to 1–100) **only when the profile has Bosses & NPCs on** (see [Bosses & NPCs](#bosses--npcs-living-world-experimental)).
  All values come from the active profile.
- Before every `startmatch`, `bEnableCheats` = true again. Also as soon as `status.ready` changes from false to
  true (start through START SERVER or the auto-host countdown – "Toggle Auto Host" in the server window
  turns cheats off otherwise).
- From the "Match Control" page: `playlist`, `bLateGame`, `bLivingWorld`, `LivingWorldMaxAI`, `bForceRespawns`,
  `RespawnTime`, `bInfiniteAmmo`, `bInfiniteMats`, `bTrickshotDetection`, `bDisableJumpFatigue`,
  `bAutoReloadOnWaypointTP`, `BotHealth`,
  `BotShield`; as `exec` the commands of the buttons (`startaircraft`, `pausesafezone`, `resumesafezone`,
  `skipsafezone`, `give …`, `givetoall …`, `parkour …`, `targetbot …`, `bot <n>`, `tpbot`, `delbot`,
  `demospeed …`, `gravity …`, `god`, `s rift o`, `w rift`, `l 2500`, `givetraps`, `giveammo`, `regen`)
  and your own presets (a leading `cheat ` or `/` is left out).

Server → launcher:

| Message | Meaning |
|---|---|
| `{"event":"hello","fortnite":19.1,"engine":5.0}` | right after connecting: version of the build |
| `{"event":"ready","port":7777}` | the server listens, players can come (once per connection, from phase `joinable`) |
| `{"event":"reply","id":1,"ok":true,"message":"Done: startaircraft"}` | answer to a command (short English text, e.g. "Saved: bInfiniteAmmo", "Server is starting. Loading the map..."). With `ok:false` the launcher shows the text as a toast titled "Server" |
| `{"event":"status","phase":"joinable","ready":true,"players":1,"lategame":false,"playlist":"/Game/…","port":7777}` | every 2 s. `phase`: `notReady`, `ready`, `joinable`, `started`, `ended`. `ready` = the start was triggered |
| `{"event":"trickshot","player":"georg","victim":"Bot 3","meters":87}` | trickshot spotted (see below). The launcher shows the toast "TRICKSHOT! georg" with "on Bot 3 · 87 m" |
| `{"event":"matchEnd"}` | match over – launcher toast "Match over"; the UI forgets this match's AI bots and Bosses & NPCs answers |
| `{"event":"playerBots","state":"active","reason":""}` or `{"event":"playerBots","state":"unavailable","reason":"Bots aren't available for this copy of 19.10."}` | only when the profile has AI bots on: the server's decision for this match (see [AI bots](#ai-bots-1910-experimental)). The launcher writes "AI bots are on for this match." or "AI bots are off: <reason>" in the live log (source Rift, category `bots`) and sends the Tauri event `server:playerBots` `{ state, reason }`; for "unavailable" the UI shows the toast "AI bots are off for this match" with the reason |
| `{"event":"livingWorld","state":"unavailable","reason":"not built yet for this version","spawned":0}` (`state` also "off", later "active") | how Bosses & NPCs go this match, sent at "Start match" (see [Bosses & NPCs](#bosses--npcs-living-world-experimental)). Today the server only sends "unavailable" (switch on) or "off" (switch off). The launcher forwards it (and any later update) as the Tauri event `server:livingWorld` `{ state, reason, spawned }`; "off" gets no log line and shows nothing |

Unknown commands → `reply` with `ok:false` ("Unknown command "…"."). The pipe threads never touch game
objects; they put commands in a queue that runs in the game thread.

### Who may send cheat commands?

Everything the F9 menu and the launcher send goes through Magnesium's `ServerCheat`
(`native/server/FortniteGame/Private/FortPlayerControllerAthena.cpp`). The server only runs a command when
`bEnableCheats` is on – or when the player comes from the same PC (127.0.0.1) and the playlist isn't
"Only Up". Otherwise it answers "Commands are currently disabled for this session." That's why the launcher
turns `bEnableCheats` on (see above). It's your own server, so every player on it may send commands.

## Rift commands in the game server (`parkour`, `targetbot`)

Code: `native/server/Erbium/Private/NiobiumParkour.cpp` (Rift's own code), hooked into `ServerCheat`
(marked with `NIOBIUM:`). Typed as `cheat parkour …` (console, F9 buttons) or sent through the pipe as
`exec`. Everything runs in the game thread and errors are caught ("Something went wrong. Please try
again."). The answers are English `ClientMessage`s with "[Rift] " in front, sent to the player who sent
the command. Without a character (e.g. on the bus or eliminated): "You need your character for this. Wait
until you're in the game."

| Command | Effect |
|---|---|
| `parkour <id>` | builds the parkour from `parkours.json` around you: clear the old Rift parkour → round your view direction to 90° → start platform `height` m above your feet → jump objects (with their own platform if given) → target bots, each on its own platform → put you on the start (looking forward) → give the first sniper from `snipers` the version knows. If you still stand on the old start, it builds from the old ground height (otherwise every new parkour would end up higher). Answer: ""First Jump" is ready! Built: 10 floors, 1 jump objects, 1 target bots." |
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
  Please start the game from the Rift launcher."

## Trickshot parkours (`parkours.json`)

One file for everything: `launcher/src/data/parkours.json`. It is built into the launcher (Rust:
`include_str!` in `launcher/core/src/parkours.rs`, UI: `launcher/src/lib/parkours.ts`). The launcher writes it
at its own start and right before every server start to `%LOCALAPPDATA%\Rift\server\parkours.json` – fresh
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

- every player gets the `ClientMessage` "[Rift] TRICKSHOT! <name> – <metres> m" (en dash; metres =
  distance from shooter to victim). The F9 menu turns it into the banner (see below);
- the launcher gets `{"event":"trickshot","player":…,"victim":…,"meters":N}`;
- the same victim is reported only once within 1.5 s.

On/off: pipe key `bTrickshotDetection` (default: on; in the launcher "Match Control" → "Trickshot" →
"Trickshot banner" → "Banner on"). This is separate from the trickshot tab in the server window.

## In-game menu (client DLL)

- On load it reads `%APPDATA%\Rift\client.json` and writes changes back. Format (taken over from ATLAS
  Console; the launcher writes the same): `{ "hotkey": 120, "joinHotkey": 116, "consoleMode": 0,
  "preferences": { "editOnRelease": true, "resetOnRelease": true, "disablePreEdits": true, "respawnsEnabled": true,
  "firstPerson": false, "sprintByDefault": false, "inGameFog": true, "mobileBuilds": false, "slashKey": true,
  "saveTogglePreferences": true, "bubbleLook": false, "bubbleStrength": 5, "resetBuilds": false,
  "resetBuildsKey": 0 }, "commands": [], "macros": [] }` (keys = Windows VK codes; `consoleMode` 0 =
  Rift console, 1 = original Unreal console). `sprintByDefault` stays in the file only so old files still
  load: "Always sprint" was removed, the launcher always writes `false` and the menu ignores the key.
  Trickshot presets are **not** in here but in the launcher's `config.json` (`trickshotPresets`). You make them
  on the "In-game Menu" page → "Trickshot presets" and run them on "Match Control" → "Trickshot" → "Your
  presets" (command by command through the pipe).
- Everything that touches game objects runs in the game thread. Own threads only put commands in a queue.
- `imgui.ini` is never written (`io.IniFilename = nullptr`), so nothing lands in the game folder.
- Window title "Rift | Menu", all texts in plain English (`native/client/ATLAS/Private/GUI.cpp`), brand
  colours (violet accent `#7A3CFF`). Tabs:

| Tab | Contents |
|---|---|
| Main | Join a server, Editing (Edit on release, Reset on release, Disable pre-edits – every version), Graphics (Mobile Builds, Bubble look + Bubble strength, In-game fog, Simpler textures), Movement, Field of view, Respawn, Other |
| Commands | your own commands and command chains, each with its own key |
| Options | Build look (Bubble Builds status), General (Which console?, Open the console with the … key, Remember my settings), Reset builds (switch, Reset builds key, status), Keys (Change menu key, Change join key, Reset everything) |
| Trickshot | Rift: Load a parkour, Target bot, Gear, Practice (`ATLAS/Private/NiobiumTrickshotTab.cpp`) |
| Credits | names Erbium and ATLAS Console; the licence line "Rift is based on ATLAS Console by cipherfps, ralz and contributors." |

- Toggles a version doesn't have are hidden (see [Versions](#versions)).
- Console: **F8**. In the Rift console also `VK_OEM_3` (US keyboard `~`, German keyboard Ö) and – when
  "Open the console with the … key" is on – `VK_OEM_2` (US `/`, German `#`); then it opens with "/" already typed.
- Host features are sent by the menu as `cheat <command>` to the server (see "Who may send cheat commands?").

**Bubble Builds status row** (Options → "Build look", read-only; on 15.40 – 16.00 and 19.x it also checks Meshes: "Bubble Builds: On (Performance Mode, Meshes Low)" or a hint to set Meshes to Low and restart): it looks for `-FeatureLevelES31` (or
`-FeatureLevelES3_1`) in `GetCommandLineW()` – case-insensitive, whole switch only – and uses the version the
game reports (`-niobiumversion=` from the launcher as a fallback and for the label). Same version gate as
`VersionRules`. It shows "Bubble Builds: On (set in the launcher)", "Bubble Builds: Off – turn it on in the
launcher, then restart the game." or "Bubble Builds: Not available on <version>", with an amber
"Experimental" badge where it applies and the hint "… Can't be changed while playing." The "Mobile Builds"
toggle in "Main" works on every version, right away.

### Edit routes (Edit on release, Reset on release, Disable pre-edits)

`native/client/ATLAS/Public/EditFeatureRoutes.h`. Each feature takes exactly **one** route per game:

| Feature | Rift's hook | Fortnite's own setting | Note |
|---|---|---|---|
| Edit on release | below 11.00 | from 11.00 ("Confirm Edit on Release"; from 24.30 "Auto Confirm Edits" = Edit) | 10.x has the setting only for mobile, so it is never written there |
| Disable pre-edits | below 15.20 | from 15.20 ("Disable Pre-Edits") | 15.10's option only reset edits when you left build mode |
| Reset on release | below 24.30 | from 24.30 ("Auto Confirm Edits" = Reset; Edit + Reset = "Both") | |

- **Hook:** our detour does the work, Epic's setting is never touched.
- **Fortnite's setting:** the F9 switch reads and writes Epic's own setting (via reflection, only on the
  game thread), our detour does nothing. The row says "Uses Fortnite's own … setting". Changing it in F9
  changes it in Fortnite's settings too.
- **Unavailable:** greyed out with the reason – "Couldn't be set up on this version.", "Waiting for
  Fortnite's settings..." or "Not available on <version>". The menu only switches to Fortnite's setting
  when its getter and setter were really found (fail closed).

### Reset builds

Aim at one of your edited build pieces, press the **Reset builds key**, and it goes back to the unedited
piece – without opening edit mode. Editing and resetting the normal way (edit key → reset) still works.
Fortnite only got its own "Reset Building" key in **37.00**; from there the F9 row just points to
Fortnite's Keyboard Controls.

- **Client** (`ATLAS/Private/QuickReset.cpp`, `Public/QuickReset.h`): F9 → Options → "Reset builds"
  (switch, off at first), "Reset builds key [<key>]" (no key at first; not the left or right mouse button),
  status: "Join a match to use it." / "Checking the server..." / "Ready." / "This server can't do it. It
  needs a Rift server." / "Not available on this version." / "Close the original console first (Esc)."
  A key that is also a menu, join, console or command key is refused. Keys typed into a console never count.
- **Server** (`Erbium/Private/QuickReset.cpp`, `Public/QuickReset.h`): host switch "Allow Reset Builds Key"
  in the server window (on by default).
- **Wire format** (plain ASCII, fixed width, lowercase hex):
  - hello, client → server via `ServerCheat`: `nbedit:v1:h:<session16>`
  - ack, server → client via `ClientMessage`: `nbedit:v1:a:<session16>` – only below 37.00, when the host
    allows it and the server's self-test finds the unedited wood wall class; at most once per second.
  - arm, client → server via `ServerCheat`: `nbedit:v1:r:<session16>:<seq8>`, right after it
    `ServerEditBuildingActor(Target, Target->Class, 0, false)`.
- **The server resets only when all of these hold:** the arm is fresh (one-shot, 1000 ms, same controller
  and world, newer sequence number); same class, rotation 0, not mirrored; the piece was placed by a player;
  nobody is editing it; the pawn is alive and not in a vehicle; same team (unless the playlist allows
  editing enemy walls); within 2048 units; at most one reset every 80 ms. Anything else: nothing happens.
  If the player is already editing that piece, the request is dropped and their edit keeps going.
- The unedited class comes from `AllPlayerBuildableClasses`, or from the `PBWA_{W,S,M}1_{Solid,Floor,StairW,RoofC}`
  paths. The game server's `stdout.log` has `[reset-builds]` lines for testing.

The buttons in the "Trickshot" tab:

| Button | Command |
|---|---|
| Parkour card → Load | `cheat parkour <id>` |
| Start over / Clear everything | `cheat parkour retry` / `cheat parkour clear` |
| Place bot in front of me | `cheat targetbot <health> <metres>` (sliders "Health" 1–200 and "Distance" 5–100 m; start 50 / 30) |
| Remove all bots / Bring bots to me | `cheat delbot` / `cheat tpbot` |
| Give sniper / Give launch pads | `cheat parkour sniper` / `cheat givetraps` |
| Refill ammo / Refill health | `cheat giveammo` / `cheat regen` |
| Save spot / Back to spot | `cheat s rift o` / `cheat w rift` (the same waypoint name as on "Match Control", so a spot saved in one place works from the other) |
| Launch me up | `cheat l 2500` |
| Slow motion (toggle) | on: `cheat demospeed 0.5`, off: `cheat demospeed 1` |
| Low gravity / Normal gravity | `cheat gravity 0.4` / `cheat gravity 1` |
| Invincible on/off | `cheat god` |
| Pause storm / Resume storm (toggle) | `cheat pausesafezone` / `cheat resumesafezone` |

After a click, the line under the section (on "Load": in the card) shows "Sent: …" for a moment – or "Can't do
that right now – are you in a match?" when the command couldn't be sent. The server's real answer is in the
console (setting "Rift console"). The menu remembers "Slow motion" and "Storm" itself; in a new match they
go back to "off". In the lobby a hint at the top says the buttons only work in a match ("You're still in the
lobby. Start a match first – then these buttons work.").

**Trickshot banner:** `Client.cpp` looks at every `ClientMessage` (in both console modes). If it starts with
`[Rift] TRICKSHOT`, `NiobiumToast_Draw` (every frame, also with the menu closed) shows a big gold
"TRICKSHOT!" at the top centre and below it the rest of the first line (name and metres), for 3.5 s. The
message itself still goes to the console unchanged.

## Build downloader ("Download a version")

Library → **Download a version** (a button at the top next to "Add a build", and a tile under the "Add a
build" tile). It downloads an old Fortnite build and adds it to the Library like "Add a build" does. Only
builds that Epic still has **completely** and that Rift's game server is meant to run are offered.

Code: `launcher/core/src/epic/` (formats, checks, the download engine – tested with `cargo test`),
`launcher/src-tauri/src/download/` (commands, HTTP, Windows drive facts), UI `launcher/src/pages/DownloadPage.tsx`,
`launcher/src/components/download/`, `launcher/src/lib/downloads.ts`. The manifest and chunk formats are
ported from Legendary (GPL-3.0-or-later, see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)).

### Where the files come from

- **The manifest** (a small file that lists a build's files and the pieces they are made of, 2.5–34 MB):
  Epic's CDN refuses old manifests without a token (answer 403), so it comes from the public GitHub archive
  `polynite/fn-releases`
  (`https://raw.githubusercontent.com/polynite/fn-releases/master/manifests/<id>.manifest`). Fallback:
  `VastBlast/FortniteManifestArchive` (`…/main/Fortnite/Windows/<id>.manifest`), only for the 15 builds
  where that file is byte-identical (not for 18.00-CL-17468642 and 18.20-CL-17792290). VastBlast has none of
  the 21.x–30.x builds, so for those polynite is the only source (`vastblast: false`). Every manifest is
  **pinned by its SHA-1** in `build-catalog.json`; any other file is refused (`MANIFEST_MISMATCH`). The
  Tectors/FortXD archive is never used (its files are damaged).
- **Every game byte** (the "chunks") comes only from Epic's official CDN hosts, path `/Builds/Fortnite/CloudDir/`,
  over HTTPS, without a login, tried in this order and rotated on every retry:
  `fastly-download.epicgames.com`, `epicgames-download1.akamaized.net`, `download.epicgames.com`,
  `cloudflare.epicgamescdn.com` (`epic/cdn.rs`, `CDN_HOSTS`). Redirects are never followed, so no other host
  is ever contacted. Rift never uses re-uploads or mirrors of builds.
- On Windows, HTTPS uses Windows' own TLS and certificate store (ureq with native-tls).

### What it offers (`launcher/core/data/build-catalog.json`, checked on 26 Oct 2026)

44 builds: 17 from Chapter 2 (13.x–18.x) and 27 from 21.x–30.x (20 main builds, two per season, plus 7 more).
All carry the badge **Experimental** (only versions in `TESTED` get "Tested", and 19.10 can't be downloaded).
The sizes are what the UI shows (decimal GB); "free space" is on disk + 2 GiB. For 21.x–30.x the last column
is the season's `about` line on its card; each build also has a short note (e.g. "Darth Vader arrives as a boss
with his Lightsaber." on 21.10). From 28.x on every note starts with "Very big: about N GB on disk." (warning
colour in the picker).

| Season | Builds | Download | On disk | Note on the card |
|---|---|---|---|---|
| Chapter 2 Season 3 | 13.30-CL-13884634; 13.40-CL-14008768, -14036559, -14113327 | 45.1 / 46.1 GB | 97.2 / 99.5 GB | "Very big: about 97 GB on disk" / "about 100 GB" ("Epic made builds smaller from 14.40 on") |
| Chapter 2 Season 5 | 15.00-CL-14826719, -14835335 | 32.7 GB | 36.2 GB | – |
| Chapter 2 Season 6 | 16.00-CL-15685441 | 35.1 GB | 38.9 GB | "Has the Chapter 2 'bubble wrap' build look (Bubble Builds)." |
| Chapter 2 Season 7 | 17.21-CL-16949556, -16967001; 17.50-CL-17388565 | 38.4–40.3 GB | 42.6–44.5 GB | – |
| Chapter 2 Season 8 | 18.00-CL-17468642; 18.10-CL-17619277, -17661844; 18.20-CL-17745267, -17792290; 18.21-CL-17811397; 18.30-CL-17882303 | 40.1–41.1 GB | 44.2–45.4 GB | – |
| Chapter 3 Season 3 | 21.10-CL-20696680; 21.20-CL-21035704; 21.50-CL-21657658 | 35.0–36.6 GB | 38.5–40.1 GB | Vibin': Reality Tree, Ballers, Darth Vader and Indiana Jones. Dragon Ball from 21.40. |
| Chapter 3 Season 4 | 22.20-CL-22600409; 22.40-CL-23070899 | 35.9–36.9 GB | 39.5–40.6 GB | Paradise: Chrome, The Herald, Spider-Gwen. Fortnitemares 2022 in 22.20. |
| Chapter 4 Season 1 | 23.40-CL-24087481; 23.50-CL-24441668 | 46.3–46.9 GB | 50.6–51.2 GB | New Chapter 4 island, Reality Augments, Doom Slayer and Geralt. Most Wanted in 23.40. |
| Chapter 4 Season 2 | 24.20-CL-25156858; 24.30-CL-25347382; 24.40-CL-25595478 | 38.5–62.5 GB | 42.6–67.7 GB | MEGA: Mega City, Kinetic Blade. Attack on Titan (24.20), Star Wars (24.30), Ranked (24.40). |
| Chapter 4 Season 3 | 25.11-CL-26171015; 25.20-CL-26629111; 25.30-CL-26867995 | 64.1–64.4 GB | 69.3–69.6 GB | WILDS: jungle, raptors, Optimus Prime. Futurama (25.20), Jujutsu Kaisen (25.30). |
| Chapter 4 Season 4 | 26.20-CL-28096793; 26.30-CL-28688692 | 67.1–73.9 GB | 72.5–79.3 GB | Last Resort: heists, Kado Thorne, Ahsoka Tano. 6th birthday (26.20), Fortnitemares 2023 (26.30). |
| Chapter 4 Season OG | 27.00-CL-29072304; 27.10-CL-29552510; 27.11-CL-29739262 | 74.2–81.5 GB | 79.6–87.3 GB | The Chapter 1 map comes back: Season 5 (27.00), Seasons 7–8 (27.10), Seasons 9–X (27.11). |
| Chapter 5 Season 1 | 28.01-CL-30313795; 28.20-CL-31286935; 28.30-CL-31511038 | 95.8–98.6 GB | 102.9–106.1 GB | Underground: new island, Society bosses, weapon mods, Peter Griffin. Winterfest 2023 in 28.01. |
| Chapter 5 Season 2 | 29.00-CL-32116959; 29.20-CL-32716692; 29.40-CL-33629566 | 101.3–107.7 GB | 108.9–116.2 GB | Myths & Mortals: Mount Olympus, Zeus and Hades bosses, Korra. Star Wars in 29.40. |
| Chapter 5 Season 3 | 30.00-CL-33962396; 30.10-CL-34399867; 30.40-CL-35235494 | 107.8–111.6 GB | 116.0–119.8 GB | Wrecked: wasteland, Nitro cars, Megalo Don, Fallout and Magneto. Metallica (30.10), Fall Guys (30.40). |

**How 21.x–30.x were checked** (26 Oct 2026, about 230,000 HEAD requests over Epic's four hosts): a random
sample is not enough here – Epic deleted the chunks of `FortniteClient-Win64-Shipping.exe` of many builds whose
random chunks all still exist (21.00-CL-20548557 passed 50 of 50 random chunks, but 190 of its 215 exe chunks are
gone). So every chunk of the shipping exe of all 92 builds 21.00–30.40 was checked (64 complete); then 36 of them
got 400 random chunks, up to 600 chunks no neighbouring build uses, every chunk under `Binaries/` and up to 600
chunks no other complete build uses – all present. 21.50-CL-21657658, 22.40-CL-23070899 and 27.11-CL-29739262
were checked chunk by chunk (38,240, 38,720 and 82,973 chunks, all present). The manifests parse with Rift's
own parser (binary, feature level 17 or 21, not encrypted, version and CL as in the catalog, longest path 106
characters). Left out because exe chunks are gone: every 21.00, 22.00 and 23.10 build, most other 21.x–23.x
builds and 24.01-CL-24757023. The downloader still checks every chunk before it writes anything, so a chunk Epic deletes later only
gives `CHUNKS_MISSING`.

28.x–30.x need 103–120 GB on disk and have 98,000–114,000 chunks, so "Check at Epic" takes a few minutes.

Nothing from 31.00 on is ever offered: the catalog is filtered by `SERVER_MAX_EXCLUSIVE` (the game server's
limit), so the live game can never show up (test `new_builds_are_filtered`).

### Seasons that can't be downloaded, and why

| Seasons | Badge | Why |
|---|---|---|
| All of Chapter 1 (1.x–10.x), Chapter 2 Seasons 1, 2 and 4 (11.x, 12.x, 14.x), **Chapter 3 Seasons 1 and 2 (19.x, 20.x)** | **Not available from Epic** | Epic has deleted part of the chunks of every build of these seasons that was checked, so no download can get one complete |

**Not offered yet:** no season has this badge right now (21.x–30.x can be downloaded since 26 Oct 2026). The
status stays in the code for a season the game server isn't ready for: a season with no build in the catalog
whose status says "available" shows it (test `season_without_builds_is_not_offered_yet`).

The text above the cards (once per reason, Rust `NOTE_NOT_FROM_EPIC` / `NOTE_NOT_OFFERED_YET`):
"Epic has deleted part of the files for this season, so no download can get it complete. If you already have
this version on your PC, it keeps working. Add it with 'Add a build'." and "Rift's game server isn't ready
for this season yet, so it isn't offered." The cards themselves say "Epic deleted some of its files." or "The
game server isn't ready for it yet."

**19.10 (Chapter 3 Season 1):** 19.10-CL-18675304 needs 46,040 chunks. 11,655 of them (25.3 %) are gone
from all four hosts (404). That breaks 631 of its 751 files, among them `FortniteClient-Win64-Shipping.exe`
(191 of its 192 chunks are gone). None of the 12 builds of Chapter 3 Season 1 (19.00–19.40) was complete.
So no download can get 19.10, wherever the manifest comes from. A 19.10 you already have keeps working;
if it is in your Library, the Season 1 card says "Your 19.10 keeps working." The test
`builtin_catalog_is_valid` makes sure 19.10 never gets into the catalog.

Inside the offered seasons, builds that were not complete in the check are left out too (e.g. 18.40, 21.00,
22.00, 23.10).

### Steps of one download (`download/mod.rs` `job_steps`, `epic/install.rs`)

The UI shows four steps: **Check at Epic**, **Download**, **Check files**, **Add to Library**.

1. **File list:** the copy saved in the folder by an earlier run (if its SHA-1 still matches), or a fresh
   download from the archive (3 tries per archive). SHA-1 check, then parse (binary or JSON format; encrypted
   manifests and format 22 and newer are refused). The version and CL inside must match the catalog entry.
2. **Folder checks** (`epic/folder.rs`; the drive facts come from the Windows API in `download/disk.rs`), in
   this order: path longer than 100 characters → `PATH_TOO_LONG`; inside Rift's own install folder →
   `OWN_FOLDER`; under Program Files or Windows → `WRITE_FAILED`; under OneDrive → `ONEDRIVE`; a network drive
   or `\\server\share` → `NETWORK_DRIVE`; FAT, FAT16 or FAT32 → `FAT32`; other files in the folder (and no
   unfinished download of this build) or an unfinished download of another build → `NOT_EMPTY`; less free
   space than the bytes still to write + 2 GiB → `NOT_ENOUGH_SPACE`. Then a write test (the folder is created,
   `.rift-write-test` is written and deleted). `download_start` already runs the same checks with the full
   size, so a bad folder is refused before the download starts, and its text shows under the folder field.
   Default folder: `<fixed drive with the most free space, no FAT>:\Rift\Builds\<version>-CL-<cl>`.
3. **Check at Epic:** a HEAD request for every chunk still needed, 32 at a time ("Checking that Epic still has
   every file… (a few minutes)" – about 1 minute for a 40 GB build, a few minutes for the 100+ GB builds of
   28.x–30.x). The first chunk Epic no longer has (404 from two hosts) stops everything with
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

### Pause, resume, cancel, closing Rift

- **Pause:** every worker stops between chunks; a chunk still arriving is dropped (the body is read in 64 KB
  pieces and Pause is checked between them). Everything written stays. A connection that sends nothing at all
  can hold Pause until its 30 s timeout.
- **Resume** runs all steps again in the same folder: the saved manifest is used, finished files (in the
  journal and with the right size) are skipped, a half-written `.part` continues from its last noted position,
  and "Check at Epic" only covers the chunks still needed. Starting the same build again into a folder that
  has its unfinished download does the same.
- Only **one download runs at a time** ("Another version is downloading. Pause it first, then start this one.").
- Unfinished downloads (running, paused, stopped by an error) are kept in `%APPDATA%\Rift\downloads.json`.
  Closing Rift pauses a running download ("Close Rift?" lists it as "Download (18.30)"); after the next
  start it is back as **Paused**.
- **Cancel** asks "Delete the downloaded files?"; **Keep files** is the default. **Delete files** removes only the
  build's own files (finished and `.part`), `.rift-download\` and the folders that are empty afterwards –
  nothing else. A finished build is never deleted from here.

### Error codes and texts (`epic/errors.rs`, shown as they are)

| Code | Text |
|---|---|
| `MANIFEST_UNAVAILABLE` | "Rift couldn't get the file list for this version. Check your internet connection and try again later." |
| `MANIFEST_MISMATCH` | "The file list for this version isn't what Rift expects, so nothing was downloaded. Please update Rift." |
| `CHUNKS_MISSING` | "Epic no longer has all the files for this version, so it can't be downloaded. Nothing was downloaded. Pick another version, or add a copy you already have with 'Add a build'." |
| `EPIC_BLOCKED` | "Epic's download servers refused the download. Nothing is wrong with your PC. Please try again later." |
| `NETWORK` | "The connection to Epic's download servers dropped. Press Resume and Rift continues where it stopped." |
| `NOT_ENOUGH_SPACE` | "There isn't enough free space on drive D:. This version needs 47.5 GB and 12.3 GB is free. Free up space or pick another folder." ("this drive" when the letter is unknown) |
| `FAT32` | "Drive E: can't hold files bigger than 4 GB (FAT32). Pick a folder on another drive." |
| `ONEDRIVE` | "This folder is synced by OneDrive. Pick a folder outside OneDrive, or it will try to upload the whole game (up to about 120 GB)." |
| `NOT_EMPTY` | "This folder already has other files in it. Pick an empty folder." |
| `WRITE_FAILED` | "Rift can't write to this folder. Pick another one (not inside Program Files)." |
| `VERIFY_FAILED` | "A downloaded file was still damaged. Please try again later." |
| `IMPORT_FAILED` | "The download finished, but Rift couldn't recognise the version in the folder." |
| `NETWORK_DRIVE` | "This folder is on a network drive. Pick a folder on a drive inside your PC." |
| `PATH_TOO_LONG` | "This folder's path is too long. Pick a shorter one, like D:\Rift\Builds." |
| `OWN_FOLDER` | "This folder belongs to Rift itself. Pick another one." |
| `ALREADY_RUNNING` | "This version is already downloading." |
| `ANOTHER_RUNNING` | "Another version is downloading. Pause it first, then start this one." |
| `UNKNOWN_BUILD` | "Rift can't download this version." |

When files of the build are already in the folder (it has a journal), three codes use other texts
(`after_files_written`; `filesKept: true` in the event):

- `CHUNKS_MISSING`: "Epic no longer has all the files for this version, so the download can't be finished.
  Remove it to free the space, then pick another version or add a copy you already have with 'Add a build'."
- `MANIFEST_MISMATCH`: "The file list for this version isn't what Rift expects, so the download can't go on.
  Please update Rift."
- `WRITE_FAILED`: "Rift couldn't write to the download folder. Free up space on the drive or close programs
  that use the folder, then press Resume."

The error card shows a short title (`errorTitle` in `downloads.ts`) above the text and the buttons that fit:
Resume, Try again, Pick another folder, Open folder, and Close (nothing on disk) or Remove (asks Delete/Keep).

### Tauri API

| Command | Answer |
|---|---|
| `catalog_list` | `{ checkedOn, chapters: [{ chapter, label, seasons: [{ season, label, versions, status: "available" \| "notFromEpic" \| "notOfferedYet", note, about, builds: [{ key, version, cl, downloadBytes, installedBytes, badge: "tested" \| "experimental", note }] }] }] }` |
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
| `livingWorld` | false | Bosses & NPCs on (see [Bosses & NPCs](#bosses--npcs-living-world-experimental)) |
| `livingWorldMaxAI` | 40 | most bosses and NPCs at once, 1–100 (clamped when sent) |

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
- "Match Control" → "Game": the start card shows the chip "AI bots 30 · Easy" ("Off" when the server said no
  this match; the answer is forgotten at `matchEnd` and when the game server stops).
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
rewrites, its backend, and its storm, inventory and loadout code (Rift has its own).

**Log lines:** every `[PlayerBots] …` line goes to the server's stdout handle, so it shows in the live log
(source Server, category `bots`, without the tag). Lines with "disabled", "failed", "fail:", "unavailable", "not
available" or "error" are warnings (`logparse.rs`, `tagged_line`). Other lines you may see: "bot service started",
"MMR bracket … to …, … bot types, ELO …", "spawn amount: … bots (max players …, humans …)", "1 bots spawned" and
every 10th, "… default outfits for bots", "cached … POI volumes and … foundations", "Error: …".

### Bosses & NPCs (living world, experimental)

The goal: the season's bosses, guards and creatures walk around, like back then. **Today no version spawns
any of them.** The game server is built in steps, season by season (19.10 first). Until a season is built,
the server answers "unavailable" with the reason "not built yet for this version" (`native/server`,
`LivingWorld.cpp`, `FLivingWorldHooks::Hook`). What exists now: the profile switch, the two pipe keys, the
pipe event, the status chip, the live-log lines and the topic filter. This section is the launcher side.
Code: `launcher/core/src/livingworld.rs`, `bots.rs` (`server_config_for`), `profiles.rs`, `logparse.rs`,
`launcher/src-tauri/src/engine.rs`; UI `launcher/src/lib/livingworld.ts`, `ProfilesPage.tsx`, `MatchPage.tsx`,
`LogsPage.tsx`, `store.ts`.

- **Profile:** `livingWorld` (default false) and `livingWorldMaxAI` (default 40; JSON key with a capital "AI").
  Old profiles load with these defaults. A new profile and the "Default" profile have it off.
- **Profile editor:** in the "Match rules" box, the switch "Bosses & NPCs" with the badge "Experimental", the hint
  "Bosses, guards and creatures of this season walk around, like back then. Still being built: not every season
  has them yet." and the slider "Max. bosses & NPCs" (1–100). It doesn't change "Classic match" (bosses were
  there back then), and the "Classic" button leaves it alone. When on, the profile gets the tag "Bosses & NPCs".
- **Match Control → Game → "Game mode":** the same switch and slider for the running server (only before "Start
  match"; they send `config` `bLivingWorld` / `LivingWorldMaxAI`; switching on also sends the max shown, because
  it isn't sent at connect while the profile has the switch off). Once the server has answered with the switch
  on, the row "This match" shows a status chip: "Not available: <reason>" (warning; today always "Not available:
  not built yet for this version") or, once a season is built, "Active · 12 spawned" (green; just "Active" while
  `spawned` is 0).
- **Switch off = nothing changes:** the keys aren't sent, the server answers "off", and the launcher shows no
  chip, no pop-up and no live-log line for it.
- **Pipe keys** (sent when the pipe connects, after the bot keys, before the map loads, **only when the profile
  has the switch on** – the server's default is off): `bLivingWorld` = true, `LivingWorldMaxAI` 1–100
  (`livingworld::clamp_max_ai`). So a server that is already past "Start match" when the pipe connects only
  refuses them (a "Server" pop-up) when the switch is on.
- **Pipe event** `{"event":"livingWorld","state":"unavailable"|"active"|"off","reason":"…","spawned":N}` →
  Tauri event `server:livingWorld` `{ state, reason, spawned }` on every event. The server sends one at "Start
  match": today "unavailable" (switch on) or "off" (switch off); "active" comes once a season is built, and if
  the server sends more (e.g. with a new `spawned`), the chip follows.
  - Live log (source Rift, category `livingWorld`): a line only when the switch is on and the state or the
    reason changed within the match: "Bosses & NPCs aren't available: <reason>" (warning), later "Bosses &
    NPCs are on: 12 spawned." (or "… are on for this match." while 0). "off" never gets a line. After `matchEnd`
    the next match gets its own line.
  - Pop-up "Bosses & NPCs aren't available this match" with the reason: at most once per match for each reason.
  - The chip, the AI bots answer (`server:playerBots`) and the pop-up memory are cleared at `matchEnd` (the
    server can stay open for the next match) and when the game server stops.
- **Log lines:** `[LivingWorld] …` lines of the server get the category `livingWorld` (source Server, without the
  tag); lines with "disabled", "failed", "fail:", "unavailable", "not available" or "error" are warnings (same
  rule as `[PlayerBots]`). With the switch on the server writes these lines today too (e.g. "unavailable: not
  built yet for this version (Fortnite 19.10, max AI 40)"); they help build the next seasons, so the test
  checklist asks for them. The Live Log has a topic filter for our own server lines: "Loot", "AI bots" and
  "Bosses & NPCs" (click the active one again to see everything).

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
`OnPlaylistLootTablesAppliedDelegate` (19.x, e.g. 19.10), every spot is rolled once with Rift's loot tables
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
rights; default folder `%LOCALAPPDATA%\Rift`), English only, no language picker, LZMA compression, the
Rift icon for installer and uninstaller, `windows/assets/header.bmp` (150 × 57) and
`windows/assets/sidebar.bmp` (164 × 314), and the hooks in `windows/hooks.nsh`:

- dark look: background `#0A0B12`, text `#F2F3F8`, classic controls so the Finish page checkboxes use the
  text colour, link colour `#B49BFF`;
- before the wizard a fading splash (`windows/assets/splash.bmp`, AdvSplash, magenta `#FF00FF` is see-through;
  not for `/P` passive or `/UPDATE` runs);
- a dark title bar on Windows 11 (installer and uninstaller; harmless on Windows 10);
- English texts: "Welcome to Rift", "You're ready to drop.", the checkbox "Launch Rift now" and the link
  "Source code and help (GitHub)" → https://github.com/georghatzmann-bit/vanity-;
- after installing it goes straight to the Finish page (`SetAutoClose`);
- **old Niobium or Vanity install:** for each of the old names (macro `REMOVE_OLD_LAUNCHER` in `hooks.nsh`,
  first Vanity, then Niobium): if the uninstall entry
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<old name>` exists, the installer runs the old
  `uninstall.exe` silently first ("Removing the old Niobium launcher..."). That only removes the old
  program files and shortcuts; the folder is removed only if it is empty, so settings, server data,
  backend data, logs and builds stay for the [migration](#moving-over-from-niobium-and-vanity).

The images are 24-bit uncompressed BMPs with a 40-byte header and no alpha; the workflow checks this before it
builds. Uninstalling Rift keeps `%APPDATA%\Rift`, the data folders in
`%LOCALAPPDATA%\Rift` (`backend-data`, `server`, `logs`) and your Fortnite builds.

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

Early log lines: lines the launcher writes while it starts (e.g. "Copied your settings from Niobium …" or a
fixed-port note) come before the UI listens, so a `log:line` event then would be lost. They wait in Rust
(`launcher/core/src/earlylog.rs`, at most 500). The UI calls `pending_log_lines` once, right after its
`log:line` listener is registered, and puts them before newer lines; from then on every line comes as an
event. If the UI never asks, Rust sends them as events 10 s after the main window shows.

Events: `services`, `launch:step`, `log:line`, `toast`, `server:event`, `trickshot`, `detect`,
`bubble:ini-changed`, `app:close-requested`, `server:playerBots` (`{ state, reason }`), `server:livingWorld`
(`{ state, reason, spawned }`), `download:progress`, `download:done`, `download:error`, `download:state`.

New settings keys in `config.json`: `bubbleBuilds` (true/false, default false) and `lastSeenVersion` (text
or null). New profile keys: `infiniteAmmo`, `infiniteMats`, `bots`, `botCount`, `botSkill` (see
[Match rules](#match-rules-classic-match)), `livingWorld`, `livingWorldMaxAI` (see
[Bosses & NPCs](#bosses--npcs-living-world-experimental)).
