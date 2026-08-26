# lockEventLogger

Locks the event logger with a secret key.

## Syntax

```lua
Ham.lockEventLogger(secretKey)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `secretKey` | `string` | Secret key for unlocking later |

## Returns

- `boolean` - `true` if successfully locked

## Example

```lua
local success = Ham.lockEventLogger("my_secret_key")
```

## See Also

- [unlockEventLogger](unlockEventLogger.md)
