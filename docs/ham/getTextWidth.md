# getTextWidth

Calculates the width and height of text using the current font.

## Syntax

```lua
Ham.getTextWidth(text)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `text` | `string` | Text to measure |

## Returns

- `float` - Text width in pixels
- `float` - Text height in pixels

## Example

```lua
local width, height = Ham.getTextWidth("Hello World")
print("Text size: " .. width .. "x" .. height)
```

## See Also

- [drawText](drawText.md)
- [setFont](setFont.md)
