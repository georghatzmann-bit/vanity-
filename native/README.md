# Vanity – Spiel-DLLs (C++20, x64, Visual Studio 2022)

Diese DLLs werden in das von Vanity gestartete, alte Fortnite geladen. Alles aus Quellcode,
keine fertigen .lib/.dll. Projektmappe: `Vanity.sln`.

| Projekt | Ergebnis | Aufgabe | Basis / Lizenz |
|---|---|---|---|
| `minhook` | (statische Lib) | Funktions-Hooks | MinHook, BSD-2 (`third_party/minhook`) |
| `redirect` | `vanity_redirect.dll` | leitet alle Epic-Anfragen auf `127.0.0.1:3551` um | Tellurium, BSD-3 (`redirect/LICENSE-Tellurium.txt`) |
| `server` | `vanity_server.dll` | macht aus Fortnite einen Game Server (Arena, Lategame, Bots, Trickshot) | Magnesium/Erbium, BSD-3 (*in Arbeit*) |
| `client` | `vanity_client.dll` | Ingame-Menü (F9) | eigener Code + ErbiumClient (GPL-3.0), ImGui (MIT) (*in Arbeit*) |

## Bauen

Mit Visual Studio 2022 („Desktop development with C++“): `Vanity.sln` öffnen, **Release / x64**,
Build. Oder auf der Kommandozeile:

```
msbuild native\Vanity.sln /t:Restore,Build /p:Configuration=Release /p:Platform=x64 /m
```

Ergebnis liegt in `native\bin\Release\`.

## Probe-Kompilieren unter Linux

`native/scripts/check-build.sh <minhook|redirect|server|client|all>` prüft mit clang-cl und den
MSVC-Headern aus `/opt/xwin` grob, ob der Code übersetzt. Das ist nur eine Vorprüfung – der
richtige Build läuft mit Visual Studio (auch im GitHub-Workflow).

## Stand

- **minhook, redirect**: fertig und im Build.
- **server, client**: Quellcode eingesammelt (Magnesium, ErbiumClient), Projektdateien und die
  Anbindung an den Launcher (Steuer-Pipe, Ingame-Menü) werden noch gebaut.
