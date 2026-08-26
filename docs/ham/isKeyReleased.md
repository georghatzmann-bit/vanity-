# isKeyReleased

Checks if a keyboard key was just released this frame.

## Syntax

```lua
Ham.isKeyReleased(key)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `key` | `integer` | ImGui key code |

## Returns

- `boolean` - `true` if the key was just released

## Example

```lua
if Ham.isKeyReleased(32) then -- Space
    print("Space was released")
end
```

## See Also

- [isKeyDown](isKeyDown.md)
- [isKeyPressed](isKeyPressed.md)
- [Key Codes Reference](key-codes.md)
