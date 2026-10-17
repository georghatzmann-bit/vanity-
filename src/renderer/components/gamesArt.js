// Games screen helpers: platform metadata, sizes, and generated cover art.
// We have no cover images, so every game gets a deterministic, platform-tinted SVG "key art"
// built from its title (palette, pattern, giant initials). Inline SVG: CSP-safe, no network.
import { svg, nextId } from '../core/dom.js';
import { monogram } from './appCard.js';

export const PLATFORMS = {
  epic: {
    id: 'epic',
    name: 'Epic Games',
    launcher: 'Epic Games Launcher',
    launcherShort: 'Epic Launcher',
    inLauncher: 'im Epic Games Launcher',
    acc: 'den Epic Games Launcher',
    nom: 'Der Epic Games Launcher',
    short: 'EPIC',
    letter: 'E',
    store: 'Epic Store',
    download: 'https://store.epicgames.com/de/download',
    rgb: '232, 234, 244',
  },
  steam: {
    id: 'steam',
    name: 'Steam',
    launcher: 'Steam',
    launcherShort: 'Steam',
    inLauncher: 'in Steam',
    acc: 'Steam',
    nom: 'Steam',
    short: 'STEAM',
    letter: 'S',
    store: 'Steam-Store',
    download: 'https://store.steampowered.com/about/',
    rgb: '102, 192, 244',
  },
  other: {
    id: 'other',
    name: 'Weitere Spiele',
    launcher: 'eigener Launcher',
    launcherShort: 'Launcher',
    inLauncher: 'im Launcher',
    acc: 'den Launcher',
    nom: 'Der Launcher',
    short: 'PC',
    letter: 'P',
    store: 'Store',
    rgb: '167, 139, 250',
  },
};

export const PLATFORM_ORDER = ['epic', 'steam', 'other'];

export const platformOf = (game) => (game && (game.platform === 'epic' || game.platform === 'steam') ? game.platform : 'other');

/** "Rocket League®" -> "Rocket League" (big type looks noisy with trademark glyphs). */
export function cleanTitle(title) {
  const t = String(title || '')
    .replace(/[®™©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || 'Unbenanntes Spiel';
}

export function gameKey(game) {
  const pid = platformOf(game);
  const id = game && (game.appId || game.appName || game.catalogItemId || game.title);
  return `${pid}:${String(id || '').toLowerCase()}`;
}

/** Fortnite gets the hero card (and the Microsoft Store alternative, which main only offers for appName "Fortnite"). */
export function isFortnite(game) {
  if (!game || game.platform !== 'epic') return false;
  return /^fortnite$/i.test(String(game.appName || '')) || /^fortnite\b/i.test(cleanTitle(game.title));
}

export const hasMsStore = (game) => !!game && game.platform === 'epic' && game.appName === 'Fortnite';

const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });

/** Launchers show decimal sizes: 38400000000 -> "38,4 GB". Empty string when unknown. */
export function formatGameSize(bytes) {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b >= 1e9) return `${nf1.format(b / 1e9)} GB`;
  if (b >= 1e6) return `${Math.round(b / 1e6)} MB`;
  return '< 1 MB';
}

/** Sum of known sizes in bytes (0 when none is known). */
export const totalBytes = (games) => games.reduce((sum, g) => sum + (Number(g.sizeBytes) > 0 ? Number(g.sizeBytes) : 0), 0);

// ---- deterministic randomness -----------------------------------------------------------------

