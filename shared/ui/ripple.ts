import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Erzeugt einen Ripple-Kreis an der Klickposition.
 * Das Ziel-Element braucht `position: relative` und `overflow: hidden`.
 */
export function spawnRipple(e: ReactPointerEvent<HTMLElement>, color?: string): void {
  if (document.documentElement.dataset.motion === "off") return;
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.4;
  const span = document.createElement("span");
  span.className = "nv-ripple";
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.style.left = `${e.clientX - rect.left - size / 2}px`;
  span.style.top = `${e.clientY - rect.top - size / 2}px`;
  if (color) span.style.color = color;
  el.appendChild(span);
  const remove = () => span.remove();
  span.addEventListener("animationend", remove, { once: true });
  window.setTimeout(remove, 900);
}
