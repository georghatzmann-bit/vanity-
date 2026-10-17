// "Reactor" progress hero for the install screen: rotating tick ring, one segment per app that lights
// up with its result, a glowing main arc with a white-hot tip, a breathing plasma core and a big
// center readout. Styles live in styles/screens/install.css (.rx*).
import { h, svg, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { gsap, motionOK, richMotion } from '../core/motion.js';
import { formatNumber } from '../core/format.js';

const VB = 400;
const C = VB / 2;
const R_TICK = 188;
const R_SEG = 171;
const R_MAIN = 147;
const R_INNER = 126;
const CIRC_MAIN = 2 * Math.PI * R_MAIN;
const CIRC_SEG = 2 * Math.PI * R_SEG;

const SEG_STATES = ['pending', 'active', 'requeued', 'installed', 'already', 'failed', 'skipped', 'cancelled'];

/**
 * InstallReactor({ total })
 * Returns the element with:
 *   setTotal(n) · setSegment(i, state) · setValue(0..1, { animate }) · setCount(done, total)
 *   setEta(text) · setMode('wait' | 'run' | 'done' | 'error') · shock(tone) · finale({ tone, label, sub }) · destroy()
 */
export function InstallReactor({ total = 0 } = {}) {
  const id = nextId('rx');
  const tickGap = (2 * Math.PI * R_TICK) / 96;

  const graphic = svg(`<svg class="rx__svg" viewBox="0 0 ${VB} ${VB}" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${id}g" x1="40" y1="0" x2="360" y2="400" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#5b21b6"/>
        <stop offset=".5" stop-color="#8b5cf6"/>
        <stop offset=".85" stop-color="#c4b5fd"/>
        <stop offset="1" stop-color="#ffffff"/>
      </linearGradient>
    </defs>
    <g class="rx__ticks-g deco"><circle class="rx__ticks" cx="${C}" cy="${C}" r="${R_TICK}" fill="none" stroke-width="5" stroke-dasharray="1.1 ${(tickGap - 1.1).toFixed(3)}"/></g>
    <g class="rx__orbit deco">
      <circle cx="${C}" cy="${C}" r="${R_TICK}" fill="none" stroke-width="2" stroke-dasharray="46 ${(2 * Math.PI * R_TICK - 46).toFixed(2)}"/>
      <circle cx="${C}" cy="${C}" r="${R_TICK}" fill="none" stroke-width="2" stroke-dasharray="18 ${(2 * Math.PI * R_TICK - 18).toFixed(2)}" stroke-dashoffset="-${(Math.PI * R_TICK).toFixed(2)}"/>
    </g>
    <g class="rx__segs" transform="rotate(-90 ${C} ${C})"></g>
    <circle class="rx__track" cx="${C}" cy="${C}" r="${R_MAIN}" fill="none" stroke-width="12"/>
    <g class="rx__spin"><g transform="rotate(-90 ${C} ${C})">
      <circle class="rx__bar" cx="${C}" cy="${C}" r="${R_MAIN}" fill="none" stroke="url(#${id}g)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${CIRC_MAIN.toFixed(2)}" stroke-dashoffset="${CIRC_MAIN.toFixed(2)}"/>
    </g></g>
    <circle class="rx__tip" cx="${C}" cy="${C - R_MAIN}" r="5.5"/>
    <g class="rx__inner-g deco"><circle class="rx__inner" cx="${C}" cy="${C}" r="${R_INNER}" fill="none" stroke-width="1.5" stroke-dasharray="2 7"/></g>
  </svg>`);
  const segsG = graphic.querySelector('.rx__segs');
  const bar = graphic.querySelector('.rx__bar');
  const tip = graphic.querySelector('.rx__tip');

  const num = h('span.rx__num', '0');
  const valueEl = h('div.rx__value', num, h('span.rx__unit', '%'));
  const countEl = h('div.rx__count', '');
  const etaEl = h('div.rx__eta', '');
  const center = h('div.rx__center', valueEl, countEl, etaEl);
  const shocks = h('div.rx__shocks', { attrs: { 'aria-hidden': 'true' } });

  const el = h(
    'div.rx.is-waiting',
    { attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Gesamtfortschritt' } },
    h('div.rx__halo.deco', { attrs: { 'aria-hidden': 'true' } }),
    h('div.rx__core', { attrs: { 'aria-hidden': 'true' } }, h('div.rx__plasma.deco'), h('div.rx__core-in')),
    graphic,
    shocks,
    center,
  );

  const state = { v: 0, shown: -1 };
  let tween = null;
  let segEls = [];
  const live = new Set();

  function render(v) {
    bar.style.strokeDashoffset = String(CIRC_MAIN * (1 - v));
    const a = v * Math.PI * 2 - Math.PI / 2;
    tip.setAttribute('cx', (C + R_MAIN * Math.cos(a)).toFixed(2));
    tip.setAttribute('cy', (C + R_MAIN * Math.sin(a)).toFixed(2));
    tip.style.opacity = v > 0.003 && v < 0.999 ? '1' : '0';
    el.style.setProperty('--p', v.toFixed(4));
    const pct = Math.floor(v * 100 + 1e-6);
    if (pct !== state.shown) {
      state.shown = pct;
      num.textContent = formatNumber(pct);
    }
  }

  function track(t) {
    if (!t) return t;
    live.add(t);
    // then() resolves on completion without replacing the tween's own onComplete.
    t.then?.(() => live.delete(t));
    return t;
  }

  const api = {
    get value() {
      return state.v;
    },
    setTotal(n) {
      const count = Math.max(0, n | 0);
      segsG.textContent = '';
      segEls = [];
      if (!count) return el;
      const seg = CIRC_SEG / count;
      const gap = Math.min(seg * 0.32, 7);
      const len = Math.max(0.8, seg - gap);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < count; i++) {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        s.setAttribute('class', 'rx__seg');
        s.setAttribute('cx', C);
        s.setAttribute('cy', C);
        s.setAttribute('r', R_SEG);
        s.setAttribute('fill', 'none');
        s.setAttribute('stroke-width', count > 60 ? '5' : '7');
        s.setAttribute('stroke-dasharray', `${len.toFixed(2)} ${(CIRC_SEG - len).toFixed(2)}`);
        s.setAttribute('stroke-dashoffset', (-(i * seg + gap / 2)).toFixed(2));
        s.dataset.s = 'pending';
        frag.append(s);
        segEls.push(s);
      }
      segsG.append(frag);
      return el;
    },
    setSegment(i, st) {
      const s = segEls[i];
      if (!s || !SEG_STATES.includes(st) || s.dataset.s === st) return el;
      s.dataset.s = st;
      if (richMotion() && st !== 'pending' && st !== 'active') {
        track(gsap.fromTo(s, { opacity: 0.2 }, { opacity: 1, duration: 0.6, ease: 'power2.out', clearProps: 'opacity' }));
      }
      return el;
    },
    setValue(v, { animate = true } = {}) {
      const target = Math.min(1, Math.max(0, Number(v) || 0));
      el.setAttribute('aria-valuenow', String(Math.floor(target * 100)));
      tween?.kill();
      if (animate && motionOK()) {
        tween = gsap.to(state, { v: target, duration: 0.7, ease: 'power3.out', onUpdate: () => render(state.v) });
      } else {
        state.v = target;
        render(target);
      }
      return el;
    },
    setCount(done, all) {
      countEl.textContent = all ? `${formatNumber(done)} von ${formatNumber(all)} fertig` : '';
      return el;
    },
    setEta(text) {
      etaEl.textContent = text || '';
      return el;
    },
    setMode(mode) {
      el.classList.toggle('is-waiting', mode === 'wait');
      el.classList.toggle('is-done', mode === 'done');
      el.classList.toggle('is-error', mode === 'error');
      if (mode !== 'wait') render(state.v);
      return el;
    },
    /** Expanding ring from the core (item finished). tone: 'ok' | 'err' | 'accent' | 'muted' */
    shock(tone = 'accent', { delay = 0, scale = 1.32 } = {}) {
      if (!richMotion()) return el;
      const ring = h(`div.rx__shock.rx__shock--${tone}`);
      shocks.append(ring);
      track(
        gsap.fromTo(
          ring,
          { scale: 0.82, opacity: 0.95 },
          { scale, opacity: 0, duration: 1.1, delay, ease: 'expo.out', onComplete: () => ring.remove() },
        ),
      );
      return el;
    },
    /** Big finish: arc completes, core flares, three shock waves, center turns into a mark. */
    finale({ tone = 'ok', label = 'Fertig', sub = '' } = {}) {
      api.setMode(tone === 'err' ? 'error' : 'done');
      api.setValue(1, { animate: true });
      const mark = h('div.rx__mark', icon(tone === 'err' ? 'x' : tone === 'warn' ? 'alert' : 'check', { size: 64, strokeWidth: 2.25 }));
      const lab = h('div.rx__count', label);
      const subEl = h('div.rx__eta', sub);
      const swap = () => center.replaceChildren(mark, lab, subEl);
      if (!motionOK()) {
        swap();
        return el;
      }
      const tl = gsap.timeline();
      tl.to(center, { scale: 0.7, opacity: 0, filter: 'blur(8px)', duration: 0.28, ease: 'power2.in', onComplete: swap })
        .fromTo(center, { scale: 1.25, opacity: 0, filter: 'blur(10px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 0.9, ease: 'elastic.out(1, 0.55)', clearProps: 'filter,transform' });
      if (richMotion()) {
        const core = el.querySelector('.rx__core');
        tl.fromTo(core, { scale: 1 }, { scale: 1.22, duration: 0.18, ease: 'power2.out', yoyo: true, repeat: 1 }, 0.1);
        tl.fromTo(el, { '--flare': 0 }, { '--flare': 1, duration: 0.25, ease: 'power2.out', yoyo: true, repeat: 1 }, 0.12);
        api.shock(tone === 'err' ? 'err' : 'accent', { delay: 0.12, scale: 1.5 });
        api.shock(tone === 'err' ? 'err' : 'ok', { delay: 0.32, scale: 1.75 });
        api.shock('accent', { delay: 0.55, scale: 2.1 });
        if (segEls.length) {
          tl.fromTo(segEls, { opacity: 0.25 }, { opacity: 1, duration: 0.5, stagger: { each: Math.min(0.03, 0.9 / segEls.length) }, ease: 'power2.out', clearProps: 'opacity' }, 0.15);
        }
      }
      track(tl);
      return el;
    },
    destroy() {
      tween?.kill();
      for (const t of live) t.kill();
      live.clear();
    },
  };

  render(0);
  if (total) api.setTotal(total);
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
