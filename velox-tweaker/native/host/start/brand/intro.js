// VELOX start sequence "Versatz" - the brand intro for every surface.
//
//   import { VeloxIntro } from './brand/intro.js';
//   const intro = VeloxIntro.mount(document.getElementById('stage'), { variant: 'full' });
//   intro.status('System wird gelesen'); intro.progress(0.4);
//   await intro.done();                       // hand-over: the loader segment snaps into the cut
//   intro.destroy();                          // always: releases the keyboard, the audio context
//
// One blade runs along the cut line. Each letter opens out of the cut as the blade passes,
// the upper halves wait one step behind, then they are struck: they slam into a hard stop
// past the lock, the whole picture freezes for two frames (hit-stop, on the crack), and a
// damped spring settles them one step ahead.
// render(t) is a pure function of time: it returns the whole picture (in glyph units) and the
// sound plan is sampled from it, so picture and sound cannot drift. Transforms and opacity
// only; no inline styles or scripts (CSP script-src/style-src 'self' - CSSOM is used).
import { GLYPHS as G } from './glyphs.js';
import * as Sound from './sound.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const CUT_MID = (G.cutTop + G.cutBot) / 2;
const V_FOOT = 29;                           // x of the V's lower-left corner: the alignment edge
const INK_R = G.w;                           // right edge of the settled word
const LOAD_GAP = 46;                         // baseline -> loader hairline, in glyph units
const SLOT_GAP = 40;                         // baseline -> slot (installer content), glyph units

// ------------------------------------------------------------------ timelines (ms)
// The strike, in three phases:
//   release -> contact   the upper halves are thrown from the draw-back (x0) to a hard stop at
//                        `peak` (past the lock at +7), constant acceleration: they arrive fast.
//   contact -> +hold     hit-stop: everything freezes at the stop for `hold` ms - the upper
//                        halves at the peak, the word popped, the lower halves recoiled. The
//                        crack of the sound sits on the first frozen frame.
//   then                 a damped spring from the peak (at rest) to +7:
//                        x(s) = 7 + (peak - 7) e^(-s/tau) (cos ws + sin(ws) / (w tau)),
//                        one undershoot (+5.45 at s = pi/w), settled < 0.25 units 130 ms later.
const VARIANTS = {
  full: {
    bladeIn: 140, wordAt: 250, speed: 2.35, len: 170, openDur: 300,
    lag: 10, wind: 2.5, windAt: 820, release: 900, strike: 26, hold: 33, peak: 12.8,
    spring: { tau: 40, w: 0.06 },
    pop: 0.035, recoil: 2.5, loadIn: 1180, loadDur: 380, settled: 1600,
  },
  short: {
    bladeIn: 40, wordAt: 40, speed: 3.2, len: 120, openDur: 240, fromV: true,
    lag: -2, wind: 0.8, windAt: 300, release: 335, strike: 17, hold: 17, peak: 8.9,   // lag -2: ELOX wait 5 units behind (more would collide with the fixed V)
    spring: { tau: 30, w: 0.075 },
    pop: 0.012, recoil: 0.9, loadIn: 430, loadDur: 300, settled: 760,
  },
  reduced: { fade: 600, loadIn: 250, loadDur: 500, settled: 800 },
  still: { settled: 0 },
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const expoOut = (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u));
const cubicOut = (u) => 1 - Math.pow(1 - u, 3);
const smooth = (u) => u * u * (3 - 2 * u);

// position of the upper halves s ms after the hit-stop ends (starts at the peak, at rest)
function springAt(V, s) {
  const sp = V.spring, X = G.offset, A = V.peak - X;
  return X + A * Math.exp(-s / sp.tau) * (Math.cos(sp.w * s) + Math.sin(sp.w * s) / (sp.w * sp.tau));
}
// derived once per variant
for (const V of [VARIANTS.full, VARIANTS.short]) {
  V.from = -V.lag - V.wind;                                  // draw-back position
  V.contact = V.release + V.strike;                          // the stop: crack, pop, recoil, hit-stop
  V.vContact = 2 * (V.peak - V.from) / V.strike;             // arrival speed (units/ms), drives the hit
  V.undershootAt = V.contact + V.hold + Math.PI / V.spring.w;
  const x0 = V.fromV ? G.letters[0].hi : G.cutLo;
  V.x0 = x0;
  V.openAt = G.letters.map((l, i) => (V.fromV && i === 0 ? -Infinity : V.wordAt + (l.cx - x0) / V.speed));
}

// blade head and tail in glyph units (edgeU = the container's left edge, in glyph units)
function bladeAt(V, t, edgeU) {
  if (V.bladeIn === undefined || t < V.bladeIn) return null;
  let head, tail;
  const free = V.x0 + (t - V.wordAt) * V.speed;           // where the head would be without the stop
  if (!V.fromV && t < V.wordAt) {                          // lead-in from the window edge, accelerating
    const d = V.x0 - edgeU, T = V.wordAt - V.bladeIn;
    const n = Math.max(1, Math.min(6, V.speed * T / Math.max(1, d)));
    head = edgeU + d * Math.pow((t - V.bladeIn) / T, n);
    tail = edgeU;
  } else {
    head = Math.min(free, G.cutHi);
    tail = Math.min(Math.max(V.fromV ? V.x0 : edgeU, free - V.len), G.cutHi);
  }
  return head - tail > 0.3 ? { head, tail } : null;
}

