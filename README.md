# vanity-

Lua scripts for the Vanity menu — a bench for developing anti-cheat detection on your own
FiveM server. Trigger a behaviour on purpose, record what the client actually did, and line
that up against what your server-side detection saw.

- **[Vanity Script API reference](docs/vanity-script-api.md)** — UI elements, notifications, prompts.
- **[Ham Lua API reference](docs/ham/README.md)** — drawing, input, HTTP, events, player features (89 functions).
- **[`scripts/`](scripts/)** — the scripts themselves.
- **[`test/`](test/)** — stubs for Vanity, Ham and the FiveM natives, so scripts can be run and
  asserted on outside the game. `test/run.sh` runs everything.

## The bench

Two scripts, the same features, different surfaces. Pick one — you do not need both.

### [`luchs-script.lua`](scripts/luchs-script.lua) — "Luchs Skript v1.0"

Every feature as a Vanity menu control: separators for sections, sliders, toggles, selectors,
text inputs and submenus. Nothing is drawn except the status overlay.

### [`luchs-gui.lua`](scripts/luchs-gui.lua) — "Luchs GUI v1.0"

The Vanity menu holds exactly one button, **Launch Menu**. Everything else lives in a drawn,
mouse-driven window with a tab per section, bound by default to <kbd>F5</kbd>.

### Why they cannot drift

Both files are standalone — nothing can be `require`d into a Vanity sandbox — so each carries
the whole engine, including one declarative `SPEC` table that defines every feature as data.
The two front ends do nothing but walk that table.

The region between `SHARED ENGINE BEGIN` and `SHARED ENGINE END` is **byte-identical** in both
files. [`test/parity_test.lua`](test/parity_test.lua) checks that, then loads each script and
checks that every feature in the spec actually reaches the menu *and* gets drawn in the GUI.

## What it does

**Scenario runner** — ladders of increasing magnitude: teleport distance, vertical jumps, hop
rate, sprint multiplier, health and armour writes. One step at a time, recording what the client
actually did at each magnitude and optionally POSTing every step to your collector. Line the run
report up against your server log: **the first step your detector did not flag is where its
threshold sits.** That is the axis worth varying — how large the behaviour is, not how well it
hides.

**Monitors** — baseline a server-side inventory (resources, state bags, triggered events,
registered events, ped models, anti-cheats), do something, diff it. Whatever the server changed
in response comes back as added, changed or removed, with both sides of every change. Every diff
rebases, so it always answers "what changed since the last look". Can run on an interval.

**Calibration** — a detector needs a number, and guessing one is how you ban people for lag.
Collect one sample per frame during normal play, then read the distribution: min, p50, p90, p95,
p99, max, and a suggested threshold at p99 plus a headroom margin. Nearest-rank percentiles, so
every number in the report is a value that was actually measured. One button applies the
suggestion to the jump threshold.

**Anti-cheat detection** — presence, count and names, via `Ham.getAntiCheats`. Builds disagree on
the return shape (an array of names, or a map keyed by name); both are read. It is recorded in
every report and every telemetry payload, and **nothing in either script branches on the result** —
it is there so a run can be labelled with what it ran against.

**Telemetry and export** — JSON snapshots POSTed to your own collector, plus a one-document
export bundle: the live snapshot, the anti-cheat block, the calibration distribution, the last
monitor diff, every scenario step and the action log. Valid JSON even when a server-controlled
state bag holds control characters — a test asserts it.

### [`ac-telemetry-hud.lua`](scripts/ac-telemetry-hud.lua)

Smaller and older: a live overlay of position, velocity, per-frame delta, health and vehicle
state, with optional JSON snapshots.

### [`vanity-toolkit.lua`](scripts/vanity-toolkit.lua)

The broad API test bench the Luchs scripts grew out of — self state, teleports down either code
path, vehicles, world, weapons, a drawing playground for every Ham primitive, an inspector and an
HTTP client.

## Not included

The spoofing/bypass family (`spoofTeleport`, `speedSpoof`, `pedSpoof`, `spoofAllVisible`,
`camBypass`, `lockEventLogger`) and the aimbot. Those exist to defeat detection or to target other
players, which is the opposite of what this bench is for. A test asserts no call site for them
exists in any script.

To check whether your anti-cheat catches Ham's built-in spoofers you do not need them wired in
here: turn them on in Ham's own menu, run a ladder, and compare the logs. The ground truth these
scripts record is what makes that comparison readable.

## Testing

```sh
test/run.sh
```

Requires `lua5.4` or `lua5.1` (`apt-get install lua5.4`). The whole suite passes under both, which
is the check that keeps the scripts safe on LuaJIT as well as on 5.4. Scripts are exercised against
stubbed Vanity/Ham/native globals, frame by frame — no game needed. The GUI tests drive the drawn
window the way a player would: they find a widget by the text it painted and click on it.
