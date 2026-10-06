# VELOX Tweaker — Architecture & Contracts

This file is the **single source of truth** for every part of VELOX. Backend, UI, catalog data and
tests are written against it in parallel. If something here is ambiguous, pick the reading that is
safest for the user's PC and document the choice in a comment.

VELOX is a Windows 10/11 tweaking tool:

- a **PowerShell backend** (runs on the built-in Windows PowerShell 5.1, no installs) that reads and
  writes registry values, services, scheduled tasks, BCD, power plans, Appx packages …
- a **local HTTP server** inside that backend (`System.Net.HttpListener`, `127.0.0.1` only)
- an **HTML/CSS/JS front end** (no build step, no CDN, no dependencies) shown in a chromeless
  Microsoft Edge app window (`msedge --app=…`)
- a **declarative tweak catalog** (JSON) — every tweak is data: what to change, the Windows default to
  revert to, how to detect it, when it applies, how risky it is.

User-facing language is **German**, simple, without jargon (one grey line of explanation per option).

---

## 1. File layout

```
velox-tweaker/
  Start.bat               double-click launcher (CRLF!): finds 64-bit powershell.exe, runs Velox.ps1
  Start-Testmodus.bat     same with -Simulate (nothing is changed on the PC)
  Velox.ps1               entry point: params, elevation, load core, start server, open window
  core/
    Common.ps1            context ($global:VxCtx), logging, JSON helpers, native-process helper, paths
    System.ps1            low-level providers: registry, services, tasks, bcd, power, appx, features
                          — each with a REAL implementation and a SIMULATED one (see §6)
    Catalog.ps1           load + index data/*.json, applicability (`when`), status detection
    Engine.ps1            apply / revert / detect per action type, journal (backup) writing, restore
    Detweak.ps1           foreign-tweak scan + reset (data/detweak.json + catalog)
    Scan.ps1              hardware/system profile
    Advisor.ps1           offline expert system ("Smart-Analyse") → findings + plan + score
    Claude.ps1            KI providers of the KI-Optimierer: Claude Code CLI, Claude API, Groq (see §9)
    Extras.ps1            startup manager, game booster, file picker
    Clean.ps1             Reinigung: clean-scan / run-action, allow-list, junction-safe walk, long-running tools
                          (DISM, SFC, CHKDSK, Datenträgerbereinigung) with live percent, timeout, cancel, skip (§3a)
    Jobs.ps1              background job runner: one reused worker runspace, one job at a time
    Server.ps1            HttpListener, routing, auth, static files
  data/
    categories.json       category list (id, name, desc, icon, order)
    tweaks/<category>.json  catalog, one file per category (schema §3)
    presets.json          presets (§4)
    detweak.json          foreign-tweak reset list (§5)
  ui/
    index.html
    css/app.css, css/games.css (Spiele page), css/cleanup.css (Reinigung page)
    js/app.js, js/api.js, js/ui.js (components), js/icons.js, js/ai.js (KI providers), js/splash.js (start sequence), js/pages/<page>.js
    brand/                copies of ../brand/ (tools/sync-brand.mjs): intro, sound, tokens, wordmarks, icon
  tests/
    Run-Tests.ps1         backend tests (pwsh 7 on Linux AND Windows PowerShell 5.1) — simulate mode
    fixtures/             small fixture catalog + fake profiles + fake Claude responses + claude-cli (fake Claude Code CLI) + games/pc (fake PC for the game detection) + clean/ (New-CleanFixture.ps1 = fake PC for the Reinigung, fake-tool.ps1 = fake DISM/SFC output)
    ui/run-ui-tests.mjs   Playwright end-to-end tests against `Velox.ps1 -Simulate -NoBrowser`
    native/               installer UI tests (Chromium, mocked bridge) + Velox.ps1 -HostPid contract (§11)
  tools/
    Validate-Catalog.ps1  strict schema validation of data/ (used by tests, run it after every edit)
    Normalize-Files.ps1   UTF-8 BOM for .ps1, CRLF for .bat
  docs/ARCHITECTURE.md    this file
  README.md               German user guide
  VERSION                 the one version number (installer, VELOX.exe, app)
  native/                 VELOX.exe + VeloxSetup.exe (C#, WebView2) and the installer UI (§11)
  dist/VeloxSetup.exe     the built installer (native/build.sh)
```

