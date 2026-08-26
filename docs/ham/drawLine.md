# drawLine

Draws a line between two points.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawLine(startPos, endPos, color, thickness)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `startPos` | `table` | Start position `{x, y}` or `{x=..., y=...}` |
| `endPos` | `table` | End position `{x, y}` or `{x=..., y=...}` |
| `color` | `table` | Color `{r, g, b, a}` (0-255 each) |
| `thickness` | `integer` | Line thickness in pixels (1-100) |

## Example

```lua
Ham.drawLine({100, 100}, {200, 200}, {255, 0, 0, 255}, 2)
```

## See Also

- [Data Types](data-types.md)
