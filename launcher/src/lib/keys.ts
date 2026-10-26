/** Readable name for a pressed key, e.g. "F9", "Ctrl", "Space". */
export function keyLabel(event: Pick<KeyboardEvent, "key" | "code">): string {
  const { key, code } = event;
  if (/^F\d{1,2}$/.test(key)) return key;
  const named: Record<string, string> = {
    Control: "Ctrl",
    Shift: "Shift",
    Alt: "Alt",
    " ": "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Insert: "Insert",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "Page Up",
    PageDown: "Page Down",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Dead: code === "Backquote" ? "^" : "Key",
  };
  if (named[key]) return named[key];
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return key.length === 1 ? key.toUpperCase() : key;
}
