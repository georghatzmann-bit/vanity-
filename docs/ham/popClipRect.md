# popClipRect

Pops the last clipping rectangle.

## Syntax

```lua
Ham.popClipRect()
```

## Example

```lua
Ham.pushClipRect({50, 50}, {200, 200}, true)
-- Drawing here will be clipped
Ham.popClipRect()
```

## See Also

- [pushClipRect](pushClipRect.md)
