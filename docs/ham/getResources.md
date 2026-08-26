# getResources

Gets a list of all resources on the server.

## Syntax

```lua
Ham.getResources()
```

## Returns

- `table` - Array of resource names

## Example

```lua
local resources = Ham.getResources()
for _, name in ipairs(resources) do
    print(name)
end
```

## See Also

- [hasResource](hasResource.md)
- [getInjectableResources](getInjectableResources.md)
