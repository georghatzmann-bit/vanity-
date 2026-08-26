# isMouseClicked

Checks if a mouse button was just clicked this frame.

## Syntax

```lua
Ham.isMouseClicked(button)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `button` | `integer` | Mouse button (0 = Left, 1 = Right, 2 = Middle) |

## Returns

- `boolean` - `true` if the button was just clicked

## Example

```lua
if Ham.isMouseClicked(0) then
    print("Left click detected")
end
```

## See Also

- [isMouseDown](isMouseDown.md)
- [isMouseDoubleClicked](isMouseDoubleClicked.md)
- [isMouseReleased](isMouseReleased.md)
