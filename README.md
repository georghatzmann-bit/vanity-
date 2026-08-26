# vanity-

Lua scripts for the Vanity menu.

- **[Vanity Script API reference](docs/vanity-script-api.md)** — UI elements, notifications, prompts.
- **[Ham Lua API reference](docs/ham/README.md)** — drawing, input, HTTP, events, player features (89 functions).
- **[`scripts/`](scripts/)** — the scripts themselves.
- **[`test/`](test/)** — stubs for Vanity, Ham and the FiveM natives, so scripts can be run and
  asserted on outside the game. `test/run.sh` runs everything.

## Scripts

### [`ac-telemetry-hud.lua`](scripts/ac-telemetry-hud.lua)

Live overlay of what the client actually reports — position, velocity, per-frame movement delta,
health, vehicle state — with optional JSON snapshots POSTed to your own collector.

Client-side ground truth for validating server-side anti-cheat checks: trigger a behaviour, read
off the delta and implied speed the client saw, and compare against what your detection caught.

## Testing

```sh
test/run.sh
```

Requires `lua5.4` (`apt-get install lua5.4`). Scripts are exercised against stubbed Vanity/Ham/native
globals, frame by frame — no game needed.
