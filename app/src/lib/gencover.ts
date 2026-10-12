import type { GamePalette } from "./types";

/** Einfacher, stabiler Hash (FNV-1a) */
export function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): string {
  const a = (s * Math.min(l, 1 - l)) / 1;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * Math.min(1, Math.max(0, c)))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Kuratierte Farbwelten für generierte Cover (Grundton in Grad) */
const HUES = [348, 12, 28, 200, 220, 258, 278, 300, 168, 145, 330, 190];

export interface GenCoverSpec {
  hue: number;
  hue2: number;
  pattern: number;
  angle: number;
  colors: { a: string; b: string; c: string; glow: string; deep: string };
  palette: GamePalette;
}

/** Bestimmt Farben und Muster eines generierten Covers aus dem Namen */
export function genCoverSpec(name: string): GenCoverSpec {
  const h = hash(name || "?");
  const hue = HUES[h % HUES.length] + ((h >> 8) % 16) - 8;
  const hue2 = (hue + 36 + ((h >> 12) % 50)) % 360;
  const pattern = (h >> 4) % 4;
  const angle = 110 + ((h >> 16) % 70);
  const colors = {
    a: hsl(hue, 0.62, 0.3),
    b: hsl(hue2, 0.58, 0.16),
    c: hsl((hue + 180) % 360, 0.5, 0.45),
    glow: hsl(hue, 0.95, 0.62),
    deep: hsl(hue2, 0.55, 0.07),
  };
  return {
    hue,
    hue2,
    pattern,
    angle,
    colors,
    palette: { primary: hsl(hue, 0.9, 0.6), secondary: hsl(hue2, 0.75, 0.55), dark: hsl(hue2, 0.5, 0.08) },
  };
}

/** Initialen für Monogramme: "Baldur's Gate 3" -> "BG3" */
export function initials(name: string, max = 3): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words
    .slice(0, max)
    .map((w) => (/^\d+$/.test(w) ? w : w[0]))
    .join("")
    .toUpperCase();
}
