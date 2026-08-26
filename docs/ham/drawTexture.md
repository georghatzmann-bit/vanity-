# drawTexture

Draws a texture/image on screen.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawTexture(texture, pos1, pos2, color, rounding, cornerFlags)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `texture` | `userdata` | Texture handle from `addCustomTexture` |
| `pos1` | `table` | Top-left position `{x, y}` |
| `pos2` | `table` | Bottom-right position `{x, y}` |
| `color` | `table` | Tint color `{r, g, b, a}` (use white for no tint) |
| `rounding` | `float` | Corner rounding (optional) |
| `cornerFlags` | `table|integer` | Corner flags for rounding (optional) |

## Example

```lua
local texture = Ham.addCustomTexture("logo.png", "https://example.com/logo.png")
Ham.drawTexture(texture, {10, 10}, {110, 110}, {255, 255, 255, 255}, 5)
```

## See Also

- [addCustomTexture](addCustomTexture.md)
- [addCustomTextureAsync](addCustomTextureAsync.md)
