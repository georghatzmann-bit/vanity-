/**
 * Erzeugt die statischen SVG-Assets (App-Icon, Mono-Zeichen, Lockup) aus derselben Geometrie
 * wie die React-Komponenten. Aufruf über `pnpm --filter @aegis/ui export-logo`; ein Test
 * stellt sicher, dass die Dateien in `assets/` exakt dieser Ausgabe entsprechen.
 *
 * Die Assets enthalten feste Farben aus dem dunklen Theme (keine CSS-Variablen), damit sie
 * auch außerhalb des Browsers (z. B. `tauri icon`, resvg) korrekt gerendert werden.
 * Hinweis: Diese Datei wird auch direkt von Node (Type-Stripping) geladen – daher nur
 * löschbare TypeScript-Syntax und Importe mit Dateiendung.
 */
import { themes } from '../tokens/tokens.ts';
import {
  fillShape,
  formatNumber,
  innerMark,
  lockup,
  lockupViewBox,
  markSize,
  markStrokeWidth,
  markViewBox,
  outline,
  scanLine,
  wordmarkFill,
  wordmarkStroke,
  wordmarkStrokeWidth,
} from './geometry.ts';

const palette = themes.dark.colors;

function svgDocument(attributes: string, body: readonly string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>`,
    ...body.map((line) => `  ${line}`),
    '</svg>',
    '',
  ].join('\n');
}

function cutoutMask(id: string): readonly string[] {
  return [
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${markSize}" height="${markSize}">`,
    `  <path d="${fillShape}" fill="white" stroke="white" stroke-width="${markStrokeWidth}" stroke-linejoin="miter"/>`,
    `  <path d="${innerMark}" fill="black"/>`,
    `  <path d="${scanLine}" fill="black"/>`,
    '</mask>',
  ];
}

function accentGradient(id: string): readonly string[] {
  return [
    `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${markSize / 2}" y1="2" x2="${markSize / 2}" y2="62">`,
    `  <stop offset="0" stop-color="${palette['accent-strong']}"/>`,
    `  <stop offset="1" stop-color="${palette.accent}"/>`,
    '</linearGradient>',
  ];
}

/** Kantenlänge des App-Icons in px. */
export const appIconSize = 1024;
/** Maßstab Bildzeichen → App-Icon (Schild ≈ 64 % der Kantenlänge). */
const appIconMarkScale = 11;
const appIconPlateInset = 24;
const appIconPlateRadius = 216;

/**
 * App-Icon: gefülltes Bildzeichen (Cyan-Verlauf, Λ und Scan-Balken ausgespart) auf einer
 * dunklen, abgerundeten Fläche. Optimiert für die Lesbarkeit bis 32 px / 16 px.
 */
export function renderAppIconSvg(): string {
  const plateSize = appIconSize - 2 * appIconPlateInset;
  const offset = formatNumber(appIconSize / 2 - (markSize / 2) * appIconMarkScale);
  return svgDocument(
    `width="${appIconSize}" height="${appIconSize}" viewBox="0 0 ${appIconSize} ${appIconSize}"`,
    [
      '<title>AEGIS</title>',
      '<defs>',
      '  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">',
      `    <stop offset="0" stop-color="${palette['surface-3']}"/>`,
      `    <stop offset="1" stop-color="${palette.bg}"/>`,
      '  </linearGradient>',
      '  <radialGradient id="halo" cx="0.5" cy="0.47" r="0.5">',
      `    <stop offset="0" stop-color="${palette.accent}" stop-opacity="0.22"/>`,
      `    <stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/>`,
      '  </radialGradient>',
      ...accentGradient('mark').map((line) => `  ${line}`),
      ...cutoutMask('cutout').map((line) => `  ${line}`),
      '</defs>',
      `<rect x="${appIconPlateInset}" y="${appIconPlateInset}" width="${plateSize}" height="${plateSize}" rx="${appIconPlateRadius}" fill="url(#plate)"/>`,
      `<rect x="${appIconPlateInset + 3}" y="${appIconPlateInset + 3}" width="${plateSize - 6}" height="${plateSize - 6}" rx="${appIconPlateRadius - 3}" fill="none" stroke="${palette.text}" stroke-opacity="0.08" stroke-width="6"/>`,
      `<rect x="${appIconPlateInset}" y="${appIconPlateInset}" width="${plateSize}" height="${plateSize}" rx="${appIconPlateRadius}" fill="url(#halo)"/>`,
      `<g transform="translate(${offset} ${offset}) scale(${appIconMarkScale})">`,
      `  <path d="${fillShape}" fill="url(#mark)" stroke="url(#mark)" stroke-width="${markStrokeWidth}" stroke-linejoin="miter" mask="url(#cutout)"/>`,
      '</g>',
    ],
  );
}

