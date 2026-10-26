<p align="center">
  <img src="launcher/public/logo.svg" width="96" height="96" alt="Niobium logo: a periodic-table tile with “Nb” and “41”">
</p>

# Niobium

**NiobiumFN — old seasons, new shine.**

A modern launcher for **OG Fortnite private servers**. For your own use only, and only with old
builds. Your game never talks to Epic's real game servers (everything goes to your own backend).
Niobium has no features for today's Fortnite and does not get around any anti-cheat. The only time it
contacts Epic is the optional "Download a version": it gets the game files of an old build straight
from Epic's own download servers – never from re-uploads.

> Niobium is not affiliated with Epic Games. "Fortnite" is a trademark of Epic Games, Inc.

> **New name:** Niobium used to be called **Vanity**. The GitHub repository keeps its old name
> (`vanity-`). Your old Vanity settings move over by themselves on the first start (see
> [`docs/02-architecture.md`](docs/02-architecture.md#moving-over-from-vanity)).
>
> **Sources:** Niobium is built on free projects: the backend comes from LawinServer, the game server
> from Magnesium/Erbium, the redirect from Tellurium and the in-game menu from ATLAS Console. The AI bots
> on 19.10 are ported from Artemis, the downloader's file formats from Legendary.
>
> **Versions:** Niobium starts every version from 1.7 to 30.x (Chapter 1 to Chapter 5 Season 3).
> Only 19.10 is tested so far; all others run as "Untested". From 31.00 on the game server
> (Erbium/Magnesium) doesn't know the builds yet. Details:
> [`docs/02-architecture.md`](docs/02-architecture.md#versions).
>
> Niobium's in-game menu is based on **ATLAS Console** by cipherfps, ralz and contributors.
> All licences: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Download and test

Test build, always built from the latest code:
**https://github.com/georghatzmann-bit/vanity-/releases/download/niobium-test/Niobium-Setup.exe**

How to test it, step by step: [`docs/03-test-checklist.md`](docs/03-test-checklist.md)
(in German: [`docs/03-test-checklist.de.md`](docs/03-test-checklist.de.md)).

The installer is in English, installs only for your Windows user (no admin rights) and quietly
removes an old Vanity install if it finds one. Your settings stay.

## What it can do

- **Host & Play:** one click starts the backend, your own game server and your game.
- **Library:** add the folder of a build; Niobium reads the version and says how well it is supported.
- **Download a version (new):** gets an old build straight from Epic's own download servers and adds it
  to the Library: Chapter 2 Seasons 3 and 5–8 (13.30 to 18.30). Epic has deleted parts of many older
  seasons, so they can't be downloaded – Chapter 3 Season 1 (19.10) is one of them. A 19.10 you already
  have keeps working. Details: [`docs/02-architecture.md`](docs/02-architecture.md#build-downloader-download-a-version).
- **Classic match (new):** profiles play like back then – no Lategame, normal ammo and materials. Switch
  each one on in the profile if you want it.
- **AI bots (new, experimental, 19.10 only):** Fortnite's own AI players drop in with you. Number of bots
  and skill (Easy, Normal, Hard) in the profile.
- **Pickups and loot (fixed):** picking up and swapping weapons works with full and free slots, and
  nothing gets lost; floor loot on 19.10; a list of the match's loot in the Live Log.
- **Match Control:** start the match, game mode, Lategame, storm, respawn, items, target dummies and trickshot
  parkours, all from the launcher.
- **F9 in-game menu:** Edit on release, Reset on release and Disable pre-edits on every version (Niobium's
  own code on old versions, Fortnite's own setting where Epic has one – never both), a "Reset builds" key
  (aim at an edited build and press it, no edit mode needed), "Bubble look", field of view, keys, joining
  by IP, a console, your own commands and a "Trickshot" tab.
- **Trickshot parkours:** 9 ready-made courses with jump objects and standing target bots, plus a big
  "TRICKSHOT!" banner when you eliminate someone in the air.
- **Bubble Builds:** the see-through "bubble wrap" build look of Chapter 2 Seasons 5–6, on
  Fortnite 15.40 – 16.00, and as an experiment on 19.x (Performance Mode + Meshes Low). Switch it on in
  Settings; it applies on the next launch. Fortnite's graphics settings are backed up first and put back
  after the game by themselves.
- **Crash Analysis and Live Log:** what went wrong, in plain words.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Research + plan | done – see [`docs/00-research-and-plan.md`](docs/00-research-and-plan.md) |
| 1 | Launcher UI | done |
| 2 | Start Fortnite 19.10 + logs | in the installer – [`docs/03-test-checklist.md`](docs/03-test-checklist.md) |
| 3 | Backend + lobby | in the installer (backend from LawinServer) |
| 4 | Game server, match on 127.0.0.1 | in the installer (`niobium_server.dll` from Magnesium) – control it in the server window or on the launcher page "Match Control" |
| 5 | In-game menu (F9) | in the installer (`niobium_client.dll`, based on ATLAS Console) – in English, with a "Trickshot" tab – waiting for a test |
| 6 | Bots | in the server window (Magnesium) and on the launcher page "Match Control" (standing target bots) – waiting for a test |
| 7 | Trickshot mode + match control | launcher page "Match Control" (Game, Trickshot, Bots) through the control pipe. **Trickshot parkours:** 9 courses made of jump objects and standing target bots (mostly on a platform in the air), plus a sniper – built with one click in the launcher or in the F9 tab "Trickshot". An elimination in the air → big "TRICKSHOT!" banner. Your own command presets on "Match Control" → "Trickshot"; the server window's trickshot tab still works too – waiting for a test |
| 8 | Polish, crash analysis, installer | crash analysis + installer done, polish ongoing |
| 9 | Niobium: new name and logo, everything in English, Bubble Builds, new animated look, splash screen, welcome screen, branded installer | in the installer – waiting for a test |
| 10 | "Download a version" (from Epic's own servers), "Classic match" profiles, AI bots on 19.10 (experimental), pickup and floor-loot fixes, loot list | new – waiting for a test ([`docs/03-test-checklist.md`](docs/03-test-checklist.md), Steps 10–14) |
| 11 | Edit features on every version without overlap, "Reset builds" key, "Bubble look", Bubble Builds on 19.x with automatic settings restore | new – waiting for a test ([`docs/03-test-checklist.md`](docs/03-test-checklist.md), Steps 6 and 8) |

## Folders

```
launcher/     Tauri 2 – UI (React, TypeScript, Tailwind, shadcn/ui, Motion) + logic in Rust
backend/      built-in backend (Node + TypeScript, based on LawinServer)
native/       game DLLs in C++ (Visual Studio 2022, x64): redirect, game server, in-game menu
docs/         plan, architecture, test checklists, brand
```

## Build it yourself (optional)

Normally GitHub Actions builds the Windows installer from this source code (tab **Actions** → latest
run → **Artifacts**, or the pre-release `niobium-test`). If you want to build it yourself:

1. Install [Node 22](https://nodejs.org), [pnpm](https://pnpm.io), [Rust](https://rustup.rs) and the
   [Tauri prerequisites for Windows](https://v2.tauri.app/start/prerequisites/).
2. In the `launcher/` folder:
   ```
   pnpm install
   pnpm tauri dev      # starts the launcher to try it out
   pnpm tauri build    # builds the installer
   ```
3. For a complete installer, first put the parts into `launcher/src-tauri/resources/`, like the
   workflow `.github/workflows/launcher.yml` does: the built backend (`backend/dist/`) into `backend/`,
   the three DLLs from `native/bin/Release/` into `dlls/` and a Windows `node.exe` into `node/`.
   How to build the DLLs: [`native/README.md`](native/README.md); the backend:
   [`backend/README.md`](backend/README.md).

## Licence

GPL-3.0 – see [`LICENSE`](LICENSE). The projects Niobium uses and their licences are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
