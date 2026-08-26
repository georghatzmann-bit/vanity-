# getAllStateBags

Gets all state bags and their data.

## Syntax

```lua
Ham.getAllStateBags()
```

## Returns

- `table` - Table of state bags `{bagName = {key = value, ...}, ...}`

## Example

```lua
local stateBags = Ham.getAllStateBags()
for bagName, data in pairs(stateBags) do
    print("Bag: " .. bagName)
    for key, value in pairs(data) do
        print("  " .. key .. " = " .. tostring(value))
    end
end
```
