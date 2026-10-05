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
    Claude.ps1            optional Claude API advisor (raw HTTPS, see §9)
    Extras.ps1            cleanup sizes/actions, startup manager, game booster, file picker
    Jobs.ps1              background runspace job runner (one mutating job at a time)
    Server.ps1            HttpListener, routing, auth, static files
  data/
    categories.json       category list (id, name, desc, icon, order)
    tweaks/<category>.json  catalog, one file per category (schema §3)
    presets.json          presets (§4)
    detweak.json          foreign-tweak reset list (§5)
  ui/
    index.html
    css/app.css
    js/app.js, js/api.js, js/ui.js (components), js/icons.js, js/pages/<page>.js
  tests/
    Run-Tests.ps1         backend tests (pwsh 7 on Linux AND Windows PowerShell 5.1) — simulate mode
    fixtures/             small fixture catalog + fake profiles + fake Claude responses
    ui/run-ui-tests.mjs   Playwright end-to-end tests against `Velox.ps1 -Simulate -NoBrowser`
  tools/
    Validate-Catalog.ps1  strict schema validation of data/ (used by tests, run it after every edit)
    Normalize-Files.ps1   UTF-8 BOM for .ps1, CRLF for .bat
  docs/ARCHITECTURE.md    this file
  README.md               German user guide
```

Runtime data lives in `%LOCALAPPDATA%\Velox\` (or `-DataRoot`):
`settings.json`, `claude.key` (DPAPI-encrypted), `state.json` + `instance.json` (real mode), `state-sim.json` + `instance-sim.json` + `sim-state.json` (Testmodus - the two modes never share state or the single-instance lock), `backups\<id>.json`, `logs\`, `edge-profile\`.

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
| `clean` | `paths` (array, env vars allowed, wildcard only in the last segment), `keep?` (names to keep), `stopServices?` | delete files (skip locked), report freed bytes | — (kind `action`) | — |
| `ps` | `apply` (PowerShell source), `revert` (source or null), `detect` (source returning `$true`/`$false`/`$null`, or null) | run `apply` | run `revert` | `detect` result |

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
- Kind `action` tweaks (cleanup/repair) have no revert and no status; kind `remove` (Appx) shows
  "entfernt"/"installiert".

**Never put these in the catalog** (they break Windows or remove protection without real gain):
disabling Windows Defender / Tamper Protection, disabling the firewall, disabling UAC, disabling
Windows Update entirely, removing Microsoft Store / App Installer / frameworks / VCLibs / UI.Xaml /
Xbox Identity Provider / Edge WebView2, disabling `AppXSvc`, `StateRepository`, `CryptSvc`,
`BFE`, `Dhcp`, `Dnscache`, `RpcSs`, `AudioSrv`, `Winmgmt`, `EventLog`, `WinDefend`, `mpssvc`,
`wuauserv`, `BITS`, `TrustedInstaller`, `ProfSvc`, `Schedule`, `Power`, `PlugPlay`, `LSM`,
disabling the page file, `DisableAntiSpyware`, disabling DEP (`nx AlwaysOff`), deleting Windows.old
automatically, editing the hosts file to block Microsoft.

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
- `ps` actions in simulate mode only record a flag; `clean` actions report fake sizes;
  restore points are logged, not created.
- `Scan` in simulate mode off Windows returns a fake profile (`-SimProfile desktop|laptop`), on
  Windows the real profile (reads are harmless).

---

## 7. HTTP API (Server.ps1 ⇄ ui/js/api.js)

Server binds `http://127.0.0.1:<port>/` (random free port unless `-Port`). A random 32-byte hex
token is generated unless `-Token` is given. The window opens `http://127.0.0.1:<port>/?t=<token>`.
When ready the backend prints exactly one line to stdout: `VELOX_READY http://127.0.0.1:<port>/?t=<token>`.

