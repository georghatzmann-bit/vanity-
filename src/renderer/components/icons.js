// Hand-drawn 24px stroke icon set (currentColor, 1.75 stroke, round joins). No emoji, no icon fonts.
import { svg } from '../core/dom.js';
import { emblemSvg } from '../fx/emblem/svg.js';

const P = {
  shield: '<path d="M12 3.2 19 6v5.4c0 4.3-2.9 8-7 9.6-4.1-1.6-7-5.3-7-9.6V6z"/>',
  'shield-check': '<path d="M12 3.2 19 6v5.4c0 4.3-2.9 8-7 9.6-4.1-1.6-7-5.3-7-9.6V6z"/><path d="m9 12 2.2 2.2L15.4 10"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V4.5"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
  usb: '<path d="M9 9V3.5h6V9"/><path d="M11 6.2v.01M13 6.2v.01"/><rect x="6.5" y="9" width="11" height="12" rx="2.6"/><path d="M10 16.5h4"/>',
  harddrive: '<path d="M4.8 12 7 6a2 2 0 0 1 1.9-1.4h6.2A2 2 0 0 1 17 6l2.2 6"/><rect x="3" y="12" width="18" height="8" rx="2.4"/><path d="M7 16h.01M11 16h6"/>',
  cloud: '<path d="M7.5 19H17a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 10.1 4.5 4.5 0 0 0 7.5 19z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="8.75"/><path d="m8.3 12.2 2.6 2.6 4.9-5.1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  'x-circle': '<circle cx="12" cy="12" r="8.75"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  alert: '<path d="M10.27 4.5 2.6 17.8a2 2 0 0 0 1.73 3h15.34a2 2 0 0 0 1.73-3L13.73 4.5a2 2 0 0 0-3.46 0z"/><path d="M12 9.8v4.2"/><path d="M12 17.2h.01"/>',
  info: '<circle cx="12" cy="12" r="8.75"/><path d="M12 11v5.2"/><path d="M12 7.7h.01"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'arrow-right': '<path d="M4.5 12h15"/><path d="m13.5 6 6 6-6 6"/>',
  'arrow-left': '<path d="M19.5 12h-15"/><path d="m10.5 6-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  gamepad: '<path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 3.6l.9 4.6a2.6 2.6 0 0 1-4.5 2.2L15.2 15H8.8l-2.1 2.4a2.6 2.6 0 0 1-4.5-2.2l.9-4.6A4.5 4.5 0 0 1 7.5 7z"/><path d="M8 9.8v3.4M6.3 11.5h3.4"/><path d="M15.4 10.6h.01M17.6 12.4h.01"/>',
  sparkles: '<path d="M11 3q.9 6.1 7 7-6.1.9-7 7-.9-6.1-7-7 6.1-.9 7-7z"/><path d="M18.5 14.5q.3 2.7 3 3-2.7.3-3 3-.3-2.7-3-3 2.7-.3 3-3z"/>',
  settings: '<path d="M10.22 4.82 10.44 2.63h3.12l.22 2.19 2.04.84 1.7-1.39 2.21 2.21-1.39 1.7.84 2.04 2.19.22v3.12l-2.19.22-.84 2.04 1.39 1.7-2.21 2.21-1.7-1.39-2.04.84-.22 2.19h-3.12l-.22-2.19-2.04-.84-1.7 1.39-2.21-2.21 1.39-1.7-.84-2.04-2.19-.22v-3.12l2.19-.22.84-2.04-1.39-1.7 2.21-2.21 1.7 1.39z"/><circle cx="12" cy="12" r="3"/>',
  volume: '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.2 6.3a8 8 0 0 1 0 11.4"/>',
  'volume-off': '<path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  minus: '<path d="M5.5 12h13"/>',
  square: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>',
  restore: '<rect x="5" y="8" width="11" height="11" rx="2"/><path d="M8.5 5H17a2 2 0 0 1 2 2v8.5"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  refresh: '<path d="M19.5 13a7.5 7.5 0 1 1-2.2-6.3L19.5 9"/><path d="M19.5 4.5V9H15"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.8V6M14.5 2.8V6M9.5 18v3.2M14.5 18v3.2M2.8 9.5H6M2.8 14.5H6M18 9.5h3.2M18 14.5h3.2"/>',
  gpu: '<path d="M2.8 5.5h1.7v13"/><rect x="4.5" y="7" width="17" height="9" rx="2"/><circle cx="10" cy="11.5" r="2.3"/><circle cx="16.3" cy="11.5" r="2.3"/><path d="M7.5 16v2.5h8V16"/>',
  memory: '<rect x="3" y="7" width="18" height="9" rx="1.6"/><path d="M7 10v3M10.5 10v3M14 10v3M17.5 10v3"/><path d="M5.5 16v2.5M9 16v2.5M15 16v2.5M18.5 16v2.5"/>',
  windows: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.2"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.2"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.2"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.2"/>',
  file: '<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>',
  code: '<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5"/><path d="m13.4 5-2.8 14"/>',
  rocket: '<path d="M12 2.5c3 2.1 4.5 5.3 4.5 9.5L15 16H9l-1.5-4c0-4.2 1.5-7.4 4.5-9.5z"/><circle cx="12" cy="9.3" r="1.6"/><path d="M7.5 12 5 14.5V18l4-2M16.5 12l2.5 2.5V18l-4-2"/><path d="M10.5 19c0 1.2.7 2 1.5 2.5.8-.5 1.5-1.3 1.5-2.5"/>',
  flame: '<path d="M12 21.5c-3.6 0-6.5-2.7-6.5-6.4 0-2.9 1.7-4.8 3.1-6.6.3 1.6 1.1 2.7 2.3 3.2-.3-3.4 1.2-6.2 3.9-8.2.4 2.9 1.9 4.6 3.2 6.3 1.1 1.5.5 3.2.5 5.3 0 3.7-2.9 6.4-6.5 6.4z"/><path d="M12 21.5c-1.7 0-3-1.3-3-3 0-1.9 1.6-2.9 2.4-4.6.9 1.2 3.6 2.4 3.6 4.6 0 1.7-1.3 3-3 3z"/>',
  clock: '<circle cx="12" cy="12" r="8.75"/><path d="M12 7.5V12l3 2"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  power: '<path d="M12 3.5v8"/><path d="M7.1 6.6a7.5 7.5 0 1 0 9.8 0"/>',
  zap: '<path d="M13.5 2.8 5 13.5h6.5l-1 7.7L19 10.5h-6.5z"/>',
  layers: '<path d="m12 3.5 9 4.8-9 4.8-9-4.8z"/><path d="m3 12.2 9 4.8 9-4.8"/><path d="m3 16.2 9 4.8 9-4.8"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  user: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.5 7l.9 12a2 2 0 0 0 2 1.8h5.2a2 2 0 0 0 2-1.8l.9-12"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5"/>',
};

export const ICON_NAMES = Object.keys(P);

/** Raw SVG markup for an icon (for innerHTML use). */
export function iconMarkup(name, { size = 24, strokeWidth = 1.75, className = '' } = {}) {
  const body = P[name] || P.info;
  return `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Icon as SVGElement. icon('shield', { size: 20 }) */
export function icon(name, opts = {}) {
  return svg(iconMarkup(name, opts));
}

/**
 * The PHOENIX app mark – the canonical neon emblem (fx/emblem/svg.js), the same strokes the FX
 * engine draws, so titlebar, boot, app icon and installer share one logo. Below 40 px the simple
 * (bolder, fewer lines) variant is used. title = accessible name (omitted: decorative).
 */
export function logoMark({ size = 28, className = '', title = '', glow } = {}) {
  return svg(emblemSvg({ size, className: `logo-mark ${className}`.trim(), title, glow }));
}
