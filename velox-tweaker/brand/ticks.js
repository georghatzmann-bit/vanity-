// VELOX tick-row progress - the installer's progress bar, in the brand's hairline language.
//
//   import { VeloxTicks } from './brand/ticks.js';        // + <link rel="stylesheet" href="brand/kit.css">
//   const bar = VeloxTicks.mount(intro.slot, { status: 'Dateien werden kopiert' });
//   bar.set(0.42); bar.step('3 / 7'); bar.status('Verknüpfungen werden angelegt');
//   bar.done('Fertig');  /  bar.fail('Kopieren fehlgeschlagen');  bar.destroy();
//
// A row of 1 px scale ticks (every tenth one taller). Done ticks turn bone; the one being
// worked on is the only orange pixel column - the blade's edge, nothing else turns orange.
// At 100 % the orange tick goes away: all bone, no colour for "finished".
// The ticks are drawn on a canvas at device resolution, so they stay one crisp device pixel
// wide at 100, 125 and 150 % scaling. The fill eases frame-rate independently and only runs
// rAF while it moves. Mono readout on the right (tabular "42 %"), status on the left.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function el(tag, cls, parent, text) {
  const e = document.createElement(tag); if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

export function mount(container, opts = {}) {
  const o = { status: '', step: '', pitch: 6, minor: 5, major: 9, reducedMotion: 'auto', ...opts };
  const reduced = o.reducedMotion === true || (o.reducedMotion === 'auto' && !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
  const root = el('div', 'vx-ticks', container);
  root.setAttribute('role', 'progressbar');
  root.setAttribute('aria-valuemin', '0'); root.setAttribute('aria-valuemax', '100'); root.setAttribute('aria-valuenow', '0');
  const meta = el('div', 'vx-ticks-meta', root);
  const statusEl = el('span', 'vx-ticks-status', meta, o.status);
  statusEl.setAttribute('aria-live', 'polite');
  const right = el('span', 'vx-ticks-read', meta);
  const stepEl = el('span', 'vx-ticks-step', right, o.step);
  const pctEl = el('span', 'vx-ticks-pct', right, '0 %');
  const canvas = el('canvas', 'vx-ticks-canvas', root);
  canvas.setAttribute('aria-hidden', 'true');
  root.style.setProperty('--vx-ticks-h', o.major + 'px');

  let target = 0, shown = 0, state = 'run', raf = 0, lt = 0, destroyed = false, lastKey = '';
  const colors = () => {
    const cs = getComputedStyle(root);
    const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
    return { line: v('--vx-line', '#2A2C31'), bone: v('--vx-bone', '#ECE9E2'), signal: v('--vx-signal', '#FF5A1F'), risk: v('--vx-risk', '#F25A80') };
  };
  let C = null, G = null;
  // device-pixel geometry: the canvas is sized and nudged so its pixels ARE device pixels
  // (no resampling blur at 125 / 150 %, even when the slot starts on a fractional device pixel)
  function measure() {
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    canvas.style.marginLeft = '0px'; canvas.style.marginTop = '0px';
    const r = root.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const fx = (Math.ceil(c.left * dpr - 1e-6) - c.left * dpr) / dpr, fy = (Math.ceil(c.top * dpr - 1e-6) - c.top * dpr) / dpr;
    const W = Math.max(1, Math.floor((r.width - fx) * dpr)), H = Math.max(1, Math.round(o.major * dpr));
    canvas.style.marginLeft = fx + 'px'; canvas.style.marginTop = fy + 'px';
    canvas.style.width = W / dpr + 'px'; canvas.style.height = H / dpr + 'px';
    G = { dpr, W, H };
    lastKey = '';
  }

  function draw() {
    if (!G) measure();
    const { dpr, W, H } = G;
    const tw = Math.max(1, Math.round(dpr));                      // tick width: whole device pixels
    const pitch = Math.max(tw + 2, Math.round(o.pitch * dpr));
    const n = Math.max(2, Math.floor((W - tw) / pitch) + 1);
    const lit = state === 'done' ? n : Math.min(n, Math.floor(shown * n + 1e-6));
    const head = state === 'done' ? -1 : (shown > 0 || state === 'fail' ? Math.min(n - 1, lit) : -1);
    const key = [W, H, n, lit, head, state].join(':');
    if (key === lastKey) return;
    lastKey = key;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    if (!C) C = colors();
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    const hMinor = Math.max(1, Math.round(o.minor * dpr));
    for (let i = 0; i < n; i++) {
      const x = i * pitch, isHead = i === head, majorTick = i % 10 === 0 || i === n - 1;
      const h = isHead || majorTick ? H : hMinor;
      g.fillStyle = isHead ? (state === 'fail' ? C.risk : C.signal) : i < lit ? C.bone : C.line;
      g.fillRect(x, H - h, tw, h);                                 // ticks stand on a common baseline
    }
  }
  function frame(now) {
    raf = 0;
    if (destroyed) return;
    const dt = lt ? Math.min(0.1, (now - lt) / 1000) : 0.016; lt = now;
    shown = reduced ? target : shown + (target - shown) * (1 - Math.exp(-10 * dt));
    if (Math.abs(target - shown) < 0.0005) shown = target;
    draw();
    if (shown !== target) raf = requestAnimationFrame(frame); else lt = 0;
  }
  const kick = () => { if (!raf && !destroyed) raf = requestAnimationFrame(frame); };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { measure(); draw(); }) : null;
  if (ro) ro.observe(root);
  let mq = null;
  const onDpr = () => { measure(); draw(); watch(); };
  function watch() { if (!window.matchMedia) return; if (mq) mq.removeEventListener('change', onDpr); mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); mq.addEventListener('change', onDpr); }
  watch();
  draw();

  return {
    element: root,
    set(p) {
      target = clamp01(+p || 0); if (state !== 'run') state = 'run';
      const pc = Math.round(target * 100);
      pctEl.textContent = pc + ' %'; root.setAttribute('aria-valuenow', String(pc));
      kick();
    },
    status(text) { statusEl.textContent = String(text); },
    step(text) { stepEl.textContent = text ? String(text) : ''; },
    done(text = 'Fertig') { target = 1; shown = 1; state = 'done'; pctEl.textContent = '100 %'; root.setAttribute('aria-valuenow', '100'); statusEl.textContent = text; draw(); },
    fail(text) { state = 'fail'; if (text) statusEl.textContent = text; root.classList.add('vx-ticks--fail'); lastKey = ''; draw(); },
    redraw() { C = null; measure(); draw(); },
    // capture / tests: draw exactly p, no easing
    seek(p) { target = shown = clamp01(p); pctEl.textContent = Math.round(p * 100) + ' %'; lastKey = ''; draw(); },
    destroy() { destroyed = true; if (raf) cancelAnimationFrame(raf); if (ro) ro.disconnect(); if (mq) mq.removeEventListener('change', onDpr); root.remove(); },
  };
}

export const VeloxTicks = { mount };
export default VeloxTicks;
