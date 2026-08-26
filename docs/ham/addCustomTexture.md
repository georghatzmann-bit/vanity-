# addCustomTexture

Downloads and loads a texture from a URL.

## Syntax

```lua
Ham.addCustomTexture(textureName, textureUrl)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `textureName` | `string` | Local filename to cache as |
| `textureUrl` | `string` | URL to download the texture from |

## Returns

- `userdata|nil` - Texture handle or nil on failure

## Example

```lua
local logo = Ham.addCustomTexture("logo.png", "https://example.com/logo.png")
if logo then
    Ham.drawTexture(logo, {10, 10}, {60, 60}, {255, 255, 255, 255})
end
```

## See Also

- [addCustomTextureAsync](addCustomTextureAsync.md)
- [drawTexture](drawTexture.md)
