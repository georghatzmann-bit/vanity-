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
| [Tellurium](https://github.com/plooshi/Tellurium) | Ploosh | BSD-3-Clause | base of the redirect `niobium_redirect.dll` (`native/redirect/`) |
| [ATLAS Console / ATLAS-Client](https://github.com/Ralzify/ATLAS-Client) | ralz, cipherfps and contributors | ATLAS Console Attribution License v1.0 (`native/client/LICENSE-ATLAS.txt`) | base of the in-game menu `niobium_client.dll` (`native/client/`). **Niobium is based on ATLAS Console by cipherfps, ralz and contributors.** Changes: see `native/client/README.md` |
| [MinHook](https://github.com/TsudaKageyu/minhook) | Tsuda Kageyu | BSD-2-Clause | function hooks (`native/third_party/minhook/`, built from source) |
| [Dear ImGui](https://github.com/ocornut/imgui) | Omar Cornut | MIT | menus in the game and in the server window (the copies that came with Magnesium in `native/server/ImGui/` and with ATLAS Console in `native/client/ATLAS/ImGui/`, version 1.92.4) |
| [Memcury](https://github.com/kem0x/Memcury) | Kareem Olim | MIT | pattern search in memory |
| [JSON for Modern C++ (nlohmann/json)](https://github.com/nlohmann/json) | Niels Lohmann | MIT | reads and writes JSON, version 3.11.2, unchanged. In the game server: `native/server/json.hpp` (control pipe, auto host, trickshot parkours and more). In the in-game menu: `native/client/third_party/nlohmann/json.hpp` (the "Trickshot" tab reads `parkours.json`), licence text in `native/client/third_party/nlohmann/LICENSE.MIT` |

## Launcher

| Project | Licence |
|---|---|
| [Tauri](https://tauri.app) (also its NSIS installer template) | MIT / Apache-2.0 |
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
