import type { MotionLevel, ThemeId } from "./types";
import { prefersReducedMotion } from "@shared/lib/env";

export const THEMES: ThemeId[] = ["pulsar", "ember", "toxic", "frost"];

/** Vorschaufarben der Themes (für die Auswahlkarten) */
export const THEME_PREVIEW: Record<ThemeId, { bg: string; fg: string; a: string; b: string; c: string }> = {
  pulsar: { bg: "#04070f", fg: "#e9f1ff", a: "#60a5fa", b: "#22d3ee", c: "#a78bfa" },
  ember: { bg: "#0b0605", fg: "#fff1ea", a: "#ffb347", b: "#ff6b35", c: "#ff3d6e" },
  toxic: { bg: "#030805", fg: "#eafff1", a: "#b4ff39", b: "#39ff88", c: "#00e5ff" },
  frost: { bg: "#eef3fa", fg: "#0d1526", a: "#2563eb", b: "#0891b2", c: "#7c3aed" },
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
