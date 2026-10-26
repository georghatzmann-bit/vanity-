# niobium_client.dll – in-game menu

The in-game menu (F9) comes from **ATLAS Console** (https://github.com/Ralzify/ATLAS-Client),
© ralz, cipherfps and contributors, licence: *ATLAS Console Attribution License v1.0* (see `LICENSE-ATLAS.txt`).
ATLAS Console is itself built on the **Erbium** SDK (GPL-3.0, `LICENSE-Erbium.txt`) and **Memcury** (MIT, `LICENSE-Memcury.txt`).

> Niobium is based on ATLAS Console by cipherfps, ralz and contributors.

## What Niobium changed

Every change in the files is marked with `// [Niobium]`.

| Area | Original | Niobium |
|---|---|---|
| Settings | `%APPDATA%\ATLAS\console.json` | `%APPDATA%\Niobium\client.json` |
| Diagnostics log | `%APPDATA%\ATLAS\diagnostics.log` | `%LOCALAPPDATA%\Niobium\logs\client-diagnostics.log` |
| MinHook | prebuilt `minhook.lib` | built from source, project `native/minhook` |
| Visible names | "ATLAS" | "Niobium" (title bar "Niobium \| Menu"), with ATLAS Console named in the "Credits" tab |
| Project file | `ATLAS.vcxproj` | `client.vcxproj` (static runtime, shared output folder, target name `niobium_client`) |
| Tabs | Main, Commands, Config, Credits | **Main, Commands, Options, Trickshot, Credits**. "Trickshot" is new (new files `ATLAS/Private/NiobiumTrickshotTab.cpp` and `ATLAS/Public/NiobiumTrickshotTab.h`) |
| Texts | English | Plain, short English with a grey hint under each toggle. `GUI.cpp` stays pure ASCII (it is built without `/utf-8`): the few special characters come from the UTF-8 macros `NB_DASH` (en dash) and `NB_NBSP` (no-break space) |
| Colours | ATLAS blue `#00A2CE` | Niobium brand colours (violet accent `#7A3CFF`, backgrounds `#0A0B12` / `#11131C`, see `docs/brand.md`) |
| Bubble Builds | – | Read-only status row in "Options" (see below) |
| Bubble look | – | "Bubble look" switch + "Bubble strength" slider in "Main" → "Graphics" (see below; new header `ATLAS/Public/BubbleLook.h`, runtime in `Client.cpp`) |
| Editing | three switches, each only below a fixed version | always shown; each switch uses exactly one route per version: our hook, or Fortnite's own setting (see below; new header `ATLAS/Public/EditFeatureRoutes.h`) |
| Reset builds | – | aim at an edited build and press your own key (Options → "Reset builds"; client half, needs the Niobium server; new files `ATLAS/Public/QuickReset.h`, `ATLAS/Private/QuickReset.cpp`) |
| Server messages | console only | also a Trickshot banner for messages that start with `[Niobium] TRICKSHOT` (marked in `Client.cpp`) |
| `imgui.ini` | written next to the game | never written (`io.IniFilename = nullptr`) |

Not changed: game logic (respawns, FOV, console, hotkeys, Arena HUD, hotfix reload). Edit on
release, Reset on release and Disable pre-edits keep their hooks on old versions (now with checked
targets and results, see "Editing" below). Internal ids such as `ATLAS_ARENA_*` stay, because the game server
expects the same texts. The JSON keys in `client.json` and the ImGui `###` ids also stay, so saved
settings keep working.

## What the menu can do

Tabs in the F9 menu (names as shown in the game):

- **Main:** "Join a server" (on this PC or by IP), "Editing" (Edit on release, Reset on release,
  Disable pre-edits: our hook or Fortnite's own setting, depending on the version), "Graphics" (Mobile Builds, Bubble look with
  Bubble strength, In-game fog, Simpler textures), "Field of view", "Respawn" (Respawn after you die), "Other" (First person, Free camera,
  Target info). "Always sprint" was removed: it is always off, and an old `"sprintByDefault": true`
  in `client.json` is ignored.
- **Commands:** your own commands and command chains, each with its own key
- **Options:**
  - "Build look": the Bubble Builds status row (see below)
  - "General": Which console?, Open the console with the … key (the key's name depends on the keyboard: `/` on US, `#` on German), Remember my settings
  - "Reset builds": the switch, "Reset builds key [none]" and a status line (see below)
  - "Keys": Change menu key (F9), Change join key (F5), Reset everything
- **Trickshot:** four sections:
  - "Load a parkour": one card per course from `%LOCALAPPDATA%\Niobium\server\parkours.json` (written by
    the launcher) with a "Load" button; below that "Start over" and "Clear everything"
  - "Target bot": sliders "Health" (1–200) and "Distance" (5–100 m), "Place bot in front of me",
    "Remove all bots", "Bring bots to me"
  - "Gear": Give sniper, Give launch pads, Refill ammo, Refill health
  - "Practice": Save spot, Back to spot, Launch me up, Slow motion, Low/Normal gravity,
    Invincible, Pause/Resume storm

  Every button sends a `cheat …` command to the Niobium server (`parkour …`, `targetbot …` and existing
  Magnesium commands; the list is in `docs/02-architecture.md`). "Save spot" / "Back to spot" use the
  waypoint name `niobium`, the same one as the launcher's match page. In the lobby the tab shows a hint at the top.
- **Credits:** names Erbium and ATLAS Console (with a link)
- **Console:** F8 – commands, history, tab completion, `/give`, `/startaircraft`, `/god`
- **Trickshot banner:** a big "TRICKSHOT!" at the top centre of the screen for 3.5 s, also when the
  menu is closed and in both console modes.

### Bubble Builds status (Options → "Build look")

Bubble Builds is the see-through "bubble wrap" build look of Chapter 2 Seasons 5–6. It only exists
in Performance Mode (the ES3.1 renderer), and the game can't switch it while playing. The launcher turns
it on by starting the game client with `-FeatureLevelES31`, so the menu only reports what the launcher did:

- it reads `GetCommandLineW()` for `-FeatureLevelES31` (or `-FeatureLevelES3_1`), case-insensitive,
  whole switch only;
- it uses the version the game reports, with `-niobiumversion=` from the launcher as a fallback;
- same version rules as `VersionRules` in `launcher/core/src/launchargs.rs`: supported 15.40 to
  below 16.10, experimental 15.30 and 16.10 to below 16.50, "lowMeshes" 19.00 to below 20.00
  (Chapter 3 Season 1: Performance Mode with Meshes set to Low, also shown as experimental),
  everything else not available.

It shows `Bubble Builds: On (set in the launcher)`,
`Bubble Builds: Off – turn it on in the launcher, then restart the game.` or
`Bubble Builds: Not available on <version>`, plus an "Experimental" badge where it applies. On 19.x
and, in Performance Mode, on 15.40–16.00 the game's Meshes setting decides too (`GetMeshQuality()`,
read on the game thread every 2 s on 19.x and whenever `-FeatureLevelES31` is set from 15.40 on). Meshes only applies after a restart, so the row follows the first value of the session:
Low reads `Bubble Builds: On (Performance Mode, Meshes Low)`, High reads
`Bubble Builds: Performance Mode is on, but Meshes is High. Set Meshes to Low in Video settings, then restart.`,
and a value that can't be read reads `Bubble Builds: On (Performance Mode)`. If the player changes
Meshes during the session, the row says that a restart is needed
(`Bubble Builds: Meshes is now Low. Restart the game to turn them on.` or
`… You set Meshes to High, so they turn off after a restart.`).
The "Mobile Builds" toggle in "Main" works on every version, right away.

### Bubble look (Main → "Graphics")

A look-alike that works on any version, with no restart: it lowers the detail of the four build
blueprint textures in `/Game/Packages/Fortress_SharedMaterials/` (`BluePrintTexture02`,
`BluePrintTexture04`, `BlueprintTextureMetal`, `BrickBlueprintTexture`), which draw the see-through
part of builds. Only you see it.

- On the game thread, about once per second (`MaintainBubbleLook` in `Client.cpp`, called from
  `ClientGameThreadTick`): each texture is found with `StaticFindObject` (never loaded), the
  transient `CachedCombinedLODBias` int is found by name on the texture class (int property, inside
  the object, value 0–15). While Bubble look's value isn't in place, the game's current value is
  the original (re-read every tick), so "on" writes original + strength (max 15) and "off" writes
  back exactly what the game had just before. A new texture object (map change, reload) or a value
  the game changed itself becomes the new original. Textures with `NeverStream` set (the bias does
  nothing there) and values outside 0–15 are never touched. SEH + `IsLiveUObject` guard every
  access. Nothing else is written, and a game restart resets it.
- Saved in `client.json` like Mobile Builds: `"bubbleLook"` (default `false`) and
  `"bubbleStrength"` (1–8, default 5). Older files without these keys load with the defaults.
- Pause rule: while Epic's own bubbles are really on (started with `-FeatureLevelES31`, a supported
  or "lowMeshes" version, Meshes Low at session start) Bubble look puts the original values back and
  shows `Paused: Bubble Builds are already on. Bubble look would only blur them more.` On the
  experimental versions in Performance Mode it still applies, with the hint
  `Lower Bubble strength if builds look too blurry.`
