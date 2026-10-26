# Third-party libraries (as source code)

| Folder | Project | Licence | Version |
|---|---|---|---|
| `minhook/` | https://github.com/TsudaKageyu/minhook | BSD-2-Clause (`minhook/LICENSE.txt`) | 8af6b4acae5a9388fd742b56fa79ece89d96f823 (2026-09-08) |
| `imgui/` | https://github.com/ocornut/imgui | MIT (`imgui/LICENSE.txt`) | v1.93.0 (c1aaac65e896a45f81f47a4d68f9959e0f86c859, 2026-10-14) |

Taken over unchanged. No prebuilt .lib or .dll files – everything is built from this source code.

Note: the projects in `Niobium.sln` don't use `imgui/` right now. The game server and the in-game menu
build the ImGui 1.92.4 copies that came with Magnesium (`native/server/ImGui/`) and ATLAS Console
(`native/client/ATLAS/ImGui/`).
