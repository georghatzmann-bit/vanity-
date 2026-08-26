# hasResource

Checks if a resource exists on the server.

## Syntax

```lua
Ham.hasResource(resourceName)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `resourceName` | `string` | Resource name to check |

## Returns

- `boolean` - `true` if the resource exists

## Example

```lua
if Ham.hasResource("es_extended") then
    print("ESX server detected")
end
```

## See Also

- [getResources](getResources.md)
