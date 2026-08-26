# isMouseReleased

Checks if a mouse button was just released this frame.

## Syntax

```lua
Ham.isMouseReleased(button)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `button` | `integer` | Mouse button (0 = Left, 1 = Right, 2 = Middle) |

## Returns

- `boolean` - `true` if the button was just released

## Example

```lua
if Ham.isMouseReleased(1) then
    print("Right mouse button released")
end
```

## See Also

- [isMouseDown](isMouseDown.md)
- [isMouseClicked](isMouseClicked.md)
