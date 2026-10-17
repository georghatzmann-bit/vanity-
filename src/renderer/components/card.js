// Glass card. Variants: default, hero (animated beam border + aura), interactive (hover lift).
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { tilt as tiltFx } from '../core/motion.js';
import { sound } from '../core/sound.js';

/**
 * Card({ variant, tilt, padding, as, eyebrow, title, text, icon, onClick, className }, ...children)
 * - variant: 'default' | 'hero' | 'interactive'
 * - padding: 'md' | 'compact' | 'flush'
 * - as: tag name ('div' | 'button' | 'article' | 'section'); onClick turns it into an interactive button
 * Returns the element with: destroy()
 */
export function Card(opts = {}, ...children) {
  const { variant = 'default', tilt = false, padding = 'md', eyebrow, title, text, icon: iconName, onClick, className = '' } = opts;
  const tag = opts.as || (onClick ? 'button' : 'div');
  const interactive = variant === 'interactive' || !!onClick;
  const classes = [
    'card',
    variant === 'hero' && 'card--hero beam deco',
    interactive && 'card--interactive',
    padding === 'compact' && 'card--compact',
    padding === 'flush' && 'card--flush',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const el = h(tag, { class: classes, type: tag === 'button' ? 'button' : null });
  if (tag === 'button') el.style.textAlign = 'left';

  if (iconName) el.append(h('div.icon-tile.mb-4', icon(iconName)));
  if (eyebrow) el.append(h('div.t-eyebrow.card__eyebrow', eyebrow));
  if (title) el.append(h('div.card__title', title));
  if (text) el.append(h('p.card__text', text));
  for (const child of children.flat()) if (child != null && child !== false) el.append(child);

  const cleanups = [];
  if (tilt) cleanups.push(tiltFx(el, typeof tilt === 'object' ? tilt : {}));
  if (interactive) {
    el.addEventListener('pointerenter', () => sound.play('hover'));
  }
  if (onClick) {
    el.addEventListener('click', (e) => {
      sound.play('click');
      onClick(e);
    });
  }
  return Object.assign(el, {
    destroy() {
      cleanups.forEach((fn) => fn());
    },
  });
}
