# isKeyPressed

Checks if a keyboard key was just pressed this frame.

## Syntax

```lua
Ham.isKeyPressed(key)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `key` | `integer` | ImGui key code |

## Returns

- `boolean` - `true` if the key was just pressed

## Example

```lua
if Ham.isKeyPressed(27) then -- Escape
    print("Escape was pressed")
end
```

## See Also

- [isKeyDown](isKeyDown.md)
- [isKeyReleased](isKeyReleased.md)
- [Key Codes Reference](key-codes.md)
