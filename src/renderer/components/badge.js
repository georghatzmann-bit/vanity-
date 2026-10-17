// Status badge. Status colors are always paired with a text label.
import { h } from '../core/dom.js';
import { icon } from './icons.js';

const TONES = ['neutral', 'accent', 'ok', 'warn', 'err'];

/**
 * Badge({ tone, label, icon, dot, live })
 * - tone: 'neutral' | 'accent' | 'ok' | 'warn' | 'err'
 * Returns the <span> with: setTone(tone), setLabel(text), set({ tone, label, icon })
 */
export function Badge({ tone = 'neutral', label = '', icon: iconName, dot = false, live = false } = {}) {
  const el = h('span.badge');
  const labelEl = h('span.badge__label', label);

  function render(next) {
    const t = TONES.includes(next.tone) ? next.tone : 'neutral';
    el.className = `badge badge--${t}${next.live ? ' badge--live' : ''}`;
    el.textContent = '';
    if (next.icon) el.append(icon(next.icon, { strokeWidth: 2 }));
    else if (next.dot) el.append(h('span.badge__dot'));
    labelEl.textContent = next.label;
    el.append(labelEl);
  }
  const state = { tone, label, icon: iconName, dot, live };
  render(state);

  return Object.assign(el, {
    setTone(t) {
      state.tone = t;
      render(state);
      return el;
    },
    setLabel(text) {
      state.label = text;
      labelEl.textContent = text;
      return el;
    },
    set(partial) {
      Object.assign(state, partial);
      render(state);
      return el;
    },
  });
}
