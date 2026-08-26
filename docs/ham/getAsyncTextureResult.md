# getAsyncTextureResult

Checks the status of an async texture load.

## Syntax

```lua
Ham.getAsyncTextureResult(requestId)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `requestId` | `integer` | Request ID from `addCustomTextureAsync` |

## Returns

- `table` - Result table with fields: `ready` (`boolean`) - True if the request is complete`success` (`boolean`) - True if texture loaded successfully (only when ready)`texture` (`userdata`) - Texture handle (only when success)`width` (`integer`) - Texture width (only when success)`height` (`integer`) - Texture height (only when success)`error` (`string`) - Error message (only on failure)

## Example

```lua
local requestId = Ham.addCustomTextureAsync("image.png", "https://example.com/image.png")

-- In render loop:
local result = Ham.getAsyncTextureResult(requestId)
if result.ready then
    if result.success then
        myTexture = result.texture
        print("Loaded: " .. result.width .. "x" .. result.height)
    else
        print("Error: " .. result.error)
    end
end
```

## See Also

- [addCustomTextureAsync](addCustomTextureAsync.md)
