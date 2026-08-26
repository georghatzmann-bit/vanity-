# drawText

Draws text on screen.

> **TIP**
>
> All drawing functions should be called within a render callback/loop.

## Syntax

```lua
Ham.drawText(text, position, color, fontSize, centered, outline, outlineColor)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `text` | `string` | Text to draw (supports multiline with `\n`) |
| `position` | `table` | Position `{x, y}` |
| `color` | `table` | Text color `{r, g, b, a}` |
| `fontSize` | `float` | Font size in pixels (optional, default 12) |
| `centered` | `boolean` | Center text horizontally (optional, default false) |
| `outline` | `boolean` | Draw text outline (optional, default false) |
| `outlineColor` | `table` | Outline color (optional, default black) |

## Example

```lua
Ham.drawText("Hello World!", {100, 100}, {255, 255, 255, 255}, 16, false, true, {0, 0, 0, 255})
```

## See Also

- [getTextWidth](getTextWidth.md)
- [setFont](setFont.md)
- [Data Types](data-types.md)
