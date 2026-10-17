// Screen router with layered GSAP transitions.
//
//   router.register('home', homeModule)
//   router.go('select', { from: 'restore' }, { transition: 'warp' | 'fade' | 'slide' | 'zoom', direction: 'forward' | 'back' })
//   router.back()
//   router.current -> 'select'
//
// Screen module contract:
//   export default {
//     fxState: 'home' | (params) => 'scan',            // optional, forwarded to fx.setState
//     title: 'Startseite',                             // optional, aria-label of the screen
//     mount(container, ctx) { ...; return cleanup },   // may return a Promise<cleanup>
//     unmount(container) {}                            // optional
//   }
//   ctx = { api, store, router, fx, sound, toast, modal, params }
// Children marked [data-stagger] are revealed in sequence after the screen enters.

import { gsap } from 'gsap';
import { motionOK, richMotion, prepareStagger, stagger } from './motion.js';

const registry = new Map();
const live = new Set();
const history = [];
let host = null;
let baseCtx = {};
let current = null;
let navId = 0;
let beam = null;
let flash = null;

function makeRecord(name, module, params) {
  const el = document.createElement('section');
  el.className = 'screen';
  el.dataset.screen = name;
  el.tabIndex = -1;
  el.setAttribute('aria-label', module.title || name);
  el.inert = true;
  return { name, module, params, el, cleanup: null, state: 'mounting', tl: null, disposed: false };
}

function runCleanup(rec) {
  if (rec.cleanedUp || typeof rec.cleanup !== 'function') return;
  rec.cleanedUp = true;
  try {
    rec.cleanup();
  } catch (err) {
    console.error(`[router] cleanup of "${rec.name}" failed`, err);
  }
}

function dispose(rec) {
  if (rec.disposed) return;
  rec.disposed = true;
  live.delete(rec);
  rec.tl?.kill();
  gsap.killTweensOf(rec.el);
  runCleanup(rec);
  try {
    rec.module.unmount?.(rec.el);
  } catch (err) {
    console.error(`[router] unmount of "${rec.name}" failed`, err);
  }
  rec.el.remove();
}

// ---- transitions ------------------------------------------------------------------------------

function outTimeline(rec, type, direction) {
  const el = rec.el;
  const rich = richMotion();
  const tl = gsap.timeline({ onComplete: () => dispose(rec) });
  const blur = (px) => (rich ? `blur(${px}px)` : 'blur(0px)');
  switch (type) {
    case 'warp':
      tl.to(el, { opacity: 0, scale: rich ? 1.16 : 1.04, filter: blur(18), duration: 0.5, ease: 'power3.in' });
      break;
    case 'slide':
      tl.to(el, { opacity: 0, x: direction === 'back' ? 90 : -90, scale: 0.985, filter: blur(10), duration: 0.42, ease: 'power3.in' });
      break;
    case 'zoom':
      tl.to(el, { opacity: 0, scale: 0.92, filter: blur(12), duration: 0.45, ease: 'power3.in' });
      break;
    case 'fade':
      tl.to(el, { opacity: 0, duration: 0.3, ease: 'power1.out' });
      break;
    default:
      tl.set(el, { opacity: 0 });
  }
  return tl;
}

function inTimeline(rec, type, direction) {
  const el = rec.el;
  const rich = richMotion();
  const tl = gsap.timeline();
  const done = { opacity: 1, x: 0, scale: 1, filter: 'blur(0px)', clearProps: 'opacity,transform,filter' };
  switch (type) {
    case 'warp':
      tl.fromTo(el, { opacity: 0, scale: rich ? 0.86 : 0.97, filter: rich ? 'blur(16px)' : 'blur(0px)' }, { ...done, duration: 0.9, ease: 'expo.out' }, 0.2);
      if (rich && beam && flash) {
        tl.fromTo(flash, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: 'power2.out' }, 0.12).to(flash, { opacity: 0, duration: 0.7, ease: 'power2.out' }, 0.28);
        tl.fromTo(beam, { opacity: 1, xPercent: -100 }, { xPercent: 100, duration: 0.75, ease: 'power2.inOut' }, 0.08).set(beam, { opacity: 0 });
      }
      break;
    case 'slide':
      tl.fromTo(el, { opacity: 0, x: direction === 'back' ? -90 : 90, filter: rich ? 'blur(10px)' : 'blur(0px)' }, { ...done, duration: 0.75, ease: 'expo.out' }, 0.14);
      break;
    case 'zoom':
      tl.fromTo(el, { opacity: 0, scale: 1.07, filter: rich ? 'blur(12px)' : 'blur(0px)' }, { ...done, duration: 0.8, ease: 'expo.out' }, 0.16);
      break;
    case 'fade':
      tl.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: 'power1.out', clearProps: 'opacity' }, 0.08);
      break;
    default:
      tl.set(el, { clearProps: 'opacity,transform,filter' });
      return tl;
  }
  const kids = stagger(el, { each: type === 'fade' ? 0.04 : 0.06 });
  if (kids) tl.add(kids, type === 'warp' ? 0.34 : 0.22);
  return tl;
}

