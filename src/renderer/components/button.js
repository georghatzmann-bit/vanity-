// Button: primary (beam border + glow + magnetic), secondary (glass), ghost, danger.
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { magnetic, pressable, ripple } from '../core/motion.js';
import { sound } from '../core/sound.js';

/**
 * Button({ label, variant, size, icon, iconRight, onClick, autoLoading, magnetic, block, title, ariaLabel, disabled, className })
 * - variant: 'primary' | 'secondary' | 'ghost' | 'danger'   (default 'secondary')
 * - size:    'sm' | 'md' | 'lg' | 'xl'                      (default 'md'; sm keeps a 44px hit area)
 * - autoLoading: when onClick returns a Promise, show the spinner until it settles
 * Returns the <button> with: setLoading(bool), setLabel(text), setDisabled(bool), destroy()
 */
export function Button({
  label = '',
  variant = 'secondary',
  size = 'md',
  icon: iconName,
  iconRight,
  onClick,
  autoLoading = false,
  magnetic: isMagnetic = variant === 'primary',
  block = false,
  title,
  ariaLabel,
  disabled = false,
  loading = false,
  type = 'button',
  className = '',
  clickSound = 'click',
} = {}) {
  // always create the label node so setLabel() also works for buttons that start empty
  const labelEl = h('span.btn__label', label);
  if (!label) labelEl.hidden = true;
  const inner = h('span.btn__inner', iconName ? icon(iconName) : null, labelEl, iconRight ? icon(iconRight) : null);
  const fxLayer = h('span.btn__fx', { attrs: { 'aria-hidden': 'true' } });
  const classes = ['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block', !label && 'btn--icon', className].filter(Boolean).join(' ');

  const el = h(
    'button',
    { type, class: classes, title, attrs: { 'aria-label': ariaLabel || (!label ? title : null) } },
    fxLayer,
    inner,
    h('span.btn__spinner', { attrs: { 'aria-hidden': 'true' } }),
  );

  const cleanups = [pressable(el)];
  if (isMagnetic) cleanups.push(magnetic(el, { inner, strength: 0.28, innerStrength: 0.12 }));

  el.addEventListener('pointerenter', () => {
    if (!el.disabled) sound.play('hover');
  });

  el.addEventListener('click', async (e) => {
    if (el.classList.contains('is-loading') || el.disabled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    ripple(fxLayer, e);
    if (clickSound) sound.play(clickSound);
    if (!onClick) return;
    const res = onClick(e);
    if (autoLoading && res && typeof res.then === 'function') {
      api.setLoading(true);
      try {
        await res;
      } finally {
        if (el.isConnected) api.setLoading(false);
      }
    }
  });

  const api = {
    setLoading(on) {
      el.classList.toggle('is-loading', !!on);
      el.setAttribute('aria-busy', on ? 'true' : 'false');
      return el;
    },
    setLabel(text) {
      labelEl.textContent = text;
      labelEl.hidden = !text;
      return el;
    },
    setDisabled(on) {
      el.disabled = !!on;
      return el;
    },
    destroy() {
      cleanups.forEach((fn) => fn());
    },
  };
  if (disabled) api.setDisabled(true);
  if (loading) api.setLoading(true);
  return Object.assign(el, api);
}

/** Small square icon-only button (44px hit area). */
export function IconButton({ icon: iconName, label, variant = 'ghost', size = 'md', onClick, className = '' }) {
  return Button({ icon: iconName, variant, size, onClick, title: label, ariaLabel: label, className, magnetic: false });
}
