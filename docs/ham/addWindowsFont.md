# addWindowsFont

Adds a font from the Windows Fonts directory.

## Syntax

```lua
Ham.addWindowsFont(fontName, size)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `fontName` | `string` | Font filename (e.g., "arial.ttf") |
| `size` | `number` | Font size in pixels |

## Returns

- `userdata|nil` - Font handle or nil on failure

## Example

```lua
local arialFont = Ham.addWindowsFont("arial.ttf", 16)
```

## See Also

- [addFont](addFont.md)
- [addCustomFont](addCustomFont.md)
- [setFont](setFont.md)
