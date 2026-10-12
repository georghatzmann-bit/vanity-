import type { MotionLevel, ThemeId } from "./types";
import { prefersReducedMotion } from "@shared/lib/env";

export const THEMES: ThemeId[] = ["nova", "polar", "neon", "midnight"];

/** Vorschaufarben der Themes (für die Auswahlkarten) */
export const THEME_PREVIEW: Record<ThemeId, { bg: string; fg: string; a: string; b: string; c: string }> = {
  nova: { bg: "#0a0a11", fg: "#eeecf4", a: "#ff8a4c", b: "#ff4f8b", c: "#8b5cf6" },
  polar: { bg: "#f4f4f8", fg: "#15141c", a: "#f47a35", b: "#e8336f", c: "#7c4dff" },
  neon: { bg: "#040509", fg: "#eafff9", a: "#f72585", b: "#00f5d4", c: "#7b2ff7" },
  midnight: { bg: "#060b1c", fg: "#e8eeff", a: "#7dd3fc", b: "#5b8cff", c: "#a78bfa" },
};

function hexToHsl(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

const hslCss = (h: number, s: number, l: number) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

/** Theme, eigene Akzentfarbe und Bewegungsstufe auf das Dokument anwenden */
export function applyAppearance(theme: ThemeId, accent: string, motion: MotionLevel) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  const hsl = accent ? hexToHsl(accent) : null;
  if (hsl) {
    const [h, s, l] = hsl;
    root.style.setProperty("--nv-accent", accent);
    root.style.setProperty("--nv-accent-2", hslCss(h + 28, Math.min(1, s * 1.05), Math.min(0.72, l + 0.06)));
    root.style.setProperty("--nv-accent-3", hslCss(h - 42, Math.min(1, s * 0.95), Math.max(0.42, l - 0.04)));
  } else {
    root.style.removeProperty("--nv-accent");
    root.style.removeProperty("--nv-accent-2");
    root.style.removeProperty("--nv-accent-3");
  }
  root.dataset.motion = motion === "full" && prefersReducedMotion() ? "reduced" : motion;
}

/**
 * Theme-Wechsel mit Lichtkreis: Das neue Theme breitet sich als Kreis vom Klickpunkt aus.
 * Fällt auf eine sanfte Überblendung zurück, wenn der Browser View Transitions nicht kann.
 */
export function transitionTheme(apply: () => void, origin?: { x: number; y: number }) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  const root = document.documentElement;
  if (!doc.startViewTransition || root.dataset.motion === "off") {
    apply();
    return;
  }
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const vt = doc.startViewTransition(apply);
  vt.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: root.dataset.motion === "reduced" ? 250 : 650, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => undefined);
}
