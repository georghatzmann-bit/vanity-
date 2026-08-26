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

### [`vanity-suite.lua`](scripts/vanity-suite.lua) — start here

Everything in one file: telemetry HUD, the full toolkit, and a **scenario runner**. Paste it into
Vanity and hit Execute; nothing else is needed.

The scenario runner plays reproducible behaviour ladders — teleport distance, vertical jumps, hop
rate, sprint multiplier, health and armour writes — one step at a time, recording what the client
actually did at each magnitude and optionally POSTing every step to your collector. Line the run
report up against your server log: **the first step your detector did not flag is where its
threshold sits.**

That is the axis worth varying when calibrating a detector — how large the behaviour is, not how
well it hides. When a step goes unnoticed, the fix belongs in the detector.

### [`vanity-toolkit.lua`](scripts/vanity-toolkit.lua)

Broad test bench across both APIs: self state (god mode, invisibility, no-clip, free cam,
spectator, anti-teleport), teleporting — via the native path *or* Ham's `setPosition`, so the same
jump can be sent down either route — vehicles, world time and weather, weapons, a drawing playground
for every Ham primitive, an inspector that dumps resources, state bags and the event inventory, an
HTTP client (sync and async), and `Ham.Execute`.

Every action is timestamped into an on-screen log and echoed to the F8 console, so a client-side
trigger can be lined up against a server-side detection hit.

## Not included

The spoofing/bypass family (`spoofTeleport`, `speedSpoof`, `pedSpoof`, `spoofAllVisible`,
`camBypass`, `lockEventLogger`) and the aimbot. Those exist to defeat detection or to target other
players, which is the opposite of what this bench is for. A test asserts no call site for them
exists in either script.

To check whether your anti-cheat catches Ham's built-in spoofers, you do not need them wired in
here: turn them on in Ham's own menu, run a ladder from `vanity-suite.lua`, and compare the logs.
The ground truth these scripts record is what makes that comparison readable.

## Testing

```sh
test/run.sh
```

Requires `lua5.4` (`apt-get install lua5.4`). Scripts are exercised against stubbed Vanity/Ham/native
globals, frame by frame — no game needed.