Security (MUST):
- Every `/api/*` request needs header `X-Velox-Token: <token>`; else 401.
  Exception: `POST /api/shutdown?t=<token>&s=<session>` (sendBeacon cannot set headers).
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
| `POST /api/settings` | partial settings | `{ settings }` |
| `POST /api/claude/key` | `{ key }` | `{ hasKey: true }` |
| `DELETE /api/claude/key` | – | `{ hasKey: false }` |
| `GET /api/backups` | – | `{ backups: [ { id, label, kind, created, count, tweakCount, simulate, restorable } ] }` — `count` = journal entries (values), `tweakCount` = distinct catalog tweak ids in the journal |
| `GET /api/backups/<id>` | – | full journal |
| `POST /api/open` | `{ target }` | `{ ok }` — whitelist only: `ms-settings:*` URIs listed in Server.ps1, `backups` (opens folder) |
| `POST /api/heartbeat?s=<session>` | – | `{ ok, busy }` |
| `POST /api/shutdown?t=<token>&s=<session>` | – | `{ ok, closing }` (see below) |

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
             desktopUser }   // desktopUser: the signed-in desktop account when VELOX was elevated with another
                             // account; HKCU writes and user folders then target that desktop user
tweak    = catalog tweak as in §3 + { category, applicable: bool, naReason: string|null }
settings = { accent:"violet"|"blue"|"cyan"|"green"|"pink"|"orange", motion:"full"|"reduced",
             confirmRisky:true, autoRestorePoint:true,
             claude:{ hasKey:false, model:"claude-opus-5-5" }, games:[...boosted games] }
state    = { statuses:{ <tweakId>: "applied"|"default"|"partial"|"custom"|"na"|"unknown" },
             profile: profile|null, lastScan: iso|null, needs:{ explorer:false, reboot:false, logoff:false },
             foreignCount: n|null }   // foreign tweaks (§5), also in profile.foreignCount; null before the first detweak scan
job      = { id, type, status:"running"|"done"|"error"|"cancelled", progress:0..1, step:"German text",
             log:[ { i, t, level:"info"|"ok"|"warn"|"error", msg } ], result:object|null, error:string|null }
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
| `apply` | `{ ids, label }` | `{ results:[{id, ok, status, error}], backupId, needs }` |
| `revert` | `{ ids, label }` | same |
| `restorepoint` | `{ label }` | `{ ok, message }` |
| `restore` | `{ backupId }` | `{ restored, failed, errors:[…] }` |
| `detweak-scan` | `{}` | `{ items:[ { key, source:"detweak"\|"catalog"\|"velox", tweakId, label, group, current, default } ], commands:[ { id, label, desc, defaultOn, needs, risk:"safe"\|"moderate" } ], foreignCount }` |
| `detweak` | `{ keys, commands, thenApply:[ids], restorePoint }` | `{ reset, resetValues, commandsRun, failed, applied, backupId, needs, errors:[…], foreignCount }` — `resetValues` = values/keys reset, `commandsRun` = commands run, `reset` = both (kept for older UIs) |
| `advisor` | `{ goal, text }` | `advisorResult` |
| `claude` | `{ goal, text, allowRisky }` | `advisorResult` + `{ model, usage }` |
| `clean-scan` | `{}` | `{ items:[ { id, bytes, files } ] }` |
| `run-action` | `{ ids }` | `{ results:[ { id, ok, freedBytes, message } ] }` |
| `startup-list` | `{}` | `{ items:[ { id, name, command, location, enabled } ] }` |
| `startup-set` | `{ id, enabled }` | `{ ok, item }` |
| `games-detect` | `{}` | `{ games:[ { id, name, exe, path, source, boost:{ priority, gpu, fso } } ] }` |
| `game-boost` | `{ path, priority, gpu, fso }` | `{ ok, game }` |
| `pick-file` | `{}` | `{ path }` (native dialog; `null` when cancelled or in simulate mode off Windows) |
| `explorer-restart` | `{}` | `{ ok }` |
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
advisorResult = { engine:"local"|"claude", score:0..100, scoreAfter:0..100, summary:"German",
                  findings:[ { id, severity:"good"|"info"|"warn"|"bad", title, detail,
                               fix: { type:"tweaks", ids:[…] } | { type:"open", target } | { type:"page", page } | null } ],
                  plan:[ { id, reason, priority:1..3 } ] }