Runtime data lives in `%LOCALAPPDATA%\Velox\` (or `-DataRoot`):
`settings.json`, `claude.key` + `groq.key` (DPAPI-encrypted), `state.json` + `instance.json` (real mode), `state-sim.json` + `instance-sim.json` + `sim-state.json` (Testmodus - the two modes never share state or the single-instance lock), `backups\<id>.json`, `logs\`, `edge-profile\`, `cache\gameart\` (game icons + `art-map.json`), `tmp\` (scripts of `Invoke-VxIsolated`, deleted after each run).

---

## 2. Coding rules for PowerShell (MUST — the user runs Windows PowerShell **5.1**)

Tests run under pwsh 7 on Linux; the product runs on 5.1 on Windows. Code must work on both.

1. **Forbidden syntax** (PS 6/7 only): `??`, `??=`, `?.`, `?[]`, ternary `a ? b : c`, pipeline chains
   `&&` / `||`, `clean {}` blocks.
2. **Forbidden cmdlet features**: `ForEach-Object -Parallel`, `ConvertFrom-Json -AsHashtable` / `-Depth`,
   `Test-Json`, `Get-Error`, `$PSStyle`, `Join-Path` with more than one child, `-Encoding utf8NoBOM`,
   `Get-Content -AsByteStream`, `Invoke-RestMethod -SkipHttpErrorCheck/-StatusCodeVariable`,
   `Split-Path -LeafBase/-Extension`, `Get-Date -AsUTC`, `Start-Process -Environment`.
   Do not use PowerShell `class` definitions or `using namespace` (they break across runspaces).
3. `$IsWindows`, `$IsLinux` do not exist in 5.1 → use `Test-VxWindows` from Common.ps1.
4. JSON out: always `ConvertTo-Json -Depth 30 -Compress`; for arrays use
   `ConvertTo-Json -InputObject @($x)` (piping unrolls single-element arrays, and `@()` piped gives nothing).
   Prefer building `[ordered]@{}` / hashtables for output.
5. JSON in: `ConvertFrom-Json` returns `PSCustomObject`. Read files with
   `[IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`. Wrap list properties in `@()` before iterating.
   Test optional properties with `$o.PSObject.Properties['name']`.
6. Never set `Set-StrictMode`. Never set a global `$ErrorActionPreference = 'Stop'`; use
   `-ErrorAction Stop` inside `try {}` per call.
7. Native programs (`bcdedit`, `powercfg`, `sc.exe`, `schtasks`, `netsh`, `fsutil`, `dism`, `sfc`): call them only via
   `Invoke-VxNative -FilePath 'bcdedit.exe' -Arguments @('/set','{current}','disabledynamictick','yes')`
   (Common.ps1) which uses `System.Diagnostics.Process`, captures stdout+stderr with the OEM code page,
   returns `@{ ExitCode; Output; Error }` and has a timeout. Never trust output text alone — check ExitCode.
   Remember `{current}` must be quoted in PowerShell.
8. Registry access via .NET (`[Microsoft.Win32.RegistryKey]::OpenBaseKey(hive, [Microsoft.Win32.RegistryView]::Registry64)`),
   not the `HKLM:` provider, so a 32-bit host cannot be WOW64-redirected and value kinds are exact.
   DWORD values above 0x7FFFFFFF must be converted to the signed `[int]` bit pattern before `SetValue`.
9. **Encoding**: every `.ps1` file is saved as **UTF-8 with BOM** (5.1 reads BOM-less files as ANSI and
   breaks umlauts). `.bat` files are ASCII with **CRLF** line endings. JSON/HTML/CSS/JS are UTF-8 without BOM.
   Run `pwsh tools/Normalize-Files.ps1` after writing files; tests fail otherwise.
10. Functions are prefixed `Vx` (`Get-VxRegValue`, `Invoke-VxTweak`, …). Every core file only defines
    functions (no top-level side effects) so it can be dot-sourced into the job runspace.
11. All public backend functions must work in **simulate mode** (§6) so they are testable on Linux.
12. Run PSScriptAnalyzer with `PSUseCompatibleSyntax` for 5.1 (`tests/Run-Tests.ps1` does this when the module is installed).
13. **C# for `Add-Type`** is compiled by the .NET Framework CodeDom compiler of Windows PowerShell 5.1:
    **C# 5** only (no `$""`, `nameof`, `?.`, expression-bodied members, auto-property initializers,
    `out var`, pattern matching, tuples, `default` literals, local functions), references are
    `mscorlib` + `System.dll` (no `System.Core`/LINQ) plus what `-ReferencedAssemblies` adds, and
    **every compiler warning fails `Add-Type`** (unused variables, unassigned fields …). The `compat`
    test extracts every C# source from `core/*.ps1` (also `-MemberDefinition` snippets inside
    isolated-script text) and compiles it exactly like that with the dotnet SDK's `csc`
    (`-langversion:5 -warn:4 -warnaserror+`) against the .NET Framework 4.8 reference assemblies
    (NuGet `Microsoft.NETFramework.ReferenceAssemblies.net48`); it is skipped with a note when dotnet
    or the reference assemblies are missing.
14. Never start `powershell.exe -EncodedCommand` (virus scanners flag base64 commands from elevated
    processes). `Invoke-VxIsolated` writes the script to `<dataRoot>\tmp\iso-*.ps1` (UTF-8 with BOM),
    runs it with `-File` and deletes it afterwards (leftovers older than a day are removed on the next
    run). A `compat` test fails on any `-EncodedCommand` in `core/` or `Velox.ps1`.
15. Never read `Task.Result` of a pipe reader after a timed-out `Wait()`: a grandchild that inherited
    the pipe keeps it open and `.Result` would block the job for good.

---

## 3. Tweak catalog schema (`data/tweaks/<category>.json`)

```json
{
  "category": "gaming",
  "tweaks": [
    {
      "id": "gaming.gamedvr-off",
      "name": "Hintergrund-Aufnahme (Game DVR) aus",
      "desc": "Windows nimmt sonst heimlich Gameplay auf. Aus = mehr FPS und weniger Ruckler.",
      "info": "Optional: 1–3 einfache Sätze mehr Hintergrund. Wann lohnt es sich, was ist der Nachteil.",
      "group": "Xbox Game Bar",
      "kind": "toggle",
      "impact": 3,
      "risk": "safe",
      "warning": null,
      "needs": "none",
      "tags": ["fps", "stutter"],
      "when": { "minBuild": 17763 },
      "actions": [
        { "type": "reg", "path": "HKCU\\System\\GameConfigStore", "name": "GameDVR_Enabled",
          "kind": "DWord", "value": 0, "default": 1 }
      ]
    }
  ]
}
```

### Fields

| field | required | meaning |
|---|---|---|
| `id` | yes | unique, `^[a-z0-9]+(\.[a-z0-9-]+)+$`, starts with `<category>.` |
| `name` | yes | German, ≤ 60 chars, what it does ("… aus", "… an", "… optimieren") |
| `desc` | yes | German, ≤ 150 chars, one line in plain words: what it brings + any downside |
| `info` | no | German, ≤ 500 chars, extra background, shown when expanded |
| `group` | no | sub-heading inside the category |
| `situational` | no | `true` = only for a specific problem (MPO flicker, Wi-Fi roaming ...): the advisors pick it only when the user's own text asks for it; presets may still include it |
| `kind` | no | `toggle` (default, revertible), `action` (one-shot button, e.g. cleanup), `remove` (Appx removal; not revertible) |
| `impact` | yes | 1 = kaum spürbar, 2 = spürbar, 3 = stark |
| `risk` | yes | `safe` (no realistic downside), `moderate` (trade-off, e.g. a feature stops working), `risky` (security or stability trade-off — never in presets, never auto-picked) |
| `warning` | risky: yes, moderate: recommended | German, ≤ 200 chars, the concrete downside ("Drucken geht danach nicht mehr.") |
| `needs` | yes | `none`, `explorer` (Explorer restart), `logoff`, `reboot` |
| `tags` | yes | from the vocabulary below |
| `when` | no | applicability, all conditions must hold (below) |
| `actions` | yes | ≥ 1 action, applied in order, reverted in reverse order |

**Tag vocabulary** (tests reject others): `fps`, `latency`, `input`, `stutter`, `network`, `ping`,
`privacy`, `telemetry`, `ads`, `ai`, `bloat`, `battery`, `laptop-bad` (hurts battery/heat on laptops),
`desktop`, `ssd`, `hdd`, `nvidia`, `amd`, `intel`, `streaming`, `security-off`, `ui`, `explorer`,
`cleanup`, `repair`, `boot`, `storage`, `memory`, `audio`, `update`, `compat`, `fivem`, `gta`,
`competitive`, `quality-of-life`.

**`when` conditions** (all optional): `os` (`"win10"`|`"win11"`), `minBuild`, `maxBuild` (Windows build
number, e.g. 22000 = first Win11), `formFactor` (`"desktop"`|`"laptop"`), `gpuVendor`
(`"nvidia"`|`"amd"`|`"intel"`, true if ANY GPU matches), `cpuVendor` (`"intel"`|`"amd"`),
`systemDisk` (`"ssd"`|`"hdd"`), `minRamGB`, `maxRamGB`, `service` (service name that must exist),
`package` (Appx package name that must be installed — only for `remove`).

### Action types

Every revertible action knows how to **apply**, **revert to the Windows default**, and **detect**.

| type | fields | apply | revert | detect = applied when |
|---|---|---|---|---|
| `reg` | `path`, `name`, `kind`, `value`, `default`, `onlyExisting?`, `defaultWin11?` | set value | set `default`; `null` → delete value | value equals `value` |
| `regkey` | `path`, `present` (bool), `default` (bool) | create key / delete key tree | back to `default` | key presence equals `present` |
| `service` | `name`, `start`, `default`, `stop?` | set start type (+ stop when Disabled unless `stop:false`) | set `default` start type (start it again if Automatic) | start type equals `start` |
| `task` | `path`, `enabled` (bool), `default` (bool) | enable/disable scheduled task | back to `default` | state equals `enabled` |
| `bcd` | `name`, `value`, `default` (string or null) | `bcdedit /set {current} name value` | `default` null → `/deletevalue` | value equals `value` (case-insensitive; yes/ja/on/true are equal) |
| `powerplan` | `plan` (`ultimate`/`high`/`balanced`), `default` (`balanced`) | activate (duplicate Ultimate scheme first if missing) | activate `default` | active plan is `plan` |
| `powersetting` | `subgroup`, `setting` (GUID or powercfg alias), `ac`, `dc` (int or null), `default` `{ "ac": n, "dc": n }` | `powercfg /setacvalueindex|/setdcvalueindex SCHEME_CURRENT …` + `/setactive SCHEME_CURRENT` | the journalled previous value if known, else `default` | current AC (and DC if given) equal |
| `feature` | `name`, `enabled` (bool), `default` (bool) | `Enable/Disable-WindowsOptionalFeature -Online -NoRestart` | back | state equals `enabled` |
| `appx` | `package` (exact package name, e.g. `Microsoft.BingNews`) | remove for all users + deprovision | not possible (kind `remove`) | package not installed |
| `clean` | `paths` (array of %TOKEN% paths, §3a), `keep?` (names to keep), `stopServices?`, `closeApps?` (process names without .exe: running → the item is skipped) | delete files (skip locked), report freed bytes | — (kind `action`) | — |
| `tool` | `tool` (one of the fixed tool ids, §3a), `timeoutSec?`, `measure?` (paths whose size the scan shows) | run the tool as its own process with live percent | — (kind `action`) | — |
| `ps` | `apply` (PowerShell source), `revert` (source or null), `detect` (source returning `$true`/`$false`/`$null`, or null); kind `action` only: `timeoutSec?` (default 600), `measure?` | run `apply` (kind `action`: in its own `powershell.exe`, see §3a) | run `revert` | `detect` result |

Rules:

- `path` starts with `HKLM\`, `HKCU\`, `HKCR\`, `HKU\` or `HKCC\`. One `*` segment means "every
  subkey at this level" (e.g. network interfaces). With `onlyExisting: true` only values/keys that
  already exist are touched (e.g. `EnableUlps` under display-adapter class keys).
- `name` `""` is the key's default value.
- `kind`: `DWord`, `QWord`, `String`, `ExpandString`, `MultiString`, `Binary`. Binary values are hex
  strings (`"9E1E078012000000"`), MultiString values are string arrays.
- `default` is the **real Windows out-of-the-box value** (for Windows 10 22H2 / Windows 11 23H2+).
  `null` means "this value does not exist on a fresh install" → revert deletes it. If Windows 11
  differs, add `defaultWin11`. When unsure, `null` (delete) is usually the safe default for
  policy keys (`HKLM\SOFTWARE\Policies\…`).
- `service.start` / `default`: `Automatic`, `AutomaticDelayed`, `Manual`, `Disabled`.
- `ps` scripts must be self-contained, idempotent, quiet (no output except `detect`'s boolean), use
  `-ErrorAction Stop`, and must be ASCII. Prefer declarative types; `ps` only when nothing else fits
  (netsh, adapter properties, `Disable-MMAgent`, `fsutil` …).
- Kind `action` tweaks (cleanup/repair) have no revert and no status. Two optional fields for them:
  `tier` (`quick` = Schnell, `deep` = Gründlich, `optin` = only "Alles" after an explicit confirmation;
  **required** for category `cleanup`, an `optin` item needs a `warning` saying what is lost) and
  `duration` (short German text ≤ 40 chars, e.g. `"5–30 Min."`, shown on the card). Kind `remove` (Appx) shows
  "entfernt"/"installiert".

**Never put these in the catalog** (they break Windows or remove protection without real gain):
disabling Windows Defender / Tamper Protection, disabling the firewall, disabling UAC, disabling
Windows Update entirely, removing Microsoft Store / App Installer / frameworks / VCLibs / UI.Xaml /
Xbox Identity Provider / Edge WebView2, disabling `AppXSvc`, `StateRepository`, `CryptSvc`,
`BFE`, `Dhcp`, `Dnscache`, `RpcSs`, `AudioSrv`, `Winmgmt`, `EventLog`, `WinDefend`, `mpssvc`,
`wuauserv`, `BITS`, `TrustedInstaller`, `ProfSvc`, `Schedule`, `Power`, `PlugPlay`, `LSM`,
disabling the page file, `DisableAntiSpyware`, disabling DEP (`nx AlwaysOff`), deleting Windows.old
automatically, editing the hosts file to block Microsoft.


### 3a. Reinigung (core/Clean.ps1) - paths, allow-list, tools

**Path tokens** (clean `paths`, `measure`): `%TEMP%`/`%TMP%`, `%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`,
`%LOCALLOW%` (`<profile>\AppData\LocalLow`) - all of the person at the desktop (`Get-VxUserFolder`) -,
`%SystemDrive%`, `%WINDIR%`/`%SystemRoot%`, `%PROGRAMDATA%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`,
`%STEAM%` (Steam folder from the registry; empty → the path is skipped) and `%RECYCLEBIN%` (only at the
start: `<drive>\$Recycle.Bin\<SID of the desktop user>` on every fixed drive). The wildcard (`*`, `?`) is
allowed in the last segment and in **at most one** folder segment before it, which needs at least one
fixed folder in front (`%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache\*` = every browser profile,
`%SystemDrive%\Users\*\AppData\Local\Temp\*` = every account). The folder wildcard only matches real
folders: never a junction/symlink, never the desktop user's own profile folder. `tools/Validate-Catalog.ps1`
checks tokens, wildcards and refuses drive / Windows / profile roots.

**Safety, in this order** (a root failing one is skipped with a German message, the rest goes on):
1. `Test-VxCleanPathSafe`: never a drive root, Windows, System32/SysWOW64/WinSxS/Installer/servicing, Program
   Files, ProgramData, Users or a profile root.
2. **Hard allow-list** (`Get-VxCleanAllowList`, code, not catalog): the root must lie in the user's Temp /
   LocalAppData / AppData / LocalLow, in `%WINDIR%\{Temp, Logs\CBS, Logs\DISM, Logs\WindowsUpdate, Logs\MoSetup,
   Logs\NetSetup, Minidump, LiveKernelReports, SoftwareDistribution\Download, ServiceProfiles\...\DeliveryOptimization,
   ServiceProfiles\LocalService\...\FontCache, System32\spool\PRINTERS}`, be `%WINDIR%\MEMORY.DMP` or
   `System32\FNTCACHE.DAT`, in `%PROGRAMDATA%\{Microsoft\Windows\WER, NVIDIA Corporation\Downloader,
   NVIDIA Corporation\NV_Cache, Blizzard Entertainment\Battle.net\Cache}`, `%SystemDrive%\{NVIDIA, AMD,
   $Windows.~BT, $Windows.~WS, Windows.old}` (the last three are only measured - cleanmgr deletes them),
   `<Steam>\{appcache\httpcache, logs, dumps, steamapps\shadercache}`, the recycle bin folders above, or any
   `<SystemDrive>\Users\<name>\AppData\Local\Temp`. A new catalog target outside it needs a code change.
3. The root and every folder above it must not be a junction/symlink; the walk never follows reparse
   points and deletes through `VeloxNative.SafeFs.DeleteUnder` (refuses anything whose real path left the root).
4. Files in use are skipped and counted (`locked`), the item stays `ok` with status `partial`.
5. `closeApps`: if one of the processes runs in this desktop session the item is **skipped** ("Chrome läuft
   gerade. Schließe … ganz") - a browser cache is never cleaned under a running browser. Browser items only
   name cache folders (Cache, Code Cache, GPUCache, Service Worker\CacheStorage + ScriptCache, ShaderCache,
   GrShaderCache, GraphiteDawnCache; Firefox cache2, startupCache, thumbnails, jumpListCache) - never
   cookies, history, logins, sessions or profiles.
6. `optin` items run only with `run-action` `confirmOptIn: true` (the UI asks with a required checkbox);
   `apply` never runs them. Never in the catalog: `Windows\Installer`, `Package Cache`, Prefetch, Defender
   folders, Documents/savegames.
7. A root shared by two items is measured and cleaned once (catalog order).

**Scan** (`clean-scan`): read-only walk, at most 15 s per item and 120 s in total (`partial:true` = "≥ X").

**Tools** (`tool` action, `Get-VxToolSpec`): `dism-scanhealth` (45 min), `dism-restorehealth` (90 min),
`dism-component-cleanup` (60 min), `dism-component-resetbase` (90 min), `sfc-scannow` (60 min), `chkdsk-scan`
(45 min), `cleanmgr-windows-old` (60 min; `cleanmgr /sagerun:9417` with StateFlags9417 set only for
"Previous Installations", "Temporary Setup Files", "Setup Log Files", "Windows Upgrade Log Files" and removed
afterwards - never "Windows ESD installation files", needed to reset the PC). Each runs as its own process
(`Invoke-VxToolProcess`, `System.Diagnostics.Process`, no PowerShell in between): stdout is read as **bytes**
with `ReadAsync` and only completed reads are looked at (rule 15), decoded with the OEM code page - or
UTF-16LE when the second byte is 0 / a FF FE BOM (sfc.exe writes wide characters into a pipe) - through a
stateful decoder, split on `\r` and `\n` (DISM/SFC redraw their bar with a bare `\r`; the unfinished last
segment is read too). Percent: DISM `[== 42.3% ]`, SFC `Überprüfung 45 % abgeschlossen.` / `Verification 45%
complete.`, CHKDSK `Total:`/`Gesamt:`. Every 0.5 s: `job.step` = "<Schritt> – 42,3 % · 3:12", `job.progress`
and `job.live` (percent, elapsedSec, note). No new output for 10 min → note "… wartet auf Windows" (a pending
update / the Windows Modules Installer); before DISM/SFC a pending CBS reboot or a running TiWorker is
logged. `job.skippable` is true the whole time: "Überspringen" / "Abbrechen" / the timeout end the **whole
process tree** (`Stop-VxProcessTree`, taskkill /T). Outcome from exit code + text (German and English):
DISM 0/3010 ok (3010 → needs reboot), 0x800F0806 pending reboot, 0x800F081F/0x800F0906 sources, 87, 740,
1726; ScanHealth "repairable"/"cannot be repaired" (+ `Repair-WindowsImage -CheckHealth` when the language
is unknown); SFC "keine Integritätsverletzungen" / "erfolgreich repariert" (→ reboot) / "nicht alle" (→ run
DISM first) / "Systemreparatur steht aus"; CHKDSK 0–2 ok, ≥3 → `/spotfix` hint. Freed bytes: `measure`
before/after, else the free space of the system drive before/after (DISM cleanup, cleanmgr).

**ps actions of kind `action`** (repair scripts, Store reset, TRIM …) run in `Invoke-VxIsolated` (own
`powershell.exe`, `-File`, `timeoutSec` default 600, skippable) - a hanging script can never block VELOX.

**Why DISM "hung" in older versions:** DISM/SFC/CHKDSK ran as `& dism.exe … 2>&1` *inside* the job runspace:
no timeout, no cancel (the runspace was blocked, `job.cancel` was never looked at), no output until the end
(captured, not streamed; the bar uses bare `\r`), the step text froze on "Führe aus: …" for 10–60 minutes and
every other job got 409 "busy". `Repair-WindowsImage -ScanHealth` loaded the DISM API into the worker itself.

---

## 4. Presets (`data/presets.json`)

```json
{
  "presets": [
    {
      "id": "gaming",
      "name": "Gaming Max",
      "tagline": "Maximale FPS, Sicherheit bleibt an",
      "desc": "Einfacher Satz, was das Preset macht und für wen es ist.",
      "icon": "gamepad",
      "maxRisk": "moderate",
      "recommendedFor": ["desktop"],
      "ids": ["gaming.gamedvr-off", "power.ultimate-plan"]
    }
  ]
}
```

Rules: every id must exist; no `risky` tweak in any preset; no `kind: action/remove` in presets except
the dedicated "Aufräumen" preset (cleanup actions allowed there); laptop preset contains no
`laptop-bad` tweak. Planned presets: `safe` (Sicherer Boost), `gaming` (Gaming Max),
`competitive` (Esport / Low Latency), `laptop` (Laptop & Akku), `privacy` (Datenschutz),
`streaming` (Streamer), `fivem` (FiveM / GTA V), `clean` (Aufräumen), `ultimate` (Alles außer riskant).

---

## 5. Detweak list (`data/detweak.json`)

"Detweak" resets values that **other** tweakers commonly change back to the Windows default, then
(optionally) applies VELOX tweaks. Scan first, show every deviation, reset only what the user keeps
selected, journal everything.

```json
{
  "registry": [
    { "path": "HKLM\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl", "name": "Win32PrioritySeparation",
      "kind": "DWord", "default": 2, "label": "CPU-Zeitverteilung (Win32PrioritySeparation)", "group": "CPU & Scheduler" }
  ],
  "registryKeys": [
    { "path": "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\*\\PerfOptions",
      "label": "Prozess-Prioritäten per IFEO", "group": "Prozesse" }
  ],
  "bcd": [ { "name": "useplatformclock", "label": "HPET erzwungen", "group": "Boot & Timer" } ],
  "services": [ { "name": "SysMain", "default": "Automatic", "label": "SysMain (Superfetch)", "group": "Dienste" } ],
  "tasks": [ { "path": "\\Microsoft\\Windows\\...", "default": true, "label": "…", "group": "Aufgaben" } ],
  "commands": [
    { "id": "dns-flush", "label": "DNS-Cache leeren", "desc": "…", "defaultOn": true,
      "needs": "none", "risk": "safe", "script": "ipconfig /flushdns" },
    { "id": "power-defaults", "label": "Energiepläne auf Standard", "desc": "…", "defaultOn": false,
      "needs": "none", "risk": "moderate", "script": "powercfg -restoredefaultschemes" }
  ]
}
```

- `registry[].default`: value or `null` (= delete). Same `kind`/path rules as §3. Entries are
  compared case-insensitively; a value that is absent counts as default when `default` is null.
- `registryKeys[]`: keys that do not exist on a clean install → listed if present, deleted on reset
  (exported to the journal first).
- `bcd[]`: always reset by `/deletevalue` (none of these exist by default).
- `services[]`: only listed when current start type ≠ `default` **and** the service exists. Only services
  whose default is certain for both Win10 and Win11 (or with `defaultWin11`).
- `tasks[]`: only listed when current state ≠ `default`.
- `commands[]`: optional extra resets shown as checkboxes (`defaultOn`), never silently run. Only
  harmless commands are `defaultOn: true` (today `dns-flush` and `trim-defaults`). Optional `risk`
  (`safe` default | `moderate`): `moderate` marks a command that changes system-wide behaviour (power
  plans reset, TCP globals, Defender, memory management, DEP, page file, network stack, policies …);
  the UI shows a "Mittel" badge. `tools/Validate-Catalog.ps1` accepts only `safe|moderate`.
- The detweak scan also includes every catalog `toggle` tweak whose status is not `default`.
- **Source of a scan item**: `detweak` (from this list), `catalog` (a catalog tweak another tool
  changed) or `velox` (a catalog tweak VELOX itself set). `velox` is decided from the journals in
  `backups\` of the current mode (Testmodus journals never count for the real PC and vice versa): every
  value of the tweak that is not at the Windows default must equal the `after` of the newest journal
  entry for that target, and that entry must come from a catalog tweak (not a detweak reset, a
  restore or a game boost). A value another tool set to the same number without a journal stays
  `catalog`. `velox` items are listed (they can be reset) but are **not foreign**.
- `current` / `default` of a catalog item are the real values ("0" → "1", "Deaktiviert" →
  "Automatisch", "nicht gesetzt") when the tweak changes exactly one value; otherwise the status text
  ("Angepasst" / "Teilweise angepasst" / "Von anderem Tool geändert" → "Windows-Standard").
- **foreignCount** = scan items whose source is not `velox`. It is stored with the foreign keys in
  `state` (`state.foreignCount`, `profile.foreignCount`) and kept in sync without a rescan: a detweak
  job removes what it reset or applied, an `apply`/`revert` job removes the tweaks it changed
  (journalled, `ok`). It stays `null` until the first detweak scan.

---

## 6. Simulate mode

`Velox.ps1 -Simulate` (and always on non-Windows) never writes to the system.

- Writes go to an in-memory overlay `$VxCtx.Sim` (a synchronized hashtable shared with the job
  runspace, persisted to `sim-state.json` in the data root).
- Reads check the overlay first. On Windows they then fall back to the **real** read (true dry run
  showing the real PC). Off Windows they fall back to a **seeded default state**: every `reg`
  action/detweak entry reads as its `default`, services read as their catalog/detweak `default`,
  tasks as enabled, BCD values absent, power plan `balanced`, Appx packages installed, features
  enabled.
- Off Windows, the overlay is seeded on first start (or `-SimReset`) with a handful of "foreign
  tweaks" (e.g. `Win32PrioritySeparation=38`, `SystemResponsiveness=0`, `useplatformclock=yes`,
  `SysMain` disabled, an IFEO `PerfOptions` key) so the detweak page has something to show.
- `ps` actions in simulate mode only record a flag; `clean` actions report fake sizes (on Windows: the real
  sizes, nothing deleted); `tool` actions feed fake DISM/SFC/CHKDSK output (bytes, `\r` bars, SFC as UTF-16)
  through the real reader in ~2.4 s (`VELOX_SIM_TOOL_MS`, tests `$VxCtx.TestToolMs`). With
  `VELOX_CLEAN_FIXTURE` (Testmodus) or `$VxCtx.CleanFixture` (tests) every token points into that fake PC
  (`tests/fixtures/clean/New-CleanFixture.ps1`; `running.txt` = running apps, `locked.txt` = files in use)
  and deletes really happen there;
  restore points are never created: a fake list in the overlay (`Sim.rp`, seeded with one Windows
  point and several old "VELOX: …" points like a PC that ran an older version) is listed, adopted,
  extended and cleaned up instead.
- `Scan` in simulate mode off Windows returns a fake profile (`-SimProfile desktop|laptop`), on
  Windows the real profile (reads are harmless).

---

## 7. HTTP API (Server.ps1 ⇄ ui/js/api.js)

Server binds `http://127.0.0.1:<port>/` (random free port unless `-Port`). A random 32-byte hex
token is generated unless `-Token` is given. The window opens `http://127.0.0.1:<port>/?t=<token>`.
When ready the backend prints exactly one line to stdout: `VELOX_READY http://127.0.0.1:<port>/?t=<token>`.

Security (MUST):
- Every `/api/*` request needs header `X-Velox-Token: <token>`; else 401.
  Exception: `POST /api/shutdown?t=<token>&s=<session>` (sendBeacon cannot set headers), and
  `GET|HEAD /api/game-art/<gameId>?…&t=<token>` (an `<img>` cannot set headers either).
- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; else 403 (DNS rebinding).
- If an `Origin` header is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>`; else 403.
- `OPTIONS` → 403, never send CORS headers.
- Static files only from `ui/`, path traversal rejected, correct `Content-Type`, `Cache-Control: no-store`.
- Responses: `application/json; charset=utf-8`, body UTF-8 bytes.

UI: reads `t` from `location.search` on load, keeps it in `sessionStorage`, removes it from the URL
with `history.replaceState`.

### Endpoints

| method & path | body | response |
|---|---|---|
| `GET /api/bootstrap` | – | `{ app, mode, categories, tweaks, presets, settings, state, busy }` |
| `GET /api/state` | – | `state` |
| `POST /api/jobs` | `{ type, params }` | `{ jobId }` or 409 `{ error:"busy", jobId, type }` (type = the running job's type) |
| `GET /api/jobs/<id>?since=<n>` | – | `job` |
| `POST /api/jobs/<id>/cancel` | – | `{ ok }` |
| `POST /api/jobs/<id>/skip` | – | `{ ok }` — "Überspringen": ends only the running **skippable** step (restore point, Detweak reset command, the current Reinigung item or repair tool); `ok:false` when none runs. The job goes on with its next step. |
| `POST /api/settings` | partial settings | `{ settings }` |
| `POST /api/claude/key` | `{ key }` | `{ hasKey: true }` |
| `DELETE /api/claude/key` | – | `{ hasKey: false }` |
| `POST /api/ai/key/<claude-api\|groq>` | `{ key }` | `{ provider, hasKey: true, settings }` — invalid key format → 400 `{ error }` (`sk-ant-…` / `gsk_…`); `/api/claude/key` = `claude-api` |
| `DELETE /api/ai/key/<claude-api\|groq>` | – | `{ provider, hasKey: false, settings }` |
| `GET /api/backups` | – | `{ backups: [ { id, label, kind, created, count, tweakCount, simulate, restorable } ] }` — `count` = journal entries (values), `tweakCount` = distinct catalog tweak ids in the journal |
| `GET /api/backups/<id>` | – | full journal |
| `POST /api/open` | `{ target }` | `{ ok }` — whitelist only: `ms-settings:*` URIs listed in Server.ps1, `backups` (opens folder) |
| `POST /api/heartbeat?s=<session>` | – | `{ ok, busy }` |
| `POST /api/shutdown?t=<token>&s=<session>` | – | `{ ok, closing }` (see below) |
| `GET /api/game-art/<gameId>?kind=cover\|icon&v=<v>&t=<token>` | – | the image bytes (`image/jpeg`, `image/png`, `image/x-icon`, …), `Cache-Control: private, max-age=86400` (the URL carries the art version `v`). Only images the last `games-detect` registered for that id — never a path from the request. Bad `kind` → 400, unknown id / no image / anything that is not a 10-hex id → 404. |

**Window sessions.** Every UI window has a random session id (`ui/js/api.js`) and sends it as `?s=`
with every heartbeat (every 3 s) and with the shutdown beacon on `pagehide`. The backend keeps the
last heartbeat per session. A shutdown beacon from session X ends VELOX after a 4 s grace period
only if **no other** session sent a heartbeat within the grace period before the beacon (then the
answer is `closing:false` and nothing is scheduled) and none arrives during it (a heartbeat of
another window, or a bootstrap, cancels). X's own heartbeat that arrives < 1 s after its beacon was
already in flight and does not cancel; a later one (the page came back from the back/forward cache)
does. Without `s` the old rule applies: the beacon always schedules the exit and any heartbeat
cancels it. A running job delays the exit until it ends; 150 s without any heartbeat also ends VELOX.

Objects:

```text
app      = { name:"VELOX", version:"1.0.0" }
mode     = { simulate, admin, windows, os:"Windows 11 Pro 23H2 (22631)", ps:"5.1.22621", userMismatch,
             desktopUser,    // desktopUser: the signed-in desktop account when VELOX was elevated with another
                             // account; HKCU writes and user folders then target that desktop user
             hosted }        // true = the UI runs in VELOX.exe's own window (-HostPid + -NoBrowser), §11
tweak    = catalog tweak as in §3 + { category, applicable: bool, naReason: string|null }
settings = { accent:"violet"|…,       // legacy (≤ 1.1): still stored and accepted, no longer applied (§10)
             motion:"full"|"reduced",
             startSound:true,       // the start sequence may play its sound (Einstellungen, M key); VELOX.exe
                                    // reads it from settings.json too (§11 "Start sound")
             introSeen:"",          // VERSION whose full intro the Edge window last played ("" = never);
                                    // only "" or d.d.d is accepted
             confirmRisky:true, restorePoints:"first"|"presets"|"off",   // §8 "Restore points"
             autoRestorePoint:true,   // read-only, derived (restorePoints != "off") for older UIs
             claude:{ hasKey:false, model:"claude-opus-5-5" },             // provider claude-api (§9)
             ai:{ provider:""|"claude-code"|"claude-api"|"groq"|"offline",   // "" = first ready one
                  claudeCode:{ model:"sonnet"|"opus"|"haiku" },              // default sonnet
                  groq:{ hasKey:false, model:"" } },                         // "" = automatic
             games:[...boosted games] }
             // settings.json of older versions stored the bool autoRestorePoint: true -> "first",
             // false -> "off" (migrated on load). POST /api/settings still accepts autoRestorePoint:
             // false -> "off", true -> "first" only when it was "off".
state    = { statuses:{ <tweakId>: "applied"|"default"|"partial"|"custom"|"na"|"unknown" },
             profile: profile|null, lastScan: iso|null, needs:{ explorer:false, reboot:false, logoff:false },
             foreignCount: n|null,    // foreign tweaks (§5), also in profile.foreignCount; null before the first detweak scan
             restorePointBaseline: { status:"created"|"adopted"|"skipped"|"timeout"|"failed", created:iso,
                                     sequence:n|null, description } | null }   // §8, null = none yet
job      = { id, type, status:"running"|"done"|"error"|"cancelled", progress:0..1, step:"German text",
             log:[ { i, t, level:"info"|"ok"|"warn"|"error", msg } ], result:object|null, error:string|null,
             skippable:bool,     // a step that "Überspringen" may end runs right now (POST …/skip)
             live:null|{ id, index, total, progress:-1|0..1, percent:-1|0..100, elapsedSec, files, freed, note,
                    done:[ run-action result rows ] },   // run-action only: the item running now + the finished ones
             durationMs:n }      // so far while running, the job's total once finished
             // every job result object also carries durationMs (engine time of the job body); the
             // UI shows it in the result toast ("27 Tweaks in 2,4 s angewendet")
             // log and error are user-visible German text: never PowerShell stack traces or error
             // positions ("at <ScriptBlock>, …", "At line:…") - those go to logs\velox-<date>.log only
```

Status meaning: `applied` all actions in tweak state; `default` all at Windows default; `partial`
mixed; `custom` a value is neither (set by another tool); `na` not applicable/not present;
`unknown` cannot detect. Kind `action` tweaks have no status entry.

### Job types

| type | params | result |
|---|---|---|
| `scan` | `{}` | `{ profile, statuses }` (also updates state) |
| `apply` | `{ ids, label, purpose? }` | `{ results:[{id, ok, status, error}], backupId, needs, durationMs, timing:{ prepMs, restorePointMs, tweaksMs, finishMs, perTweakMs } }` — `purpose` `preset`\|`plan`\|`toggles` (else derived from the label: `Preset: …` → preset, `KI-Plan…` → plan) only decides about an extra restore point (§8) |
| `revert` | `{ ids, label }` | same |
| `restorepoint` | `{ label }` | `{ ok, message, skipped, timedOut, baseline }` (a manual point; the first one VELOX ever makes counts as the baseline) |
| `restorepoint-list` | `{}` | `{ ok, items:[ { sequence, description, created, velox } ], keep, extra, baseline, mode, message }` — all restore points of the PC; `velox` = description starts with "VELOX"; `keep` = the VELOX point that stays (the recorded baseline, else the oldest VELOX point); `extra` = the other VELOX points |
| `restorepoint-clean` | `{}` | `{ removed, failed, kept, errors:[…], baseline }` — deletes every VELOX point except `keep` (`SRRemoveRestorePoint`); points of Windows and other programs are never touched; `keep` becomes the baseline |
| `restore` | `{ backupId }` | `{ restored, failed, errors:[…] }` |
| `detweak-scan` | `{}` | `{ items:[ { key, source:"detweak"\|"catalog"\|"velox", tweakId, label, group, current, default } ], commands:[ { id, label, desc, defaultOn, needs, risk:"safe"\|"moderate" } ], foreignCount }` |
| `detweak` | `{ keys, commands, thenApply:[ids], restorePoint }` | `{ reset, resetValues, commandsRun, failed, applied, skipped, backupId, needs, errors:[…], foreignCount }` — `resetValues` = values/keys reset, `commandsRun` = commands run, `reset` = both (kept for older UIs), `skipped` = commands the user skipped. `restorePoint:false` only rules out an extra point for this job; it never forces one (§8). Reuses the items of the last `detweak-scan` when no system-changing job ran since (≤ 30 min); each reset command runs in its own `powershell.exe` with a hard timeout (`timeoutSec` of the command, default 120 s) and "Überspringen"; afterwards only the touched tweaks are re-detected |
| `advisor` | `{ goal, text }` | `advisorResult` |
| `claude` | `{ goal, text, allowRisky }` | `advisorResult` + `{ model, usage }` (= `ai` with provider `claude-api`) |
| `ai` | `{ provider, goal, text, allowRisky }` | `advisorResult` + `{ provider, model, usage }` — provider `claude-code`\|`claude-api`\|`groq`\|`offline` (§9) |
| `ai-status` | `{ test? }` | `{ providers:[ row ], recommended:"claude-code", preferred }` — see §9 |
| `clean-scan` | `{}` | `{ items:[ { id, bytes, files, found, partial, measurable, running:[app names] } ], totalBytes }` — every kind `action` tweak with a `tier`, clean action or `measure`; `found:false` = nothing of it on this PC, `measurable:false` = size only known afterwards (DISM) |
| `run-action` | `{ ids, confirmOptIn?, expect?:{ <id>: files } }` | `{ results:[ { id, ok, freedBytes, message, status:"ok"\|"partial"\|"skipped"\|"failed", skipped, deleted, locked, running, durationMs } ], freedBytes }` — `expect` (file counts of the last scan) only drives the progress bar; live state in `job.live` |
| `startup-list` | `{}` | `{ items:[ { id, name, command, location, enabled } ] }` |
| `startup-set` | `{ id, enabled }` | `{ ok, item }` |
| `games-detect` | `{}` | `{ games:[ game ] }` (see "Game library" below) |
| `game-boost` | `{ path, priority, gpu, fso }` | `{ ok, game }` |
| `pick-file` | `{}` | `{ path }` (native dialog; `null` when cancelled or in simulate mode off Windows) |
| `explorer-restart` | `{}` | `{ ok }` - ends this session's Explorer; Windows restarts it. Only if it is not back after 15 s, the backend starts `explorer.exe` with the desktop Explorer's token taken beforehand (`CreateProcessWithTokenW`: not elevated, outside VELOX.exe's job object), never with `Start-Process`; without a token the job fails with Task-Manager instructions. |
| `reboot` | `{}` | `{ ok }` (`shutdown /r /t 10`; simulate: logged only) |

`goal` ∈ `gaming`, `competitive`, `balanced`, `privacy`, `laptop`, `streaming`, `fivem`.

Local advisor (core/Advisor.ps1, deterministic):
- **Recommended set** per goal: candidates (goal tags, free-text keywords, hardware rules; `moderate`
  only from the goal's preset, for this PC's hardware, on request or when it fixes a finding) ranked
  by priority, free-text match, finding fix, preset membership, goal relevance, impact, risk, id;
  conflicting tweaks removed (an applied one keeps its slot); capped per goal: balanced 25, gaming 40,
  competitive 55, privacy 50, laptop 30, streaming 40, fivem 45. The plan = the not yet applied part,
  so it never exceeds the cap and applying it empties it.
- **Reasons**: German, per goal tag and category (a network tweak in a gaming plan talks about ping),
  then the tweak's own description; the hardware is named only when it matters (vendor-specific
  tweak, SSD/HDD tweak, memory tweak with ≤ 16 GB RAM).
- **Score** = 50 + 50 × weighted share of the recommended set applied (weight = impact, half for side
  benefits) − finding penalties (bad 5, warn 3, info 1, at most 12; "no-backups" costs nothing). A
  stock Windows PC lands around 35–55, a fully applied plan around 85–95. 100 only when every
  recommended tweak is applied and no finding other than good news is left (else at most 99).
  `scoreAfter` = the same with the plan applied and findings fixed by a plan tweak gone. A finding
  whose fix tweak VELOX has applied since the last scan is not shown any more.
- Texts use German keywords, German quotes („…“) and de-DE numbers ("3,3 GB"). The "foreign tweaks"
  finding uses `foreignCount` (never VELOX's own tweaks).

```text
advisorResult = { engine:"local"|"claude"|"claude-code"|"groq", provider?, score:0..100, scoreAfter:0..100, summary:"German",
                  findings:[ { id, severity:"good"|"info"|"warn"|"bad", title, detail,
                               fix: { type:"tweaks", ids:[…] } | { type:"open", target } | { type:"page", page } | null } ],
                  plan:[ { id, reason, priority:1..3 } ] }
```

### Game library (`games-detect`, core/Extras.ps1)

```text
game = { id:"10 hex = short hash of the lower-case exe path", name, exe, path,
         source:"steam"|"epic"|"gog"|"ubisoft"|"ea"|"battlenet"|"riot"|"xbox"|"rockstar"|"fivem"|
                "minecraft"|"roblox"|"other"|"manual",
         appid?:"Steam app id / Epic AppName / GOG gameID / Ubisoft install id / Xbox identity",
         running?:true,                       // the exe was running during the detection
         boost:{ priority, gpu, fso, priorityTweak },
         art:{ cover:bool, icon:bool, shape:"wide"|"tall"|null, v:"art version" } }
```

Sources, each with its own time budget; a source that throws or runs out of time only loses its own
games; results are deduplicated by exe path (first source wins, `running` is merged in):
Steam (every library in `libraryfolders.vdf`, every fully installed `appmanifest_*.acf`; exe from a
curated app-id map, else the heuristic below), Epic (`Manifests\*.item`: DisplayName,
InstallLocation, LaunchExecutable; a launcher exe is swapped for the `*-Shipping.exe` next to it),
GOG (`GOG.com\Games\*`), Ubisoft Connect (`Launcher\Installs\*\InstallDir`), EA app / Origin (registry +
`EA Games\*\__Installer`), Battle.net (uninstall entries of Blizzard/Activision + known exe names),
Riot (`RiotClientInstalls.json`, Metadata yaml, default folders), Xbox / PC Game Pass (`XboxGames`
or the drive's `.GamingRoot`, `Content\MicrosoftGame.config` ExecutableList), Rockstar (registry),
FiveM / RedM / alt:V / RAGE MP, Minecraft (Java launcher, Java + Bedrock Appx), Roblox (newest
`Versions\*\RobloxPlayerBeta.exe`), uninstall entries of well-known game publishers, and running
processes with a full-screen window or an exe inside a typical game folder (`source:"other"`).
Exe heuristic: every `.exe` up to two folders deep (plus Unreal `Binaries\Win64`), never crash
handlers, launchers, redistributables, uninstallers, anti-cheat services, setup/helper/report tools;
known game exe names win, then Unreal `*-Shipping.exe`, then a name like the game, then the biggest.
Games boosted earlier (`settings.games`) are always kept.

Art (registered per id for `GET /api/game-art`): Steam's local library cache (old flat
`<appid>_header.jpg` / `_library_600x900.jpg` / `_icon.jpg` and the per-app folders
`librarycache\<appid>\header.jpg`, `library_600x900.jpg`, `<sha1>.jpg` icon), GOG `goggame-*.ico`,
Xbox `SplashScreenImage` + the largest `Square*Logo` scale; on Windows the exe's own icon fills the
gaps (IShellItemImageFactory via one Add-Type class, fallback `Icon.ExtractAssociatedIcon`), cached as
PNG under `<dataRoot>\cache\gameart\` (key = path + size + date) within a 12 s budget per detection.
The id → file map is saved next to them (`art-map.json`, Testmodus `art-map-sim.json`) and read back
lazily after a restart, so the images of the last detection are served before the next scan.
Running games: a window counts as fullscreen only when it covers its monitor **and** has no title
bar (a maximized normal window with an auto-hide taskbar covers the screen too).
Off Windows — or in Testmodus with `VELOX_GAMES_FIXTURE` set — the detection reads the fake PC in
`tests/fixtures/games/pc` (`system.json` = registry, processes, Appx; `C/`, `D/` = drives), with
generated placeholder art (no real logos).

Only one mutating job runs at a time (409 otherwise). Read-only jobs (`scan`, `clean-scan`,
`detweak-scan`, `advisor`, `claude`, `ai`, `ai-status`, `startup-list`, `games-detect`) are also serialized for simplicity.
Every job that changes something writes a journal **before** each change (§8).

---

## 8. Journal / backups

`backups\<id>.json` where id = `yyyyMMdd-HHmmss-<kind>`:

```json
{ "id": "...", "label": "Preset: Gaming Max", "kind": "apply|revert|detweak|restore|game|startup",
  "created": "2026-10-05T15:30:12", "simulate": false, "restorePoint": true,
  "entries": [
    { "op": "reg", "path": "HKLM\\…", "name": "X",
      "before": { "exists": true, "kind": "DWord", "value": 1 }, "after": { "exists": true, "kind": "DWord", "value": 0 }, "tweakId": "…" },
    { "op": "regkey", "path": "…", "before": false, "after": true, "tree": null },
    { "op": "service", "name": "SysMain", "before": "Automatic", "after": "Disabled" },
    { "op": "task", "path": "…", "before": true, "after": false },
    { "op": "bcd", "name": "…", "before": null, "after": "yes" },
    { "op": "powerplan", "before": "<guid>", "after": "<guid>" },
    { "op": "powersetting", "subgroup": "…", "setting": "…", "before": { "ac": 5, "dc": 5 }, "after": { "ac": 100, "dc": 5 } },
    { "op": "feature", "name": "…", "before": true, "after": false },
    { "op": "ps", "tweakId": "…", "mode": "apply" },
    { "op": "appx", "package": "…", "restorable": false }
  ] }
```

Restore replays entries in reverse order back to `before` (a deleted key tree is re-created from
`tree`, a `ps` entry runs the tweak's opposite script). The journal is written through one open
`FileStream` per job (`<id>.journal`, flushed after every entry, readable while open); on success
it becomes `<id>.json`, an interrupted job leaves the `.journal` behind and it is still listed.

### Restore points (core/Engine.ps1 `Invoke-VxAutoRestorePoint`)

The JSON journals make every change undoable, so Windows restore points (several GB each) are a
rare extra net, never one per job. `settings.restorePoints`:

| mode | behaviour |
|---|---|
| `first` (default) | exactly **one baseline** restore point before the very first change VELOX ever makes on this PC — recorded in the real-mode state (`state.restorePointBaseline` `{ status, created, sequence, description, attempts }`) and never repeated, whatever job comes first |
| `presets` | the baseline + one before presets, KI plans and Detweak jobs with **10+** tweaks/values, at most one per 24 h (`state.restorePointLast`) |
| `off` | none |

- Single toggles, revert, restore, cleanup, autostart and game boost never add a point beyond the
  baseline. No job forces one (the old Detweak checkbox only opts out).
- If VELOX points from an older version exist, the oldest one is **adopted** as baseline (no new
  point). The baseline is settled once `created`, `adopted` or `skipped`; after `timeout`/`failed`
  it is tried again in a later session (once per session, at most 3 attempts).
- Creation runs in its own `powershell.exe` (`Invoke-VxIsolated`) with a hard timeout of 90 s:
  `Checkpoint-Computer`, fallback WMI `SystemRestore.CreateRestorePoint`, then the new sequence
  number is read back. Computer protection switched off for the system drive (HRESULT
  `0x80070422` / code 1058) → German message how to switch it on, the job goes on (baseline status
  `failed`, tried again next session). Only a point the user asks for by hand (`restorepoint` job)
  runs `Enable-ComputerRestore` and tries once more; automatic points never change the protection
  settings. The job shows
  "Wiederherstellungspunkt wird erstellt – das kann bis zu 1–2 Minuten dauern" plus elapsed time,
  `job.skippable` is true and "Überspringen" ends just this step. Timeout, skip or failure → a
  warning in the log, the job goes on. `SystemRestorePointCreationFrequency` is set to 0 only for
  the baseline and a point the user asks for by hand, and restored to its previous value (or
  removed) right after.
- Clean-up: the Sicherungen page lists the restore points (`restorepoint-list`) and deletes the
  superfluous VELOX ones (`restorepoint-clean`, after a confirm dialog) with `SRRemoveRestorePoint`
  from `srclient.dll` (Add-Type P/Invoke in an isolated `powershell.exe`; timeout 60 s + 15 s per
  point, at most 15 min). The script prints `VXRM <sequence> <code>` after every point, so a timeout
  or "Überspringen" still reports which ones are gone.

### Job speed

- **One worker runspace** is kept alive and reused (`Jobs.ps1`): the core files are dot-sourced into
  it once; it is pre-warmed while VELOX is idle (also right after start — a job that arrives during
  the warm-up queues behind it instead of loading the core a second time) and replaced only after
  it crashed. Per-job state (`$VxCtx.Cache`, log buffer, open journals, COM objects) is reset by
  `Invoke-VxJobBody`.
- Real-Windows fast paths: scheduled tasks through one `Schedule.Service` COM connection per job
  (`GetTask().Enabled`), services through `ChangeServiceConfig`/`ControlService` P/Invoke
  (`VxNative.Svc`, compiled once, `sc.exe` only as fallback; a stopped service is not waited for),
  power settings from one `powercfg /qh <scheme>` per scheme and job (language independent parse),
  one deferred `/setactive` per job, the BCD and Appx lists read once per job.
- After a job only the touched tweaks are re-detected, not the whole catalog.
- Every job result carries `durationMs`; apply/revert also `timing` (see job types). The log file
  gets one line per tweak (`apply <id>: <n> ms`) and a summary line per job.
- Regression test (`tests/Run-Tests.ps1`, group `speed`): the biggest preset in the Testmodus must
  stay under 80 ms engine overhead per tweak.

---

## 9. KI providers (core/Claude.ps1, ui/js/ai.js)

The KI-Optimierer can ask four providers. All of them get the **same rules** (`Get-VxAiRulesText`:
only ids from the catalog data, prefer `safe`, `risky` only with `allowRisky`, situational tweaks only
when the user's text asks, laptop / vendor / X3D / HDD / RAM rules, reasons in simple German with
"du"), the **same output schema** and the **same validation**: `Select-VxClaudePlan` drops ids that
are unknown, not applicable, `kind != toggle`, `risky`/`security-off` without `allowRisky`,
`laptop-bad` on laptops, X3D-hostile on dual-CCD X3D, or clash with an earlier pick;
`Complete-VxAiResult` normalises findings (fix `null`, at most 12) and takes `score`/`scoreAfter`
from the local advisor's scoring of the resulting plan. Only the profile without user/computer/
adapter names and the tweak statuses are sent (the UI says so in one line).

| provider | how | needs | default model |
|---|---|---|---|
| `claude-code` (recommended) | the user's own Claude Code CLI, `claude -p`, subscription login | Claude Code installed + logged in (Pro/Max) | `sonnet` (alias; `opus`, `haiku`) |
| `claude-api` | raw HTTPS to the Messages API | Anthropic API key | `claude-opus-5-5` |
| `groq` | OpenAI-compatible chat API | free Groq API key | automatic (best available) |
| `offline` | `Invoke-VxAdvisor` (Smart-Analyse) | nothing | – |

Keys: `claude.key` / `groq.key` in the data root, `ConvertFrom-SecureString` (DPAPI, current user),
never returned to the UI (`settings.claude.hasKey`, `settings.ai.groq.hasKey` only), never logged.
Test-only overrides — `VELOX_ANTHROPIC_BASE_URL`, `VELOX_GROQ_BASE_URL`, `VELOX_CLAUDE_CLI`,
`VELOX_CLAUDE_CLI_ONLY=1` (discovery = override + PATH only, so tests never find a real install) — are honoured
only in the Testmodus or off Windows, so a planted user variable can neither redirect a key nor start
another program in real mode.

### Claude Code (`claude-code`)

Discovery (desktop user's folders, see `Get-VxUserFolder`): `VELOX_CLAUDE_CLI` (tests only) →
`%USERPROFILE%\.local\bin\claude.exe` (native installer) → `%APPDATA%\npm\claude.cmd` →
`%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe`, `…\WinGet\Packages\Anthropic.ClaudeCode*\claude.exe`,
`%ProgramFiles%\WinGet\Links\claude.exe` → `PATH` (`Get-Command claude`). An npm `.cmd` shim is
resolved to `node.exe` + `cli.js` (or the bundled `claude.exe`) so no argument passes cmd.exe; an
unresolvable shim runs through `cmd /d /s /c` without `--json-schema`.

Status without spending tokens: `claude --version` and `claude auth status` (JSON, exit 0 = logged
in; `email`, `subscriptionType`, `authMethod`). An old CLI without `auth` counts as "probably logged in".

Analysis (one process, hard timeout 180 s, "Abbrechen" kills the process tree):

```
claude -p --output-format json --model <sonnet|opus|haiku> --tools "" --no-session-persistence
       --setting-sources "" --system-prompt-file <tmp>\velox-system.txt --json-schema <advisor schema>
stdin:  the user content (goal, text, allowRisky, profile, statuses)
cwd:    an empty %TEMP%\velox-ki-<random> folder (deleted afterwards)
env:    CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 NO_COLOR=1
```

`velox-system.txt` = rules + the full catalog digest. Never `--bare`: it limits auth to
`ANTHROPIC_API_KEY` and would ignore the subscription login. The answer is the result JSON:
`structured_output` when present, else the first JSON object in `result`. Fallbacks: "unknown option"
→ one retry with only `-p --output-format json --model` and rules + digest + request on stdin;
`is_error` with a structured-output subtype → one retry without `--json-schema`. `is_error` texts are
mapped to German (not logged in → "claude auth login", usage limit, credit, overloaded, unknown
model, Git for Windows, network).

VELOX runs elevated, the CLI lives in user-writable folders: when VELOX has admin rights, every CLI
call (also `--version` / `auth status`) is started **without** them, with the token of the desktop's
Explorer (`VxAi.ShellChild`: `CreateProcessWithTokenW` + `CreateEnvironmentBlock`, redirected pipes,
C# 5 via `Add-Type`). That is also the desktop user's account when VELOX was elevated with another
admin account (`mode.desktopUser`). If that start fails (e.g. the "Sekundäre Anmeldung" service
seclogon is disabled): same account → plain child process (logged); other account → German
explanation that Claude Code must run from the user's own account. `CreateProcessWithTokenW` takes at
most 1024 characters of command line: when the full line with `--json-schema` would exceed 1000,
the analysis runs without the inline schema (the rules text still demands the JSON object). The
prompt itself never goes on the command line (stdin; system text via `--system-prompt-file`). An
npm `claude.cmd` shim is resolved to `node.exe` + `cli.js` (or the bundled `.exe`), skipping the
`"%dp0%\node.exe"` reference the shim names first.

Install text (German, in the status row and errors): PowerShell as a normal user →
`irm https://claude.ai/install.ps1 | iex` → `claude` and log in (Pro/Max) → "Erneut prüfen".
Login: `claude auth login` (or `claude` and `/login`).

### Claude API (`claude-api`)

PowerShell has no official Anthropic SDK, so this is raw HTTPS (`System.Net.Http.HttpClient`, TLS 1.2,
UTF-8 body bytes, 600 s timeout - a non-streaming call at effort "high" can take minutes). Base URL `https://api.anthropic.com` (override: env
`VELOX_ANTHROPIC_BASE_URL`, used by tests).

```
POST {base}/v1/messages
x-api-key: <key>            anthropic-version: 2023-06-01
anthropic-beta: server-side-fallback-2026-07-01
content-type: application/json

{ "model": "<settings.claude.model, default claude-opus-5-5>",
  "max_tokens": 16000,
  "fallbacks": "default",
  "output_config": { "effort": "high", "format": { "type": "json_schema", "schema": <advisor schema> } },
  "system": [ { "type": "text", "text": "<role + rules>" },
              { "type": "text", "text": "<catalog digest: id | name | category | risk | tags | desc | warning>", "cache_control": { "type": "ephemeral" } } ],
  "messages": [ { "role": "user", "content": "<profile JSON (no user/computer names) + current statuses + goal + free text>" } ] }
```

Schema: `{ summary: string, findings: [ { severity: good|info|warn|bad, title, detail } ], plan: [ { id, reason } ] }`
with `additionalProperties: false` everywhere. Handling: HTTP 401 → "API-Key ungültig", 429 → "Zu viele
Anfragen", 5xx/529 → one retry after 3 s, 400 mentioning `fallbacks` → retry once without
`fallbacks` + beta header. Check `stop_reason` before reading content: `refusal` → German message,
`max_tokens` → error. Parse the first `text` block as JSON. "Verbindung testen" = `GET /v1/models`
(free; 401 = wrong key).

### Groq (`groq`)

`POST https://api.groq.com/openai/v1/chat/completions` (override `VELOX_GROQ_BASE_URL`), header
`Authorization: Bearer <key>`, 90 s timeout. The free tier allows only ~8 000 tokens per minute, so
Groq gets the **compact** variant: the same rules (plan 5–20 tweaks) and a candidate list instead of
the whole catalog (`Get-VxCompactDigest`: the local advisor's recommended set for the goal, then the
other fitting candidates by impact, risky ones only with `allowRisky`; never applied/`na` ones; cut at
~9 000 characters), statuses left out. Body: `temperature 0.2`, `max_completion_tokens 2800`,
`response_format` `json_schema` (`strict: true`) for models that support it (`openai/gpt-oss-*`,
`qwen/qwen3*`), else `json_object`; gpt-oss also gets `reasoning_effort: "low"`, `include_reasoning: false`.

Model: `settings.ai.groq.model`, or (empty = automatic) the first available one of
`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`, `llama-3.3-70b-versatile`, Llama 4,
`llama-3.1-8b-instant` from `GET /openai/v1/models` (free; also "Verbindung testen", whose list —
chat models only, no whisper/guard/tts — feeds the model choice in the settings). Errors: 401 → key
invalid; 429 → one retry when `retry-after` ≤ 20 s, else German message with the wait time; 413 /
"Request too large" → one retry with a ~45 % shorter list; retired / unknown model → switch once to
the best available one; `json_validate_failed` or unreadable JSON → one retry with `json_object`;
5xx → one retry after 3 s; `finish_reason: length` → one retry with a shorter list.

### Jobs and UI

- `ai-status { test? }` → `{ providers, recommended:"claude-code", preferred }`. Rows:
  `claude-code { ready, installed, loggedIn, state: ready|missing|logged-out|error, version, account,
  subscription, authMethod, path, runsAs, model, message, steps[], installCommand }`,
  `claude-api|groq { ready, hasKey, state: ready|no-key|error, model, message, tested, ok, models? }`,
  `offline { ready:true }`. Without `test` only Claude Code is probed (no network request at all);
  `test` = one provider's free check. Background job in the UI (never blocks what the user starts).
- `ai { provider, goal, text, allowRisky }` → advisorResult with `engine` `claude` (API, kept for
  older UIs) | `claude-code` | `groq`, plus `provider`, `model` (served model), `usage`. A missing key
  fails before the first scan. `offline` = the `advisor` job.
- Einstellungen → "KI": one card per provider (status pill, "Empfohlen" on Claude Code, install/login
  steps with a copy button, "Erneut prüfen", key field with Speichern / Key löschen / "Verbindung
  testen", model choice per provider), one privacy line. KI-Optimierer: provider chips (2×2) with
  their state, preselected = last choice if ready, else the first ready of Claude Code → Claude API →
  Groq → Smart-Analyse; a not-ready chip explains what is missing and links to its card; while the
  model thinks the radar shows the backend's step with the elapsed time; a failed run shows the
  German error with "Smart-Analyse starten" and "Einstellungen öffnen".

---

## 10. UI design system (ui/)

The look is the brand kit **"Versatz"** (`brand/README.md` is the source of truth; `ui/brand/` holds
byte-identical copies made by `node tools/sync-brand.mjs`, never edited there). The user asked for an
ultra-modern UI with hover and click feedback on everything; since 1.2.0 it is calm and precise
instead of glossy: ink and bone, one signal colour, hairlines, mono readouts.

- **Tokens**: `ui/index.html` links `css/app.css`, `css/games.css`, then **`brand/tokens-app.css`**
  (maps the palette of `brand/tokens.css` onto `--bg`, `--s1…s4`, `--text`, `--muted`, `--faint`,
  `--ok/--warn/--err`, `--accent*`, `--on-accent`, `--focus-*`, `--selection-*`, `--risk-*`,
  `--nav-active-*`) and `brand/intro.css`. `app.css` defines no palette of its own, only neutral
  tints of bone (`--tint-1…4`), `--text-2`, `--sel-bg/--sel-edge` (selected states), `--edge-hi`,
  `--well`, radii, type and motion.
- **Palette**: Tinte `#0C0D0F` (ground) / `#141518` (panels, sidebar, cards) / `#1A1B1F` (raised) /
  `#212328` (hover, selected); Linie `#2A2C31` / `#45484F`; Knochen `#ECE9E2` (text, 16:1), Asche
  `#8E8B85` / `#807D77` (secondary / tertiary). **Signal `#FF5A1F`** with ink text on it (6.2:1).
- **Orange only for**: the primary button (`.btn-primary`, `.btn-brand` is the same), the active nav
  bar (2 px on the item's left edge), the focus ring (`2px solid` signal), the head of a progress bar
  (`.pbar::after`, position `--p` set by `setBar()` in `ui.js`) and the brand mark. Never for risk,
  never as a gradient, no glow, no second accent. Selected chips, rail items, radio cards, goals and
  palette rows are ink-4 with a bone hairline; switches are monochrome (on = a bone slot with an ink
  knob); checkboxes bone; the score ring is a bone arc. The old accent picker is gone
  (`settings.accent` is ignored).
- **Risk**: Sicher `#3FC98A`, Mittel `#E9C440`, Riskant `#F25A80` – text on its own 12 % tint (7.0 / 8.5 /
  5.0 : 1), always with the word and an icon. A Mittel badge never sits directly beside a primary button.
  `tests/ui` checks every badge and accent button for ≥ 4.5:1 against what is really behind it.
- **Type**: `--vx-font` (Segoe UI Variable Text …), `--vx-font-display`; **numbers and readouts in
  `--vx-mono`** (Cascadia Mono, tabular): score, stats, counters, percentages, versions, nav indices.
  Three text sizes (20 / 14 / 12) + one display size. Labels in sentence case, never uppercase with
  letter-spacing. No webfonts, no CDN.
- **Spacing** 4/8/12/16/24/32 only. Radius 4 (chips, badges), 6 (controls), 8 (cards, dialogs).
- **Motion**: 120–180 ms on the kit's curve (`--vx-ease`, expo-out). Hover = one step lighter surface or
  hairline + 1 px lift on clickable cards and buttons; press = scale .97–.99 (60–80 ms); switch knob with a
  short damped settle; page transitions (fade + 6 px, View Transitions API when available); a faint bone
  ripple (ink on the signal button); count-up numbers; skeleton loaders; toasts slide in. No aurora, no
  glow, no 3D tilt. `prefers-reduced-motion` and `settings.motion = "reduced"` turn all of it down to plain
  fades (the intro then uses its reduced variant).
- **Start sequence** (`ui/js/splash.js` + `brand/intro.js`): `#splash` is plain ink until the module runs.
  Started by VELOX.exe (`?from=host`, or `bootstrap.mode.hosted`): `still` + `handedOver` – the end pose
  VELOX.exe left, no sound – faded out when the data is in. Started by Start.bat: the full intro on the
  first start of a `VERSION` (`settings.introSeen`, localStorage as a second opinion), the short one
  otherwise; sound per `settings.startSound` (M / the sound button write it); blocked autoplay → "Ton:
  klicken" and the first click replays with sound. No bootstrap after 700 ms → a silent short intro.
  The first-run scan reports through the intro's loader (`status()` / `progress()`), under VELOX.exe
  through the intro's slot. Then `done()` (hand-over, never cut short), a 220 ms fade, `destroy()`.
  Einstellungen → "Startanimation abspielen" replays the full intro over the app.
- **Layout**: sidebar (232 px, collapsible to 72 px icons; the small wordmark + version, collapsed the
  mark) with mono page indices; top bar with command palette trigger (Ctrl+K), mode chips (Admin /
  Testmodus / Neustart nötig); content max 1180 px; sticky bottom bar for staged changes
  ("3 Änderungen · Verwerfen · Anwenden"). Works down to 900×600.
- **Pages**: Übersicht (dashboard), Tweaks (category tabs + search + risk filter), Presets,
  KI-Optimierer (Claude Code / Claude API / Groq / Smart-Analyse), Detweak, Spiele (game booster), Reinigung (scan → grouped list with sizes → Schnell / Gründlich / Alles → live progress per item, repair tools with duration note and live percent on the card; both without the modal overlay, the page re-attaches to a running job),
  Apps (autostart + bloatware), Sicherungen (backups/journal), Einstellungen.
- Every option has one grey line of explanation. Empty states explain what to do. Every action gives
  feedback (toast). Risk badges with text ("Sicher", "Mittel", "Riskant"). Risky tweaks need a confirm
  dialog with a checkbox. Icons are inline SVG (stroke 1.75), never emojis.
- Toggles are **staged**: flipping a switch adds to the pending bar; "Anwenden" starts one `apply`/`revert`
  job and shows a progress overlay with live log. Status `custom`/`partial` shows a hint badge
  ("Von anderem Tool geändert").
- **CSP** stays `script-src 'self'; style-src 'self'`: no inline `<style>`, `<script>` or `style`
  attributes; dynamic values go through CSSOM (`element.style`). `tests/ui` fails on any
  `securitypolicyviolation`.

---

## 11. Native host & installer (`native/`, `dist/`)

Two small **.NET Framework WinForms** exes built for **4.7.2** (every Windows 10 from 1803 on - also LTSC
2019 / 1809, which has no 4.8 - and Windows 11 have it, so nothing has to be installed; 4.8 / 4.8.1 run them
unchanged) around the unchanged PowerShell backend. VeloxSetup.exe checks the installed version first
(`Release` ≥ 461808 under `HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full`; older → German
dialog with the download link, `/S` → exit 1; unreadable → go on). Both use **WebView2** for their UI and
are AnyCPU without Prefer32Bit (64-bit process → 64-bit `powershell.exe`, 64-bit registry view).

| File | What |
|---|---|
| `VERSION` | the one version number (`1.2.1`; bump it for every `dist/VeloxSetup.exe` that leaves the house, so an installed build can be told apart and the setup offers *Aktualisieren*). Read by `native/Directory.Build.props` (assembly/file/informational version of both exes), by `Util.Version()` (registry `DisplayVersion`, installer UI) and by `Velox.ps1` (`$ctx.Version`, shown in the app). |
| `native/host/` | **VELOX.exe** – the installed app: `Program.cs` (elevation, single instance), `HostForm.cs` (window + WebView2 + navigation policy), `Backend.cs` (PowerShell process + job object), `Startup.cs` (start timeout, start-up texts, diagnosis of a blocked PowerShell), `FallbackHost.cs` (no WebView2 → Edge app window), `WindowPlacement.cs` (also `lastIntroVersion`), `StartPage.cs` (the start screen as an in-memory site), `start/` (the start screen: `splash.html`, `splash.css`, `splash.js` + `start/brand/` = byte-identical copies of `brand/`, all embedded as resources `start/…`), `app.manifest` (`asInvoker`, PerMonitorV2). |
| `native/setup/` | **VeloxSetup.exe** – installer + uninstaller: `Program.cs` (switches, AssemblyResolve, temp copy for uninstall), `SetupWindow.cs` (the only file with WebView2 types), `Installer.cs` (install/update/uninstall engine), `Payload.cs` (embedded zip), `WebView2Runtime.cs` (runtime download), `FallbackForm.cs` (plain native UI), `app.manifest` (`requireAdministrator`, PerMonitorV2). |
| `native/setup-ui/` | installer UI: `index.html`, `setup.css`, `setup.js` (ES module) + `brand/` (byte-identical copies of the brand kit: `intro.js`, `sound.js`, `glyphs.js`, `ticks.js`, `intro.css`, `kit.css`, `tokens.css`). Opening `index.html` over http shows a demo (`#update`, `#uninstall` in the URL pick the mode). |
| `native/shared/` | `Common.cs` (Log, Util), `EmbeddedSite.cs` (embedded resources served from memory as one `https://<host>/` origin; no WebView2 types), `WebViewData.cs` (the only place that picks WebView2 user data folders + desktop-user access), `DarkUi.cs` (dark native dialogs, `Brand` = the `brand/tokens.css` palette, the mark, the kit's hairline loader), `Settings.cs` (reads `settings.json` `startSound`, never writes it), `NativeMethods.cs` (P/Invoke). |
| `native/assets/` | `velox.ico` (16, 20, 24, 32, 40, 48, 64, 96, 128, 256 px) + `velox-256.png`, rendered by `make-icon.mjs` (Chromium 1:1 + ImageMagick) from the brand kit: 16 px `brand/mark-16.svg`, 20/24 px the pixel-fitted `brand/src/fit/mark-20/24.svg`, 32–256 px `brand/src/fit/app-icon-<n>.svg` (`brand/app-icon.svg` snapped to whole pixels per size); every frame is checked pixel-identical to `brand/export/`. Both exes use it. |
| `native/buildtool/` | net8 helper used only by the build: `pack` (payload.zip) and `verify` (checks the finished exe; compiles `shared/EmbeddedSite.cs` in and runs it against the files embedded in both exes). |
| `native/build.sh`, `native/Build.ps1` | build `dist/VeloxSetup.exe` (Linux/macOS resp. Windows, .NET SDK 8+). Deterministic: same sources → byte-identical exe. |
| `dist/VeloxSetup.exe` | the download (≈ 1.1 MB, budget 3 MB). `dist/obj/` is build output and ignored. |
| `tests/native/` | `run-setup-ui-tests.mjs` (installer UI + host start screen in Chromium, mocked bridge, screenshots), `Test-HostPid.ps1` (backend ↔ host contract, lifecycle), `wine-smoke.sh` (runs the real VeloxSetup.exe / VELOX.exe / Uninstall.exe under Wine + wine-mono with a fake `powershell.exe` from `wine/`; optional, skips without Wine). |

### The WebView2 browser process is untrusted-for-elevation (since 1.2.1)

**Rule: content from memory, user data folders in user-accessible folders.** Both exes may run elevated, but
the WebView2 *browser process* never gets their administrator rights: current runtimes run it de-elevated
(filtered token - the user SID is enabled, `BUILTIN\Administrators` is deny-only; Microsoft: "WebView2
processes cannot run elevated"), and under Windows 11 Administrator Protection it may run as the signed-in
user while the host runs as the shadow admin; over-the-shoulder elevation makes host and desktop two
different accounts. 1.2.0 broke on a real Windows 11 PC exactly here: the setup's user data folder and both
UIs lived in a private temp folder that only Administrators + SYSTEM may open (`Util.CreatePrivateTempDir`) -
the runtime showed the modal "Das Datenverzeichnis konnte nicht erstellt werden", VELOX.exe showed
`ERR_FILE_NOT_FOUND`. So:

- **Pages from memory.** `https://setup.velox.example/*` and `https://start.velox.example/*` are answered by
  `CoreWebView2.WebResourceRequested` from the embedded resources (`shared/EmbeddedSite.cs`; glue in
  `SetupWindow.cs` / `HostForm.cs`): `AddWebResourceRequestedFilter("https://<host>/*", All, Document)`
  (SDK 1.0.2903.40; on a runtime without `ICoreWebView2_22` the call throws `NotImplementedException` and the
  older two-argument overload is used), `Environment.CreateWebResourceResponse(new MemoryStream(bytes, false),
  status, reason, headers)` set synchronously on the UI thread (no deferral). Only exact names of embedded
  files are served (no file system behind it, so no traversal; dot segments are removed by the URL rules and
  can only reach the site's own files); `Content-Type` by extension (`text/html; charset=utf-8`,
  `text/javascript; charset=utf-8` for `.js` incl. ES modules, `text/css; charset=utf-8`, `image/svg+xml`,
  `image/png`, …) + `X-Content-Type-Options: nosniff` + `Cache-Control: no-store`; unknown name or type → 404,
  other methods than GET/HEAD → 405, other origins are not answered. The pages keep their strict CSP
  (`<meta>`). Nothing is extracted to disk; a folder mapping (`SetVirtualHostNameToFolderMapping`) is
  forbidden.
- **User data folders are normal user folders** (`shared/WebViewData.cs`, the only place that picks them):
  VELOX.exe `%LOCALAPPDATA%\Velox\webview2\<real|test>` (as in 1.1.x), VeloxSetup.exe a fresh
  `%TEMP%\VeloxSetup-WebView2-<random>` per run with the profile's inherited ACL, deleted after the run (retries
  for 6 s while the browser lets go, the rest at the next restart; leftovers older than 12 h at the next
  setup start). Both: the process user's own SID must have an allow entry (not only via Administrators),
  otherwise Modify (inherit) is added for it; if the desktop user - the owner of the shell window
  (`GetShellWindow` → `GetWindowThreadProcessId` → `OpenProcess` → `OpenProcessToken` → `TokenUser`) - is
  another account, it gets Modify (inherit) too. Entries are only added; protection and other entries stay.
- **The private Admins-only temp folder stays - only for what the elevated process itself loads**
  (`WebView2Loader.dll`, the setup's uninstall copy, the runtime bootstrapper).
- **Failures fall back, they do not hang in a runtime dialog:** a user data folder that cannot be created, or
  `CreateAsync` / `EnsureCoreWebView2Async` failing, is logged with HRESULT, folder and exception, and the
  setup shows its native `FallbackForm`, VELOX.exe its Edge-window fallback. Both also give up after 30 s
  without an answer from the runtime (a stuck runtime, or one waiting behind its own error dialog).
  **A page that does not load never stays on screen either:** the setup page must report `ready` within 15 s
  of its navigation and a failed load of it (an Edge error page, not `OperationCanceled`) is caught in
  `NavigationCompleted` - both switch to `FallbackForm` (nothing has been done before `ready`). VELOX.exe treats
  a start screen that fails to load or does not report `splash-ready` within 12 s as broken: it logs it, opens
  the app as soon as the backend is ready (no hand-over wait), and an error the start screen would have
  shown goes to the Edge-window fallback instead.
- **Background:** `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` is ignored for elevated hosts, so both set the
  control's `DefaultBackgroundColor` (`#0C0D0F`; the WinForms control applies it to the controller when it is
  created) and again after start-up. API options such as `AdditionalBrowserArguments
  "--autoplay-policy=no-user-gesture-required"` are honoured for elevated hosts and stay.
- **Guards:** `buildtool verify` fails if any source in `native/host|setup|shared` mentions
  `SetVirtualHostNameToFolderMapping`, if a `CoreWebView2Environment.CreateAsync` user data folder is not a
  variable set only from `WebViewData.*`, if a line derives a WebView2/UDF path from `TempDir` /
  `CreatePrivateTempDir`, if `EnsureCoreWebView2Async()` runs without an environment, or a `"file:` URL
  appears (with a self-test on known-bad samples); and it serves every embedded file of both exes through
  `EmbeddedSite` (200 + identical bytes + type, 404/405 cases, CSP kept).

### Velox.ps1 under VELOX.exe

VELOX.exe starts `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive
-ExecutionPolicy Bypass -File "<dir>\Velox.ps1" -NoBrowser -Port 0 -HostPid <pid> [-Simulate]` hidden
(`CreateNoWindow`), stdin closed, stdout/stderr read asynchronously in the system OEM code page (`GetOEMCP()` -
what PowerShell's hidden console starts with; not the user culture's code page, and 65001 with Windows'
"Beta: UTF-8" option), `PSModulePath` and
`VELOX_DATA_DIR` removed from its environment. The process goes into a **job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**, so neither it nor anything it starts can outlive VELOX.exe.

`-HostPid <int>` (default 0 = off) changes only this:

- start-up errors are printed as one line `VELOX_ERROR <text>` instead of waiting for Enter;
- not elevated in real mode → `VELOX_ERROR …`, exit 2 (VELOX.exe elevates itself; the backend never opens a second UAC prompt);
- another backend of the same mode already runs → `VELOX_RUNNING <url>` (VELOX.exe connects to it);
- a watcher runspace checks every 2 s whether that process still exists (and is the same process: start time) and otherwise asks the server loop to end (the normal shutdown path, a running job still finishes);
- `VELOX_STATUS <key>` before each start-up phase (`core`, `system`, `catalog`, `server`); VELOX.exe shows a German text for it (`Startup.cs`) and counts it as a sign of life;
- with `-NoBrowser` too (VELOX.exe's own window) the 150 s page-heartbeat timeout is off (`$ctx.Life.hostWindow`): the host ends the backend.

In every mode the server loop treats a wall-clock jump of more than 30 s between two rounds as a wake-up from
sleep/hibernation and counts it as a heartbeat - before, VELOX quit whenever the PC woke up with VELOX open.

Stdout lines VELOX.exe reacts to: `VELOX_READY http://127.0.0.1:<port>/?t=<token>` (only 127.0.0.1/localhost
with a token is accepted), `VELOX_RUNNING <url>`, `VELOX_ERROR <text>`, `VELOX_STATUS <key>`. Everything is also written to
`%LOCALAPPDATA%\Velox\logs\host.log`. `Start.bat` / `Start-Testmodus.bat` behave exactly as before.

### VELOX.exe

| Switch | Meaning |
|---|---|
| *(none)* | real mode. Not elevated → relaunch itself with `ShellExecute` verb `runas` and `--elevated`. UAC declined → dark dialog offering the Testmodus. |
| `--test` | Testmodus (`Velox.ps1 -Simulate`), never elevated. |
| `--elevated` | internal: marks the relaunch (no second attempt). |

- **Single instance per mode:** mutex `Local\VELOX-Host-real` / `Local\VELOX-Host-sim`. A second start broadcasts the registered window message `VELOX.Host.Activate.v1` (wParam 1 = real, 2 = Testmodus; allowed through UIPI with `ChangeWindowMessageFilterEx`) and exits; if the other instance is just closing (mutex gone within 4.5 s) it starts normally instead.
- **Window:** opens at once with the start screen (below), BackColor and the WebView2 control's `DefaultBackgroundColor` `#0C0D0F` (`--vx-ink`; no white flash - the env var `WEBVIEW2_DEFAULT_BACKGROUND_COLOR` alone is ignored for elevated hosts), dark title bar (`DwmSetWindowAttribute` 20, fallback 19), Windows 11 rounded corners + caption colour, min 900×600, default 1360×880 DIP clamped to the work area, size/position/maximized in `%LOCALAPPDATA%\Velox\window.json` (every write keeps the file's other keys), title `VELOX` / `VELOX – Testmodus`.
- **Start:** the backend must report `VELOX_READY` - at the latest **60 s after its last output line** and **180 s** after the start (a slow first start after boot or install keeps going while it prints its phases); otherwise (or if it exits) the start screen shows an error with the last 40 log lines and the buttons *Erneut versuchen* / *Testmodus* / *Log öffnen*. Ended without `VELOX_ERROR`: the stderr tail is checked for PowerShell refusing the script (execution policy forced by Group Policy, the virus scanner / AMSI, Constrained Language Mode) and the user gets a plain German explanation instead of "Code 1".
- **WebView2 watchdog:** if `CreateAsync` / `EnsureCoreWebView2Async` has not finished after **30 s** (a stuck runtime never throws), VELOX.exe gives up on WebView2 exactly as on an exception: `FallbackHost`.
- **WebView2:** user data folder `%LOCALAPPDATA%\Velox\webview2\<real|test>` (`WebViewData.ForHost`: browser access ensured as described above; failure → Edge fallback); environment options `Language de-DE` + `AdditionalBrowserArguments "--autoplay-policy=no-user-gesture-required"` (SDK 1.0.2903.40; the start sound plays without a click). A browser process that still owns the user data folder with other options (a VELOX that is just closing, or 1.1.x, which started without the argument) makes the new environment fail with `ERROR_INVALID_STATE` (0x8007139F): VELOX.exe then waits 0.6 s and tries again with a fresh WebView2 control (4 attempts), and the 5th attempt starts without the argument (the intro then runs silent and offers *Ton: klicken*) - never the Edge fallback for this. DevTools, browser accelerator keys, default context menu, status bar, zoom, pinch zoom, swipe navigation, autofill, password saving and host objects off. Only `http://127.0.0.1:<port>/` (and `localhost:<port>`) and the start screen (`https://start.velox.example/`) may load in the window; every other navigation is cancelled, user-initiated http(s) links and `window.open` open in the default browser **non-elevated** via `explorer.exe "<url>"`. Render process crash → reload; browser process crash → restart VELOX.exe. A failed load of the app (only the latest app navigation, never `OperationCanceled` - the start screen replaced by the app, or a navigation the host cancelled itself) is retried up to 3 times.
- **Close:** if `POST /api/heartbeat` says `busy`, ask first (*Trotzdem beenden* / *Weiter warten*). Then the window hides, the WebView is disposed (its heartbeats stop), `POST /api/shutdown?t=<token>`, wait up to **3 s**, then `TerminateJobObject` (the backend keeps its 4 s reload grace period, so it is normally ended by the job object; that is safe because every change is saved when it is made). Windows shutdown: request + terminate at once.
- **WebView2 runtime missing** (`GetAvailableBrowserVersionString` throws `WebView2RuntimeNotFoundException`, or creating the environment fails): `FallbackHost` – a small dark start window runs `Velox.ps1` hidden **without** `-NoBrowser` (the backend opens its Edge app window as with `Start.bat`); VELOX.exe stays alive as the job owner and ends when the backend ends.

**Start screen** (`native/host/start/`, since 1.2.0): `brand/intro.js` (the kit's start sequence with
sound) from byte-identical copies in `start/brand/`. ES modules need a real origin, so `NavigateToString`
(an opaque `data:` origin) cannot load it: VELOX.exe embeds the folder as resources `start/…` and answers
`https://start.velox.example/*` from memory (`StartPage.Load` → `EmbeddedSite`, `WebResourceRequested`; see
"untrusted-for-elevation" above - since 1.2.1, 1.2.0 extracted it to a private temp folder the browser could
not read; its leftovers `%TEMP%\VeloxStart-*` older than 12 h are removed). Start screen missing from the exe →
Edge fallback. Nothing can swap a file the elevated window shows: there is no file. The page keeps the strict
CSP (`default-src 'none'; script-src 'self'; style-src 'self'`; CSSOM only, no inline styles or scripts).
URL: `https://start.velox.example/splash.html?v=<VERSION>&variant=full|short|still&sound=1|0&test=1|0`:

- `variant`: `full` on the first start of a `VERSION` (VELOX.exe keeps `lastIntroVersion` in its own
  `window.json` and records it at once), `short` on every other start, `still` when the start screen comes
  back for an error after the app was already shown (no second intro, no sound, no keys).
- `sound`: `settings.json` `startSound` (`UserSettings.StartSound`: missing file / key / non-boolean → on,
  one retry after 50 ms while the backend replaces the file) or the user's choice from earlier in this run.
- Layout, timings, the M key, *Überspringen* / Esc and the hand-over pose are the kit's (`brand/README.md`).
  The Testmodus shows as a small "Sicher"-green label on the word's left margin, the version on the right.
- Errors go into `intro.slot` under the word (the word stays; the intro skips to its settled frame, the
  loader steps aside): title, message, the last 40 log lines (mono, rose left rule, scrolled to the end),
  *Erneut versuchen* (primary) / *Testmodus* / *Log öffnen*. After 6 s without READY a quiet hint
  ("Beim ersten Start kann das ein paar Sekunden dauern.") hangs in the slot.
- **Hand-over:** on `VELOX_READY` the host posts `ready`; the page answers `handover{ms}` (rest of the intro
  + the 430 ms hand-over), calls `intro.done()` and posts `continue` when it resolves; the host navigates on
  `continue` to `<app url>&from=host[&sound=on|off]`. Hard cap: without an answer the host navigates
  **1 s** after READY; with one at `min(ms + 250, 2300)` ms after READY - a broken animation can never hold
  the app back by more than ~1 s, a working one never ends on a struck-through word. If READY comes before
  the page reported `splash-ready`, `ready` is posted on `splash-ready` (the 1 s cap runs from READY).

Start screen protocol (`splash.js` ⇄ VELOX.exe, JSON web messages; only accepted from
`https://start.velox.example/` while the start screen - not the app - is shown):
host → page `mode{test}` · `status{text}` (VELOX_STATUS phase text → `intro.status()`) · `starting{text}` · `ready` · `error{title,message,log,canTest}`;
page → host `splash-ready` · `retry` · `test` · `openlog` · `sound{on}` (M / sound button; the host keeps it
for this run and forwards it to the app as `&sound=on|off`) · `handover{ms}` · `continue`.

#### Start sound and the hand-over to the app (contract between VELOX.exe and `ui/`, since 1.2.0)

- **Where the switch lives:** `settings.json` in the backend's data folder, which for VELOX.exe is always
  `%LOCALAPPDATA%\Velox\settings.json` (`[Environment]::GetFolderPath(LocalApplicationData)` + `\Velox`;
  VELOX.exe removes `VELOX_DATA_DIR` and passes no `-DataRoot`). The Testmodus uses the same file.
- **Key:** `startSound` – JSON boolean, top level. `true` = the start sequence may play its sound. Missing
  file, unreadable JSON, missing key or anything that is not a boolean → **`true`** (the default).
  The file is UTF-8 (written without BOM; accept one). The backend replaces it atomically
  (`settings.json.tmp` → delete → move), so for a moment it can be missing: read it once at start, retry
  once after ~50 ms if it is missing or does not parse, then use the default.
- **VELOX.exe only reads it.** The backend owns the file and rewrites it whole on every settings change; a
  second writer would lose changes. `startSound:false` → mount the start screen with `muted: true` (the
  sound button then says "Ton aus" and M turns it on for this start).
- **M / the sound button in VELOX.exe's start screen:** the host does not write the file. It appends the
  user's last choice to the app URL when it navigates after `continue`:
  `http://127.0.0.1:<port>/?t=<token>&from=host` plus `&sound=on` or `&sound=off` **only if the user
  changed it** on the start screen. The app saves it (`POST /api/settings {startSound}`) and removes
  `from`/`sound` from the address bar together with `t`.
- **`from=host`** tells the app that VELOX.exe already played the intro: the in-app splash then shows only
  the hand-over end pose (`still` + `handedOver`, no sound, no second intro) and fades out when the first
  data is in. As a fallback (reload inside VELOX.exe, a host that forgot `from=host`) the app also trusts
  `bootstrap.mode.hosted` (true when the backend runs with `-HostPid` **and** `-NoBrowser`).
- **Full or short?** VELOX.exe decides for its own start screen (first start after an install / update →
  `full`, else `short`; keep that memory in the host, e.g. in `window.json`, never in `settings.json`).
  The app keeps `settings.introSeen` (the `VERSION` whose full intro the Edge window last played) for the
  Start.bat path only; VELOX.exe may read it but must not write it.
- localStorage is no help across starts: the app's origin carries a random port, so every start is a new
  origin. That is why both values live in `settings.json`.

### VeloxSetup.exe

One file (manifest `requireAdministrator`). Embedded resources: `payload.zip` (the app: `Velox.ps1`,
`Start.bat`, `Start-Testmodus.bat`, `README.md`, `VERSION`, `core/`, `ui/`, `data/`, plus `VELOX.exe`,
`VELOX.exe.config`, `Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`,
`runtimes/win-{x64,x86,arm64}/native/WebView2Loader.dll`; never `tests/`, `tools/`, `docs/`, `native/`)
and `ui/index.html`, `ui/setup.css`, `ui/setup.js`.

Its own WebView2: the managed DLLs are loaded from `payload.zip` through `AppDomain.AssemblyResolve`
(registered first thing in `Main`; all WebView2-typed code is in `SetupWindow.cs`, called through
`[NoInlining]` methods so it is JIT-compiled after that); `WebView2Loader.dll` for the process
architecture is extracted to a private temp folder and announced with
`CoreWebView2Environment.SetLoaderDllFolderPath` before any other WebView2 call. The UI (every embedded
resource `ui/…`: the three files and `ui/brand/*`) is answered from memory as `https://setup.velox.example/*`
(`EmbeddedSite`, `WebResourceRequested` - never extracted, see "untrusted-for-elevation" above); only
`https://setup.velox.example/` may load (`index.html?sound=0|1[&mode=uninstall]`; `sound` = `settings.json`
`startSound`, read only). User data folder: a fresh `%TEMP%\VeloxSetup-WebView2-<random>` per run
(`WebViewData.NewSetupRun`; normal inherited ACL, never inside the private temp folder; deleted after the
run). Environment options: `de-DE` + `--autoplay-policy=no-user-gesture-required` (fresh folder per run, so no
option clash; if the runtime still refuses, it starts again without it in another fresh folder). Window
background `#0C0D0F` and the WebView2 control's `DefaultBackgroundColor` (the env var is ignored for elevated
hosts), DWM border `--vx-line`. Window: borderless 880×560 DIP (scaled, clamped), drop
shadow, rounded corners, own title bar (drag = `ReleaseCapture` + `WM_NCLBUTTONDOWN/HTCAPTION`, only while `GetAsyncKeyState` says the primary button is still down).

WebView2 runtime missing → dark native dialog: download the Evergreen bootstrapper
(`https://go.microsoft.com/fwlink/p/?LinkId=2124703`) and run it with `/silent /install`; still
missing → `FallbackForm`, a plain native install/uninstall UI with the same engine.

| Switch | Meaning |
|---|---|
| *(none)* | install UI; when VELOX is installed already: update UI. |
| `/S` | silent install (no UI, VELOX is not started). With `/D=<folder>` another folder (NSIS style: may be unquoted with spaces when it is the last argument - it is read from the raw command line; `"/D=<folder>"` works too), `/nodesktop`, `/nostartmenu`. |
| `/uninstall` | uninstall UI (`Uninstall.exe /uninstall` is the `UninstallString`). |
| `/uninstall /S` | silent uninstall, keeps settings and backups; `/purge` deletes `%LOCALAPPDATA%\Velox` too. The launching `Uninstall.exe` waits for the temp copy's **result file** (`--parent <pid> --result <file>`), exits with that code, and the copy then deletes the launcher's `Uninstall.exe` and the empty folder (a running exe cannot be deleted). |
| `--from-temp --dir <folder> [--parent <pid> --result <file>]` | internal: the uninstaller copies itself to `%TEMP%\VeloxUninstall-*` and runs from there so it can delete its own folder. That temp copy (and the loaded `WebView2Loader.dll`) cannot delete itself: it is registered for deletion at the next restart (`MoveFileEx` delay-until-reboot, like NSIS) - no `cmd /c ping & rd` helper, which antivirus heuristics flag. |

Exit codes: 0 ok, 1 error, 2 closed before finishing, 5 not elevated. Log: `%TEMP%\VeloxSetup.log`.

**Install steps** (the same for install and update): check the folder (a folder not named `VELOX` gets
`\VELOX` appended; no network drives, not below `%windir%`, no `[ ]` in the path - Windows PowerShell 5.1 reads them as wildcards in `-File`) and free space → close a running VELOX
(`VELOX.exe` from that folder via `CloseMainWindow`, 12 s, then kill; PowerShell processes whose command
line contains `<dir>\Velox.ps1` via WMI) → create the folder (outside Program Files: ACL admins/SYSTEM full,
users read, owner Administrators) → extract with progress → copy itself as `<dir>\Uninstall.exe` (its `Zone.Identifier` stream - the download's Mark of the Web - is removed, so uninstalling from the Windows settings shows no SmartScreen warning) → delete files of the old
version that are gone (list in the hidden `<dir>\.velox-files`) → shortcuts via `WScript.Shell` (common
Start menu `VELOX.lnk` + `VELOX Testmodus.lnk` (`--test`), common desktop `VELOX.lnk`, icon from VELOX.exe)
→ registry → optionally start VELOX.exe (it elevates itself if needed).

Registry `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\VELOX` (64-bit view): `DisplayName`
`VELOX`, `DisplayVersion` (from `VERSION`), `Publisher` `VELOX`, `DisplayIcon` `<dir>\VELOX.exe,0`,
`InstallLocation`, `UninstallString` `"<dir>\Uninstall.exe" /uninstall`, `QuietUninstallString`
`"<dir>\Uninstall.exe" /uninstall /S`, `EstimatedSize` (KB, DWORD), `NoModify` 1, `NoRepair` 1,
`InstallDate` (yyyyMMdd). An existing entry means "update".

**Uninstall:** close VELOX → delete the shortcuts → delete exactly the installed files (manifest + payload
list; locked ones on reboot) and empty folders → delete the registry entry → optionally
`%LOCALAPPDATA%\Velox` (settings, backups, logs). Applied tweaks stay active – the UI says so and points to
*Sicherungen* in VELOX.

**Message protocol** (`setup-ui` ⇄ `SetupWindow.cs`, JSON objects via `chrome.webview.postMessage` /
`PostWebMessageAsJson`; only messages from `https://setup.velox.example/` are accepted):

| Direction | Message |
|---|---|
| page → setup | `ready` (page loaded) · `drag` · `minimize` · `close` (ignored while busy) · `browse{dir}` · `checkRunning` · `install{dir, desktop, startMenu, launch, closeRunning}` · `uninstall{keepData, closeRunning}` · `launch` (start VELOX and close) · `openLog` · `exit` · `sound{on}` (M in the intro; logged only - the setup never writes the app's settings) |
| setup → page | `init{version, mode: install\|update\|uninstall, installedVersion, dir, defaultDir, sizeMB, freeMB, running}` · `folder{dir, error, freeMB}` · `running{running}` · `progress{percent, step, file}` (≤ ~30/s) · `done{mode, launched}` · `error{message, hint}` |

Screens (one continuous surface, `brand/README.md` "How each surface embeds it"): the intro is
`brand/intro.js` **full** with sound (`short` for `/uninstall`), `place: 'header'`, `loader: false`; Esc /
Enter / Space / *Überspringen* or a click skip it, M / the sound button mute it (`prefers-reduced-motion` →
the kit's 0.8 s fade). Every screen lives in `intro.slot` under the wordmark, so the word never moves:
welcome (install / update; headline, mono readouts *Ziel* / *Größe* / *Version*, update shows
`1.1.1 → 1.2.0`) arrives under the settled word, then options → progress → done / error, or uninstall. A
running VELOX is only closed after the confirm dialog. Orange only on the V's foot, the one primary button
per screen, the current tick and the focus ring; switches are monochrome (bone when on); errors use the
kit's rose (`--vx-risk`).

Motion = the kit's language, all frame-rate independent, nothing loops while idle: screens arrive 8 px up
with `--vx-ease` (460 ms; reduced motion: a 200 ms fade). Progress = the kit's tick row (`brand/ticks.js`):
1-device-pixel ticks, finished ones bone, the current one the only orange, status left, `42 %` mono right,
the current file in mono below. Done = the row runs to 100 %, turns all bone (the orange tick goes away),
then the done screen with the finished row as a quiet trace (*Installiert* / *Aktualisiert* / *Entfernt*).
Error = the row stops where it failed, its current tick rose (*Abgebrochen bei 40 %*). No confetti, rings,
particles, aurora, gradients or glow.

Native fallbacks (`DarkDialog`, the setup's `FallbackForm`, the WebView2 download window, VELOX.exe's
`FallbackForm`) use the same palette (`Brand` in `DarkUi.cs` = `brand/tokens.css`), the mark / app-icon
drawing and the kit's hairline loader with a 2 px signal segment; buttons are solid signal with ink text or
hairline.

### Build & checks

`native/build.sh` (or `native/Build.ps1`): `dotnet build` VELOX.exe → `buildtool pack` (payload.zip, sorted,
fixed timestamps) → `dotnet build` VeloxSetup.exe with the payload → copy to `dist/` → `buildtool verify`:
manifests (`requireAdministrator` / `asInvoker`, PerMonitorV2; parsed strictly as XML like Windows' SxS
loader does - "--" in a comment once made VELOX.exe refuse to start), icon + version resources, versions =
`VERSION`, embedded resources, **the brand kit**: VELOX.exe's `start/brand/*` and the setup's `ui/brand/*`
are exactly the runtime files that surface needs and byte-identical to `brand/` (and `start/*.html|css|js`,
`ui/index.html|setup.css|setup.js` identical to their sources; `build.sh` / `Build.ps1` also run
`brand/tools/check-copies.mjs` before building - fix a difference with `node tools/sync-brand.mjs`, never
by editing a copy), payload = every app file byte-identical and nothing else, CRLF of the
`.bat`s and BOM of `Velox.ps1` kept, WebView2Loader machine types, size ≤ 3 MB; both exes built for
4.7.2 = `VELOX.exe.config`'s `sku` = the setup's .NET check (`Util.NetFrameworkMinRelease`); every
non-framework assembly VELOX.exe, the setup and the WebView2 DLLs reference is in the payload root with the
exact name, version and public key token; both embedded sites served through `EmbeddedSite` and the WebView2
source guards (see "untrusted-for-elevation"). Then
`node tests/native/run-setup-ui-tests.mjs` and `pwsh tests/native/Test-HostPid.ps1`; with Wine installed
also `tests/native/wine-smoke.sh` (≈ 4 min). WebView2, UAC and shortcuts cannot run under Wine; every
Win32/COM/WebView2 call is wrapped and logged.