- Status under the switch: `Bubble look: waiting for the build textures. Place one build piece.`,
  `Bubble look: on (<n> of 4 build textures)` (n = textures actually changed) or
  `Bubble look isn't available on <version>.` The last one shows when the property is missing,
  when no texture found can be changed, when none of the textures showed up after about 3 minutes
  in a match (it keeps looking and switches on if one shows up later), or when the game-thread
  pump isn't running on this client build.
- Debug probe (off by default, never writes): add `"bubbleProbe": true` to the `"preferences"`
  object in `client.json`. The DLL then logs `bubble-probe …` lines to `client-diagnostics.log`:
  per texture found/address/offset/`CachedCombinedLODBias`/`NeverStream`/`LODGroup`/`LODBias`, and
  `IsInPerformanceMode()` / `GetMeshQuality()` through `FortKismetLibrary.GetFortGameUserSettings()`.
  The key is only written back while it is on.

### Editing (Main → "Editing")

Each of the three switches uses exactly one route per game process
(`ATLAS/Public/EditFeatureRoutes.h`, the same rule for the menu and the hooks):

| Switch | Our hook (detour) | Fortnite's own setting (`UFortClientSettingsRecord`) |
|---|---|---|
| Edit on release | below 11.00 (SelectEdit) | 11.00+ `Get/SetEditConfirmOnReleaseEnabled` ("Confirm Edit on Release"; from 24.30 "Auto Confirm Edits" → Edit) |
| Reset on release | below 24.30 (SelectReset) | 24.30+ `Get/SetResetConfirmOnReleaseEnabled` ("Auto Confirm Edits" → Reset) |
| Disable pre-edits | below 15.20 (PerformBuildingEditInteraction) | 15.20+ `Get/SetDisablePreEditsWhenPlacingBuilding` |

