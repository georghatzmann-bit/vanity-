# httpGetAsync

Starts an asynchronous HTTP GET request.

## Syntax

```lua
Ham.httpGetAsync(url, headers, insecure)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `url` | `string` | URL to request |
| `headers` | `table|nil` | Optional headers |
| `insecure` | `boolean|nil` | Skip SSL verification |

## Returns

- `integer` - Request ID

## Example

```lua
local requestId = Ham.httpGetAsync("https://api.example.com/data")
```

## See Also

- [getAsyncResult](getAsyncResult.md)
- [httpGet](httpGet.md)
