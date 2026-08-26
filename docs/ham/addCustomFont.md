# addCustomFont

Downloads and adds a custom font from a URL.

## Syntax

```lua
Ham.addCustomFont(fontName, fontUrl, size)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `fontName` | `string` | Local filename to save as |
| `fontUrl` | `string` | URL to download the font from |
| `size` | `integer` | Font size in pixels |

## Returns

- `userdata|nil` - Font handle or nil on failure

## Example

```lua
local customFont = Ham.addCustomFont("MyFont.ttf", "https://example.com/font.ttf", 16)
```

## See Also

- [addFont](addFont.md)
- [addWindowsFont](addWindowsFont.md)
- [setFont](setFont.md)
