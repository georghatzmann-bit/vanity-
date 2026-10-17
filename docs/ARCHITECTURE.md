# Phoenix – Architecture & Contracts

> Phoenix is a Windows 10/11 desktop app (Electron) that **backs up the list of installed apps and games before a full Windows reset** and **reinstalls the ones the user picks afterwards** – silently via `winget`, with live progress and a cinematic, ultra-modern UI.
> This file is the single source of truth for module boundaries, IPC contracts and data formats. Code must follow it; change this file first if a contract has to change.

User-facing language: **German** (real umlauts in renderer strings; PowerShell scripts stay ASCII-only).

---

## 1. User flows

### 1.1 Sichern (before reset)
1. User clicks **Sichern**. Phoenix scans automatically – **everything is saved, no selection needed**:
   - `winget export` → all packages that winget can reinstall (source `winget` / `msstore`).
   - Registry uninstall keys (HKLM 64/32-bit, HKCU) → display names, versions, icons; entries not matched to a winget id become **"unmatched"** (shown as "manuell installieren" list).
   - Epic Games library (Fortnite …) and Steam library.
   - Hardware info (for driver hints after the reset).
2. Review screen shows what was found (apps grid, games, unmatched list). Only informational – the user can continue immediately.
3. Save targets (several at once allowed):
   - **USB-Stick** (removable drives) → `<drive>\Phoenix\` + copy of `Phoenix-Setup-*.exe` if found in Downloads/Desktop ("Rettungs-Stick").
   - **Zweite Festplatte** (fixed drives other than the Windows drive) → hint: survives only if the reset wipes the Windows drive only.
   - **OneDrive** folder if present.
   - **Speichern unter…** (dialog).
   - **Wiederherstellungs-Code**: compact text (`PHX1-…`) to copy and send to yourself (WhatsApp / Mail).
   - Always also a copy in `Dokumente\Phoenix\` (clearly labelled "wird beim kompletten Reset gelöscht").
4. Final checklist: "Profil gesichert ✓ – Setup auf Stick ✓ – Jetzt kannst du resetten."

### 1.2 Wiederherstellen (after reset)
1. Phoenix auto-finds profiles (all drive roots, `<drive>\Phoenix\`, Desktop, Downloads, Documents, OneDrive) and shows them as cards. Alternatives: open file (also accepts a raw `winget export` JSON), paste code, or catalog.
2. **Selection screen**: everything from the profile is listed by category; user picks what to install (search, select all/none per category, presets). Catalog items can be added too.
3. **Install**: Phoenix makes sure winget works (repairs/installs it if needed), asks for admin **once** (UAC) and installs sequentially with live progress.
4. **Spiele**: for each game from the profile a button opens the launcher's install page (Epic URI for Fortnite, `steam://install/<id>`), once the launcher is installed and the user is logged in.
5. **Fertig**: summary, retry failed, reboot hint, export log.

### 1.3 Schnell-Setup (no profile)
Same selection + install screens, pre-filled from the curated catalog (`popular` items pre-selected).

---

## 2. Process model

```
┌────────────── UI process (NON-elevated) ──────────────┐        ┌──── Worker (ELEVATED) ────┐
│ Electron main  ── IPC ──  Renderer (Vite bundle)      │  pipe  │ same Phoenix.exe --worker │
│  scan / profile / catalog / winget(user lane) / games │◄──────►│ winget installs (admin    │
│  install queue orchestrator, named-pipe SERVER        │ NDJSON │ lane), named-pipe CLIENT  │
└───────────────────────────────────────────────────────┘        └───────────────────────────┘
```

