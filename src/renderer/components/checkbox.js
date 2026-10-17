// Checkbox with animated check stroke. Real <input> underneath for keyboard + screen readers.
import { h, svg, nextId } from '../core/dom.js';
import { sound } from '../core/sound.js';
import { pop } from '../core/motion.js';

/** The 22px box with the check path (also used inside app cards). */
export function checkBox() {
  const box = h('span.checkbox__box', { attrs: { 'aria-hidden': 'true' } });
  box.append(svg('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 12.5 4.2 4.2 8.8-9.4"/></svg>'));
  return box;
}

/**
 * Checkbox({ checked, label, description, onChange, disabled })
 * Returns the <label> with: checked (get/set), setChecked(v, { silent }), setDisabled(bool)
 */
export function Checkbox({ checked = false, label = '', description = '', onChange, disabled = false } = {}) {
  const id = nextId('cb');
  const input = h('input.checkbox__input', { type: 'checkbox', id, checked, disabled });
  const box = checkBox();
  const text = h('span.checkbox__text', h('span.checkbox__label', label), description ? h('span.checkbox__desc', description) : null);
  const el = h('label.checkbox', { htmlFor: id }, input, box, label || description ? text : null);
  if (checked) el.classList.add('is-checked');

  input.addEventListener('change', () => {
    el.classList.toggle('is-checked', input.checked);
    sound.play(input.checked ? 'click' : 'hover');
    pop(box);
    onChange?.(input.checked);
  });
  el.addEventListener('pointerenter', () => sound.play('hover'));

  const api = {
    get checked() {
      return input.checked;
    },
    set checked(v) {
      api.setChecked(v, { silent: true });
    },
    setChecked(v, { silent = false } = {}) {
      input.checked = !!v;
      el.classList.toggle('is-checked', input.checked);
      if (!silent) onChange?.(input.checked);
      return el;
    },
    setDisabled(v) {
      input.disabled = !!v;
      return el;
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
