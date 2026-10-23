/** Lesbarer Name für eine gedrückte Taste, z. B. „F9“, „Strg“, „Leertaste“. */
export function keyLabel(event: Pick<KeyboardEvent, "key" | "code">): string {
  const { key, code } = event;
  if (/^F\d{1,2}$/.test(key)) return key;
  const named: Record<string, string> = {
    Control: "Strg",
    Shift: "Umschalt",
    Alt: "Alt",
    " ": "Leertaste",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Rücktaste",
    Insert: "Einfg",
    Delete: "Entf",
    Home: "Pos1",
    End: "Ende",
    PageUp: "Bild ↑",
    PageDown: "Bild ↓",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Dead: code === "Backquote" ? "^" : "Taste",
  };
  if (named[key]) return named[key];
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return key.length === 1 ? key.toUpperCase() : key;
}
