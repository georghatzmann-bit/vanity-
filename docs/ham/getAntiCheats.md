# getAntiCheats

Gets a list of detected anti-cheat systems.

## Syntax

```lua
Ham.getAntiCheats()
```

## Returns

- `table` - Array of anti-cheat names (e.g., "FiveGuard", "ElectronAC", "ReaperAC")

## Example

```lua
local anticheat = Ham.getAntiCheats()
for _, ac in ipairs(anticheat) do
    print("Detected: " .. ac)
end
```
