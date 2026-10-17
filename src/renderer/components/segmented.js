// Segmented control (radiogroup) with a sliding glowing thumb. Arrow keys move the selection.
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { sound } from '../core/sound.js';

/**
 * Segmented({ options: [{ value, label, icon? }], value, onChange, ariaLabel })
 * Returns the element with: value (get), setValue(v, { silent }), destroy()
 */
export function Segmented({ options = [], value, onChange, ariaLabel = '' } = {}) {
  const thumb = h('span.segmented__thumb', { attrs: { 'aria-hidden': 'true' } });
  const el = h('div.segmented', { attrs: { role: 'radiogroup', 'aria-label': ariaLabel } }, thumb);
  let current = value ?? options[0]?.value;
  const buttons = options.map((opt) =>
    h(
      'button.segmented__opt',
      {
        type: 'button',
        dataset: { value: String(opt.value) },
        attrs: { role: 'radio' },
        onClick: () => select(opt.value, false),
        onPointerenter: () => sound.play('hover'),
      },
      opt.icon ? icon(opt.icon) : null,
      h('span', opt.label),
    ),
  );
  el.append(...buttons);

  function placeThumb(animate = true) {
    const i = options.findIndex((o) => o.value === current);
    const btn = buttons[i];
    if (!btn || !btn.offsetWidth) return;
    if (!animate) thumb.style.transition = 'none';
    thumb.style.width = `${btn.offsetWidth}px`;
    thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
    if (!animate) {
      void thumb.offsetWidth;
      thumb.style.transition = '';
    }
  }

  function sync() {
    buttons.forEach((b, i) => {
      const on = options[i].value === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function select(v, silent) {
    if (v === current) return;
    current = v;
    sync();
    placeThumb(true);
    if (!silent) {
      sound.play('click');
      onChange?.(v);
    }
  }

  el.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === current);
    const next = (i + dir + options.length) % options.length;
    select(options[next].value, false);
    buttons[next].focus();
  });

  sync();
  const ro = new ResizeObserver(() => placeThumb(false));
  ro.observe(el);
  requestAnimationFrame(() => placeThumb(false));

  const api = {
    get value() {
      return current;
    },
    setValue(v, { silent = true } = {}) {
      select(v, silent);
      return el;
    },
    destroy() {
      ro.disconnect();
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
