// Motion helpers on top of GSAP. Every helper degrades to an instant state change when the
// user prefers reduced motion or effects are set to "off".
import { gsap } from 'gsap';
import { store } from './store.js';

const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

export const prefersReducedMotion = () => !!reducedMq.matches;
/** Calls fn(reduced) whenever the OS "reduce motion" setting flips. Returns an unsubscribe. */
export function onReducedMotionChange(fn) {
  if (typeof reducedMq.addEventListener !== 'function') return () => {};
  const handler = () => fn(!!reducedMq.matches);
  reducedMq.addEventListener('change', handler);
  return () => reducedMq.removeEventListener('change', handler);
}
export const effectsLevel = () => store.get('settings')?.effects || 'ultra';
/** Any motion at all (fades, small slides). */
export const motionOK = () => !prefersReducedMotion() && effectsLevel() !== 'off';
/** Rich, decorative motion (magnetic, tilt, scramble, kinetic type). */
export const richMotion = () => motionOK() && effectsLevel() !== 'low';

const finePointer = typeof matchMedia === 'function' ? matchMedia('(pointer: fine)') : { matches: true };

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789#%&*+=<>/\\|{}[]?!$§';
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Decode effect: random glyphs resolve left-to-right into `finalText`.
 * @returns {{ cancel(): void, finished: Promise<void> }}
 */
export function scrambleText(el, finalText, { duration = 0.9, delay = 0, glyphs = GLYPHS, onComplete } = {}) {
  const text = String(finalText ?? '');
  if (!richMotion() || !el) {
    if (el) el.textContent = text;
    onComplete?.();
    return { cancel() {}, finished: Promise.resolve() };
  }
  const len = text.length;
  const reveal = Array.from({ length: len }, (_, i) => delay + (i / Math.max(1, len)) * duration * 0.7 + Math.random() * duration * 0.3);
  const current = Array.from({ length: len }, () => glyphs[(Math.random() * glyphs.length) | 0]);
  const start = performance.now();
  let lastSwap = 0;
  let raf = 0;
  let done;
  const finished = new Promise((r) => (done = r));

  const frame = (now) => {
    const t = (now - start) / 1000;
    const swap = now - lastSwap > 45;
    if (swap) lastSwap = now;
    let html = '';
    let pending = 0;
    for (let i = 0; i < len; i++) {
      const ch = text[i];
      if (t >= reveal[i] || ch === ' ' || ch === ' ') {
        html += escapeHtml(ch);
      } else {
        if (swap) current[i] = glyphs[(Math.random() * glyphs.length) | 0];
        html += `<span class="scramble-glyph">${escapeHtml(current[i])}</span>`;
        pending++;
      }
    }
    el.innerHTML = html;
    if (pending) raf = requestAnimationFrame(frame);
    else {
      el.textContent = text;
      onComplete?.();
      done();
    }
  };
  raf = requestAnimationFrame(frame);
  return {
    cancel() {
      cancelAnimationFrame(raf);
      el.textContent = text;
      done();
    },
    finished,
  };
}

/** Animated number. format defaults to German integer formatting. Returns the tween (or null). */
export function countUp(el, to, { from = 0, duration = 1.2, delay = 0, ease = 'power3.out', format } = {}) {
  const fmt = format || ((v) => new Intl.NumberFormat('de-DE').format(Math.round(v)));
  if (!el) return null;
  if (!motionOK()) {
    el.textContent = fmt(to);
    return null;
  }
  const obj = { v: from };
  el.textContent = fmt(from);
  return gsap.to(obj, { v: to, duration, delay, ease, onUpdate: () => (el.textContent = fmt(obj.v)) });
}

/**
 * Splits text into .word > .char spans (keeps words unbreakable). Returns the char spans.
 * Re-splitting restores the original text first.
 */
export function splitChars(el) {
  const text = el.dataset.splitText ?? el.textContent;
  el.dataset.splitText = text;
  el.textContent = '';
  el.setAttribute('aria-label', text);
  const chars = [];
  text.split(/(\s+)/).forEach((part) => {
    if (!part) return;
    if (/^\s+$/.test(part)) {
      el.append(document.createTextNode(' '));
      return;
    }
    const word = document.createElement('span');
    word.className = 'split-word';
    word.setAttribute('aria-hidden', 'true');
    for (const ch of part) {
      const c = document.createElement('span');
      c.className = 'split-char';
      c.textContent = ch;
      word.append(c);
      chars.push(c);
    }
    el.append(word);
  });
  return chars;
}

/** Restores text split by splitChars(). */
export function unsplit(el) {
  if (!el || el.dataset.splitText === undefined) return;
  el.textContent = el.dataset.splitText;
  delete el.dataset.splitText;
  el.classList.remove('is-split');
}

/**
 * Kinetic headline: characters rise with blur + 3D tilt.
 * Gradient text (background-clip: text, e.g. .t-grad) is revealed as one line instead – a wipe with
 * tracking tightening – because per-character clipped backgrounds break under 3D transforms.
 * Returns the timeline (or null).
 */
