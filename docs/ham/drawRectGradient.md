# drawRectGradient

Draws a filled rectangle with a gradient.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawRectGradient(rect, colorStart, colorEnd, vertical)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `rect` | `table` | Rectangle `{x, y, w, h}` |
| `colorStart` | `table` | Starting color `{r, g, b, a}` |
| `colorEnd` | `table` | Ending color `{r, g, b, a}` |
| `vertical` | `boolean` | `true` for vertical gradient, `false` for horizontal |

## Example

```lua
Ham.drawRectGradient({0, 0, 200, 50}, {255, 0, 0, 255}, {0, 0, 255, 255}, false)
```

## See Also

- [drawRect](drawRect.md)
- [drawRectFilled](drawRectFilled.md)
- [Data Types](data-types.md)
