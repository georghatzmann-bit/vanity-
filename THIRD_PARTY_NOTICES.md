# Fremde Projekte und Lizenzen

Vanity steht unter der GPL-3.0. Diese Datei listet alle Projekte, aus denen Code, Daten oder
Ideen stammen. Sobald Code tatsächlich übernommen wird, steht hier zusätzlich, welche Dateien
betroffen sind, und der Original-Lizenztext liegt im jeweiligen Unterordner bei.

## Vorbilder für Abläufe (kein Code übernommen)

| Projekt | Autor | Lizenz | Wofür |
|---|---|---|---|
| [Reboot Launcher](https://github.com/Auties00/reboot_launcher) | Auties00 | keine Lizenz-Datei (alle Rechte vorbehalten) | Startablauf, Log-Erkennung, Versionserkennung – nur gelesen und nachgebaut |

## Backend

| Projekt | Autor | Lizenz | Wofür |
|---|---|---|---|
| [LawinServer](https://github.com/Lawin0129/LawinServer) | Lawin0129 | GPL-3.0 | Grundlage des Backends – liegt in `backend/lawinserver/` (Stand 70414917, 16.10.2026), alle Änderungen in `backend/lawinserver/VANITY_CHANGES.md` |
| [Express](https://expressjs.com), [ws](https://github.com/websockets/ws) und weitere npm-Pakete | siehe `backend/dist/THIRD_PARTY_LICENSES.txt` | MIT u. a. | Webserver und WebSocket |

## Spiel-DLLs (Quellcode übernommen, liegt in `native/`)

| Projekt | Autor | Lizenz | Wofür |
|---|---|---|---|
| [Magnesium](https://github.com/Ralzify/Magnesium) | Ploosh, ralz, cipher | BSD-3-Clause | Grundlage des Game Servers `vanity_server.dll` (`native/server/`, Bots, Trickshot, Lategame) |
| [Erbium](https://github.com/plooshi/Erbium) | Ploosh | GPL-3.0 | Basis von Magnesium; SDK im Ingame-Menü |
| [Tellurium](https://github.com/plooshi/Tellurium) | Ploosh | BSD-3-Clause | Grundlage der Umleitung `vanity_redirect.dll` (`native/redirect/`) |
| [ATLAS Console / ATLAS-Client](https://github.com/Ralzify/ATLAS-Client) | ralz, cipherfps und Mitwirkende | ATLAS Console Attribution License v1.0 (`native/client/LICENSE-ATLAS.txt`) | Grundlage des Ingame-Menüs `vanity_client.dll` (`native/client/`). **Vanity basiert beim Ingame-Menü auf ATLAS Console von cipherfps, ralz und Mitwirkenden.** Änderungen siehe `native/client/README.md` |
| [MinHook](https://github.com/TsudaKageyu/minhook) | Tsuda Kageyu | BSD-2-Clause | Funktions-Hooks (`native/third_party/minhook/`, aus Quellcode gebaut) |
| [Dear ImGui](https://github.com/ocornut/imgui) | Omar Cornut | MIT | Menüs im Spiel und im Server-Fenster |
| [Memcury](https://github.com/kem0x/Memcury) | Kareem Olim | MIT | Muster-Suche im Speicher |

## Launcher (Phase 1)

| Projekt | Lizenz |
|---|---|
| [Tauri](https://tauri.app) | MIT / Apache-2.0 |
| [React](https://react.dev) | MIT |
| [Vite](https://vite.dev) | MIT |
| [Tailwind CSS](https://tailwindcss.com) | MIT |
| [shadcn/ui](https://ui.shadcn.com) | MIT |
| [Radix UI](https://www.radix-ui.com) | MIT |
| [Motion (Framer Motion)](https://motion.dev) | MIT |
| [Lucide Icons](https://lucide.dev) | ISC |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [Sonner](https://sonner.emilkowal.ski) | MIT |
