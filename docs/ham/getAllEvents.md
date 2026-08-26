# getAllEvents

Gets all events triggered by resources.

## Syntax

```lua
Ham.getAllEvents()
```

## Returns

- `table` - Table `{resourceName = {event1, event2, ...}, ...}`

## Example

```lua
local events = Ham.getAllEvents()
```

## See Also

- [getAllRegisteredEvents](getAllRegisteredEvents.md)
- [findEvent](findEvent.md)
