# drawRect

Draws a rectangle outline.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawRect(startPos, endPos, color, rounding, flags, thickness)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `startPos` | `table` | Top-left position `{x, y}` |
| `endPos` | `table` | Bottom-right position `{x, y}` |
| `color` | `table` | Color `{r, g, b, a}` |
| `rounding` | `float` | Corner rounding radius (0-100) |
| `flags` | `integer` | Rounding corner flags |
| `thickness` | `integer` | Line thickness (1-100) |

## Example

```lua
Ham.drawRect({50, 50}, {150, 150}, {255, 255, 255, 255}, 5, 0, 1)
```

## See Also

- [drawRectFilled](drawRectFilled.md)
- [drawRectGradient](drawRectGradient.md)
- [Data Types](data-types.md)