- The UI never runs elevated (no UAC on start, drag&drop works, user-scope installers land in the right profile).
- On install, the queue launches **one** elevated worker (`Start-Process -Verb RunAs`), which connects back over a named pipe (`\\.\pipe\phoenix-<uuid>`) and authenticates with a random token.
- **Lanes**: items whose installer prohibits elevation (`elevation: "prohibited"`, e.g. Spotify), per-user installers (`scope: "user"` or `"both"` – winget prefers the user installer) and `msstore` items run in the **user lane** (UI process spawns winget itself). Everything else runs in the **admin lane** (worker). A worker result `0x8A150056` (installer prohibits elevation) is automatically retried in the user lane. If UAC is declined/fails, all items move to the user lane (winget then shows per-installer UAC prompts as needed).
- Order: admin lane first, then user lane. Strictly sequential (one winget at a time).
- **Mock mode**: if `process.platform !== 'win32'` or `PHOENIX_MOCK=1`, main uses `src/main/mock/*` (fake scan, fake installs with timed progress) so the full app runs on Linux for e2e tests and demos. The renderer additionally has a browser mock (`src/renderer/core/mock-api.js`) used when `window.phoenix` is missing (Vite dev server / screenshots).

---

## 3. Repository layout

```
package.json                 scripts, deps (renderer libs are devDependencies – bundled by Vite)
vite.config.mjs              root: src/renderer, outDir: dist/renderer, base: './'
package.json "build"         electron-builder config: NSIS oneClick per-MACHINE Setup.exe → release/ (the elevated worker exe must live in admin-only Program Files)
build/                       icon.ico, icon.png, installer.nsh (buildResources)
scripts/                     dev helpers (icon generation, screenshot tool, e2e)
docs/ARCHITECTURE.md         this file
.github/workflows/build.yml  Windows CI build → artifact + GitHub Release on tag
src/main/                    Electron main process (CommonJS, Node 22, no native deps)
  main.js                    entry: `--worker` → install/worker.js, else ui.js
  ui.js                      single-instance, window, first-run marker, registers IPC
  ipc.js                     ALL ipcMain.handle registrations (see §4)
  window.js                  BrowserWindow factory + navigation hardening
  log.js                     file logger (userData/logs/phoenix-YYYYMMDD.log) + ring buffer
  util/ps.js                 PowerShell runner (temp .ps1, UTF-8 output, JSON helper, timeout)
  util/paths.js              known folders, drives, OneDrive, setup-exe finder
  util/shell.js              allowlisted openExternal
  winget/locate.js           find winget + version
  winget/bootstrap.js        ensure winget works (embedded Ensure-Winget.ps1)
  winget/runner.js           spawn install/export, progress → events, cancel (taskkill /T /F)
  winget/progress.js         PURE progress parser (unit-tested)
  winget/errors.js           PURE exit-code table + classify() (unit-tested)
  scan/index.js              orchestrates full scan (emits scan:progress)
  scan/apps.js               winget export + registry merge, unmatched filter
  scan/registry.js           PowerShell registry query + PURE filter/normalize
  scan/games.js              Epic + Steam (+ launcher detection)
  scan/vdf.js                PURE Valve KeyValues parser
  scan/epic.js               PURE Epic manifest parser
  scan/hardware.js           OS/CPU/RAM/GPU via Get-CimInstance
  scan/icons.js              app.getFileIcon → data URL (32px), concurrency-limited
  profile/profile.js         PURE normalize/validate/build + fs save/load/find
  profile/code.js            PURE restore-code encode/decode (zlib deflateRaw + base64url)
  catalog/catalog.json       curated, verified catalog
  catalog/index.js           load + lookup helpers (by id, prettify id → name)
  install/queue.js           orchestrator in UI process (lanes, worker, events)
  install/elevate.js         isElevated(), launchWorker(), pipe server
  install/protocol.js        PURE NDJSON framing + message validation
  install/worker.js          elevated worker entry
  games/launch.js            build launcher URIs, open them, detect launchers
  mock/                      mock implementations for non-Windows / PHOENIX_MOCK
src/preload/preload.js       contextBridge → window.phoenix (§4)
src/renderer/                index.html, main.js, styles/, core/, fx/, components/, screens/
test/                        node:test unit tests for PURE modules (`npm test`)
```

---

## 4. IPC contract (`window.phoenix`)

All methods return Promises. Errors reject with `Error(message)` where `message` is German, user-presentable.