// the strike: upper-half offset, word scale, lower-half recoil at time t
function strikeAt(V, t) {
  if (t >= V.settled) return { dx: G.offset, scale: 1, rec: 0 };           // exact rest pose
  if (t < V.windAt) return { dx: -V.lag, scale: 1, rec: 0 };
  if (t < V.release) { const w = (t - V.windAt) / (V.release - V.windAt); return { dx: -V.lag - V.wind * (1 - (1 - w) * (1 - w)), scale: 1, rec: 0 }; }
  if (t < V.contact) { const u = (t - V.release) / V.strike; return { dx: V.from + (V.peak - V.from) * u * u, scale: 1, rec: 0 }; }
  if (t < V.contact + V.hold) return { dx: V.peak, scale: 1 + V.pop, rec: -V.recoil };   // hit-stop: hard, no easing
  const s = t - V.contact - V.hold;
  return {
    dx: springAt(V, s),
    scale: 1 + V.pop * Math.exp(-s / 28) * Math.cos(V.spring.w * s),
    rec: -V.recoil * Math.exp(-s / 30) * Math.cos(2 * Math.PI * s / 110),
  };
}

// The pure picture. live = { edgeU, doneAt, fill } (edgeU from the layout; doneAt and fill
// only when the host has called done() / progress()). Everything returned is in glyph units
// except opacities and the loader's lift (px).
export function render(variant, t, live = {}) {
  const V = VARIANTS[variant];
  const st = { wordAlpha: 1, scale: 1, letters: [], blade: null, loadAlpha: 0, loadLift: 0, seg: null, skipAlpha: 0, line: null };
  if (variant === 'still' || variant === 'reduced') {
    const k = variant === 'still' ? 1 : smooth(clamp01(t / V.fade));
    st.wordAlpha = k;
    for (let i = 0; i < 5; i++) st.letters.push({ open: 1, tdx: G.offset, bdx: 0 });
    st.loadAlpha = variant === 'still' ? 1 : clamp01((t - V.loadIn) / V.loadDur);
    // still: no resting segment (a short bar at rest reads as progress stuck at 18 %).
    // reduced: a resting segment that breathes in opacity - no travel.
    st.seg = variant === 'still' ? null : { a: 0, b: 0.18, alpha: 0.6 + 0.4 * Math.cos(Math.max(0, t - V.settled) / 2600 * Math.PI * 2) };
    st.skipAlpha = variant === 'still' ? 0 : 1 - clamp01((t - V.settled + 200) / 200);
  } else {
    const sk = strikeAt(V, t);
    st.scale = sk.scale;
    for (let i = 0; i < 5; i++) {
      const open = V.openAt[i] === -Infinity ? 1 : expoOut(clamp01((t - V.openAt[i]) / V.openDur));
      const fixed = V.fromV && i === 0;                    // short: the V is already in place
      st.letters.push({ open, tdx: fixed ? G.offset : sk.dx, bdx: fixed ? 0 : sk.rec });
    }
    st.blade = bladeAt(V, t, live.edgeU === undefined ? -60 : live.edgeU);
    const k = cubicOut(clamp01((t - V.loadIn) / V.loadDur));
    st.loadAlpha = k; st.loadLift = (1 - k) * 6;
    st.seg = loopSeg(t - (V.loadIn + 150));
    st.skipAlpha = 1 - clamp01((t - V.settled + 200) / 200);
  }
  if (live.fill !== undefined && live.fill !== null) st.seg = { a: 0, b: clamp01(live.fill), alpha: 1, fill: true };
  if (live.doneAt !== undefined && live.doneAt !== null && t >= live.doneAt) handover(st, t - live.doneAt, render(variant, live.doneAt, { ...live, doneAt: null }));
  return st;
}

// the loading loop: one short segment crossing the hairline, echoing the blade
function loopSeg(tl) {
  if (tl < 0) return null;
  const period = 1700, travel = 1450, u = (tl % period) / travel;
  if (u > 1) return null;
  const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  const sw = 0.18, x = -sw + (1 + sw) * e;
  const a = Math.max(0, x), b = Math.min(1, x + sw);
  return b > a ? { a, b, alpha: 1 } : null;
}

