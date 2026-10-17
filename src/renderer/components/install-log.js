// Collapsible live-log drawer for the install screen. The collapsed bar shows the newest line as a
// ticker; the panel keeps the last `max` lines (monospace), sticks to the bottom unless the user
// scrolled up, and can copy everything. Styles live in styles/screens/install.css (.ilog*).
import { h, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { Button } from './button.js';
import { gsap, motionOK } from '../core/motion.js';

const TAGS = { ok: 'OK', err: 'FEHLER', warn: 'HINWEIS', info: 'INFO', run: 'START', raw: 'WINGET' };
const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;

/**
 * InstallLog({ onCopy(text), max = 300, open = false })
 * Returns the element with: add({ t, level, text, who }), setLines(entries), toggle(open?), isOpen, text(), destroy()
 */
export function InstallLog({ onCopy, onToggle, max = 300, open = false } = {}) {
  const panelId = nextId('ilog');
  const ticker = h('span.ilog__ticker', 'Noch keine Einträge');
  const count = h('span.ilog__count', '');
  const bar = h(
    'button.ilog__bar',
    { type: 'button', attrs: { 'aria-expanded': 'false', 'aria-controls': panelId, title: 'Protokoll ein- oder ausblenden (Taste L)' } },
    h('span.ilog__icon', icon('terminal', { size: 16 })),
    h('span.ilog__label', 'Protokoll'),
    count,
    ticker,
    h('kbd.ilog__kbd', 'L'),
    h('span.ilog__chev', icon('chevron-down', { size: 16 })),
  );
  const lines = h('div.ilog__lines.selectable', { attrs: { role: 'log', 'aria-label': 'Installationsprotokoll', tabindex: '0' } });
  const copyBtn = Button({ label: 'Kopieren', icon: 'copy', variant: 'ghost', size: 'sm', magnetic: false, onClick: () => onCopy?.(api.text()) });
  const panel = h(
    'div.ilog__panel',
    { id: panelId, hidden: true },
    h('div.ilog__tools', h('span.ilog__hint', `Live-Ausgabe · letzte ${max} Zeilen`), h('span.ilog__tools-gap'), h('span.ilog__hint', 'Kopiert alles für den Support'), copyBtn),
    lines,
  );
  const el = h('div.ilog', bar, panel);

  const entries = [];
  let isOpen = false;
  let stick = true;
  let tl = null;

  const onScroll = () => {
    stick = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 24;
  };
  lines.addEventListener('scroll', onScroll, { passive: true });
  bar.addEventListener('click', () => api.toggle());

  function lineEl(e) {
    const lvl = TAGS[e.level] ? e.level : 'info';
    return h(
      `div.ilog__line.ilog__line--${lvl}`,
      h('span.ilog__time', clock(e.t)),
      h('span.ilog__tag', TAGS[lvl]),
      e.who ? h('span.ilog__who', e.who) : null,
      h('span.ilog__text', e.text),
    );
  }

  function updateCount() {
    count.textContent = entries.length ? String(entries.length) : '';
  }

  const api = {
    get isOpen() {
      return isOpen;
    },
    add(e) {
      const entry = { t: e.t instanceof Date ? e.t : new Date(), level: e.level || 'info', text: String(e.text ?? ''), who: e.who || '' };
      entries.push(entry);
      if (entries.length > max) entries.splice(0, entries.length - max);
      ticker.textContent = entry.who ? `${entry.who} · ${entry.text}` : entry.text;
      ticker.dataset.level = entry.level;
      lines.append(lineEl(entry));
      while (lines.childElementCount > max) lines.firstElementChild.remove();
      if (isOpen && stick) lines.scrollTop = lines.scrollHeight;
      updateCount();
      return el;
    },
    setLines(list) {
      entries.length = 0;
      lines.textContent = '';
      const recent = list.slice(-max);
      const frag = document.createDocumentFragment();
      for (const e of recent) {
        entries.push(e);
        frag.append(lineEl(e));
      }
      lines.append(frag);
      const last = recent[recent.length - 1];
      ticker.textContent = last ? (last.who ? `${last.who} · ${last.text}` : last.text) : 'Noch keine Einträge';
      if (last) ticker.dataset.level = last.level;
      updateCount();
      if (isOpen) lines.scrollTop = lines.scrollHeight;
      return el;
    },
    toggle(force) {
      const next = force === undefined ? !isOpen : !!force;
      if (next === isOpen) return el;
      isOpen = next;
      el.classList.toggle('is-open', isOpen);
      bar.setAttribute('aria-expanded', String(isOpen));
      tl?.kill();
      if (isOpen) {
        panel.hidden = false;
        lines.scrollTop = lines.scrollHeight;
        stick = true;
        if (motionOK()) {
          tl = gsap.fromTo(panel, { height: 0, opacity: 0 }, { height: 'auto', opacity: 1, duration: 0.42, ease: 'expo.out', clearProps: 'height,opacity', onUpdate: () => (lines.scrollTop = lines.scrollHeight) });
        }
      } else if (motionOK()) {
        tl = gsap.to(panel, { height: 0, opacity: 0, duration: 0.26, ease: 'power3.in', onComplete: () => { panel.hidden = true; gsap.set(panel, { clearProps: 'height,opacity' }); } });
      } else {
        panel.hidden = true;
      }
      onToggle?.(isOpen);
      return el;
    },
    text() {
      return entries.map((e) => `${clock(e.t)}  ${TAGS[e.level] || 'INFO'}  ${e.who ? `${e.who}: ` : ''}${e.text}`).join('\n');
    },
    destroy() {
      tl?.kill();
      lines.removeEventListener('scroll', onScroll);
      copyBtn.destroy();
    },
  };
  if (open) api.toggle(true);
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
