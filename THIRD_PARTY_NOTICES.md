# Third-party projects and licences

Niobium (which used to be called Vanity) is licensed under the GPL-3.0. This file lists every project
that code, data or ideas come from. Where code was taken over, it also says which files are affected,
and the original licence text sits in the matching folder.

## Models for how things work (no code taken)

| Project | Author | Licence | What for |
|---|---|---|---|
| [Reboot Launcher](https://github.com/Auties00/reboot_launcher) | Auties00 | no licence file (all rights reserved) | launch flow, log detection, version detection – only read and rebuilt from scratch |

## Backend

| Project | Author | Licence | What for |
|---|---|---|---|
| [LawinServer](https://github.com/Lawin0129/LawinServer) | Lawin0129 (with PRO100KatYT) | GPL-3.0 | base of the backend – in `backend/lawinserver/` (commit 70414917, 16 Oct 2026); every change is listed in `backend/lawinserver/NIOBIUM_CHANGES.md` |
| [Express](https://expressjs.com), [ws](https://github.com/websockets/ws) and other npm packages | see `backend/dist/THIRD_PARTY_LICENSES.txt` | MIT and others | web server and WebSocket |
| [Node.js](https://nodejs.org) | OpenJS Foundation and contributors | MIT (plus the licences of its bundled parts, see Node's `LICENSE`) | runs the backend; the installer ships `node.exe` |

## Game DLLs (source code taken over, in `native/`)

| Project | Author | Licence | What for |
|---|---|---|---|
| [Magnesium](https://github.com/Ralzify/Magnesium) | Ploosh, ralz, cipher | BSD-3-Clause | base of the game server `niobium_server.dll` (`native/server/`: bots, trickshot, Lategame) |
| [Erbium](https://github.com/plooshi/Erbium) | Ploosh | GPL-3.0 | base of Magnesium; SDK of the in-game menu |
| [Artemis](https://github.com/NotTacs/Artemis) | NotTacs and contributors | GPL-3.0 | Fortnite's own AI player bots on 19.10 (CL 18675304): bot count and skill, bot service setup, POI caches, nav data, bus boarding, bot outfits and the 19.10 addresses, ported from commit 48dba08 (25 Oct 2026) into `native/server/FortniteGame/Private/PlayerBots_19_10.cpp` (the file header maps every part to its Artemis source); the near-page and LEA helpers now live in `native/server/FortniteGame/Private/AIBase.cpp`, plus the AI-bot branch of `SpawnDefaultPawnFor` in `FortGameMode.cpp` |
| [Velora](https://github.com/Jeremy1926/Velora) | Jeremy1926 | MIT | methods only, rewritten (no code copied): how to switch off the game-internal standalone check on 17.00–19.x (commit 67ffac0, `FortPlayerPawnAthena.cpp:25-33`; owner approved, private server only) in `native/server/FortniteGame/Private/AIBase.cpp`, and the rules for dropping a dead AI's inventory (`FortAthenaAIBotController.cpp:383-438`, dfa12c2) in `native/server/FortniteGame/Private/LivingWorld.cpp` |
| [Tellurium](https://github.com/plooshi/Tellurium) | Ploosh | BSD-3-Clause | base of the redirect `niobium_redirect.dll` (`native/redirect/`) |
| [ATLAS Console / ATLAS-Client](https://github.com/Ralzify/ATLAS-Client) | ralz, cipherfps and contributors | ATLAS Console Attribution License v1.0 (`native/client/LICENSE-ATLAS.txt`) | base of the in-game menu `niobium_client.dll` (`native/client/`). **Niobium is based on ATLAS Console by cipherfps, ralz and contributors.** Changes: see `native/client/README.md` |
| [MinHook](https://github.com/TsudaKageyu/minhook) | Tsuda Kageyu | BSD-2-Clause | function hooks (`native/third_party/minhook/`, built from source) |
| [Dear ImGui](https://github.com/ocornut/imgui) | Omar Cornut | MIT | menus in the game and in the server window (the copies that came with Magnesium in `native/server/ImGui/` and with ATLAS Console in `native/client/ATLAS/ImGui/`, version 1.92.4) |
| [Memcury](https://github.com/kem0x/Memcury) | Kareem Olim | MIT | pattern search in memory |
| [JSON for Modern C++ (nlohmann/json)](https://github.com/nlohmann/json) | Niels Lohmann | MIT | reads and writes JSON, version 3.11.2, unchanged. In the game server: `native/server/json.hpp` (control pipe, auto host, trickshot parkours and more). In the in-game menu: `native/client/third_party/nlohmann/json.hpp` (the "Trickshot" tab reads `parkours.json`), licence text in `native/client/third_party/nlohmann/LICENSE.MIT` |

## Build downloader (in the launcher, `launcher/core/src/epic/`)

| Project | Author | Licence | What for |
|---|---|---|---|
| [Legendary](https://github.com/derrod/legendary) | Rodney (derrod) and contributors | GPL-3.0-or-later (used under GPL-3.0, which fits Niobium's GPL-3.0-only) | Epic's manifest formats (binary and JSON), the chunk format and Epic's rolling hash, rewritten in Rust from `legendary/models/manifest.py`, `json_manifest.py`, `chunk.py` and `utils/rolling_hash.py` into `manifest.rs`, `manifest_bin.rs`, `manifest_json.rs` and `chunk.rs` (each file header names its Legendary source); the test files in `fixtures.rs` follow Legendary's `write` methods |

Data the downloader fetches while it runs (nothing of it ships with Niobium):

| Source | What |
|---|---|
| [polynite/fn-releases](https://github.com/polynite/fn-releases) | public archive of Epic's own manifest files (the file list of a build). Niobium downloads one manifest when you start a download and only accepts it if its SHA-1 is the one pinned in `launcher/core/data/build-catalog.json` |
| [VastBlast/FortniteManifestArchive](https://github.com/VastBlast/FortniteManifestArchive) | the same, as a fallback – only for builds where its file is byte-identical (same pinned SHA-1) |
| Epic Games' download servers (`fastly-download.epicgames.com`, `epicgames-download1.akamaized.net`, `download.epicgames.com`, `cloudflare.epicgamescdn.com`) | every game file. Niobium never downloads builds from re-uploads or mirrors |

## Launcher

| Project | Licence |
|---|---|
| [Tauri](https://tauri.app) (also its NSIS installer template) | MIT / Apache-2.0 |
| [ureq](https://github.com/algesten/ureq) with [native-tls](https://github.com/rust-native-tls/rust-native-tls), [flate2](https://github.com/rust-lang/flate2-rs) and [sha1](https://github.com/RustCrypto/hashes) (RustCrypto) – HTTPS, unpacking and SHA-1 checks of the build downloader | MIT / Apache-2.0 |
| [React](https://react.dev) | MIT |
| [Vite](https://vite.dev) | MIT |
| [Tailwind CSS](https://tailwindcss.com) | MIT |
| [shadcn/ui](https://ui.shadcn.com) | MIT |
| [Radix UI](https://www.radix-ui.com) | MIT |
| [Motion (Framer Motion)](https://motion.dev) | MIT |
| [Lucide Icons](https://lucide.dev) | ISC |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [Sonner](https://sonner.emilkowal.ski) | MIT |
| [class-variance-authority](https://github.com/joe-bell/cva), [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge), [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | MIT |

## Logo and installer

| Project | Author | Licence | What for |
|---|---|---|---|
| [Inter](https://rsms.me/inter) | Rasmus Andersson | SIL Open Font License 1.1 | the "41" in the logo and the "Niobium" wordmark are outlines drawn from Inter Display Bold. No font file ships. See `docs/brand.md` |
| [NSIS](https://nsis.sourceforge.io) with the AdvSplash plug-in | NSIS contributors | zlib/libpng licence | the Windows installer and its fading splash screen (`launcher/src-tauri/windows/hooks.nsh`) |
