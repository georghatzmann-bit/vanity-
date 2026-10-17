// Switch row: label + grey one-line explanation + animated switch (role="switch").
import { h, nextId } from '../core/dom.js';
import { sound } from '../core/sound.js';

/**
 * Toggle({ checked, label, description, onChange, disabled })
 * Returns the row element with: checked (get/set), setChecked(v, { silent }), setDisabled(bool)
 */
export function Toggle({ checked = false, label = '', description = '', onChange, disabled = false } = {}) {
  const labelId = nextId('tg');
  const descId = nextId('tgd');
  const knob = h('span.toggle__knob');
  const sw = h('button.toggle__switch', {
    type: 'button',
    attrs: { role: 'switch', 'aria-checked': String(!!checked), 'aria-labelledby': label ? labelId : null, 'aria-describedby': description ? descId : null },
    disabled,
  }, knob);
  const el = h(
    'div.toggle',
    label || description
      ? h('div.toggle__text', label ? h('span.toggle__label', { id: labelId }, label) : null, description ? h('span.toggle__desc', { id: descId }, description) : null)
      : null,
    sw,
  );
  let on = !!checked;
  el.classList.toggle('is-on', on);

  function set(v, silent) {
    on = !!v;
    el.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', String(on));
    if (!silent) onChange?.(on);
  }

  el.addEventListener('click', (e) => {
    if (sw.disabled) return;
    if (e.target !== sw && !sw.contains(e.target) && e.target.closest('a,button,input')) return;
    set(!on, false);
    sound.play(on ? 'click' : 'hover');
  });
  el.addEventListener('pointerenter', () => sound.play('hover'));

  const api = {
    get checked() {
      return on;
    },
    set checked(v) {
      set(v, true);
    },
    setChecked(v, { silent = false } = {}) {
      set(v, silent);
      return el;
    },
    setDisabled(v) {
      sw.disabled = !!v;
      return el;
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
