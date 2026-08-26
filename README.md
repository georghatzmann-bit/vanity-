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

### [`vanity-toolkit.lua`](scripts/vanity-toolkit.lua)

Broad test bench across both APIs: self state (god mode, invisibility, no-clip, free cam,
spectator, anti-teleport), teleporting — via the native path *or* Ham's `setPosition`, so the same
jump can be sent down either route — vehicles, world time and weather, weapons, a drawing playground
for every Ham primitive, an inspector that dumps resources, state bags and the event inventory, an
HTTP client (sync and async), and `Ham.Execute`.

Every action is timestamped into an on-screen log and echoed to the F8 console, so a client-side
trigger can be lined up against a server-side detection hit.

Not included: the spoofing/bypass family (`spoofTeleport`, `speedSpoof`, `pedSpoof`,
`spoofAllVisible`, `camBypass`, `lockEventLogger`) and the aimbot — those exist to defeat detection
or to target other players, which is the opposite of what this bench is for. A test asserts they
stay absent.

## Testing

```sh
test/run.sh
```

Requires `lua5.4` (`apt-get install lua5.4`). Scripts are exercised against stubbed Vanity/Ham/native
globals, frame by frame — no game needed.