function renderMountError(el, name, err) {
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'screen__inner center';
  wrap.innerHTML = `<div class="card" style="max-width:520px;text-align:center">
    <div class="t-eyebrow" style="color:var(--err)">Fehler</div>
    <h2 class="t-h2 mt-2">Dieser Bereich konnte nicht geladen werden</h2>
    <p class="hint mt-2"></p>
    <button class="btn btn--secondary mt-5" type="button"><span class="btn__inner">Zur Startseite</span></button>
  </div>`;
  wrap.querySelector('.hint').textContent = `${name}: ${(err && err.message) || err}`;
  wrap.querySelector('button').addEventListener('click', () => router.go('home', {}, { transition: 'fade' }));
  el.append(wrap);
}

// ---- public API -------------------------------------------------------------------------------

export const router = {
  /** container: the #app element; ctx: { api, store, fx, sound, toast, modal } */
  init({ container, ctx }) {
    host = container;
    baseCtx = { ...ctx };
    beam = document.createElement('div');
    beam.className = 'route-beam';
    flash = document.createElement('div');
    flash.className = 'route-flash';
    host.append(flash, beam);
    return router;
  },

  register(name, module) {
    registry.set(name, module && module.default ? module.default : module);
    return router;
  },

  has(name) {
    return registry.has(name);
  },

  get current() {
    return current ? current.name : null;
  },

  get params() {
    return current ? current.params : null;
  },

  /** Navigates; safe to call rapidly – the latest call wins. Resolves true when the screen entered. */
  async go(name, params = {}, { transition = 'warp', direction = 'forward', replace = false } = {}) {
    const module = registry.get(name);
    if (!module || typeof module.mount !== 'function') {
      console.error(`[router] unknown screen "${name}"`);
      return false;
    }
    if (!host) throw new Error('router.init() must run before router.go()');
    const id = ++navId;
    const type = motionOK() ? transition : 'none';

    // Screens that were only passed through (still mounting, or superseded within 350 ms) are not recorded.
    const settled = current && (current.state === 'active' || (current.enteredAt > 0 && performance.now() - current.enteredAt > 350));
    if (current && !replace && settled) history.push({ name: current.name, params: current.params });
    if (history.length > 30) history.shift();

    const hadFocusInside = current && current.el.contains(document.activeElement);

    // Retire everything on screen. Screens already leaving are fast-forwarded.
    for (const rec of [...live]) {
      if (rec.state === 'leaving') {
        rec.tl ? rec.tl.progress(1) : dispose(rec);
        continue;
      }
      rec.state = 'leaving';
      rec.el.inert = true;
      rec.el.setAttribute('aria-hidden', 'true');
      rec.el.style.zIndex = '1';
      rec.tl?.kill();
      rec.tl = outTimeline(rec, type, direction);
    }

    if (type !== 'none') {
      baseCtx.fx?.pulse?.(type === 'warp' ? 1 : 0.6);
      if (type !== 'fade') baseCtx.sound?.play?.('whoosh');
    }

    const rec = makeRecord(name, module, params);
    rec.el.style.zIndex = '2';
    live.add(rec);
    current = rec;
    gsap.set(rec.el, { opacity: 0 });
    host.insertBefore(rec.el, flash);

    const ctx = { ...baseCtx, router, params };
    try {
      const res = module.mount(rec.el, ctx);
      rec.cleanup = res && typeof res.then === 'function' ? await res : res;
    } catch (err) {
      console.error(`[router] mount of "${name}" failed`, err);
      renderMountError(rec.el, name, err);
    }

    if (id !== navId || rec.disposed) {
      // Superseded while mounting: dispose now, or run the cleanup that arrived after disposal.
      if (rec.disposed) runCleanup(rec);
      else dispose(rec);
      return false;
    }

    const fxState = typeof module.fxState === 'function' ? module.fxState(params) : module.fxState;
    if (fxState) baseCtx.fx?.setState?.(fxState);

    rec.state = 'entering';
    rec.enteredAt = performance.now();
    rec.el.inert = false;
    prepareStagger(rec.el);
    rec.tl = inTimeline(rec, type, direction);
    rec.tl.eventCallback('onComplete', () => {
      if (rec.state === 'entering') rec.state = 'active';
      rec.el.style.zIndex = '';
    });

    if (hadFocusInside || document.activeElement === document.body) rec.el.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent('phoenix:route', { detail: { name, params } }));
    return true;
  },

  /** Goes to the previous screen (slide back), or home. */
  back(fallback = 'home') {
    const prev = history.pop();
    return router.go(prev ? prev.name : fallback, prev ? prev.params : {}, { transition: 'slide', direction: 'back', replace: true });
  },

  /** Clears the back stack (e.g. after finishing a flow). */
  resetHistory() {
    history.length = 0;
  },
};