```js
window.phoenix = {
  app:      { info(), markInstalled() },
  win:      { minimize(), toggleMaximize(), close() },
  system:   { info() },
  winget:   { status(), ensure() },
  scan:     { run() },
  catalog:  { get() },
  profile:  { save(profile, dir?), saveToDrive(profile, root), open(), find(), load(path), encode(profile), decode(code) },
  drives:   { list() },
  setup:    { find() },
  install:  { start(items), cancel() },
  games:    { launchers(), install(game, mode?) },
  shell:    { open(url), showItem(path) },
  clipboard:{ write(text) },
  log:      { export() },
  on(channel, callback) // → unsubscribe(); channels: 'scan:progress' | 'winget:ensure-progress' | 'install:event'
}
```

| Method | ipc channel | Returns |
|---|---|---|
| `app.info()` | `app:info` | `{ version, firstRun, isPackaged, mock }` – `firstRun` true if marker `userData/installed-version` is missing or differs from `app.getVersion()` |
| `app.markInstalled()` | `app:markInstalled` | `true` (writes marker) |
| `win.*` | `win:minimize` / `win:toggleMaximize` / `win:close` | `void` |
| `system.info()` | `system:info` | `MachineInfo` |
| `winget.status()` | `winget:status` | `{ available, version, path, ok, minVersion }` |
| `winget.ensure()` | `winget:ensure` | `{ ok, version, error? }`, emits `winget:ensure-progress` `{ step, message }` |
| `scan.run()` | `scan:run` | `ScanResult`, emits `scan:progress` `{ phase, message, pct, found? }` |
| `catalog.get()` | `catalog:get` | `{ categories: string[], items: CatalogItem[] }` |
| `profile.save(p, dir?)` | `profile:save` | `{ path }` – no `dir` → save dialog (`{ path:null, canceled:true }` if cancelled); `dir: 'documents'` → `Documents\Phoenix\`; `dir: 'onedrive'` → `OneDrive\Phoenix\` |
| `profile.saveToDrive(p, root)` | `profile:saveToDrive` | `{ path, setupCopied, setupPath? }` – writes `<root>\Phoenix\<file>` and copies setup exe if found |
| `profile.open()` | `profile:open` | `Profile \| null` (dialog; accepts `.phoenix.json`, `.json` incl. raw winget export) |
| `profile.find()` | `profile:find` | `ProfileRef[]` = `{ path, location, createdAt, hostname, appCount, gameCount }` |
| `profile.load(path)` | `profile:load` | `Profile` |
| `profile.encode(p)` | `profile:encode` | `string` (`PHX1-…`) |
| `profile.decode(code)` | `profile:decode` | `Profile` |
| `drives.list()` | `drives:list` | `Drive[]` = `{ root:'E:\\', label, kind:'removable'\|'fixed'\|'network'\|'system', freeBytes, totalBytes }` plus, if present, `{ root:'onedrive', label:'OneDrive', kind:'cloud', path }` (save it with `profile.save(p, 'onedrive')`) |
| `setup.find()` | `setup:find` | `{ path } \| null` newest `Phoenix-Setup-*.exe` in Downloads/Desktop |
| `install.start(items)` | `install:start` | `{ jobId }`, emits `install:event` (§6) |
| `install.cancel()` | `install:cancel` | `true` |
| `games.launchers()` | `games:launchers` | `{ epic:{installed}, steam:{installed}, ... }` |
| `games.install(game, mode?)` | `games:install` | `{ ok, uri, error? }` – mode `'install'` (default, launcher install dialog), `'store'` (store page in launcher), `'library'`, `'msstore'` (Fortnite Xbox/Store edition) |
| `shell.open(url)` | `shell:open` | `true` – allowlisted schemes only: `https:` `http:` `steam:` `com.epicgames.launcher:` `battlenet:` `uplay:` `goggalaxy:` `origin2:` `ms-windows-store:` `ms-settings:` |
| `shell.showItem(path)` | `shell:showItem` | `true` |
| `clipboard.write(t)` | `clipboard:write` | `true` |
| `log.export()` | `log:export` | `{ path }` (Desktop) |

---

## 5. Data formats

```ts
CatalogItem = { id, source: 'winget'|'msstore'|'link', name, category, desc, homepage, popular: bool,
                elevation: 'required'|'prohibited'|'none'|'unknown', scope: 'user'|'machine'|'both'|'unknown', url? }