export function revealText(el, { delay = 0, stagger = 0.022, duration = 0.9, y = 105, blur = 10 } = {}) {
  if (!el) return null;
  if (!richMotion()) {
    if (motionOK()) return gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.4, delay });
    return null;
  }
  const cs = getComputedStyle(el);
  if (/text/.test(cs.webkitBackgroundClip || cs.backgroundClip || '')) {
    const tracking = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    el.classList.add('is-revealing');
    return gsap.fromTo(
      el,
      { opacity: 0, x: -24, letterSpacing: '0.12em', filter: `blur(${blur + 6}px)`, clipPath: 'inset(-30% 100% -40% -5%)' },
      {
        opacity: 1,
        x: 0,
        letterSpacing: tracking,
        filter: 'blur(0px)',
        clipPath: 'inset(-30% -5% -40% -5%)',
        duration: duration + 0.35,
        delay,
        ease: 'expo.out',
        clearProps: 'filter,clipPath,letterSpacing,transform',
        onComplete: () => el.classList.remove('is-revealing'),
      },
    );
  }
  const chars = splitChars(el);
  el.classList.add('is-split');
  return gsap
    .timeline({ delay })
    .fromTo(
      chars,
      { yPercent: y, rotateX: -70, opacity: 0, filter: `blur(${blur}px)` },
      { yPercent: 0, rotateX: 0, opacity: 1, filter: 'blur(0px)', duration, ease: 'expo.out', stagger, clearProps: 'filter,transform' },
    );
}

// ---------------------------------------------------------------------------------------------
// Entrances
// ---------------------------------------------------------------------------------------------

/**
 * Staggers children marked [data-stagger] in. data-stagger="2" adds an extra delay step.
 * Returns the timeline (or null when motion is off – elements are just shown).
 */
export function stagger(container, { selector = '[data-stagger]', y = 26, blur = 8, scale = 0.985, duration = 0.85, each = 0.06, delay = 0 } = {}) {
  const els = container ? Array.from(container.querySelectorAll(selector)) : [];
  if (!els.length) return null;
  if (!motionOK()) {
    gsap.set(els, { clearProps: 'opacity,transform,filter,visibility' });
    return null;
  }
  const rich = richMotion();
  return gsap.timeline({ delay }).fromTo(
    els,
    { opacity: 0, y, scale: rich ? scale : 1, filter: rich ? `blur(${blur}px)` : 'none' },
    { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)', duration: rich ? duration : 0.45, ease: 'expo.out', stagger: each, clearProps: 'filter,transform' },
  );
}

/** Hides [data-stagger] children before a route transition reveals them (prevents a flash). */
export function prepareStagger(container, selector = '[data-stagger]') {
  if (!motionOK() || !container) return;
  gsap.set(container.querySelectorAll(selector), { opacity: 0 });
}

// ---------------------------------------------------------------------------------------------
// Pointer interactions
// ---------------------------------------------------------------------------------------------

/**
 * Element drifts toward the cursor while hovered and springs back on leave.
 * `inner` (selector or element) moves a bit further for a parallax feel.
 * @returns cleanup()
 */
export function magnetic(el, { strength = 0.32, inner = null, innerStrength = 0.16, max = 10 } = {}) {
  if (!el || !finePointer.matches) return () => {};
  const innerEl = typeof inner === 'string' ? el.querySelector(inner) : inner;
  const xTo = gsap.quickTo(el, 'x', { duration: 0.55, ease: 'power3.out' });
  const yTo = gsap.quickTo(el, 'y', { duration: 0.55, ease: 'power3.out' });
  const ixTo = innerEl ? gsap.quickTo(innerEl, 'x', { duration: 0.6, ease: 'power3.out' }) : null;
  const iyTo = innerEl ? gsap.quickTo(innerEl, 'y', { duration: 0.6, ease: 'power3.out' }) : null;
  const clamp = gsap.utils.clamp(-max, max);

  const move = (e) => {
    if (!richMotion()) return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    xTo(clamp(dx * strength));
    yTo(clamp(dy * strength));
    ixTo?.(clamp(dx * innerStrength) * 0.6);
    iyTo?.(clamp(dy * innerStrength) * 0.6);
  };
  const leave = () => {
    gsap.to(el, { x: 0, y: 0, duration: 0.9, ease: 'elastic.out(1, 0.35)', overwrite: 'auto' });
    if (innerEl) gsap.to(innerEl, { x: 0, y: 0, duration: 0.9, ease: 'elastic.out(1, 0.35)', overwrite: 'auto' });
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', leave);
  return () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerleave', leave);
    gsap.killTweensOf(el, 'x,y');
    gsap.set(el, { x: 0, y: 0 });
  };
}

/**
 * 3D tilt with cursor-following specular highlight and holographic sheen.
 * Injects .tilt-glare / .tilt-sheen layers and drives --mx/--my/--sx/--sy/--tilt-o.
 * @returns cleanup()
 */