function hash(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) {
    x ^= str.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deep, saturated key-art palettes: a = top-left, b = bottom-right, glow = light source, hi = highlights.
const PALETTES = [
  { a: '#2a0f5e', b: '#08051a', glow: '#c026d3', hi: '#f0abfc' }, // 0 violet / magenta
  { a: '#053246', b: '#020c14', glow: '#06b6d4', hi: '#a5f3fc' }, // 1 cyan
  { a: '#4c0b1d', b: '#120309', glow: '#f43f5e', hi: '#fecdd3' }, // 2 crimson
  { a: '#3f2405', b: '#120a02', glow: '#f59e0b', hi: '#fde68a' }, // 3 amber
  { a: '#062b20', b: '#020d09', glow: '#10b981', hi: '#a7f3d0' }, // 4 emerald
  { a: '#0f1f5c', b: '#040818', glow: '#3b82f6', hi: '#bfdbfe' }, // 5 royal blue
  { a: '#3e0a47', b: '#0e0413', glow: '#ec4899', hi: '#fbcfe8' }, // 6 plum
  { a: '#1e1b4b', b: '#06051a', glow: '#8b5cf6', hi: '#ddd6fe' }, // 7 indigo
];

// Known titles get a palette that matches their vibe; everything else is hashed.
const TITLE_HINTS = [
  [/counter-?strike|\bcs2\b|cs:?go/i, 3],
  [/\brust\b/i, 2],
  [/rocket league/i, 5],
  [/fortnite/i, 7],
  [/valorant|apex|pubg|call of duty|warzone/i, 2],
  [/minecraft|fall guys/i, 4],
  [/gta|grand theft|cyberpunk|elden ring/i, 3],
  [/rainbow six|siege|destiny|halo/i, 5],
  [/dota|league of legends|genshin|overwatch/i, 1],
];

function paletteFor(title, seed) {
  for (const [re, idx] of TITLE_HINTS) if (re.test(title)) return PALETTES[idx];
  return PALETTES[seed % PALETTES.length];
}

const r1 = (n) => Math.round(n * 10) / 10;

function patternMarkup(kind, rnd, pal, rgb) {
  const W = 320;
  const H = 180;
  let out = '';
  switch (kind) {
    case 'grid': {
      // Synthwave floor: lines converging to a vanishing point on a horizon.
      const vx = 120 + rnd() * 140;
      const hy = 78 + rnd() * 26;
      for (let i = -9; i <= 9; i++) out += `<line x1="${r1(vx + i * 6)}" y1="${r1(hy)}" x2="${r1(vx + i * 62)}" y2="${H + 8}"/>`;
      for (let k = 1; k <= 7; k++) {
        const y = hy + (H + 8 - hy) * Math.pow(k / 7, 1.9);
        out += `<line x1="-10" y1="${r1(y)}" x2="${W + 10}" y2="${r1(y)}"/>`;
      }
      return `<g stroke="rgb(${rgb})" stroke-opacity=".2" stroke-width=".8" fill="none">${out}</g><line x1="0" y1="${r1(hy)}" x2="${W}" y2="${r1(hy)}" stroke="${pal.hi}" stroke-opacity=".55" stroke-width="1"/>`;
    }
    case 'rings': {
      const cx = 200 + rnd() * 90;
      const cy = 40 + rnd() * 90;
      for (let i = 0; i < 11; i++) {
        const r = 14 + i * 24 + rnd() * 6;
        const o = Math.max(0.04, 0.32 - i * 0.026);
        out += `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(r)}" stroke-opacity="${r1(o * 100) / 100}" stroke-dasharray="${i % 3 === 1 ? '2 5' : 'none'}"/>`;
      }
      return `<g stroke="${pal.hi}" stroke-width="1" fill="none">${out}</g>`;
    }
    case 'stripes': {
      let x = -60;
      for (let i = 0; i < 9; i++) {
        const w = 8 + rnd() * 26;
        out += `<rect x="${r1(x)}" y="-120" width="${r1(w)}" height="420" fill-opacity="${r1((0.035 + rnd() * 0.08) * 100) / 100}"/>`;
        x += w + 10 + rnd() * 34;
      }
      return `<g fill="${pal.hi}" transform="rotate(${r1(-24 - rnd() * 14)} 160 90)">${out}</g>`;
    }
    default: {
      // Shards: low-poly crystal splinters.
      for (let i = 0; i < 7; i++) {
        const x = 110 + rnd() * 230;
        const y = -20 + rnd() * 200;
        const s = 26 + rnd() * 70;
        const p = [
          [x, y],
          [x + s * (0.4 + rnd() * 0.6), y + s * (0.2 + rnd() * 0.5)],
          [x - s * (0.1 + rnd() * 0.5), y + s * (0.6 + rnd() * 0.7)],
        ]
          .map(([a, b]) => `${r1(a)},${r1(b)}`)
          .join(' ');
        const fill = i % 2 ? pal.glow : pal.hi;
        out += `<polygon points="${p}" fill="${fill}" fill-opacity="${r1((0.06 + rnd() * 0.16) * 100) / 100}" stroke="${pal.hi}" stroke-opacity=".22" stroke-width=".7"/>`;
      }
      return `<g>${out}</g>`;
    }
  }
}

/**
 * Generated key art for a game (16:9 viewBox, slices to fill its box).
 * Returns an SVGElement (.gart) – decorative, aria-hidden.
 */
export function coverArt(game) {
  const title = cleanTitle(game && game.title);
  const seed = hash(title.toLowerCase());
  const rnd = mulberry32(seed);
  const pal = paletteFor(title, seed);
  const rgb = PLATFORMS[platformOf(game)].rgb;
  const id = nextId('gart');
  const kinds = ['grid', 'rings', 'stripes', 'shards'];
  const kind = kinds[(seed >>> 5) % kinds.length];

  const blob = { x: r1(170 + rnd() * 130), y: r1(10 + rnd() * 80), r: r1(120 + rnd() * 70) };
  const glow = { x: r1(rnd() * 150), y: r1(120 + rnd() * 70), r: r1(90 + rnd() * 60) };
  const streakY = r1(30 + rnd() * 110);
  const streakA = r1(-16 + rnd() * 10);
  const ini = monogram(title) || '?';
  const fs = ini.length > 1 ? 128 : 166;
  const tx = 320 - 12;
  const ty = r1(180 + fs * 0.1);

  return svg(`<svg class="gart" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${pal.a}"/><stop offset="1" stop-color="${pal.b}"/></linearGradient>
      <radialGradient id="${id}g1"><stop offset="0" stop-color="${pal.glow}" stop-opacity=".8"/><stop offset=".55" stop-color="${pal.glow}" stop-opacity=".18"/><stop offset="1" stop-color="${pal.glow}" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}g2"><stop offset="0" stop-color="rgb(${rgb})" stop-opacity=".42"/><stop offset="1" stop-color="rgb(${rgb})" stop-opacity="0"/></radialGradient>
      <linearGradient id="${id}tx" x1="0" y1="0" x2="0" y2="1"><stop offset=".05" stop-color="#ffffff" stop-opacity=".95"/><stop offset=".55" stop-color="${pal.hi}" stop-opacity=".55"/><stop offset=".95" stop-color="${pal.hi}" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}st" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset=".5" stop-color="${pal.hi}" stop-opacity=".9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}fd" x1="0" y1="0" x2="0" y2="1"><stop offset=".3" stop-color="#05060a" stop-opacity="0"/><stop offset="1" stop-color="#05060a" stop-opacity=".9"/></linearGradient>
    </defs>
    <rect width="320" height="180" fill="url(#${id}bg)"/>
    <circle cx="${blob.x}" cy="${blob.y}" r="${blob.r}" fill="url(#${id}g1)"/>
    <circle cx="${glow.x}" cy="${glow.y}" r="${glow.r}" fill="url(#${id}g2)"/>
    <g class="gart__pat">${patternMarkup(kind, rnd, pal, rgb)}</g>
    <g class="gart__ini">
      <text x="${tx}" y="${ty}" text-anchor="end" font-size="${fs}" fill="none" stroke="rgb(${rgb})" stroke-opacity=".38" stroke-width="1.1" transform="translate(-6 -4)">${ini}</text>
      <text x="${tx}" y="${ty}" text-anchor="end" font-size="${fs}" fill="url(#${id}tx)">${ini}</text>
    </g>
    <rect class="gart__streak" x="-80" y="${streakY}" width="480" height="1.4" fill="url(#${id}st)" transform="rotate(${streakA} 160 90)"/>
    <rect width="320" height="180" fill="url(#${id}fd)"/>
  </svg>`);
}
