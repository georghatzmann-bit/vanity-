# getAllRegisteredEvents

Gets all registered event handlers by resource.

## Syntax

```lua
Ham.getAllRegisteredEvents()
```

## Returns

- `table` - Table `{resourceName = {event1, event2, ...}, ...}`

## Example

```lua
local handlers = Ham.getAllRegisteredEvents()
```

## See Also

- [getAllEvents](getAllEvents.md)
- [findEvent](findEvent.md)
