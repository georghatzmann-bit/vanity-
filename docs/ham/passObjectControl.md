# passObjectControl

Passes network object control to another player.

## Syntax

```lua
Ham.passObjectControl(playerServerId, vehicleId)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `playerServerId` | `integer` | Target player's server ID |
| `vehicleId` | `integer` | Entity/vehicle ID to pass control of |

## Example

```lua
Ham.passObjectControl(5, 12345)
```
