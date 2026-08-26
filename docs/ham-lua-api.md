# Ham Lua API

Complete reference for the Ham Lua API in FiveM — a modern API for FiveM development, covering
state management, drawing/rendering, natives, HTTP requests, and events.

> **Status of this document:** only the overview / quick-start section below has been mirrored so
> far. The per-category function reference (state bags, drawing, HTTP, events, …) is **not yet
> captured** — see [What's missing](#whats-missing).

## Quick start

The Ham API is accessed through the global table `Ham`. All functions are called using this table
as a prefix:

```lua
Ham.FunctionName()
```

### Function name variants

Every function in the Ham API has both a **capitalized** and a **lowercase** variant of its name.
Either format works:

```lua
Ham.getAllStateBags()  -- capitalized variant
Ham.getallstatebags()  -- lowercase variant
```

> Convention for this repo: use the **camelCase / capitalized** variant everywhere, for consistency
> and readability.

### Example usage

```lua
-- Get all state bags
local allStateBags = Ham.getAllStateBags()

-- Draw a line
Ham.drawLine({x = 100, y = 100}, {x = 200, y = 200}, {255, 0, 0, 255}, 2)

-- Get screen resolution
local width, height = Ham.getResolution()
```

## Known functions

Confirmed from the quick-start examples only — signatures are inferred from usage, not from a
formal reference.

| Function | Signature (inferred) | Returns | Notes |
|---|---|---|---|
| `Ham.getAllStateBags` | `()` | table | List/table of all state bags |
| `Ham.drawLine` | `(from, to, color, thickness)` | — | `from`/`to` are `{x=, y=}`; `color` is `{r, g, b, a}` (0–255); `thickness` in px |
| `Ham.getResolution` | `()` | `width, height` | Two return values, screen resolution in px |

## Feature areas (per the docs landing page)

- **Fast & efficient** — optimized for performance with minimal overhead.
- **Drawing & rendering** — drawing functions for custom UI and overlays.
- **Easy to use** — simple, intuitive API design.
- **FiveM native** — built specifically for FiveM with native integration.

## What's missing

To write Ham-based scripts beyond the three functions above, the following reference pages still
need to be mirrored here:

- State management — the full state-bag function list
- Drawing & rendering — beyond `drawLine` (text, rects, circles, 3D→2D projection, colors)
- HTTP requests
- Events
- Natives access