- 10.x has Epic's Edit on release only for mobile, and 15.10's pre-edit option only reset edits when
  leaving build mode, so both stay on our hook there. Epic's settings are never written there.
- Hooks: every target from the byte search must be inside `.text`, look like a function start and be
  different from the others; each hook is created and enabled on its own and both results are checked.
  A failed hook greys the row out: `Couldn't be set up on this version.` The same happens to Edit
  and Reset on release when the game's complete-edit function crashes once (it is then switched off).
  The detours also check that their feature really uses the hook before doing anything.
- Fortnite's own setting: found by name on the game thread (getter with one 1-byte return, setter
  with one 1-byte input), read about once a second. The switch shows Fortnite's value and only a
  click writes it (setter, then read back). Never written at startup and never saved in
  `client.json` (the `editOnRelease` / `resetOnRelease` / `disablePreEdits` keys only drive the hooks).
  Rows: `Waiting for Fortnite's settings...`, `Not available on <version>.` (no such setting) and
  `Couldn't change it here. Use Fortnite's settings (Game, Building).` (a write didn't stick; off for
  the rest of the session).
- Log: `edit-hooks …` and `edit-routes startup|native version=… eor=… ror=… pre=… complete=…`.

### Reset builds (Options → "Reset builds")

Aim at one of your edited builds and press your Reset builds key: it goes back to normal without
opening edit mode. This is the client half; the Niobium server does the reset.

- Off and without a key by default (`"resetBuilds"`, `"resetBuildsKey"` in `client.json`). Never the
  left or right mouse button, never a key Niobium already uses (menu, join, console, saved commands).
  The key is never swallowed and never goes through the command/macro binds, so Fortnite still gets it.
- WndProc only stamps the press, and not while F9, our console or Fortnite's own console is open.
  Unreal keeps its console state to itself, so it is followed from the keys that reach the game
  (`NextGameConsoleState` in `QuickReset.h`: the console key cycles one line → full → closed, Enter
  closes the one-line console, Esc clears a typed line first and then closes); when unsure it counts
  as open, and F9 then shows "Close the original console first (Esc)."
- The game-thread pump (every frame) ignores a press in edit mode (or within 50 ms after it), with the
  mouse cursor shown, in the lobby, before the server acked, and within 100 ms of the last reset. The
  target is the game's own `TargetedBuilding` (a build preview is redirected to the highlighted placed
  piece): a player-placed wall, floor, stair or roof of your team that nobody is editing. A team that
  can't be read on either side counts as "not yours".
- Wire format (plain ASCII, lowercase hex, via `ServerCheat` with `ProcessEvent`, never a console
  `cheat …`): hello `nbedit:v1:h:<session16>` (28 chars, up to 5 times, 1.5 s apart, only while the
  switch is on and a key is set; an old Niobium server answers with its command list, which stops the
  hellos for that match; turning the switch off and on again, or picking another key, asks once
  more), ack from the server through `ClientMessage`
  `nbedit:v1:a:<session16>` (hidden from the console), then per reset two RPCs back to back:
  `ServerCheat("nbedit:v1:r:<session16>:<seq8>")` and
  `ServerEditBuildingActor(Target, Target->Class, 0, false)`.
- Status: `Ready.`, `Pick a key first.`, `Join a match to use it.`, `Checking the server...`,
  `This server can't do it. It needs a Niobium server.`, `Not available on this version.` and the
  key-conflict lines. From 37.00 (Epic's own "Reset Building" key) the row is replaced by a hint.
- Debug probe (never sends): `"resetBuildsProbe": true` in `"preferences"` logs what the targeting
  sees twice a second and why a press was ignored.

## Building and preview

`ATLAS/Private/NiobiumTrickshotTab.cpp` needs neither `pch.h` nor game headers (only ImGui and
`third_party/nlohmann/json.hpp`, MIT, unchanged from `native/server/json.hpp`, licence in
`third_party/nlohmann/LICENSE.MIT`). It is built with `/utf-8` and also compiles on Linux for the
menu screenshots (`native/tools/menu-preview/build-and-render.sh <output folder>`).

The launcher loads the DLL into the game after login (`-nullrhi` processes detect that they are a
server without a window and turn input off).
