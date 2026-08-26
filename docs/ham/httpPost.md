# httpPost

Performs a synchronous HTTP POST request.

## Syntax

```lua
Ham.httpPost(url, payload, headers, insecure)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `url` | `string` | URL to request |
| `payload` | `string` | Request body |
| `headers` | `table|nil` | Optional headers table |
| `insecure` | `boolean|nil` | Skip SSL verification (optional) |

## Returns

- `table` - Response table (same as `httpGet`)

## Example

```lua
local response = Ham.httpPost("https://api.example.com/submit",
    '{"key": "value"}',
    {["Content-Type"] = "application/json"}
)
```

## See Also

- [httpGet](httpGet.md)
- [httpPostAsync](httpPostAsync.md)
