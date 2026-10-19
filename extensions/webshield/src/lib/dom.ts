/** Kleiner DOM-Baukasten für die Erweiterungsseiten (nur `textContent`, nie HTML-Strings). */

type Child = Node | string | null;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { readonly className?: string; readonly id?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className !== undefined) {
    node.className = props.className;
  }
  if (props.id !== undefined) {
    node.id = props.id;
  }
  for (const child of children) {
    if (child !== null) {
      node.append(child);
    }
  }
  return node;
}
