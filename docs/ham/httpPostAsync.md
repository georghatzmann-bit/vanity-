# httpPostAsync

Starts an asynchronous HTTP POST request.

## Syntax

```lua
Ham.httpPostAsync(url, payload, headers, insecure)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `url` | `string` | URL to request |
| `payload` | `string` | Request body |
| `headers` | `table|nil` | Optional headers |
| `insecure` | `boolean|nil` | Skip SSL verification |

## Returns

- `integer` - Request ID

## Example

```lua
local requestId = Ham.httpPostAsync("https://api.example.com/submit", '{"data": 123}')
```

## See Also

- [getAsyncResult](getAsyncResult.md)
- [httpPost](httpPost.md)