```

Only one mutating job runs at a time (409 otherwise). Read-only jobs (`scan`, `clean-scan`,
`detweak-scan`, `advisor`, `claude`, `startup-list`, `games-detect`) are also serialized for simplicity.
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
`tree`, a `ps` entry runs the tweak's opposite script). Before any job that changes the system,
when `settings.autoRestorePoint` is on, a Windows restore point is created once per session
(`Checkpoint-Computer`, temporarily setting `SystemRestorePointCreationFrequency=0`; if System
Restore is off it is enabled for the system drive; failure is logged as a warning, never fatal).

---

## 9. Claude advisor (core/Claude.ps1)

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
              { "type": "text", "text": "<catalog digest: id | name | category | risk | tags | desc>", "cache_control": { "type": "ephemeral" } } ],
  "messages": [ { "role": "user", "content": "<profile JSON (no user/computer names) + current statuses + goal + free text>" } ] }
```

Schema: `{ summary: string, findings: [ { severity: good|info|warn|bad, title, detail } ], plan: [ { id, reason } ] }`
with `additionalProperties: false` everywhere. Handling: HTTP 401 → "API-Key ungültig", 429 → "Zu viele
Anfragen", 5xx/529 → one retry after 3 s, 400 mentioning `fallbacks` → retry once without
`fallbacks` + beta header. Check `stop_reason` before reading content: `refusal` → German message,
`max_tokens` → error. Parse the first `text` block as JSON; drop plan ids that are unknown, not
applicable, `kind != toggle`, or `risky` (unless `allowRisky`). Score/scoreAfter come from the local
advisor's scoring of the resulting plan. The key is stored DPAPI-encrypted (`ConvertFrom-SecureString`)
in `claude.key`, never returned to the UI, never logged.

---

## 10. UI design system (ui/)

The user asked for an **ultra-modern** UI with hover and click animations on everything.

- **Theme**: dark by default. Background `#0F1115`, surfaces `#151821` / `#1B1F2A` / `#232838`,
  hairline `rgba(255,255,255,.06)`, text `#E8EAF0`, muted `#9AA3B2`, faint `#6B7385`.
  One accent (default violet `#7C5CFF`, user-selectable: blue, cyan, green, pink, orange) exposed as
  CSS custom properties. Brand gradient (accent → cyan) only for the logo, hero ring and primary CTA.
  Status colors: green `#34D399` ok, orange `#F5A524` warn, red `#F43F5E` error, always with text.
- **Type**: `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`; mono `"Cascadia Mono", Consolas, monospace`.
  Three text sizes (20 / 14 / 12) + one display size for big numbers. No webfonts, no CDN.
- **Spacing** 4/8/12/16/24/32 only. Radius 8 (controls), 10–12 (cards), 6 (chips).
- **Motion**: 120–200 ms, `cubic-bezier(.2,.8,.2,1)`; toggles with a slight spring; page transitions
  (fade + 8 px slide, View Transitions API when available); ripple on every button/card click;
  hover = lighter surface + 1 px lift + soft accent glow on primary; active = scale .97;
  `:focus-visible` ring 2 px accent on everything clickable; count-up numbers; animated score ring;
  skeleton loaders; toasts slide in and auto-dismiss; subtle animated aurora background.
  `prefers-reduced-motion` and `settings.motion = "reduced"` turn all of it down to plain fades.
- **Layout**: sidebar (232 px, collapsible to 72 px icons) with animated active pill; top bar with
  command palette trigger (Ctrl+K), mode chips (Admin / Testmodus / Neustart nötig); content max 1180 px;
  sticky bottom bar for staged changes ("3 Änderungen · Verwerfen · Anwenden"). Works down to 900×600.
- **Pages**: Übersicht (dashboard), Tweaks (category tabs + search + risk filter), Presets,
  KI-Optimierer (local + Claude), Detweak, Spiele (game booster), Reinigung (cleanup + repair),
  Apps (autostart + bloatware), Sicherungen (backups/journal), Einstellungen.
- Every option has one grey line of explanation. Empty states explain what to do. Every action gives
  feedback (toast). Risk badges with text ("Sicher", "Mittel", "Riskant"). Risky tweaks need a confirm
  dialog with a checkbox. Icons are inline SVG (stroke 1.75), never emojis.
- Toggles are **staged**: flipping a switch adds to the pending bar; "Anwenden" starts one `apply`/`revert`
  job and shows a progress overlay with live log. Status `custom`/`partial` shows a hint badge
  ("Von anderem Tool geändert").