// the hand-over: the segment leaves the hairline and snaps into the cut (it moves behind the
// letters). One quiet click on arrival. After a short hold the line retracts, right to left,
// into the V's foot - the end pose is the canonical wordmark, never a struck-through word.
export const HANDOVER = { travel: 120, hold: 170, retract: 140 };
HANDOVER.total = HANDOVER.travel + HANDOVER.hold + HANDOVER.retract;
function handover(st, h, at) {
  const fade = clamp01(h / 140);
  st.loadAlpha = at.loadAlpha * (1 - fade);
  st.seg = null;
  st.skipAlpha = 0;
  const T = HANDOVER;
  if (h >= T.total) { st.line = null; return; }
  if (h >= T.travel + T.hold) {
    const u = clamp01((h - T.travel - T.hold) / T.retract), q = u * u * u;   // accelerates home
    st.line = { y: CUT_MID, x0: G.cutLo, x1: G.cutHi + (G.cutLo - G.cutHi) * q };
    return;
  }
  const from = at.seg || { a: 0, b: 0.18 };
  const trackL = V_FOOT, trackW = INK_R - V_FOOT;
  const yFrom = 100 + LOAD_GAP, u = clamp01(h / T.travel);
  const q = u * u;                                          // accelerates into the cut
  const e = cubicOut(u);
  st.line = {
    y: yFrom + (CUT_MID - yFrom) * q,
    x0: trackL + trackW * from.a + (G.cutLo - (trackL + trackW * from.a)) * e,
    x1: trackL + trackW * from.b + (G.cutHi - (trackL + trackW * from.b)) * e,
  };
}

// ------------------------------------------------------------------ sound plan from render()
// geo = { k (px per unit), X0 (px of glyph x=0), cw (container width) } -> pan positions
export function soundPlan(variant, geo = { k: 1, X0: 60, cw: 880 }) {
  const pan = (u) => Math.max(-0.85, Math.min(0.85, -0.85 + 1.7 * (geo.X0 + u * geo.k) / geo.cw));
  const edgeU = -geo.X0 / geo.k;
  if (variant === 'reduced') return { events: [{ type: 'ready', t: 100, soft: true }], fadeFrom: 1450, end: 1700, gain: 1 };
  if (variant === 'still') return { events: [], fadeFrom: 0, end: 10, gain: 1 };
  const V = VARIANTS[variant], ev = [];
  const full = VARIANTS.full;
  const wordPan = pan((G.cutLo + G.cutHi) / 2);
  if (variant === 'full') {
    ev.push({ type: 'tick', t: V.bladeIn, gain: 1, pan: pan(edgeU) });
    // air: a thin, steady band while the blade head moves - its pan follows the head, its
    // pitch rises only a little with the head's position. Level constant (no swell).
    const step = 4, t0 = V.bladeIn, t1 = V.wordAt + (G.cutHi - V.x0) / V.speed + 8;
    const freq = [], gain = [], pn = [];
    for (let t = t0; t <= t1; t += step) {
      const b = bladeAt(V, t, edgeU);
      const head = b ? b.head : G.cutHi;
      const f = clamp01((head - edgeU) / (G.cutHi - edgeU));
      freq.push(4300 * Math.pow(5000 / 4300, f));
      gain.push(1);
      pn.push(pan(head));
    }
    gain[0] = 0; gain[gain.length - 1] = 0;                 // 4 ms ramps, no edge clicks
    ev.push({ type: 'air', t: t0, dur: (freq.length - 1) * step / 1000, freq, gain, pan: pn });
  }
  const maxMass = Math.max(...G.letters.map((l) => l.mass));
  G.letters.forEach((l, i) => {
    if (V.openAt[i] === -Infinity || variant === 'short') return;   // short: no clicks, one hit only
    // one dry click per letter as it opens; the more material the cut runs through, the
    // lower and louder it is (L 2.2 kHz ... E 1.2 kHz)
    // (gain / sqrt(f): a band-passed click carries energy in proportion to its bandwidth)
    const m = l.mass / maxMass, f = 2200 - 1000 * (m - 24 / 53) / (1 - 24 / 53);
    ev.push({ type: 'click', t: V.openAt[i], i, gain: (0.55 + 0.45 * m) * Math.sqrt(1300 / f), f, pan: pan(l.cx) });
  });
  ev.push({ type: 'impact', t: V.contact, v: V.vContact / full.vContact, small: variant === 'short',
    tau: V.spring.tau / 1000, halfPeriod: Math.min(0.07, Math.PI / V.spring.w / 1000), pan: wordPan * 0.5 });
  // no "ready" tone after the hit: Klack, then silence
  return variant === 'full'
    ? { events: ev, fadeFrom: 1500, end: 1700, gain: 1 }
    : { events: ev, fadeFrom: V.contact + 300, end: V.contact + 420, gain: 1.3 };   // the small hit: about -23 LUFS
}
export function handoverPlan(pan = 0) {
  return { events: [{ type: 'snap', t: 0, pan }], fadeFrom: 160, end: 220, gain: 1 };
}

