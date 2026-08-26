# getAsyncResult

Checks the status of an async HTTP request.

## Syntax

```lua
Ham.getAsyncResult(requestId)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `requestId` | `integer` | Request ID from async function |

## Returns

- `table` - Result table: `ready` (`boolean`) - True if request is complete`pending` (`boolean`) - True if still in progress`success` (`boolean`) - True if request succeeded (only when ready)`data` (`string`) - Response body (only when success)`error` (`string`) - Error message`status` (`integer`) - HTTP status code

## Example

```lua
local requestId = Ham.httpGetAsync("https://api.example.com/data")

-- Check in a loop/timer:
local result = Ham.getAsyncResult(requestId)
if result.ready then
    if result.success then
        print("Response: " .. result.data)
    else
        print("Error: " .. result.error)
    end
end
```

## See Also

- [httpGetAsync](httpGetAsync.md)
- [httpPostAsync](httpPostAsync.md)
- [cleanupAsyncRequests](cleanupAsyncRequests.md)
