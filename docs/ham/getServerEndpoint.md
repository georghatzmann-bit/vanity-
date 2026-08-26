# getServerEndpoint

Gets the current server's connection endpoint.

## Syntax

```lua
Ham.getServerEndpoint()
```

## Returns

- `string` - Server endpoint address

## Example

```lua
local endpoint = Ham.getServerEndpoint()
print("Connected to: " .. endpoint)
```

## See Also

- [getServerHostname](getServerHostname.md)
