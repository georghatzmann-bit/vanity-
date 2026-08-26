# addCustomTextureAsync

Starts an asynchronous texture download.

## Syntax

```lua
Ham.addCustomTextureAsync(textureName, textureUrl)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `textureName` | `string` | Local filename to cache as |
| `textureUrl` | `string` | URL to download the texture from |

## Returns

- `integer` - Request ID (use with `getAsyncTextureResult`)

## Example

```lua
local requestId = Ham.addCustomTextureAsync("bigimage.png", "https://example.com/big.png")
```

## See Also

- [getAsyncTextureResult](getAsyncTextureResult.md)
- [cleanupAsyncTextureRequests](cleanupAsyncTextureRequests.md)
- [addCustomTexture](addCustomTexture.md)
