# drawRectFilled

Draws a filled rectangle.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawRectFilled(rect, color, rounding, roundingCorners)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `rect` | `table` | Rectangle `{x, y, w, h}` or `{x=..., y=..., w=..., h=...}` |
| `color` | `table` | Color `{r, g, b, a}` |
| `rounding` | `float` | Corner rounding radius (optional, default 0) |
| `roundingCorners` | `integer` | Corner flags (optional, default 0) |

## Example

```lua
Ham.drawRectFilled({100, 100, 200, 100}, {0, 128, 255, 200}, 10, 0)
```

## See Also

- [drawRect](drawRect.md)
- [drawRectGradient](drawRectGradient.md)
- [Data Types](data-types.md)
