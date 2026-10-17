// Game tile for the select screen: platform tile + title + "Epic Games · 35,8 GB" + switch.
// Built on Toggle (role="switch", whole tile clickable). Styles in select.css.
import { h } from '../core/dom.js';
import { Toggle } from './toggle.js';
import { xicon } from './selectIcons.js';
import { formatBytes } from '../core/format.js';
import { PLATFORM_LABEL } from './selectModel.js';

const PLATFORM_ICON = { epic: 'epic', steam: 'steam', other: 'gamepad' };

/**
 * GameCard({ entry: { key, game, title, platform }, selected, onChange(on) })
 * Returns the Toggle element (checked, setChecked(v, { silent })) with class .sel-game.
 */
export function GameCard({ entry, selected = true, onChange } = {}) {
  const g = entry.game || {};
  const platform = PLATFORM_LABEL[entry.platform] ? entry.platform : 'other';
  const size = Number(g.sizeBytes) > 0 ? formatBytes(g.sizeBytes) : '';
  const sub = [PLATFORM_LABEL[platform], size].filter(Boolean).join(' · ');
  const t = Toggle({ checked: selected, label: entry.title, description: sub, onChange });
  t.classList.add('sel-game', `sel-game--${platform}`);
  t.dataset.key = entry.key;
  t.prepend(h('span.sel-game__tile', { attrs: { 'aria-hidden': 'true' } }, xicon(PLATFORM_ICON[platform], { size: 22 })));
  t.querySelector('.toggle__label')?.setAttribute('title', entry.title);
  return t;
}
