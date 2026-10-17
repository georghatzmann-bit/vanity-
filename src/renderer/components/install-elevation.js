// Glass banner for the one-time UAC prompt (install screen).
//   requested -> prominent, beam border, pulsing shield ("klicke auf „Ja“")
//   granted   -> turns green with a check, then collapses by itself
//   declined / failed -> orange info: Windows may ask per app instead
// Styles live in styles/screens/install.css (.elev*).
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { Button } from './button.js';
import { gsap, motionOK, richMotion, pop } from '../core/motion.js';

const COPY = {
  requested: {
    icon: 'shield',
    title: 'Windows fragt gleich nach Administratorrechten – klicke auf „Ja“',
    text: 'Einmal bestätigen reicht, danach läuft alles ohne weitere Fragen. Kein Fenster zu sehen? Schau unten in der Taskleiste nach dem blinkenden Schild.',
  },
  granted: {
    icon: 'shield-check',
    title: 'Administratorrechte erteilt',
    text: 'Danke! Ab jetzt installiert PHOENIX alles von allein.',
  },
  declined: {
    icon: 'info',
    title: 'Ohne Administratorrechte – auch okay',
    text: 'Windows fragt dann bei manchen Apps einzeln nach – bestätige jeweils mit „Ja“. Alles andere läuft wie gewohnt.',
  },
  failed: {
    icon: 'info',
    title: 'Admin-Modus nicht verfügbar',
    text: 'PHOENIX installiert trotzdem weiter. Windows fragt dann bei manchen Apps einzeln nach – bestätige jeweils mit „Ja“.',
  },
};

/**
 * ElevationBanner()
 * Returns the element with: set(status) · hide() · status · destroy()
 */
export function ElevationBanner() {
  const iconWrap = h('div.elev__icon', h('span.elev__ripple.deco'), h('span.elev__ripple.elev__ripple--2.deco'), h('span.elev__glyph'));
  const title = h('div.elev__title');
  const text = h('p.elev__text');
  const dismiss = Button({ label: 'Verstanden', variant: 'ghost', size: 'sm', magnetic: false, onClick: () => api.hide() });
  const side = h('div.elev__side', dismiss, h('span.elev__side-hint', 'Blendet den Hinweis aus'));
  const box = h('div.elev', { attrs: { role: 'status', 'aria-live': 'polite' } }, iconWrap, h('div.elev__body', title, text), side);
  const el = h('div.elev-slot', { hidden: true }, box);

  let status = null;
  let timer = 0;
  let tl = null;

  function setGlyph(name) {
    const g = iconWrap.querySelector('.elev__glyph');
    g.replaceChildren(icon(name, { size: 26, strokeWidth: 1.9 }));
    pop(g, { from: 0.6 });
  }

  function show() {
    if (!el.hidden) return;
    el.hidden = false;
    tl?.kill();
    if (motionOK()) {
      const rich = richMotion();
      tl = gsap
        .timeline()
        .fromTo(el, { height: 0, opacity: 0 }, { height: 'auto', opacity: 1, duration: 0.55, ease: 'expo.out', clearProps: 'height' })
        .fromTo(box, { y: -14, scale: 0.97, filter: rich ? 'blur(10px)' : 'none' }, { y: 0, scale: 1, filter: 'blur(0px)', duration: 0.7, ease: 'expo.out', clearProps: 'filter,transform' }, 0);
    }
  }

  const api = {
    get status() {
      return status;
    },
    set(next) {
      const copy = COPY[next];
      if (!copy) return el;
      clearTimeout(timer);
      status = next;
      box.className = `elev elev--${next}`;
      box.classList.toggle('beam', next === 'requested');
      setGlyph(copy.icon);
      title.textContent = copy.title;
      // The raw message from main goes to the log; the banner keeps its own short, consistent copy.
      text.textContent = copy.text;
      side.hidden = !(next === 'declined' || next === 'failed');
      box.setAttribute('role', next === 'requested' ? 'alert' : 'status');
      show();
      if (next === 'granted') timer = setTimeout(() => api.hide(), 1900);
      return el;
    },
    hide() {
      clearTimeout(timer);
      if (el.hidden) return el;
      tl?.kill();
      if (!motionOK()) {
        el.hidden = true;
        return el;
      }
      tl = gsap
        .timeline({ onComplete: () => { el.hidden = true; gsap.set([el, box], { clearProps: 'all' }); } })
        .to(box, { scale: 0.98, opacity: 0, filter: richMotion() ? 'blur(6px)' : 'none', duration: 0.3, ease: 'power2.in' })
        .to(el, { height: 0, marginBottom: 0, duration: 0.4, ease: 'power3.inOut' }, 0.12);
      return el;
    },
    destroy() {
      clearTimeout(timer);
      tl?.kill();
      dismiss.destroy();
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
