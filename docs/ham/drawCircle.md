# drawCircle

Draws a circle.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawCircle(circle, color, segments, thickness, filled)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `circle` | `table` | Circle definition `{x, y, radius}` or `{x=..., y=..., radius=...}` |
| `color` | `table` | Color `{r, g, b, a}` |
| `segments` | `integer` | Number of segments (higher = smoother) |
| `thickness` | `float` | Line thickness (only for unfilled circles) |
| `filled` | `boolean` | `true` for filled circle, `false` for outline |

## Example

```lua
-- Outline circle
Ham.drawCircle({200, 200, 50}, {255, 255, 0, 255}, 32, 2, false)

-- Filled circle
Ham.drawCircle({300, 200, 30}, {0, 255, 0, 200}, 24, 0, true)
```

## See Also

- [Data Types](data-types.md)
