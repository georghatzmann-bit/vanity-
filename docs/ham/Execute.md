# Execute

Executes Lua code in a specified resource context.

## Syntax

```lua
Ham.Execute(resourceName, code)
```

## Parameters

| Name | Type | Description |
|---|---|---|
| `resourceName` | `string` | Target resource name (use "isolated" for isolated context) |
| `code` | `string` | Lua code to execute |

## Returns

- `boolean` - `true` if execution was successful

## Example

```lua
Ham.Execute("isolated", "print('Hello from isolated context')")
```
