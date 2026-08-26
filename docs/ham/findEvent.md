# findEvent

Searches for an event by name.

## Syntax

```lua
Ham.findEvent(searchTerm)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `searchTerm` | `string` | Partial event name to search for |

## Returns

- `table|nil` - Found event `{event = "eventName", resource = "resourceName"}` or nil

## Example

```lua
local result = Ham.findEvent("playerSpawned")
if result then
    print("Found: " .. result.event .. " in " .. result.resource)
end
```

## See Also

- [getAllEvents](getAllEvents.md)
