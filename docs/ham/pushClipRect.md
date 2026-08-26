# pushClipRect

Pushes a clipping rectangle to restrict drawing area.

## Syntax

```lua
Ham.pushClipRect(minPos, maxPos, intersect)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `minPos` | `table` | Top-left position `{x, y}` |
| `maxPos` | `table` | Bottom-right position `{x, y}` |
| `intersect` | `boolean` | Intersect with existing clip rect |

## Example

```lua
Ham.pushClipRect({50, 50}, {200, 200}, true)
-- Drawing here will be clipped
Ham.popClipRect()
```

## See Also

- [popClipRect](popClipRect.md)
