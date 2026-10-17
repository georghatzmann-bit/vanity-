// Extra stroke icons for the restore + select screens (same 24px / 1.75 stroke language as icons.js).
// Falls back to icons.js for every name not defined here.
import { svg } from '../core/dom.js';
import { icon as baseIcon, ICON_NAMES } from './icons.js';

const EXTRA = {
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2.2"/><path d="M8.5 20h7M12 16.5V20"/>',
  globe: '<circle cx="12" cy="12" r="8.75"/><path d="M3.5 12h17"/><path d="M12 3.3c2.4 2.4 3.6 5.3 3.6 8.7s-1.2 6.3-3.6 8.7c-2.4-2.4-3.6-5.3-3.6-8.7s1.2-6.3 3.6-8.7z"/>',
  chat: '<path d="M20 11.6c0 4-3.6 7.1-8 7.1-1.1 0-2.2-.2-3.1-.6L4.5 19.5l1.2-3.6A6.7 6.7 0 0 1 4 11.6c0-4 3.6-7.1 8-7.1s8 3.1 8 7.1z"/><path d="M8.6 11.7h.01M12 11.7h.01M15.4 11.7h.01"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.4-3.4a6 6 0 0 1-7.9 7.9l-6.4 6.4a2.1 2.1 0 0 1-3-3l6.4-6.4a6 6 0 0 1 7.9-7.9z"/>',
  music: '<path d="M9 18V5.5l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>',
  radar: '<circle cx="12" cy="12" r="8.75"/><circle cx="12" cy="12" r="4.6"/><path d="M12 12 18.2 5.8"/><path d="M12 12h.01"/>',
  steam: '<circle cx="12" cy="12" r="8.75"/><circle cx="15.2" cy="9.6" r="2.4"/><circle cx="8.8" cy="15" r="1.7"/><path d="m10.3 14.2 2.9-2.4M4 13.1l3.4 1.4"/>',
  epic: '<path d="M6 3.5h12v13.2L12 20.5l-6-3.8z"/><path d="M14.5 7.5h-5v8h5M9.5 11.5h3.5"/>',
};

/** icon(name, opts) – screen-local extras first, then the shared set. */
export function xicon(name, { size = 24, strokeWidth = 1.75, className = '' } = {}) {
  if (!EXTRA[name]) return baseIcon(ICON_NAMES.includes(name) ? name : 'info', { size, strokeWidth, className });
  return svg(
    `<svg class="icon ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${EXTRA[name]}</svg>`,
  );
}

/** Category → icon name for the sidebar and section heads. */
export const CATEGORY_ICONS = {
  'Gaming-Launcher': 'rocket',
  'Gaming-Tools': 'zap',
  Browser: 'globe',
  Kommunikation: 'chat',
  'Musik & Video': 'music',
  Tools: 'wrench',
  'Treiber & Runtimes': 'cpu',
  'Weitere Apps': 'grid',
};