// ------------------------------------------------------------------ layout
// The composition is left-aligned (a hardware box, not a centred logo): the V's foot sits on
// the left margin, loader and status hang from the same edge. place 'hero' = the start screen
// (the word spans about two thirds of the width), 'header' = the word near the top with room
// for the installer content (the slot) under it.
// dpr: device pixels per CSS px. The scale is chosen so that every horizontal edge of the word
// at rest (cap line, both cut edges, baseline) and the blade land on whole device pixels.
export function layoutFor(cw, ch, place = 'hero', dpr = 1, ox = 0, oy = 0) {   // ox/oy: the container's page offset (it may sit on a fractional device pixel)
  const m = Math.round(Math.max(20, Math.min(cw * 0.072, 140)));
  const inkU = INK_R - 22;                                  // overhang of the V at the cut included
  let cap = place === 'header' ? Math.min(cw * 0.112, ch * 0.175) : Math.min(cw * 0.166, ch * 0.3);
  cap = Math.max(36, Math.min(cap, place === 'header' ? 160 : 320, (cw - 2 * m) / (inkU / 100)));
  // snap: the cut band (8 units) is an even number of device pixels -> 44, 48, 52, 100 all whole
  const band = Math.max(2, 2 * Math.round(cap * 0.08 * dpr / 2));
  const k = band / (8 * dpr);
  cap = 100 * k;
  const snapX = (v) => Math.round((v + ox) * dpr) / dpr - ox, snapY = (v) => Math.round((v + oy) * dpr) / dpr - oy;
  let top;
  if (place === 'header') top = Math.max(48, ch * 0.105);
  else { const block = cap * (1 + LOAD_GAP / 100) + 40; top = (ch - block) * 0.46; }
  top = snapY(top);
  const X0 = snapX(m - V_FOOT * k);
  const fs = Math.round(Math.max(12, Math.min(cap * 0.1, 16)));
  return { cw, ch, m, cap, k, top, X0, fs, edgeU: -X0 / k, place, dpr, band, ox, oy };
}

