# vanity-

Lua scripts for the **Vanity** menu (FiveM / GTA V sandbox).

## Layout

- `docs/vanity-script-api.md` — the Vanity Script API reference. **Read this before writing any script.**
- `scripts/` — one `.lua` file per script.

## Conventions

- Scripts run in a sandbox with a global `Vanity` table for UI, plus game natives and the Ham API.
- The UI is rebuilt from scratch on every Execute — register elements at the top level, no cleanup needed.
- Callbacks fire on user interaction, so keep state in `local` variables above the registration calls.
- Start each script with `Vanity.addText("<Name> v<x.y>")` and group sections with `Vanity.addSeparator()`.
- Always pass the optional `description` argument — it becomes the hover tooltip.
- Guard natives that can fail (e.g. `GetVehiclePedIsIn(...) == 0`) and report back via `print()` or
  `Vanity.notify()` instead of erroring out.
