# vanity-

Lua scripts for the **Vanity** menu (FiveM / GTA V sandbox).

## Layout

- `docs/vanity-script-api.md` — the Vanity Script API reference. **Read this before writing any script.**
- `docs/ham/` — the Ham Lua API reference, mirrored from docs.hammafia.cc, one file per function.
  Start at `docs/ham/README.md`; `data-types.md` and `key-codes.md` hold the shared formats.
- `scripts/` — one `.lua` file per script.
- `test/` — `stubs.lua` fakes Vanity, Ham and the FiveM natives so scripts can be exercised
  outside the game; one `<script>_test.lua` per script. Run all of them with `test/run.sh`.

## Conventions

- Scripts run in a sandbox with a global `Vanity` table for UI, plus game natives and the Ham API.
- The UI is rebuilt from scratch on every Execute — register elements at the top level, no cleanup needed.
- Callbacks fire on user interaction, so keep state in `local` variables above the registration calls.
- Start each script with `Vanity.addText("<Name> v<x.y>")` and group sections with `Vanity.addSeparator()`.
- Always pass the optional `description` argument — it becomes the hover tooltip.
- Guard natives that can fail (e.g. `GetVehiclePedIsIn(...) == 0`) and report back via `print()` or
  `Vanity.notify()` instead of erroring out.
- Ham drawing calls only take effect inside a render loop (`CreateThread` + `Wait(0)`).

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
end)
```

Older loops see the counter change and exit on their next frame.

## Testing

Before handing over a script: `luac5.4 -p scripts/<name>.lua` for syntax, then a
`test/<name>_test.lua` built on `test/stubs.lua` that drives real frames and asserts on the
recorded draw calls, HTTP requests and UI registrations. Cover at minimum: the render loop
produces output, every UI callback changes what is drawn, the panel stays on screen at each
anchor and font size, and re-executing the script does not double-draw.
