// VELOX start sequence - the light, drawn off the main thread (module worker, OffscreenCanvas).
// intro.js hands over its canvas and posts the clock, the layout and the host's calls
// (done / celebrate); this worker runs the same pure render(t) on its own animation frames, so
// picture, light and sound share one timeline. Loaded by intro.js only; not used directly.
import { render, VARIANTS, HANDOVER, CELEBRATE, makePainter, cameraXf, lightParams, liveOf } from './intro.js';

let canvas = null, painter = null, variant = 'long', L = null, bandTop = 0, lightRes = 1, t0Abs = null, raf = 0, warming = true;
const live = { doneAt: null, celebAt: null, calm: false, q: 'high' };
const stats = { n: 0, max: 0, over: 0 };            // draw cost per frame (tests: intro.lightStats())
const nowT = () => performance.timeOrigin + performance.now() - t0Abs;

function draw(t) {
  const st = render(variant, t, liveOf(L, live));
  const xf = cameraXf(st, L);
  painter.paint(st, [xf.B, xf.Ax, xf.Ay - bandTop], lightParams(L, xf, lightRes, VARIANTS[variant].lag || 0));
}
function busy(t) {
  const V = VARIANTS[variant];
  return t < V.settled + 80
    || (live.celebAt !== null && t - live.celebAt < CELEBRATE.total + 80)
    || (live.doneAt !== null && t - live.doneAt < HANDOVER.total + 80);
}
function frame(ts) {
  raf = 0;
  if (!painter || !L || t0Abs === null) return;
  const t = performance.timeOrigin + ts - t0Abs;     // the frame's time, on the intro's clock
  const c0 = performance.now();
  draw(t);
  const dc = performance.now() - c0; stats.n++; stats.max = Math.max(stats.max, dc); if (dc > 8) stats.over++;
  if (warming) warming = painter.warmStep(6);
  if (busy(t)) raf = requestAnimationFrame(frame);
}
function kick() {
  if (raf || !painter || !L || t0Abs === null) return;
  const t = nowT();
  if (busy(t)) raf = requestAnimationFrame(frame);
  else draw(t);                                       // at rest: one frame (e.g. after a resize)
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      canvas = m.canvas; variant = m.variant;
      painter = makePainter(canvas);
      self.postMessage({ up: true });                 // intro.js starts its clock on this (or draws itself)
      painter.warm([0.25, 0.3, 0.36, 0.4, 0.55, 0.6, 0.62, 0.8, 1]);
      break;
    case 'size':
      if (canvas.width !== m.w) canvas.width = m.w;
      if (canvas.height !== m.h) canvas.height = m.h;
      L = m.L; bandTop = m.bandTop; lightRes = m.lightRes;
      if (painter) painter.invalidate();
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      break;
    case 'clock': t0Abs = m.t0Abs; break;
    case 'live': Object.assign(live, m.live); painter.invalidate(); break;
    case 'probe': self.postMessage({ id: m.id, n: painter ? painter.lit() : 0 }); return;
    case 'stats': self.postMessage({ id: m.id, n: { ...stats } }); return;
    default: return;
  }
  kick();
};
