# Rift's changes to LawinServer

Source: <https://github.com/Lawin0129/LawinServer>, commit `70414917f57187cba1f22190f696f3a4ffbcd058`
(16 Oct 2026, "Added the new Grave Feather hero and new questline"). Licence: GPL-3.0, see `LICENSE`.
Authors: Lawin0129 (Lawin) and PRO100KatYT. Thank you, Lawin!

Every change in the code is marked with `// NIOBIUM:` (in `config.ini` with `# NIOBIUM:`).
For blocks of several lines the marker is in the comment line above.
(Rift used to be called Niobium, and before that Vanity. The markers kept the name `NIOBIUM:` from the
Niobium days; under Vanity they were `// VANITY:`.)

## Not taken over

| File | Reason |
|---|---|
| `package.json`, `package-lock.json` | Dependencies are in `backend/package.json` (pinned versions, pnpm). The `path` package (an npm copy of the Node module) is dropped; Node uses its built-in `path` anyway. |
| `start.bat`, `install_packages.bat` | LawinServer isn't started on its own any more, but through `backend/src/main.ts`. |
| `.gitignore`, `.git/` | not needed |

## New file

**`structure/niobium.js`** – one place for paths, ports and the game server target:

- `configure()` – sets the resource folder, data folder, bind address, matchmaker port and game server target
  (called by `src/main.ts` before any other LawinServer module is loaded).
- `file(rel)` – absolute path. Writable paths (`WRITABLE`: `profiles/`, `Config/`, `ClientSettings/`,
  `responses/friendslist.json`, `responses/friendslist2.json`, `responses/privacy.json`,
  `responses/Athena/SeasonData.json`) are in the data folder, everything else in the resource folder
  (next to `dist/main.js`). Paths with `..` are refused.
- `json(rel)` – replacement for `require("./../<rel>.json")`, same behaviour (read once, then the same object).
- `writeFile(rel, data)` – replacement for `fs.writeFileSync("./<rel>", data)`; writes via a temp file
  and renames it, so stopping in the middle never leaves half an `athena.json`.
- `isSafeName(name)` – checks profile and file names from requests.

## Changed files

### All files in `structure/` with data access (mechanical, the same kind of change)

`affiliate.js`, `cloudstorage.js`, `contentpages.js`, `discovery.js`, `friends.js`, `functions.js`,
`main.js`, `matchmaking.js`, `mcp.js`, `privacy.js`, `storefront.js`, `timeline.js`, `user.js`

- `const niobium = require("./niobium.js");` at the top of the file.
- `require("./../profiles|responses|Config/….json")` → `niobium.json("…")`
- `fs.writeFileSync("./profiles|responses/…", …)` → `niobium.writeFile("…", …)`
- `fs.readdirSync("./profiles")` → `fs.readdirSync(niobium.file("profiles"))`
- `path.join(__dirname, "..", "Config", "config.ini")` (and similar) → `niobium.file("Config/config.ini")`

**Why:** LawinServer read data relative to the module folder and wrote relative to the working folder.
Rift bundles everything into one file with esbuild (`dist/main.js`) – there `require` would build the
JSON files in (profiles could never be reloaded) and `__dirname` would point to the wrong folder.
Also, all written data has to land in the data folder (`NIOBIUM_DATA_DIR`), not in the program folder.

### `index.js`

- The app is now built in the function `createApp()`, exported as `module.exports = { createApp }`.
  **Why:** `src/main.ts` mounts the LawinServer app behind its own `/niobium` endpoints and the logging.
- `Express.static('public')` → `Express.static(niobium.file("public"))`. **Why:** independent of the working folder.
- `express.listen(…)`, starting `xmpp.js` and creating `%LOCALAPPDATA%\LawinServer` removed.
  **Why:** `src/main.ts` does that now (port/bind from environment variables, exit code 1 instead of 0 when the
  port is taken, data folder instead of `%LOCALAPPDATA%\LawinServer`).

### `structure/xmpp.js`

- Port `80` → `niobium.settings.matchmakerPort` (`NIOBIUM_MATCHMAKER_PORT`), bind address
  `niobium.settings.bindAddress` (`NIOBIUM_BIND`).
  **Why:** the port can be changed, and by default it only listens on 127.0.0.1 instead of every network card.
- The error message at start names the port and the reason (e.g. `EADDRINUSE`).

### `structure/matchmaking.js`

- `serviceUrl`: `ws://127.0.0.1` → `ws://127.0.0.1:<NIOBIUM_MATCHMAKER_PORT>` (without the port when it is 80).
- `serverAddress`/`serverPort`: from `niobium.settings.gameServer` (`NIOBIUM_GAMESERVER`, can be changed while
  running with `POST /niobium/gameserver`) instead of `config.ini` `[GameServer]`.

### `structure/cloudstorage.js`

- `CloudStorage/` from the resource folder; the file name from the URL is checked with `isSafeName`.
  **Why:** before, `GET /fortnite/api/cloudstorage/system/..%2F..%2F<path>` could read any file
  (important as soon as the backend is reachable in the network with `NIOBIUM_BIND=0.0.0.0`).
- `ClientSettings-<CL>.Sav` in the data folder (`ClientSettings/`) instead of `%LOCALAPPDATA%\LawinServer\ClientSettings`.
- `DefaultEngine.ini`: `ServerPort=80` (XMPP) is replaced with `NIOBIUM_MATCHMAKER_PORT` when the file is sent,
  if the port isn't 80. The file itself stays unchanged.

### `structure/mcp.js`

- On top of the mechanical change: `profileId` from the request must be a simple name
  (`isSafeName`), otherwise `400`. **Why:** `profileId` becomes part of a file path (before, e.g.
  `profileId=../../x` → reading/writing outside `profiles/`).
- `DailyQuestPath` (for `FortRerollDailyQuest`) uses `niobium.json` instead of `require`.

### `Config/config.ini`

- Note in the `[GameServer]` section: `ip`/`port` are not used by Rift
  (the target comes from `NIOBIUM_GAMESERVER` / `POST /niobium/gameserver`).

## Unchanged

`structure/lightswitch.js`, `structure/matchmaker.js`, `structure/party.js`, `structure/version.js`,
all data in `profiles/`, `responses/`, `CloudStorage/`, `public/`, `Config/catalog_config.json`, `README.md`, `LICENSE`.
Display name as in LawinServer: the e-mail at login → the name before the `@` (`georg@niobium.local` → `georg`).

## Known, but not changed

- The backend itself never connects to the outside (no `http(s).request`, `fetch` or the like in the code).
  The response data (`responses/*.json`, `structure/functions.js`) does contain URLs that the **game**
  might call: about 2300 image URLs on `cdn2.unrealengine.com` (shop, news, lobby backgrounds) and
  some `*.ol.epicgames.com`/`api.epicgames.dev` addresses (e.g. in `sdkv1.json`). The backend never calls
  them itself; they are just data from LawinServer.
- The backend only knows one profile for everybody (like LawinServer). With `NIOBIUM_BIND=0.0.0.0` every
  player in the network shares the same locker.

## Crash guards (October 2026)

- `structure/storefront.js`: `req.headers["user-agent"]` can be missing (tools, tests) – now `(… || "")`.
- `structure/matchmaking.js`: `req.query.bucketId` can be missing – now `String(… || "")`.

Both spots are marked with `// NIOBIUM:`. Reason: without these checks the backend answered with 500.
