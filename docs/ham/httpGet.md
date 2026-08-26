# httpGet

Performs a synchronous HTTP GET request.

## Syntax

```lua
Ham.httpGet(url, headers, insecure)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `url` | `string` | URL to request |
| `headers` | `table|nil` | Optional headers table `{["Header-Name"] = "value"}` |
| `insecure` | `boolean|nil` | Skip SSL verification (optional, default false) |

## Returns

- `table` - Response table: `success` (`boolean`) - Request succeeded`data` (`string`) - Response body`error` (`string`) - Error message (if failed)`status` (`integer`) - HTTP status code

## Example

```lua
local response = Ham.httpGet("https://api.example.com/data", {
    ["Authorization"] = "Bearer token123"
})

if response.success then
    print("Data: " .. response.data)
else
    print("Error: " .. response.error)
end
```

## See Also

- [httpPost](httpPost.md)
- [httpGetAsync](httpGetAsync.md)