// ------------------------------------------------------------------ helpers
function ensureCss() {
  const href = new URL('./intro.css', import.meta.url).href;
  const have = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === href);
  if (have) return have.sheet ? Promise.resolve() : new Promise((r) => { have.addEventListener('load', r, { once: true }); setTimeout(r, 400); });
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.dataset.vxCss = '';
  document.head.appendChild(link);
  return new Promise((r) => { link.addEventListener('load', r, { once: true }); link.addEventListener('error', r, { once: true }); setTimeout(r, 600); });
}
function el(tag, cls, parent, text) {
  const e = document.createElement(tag); if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function readMuted() { try { return localStorage.getItem('velox.sound') === 'off'; } catch (e) { return false; } }
function writeMuted(m) { try { localStorage.setItem('velox.sound', m ? 'off' : 'on'); } catch (e) { /* no storage (e.g. NavigateToString) */ } }
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [contenteditable], [data-vx-noreplay]';
const devicePx = () => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

// ------------------------------------------------------------------ mount
export function mount(container, opts = {}) {
  const o = {
    variant: 'full', sound: true, muted: undefined, reducedMotion: 'auto', place: 'hero', loader: true,
    labels: null, statusText: 'Dienst wird gestartet', clock: 'auto', onMuteChange: null, handedOver: false, ...opts,
  };
  let reduced = o.reducedMotion === true;
  if (o.reducedMotion === 'auto') {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    try { if (new URLSearchParams(location.search).get('reduced') === '1') reduced = true; } catch (e) { /* opaque origin */ }
  }
  const variant = o.variant === 'still' ? 'still' : reduced ? 'reduced' : (o.variant === 'short' ? 'short' : 'full');
  const V = VARIANTS[variant];
  const manual = o.clock === 'manual';
  const hasSound = !!o.sound && variant !== 'still';        // still never plays a cue: no sound UI either

  // ---- DOM
  container.classList.add('vx-host');
  const root = el('div', 'vx vx--' + variant + ' vx--' + o.place + (o.loader ? '' : ' vx--noload'), container);
  root.classList.add('vx--boot');
  const labels = el('div', 'vx-labels', root);
  const labL = el('span', 'vx-label', labels), labR = el('span', 'vx-label vx-label-r', labels);
  if (o.labels) { const lb = Array.isArray(o.labels) ? o.labels : [null, o.labels]; labL.textContent = lb[0] || ''; labR.textContent = lb[1] || ''; }
  labels.setAttribute('aria-hidden', 'true');
  const blade = el('div', 'vx-blade', root); blade.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'vx-word'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'VELOX');
  svg.setAttribute('focusable', 'false');
  root.appendChild(svg);
  const M = 24;   // margin around the word inside the svg, glyph units (room for the strike)
  svg.setAttribute('viewBox', `${-M} ${-M} ${G.w + 2 * M} ${100 + 2 * M}`);
  const uid = 'vx' + Math.random().toString(36).slice(2, 8);
  const defs = document.createElementNS(SVGNS, 'defs');
  const clip = (id, y0, y1) => {
    const cp = document.createElementNS(SVGNS, 'clipPath'); cp.setAttribute('id', id);
    const rc = document.createElementNS(SVGNS, 'rect');
    rc.setAttribute('x', -M); rc.setAttribute('y', y0); rc.setAttribute('width', G.w + 2 * M); rc.setAttribute('height', y1 - y0);
    cp.appendChild(rc); defs.appendChild(cp);
  };
  clip(uid + 't', -M, G.cutTop); clip(uid + 'b', G.cutBot, 100 + M);
  svg.appendChild(defs);
  const gWord = document.createElementNS(SVGNS, 'g');
  const gT = document.createElementNS(SVGNS, 'g'); gT.setAttribute('clip-path', `url(#${uid}t)`);
  const gB = document.createElementNS(SVGNS, 'g'); gB.setAttribute('clip-path', `url(#${uid}b)`);
  gWord.appendChild(gT); gWord.appendChild(gB); svg.appendChild(gWord);
  const tops = [], bots = [];
  for (const l of G.letters) {
    const pt = document.createElementNS(SVGNS, 'path'); pt.setAttribute('d', l.top); pt.setAttribute('class', 'vx-pc');
    const pb = document.createElementNS(SVGNS, 'path'); pb.setAttribute('d', l.bot); pb.setAttribute('class', l.signal ? 'vx-pc vx-signal' : 'vx-pc');
    gT.appendChild(pt); gB.appendChild(pb); tops.push(pt); bots.push(pb);
  }
  const load = el('div', 'vx-load', root);
  const loadIn = el('div', 'vx-load-in', load);
  const track = el('div', 'vx-track', loadIn);
  const seg = el('div', 'vx-seg', track);
  const meta = el('div', 'vx-meta', loadIn);
  const statusEl = el('span', 'vx-status', meta, o.statusText);
  statusEl.setAttribute('role', 'status'); statusEl.setAttribute('aria-live', 'polite');
  const pctEl = el('span', 'vx-pct', meta, '');
  if (!o.loader) load.hidden = true;
  const slot = el('div', 'vx-slot', root);
  const bar = el('div', 'vx-bar', root);
  const soundBtn = el('button', 'vx-btn vx-sound', bar);
  soundBtn.type = 'button';
  const soundLbl = el('span', '', soundBtn, 'Ton an'); el('kbd', 'vx-key', soundBtn, 'M');
  const skipBtn = el('button', 'vx-btn vx-skip', bar);
  skipBtn.type = 'button'; el('span', '', skipBtn, 'Überspringen'); el('kbd', 'vx-key', skipBtn, 'Esc');
  if (!hasSound) soundBtn.hidden = true;
  if (variant === 'still') skipBtn.hidden = true;

  // ---- layout (snapped to device pixels; re-run on resize and on a DPI change)
  let L = layoutFor(container.clientWidth || 880, container.clientHeight || 560, o.place, devicePx());
  let thick = 2, hair = 1;
  function applyLayout() {
    const dpr = devicePx(), r = container.getBoundingClientRect(), bw = container.clientLeft || 0, bt = container.clientTop || 0;
    L = layoutFor(container.clientWidth || 880, container.clientHeight || 560, o.place, dpr, r.left + bw, r.top + bt);
    const k = L.k;
    thick = Math.max(1, Math.round(2 * dpr)) / dpr;          // the 2 px line, in whole device pixels
    hair = Math.max(1, Math.round(dpr)) / dpr;               // the 1 px hairline
    root.style.setProperty('--vx-fs', L.fs + 'px');
    root.style.setProperty('--vx-m', L.m + 'px');
    root.style.setProperty('--vx-thick', thick + 'px');
    root.style.setProperty('--vx-hair', hair + 'px');
    root.style.setProperty('--vx-hair-y', Math.floor((Math.round(thick * dpr) - Math.round(hair * dpr)) / 2) / dpr + 'px');
    svg.style.width = (G.w + 2 * M) * k + 'px';
    svg.style.height = (100 + 2 * M) * k + 'px';
    svg.style.transformOrigin = ((V_FOOT + M) * k) + 'px ' + ((100 + M) * k) + 'px';
    blade.style.width = L.cw + 'px';
    const loadY = L.top + (100 + LOAD_GAP) * k;
    load.style.left = L.m + 'px'; load.style.top = (Math.round((loadY + L.oy) * dpr) / dpr - L.oy) + 'px';
    load.style.width = Math.round((INK_R - V_FOOT) * k) + 'px';
    slot.style.left = L.m + 'px'; slot.style.right = L.m + 'px';
    slot.style.top = Math.round(L.top + (100 + SLOT_GAP) * k) + 'px';
    last = {};
    paint(curT());
    watchDpr(dpr);
  }
  let dprMq = null;
  function onDpr() { applyLayout(); }
  function watchDpr(dpr) {
    if (!window.matchMedia) return;
    if (dprMq) dprMq.removeEventListener('change', onDpr);
    dprMq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    dprMq.addEventListener('change', onDpr);
  }

  // ---- paint one frame (only writes what changed)
  let last = {};
  const set = (key, node, prop, val) => { if (last[key] !== val) { last[key] = val; node.style[prop] = val; } };
  let fill = null, fillShown = null, doneAt = null;
  function paint(t) {
    const st = render(variant, t, { edgeU: L.edgeU, doneAt, fill: fillShown });
    const k = L.k, dpr = L.dpr;
    set('svgT', svg, 'transform', `translate(${(L.X0 - M * k).toFixed(3)}px,${(L.top - M * k).toFixed(3)}px) scale(${st.scale.toFixed(5)})`);
    set('svgO', svg, 'opacity', st.wordAlpha >= 1 ? '1' : st.wordAlpha.toFixed(3));
    for (let i = 0; i < 5; i++) {
      const s = st.letters[i];
      const ty = (1 - s.open) * (G.cutTop + 4), by = -(1 - s.open) * (100 - G.cutBot + 4);
      set('t' + i, tops[i], 'transform', `translate(${s.tdx.toFixed(3)}px,${ty.toFixed(3)}px)`);
      set('b' + i, bots[i], 'transform', `translate(${s.bdx.toFixed(3)}px,${by.toFixed(3)}px)`);
    }
    // blade / hand-over line (same element: a solid signal line, whole device pixels thick,
    // on a whole device-pixel row, scaled from its left end)
    const ln = st.line || (st.blade && { y: CUT_MID, x0: st.blade.tail, x1: st.blade.head });
    if (ln) {
      const x0 = Math.max(0, L.X0 + ln.x0 * k), x1 = Math.min(L.cw, L.X0 + ln.x1 * k);
      const y = Math.round((L.top + ln.y * k + L.oy) * dpr - thick * dpr / 2) / dpr - L.oy;
      set('blO', blade, 'opacity', x1 > x0 ? '1' : '0');
      set('blT', blade, 'transform', `translate(${x0.toFixed(2)}px,${y.toFixed(3)}px) scaleX(${((x1 - x0) / L.cw).toFixed(5)})`);
    } else set('blO', blade, 'opacity', '0');
    set('ldO', load, 'opacity', st.loadAlpha.toFixed(3));
    set('ldT', loadIn, 'transform', `translateY(${(Math.round(st.loadLift * dpr) / dpr).toFixed(3)}px)`);
    if (st.seg) {
      set('sgO', seg, 'opacity', st.seg.alpha.toFixed(3));
      set('sgT', seg, 'transform', `translateX(${(st.seg.a * 100).toFixed(3)}%) scaleX(${(st.seg.b - st.seg.a).toFixed(5)})`);
    } else set('sgO', seg, 'opacity', '0');
    set('skO', skipBtn, 'opacity', st.skipAlpha.toFixed(3));
    const skipLive = st.skipAlpha > 0.05;
    if (last.skipLive !== skipLive) { last.skipLive = skipLive; skipBtn.classList.toggle('vx-off', !skipLive); }
  }

  // ---- clock
  let t0 = performance.now(), raf = 0, destroyed = false, skipped = false, manualT = 0;
  const curT = () => (manual ? manualT : performance.now() - t0);
  let resolveSettled; const settled = new Promise((r) => { resolveSettled = r; });
  let settledFired = false;
  function fireSettled() {
    if (settledFired) return;
    settledFired = true; root.classList.add('vx--settled'); resolveSettled();
    if (!o.loader) releaseKeys();          // installer: the intro's controls are gone, so are its keys
    muteUi();
  }
  // rAF stops in a hidden or minimised window: timers make sure settled/done() still resolve
  let settleTimer = 0;
  function armSettleTimer() { clearTimeout(settleTimer); settleTimer = setTimeout(() => { if (!destroyed && curT() >= V.settled - 20) { fireSettled(); kick(); } else if (!destroyed) armSettleTimer(); }, Math.max(30, V.settled - curT() + 40)); }
  function frame() {
    raf = 0;
    if (destroyed) return;
    const t = curT();
    // determinate progress eases towards its target, frame-rate independent
    if (fill !== null) {
      const now = performance.now(), dt = Math.min(0.1, (now - (frame.lt || now)) / 1000); frame.lt = now;
      fillShown = fillShown === null ? fill : fillShown + (fill - fillShown) * (1 - Math.exp(-12 * dt));
      if (Math.abs(fill - fillShown) < 0.0005) fillShown = fill;
    } else frame.lt = 0;
    paint(t);
    if (!settledFired && t >= V.settled) fireSettled();
    if (handoverTick(t)) return;
    const moving = !settledFired || (o.loader && doneAt === null && (fill === null ? variant !== 'still' && variant !== 'reduced' : fillShown !== fill)) || doneAt !== null;
    if (moving) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && !destroyed && !manual) raf = requestAnimationFrame(frame); };

  // ---- sound
  // States the sound button shows: 'on' (playing / allowed), 'off' (muted, remembered),
  // 'blocked' (wanted, but the browser has not allowed audio yet: "Ton: klicken").
  let ctx = null, cue = null, audible = false, replayed = false, unlocking = false;
  let muted = o.muted !== undefined ? !!o.muted : readMuted();
  function audioReady() { return hasSound && !muted && ctx && ctx.state === 'running'; }
  function blocked() { return hasSound && !muted && !manual && !!ctx && ctx.state !== 'running' && !settledFired; }
  function startCue(fromMs) {
    if (!audioReady()) return false;
    if (variant !== 'reduced' && fromMs > V.contact - 30) return false;     // too late to land the hit in sync
    const plan = soundPlan(variant, L);
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const when = ctx.currentTime + 0.02;
    cue = Sound.scheduleCue(ctx, ctx.destination, when, plan, fromMs);
    // keep the picture on the sound: plan time fromMs is heard at `when + lat`
    if (!manual) t0 = performance.now() - fromMs + 20 + lat * 1000;
    audible = true;
    muteUi();
    return true;
  }
  function stopCue(ms = 60) { if (cue) { cue.stop(ms); cue = null; } }
  function watchCtx() {
    if (ctx && !ctx.__vxWatched) { ctx.__vxWatched = true; ctx.addEventListener('statechange', () => { if (!destroyed) muteUi(); }); }
  }

  let started = null;
  function begin() {
    t0 = performance.now(); started = t0; skipped = false; settledFired = false; root.classList.remove('vx--settled');
    armSettleTimer();
    if (hasSound && !muted && !manual) {
      if (!ctx) ctx = Sound.createContext();
      if (ctx) {
        watchCtx();
        if (ctx.state === 'running') startCue(0);
        else ctx.resume().then(() => { if (!audible && !unlocking && !destroyed) startCue(curT()); }, () => {});
      }
    }
    muteUi();
    kick();
  }

  // ---- input
  function skip() {
    if (skipped || settledFired || variant === 'still') return;
    skipped = true; stopCue(60);
    if (manual) manualT = V.settled; else t0 = performance.now() - V.settled;
    if (!manual) armSettleTimer();
    kick();
  }
  function muteUi() {
    const b = blocked();
    soundBtn.classList.toggle('vx-blocked', b);
    soundLbl.textContent = muted ? 'Ton aus' : b ? 'Ton: klicken' : 'Ton an';
    soundBtn.setAttribute('aria-pressed', !muted && !b ? 'true' : 'false');
    soundBtn.setAttribute('aria-label', muted ? 'Ton einschalten' : b ? 'Ton ist noch blockiert. Klicken, um ihn einzuschalten' : 'Ton ausschalten');
  }
  function setMuted(m) {
    muted = !!m; writeMuted(muted); muteUi();
    if (muted) stopCue(60);
    else if (!audible && !settledFired && !manual) {     // unmuted mid-intro: play what is still ahead
      if (!ctx) { ctx = Sound.createContext(); watchCtx(); }
      if (ctx) (ctx.state === 'running' ? Promise.resolve() : ctx.resume()).then(() => startCue(curT()), () => {});
    }
    muteUi();
    if (typeof o.onMuteChange === 'function') o.onMuteChange(muted);
  }
  // Autoplay blocked: a click (or M, or the sound button) is the gesture that unlocks audio.
  // Before the settle, with nothing in the slot, it replays the intro from the start with
  // sound - once. Never after the settle, never over installer content.
  const canReplay = () => !replayed && !settledFired && doneAt === null && slot.childElementCount === 0 && !slot.textContent.trim();
  function unlock() {
    if (!ctx) { ctx = Sound.createContext(); watchCtx(); }
    if (!ctx || unlocking) return;
    unlocking = true;                      // set synchronously: begin()'s pending resume() must not start the cue mid-way
    ctx.resume().then(() => {
      unlocking = false;
      if (destroyed || audible) { muteUi(); return; }
      if (canReplay()) { replayed = true; begin(); }
      else if (!settledFired) startCue(curT());
      muteUi();
    }, () => { unlocking = false; });
  }
  function onPointer(e) {
    if (destroyed || manual) return;
    if (e.target.closest && e.target.closest('.vx-bar')) return;
    if (e.target.closest && slot.contains(e.target)) return;
    if (blocked() && canReplay()) unlock();
  }
  let keysOn = false;
  function onKey(e) {
    if (destroyed || e.ctrlKey || e.altKey || e.metaKey) return;
    const tgt = e.target, typing = tgt && tgt.closest && tgt.closest('input, textarea, select, [contenteditable]');
    if (typing) return;
    if ((e.key === 'm' || e.key === 'M') && hasSound) { soundAction(); return; }
    const inSlot = tgt && tgt.closest && (tgt.closest('.vx-bar') || (slot.contains(tgt) && tgt.closest(INTERACTIVE)));
    if ((e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && !settledFired && !inSlot) {
      e.preventDefault(); skip();
    }
  }
  function soundAction() { if (blocked()) unlock(); else setMuted(!muted); }
  function releaseKeys() { if (keysOn) { keysOn = false; window.removeEventListener('keydown', onKey); } }
  soundBtn.addEventListener('click', (e) => { e.stopPropagation(); soundAction(); });
  skipBtn.addEventListener('click', (e) => { e.stopPropagation(); skip(); });
  root.addEventListener('pointerdown', onPointer);
  if (variant !== 'still' && !manual) { keysOn = true; window.addEventListener('keydown', onKey); }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => applyLayout()) : null;
  if (ro) ro.observe(container); else window.addEventListener('resize', applyLayout);

  // ---- hand-over
  let doneResolve = null, donePromise = null, snapped = false;
  function finishHandover() {
    root.classList.add('vx--done'); releaseKeys();
    const r = doneResolve; doneResolve = null; if (r) r();
  }
  function handoverTick(t) {
    if (doneAt === null) return false;
    const h = t - doneAt;
    if (!snapped && h >= HANDOVER.travel) {
      snapped = true;
      if (audioReady()) Sound.scheduleCue(ctx, ctx.destination, ctx.currentTime + 0.005, handoverPlan(0), 0);
    }
    if (h >= HANDOVER.total) { finishHandover(); return true; }
    return false;
  }
  function done() {
    if (donePromise) return donePromise;
    donePromise = settled.then(() => new Promise((resolve) => {
      if (destroyed) { resolve(); return; }
      doneResolve = resolve;
      doneAt = curT();
      if (manual) { finishHandover(); return; }
      kick();
      setTimeout(() => { if (doneResolve === resolve) finishHandover(); }, HANDOVER.total + 250);
    }));
    return donePromise;
  }

  // ---- start
  muteUi();
  if (o.handedOver) {                        // in-app continuation of VELOX.exe's start screen: the canonical end pose
    doneAt = -(HANDOVER.total + 1); snapped = true;
    donePromise = Promise.resolve();
    root.classList.add('vx--done');
    releaseKeys();
  }
  // Audio start-up is split over separate tasks (create the context / build buffers / schedule),
  // each well under the 50 ms long-task line, and finished before the clock starts - so the
  // first frames are never blocked by it.
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const wantsAudio = hasSound && !muted && !manual;
  const audioBoot = !wantsAudio ? Promise.resolve() : nextTask()
    .then(() => { if (!destroyed && !ctx) { ctx = Sound.createContext(); watchCtx(); } return nextTask(); })
    .then(() => { if (!destroyed && ctx) Sound.prewarm(ctx); return nextTask(); });
  const boot = Promise.all([o.css === false ? Promise.resolve() : ensureCss(), audioBoot]).then(() => {
    if (destroyed) return;
    root.classList.remove('vx--boot');
    applyLayout();
    if (manual) paint(0); else begin();
  });

  return {
    element: root,
    slot,
    settled,
    ready: boot,
    variant,
    get muted() { return muted; },
    get startedAt() { return started; },   // performance.now() of the intro's t = 0 (after boot)
    get audible() { return audible && !!ctx && ctx.state === 'running'; },   // the cue is playing (autoplay allowed / unlocked)
    get blocked() { return blocked(); },    // sound wanted, but not yet allowed by the browser
    status(text) { statusEl.textContent = String(text); },
    progress(p) {
      if (p === null || p === undefined || !isFinite(p)) { fill = null; fillShown = null; pctEl.textContent = ''; root.classList.remove('vx--det'); }
      else { fill = clamp01(+p); if (fillShown === null) fillShown = 0; pctEl.textContent = Math.round(fill * 100) + ' %'; root.classList.add('vx--det'); }
      kick();
    },
    done,
    skip,
    setMuted,
    replay() { stopCue(30); audible = false; doneAt = null; snapped = false; donePromise = null; root.classList.remove('vx--done'); if (variant !== 'still' && !manual && !keysOn) { keysOn = true; window.addEventListener('keydown', onKey); } begin(); },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); clearTimeout(settleTimer); stopCue(30);
      releaseKeys();
      if (dprMq) dprMq.removeEventListener('change', onDpr);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', applyLayout);
      if (ctx && ctx.close) setTimeout(() => ctx.close().catch(() => {}), 120);
      root.remove(); container.classList.remove('vx-host');
    },
    // capture / tests: draw frame t (ms) without a running clock
    seek(ms, live = {}) {
      manualT = ms;
      if (live.doneAt !== undefined) doneAt = live.doneAt;
      if (live.fill !== undefined) { fill = live.fill; fillShown = live.fill; }
      if (!settledFired && ms >= V.settled) fireSettled();
      root.classList.toggle('vx--settled', ms >= V.settled);
      if (!o.handedOver) root.classList.toggle('vx--done', doneAt !== null && ms >= doneAt + HANDOVER.total);
      paint(ms);
    },
    plan() { return soundPlan(variant, L); },
    layout() { return { ...L }; },
    timeline() { return { ...V, letters: undefined }; },
    get keysActive() { return keysOn; },    // tests: is the window keydown listener attached
  };
}

// Full intro on the first launch after an install or update, the short one otherwise.
export function pickVariant(version, key = 'velox.intro.seen') {
  try {
    if (localStorage.getItem(key) === String(version)) return 'short';
    localStorage.setItem(key, String(version));
  } catch (e) { /* no storage: be modest */ return 'short'; }
  return 'full';
}

export const VeloxIntro = { mount, pickVariant, render, soundPlan, handoverPlan, layoutFor, VARIANTS, HANDOVER, HANDOVER_TRAVEL: HANDOVER.travel, Sound };
export default VeloxIntro;
