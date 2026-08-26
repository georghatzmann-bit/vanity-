# getKeyState

Gets the async key state (Windows API).

## Syntax

```lua
Ham.getKeyState(key)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `key` | `integer` | Virtual key code |

## Returns

- `integer` - Key state value

## Example

```lua
local state = Ham.getKeyState(0x01) -- Left mouse button
if state ~= 0 then
    print("Left mouse is pressed")
end
```

## See Also

- [Virtual Key Codes](key-codes#virtual-key-codes.md)