export function tilt(el, { max = 7, perspective = 1000, scale = 1.012, glare = true } = {}) {
  if (!el || !finePointer.matches) return () => {};
  const layers = [];
  if (glare) {
    for (const cls of ['tilt-glare', 'tilt-sheen']) {
      if (!el.querySelector(`:scope > .${cls}`)) {
        const s = document.createElement('span');
        s.className = cls;
        s.setAttribute('aria-hidden', 'true');
        el.append(s);
        layers.push(s);
      }
    }
  }
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  gsap.set(el, { transformPerspective: perspective });
  const rx = gsap.quickTo(el, 'rotationX', { duration: 0.5, ease: 'power3.out' });
  const ry = gsap.quickTo(el, 'rotationY', { duration: 0.5, ease: 'power3.out' });
  const sx = gsap.quickTo(el, 'scaleX', { duration: 0.5, ease: 'power3.out' });
  const sy = gsap.quickTo(el, 'scaleY', { duration: 0.5, ease: 'power3.out' });
  const sc = (v) => {
    sx(v);
    sy(v);
  };

  const move = (e) => {
    if (!richMotion()) return;
    const r = el.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    ry((px - 0.5) * 2 * max);
    rx(-(py - 0.5) * 2 * max);
    sc(scale);
    el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    el.style.setProperty('--sx', `${(100 - px * 100).toFixed(1)}%`);
    el.style.setProperty('--sy', `${(100 - py * 100).toFixed(1)}%`);
    el.style.setProperty('--tilt-o', '1');
  };
  const leave = () => {
    rx(0);
    ry(0);
    sc(1);
    el.style.setProperty('--tilt-o', '0');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', leave);
  return () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerleave', leave);
    layers.forEach((l) => l.remove());
    gsap.killTweensOf(el, 'rotationX,rotationY,scaleX,scaleY');
    gsap.set(el, { rotationX: 0, rotationY: 0, scale: 1 });
  };
}

/** Press feedback: squish on pointerdown, spring back on release. @returns cleanup() */
export function pressable(el, { scale = 0.965 } = {}) {
  if (!el) return () => {};
  const down = (e) => {
    if (e.button !== 0 || !motionOK() || el.disabled) return;
    gsap.to(el, { scale, duration: 0.12, ease: 'power2.out', overwrite: 'auto' });
  };
  const up = () => {
    if (!motionOK()) return;
    gsap.to(el, { scale: 1, duration: 0.7, ease: 'elastic.out(1.1, 0.4)', overwrite: 'auto' });
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointerleave', up);
  };
}

/** Material-style light ripple from the pointer position. Host should clip (overflow hidden). */
export function ripple(host, event, { color } = {}) {
  if (!host || !motionOK()) return;
  const r = host.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.4;
  const x = event && event.clientX ? event.clientX - r.left : r.width / 2;
  const y = event && event.clientY ? event.clientY - r.top : r.height / 2;
  const dot = document.createElement('span');
  dot.className = 'ripple';
  Object.assign(dot.style, { width: `${size}px`, height: `${size}px`, left: `${x}px`, top: `${y}px` });
  if (color) dot.style.background = `radial-gradient(circle, ${color}, transparent 70%)`;
  host.append(dot);
  gsap.fromTo(dot, { scale: 0, opacity: 0.9 }, { scale: 1, opacity: 0, duration: 0.75, ease: 'power2.out', onComplete: () => dot.remove() });
}

// ---------------------------------------------------------------------------------------------
// Springs / micro feedback
// ---------------------------------------------------------------------------------------------

/** gsap.to with a natural spring ease. */
export function spring(target, vars = {}) {
  if (!motionOK()) return gsap.set(target, stripTweenKeys(vars));
  return gsap.to(target, { duration: 0.9, ease: 'elastic.out(1, 0.5)', overwrite: 'auto', ...vars });
}

/** Snappy overshoot without wobble (UI-friendly). */
export function snap(target, vars = {}) {
  if (!motionOK()) return gsap.set(target, stripTweenKeys(vars));
  return gsap.to(target, { duration: 0.55, ease: 'back.out(1.7)', overwrite: 'auto', ...vars });
}

/** Quick attention pop (e.g. on selection). */
export function pop(target, { from = 0.955 } = {}) {
  if (!richMotion()) return null;
  return gsap.fromTo(target, { scale: from }, { scale: 1, duration: 0.7, ease: 'elastic.out(1.2, 0.4)', overwrite: 'auto' });
}

/** Horizontal error shake. */
export function shake(target) {
  if (!motionOK()) return null;
  return gsap.fromTo(target, { x: 0 }, { duration: 0.5, ease: 'none', keyframes: { x: [0, -10, 9, -7, 5, -3, 0] } });
}

function stripTweenKeys(vars) {
  const out = { ...vars };
  for (const k of ['duration', 'ease', 'delay', 'stagger', 'overwrite', 'repeat', 'yoyo', 'onComplete', 'onUpdate', 'keyframes']) delete out[k];
  return out;
}

export { gsap };
