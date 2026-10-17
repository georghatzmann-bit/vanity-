// Frameless window titlebar: drag region, brand, live status pill, sound/settings, window controls.
import { h } from '../core/dom.js';
import { icon, logoMark } from './icons.js';

/**
 * Titlebar({ api, store, sound, onSettings, version })
 * Returns the <header> with: setStatus(text, tone = 'accent'|'ok'|'warn'|'err'), clearStatus(), setVersion(v)
 */
export function Titlebar({ api, store, sound, onSettings, version = '' } = {}) {
  const tbBtn = (name, label, onClick, extra = '') => {
    const b = h(`button.tb-btn${extra}`, { type: 'button', title: label, attrs: { 'aria-label': label } }, icon(name));
    b.addEventListener('click', onClick);
    b.addEventListener('pointerenter', () => sound?.play('hover'));
    return b;
  };

  const versionEl = h('span.titlebar__version', version ? `v${version}` : '');
  if (!version) versionEl.hidden = true;
  const statusText = h('span.titlebar__status-text');
  const status = h('div.titlebar__status', { attrs: { role: 'status', 'aria-live': 'polite' } });

  const soundBtn = tbBtn('volume', 'Sound an/aus', () => {
    const s = store.get('settings');
    store.patch('settings', { sound: !s.sound });
    if (!s.sound) sound?.play('click');
  });
  const settingsBtn = tbBtn('settings', 'Einstellungen (Strg+,)', () => onSettings?.(), '.tb-btn--settings');
  const minBtn = tbBtn('minus', 'Minimieren', () => api.win.minimize().catch(() => {}));
  const maxBtn = tbBtn('square', 'Maximieren', () => api.win.toggleMaximize().catch(() => {}));
  const closeBtn = tbBtn('close', 'Schließen', () => api.win.close().catch(() => {}), '.tb-btn--close');

  const el = h(
    'header.titlebar',
    h('div.titlebar__brand', logoMark({ size: 22 }), h('span.titlebar__wordmark', 'PHOENIX'), versionEl),
    h('div.titlebar__center', status),
    h('div.titlebar__actions', soundBtn, settingsBtn, h('span.tb-sep'), minBtn, maxBtn, closeBtn),
  );

  const syncSound = (on) => {
    soundBtn.replaceChildren(icon(on ? 'volume' : 'volume-off'));
    soundBtn.classList.toggle('is-off', !on);
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.title = on ? 'Sound ausschalten' : 'Sound einschalten';
    soundBtn.setAttribute('aria-label', soundBtn.title);
  };
  store.subscribe((s) => s.settings.sound, syncSound, { immediate: true });

  return Object.assign(el, {
    setStatus(text, tone = 'accent') {
      status.textContent = '';
      if (!text) return el;
      status.dataset.tone = tone;
      statusText.textContent = text;
      status.append(h('span.titlebar__dot'), statusText);
      return el;
    },
    clearStatus() {
      status.textContent = '';
      return el;
    },
    setVersion(v) {
      versionEl.textContent = v ? `v${v}` : '';
      versionEl.hidden = !v;
      return el;
    },
  });
}
