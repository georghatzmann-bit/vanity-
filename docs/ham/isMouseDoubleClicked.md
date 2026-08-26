# isMouseDoubleClicked

Checks if a mouse button was double-clicked.

## Syntax

```lua
Ham.isMouseDoubleClicked(button)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `button` | `integer` | Mouse button (0 = Left, 1 = Right, 2 = Middle) |

## Returns

- `boolean` - `true` if double-clicked

## Example

```lua
if Ham.isMouseDoubleClicked(0) then
    print("Double click detected")
end
```

## See Also

- [isMouseClicked](isMouseClicked.md)
