# Phase 0 – Research and plan

> This is the plan from 23 October 2026, when the project was still called **Vanity**. It was renamed
> to **Niobium** on 26 October 2026. Some details turned out differently in the end (for example the
> backend uses Express from LawinServer instead of Fastify, and the folders under `native/` are
> `redirect/`, `server/` and `client/`). The current state is in
> [`02-architecture.md`](02-architecture.md).

Status: 23 Oct 2026. For each project, the latest state was read:

| Project | Status (last commit) | What it is |
|---|---|---|
| [Auties00/reboot_launcher](https://github.com/Auties00/reboot_launcher) | 05 Sep 2026 | launcher (Flutter/Dart) |
| [plooshi/Erbium](https://github.com/plooshi/Erbium) | 05 Sep 2026 | game server (C++) + small client "ErbiumClient" |
| [Ralzify/Magnesium](https://github.com/Ralzify/Magnesium) | 04 Sep 2026 | game server, a heavily extended copy of Erbium |
| [plooshi/Tellurium](https://github.com/plooshi/Tellurium) | 16 Feb 2026 | redirect DLL |
| [Ralzify/ATLAS-Client](https://github.com/Ralzify/ATLAS-Client) | 04 Sep 2026 | in-game menu (F9) |
| [Lawin0129/LawinServer](https://github.com/Lawin0129/LawinServer) | 16 Oct 2026 | backend (Node.js) |

---

## 1. How the parts work together

After it starts, an OG Fortnite build wants to talk to Epic's servers (login, locker, lobby,
matchmaking). For old versions those servers don't exist any more. That's why five parts are needed:

```
 ┌──────────────┐ starts  ┌────────────────────────────────────┐
 │   LAUNCHER   │────────▶│ BACKEND  (127.0.0.1:3551)          │
 │              │         │ plays "Epic": login, locker, lobby, │
 └──────┬───────┘         │ matchmaking → "server is :7777"     │
        │                 └──────────────────▲─────────────────┘
        │ starts Fortnite twice              │ every request to Epic
        ▼                                    │ is redirected here
 ┌──────────────────────────────┐   ┌────────┴─────────────────────┐
 │ Fortnite #1 = SERVER          │   │ Fortnite #2 = YOUR GAME       │
 │ + redirect DLL  (Tellurium)   │   │ + redirect DLL  (Tellurium)   │
 │ + game server DLL (Erbium /   │◀──│ + overlay DLL   (ATLAS, F9)   │
 │   Magnesium), port 7777       │   │                               │
 └──────────────────────────────┘   └───────────────────────────────┘
```

How Reboot does it (read in `gui/lib/src/button/game_start_button.dart`):

1. The **launcher** starts the **backend** (a packaged copy of LawinServer, port 3551).
2. The launcher starts **Fortnite #1** as the server (without graphics if wanted, `-nullrhi`).
   Right after that it loads the **redirect DLL** into it.
3. The **redirect DLL** (Tellurium) hooks into Fortnite's built-in HTTP part and rewrites every
   address like `…ol.epicgames.com` to `http://127.0.0.1:3551`. The backend answers "login okay".
4. The launcher reads the game log. As soon as it says "login done", it loads the
   **game server DLL** (Erbium/Magnesium). That turns this Fortnite into a real server: turn off the
   player part, load the map (Chapter 3: `Artemis_Terrain`), open port 7777 and take over all the game
   logic Epic would normally do (inventory, loot, storm, bus, building, eliminations).
5. The launcher starts **Fortnite #2** = your game, again with the redirect DLL → you land in the
   lobby. After the login it loads the **overlay DLL** (ATLAS): menu on F9, console, Edit on Release
   and so on.
6. You press "Play": the matchmaker in the backend answers "server is 127.0.0.1:7777"
   (`Config/config.ini` → `[GameServer]`). Your game connects to Fortnite #1.

Your current Reboot setup fits this exactly: in `settings\v3_dll_storage.gs`, `backend` = redirect
(Tellurium for you), `game_server` = game server (Magnesium), `unreal_engine_console` = overlay (ATLAS),
`memory_leak` = memory-leak fix (Chapter 1 only).

### Technical details that matter for us

- **Loading DLLs ("injection")**: Reboot uses the standard way `LoadLibraryA` +
  `CreateRemoteThread` (`common/lib/src/util/os.dart`).
- **Launch arguments** (Reboot, `game_metadata.dart`): `-epicapp=Fortnite -epicenv=Prod
  -skippatchcheck -nobe -fromfl=eac -fltoken=… -caldera=… -AUTH_LOGIN=… -AUTH_PASSWORD=…
  -AUTH_TYPE=epic`, for the server also `-nosplash -nosound` (and `-nullrhi`).
- **Helper processes**: Reboot starts `FortniteLauncher.exe` and
  `FortniteClient-Win64-Shipping_EAC.exe` and pauses them at once (they never really run).
  The old game only checks that they exist. See decision 3 at the end.
- **Version detection**: Reboot reads the file info of `CrashReportClient.exe`
  (e.g. `++Fortnite+Release-19.10-CL-18675304`) and has a table build number → version.
  19.10 = CL 18675304 is in it.
- **Log detection**: "login done" = a line with `[UOnlineAccountCommon::ContinueLoggingIn]`
  and `(Completed)`. "Build broken" = e.g. `Pak chunk signature verification failed!`.
  "No connection" = e.g. `port 3551 failed: Connection refused`. "Match over" =
  `TeamsLeft: 1`.
- **Environment variable** `OPENSSL_ia32cap=~0x20000000`: prevents a known crash of old OpenSSL
  versions on new Intel CPUs. Only applies to the started process.
- **Erbium/Magnesium** don't need a built-in SDK per version. They find functions and fields at
  runtime through patterns and Unreal's own type info (`Finders.cpp`, `SDK/`). That's why they run on
  many versions. Erbium: full support 3.4 to 19.40 – so 19.10 too.
- **As far as is known, 19.10 already runs on Unreal Engine 5.0** (Chapter 3 was the switch to UE5).
  From UE 5.0 Erbium switches extra things
  (e.g. `bWaitForServerToBeInitializedBeforeTravelingFeatureEnabled = false`). We check this
  automatically when a build is imported.
- **Why Reboot's console.dll crashes on 19.40 (very likely)**: ErbiumClient (the base of many console
  DLLs) touches game objects from its *own* thread (`ClientThread()` in `ErbiumClient/Private/Client.cpp`
  runs every 33 ms next to the game). Unreal doesn't allow that – depending on the version it crashes
  with "Access Violation". ATLAS solved it: every command goes into a mailbox and runs in the game's
  tick (hook on `UEngine::GetMaxTickRate`, so in the game thread). **We take this over as a basic rule:
  we only touch game objects in the game thread.**
- **Overlay**: ATLAS hooks DirectX 11/12 `Present` and `ResizeBuffers` (through a helper swap chain)
  and the window messages (`WndProc`). The standard way; we do it the same.
- **"Join Local Host"** is simply the console command `open 127.0.0.1` in ATLAS.
- **Bots**: Magnesium has "Spawnbots" through the cheat manager (name, health, shield can be set).
  These are more like player dummies. None of the projects has real AI opponents (walking, building,
  shooting) ready → that is the hardest part of the plan.
- **Backend**: LawinServer = Express (HTTP, port 3551) + XMPP/matchmaker over WebSocket on port 80.
  Profiles (locker, skins) are JSON files in `profiles/`, answers in `responses/`.

---

## 2. Licences – what we may do

| Project | Licence | What it means for us |
|---|---|---|
| Reboot Launcher (GUI, common, cli) | **no licence file** → all rights with the author | Only read it and learn from it. **Don't copy code.** Rebuilding how things work is allowed. |
| Reboot `auth_backend` | GPL-3.0 | a LawinServer offshoot |
| Erbium + ErbiumClient | **GPL-3.0** (since 16 Aug 2026, BSD-3 before) | Taking code over is allowed. Then our game server must be GPL-3.0 too and name the source. |
| Magnesium | BSD-3 (copyright Ploosh) | Not a Git fork but a code import from 11 Jan 2026 (Erbium was BSD then). Taking it over is allowed with the copyright notice. Whether later parts came from the GPL Erbium can't be told for sure → no problem if our project is GPL-3.0. |
| Tellurium | BSD-3-Clause | Taking it over is allowed; keep the copyright notice and name the author. |
| ATLAS-Client | own "ATLAS Console Attribution License" | Use is allowed, but with the required notice "Based on ATLAS Link…" in a visible place. The text confusingly talks about "ATLAS Link" (a launcher). **Recommendation: copy no ATLAS code, only ideas.** We write our own menu. |
| LawinServer | GPL-3.0 | Rebuild in TypeScript + take over the JSON data → our backend becomes GPL-3.0. |
| MinHook | BSD-2-Clause | free to use with a notice |
| Dear ImGui | MIT | free to use with a notice |
| Memcury | MIT | free to use with a notice |

**Recommendation: the whole project becomes GPL-3.0.** That fits all the licences above. Consequence:
if you ever publish the launcher, the source code must come with it. All sources go into
`THIRD_PARTY_NOTICES.md` and into a "Credits" area in the launcher.

(What happened later: the in-game menu *is* based on ATLAS Console after all, with the required
notice "Niobium is based on ATLAS Console by cipherfps, ralz and contributors." in the Credits tab and in
`THIRD_PARTY_NOTICES.md`; the backend uses LawinServer's code directly.)

### Prebuilt binaries in the projects (we do NOT take them)

- `minhook.lib` in Erbium, ErbiumClient, Magnesium, ATLAS → we build MinHook from source.
- `libcurl.lib` and `zlib.lib` in Erbium and Magnesium → not needed (only for Discord webhooks).
  If ever needed: Windows' built-in WinHTTP.
- Reboot ships `console.dll`, `sinum.dll`, `cobalt.dll`, `starfall.dll`, `memory.dll`,
  `lawinserver.exe`, `aria2c.exe`, `7zip.exe`, `winrar.exe` prebuilt → we take none of them.

---

## 3. Plan

### Basic rules

- **Only old builds, only our own backend.** The launcher only takes builds it surely recognises as
  old (at first only 19.10). Every request goes to our own backend. Tellurium's modes that partly talk
  to Epic's real servers ("Hybrid", "Dev") are not built in. "Manual mapping" (meant to get around
  anti-cheat) isn't either.
- **Everything from source.** Third-party libraries as source with a fixed version.
- **Only touch game objects in the game thread.** Own threads may only drop in messages.
- **Version switches instead of crashes.** Every feature in the menu/server has a list of the versions
  it is checked on. Unchecked = greyed out instead of a crash.
- **Change nothing outside the project without asking.** The launcher keeps its own data in
  `%APPDATA%\Niobium` (back then `%APPDATA%\Vanity`). It only touches the build folder and Reboot's
  settings after asking (e.g. renaming `GFSDK_Aftermath_Lib.dll`, which Reboot deletes without asking).

### Folder structure (as planned)

```
vanity-/                   (the repository keeps this name)
├─ launcher/               the launcher (Tauri 2)
│  ├─ src/                 UI: React + TypeScript + Tailwind + shadcn/ui + Framer Motion
│  └─ src-tauri/           Rust: start the game, load DLLs, logs, crash analysis, control centre
├─ backend/                built-in backend (Node 22 + TypeScript + Fastify), after LawinServer
├─ native/                 all game DLLs, one Visual Studio 2022 solution (C++20, x64)
│  ├─ common/              shared: Unreal access, hooks, game-thread mailbox, version switches
│  ├─ redirect/            redirect DLL (base: Tellurium)
│  ├─ client/              in-game menu F9 (ImGui + DX11 + MinHook)
│  ├─ gameserver/          game server (base: Erbium, parts/ideas from Magnesium)
│  └─ third_party/         MinHook, ImGui, Memcury, nlohmann/json – as source
├─ docs/                   this plan + one test checklist per phase
├─ .github/workflows/      builds everything from source on a Windows machine at GitHub
├─ THIRD_PARTY_NOTICES.md  who wrote what, under which licence
└─ LICENSE                 GPL-3.0
```

### Technology

| Part | Technology | Why |
|---|---|---|
| UI | Tauri 2, React, TypeScript, Vite, Tailwind, shadcn/ui, Framer Motion, lucide icons | as requested; small and fast |
| Launcher logic | Rust: `windows` crate (processes, loading DLLs), `tokio` (reading logs at the same time), `pelite` (reading the version from the .exe) | stable, no crashes from memory bugs |
| Backend | Node 22 + TypeScript, Fastify (HTTP), `ws` (matchmaker/XMPP); built as a single .exe and started by the launcher | LawinServer's logic is easy to carry over |
| Game DLLs | C++20, VS 2022, x64, MinHook, Dear ImGui (DX11), Memcury | standard in the scene, all source |
| Launcher ↔ DLLs | one named pipe per process, messages as JSON | the launcher sees "server ready" live and can change server options |
| F9 menu ↔ server | through Fortnite's own `ServerCheat` path; the server checks whether it's the host | also works when friends play along |
| Building | GitHub Actions on `windows-latest`: builds the DLLs, the backend .exe and the launcher installer | you download a finished installer built from *our* source – or build it yourself with VS 2022 |

Note: my working environment here runs Linux. I test the UI, the backend and the Rust logic (version
detection, log and crash analysis) here automatically. GitHub Actions builds the DLLs and the Windows
installer. I can't start Fortnite myself – you test that with the checklist and send me the logs.

### Phases

Every phase ends with a test checklist in `docs/` and waits for your "works".

| # | Phase | What you can test afterwards |
|---|---|---|
| 0 | Research + plan | read this document, answer the questions |
| 1 | **Launcher UI** (design only, sample data): Home ("Host & Play"), Library (builds), Servers & Friends, Live Log, in-game menu options, Profiles, Settings, Credits | start the installer, click through every page, animations, resize the window |
| 2 | **Start Fortnite 19.10 + logs**: import a build folder with version detection (19.10 · CL-18675304 · Chapter 3 Season 1 · UE 5.0), start with `-d3d11`, live log, notice "closed"/"crashed". **The redirect DLL already comes along**, set to 127.0.0.1 – so Fortnite never talks to Epic. | import a build → version is right; start → Fortnite opens and reports "no connection" (correct, the backend is still missing); the log runs live; close Fortnite → the launcher notices |
| 3 | **Backend + lobby**: login, profile/locker, lobby content, version check, cloud settings, matchmaker. In the launcher: backend status and a list of requests | start → you land in the lobby with your name; open the locker; settings are kept |
| 4 | **Game server + match on 127.0.0.1**: game server DLL (Erbium base) for 19.10, "Host & Play" with one click (backend + server without graphics + your game). Friends join by IP (Tailscale/Radmin) | press Play → bus, drop, loot, building, editing, fall damage, victory; server ended/restarted after the match |
| 5 | **In-game menu (F9)**: modern ImGui design, Edit on Release, Reset on Release, Disable Pre-Edits, FOV, keybinds, Join Local Host / by IP, console on/off (game-thread safe) | every option on/off in a match; settings are kept after a restart |
| 6 | **Bots**: 6a target bots (number, health/shield, standing still); 6b real opponents with difficulty (**experimental** – the hardest part) | spawn bots, hit them, eliminate them; change number/difficulty |
| 7 | **Trickshot mode + match control**: no fall damage, infinite ammo/materials, instant reload, spawn up high, teleport points, trickshot detection with a banner; playlist, Lategame, start match, storm on/off + speed, give items, respawn on/off – in the launcher (host panel) and in the F9 menu (host only) | try every option in a match |
| 8 | **Polish**: design, crash analysis in plain words (reads `…\Saved\Crashes`), server browser, installer, guide | trigger a crash on purpose → an understandable message; installer on a fresh Windows |

Later: more versions (19.40 first, because Erbium already fully supports it).

### What you need

- Windows 10/11, enough RAM for two Fortnite instances (server + game, roughly 12–16 GB).
- To build it yourself (optional): Visual Studio 2022 ("Desktop development with C++"),
  Rust, Node 22, pnpm. Otherwise the installer from GitHub Actions is enough.

---

## 4. Decisions (23 Oct 2026)

All four points were confirmed like this:

1. **Licence GPL-3.0** for the whole project. The project is for your own use; the source code is public
   in the repository `vanity-` – that fits the GPL. Every source is named.
2. **Erbium as the base** of the game server, Magnesium features on purpose with credit.
3. **Launch method like all OG launchers** (helper processes paused, placeholder token), with the safety
   limits from section 3 (only old builds, only our own backend).
4. **Name: Vanity.** → Renamed to **Niobium** on 26 Oct 2026 (element 41, symbol Nb; see
   [`brand.md`](brand.md)). The repository keeps the name `vanity-`.
