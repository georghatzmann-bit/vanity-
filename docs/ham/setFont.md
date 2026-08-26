# setFont

Sets the active font for subsequent drawing operations.

## Syntax

```lua
Ham.setFont(font)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `font` | `userdata` | Font handle from `addFont`, `addWindowsFont`, or `addCustomFont` |

## Example

```lua
local font = Ham.addFont(1, 20)
Ham.setFont(font)
Ham.drawText("Custom font text", {100, 100}, {255, 255, 255, 255}, 20)
Ham.resetFont()
```

## See Also

- [resetFont](resetFont.md)
- [addFont](addFont.md)
