# isMouseDown

Checks if a mouse button is currently being held down.

## Syntax

```lua
Ham.isMouseDown(button)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `button` | `integer` | Mouse button (0 = Left, 1 = Right, 2 = Middle) |

## Returns

- `boolean` - `true` if the button is down

## Example

```lua
if Ham.isMouseDown(0) then
    print("Left mouse button is held")
end
```

## See Also

- [isMouseClicked](isMouseClicked.md)
- [isMouseReleased](isMouseReleased.md)
