// =============================================================================
// Symbole für die Menüs (eigene, einfache SVG-Formen – keine Original-Grafiken)
// =============================================================================
const svg = (body, view = '0 0 24 24') =>
  `<svg class="ic" viewBox="${view}" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  gear: svg('<path fill="currentColor" d="M10.3 2h3.4l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.7 2.9-2 1.8c.1.6.1 1.2 0 1.8l2 1.8-1.7 2.9-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-3.4l-.5-2.6c-.6-.2-1.2-.5-1.7-.9l-2.5.9L2.4 15l2-1.8a6 6 0 0 1 0-1.8l-2-1.8 1.7-2.9 2.5.9c.5-.4 1.1-.7 1.7-.9zM12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z" transform="translate(0 1)"/>'),
  coin: svg('<circle cx="12" cy="12" r="10" fill="#FFC83D"/><circle cx="12" cy="12" r="7.2" fill="#FFB000"/><circle cx="12" cy="12" r="7.2" fill="none" stroke="#FFE38A" stroke-width="1.4"/><path d="M10 8h3.2a2.3 2.3 0 0 1 0 4.6H10zm0 4.6h3.6a2.2 2.2 0 0 1 0 4.4H10z" fill="none" stroke="#8A5A00" stroke-width="1.7" stroke-linejoin="round" transform="translate(0 -.5)"/>'),
  trophy: svg('<path fill="#FFD23D" d="M7 3h10v2h3v2.5A4.5 4.5 0 0 1 16.2 12 5 5 0 0 1 13 14.8V17h3v3H8v-3h3v-2.2A5 5 0 0 1 7.8 12 4.5 4.5 0 0 1 4 7.5V5h3zm-1 4v.5a2.5 2.5 0 0 0 1.4 2.2A9 9 0 0 1 7 7zm11 0c0 1-.1 1.9-.4 2.7A2.5 2.5 0 0 0 18 7.5V7z"/><path fill="#E59A00" d="M12 4h4v5a4 4 0 0 1-4 4z"/>'),
  shop: svg('<path fill="currentColor" d="M6 7V6a6 6 0 0 1 12 0v1h2.2l-1 14.2a1 1 0 0 1-1 .8H5.8a1 1 0 0 1-1-.8L3.8 7zm2 0h8V6a4 4 0 0 0-8 0zm-.5 3.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zm9 0a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>'),
  locker: svg('<path fill="currentColor" d="M12 3a3 3 0 0 1 3 3h-2a1 1 0 1 0-1 1 1 1 0 0 1 1 1v1.3l8.2 5.6A1.8 1.8 0 0 1 20.2 18H3.8a1.8 1.8 0 0 1-1-3.1L11 9.3V8.8A3 3 0 0 1 12 3zm0 8.3L5 16h14z"/>'),
  pencil: svg('<path fill="currentColor" d="M15.5 4.5l4 4L9 19l-5 1 1-5zm1.4-1.4l1.4-1.4a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2l-1.4 1.4z" transform="scale(.9) translate(1 1)"/>'),
  lock: svg('<path fill="currentColor" d="M7 10V7a5 5 0 0 1 10 0v3h1.5A1.5 1.5 0 0 1 20 11.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20.5v-9A1.5 1.5 0 0 1 5.5 10zm2 0h6V7a3 3 0 0 0-6 0z"/>'),
  check: svg('<path fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/>'),
  back: svg('<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/>'),
  close: svg('<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>'),
  play: svg('<path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/>'),
  swap: svg('<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" d="M5 8h13l-3.5-3.5M19 16H6l3.5 3.5"/>'),
  solo: svg('<circle cx="12" cy="7.5" r="4" fill="currentColor"/><path fill="currentColor" d="M4 20.5a8 8 0 0 1 16 0z"/>'),
  duo: svg('<circle cx="8.5" cy="8" r="3.4" fill="currentColor"/><circle cx="16.5" cy="8" r="3.4" fill="currentColor" opacity=".7"/><path fill="currentColor" d="M1.8 20a6.7 6.7 0 0 1 13.4 0z"/><path fill="currentColor" opacity=".7" d="M12.6 14.4A6.7 6.7 0 0 1 22.2 20h-5.4a8.6 8.6 0 0 0-4.2-5.6z"/>'),
  skin: svg('<circle cx="12" cy="6.5" r="3.8" fill="currentColor"/><path fill="currentColor" d="M6.5 11.5h11l1.5 6h-2.5L16 22h-8l-.5-4.5H5z"/>'),
  pickaxe: svg('<path fill="currentColor" d="M3.5 7.5C7 3.5 13 2.5 18 4.6l1.4-1.4 1.4 1.4-1.4 1.4c2.1 5 1.1 11-2.9 14.5.9-4 .4-8.1-1.5-11.4L5.5 20.6l-2.1-2.1L14.9 7c-3.3-1.9-7.4-2.4-11.4-1.5z"/>'),
  emote: svg('<path fill="currentColor" d="M9 3.5l11-2v13.2a3.3 3.3 0 1 1-2-3V6.1l-7 1.3v9.3a3.3 3.3 0 1 1-2-3z"/>'),
};

// Kachel-Bilder für die Modi (groß, bunt)
const tile = (bg, body) => svg(`<rect width="48" height="48" rx="11" fill="${bg}"/>${body}`, '0 0 48 48');
export const MODE_ICONS = {
  creative: tile('#2EB86B', '<path fill="#C98F55" d="M9 31h14v9H9z"/><path fill="#A8733F" d="M23 31h14v9H23z"/><path fill="#E0A96D" d="M16 22h14v9H16z"/><path fill="#fff" d="M30 9l5 5-11 11-6 1 1-6z"/><path fill="#FFD23D" d="M33 7l3-3 5 5-3 3z"/>'),
  practice: tile('#3D8BFF', '<circle cx="24" cy="24" r="14" fill="#fff"/><circle cx="24" cy="24" r="10" fill="#E8483B"/><circle cx="24" cy="24" r="6" fill="#fff"/><circle cx="24" cy="24" r="2.6" fill="#E8483B"/><path stroke="#1D3557" stroke-width="3" stroke-linecap="round" d="M24 4v7M24 37v7M4 24h7M37 24h7"/>'),
  duel: tile('#E8475F', '<path fill="#fff" d="M10 9l17 17-3 3L7 12zM38 9L21 26l3 3 17-17z"/><path fill="#FFD23D" d="M12 33l4-4 3 3-4 4zM36 33l-4-4-3 3 4 4z"/><circle cx="12" cy="37" r="3" fill="#2B2D42"/><circle cx="36" cy="37" r="3" fill="#2B2D42"/>'),
  boxFight: tile('#A34DF0', '<path fill="#C98F55" d="M10 18l14-8 14 8v16l-14 8-14-8z"/><path fill="#A8733F" d="M24 26v16l14-8V18z"/><path fill="#E0A96D" d="M10 18l14 8 14-8-14-8z"/>'),
  zoneWars: tile('#7B2CBF', '<circle cx="24" cy="24" r="15" fill="none" stroke="#E0B3FF" stroke-width="4" stroke-dasharray="5 4"/><circle cx="24" cy="24" r="7" fill="#fff"/><path fill="#7B2CBF" d="M24 19l2 4h-4z"/>'),
  battleRoyale: tile('#F5A623', '<path fill="#fff" d="M8 22a16 12 0 0 1 32 0c-3-2-6-2-8 0-2.5-2-5.5-2-8 0-2.5-2-5.5-2-8 0-2-2-5-2-8 0z"/><path stroke="#fff" stroke-width="1.8" d="M10 22l13 14M38 22L25 36M18 22l5 14M30 22l-5 14"/><rect x="21" y="35" width="6" height="7" rx="2" fill="#1D3557"/>'),
  deathmatch: tile('#FF6B35', '<path fill="#fff" d="M24 8c-8 0-13 5.5-13 12.5 0 4.6 2.4 7.6 5 9.2V36h16v-6.3c2.6-1.6 5-4.6 5-9.2C37 13.5 32 8 24 8z"/><circle cx="18.5" cy="21" r="3.6" fill="#2B2D42"/><circle cx="29.5" cy="21" r="3.6" fill="#2B2D42"/><path fill="#2B2D42" d="M20 32h2v4h-2zM26 32h2v4h-2z"/>'),
  aimTrainer: tile('#2EC4E6', '<circle cx="24" cy="24" r="13" fill="none" stroke="#fff" stroke-width="3.5"/><path stroke="#fff" stroke-width="3.5" stroke-linecap="round" d="M24 6v9M24 33v9M6 24h9M33 24h9"/><circle cx="24" cy="24" r="3" fill="#E8483B"/>'),
  default: tile('#8FA3BF', '<circle cx="24" cy="24" r="9" fill="#fff"/>'),
};
