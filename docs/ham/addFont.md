# addFont

Adds a built-in font.

## Syntax

```lua
Ham.addFont(fontIndex, size)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `fontIndex` | `integer` | Font type: `1` = Rubik, `2` = Font Awesome, `3` = Consolas |
| `size` | `number` | Font size in pixels |

## Returns

- `userdata|nil` - Font handle or nil on failure

## Example

```lua
local font = Ham.addFont(1, 18)
```

## See Also

- [addWindowsFont](addWindowsFont.md)
- [addCustomFont](addCustomFont.md)
- [setFont](setFont.md)
