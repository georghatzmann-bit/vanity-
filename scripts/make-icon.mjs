// Generates the Phoenix app icon from code:
//   build/icon.svg  – vector source (1024 master)
//   build/icon.png  – 1024 x 1024 PNG (Linux window icon, docs)
//   build/icon.ico  – 16, 24, 32, 48, 64, 128, 256 (exe, installer, uninstaller, shortcuts)
//
// Every ICO size is rendered natively at its own pixel size (no downscaling) and small sizes use a
// bolder layout (bigger mark, wider gap, no blur) so the icon stays crisp at 16 px.
// The mark reuses the SVG paths of logoMark() in src/renderer/components/icons.js.
//
// Usage: node scripts/make-icon.mjs        (needs Playwright + Chromium and python3 with Pillow)
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs overrides where Playwright is loaded from.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// logoMark() paths, 32 x 32 design grid (bounds x 4.4–27.6, y 2.6–28.5).
const WING_L = 'M16 28.5C9.6 24.6 4.6 17.8 4.4 7.6c3.7 4.8 7.3 7.1 11.6 7.9z';
const WING_R = 'M16 28.5c6.4-3.9 11.4-10.7 11.6-20.9-3.7 4.8-7.3 7.1-11.6 7.9z';
const FLAME = 'M16 2.6c3.4 4.1 4.6 8.4 3.2 12.4-.7 2-1.8 3.5-3.2 4.9-1.4-1.4-2.5-2.9-3.2-4.9-1.4-4-.2-8.3 3.2-12.4z';
const MARK_CX = 16;
const MARK_CY = 15.55;
const MARK_H = 25.9;

const r = (n) => Math.round(n * 1000) / 1000;

/** Builds the icon SVG for a target pixel size (layout adapts to the size). */
export function iconSvg(size) {
  const S = size;
  const small = S <= 32;
  const tiny = S <= 16;
  // Tile geometry (pixel-snapped at small sizes so the edges stay sharp).
  const m = small ? (tiny ? 0 : 1) : Math.round(S * 0.04);
  const t = S - 2 * m;
  const rx = r(t * (small ? 0.24 : 0.225));
  // Mark: fraction of tile height; bolder at small sizes.
  const markH = t * (tiny ? 0.8 : small ? 0.74 : 0.6);
  const k = markH / MARK_H;
  const cx = S / 2;
  const cy = m + t * (small ? 0.5 : 0.505);
  const tf = `translate(${r(cx - MARK_CX * k)} ${r(cy - MARK_CY * k)}) scale(${r(k)})`;
  // Negative-space gap between flame and wings (visible width in px: ~1 px small, ~1.3 % large).
  const gapPx = tiny ? 0 : small ? 1 : S * 0.013;
  const gap = gapPx / k;
  const edgeW = r(Math.max(1, S / 160));
  const blur = r(S * 0.05);
  const id = (n) => `phx-${n}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="${id('tile')}" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#151025"/>
      <stop offset="1" stop-color="#07080C"/>
    </linearGradient>
    <radialGradient id="${id('glow')}" cx="0.5" cy="${small ? 0.52 : 0.6}" r="${small ? 0.62 : 0.6}">
      <stop offset="0" stop-color="#8B5CF6" stop-opacity="${small ? 0.5 : 0.62}"/>
      <stop offset="0.5" stop-color="#7C3AED" stop-opacity="${small ? 0.16 : 0.2}"/>
      <stop offset="1" stop-color="#7C3AED" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id('sheen')}" cx="0.3" cy="0" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${id('edge')}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#C4B5FD" stop-opacity="${small ? 0.42 : 0.36}"/>
      <stop offset="0.5" stop-color="#8B5CF6" stop-opacity="${small ? 0.2 : 0.1}"/>
      <stop offset="1" stop-color="#8B5CF6" stop-opacity="${small ? 0.28 : 0.18}"/>
    </linearGradient>
    <linearGradient id="${id('wing')}" x1="16" y1="7.6" x2="16" y2="28.5" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#F5F3FF"/>
      <stop offset="0.42" stop-color="#A78BFA"/>
      <stop offset="1" stop-color="#8B5CF6"/>
    </linearGradient>
    <linearGradient id="${id('flame')}" x1="16" y1="2.6" x2="16" y2="19.9" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="0.6" stop-color="#EEEAFF"/>
      <stop offset="1" stop-color="#B9A4FC"/>
    </linearGradient>
    <clipPath id="${id('clip')}"><rect x="${m}" y="${m}" width="${t}" height="${t}" rx="${rx}"/></clipPath>
    ${
      gap > 0
        ? `<mask id="${id('knock')}" maskUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}">
      <rect width="${S}" height="${S}" fill="#fff"/>
      <path transform="${tf}" d="${FLAME}" fill="#000" stroke="#000" stroke-width="${r(gap * 2)}" stroke-linejoin="round"/>
    </mask>`
        : ''
    }
    ${small ? '' : `<filter id="${id('blur')}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur}"/></filter>`}
  </defs>
  <g clip-path="url(#${id('clip')})">
    <rect x="${m}" y="${m}" width="${t}" height="${t}" fill="url(#${id('tile')})"/>
    <rect x="${m}" y="${m}" width="${t}" height="${t}" fill="url(#${id('glow')})"/>
    <rect x="${m}" y="${m}" width="${t}" height="${t}" fill="url(#${id('sheen')})"/>
    ${
      small
        ? ''
        : `<g${gap > 0 ? ` mask="url(#${id('knock')})"` : ''}><g transform="${tf}" filter="url(#${id('blur')})">
      <path fill="#8B5CF6" d="${WING_L}"/><path fill="#8B5CF6" d="${WING_R}"/><path fill="#C4B5FD" d="${FLAME}"/>
    </g></g>`
    }
    <g${gap > 0 ? ` mask="url(#${id('knock')})"` : ''}>
      <g transform="${tf}">
        <path fill="url(#${id('wing')})" d="${WING_L}"/>
        <path fill="url(#${id('wing')})" d="${WING_R}" opacity="0.82"/>
      </g>
    </g>
    <path transform="${tf}" fill="url(#${id('flame')})" d="${FLAME}"/>
  </g>
  <rect x="${r(m + edgeW / 2)}" y="${r(m + edgeW / 2)}" width="${r(t - edgeW)}" height="${r(t - edgeW)}" rx="${r(rx - edgeW / 2)}" fill="none" stroke="url(#${id('edge')})" stroke-width="${edgeW}"/>
</svg>
`;
}

async function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const c of candidates) {
    try {
      return (await import(c)).chromium;
    } catch {
      /* try next */
    }
  }
  throw new Error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE.');
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'icon.svg'), iconSvg(1024));

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (size, file) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(size)}</body></html>`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  };

  const tmp = mkdtempSync(join(tmpdir(), 'phx-icon-'));
  try {
    await render(1024, join(OUT, 'icon.png'));
    const pngs = [];
    for (const s of ICO_SIZES) {
      const f = join(tmp, `icon-${s}.png`);
      await render(s, f);
      pngs.push(f);
    }
    if (process.env.ICON_PREVIEW_DIR) {
      for (const s of ICO_SIZES) await render(s, join(process.env.ICON_PREVIEW_DIR, `icon-${s}.png`));
    }
    await browser.close();
    execFileSync(process.env.PYTHON || 'python3', [join(ROOT, 'scripts', 'make-ico.py'), join(OUT, 'icon.ico'), ...pngs], {
      stdio: 'inherit',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('icon: build/icon.svg, build/icon.png (1024), build/icon.ico (' + ICO_SIZES.join(', ') + ')');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
