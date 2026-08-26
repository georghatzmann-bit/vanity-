# vanity-

Lua scripts for the **Vanity** menu (FiveM / GTA V sandbox).

## Layout

- `docs/vanity-script-api.md` — the Vanity Script API reference. **Read this before writing any script.**
- `docs/ham/` — the Ham Lua API reference, mirrored from docs.hammafia.cc, one file per function.
  Start at `docs/ham/README.md`; `data-types.md` and `key-codes.md` hold the shared formats.
  Look signatures up there rather than guessing them.
- `scripts/` — one `.lua` file per script.
- `test/` — `stubs.lua` fakes Vanity, Ham and the FiveM natives so scripts can be exercised
  outside the game; one `<script>_test.lua` per script. Run all of them with `test/run.sh`.

## Conventions

- Scripts run in a sandbox with a global `Vanity` table for UI, plus game natives and the Ham API.
- The UI is rebuilt from scratch on every Execute — register elements at the top level, no cleanup needed.
- Callbacks fire on user interaction, so keep state in `local` variables above the registration calls.
- Start each script with `Vanity.addText("<Name> v<x.y>")` and group sections with `Vanity.addSeparator()`.
  (`luchs-gui.lua` deliberately does not: it registers exactly one control.)
- Always pass the optional `description` argument — it becomes the hover tooltip.
- Guard natives that can fail (e.g. `GetVehiclePedIsIn(...) == 0`) and report back via `print()` or
  `Vanity.notify()` instead of erroring out.
- Ham drawing calls only take effect inside a render loop (`CreateThread` + `Wait(0)`).

## Portability

FiveM may be LuaJIT (5.1) or 5.4, so scripts must run on both:

- No `math.pow`, no `//`, no bitwise operators, no `goto`.
- **`Wait()` must never be reachable from inside a `pcall`.** Yielding across a protected-call
  boundary is not portable. If a click handler might yield — loading a model does — queue it during
  the protected part and run it after.
- `test/run.sh` picks whichever interpreter is installed; the suite is expected to pass under
  `lua5.1` **and** `lua5.4`. Check both before handing work over.

## Vanity UI rules

- A selector always opens on its **first** choice. Every default in the code must therefore be
  `choices[1]`, or the menu shows one value while another is in effect.
- Submenu entries: only `type = "button"`. Nothing else is documented.
- `Vanity.promptText` is the way to take text input, and it works from a drawn GUI too.

## Render loops and re-execution

Vanity clears the UI on every Execute, but it does **not** stop a `CreateThread` loop started by
a previous run — those keep drawing, and re-running a script stacks duplicate overlays. Any script
with a render loop must guard it with a global generation counter:

```lua
_G.__MY_SCRIPT_GENERATION = (_G.__MY_SCRIPT_GENERATION or 0) + 1
local generation = _G.__MY_SCRIPT_GENERATION

CreateThread(function()
    while _G.__MY_SCRIPT_GENERATION == generation do
        Wait(0)
        -- draw here
    end
    -- retiring: hand back anything this run grabbed
end)
```

Older loops see the counter change and exit on their next frame.

## Drawn GUIs

- A script that grabs the mouse or blocks input (`toggleMouse`, `toggleInputBlock`) must hand it
  back on **every** path out: hiding, a draw error, and the old loop retiring after a re-Execute.
  A captured cursor with no window under it leaves the player unable to do anything but restart.
- Animate frame-rate independently: `value = value + (target - value) * (1 - math.exp(-speed * dt))`,
  never a fixed step per frame.
- Clamp the window to the screen on both axes so no scale can push an edge off it.
- Drop any in-progress drag when the button comes up, the tab changes or the window closes.

## Two front ends, one spec

`luchs-script.lua` (Vanity menu) and `luchs-gui.lua` (drawn window) expose the same features.
Both are standalone single files, so each carries the whole engine — including one declarative
`SPEC` table describing every feature as data. Only the front end at the bottom of each file
differs.

The region between `-- >>> SHARED ENGINE BEGIN <<<` and `-- <<< SHARED ENGINE END >>>` is
**byte-identical** in both files. When changing anything in it, change it in both and re-run
`test/parity_test.lua`, which checks the byte identity and then that every spec feature reaches
the menu and gets drawn in the GUI.

Add a feature by adding a spec item; both front ends pick it up.

## Testing

Before handing over a script: `luac5.4 -p scripts/<name>.lua` **and** `luac5.1 -p` for syntax, then a
`test/<name>_test.lua` built on `test/stubs.lua` that drives real frames and asserts on the
recorded draw calls, HTTP requests and UI registrations. Cover at minimum: the render loop
produces output, every UI callback changes what is drawn, the panel stays on screen at each
anchor and font size, and re-executing the script does not double-draw.

For a drawn GUI, drive it the way a player would: `H.findText`/`H.clickText` locate a widget by
the text it painted and click there, so the test exercises real hit-testing instead of re-deriving
the layout. Avoid assertions that depend on a pixel size — they pass at one scale and silently
skip at another.

## The 200-local limit

A standalone script is one Lua function, and Lua allows 200 local variables in one function.
Crossing it fails at compile time with `main function has more than 200 local variables`, which
says nothing about which change caused it. `test/parity_test.lua` asserts headroom instead, so
the failure arrives with a name attached. If it starts failing, group related locals into a table
rather than deleting features.
