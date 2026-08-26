# Key Codes Reference

## ImGui Key Codes

Used with [isKeyDown](isKeyDown.md), [isKeyPressed](isKeyPressed.md), and [isKeyReleased](isKeyReleased.md).

You can iterate the `ImGuiKey` global table to get the full key code mapping:

```lua
for keyName, keyCode in pairs(ImGuiKey) do
    print(keyName .. " = " .. keyCode)
end
```

## Virtual Key Codes

Used with [getKeyState](getKeyState.md).

| Key | Code (Hex) | Key | Code (Hex) |
|---|---|---|---|
| Left Mouse | 0x01 | Right Mouse | 0x02 |
| Middle Mouse | 0x04 | Backspace | 0x08 |
| Tab | 0x09 | Enter | 0x0D |
| Shift | 0x10 | Ctrl | 0x11 |
| Alt | 0x12 | Escape | 0x1B |
| Space | 0x20 | Page Up | 0x21 |
| Page Down | 0x22 | End | 0x23 |
| Home | 0x24 | Arrow Keys | 0x25-0x28 |
