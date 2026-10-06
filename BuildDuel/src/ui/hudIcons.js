// =============================================================================
// Kleine Bilder (SVG) für das HUD: Waffen, Heil-Items, Bauteile – selbst gezeichnet,
// einfache Formen (keine Original-Grafiken). Waffen in der Text-Farbe (currentColor),
// Heil-Items in eigenen Farben.
// =============================================================================

// Waffen: breites Bild 48 x 24
const W = (body) => `<svg viewBox="0 0 48 24" aria-hidden="true"><g fill="currentColor">${body}</g></svg>`;
// Quadratisch 24 x 24
const S = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const WEAPON_ICONS = {
  shotgun: W(
    '<path d="M2 11.5 12 9l1 4.5-10 3z"/>' + // Kolben
    '<rect x="12" y="8" width="10" height="6" rx="1"/>' +
    '<rect x="21" y="8.5" width="25" height="2.6" rx="1"/>' + // Lauf
    '<rect x="26" y="11.6" width="11" height="3.2" rx="1.4"/>' + // Pump-Griff
    '<path d="M14.5 13.5h4l-1.6 5.5h-3.4z"/>',
  ),
  ar: W(
    '<path d="M2 9h9.5v6L3 16.5z"/>' +
    '<rect x="11" y="7" width="18" height="7" rx="1"/>' +
    '<rect x="17" y="4.6" width="7" height="2.4" rx="0.6"/>' + // Visier
    '<rect x="29" y="8" width="8" height="4.6" rx="1"/>' +
    '<rect x="36" y="9.3" width="10" height="2" rx="0.6"/>' +
    '<path d="M19 13.5h4.2l2.2 7.5h-4.4z"/>' + // Magazin
    '<path d="M12.5 13.5h3.4l-1 5.5h-3.4z"/>',
  ),
  smg: W(
    '<rect x="5" y="8" width="8" height="2" rx="0.6"/><rect x="5" y="8" width="2" height="7" rx="0.6"/>' +
    '<rect x="12" y="7" width="17" height="7" rx="1.2"/>' +
    '<rect x="28" y="9" width="9" height="2.4" rx="0.6"/>' +
    '<rect x="16.5" y="13.5" width="3.6" height="8.5" rx="0.8"/>' +
    '<path d="M23 13.5h3.4l-1 5.5H22z"/>',
  ),
  sniper: W(
    '<path d="M1 10.5 12 9v5l-7.5 2.5H1z"/>' +
    '<rect x="12" y="9" width="15" height="5" rx="1"/>' +
    '<rect x="26" y="10.3" width="21" height="1.9" rx="0.6"/>' +
    '<rect x="13" y="4.6" width="13" height="3.2" rx="1.6"/>' + // Zielfernrohr
    '<rect x="17.5" y="7.4" width="3" height="1.8"/>' +
    '<path d="M15 13.5h3.4l-1 5.5H14z"/>',
  ),
  pistol: W(
    '<rect x="14" y="7" width="21" height="5.2" rx="1.2"/>' +
    '<path d="M15.5 11.8h6.4l-1.8 9.2h-6z"/>' +
    '<path d="M22 12h4v1.6c0 1.6-1.4 2.8-3 2.8h-1z" opacity="0.8"/>',
  ),
  grenadeLauncher: W(
    '<path d="M3 10.5 12 9v5l-8 2.5z"/>' +
    '<circle cx="19" cy="12" r="5.6"/>' +
    '<rect x="23" y="8" width="21" height="6.4" rx="2"/>' +
    '<path d="M12.5 14h3.4l-1 5.5h-3.4z"/>',
  ),
  pickaxe: S(
    '<g fill="currentColor"><path d="M13.2 6.6 15 8.4 5.2 22.6 3 21z"/>' +
    '<path d="M3.6 9.4C7 4.4 13.8 2.2 20.8 4.6l1.2 3.2C16 6 10.6 7 6.2 11.2z"/></g>',
  ),
};

export const ITEM_ICONS = {
  bandage: S(
    '<g transform="rotate(-28 12 12)"><rect x="3" y="7" width="18" height="10" rx="3.2" fill="#F3E7D3"/>' +
    '<rect x="9.5" y="7" width="5" height="10" fill="#E5484D"/></g>',
  ),
  medkit: S(
    '<rect x="8.5" y="2.5" width="7" height="4" rx="1.2" fill="none" stroke="#F3E7D3" stroke-width="1.6"/>' +
    '<rect x="2.5" y="5.5" width="19" height="15" rx="2.6" fill="#E5484D"/>' +
    '<path d="M10.2 8.6h3.6v2.6h2.6v3.6h-2.6v2.6h-3.6v-2.6H7.6v-3.6h2.6z" fill="#FFFFFF"/>',
  ),
  smallShield: S(
    '<path d="M10 3h4v4.5l3.6 6.2A4.6 4.6 0 0 1 13.6 21h-3.2a4.6 4.6 0 0 1-4-7.3L10 7.5z" fill="#5AB8FF"/>' +
    '<rect x="9.2" y="2" width="5.6" height="2.4" rx="1" fill="#D6EEFF"/>' +
    '<path d="M8.4 14.5h7.2" stroke="#D6EEFF" stroke-width="1.4" stroke-linecap="round"/>',
  ),
  bigShield: S(
    '<rect x="4" y="6" width="16" height="16" rx="4" fill="#3E8BFF"/>' +
    '<rect x="8.5" y="2" width="7" height="5" rx="1.4" fill="#D6EEFF"/>' +
    '<path d="M12 10.2 16 12v3.2c0 2.2-1.8 3.8-4 4.6-2.2-.8-4-2.4-4-4.6V12z" fill="#D6EEFF"/>',
  ),
};

export const PIECE_ICONS = {
  wall: S(
    '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<rect x="3.5" y="3.5" width="17" height="17" rx="1"/>' +
    '<path d="M3.5 9.2h17M3.5 14.8h17M9 3.5v5.7M15 9.2v5.6M9 14.8v5.7" stroke-width="1.3"/></g>',
  ),
  floor: S(
    '<g stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<path d="M2.5 15.5 8.5 9h13l-6 6.5z" fill="currentColor" fill-opacity="0.25"/>' +
    '<path d="M2.5 15.5v2.5h13l6-6.5V9" fill="none"/></g>',
  ),
  ramp: S(
    '<g stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<path d="M3 20 21 4.5V20z" fill="currentColor" fill-opacity="0.25"/>' +
    '<path d="M8 15.7v4.3M13 11.4V20M17.5 7.5V20" fill="none" stroke-width="1.2"/></g>',
  ),
  roof: S(
    '<g stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
    '<path d="M2.5 17.5 12 4.5l9.5 13z" fill="currentColor" fill-opacity="0.25"/>' +
    '<path d="M12 4.5 9.5 17.5M2.5 17.5 21.5 17.5" fill="none" stroke-width="1.2"/></g>',
  ),
};

export const HUD_ICONS = {
  shield: S('<path d="M12 2.5 20 5.6v5.6c0 5-3.4 9-8 10.6-4.6-1.6-8-5.6-8-10.6V5.6z" fill="currentColor"/>'),
  health: S('<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor"/>'),
};

/** Bild für einen Gegenstand im Platz (Waffe oder Heil-Item). Unbekannt → leer. */
export function itemIcon(id) {
  return WEAPON_ICONS[id] ?? ITEM_ICONS[id] ?? '';
}