/** Kantenlänge der Kleinst-Variante (Raster 16 px, gezeichnet auf 64 Einheiten). */
export const smallIconSize = 64;

/**
 * Kleinst-Variante für 16/24 px (Taskleiste, Tray, Explorer-Liste): Schild fast
 * formatfüllend, ohne das feine Λ (verschwimmt bei 16 px), dafür ein kräftiger Scan-Balken
 * (doppelte Strichstärke) als einzige Aussparung.
 */
export function renderSmallIconSvg(): string {
  const scale = 0.9;
  const offset = formatNumber((smallIconSize - markSize * scale) / 2);
  const barHeight = markStrokeWidth * 2;
  return svgDocument(
    `width="${smallIconSize}" height="${smallIconSize}" viewBox="0 0 ${smallIconSize} ${smallIconSize}"`,
    [
      '<title>AEGIS</title>',
      '<defs>',
      ...accentGradient('mark').map((line) => `  ${line}`),
      `  <mask id="bar" maskUnits="userSpaceOnUse" x="0" y="0" width="${markSize}" height="${markSize}">`,
      `    <path d="${fillShape}" fill="white" stroke="white" stroke-width="${markStrokeWidth}" stroke-linejoin="miter"/>`,
      `    <rect x="14" y="${34 - barHeight / 2}" width="${markSize - 28}" height="${barHeight}" fill="black"/>`,
      '  </mask>',
      '</defs>',
      `<rect width="${smallIconSize}" height="${smallIconSize}" rx="12" fill="${palette.bg}"/>`,
      `<g transform="translate(${offset} ${offset}) scale(${scale})">`,
      `  <path d="${fillShape}" fill="url(#mark)" stroke="url(#mark)" stroke-width="${markStrokeWidth}" stroke-linejoin="miter" mask="url(#bar)"/>`,
      '</g>',
    ],
  );
}

/** Einfarbiges Bildzeichen (currentColor, ausgesparte Formen) – z. B. für Tray/Druck. */
export function renderMonoMarkSvg(): string {
  return svgDocument(`width="${markSize}" height="${markSize}" viewBox="${markViewBox}"`, [
    '<title>AEGIS</title>',
    '<defs>',
    ...cutoutMask('cutout').map((line) => `  ${line}`),
    '</defs>',
    `<path d="${fillShape}" fill="currentColor" stroke="currentColor" stroke-width="${markStrokeWidth}" stroke-linejoin="miter" mask="url(#cutout)"/>`,
  ]);
}

/** Lockup (Strichzeichen + Schriftzug) für dunkle Flächen. */
export function renderFullLogoSvg(): string {
  const height = 128;
  const width = formatNumber((lockup.width / lockup.height) * height);
  return svgDocument(`width="${width}" height="${height}" viewBox="${lockupViewBox}"`, [
    '<title>AEGIS</title>',
    '<defs>',
    ...accentGradient('mark').map((line) => `  ${line}`),
    '</defs>',
    `<g transform="translate(${lockup.markOffsetX} 0)">`,
    `  <path d="${fillShape}" fill="${palette.accent}" fill-opacity="0.08"/>`,
    `  <path d="${outline}" fill="none" stroke="url(#mark)" stroke-width="${markStrokeWidth}" stroke-linejoin="miter" stroke-miterlimit="4"/>`,
    `  <path d="${innerMark}" fill="url(#mark)"/>`,
    `  <path d="${scanLine}" fill="${palette['accent-strong']}"/>`,
    '</g>',
    `<g transform="translate(${lockup.wordmarkX} ${lockup.wordmarkY}) scale(${lockup.wordmarkScale})" fill="${palette.text}">`,
    `  <path d="${wordmarkFill}"/>`,
    `  <path d="${wordmarkStroke}" fill="none" stroke="${palette.text}" stroke-width="${wordmarkStrokeWidth}" stroke-linecap="butt" stroke-linejoin="miter"/>`,
    '</g>',
  ]);
}

/** Alle Assets: Dateiname in `packages/ui/assets/` → Inhalt. */
export function renderLogoAssets(): Readonly<Record<string, string>> {
  return {
    'logo-mark.svg': renderAppIconSvg(),
    'logo-mark-16.svg': renderSmallIconSvg(),
    'logo-mark-mono.svg': renderMonoMarkSvg(),
    'logo-full.svg': renderFullLogoSvg(),
  };
}
