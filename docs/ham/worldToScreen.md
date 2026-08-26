# worldToScreen

Converts 3D world coordinates to 2D screen coordinates.

## Syntax

```lua
Ham.worldToScreen(x, y, z)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `x` | `float` | World X coordinate |
| `y` | `float` | World Y coordinate |
| `z` | `float` | World Z coordinate |

## Returns

- `boolean` - `true` if the point is on screen
- `float` - Screen X coordinate
- `float` - Screen Y coordinate

## Example

```lua
local onScreen, screenX, screenY = Ham.worldToScreen(100.0, 200.0, 50.0)
if onScreen then
    Ham.drawText("Target", {screenX, screenY}, {255, 0, 0, 255}, 14, true)
end
```
