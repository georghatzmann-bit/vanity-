# Niobium backend

The backend is a small server on your own PC. It answers the old Fortnite build instead of the
real Epic servers: login, locker, shop, settings and matchmaking. It **never** talks to Epic –
everything stays on your own computer (or in your own network, if you set it up that way).

Built for Fortnite **19.10** (Chapter 3, Season 1), but like LawinServer it works with every version.

## Where it comes from

The core is [LawinServer](https://github.com/Lawin0129/LawinServer) by **Lawin0129** (with
PRO100KatYT), licensed under the **GPL-3.0**. It sits almost unchanged in the `lawinserver/` folder.
Every change is marked in the code with `// NIOBIUM:` and listed in
[`lawinserver/NIOBIUM_CHANGES.md`](lawinserver/NIOBIUM_CHANGES.md). Thanks to Lawin for the work!

Only `src/` (TypeScript) comes from Niobium itself: settings from environment variables, the
`/niobium` endpoints, the logging and the start.

## Folders

```
backend/
  src/              our code (main.ts = entry point)
  lawinserver/      LawinServer (GPL-3.0) + NIOBIUM_CHANGES.md
  scripts/build.mjs builds dist/
  test/smoke.mjs    test: starts the server and acts like a 19.10 client
  test/versions.mjs test: requests of newer builds (Chapter 4 to 6)
  dist/             the finished backend (built, not in git)
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `NIOBIUM_BACKEND_PORT` | `3551` | HTTP port for every request of the game and `/niobium/*` |
| `NIOBIUM_MATCHMAKER_PORT` | `80` | port for the matchmaker and XMPP (WebSocket) |
| `NIOBIUM_BIND` | `127.0.0.1` | `0.0.0.0` if others in the network should reach it |
| `NIOBIUM_DATA_DIR` | `%LOCALAPPDATA%\Niobium\backend-data` (Linux/macOS: `~/.niobium/backend`) | everything that changes goes here |
| `NIOBIUM_GAMESERVER` | `127.0.0.1:7777` | where the matchmaker sends the players (`ip:port`) |

If a variable is invalid (e.g. port `abc`), the backend stops with a message and exit code 1.
The same happens when the HTTP port is already taken. If only the matchmaker port is taken, the
backend keeps running and writes `XMPP and Matchmaker FAILED to start hosting. (port 80: EADDRINUSE)`.

## Data folder

On the first start the backend copies the default data into the data folder:

- `profiles/` – locker, items, V-Bucks (what changes in the game)
- `Config/` – `config.ini` and `catalog_config.json` (shop) to edit yourself
- `responses/friendslist*.json`, `responses/privacy.json`, `responses/Athena/SeasonData.json`
- `ClientSettings/` – game settings (`ClientSettings-<build>.Sav`)

Existing files are never overwritten. To start over, delete the folder.
Everything else (shop data, news, pictures, hotfixes) is only read and stays next to `main.js`.

## Own endpoints

| Method + path | Who may call it | Answer |
|---|---|---|
| `GET /niobium/health` | everyone | `{ "ok": true, "version": "0.1.0" }` |
| `GET /niobium/status` | everyone | `{ "name", "hosting", "playlist", "players", "maxPlayers", "version", "gameServer": { "ip", "port" } }` |
| `POST /niobium/status` | only 127.0.0.1 / ::1 | sets single fields from above, answers with the new status |
| `POST /niobium/gameserver` | only 127.0.0.1 / ::1 | `{ "ip": "100.101.12.7", "port": 7777 }` – change the matchmaker target right away |

- Requests from other computers to the POST endpoints get `403`.
- POST only with `Content-Type: application/json` (otherwise `415`) – so no other website in the
  browser can change the target.
- Wrong values → `400` with `{ "ok": false, "error": "…" }`.
- `name` in the status is "Niobium" until the launcher sets it ("<player>'s server").
- `version` in the status is the Fortnite version of the hosted game (set by the launcher, empty by default).
- `gameServer` in the status is always the current matchmaker target. `POST /niobium/status` may set it
  too (`"gameServer": { "ip", "port" }` or `"ip:port"`).
- For `POST /niobium/gameserver`, `port` is optional (default `7777`).

Every request is one line on stdout, e.g. `[HTTP] GET /niobium/health → 200`
(without `?…`; if the client stops early: `→ aborted`). Own messages start with `[Niobium]`.

## Build, test, start

Needs Node 22 and pnpm 10.

```sh
cd backend
pnpm install
pnpm build      # check types (tsc) + build dist/
pnpm test       # smoke test + version test against dist/main.js
pnpm start      # node dist/main.js
```

`pnpm build` creates `dist/main.js` (one file with every npm package built in – it needs no
`node_modules` to run) and copies the data next to it (`profiles/`, `responses/`, `CloudStorage/`,
`Config/`, `public/`). `LICENSE` and `THIRD_PARTY_LICENSES.txt` are added too. The whole `dist/` folder
is the finished backend; `main.js` always finds its data next to itself, no matter which folder it is
started from.

The smoke test starts the backend on free ports with an empty temp data folder and checks login,
profiles, saving the locker (also after a restart), settings, content pages, hotfixes, matchmaking
with WebSocket, XMPP, the `/niobium` endpoints and the `403` for requests from the network.
The version test asks the most important start endpoints as many Fortnite versions (through the
User-Agent): never a 5xx, the right season, the hotfix rule for 9.40–10.40 and the answers for newer builds.

This is how the launcher starts the backend (the `dist/` folder as `<resources>/backend/`):

```
node.exe <resources>/backend/main.js
```

with the environment variables from above and the data folder as the working folder.
