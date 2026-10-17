// Designed empty state: orbiting icon, title, grey explanation, optional actions.
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { Button } from './button.js';

/**
 * EmptyState({ icon, title, text, actions: [{ label, onClick, variant, icon }] | Node[] , compact })
 */
export function EmptyState({ icon: iconName = 'folder', title = '', text = '', actions = [], compact = false } = {}) {
  const orb = h(
    'div.empty__orb.deco',
    h('span.empty__ring'),
    h('span.empty__sat.deco'),
    h('div.empty__icon', icon(iconName)),
  );
  const el = h('div.empty', { style: compact ? { padding: '24px 16px' } : null }, orb, h('h3.empty__title', title), text ? h('p.empty__text', text) : null);
  if (actions.length) {
    el.append(
      h(
        'div.empty__actions',
        actions.map((a, i) => (a instanceof Node ? a : Button({ variant: a.variant || (i === 0 ? 'primary' : 'secondary'), magnetic: false, ...a }))),
      ),
    );
  }
  return el;
}