MachineInfo = { hostname, user, os: { caption, version, build, displayVersion }, cpu, ramGB, gpus: [{ name, vendor: 'nvidia'|'amd'|'intel'|'other' }] }

AppEntry  = { id, source: 'winget'|'msstore', name, version?, publisher?, category?, icon?: dataURL, elevation? }
GameEntry = { platform: 'epic'|'steam'|'other', title, sizeBytes?, appName?, namespace?, catalogItemId?, appId? }
Unmatched = { name, publisher?, version? }

ScanResult = { apps: AppEntry[], games: GameEntry[], unmatched: Unmatched[], machine: MachineInfo, winget: { ok, version }, warnings: string[] }

Profile (file *.phoenix.json, UTF-8, pretty JSON) = {
  format: 'phoenix-profile', version: 1, createdAt: ISO, appVersion,
  machine: MachineInfo, apps: AppEntry[], games: GameEntry[], unmatched: Unmatched[] }
```

- File name: `Phoenix-Profil-<HOSTNAME>-<YYYY-MM-DD>.phoenix.json`.
- `profile.normalize()` is applied on save **and** load (drops unknown fields, dedupes apps by `source:id`, caps strings, validates ids with `/^[A-Za-z0-9][A-Za-z0-9.+_\-]{0,127}$/`).
- Loading a raw **winget export** JSON (`Sources[].Packages[].PackageIdentifier`, `Sources[].SourceDetails.Name`) converts it into a Profile (names from catalog or prettified id).
- **Restore code** `PHX1-<base64url(deflateRaw(JSON))>` with minimal payload `{ v:1, h:hostname, d:createdAt, a:[[source(0=winget,1=msstore), id], …], g:[[platform, title, appName|appId, namespace?, catalogItemId?], …] }` – no icons/unmatched. Decoding tolerates whitespace/line breaks and a missing prefix.

---

## 6. Install events (`install:event`)

```js
{ type:'job-start', jobId, items:[{ key, name, lane:'admin'|'user' }] }
{ type:'phase', phase:'winget-check'|'elevating'|'installing'|'finishing', message }
{ type:'elevation', status:'requested'|'granted'|'declined'|'failed', message }
{ type:'item-start', key, index, total }
{ type:'item-progress', key, stage:'resolving'|'downloading'|'verifying'|'installing', pct: 0..100|null, bytes?:{ done, total } }
{ type:'item-done', key, status:'installed'|'already'|'failed'|'skipped'|'cancelled', rebootRequired:bool, code?, codeHex?, message, durationMs }
{ type:'log', key?, line }
{ type:'job-done', summary:{ installed, already, failed, skipped, cancelled, rebootRequired }, durationMs }
```

Install item sent by the renderer: `{ key: '<source>:<id>', id, source: 'winget'|'msstore', name, elevation, scope }` (elevation/scope from the catalog when known). `link` catalog items are never sent – the renderer shows them as "Manuell" with an open-link button.

Worker protocol (NDJSON over the pipe, one JSON object per line):
`worker→ui {t:'hello', token, pid, elevated}` · `ui→worker {t:'job', items}` · `worker→ui {t:'event', event}` (event = objects above) · `ui→worker {t:'cancel'}` · `worker→ui {t:'bye'}`.

---

## 7. winget usage rules

- Exit code is the truth; output text is localized (German Windows!) → parsing is only for progress (numbers), never for success.
- Install: `winget install --id <id> --exact --source <winget|msstore> --silent --accept-package-agreements --accept-source-agreements --disable-interactivity --no-upgrade` (`--no-upgrade` only for winget ≥ 1.9). stdin is closed (`'ignore'`) so a prompt can never hang.
- winget ≥ 1.29 prints **no progress bar** when piped → `winget/download-watch.js` estimates download progress from the growing file in `%TEMP%\WinGet` + a HEAD request on the download URL.
- `winget export` writes to an ASCII-only folder (winget ≤ 1.29 breaks on non-ASCII paths).
- Sequential only. Retries: network 2× (5 s, 15 s), source/hash 1× after `winget source update`, app in use 1×, MSI busy (1618 → `0x8A150102`) 3× (30/60/120 s).
- After the job, pending-reboot registry keys are checked (winget reports MSI 3010 as success).
- Per-item watchdog 40 min; cancel kills the process tree (`taskkill /PID <pid> /T /F`).

## 8. Renderer

- Vanilla ES modules bundled by Vite; libraries: `three` (WebGL FX), `gsap` (timelines).
- `core/api.js` → `window.phoenix` or `mock-api.js`; `core/store.js` reactive state; `core/router.js` screen transitions; `core/sound.js` WebAudio-synth SFX (mute persisted).
- `fx/engine.js` API: `init(canvas, { quality })`, `setState('boot'|'idle'|'home'|'scan'|'installing'|'success'|'error')`, `setProgress(0..1)`, `pulse()`, `burst()`, `setQuality('ultra'|'high'|'low'|'off')`, `dispose()`. Auto quality: WEBGL_debug_renderer_info contains `SwiftShader` / `Basic Render` / `llvmpipe` → `low`; frame-time probe downgrades further.
- Screens: `boot` (first-run installation cinematic with real system data + winget check) · `home` · `backup` · `restore` · `select` · `install` · `games` · `done` · settings modal.
- Visual language: dark (#05060A base, text #E8EAF0, muted #8A90A2), ONE accent electric violet (#8B5CF6/#A78BFA), status colors green/orange/red **always with text**, 4-8-12-16-24-32 spacing, radius 8–10px, glass surfaces, 120–200 ms UI transitions, every option has a grey one-line explanation, designed empty states.
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.google.com https://*.gstatic.com; connect-src 'self'; media-src 'self' data: blob:; worker-src 'self' blob:`.

