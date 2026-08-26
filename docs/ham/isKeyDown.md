# isKeyDown

Checks if a keyboard key is currently being held down.

## Syntax

```lua
Ham.isKeyDown(key)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `key` | `integer` | ImGui key code |

## Returns

- `boolean` - `true` if the key is down

## Example

```lua
if Ham.isKeyDown(87) then -- W key
    print("W is being held")
end
```

## See Also

- [isKeyPressed](isKeyPressed.md)
- [isKeyReleased](isKeyReleased.md)
- [Key Codes Reference](key-codes.md)
