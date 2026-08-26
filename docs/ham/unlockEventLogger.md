# unlockEventLogger

Unlocks the event logger.

## Syntax

```lua
Ham.unlockEventLogger(secretKey)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `secretKey` | `string` | The secret key used to lock |

## Returns

- `boolean` - `true` if successfully unlocked

## Example

```lua
Ham.unlockEventLogger("my_secret_key")
```

## See Also

- [lockEventLogger](lockEventLogger.md)
