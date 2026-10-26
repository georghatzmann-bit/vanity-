# Niobium – game DLLs (C++, x64, Visual Studio 2022)

These DLLs are loaded into the old Fortnite that Niobium starts. Everything is built from source –
no prebuilt .lib or .dll files. Solution: `Niobium.sln`.

| Project | Output | Job | Base / licence |
|---|---|---|---|
| `minhook` | (static library) | function hooks | MinHook, BSD-2 (`third_party/minhook`) |
| `redirect` | `niobium_redirect.dll` | sends every Epic request to your own backend on `127.0.0.1:3551` | Tellurium, BSD-3 (`redirect/LICENSE-Tellurium.txt`) |
| `server` | `niobium_server.dll` | turns Fortnite into a game server (Arena, Lategame, bots, trickshot, the launcher's control pipe `\\.\pipe\niobium-server`) | Magnesium (BSD-3) / Erbium (GPL-3.0) |
| `client` | `niobium_client.dll` | in-game menu (F9) – see [`client/README.md`](client/README.md) | ATLAS Console (ATLAS Console Attribution License v1.0, `client/LICENSE-ATLAS.txt`), Erbium SDK (GPL-3.0), Memcury (MIT), Dear ImGui (MIT) |

Changes in vendored code are marked: `// NIOBIUM:` in the server and the redirect, `// [Niobium]` in
the in-game menu. (Before the rename they were `VANITY:` and `[Vanity]`.)

## Building

With Visual Studio 2022 ("Desktop development with C++", toolset v143): open `Niobium.sln`, pick
**Release / x64**, build. Or on the command line:

```
msbuild native\Niobium.sln /t:Restore,Build /p:Configuration=Release /p:Platform=x64 /m
```

The DLLs land in `native\bin\Release\` (`niobium_redirect.dll`, `niobium_server.dll`,
`niobium_client.dll`). The GitHub workflow builds them the same way and puts them into the installer.

## Test compile on Linux

`native/scripts/check-build.sh <minhook|redirect|server|client|all>` checks roughly with clang-cl and
the MSVC headers from `/opt/xwin` whether the code compiles. This is only a first check – the real
build runs with Visual Studio (also in the GitHub workflow).

Screenshots of the F9 menu without the game: `native/tools/menu-preview/build-and-render.sh <output folder>`.

## Status

- **minhook, redirect, server, client:** all four build in the GitHub workflow and are in the installer.
- Not tested in the real game yet – see [`../docs/03-test-checklist.md`](../docs/03-test-checklist.md).
