// Backup scanner: radar sweep, converging beams, tick rings and a glowing core with a live
// "Apps erkannt" counter. Also hosts the "icons spiral into the vault" sequence after the scan.
//
//   const sc = BackupScanner()
//   sc.setState('scanning' | 'done' | 'error')
//   sc.setProgress(0..1) · sc.setFound(n) · sc.bump() · sc.lock()
//   await sc.absorb(nodes)   // spiral nodes into the core (rich motion only), returns a timeline
//   sc.destroy()
import { h, svg, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { gsap, motionOK, richMotion } from '../core/motion.js';

const nf = new Intl.NumberFormat('de-DE');
const ARC_R = 168;
const ARC_C = 2 * Math.PI * ARC_R;
const MAX_BLIPS = 38;

function tickPath(count, rIn, rLong, rOut, every = 10) {
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r1 = i % every === 0 ? rLong : rIn;
    const c = Math.cos(a);
    const s = Math.sin(a);
    d += `M${(200 + c * r1).toFixed(2)} ${(200 + s * r1).toFixed(2)}L${(200 + c * rOut).toFixed(2)} ${(200 + s * rOut).toFixed(2)}`;
  }
  return d;
}

export function BackupScanner({ label = 'Apps erkannt' } = {}) {
  const gid = nextId('bks');

  const base = svg(`<svg class="bks__svg" viewBox="0 0 400 400" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${gid}-arc" x1="0" y1="0" x2="400" y2="400" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#EDE9FE"/><stop offset=".5" stop-color="#A78BFA"/><stop offset="1" stop-color="#7C3AED"/>
      </linearGradient>
      <radialGradient id="${gid}-fade" cx="200" cy="200" r="200" gradientUnits="userSpaceOnUse">
        <stop offset=".55" stop-color="#A78BFA" stop-opacity="0"/><stop offset="1" stop-color="#A78BFA" stop-opacity=".12"/>
      </radialGradient>
    </defs>
    <circle cx="200" cy="200" r="198" fill="url(#${gid}-fade)"/>
    <circle class="bks__ring bks__ring--outer" cx="200" cy="200" r="197"/>
    <circle class="bks__arc-track" cx="200" cy="200" r="${ARC_R}"/>
    <circle class="bks__arc" cx="200" cy="200" r="${ARC_R}" stroke="url(#${gid}-arc)" stroke-dasharray="${ARC_C.toFixed(2)}" stroke-dashoffset="${ARC_C.toFixed(2)}"/>
    <circle class="bks__ring bks__ring--inner" cx="200" cy="200" r="122"/>
    <path class="bks__cross" d="M200 20V62M200 338V380M20 200H62M338 200H380"/>
  </svg>`);
  const arc = base.querySelector('.bks__arc');

  const ticks = h(
    'div.bks__layer.bks__ticks.deco',
    svg(`<svg viewBox="0 0 400 400" aria-hidden="true" focusable="false"><path d="${tickPath(120, 182, 176, 189)}"/></svg>`),
  );
  const dashes = h(
    'div.bks__layer.bks__dashes.deco',
    svg(`<svg viewBox="0 0 400 400" aria-hidden="true" focusable="false"><circle cx="200" cy="200" r="146"/><circle class="bks__dashes-fine" cx="200" cy="200" r="138"/></svg>`),
  );

  const sweep = h('div.bks__sweep.deco');
  const beams = h(
    'div.bks__beams',
    Array.from({ length: 8 }, (_, i) =>
      h('span.bks__beam.deco', { style: { '--a': `${22.5 + i * 45}deg`, '--d': `${(i * 0.37) % 1.9}s` } }),
    ),
  );
  const blips = h('div.bks__blips');

  const countEl = h('span.bks__count.t-num', '0');
  const labelEl = h('span.bks__label', label);
  const glyph = h('span.bks__glyph', icon('shield-check', { size: 22, strokeWidth: 1.9 }));
  const core = h(
    'div.bks__core',
    h('span.bks__core-shine'),
    h('div.bks__core-inner', glyph, countEl, labelEl),
  );
  const shock = h('span.bks__shock');
  const flyLayer = h('div.bks__fly');

  const el = h(
    'div.bks',
    { dataset: { state: 'idle' }, attrs: { role: 'img', 'aria-label': 'Scanner' } },
    h('div.bks__glow'),
    base,
    dashes,
    ticks,
    sweep,
    beams,
    blips,
    core,
    shock,
    flyLayer,
  );

  let found = 0;
  const counter = { v: 0 };
  let progress = 0;
  const tweens = new Set();
  const track = (t) => {
    if (t) {
      tweens.add(t);
      t.eventCallback?.('onComplete', () => tweens.delete(t));
    }
    return t;
  };

  function renderCount() {
    countEl.textContent = nf.format(Math.round(counter.v));
  }

  function addBlip() {
    const a = Math.random() * Math.PI * 2;
    const r = 0.3 + Math.random() * 0.15; // fraction of size, outside the core
    const x = 50 + Math.cos(a) * r * 100;
    const y = 50 + Math.sin(a) * r * 100;
    const b = h('span.bks__blip', { style: { left: `${x}%`, top: `${y}%` } });
    blips.append(b);
    while (blips.childElementCount > MAX_BLIPS) blips.firstElementChild.remove();
    if (motionOK()) {
      track(gsap.fromTo(b, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(3)', delay: Math.random() * 0.4 }));
    }
  }

  const api = {
    get found() {
      return found;
    },
    setState(state) {
      el.dataset.state = state;
      el.setAttribute('aria-label', state === 'error' ? 'Scanner: Fehler' : state === 'done' ? 'Scanner: fertig' : 'Scanner läuft');
      return el;
    },
    setLabel(text) {
      labelEl.textContent = text;
      return el;
    },
    setProgress(p) {
      const v = Math.min(1, Math.max(0, Number(p) || 0));
      if (v === progress) return el;
      progress = v;
      const off = ARC_C * (1 - v);
      if (!motionOK()) arc.setAttribute('stroke-dashoffset', off.toFixed(2));
      else track(gsap.to(arc, { attr: { 'stroke-dashoffset': off }, duration: 0.8, ease: 'power3.out', overwrite: 'auto' }));
      return el;
    },
    setFound(n) {
      const next = Math.max(0, Math.round(Number(n) || 0));
      if (next === found) return el;
      const delta = next - found;
      found = next;
      if (!motionOK()) {
        counter.v = next;
        renderCount();
      } else {
        track(gsap.to(counter, { v: next, duration: Math.min(1.4, 0.5 + Math.abs(delta) * 0.04), ease: 'power2.out', onUpdate: renderCount, overwrite: 'auto' }));
        if (delta > 0) api.bump(0.6);
      }
      for (let i = 0; i < Math.min(delta, 8); i++) addBlip();
      return el;
    },
    /** Small heartbeat of the core (absorbed icon, new findings). */
    bump(strength = 1) {
      if (!motionOK()) return;
      track(
        gsap.fromTo(core, { scale: 1 + 0.06 * strength }, { scale: 1, duration: 0.45, ease: 'elastic.out(1.1, 0.5)', overwrite: 'auto' }),
      );
    },
    /** Final lock: flash, shock ring and the shield glyph. */
    lock() {
      el.classList.add('is-locked');
      if (!motionOK()) return;
      track(gsap.fromTo(shock, { scale: 0.45, opacity: 0.95 }, { scale: 1.9, opacity: 0, duration: 1.1, ease: 'expo.out' }));
      track(gsap.fromTo(core, { scale: 1.16 }, { scale: 1, duration: 1, ease: 'elastic.out(1, 0.4)' }));
      track(gsap.fromTo(glyph, { scale: 0.2, rotate: -40, opacity: 0 }, { scale: 1, rotate: 0, opacity: 1, duration: 0.8, ease: 'back.out(3)' }));
    },
    /**
     * Spirals the given nodes (icon tiles) into the core. Rich motion only; returns the timeline
     * (thenable) or null. Each arrival bumps the core.
     */
    absorb(nodes = []) {
      if (!richMotion() || !nodes.length) return null;
      const size = el.offsetWidth || 400;
      const tl = gsap.timeline();
      const n = nodes.length;
      const each = Math.min(0.045, 1.1 / n);
      nodes.forEach((node, i) => {
        const a = (i / n) * 360 + gsap.utils.random(-14, 14);
        const r = size * gsap.utils.random(0.62, 0.82);
        const tile = h('div.bks__fly-tile', node);
        const arm = h('div.bks__fly-arm', tile);
        flyLayer.append(arm);
        gsap.set(arm, { rotation: a - 30 });
        gsap.set(tile, { x: r, rotation: -(a - 30), scale: 0, opacity: 0, xPercent: -50, yPercent: -50 });
        const spin = gsap.utils.random(120, 190);
        const t0 = i * 0.012;
        const t1 = 0.55 + i * each;
        tl.to(arm, { rotation: a, duration: 0.7, ease: 'power2.out' }, t0)
          .to(tile, { rotation: -a, scale: 1, opacity: 1, duration: 0.55, ease: 'back.out(2.2)' }, t0)
          .to(arm, { rotation: a + spin, duration: 0.8, ease: 'power2.in' }, t1)
          .to(tile, { x: 0, rotation: -(a + spin), scale: 0.18, duration: 0.8, ease: 'power3.in' }, t1)
          .to(tile, { opacity: 0, duration: 0.12, ease: 'none' }, t1 + 0.68)
          .call(() => api.bump(0.5), null, t1 + 0.78);
      });
      tl.call(() => flyLayer.replaceChildren());
      return track(tl);
    },
    reset() {
      found = 0;
      counter.v = 0;
      renderCount();
      progress = -1;
      api.setProgress(0);
      blips.replaceChildren();
      flyLayer.replaceChildren();
      el.classList.remove('is-locked');
      return el;
    },
    destroy() {
      for (const t of tweens) t.kill();
      tweens.clear();
      gsap.killTweensOf([core, glyph, shock, arc, counter]);
    },
  };
  return Object.defineProperties(el, Object.getOwnPropertyDescriptors(api));
}