## 9. Security

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no remote content except favicon images, `will-navigate` blocked, `setWindowOpenHandler` → deny (+ allowlisted openExternal). IPC inputs validated in main (ids regex, paths must be absolute, profile normalized). Worker pipe authenticated by a random 32-byte token.

## 10. Renderer flow contract (screens ↔ store)

| Screen | Enter with | Reads | Writes / leaves with |
|---|---|---|---|
| `boot` | first run only | `api.system.info()`, `api.winget.ensure()` | `api.app.markInstalled()` → `home` |
| `home` | – | `store.machine` | `backup` · `restore` · `select {mode:'catalog'}` |
| `backup` | – | `api.scan.run()` + `scan:progress` | `store.scan = ScanResult`, `store.profile = Profile` (built from the scan, **everything included**, `appVersion` from `store.appInfo`) → saves via `api.profile.save/saveToDrive/encode` → `home` |
| `restore` | – | `api.profile.find()`, `open()`, `load()`, `decode()` | `store.profile = Profile` → `select {mode:'restore'}`; "Ohne Profil" → `select {mode:'catalog'}` |
| `select` | `{mode:'restore'|'catalog'}` | `store.profile`, `api.catalog.get()`, `store.machine` (GPU → suggest NVIDIA App / AMD link) | `store.installJob = { items: InstallItem[], links: CatalogItem[] (source 'link'), games: GameEntry[] }` → `install` |
| `install` | – | `store.installJob`, `install:event` | `store.installJob.result = { summary, byKey: {key → item-done event}, durationMs, elevation }` → `done` |
| `done` | – | `store.installJob` | retry failed → `install` with only failed items; `games` if `store.installJob.games.length`; links list (open in browser) |
| `games` | – | `store.installJob.games` or `store.profile.games`, `api.games.launchers()` | opens launcher URIs via `api.games.install(game, mode)` → `home` |

Rules: screens never call `window.phoenix` directly (only `ctx.api`); every screen works standalone with `?screen=<name>` by seeding mock data from `ctx.api` when the store slot is empty; `fxState` per screen: boot→`boot`, home→`home`, backup→`scan`, restore/select→`idle`, install→`installing` (+ `fx.setProgress`), done→`success` (or `error` if everything failed), games→`idle`.
