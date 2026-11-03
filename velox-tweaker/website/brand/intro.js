// VELOX start sequence "Versatz" - the brand intro for every surface.
//
//   import { VeloxIntro } from './brand/intro.js';
//   const intro = VeloxIntro.mount(document.getElementById('stage'), { variant: 'long' });
//   intro.status('System wird gelesen'); intro.progress(0.4);
//   await intro.done();                       // hand-over: the loader segment snaps into the cut
//   intro.destroy();                          // always: releases the keyboard, the audio context
//
// The long intro ("Zündung", the default for every launch; 'full' is its old name), 3.0 s:
// an ember catches at the V's end of the cut and charges once, then fires a light streak along
// the cut that draws the letters' outlines white-hot (they cool to ember), the blade opens them
// out of the cut, light races along the cut while the word sinks into a dark silhouette and
// the frame closes in on it, one held breath (a needle of white-hot light in the cut), then
// the strike: the upper halves slam into a hard stop, the word flashes white for two frames
// and cools from the cut outwards (white -> amber -> orange), the camera punches in, sparks
// fly forward off the halves' leading edges, a narrow sheared sweep crosses the finished word
// and a low ember stays in the cut until the hand-over.
// render(t) is a pure function of time: it returns the whole picture (in glyph units) and the
// sound plan is sampled from it, so picture and sound cannot drift. The word is SVG moved by
// transforms; the light on the letters (outlines, rims, the sweep) is SVG too, so it is as
// crisp as the letters; the light in the cut and around the word is drawn on one 2D canvas
// (no WebGL), the needle-thin core of the cut is one DOM line. No inline styles or scripts
// (CSP script-src/style-src 'self' - CSSOM is used).
import { GLYPHS as G } from './glyphs.js';
import * as Sound from './sound.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const CUT_MID = (G.cutTop + G.cutBot) / 2;
const V_FOOT = 29;                           // x of the V's lower-left corner: the alignment edge
const INK_R = G.w;                           // right edge of the settled word
const LOAD_GAP = 46;                         // baseline -> loader hairline, in glyph units
const SLOT_GAP = 40;                         // baseline -> slot (installer content), glyph units
const WORD_CX = (22 + G.w) / 2;              // the camera's centre (x), glyph units; y = 50

// ------------------------------------------------------------------ timelines (ms)
// The strike, in three phases:
//   release -> contact   the upper halves are thrown from the draw-back (x0) to a hard stop at
//                        `peak` (past the lock at +7), constant acceleration: they arrive fast.
//   contact -> +hold     hit-stop: everything freezes at the stop for `hold` ms - the upper
//                        halves at the peak, the word popped, the lower halves recoiled. The
//                        crack of the sound sits on the first frozen frame.
//   then                 a damped spring from the peak (at rest) to +7:
//                        x(s) = 7 + (peak - 7) e^(-s/tau) (cos ws + sin(ws) / (w tau)),
//                        one undershoot, settled < 0.25 units 130 ms later.
export const VARIANTS = {
  long: {
    name: 'long', light: true,
    // act 1 - the ember catches, charges once (and fires the first streak)
    ember: 60, charge: [90, 400],
    // act 2 - build-up: the streak runs the cut and draws the outlines, then the blade opens the
    // letters (as in the old full intro), then light races along the cut, the word sinks into a
    // silhouette and the frame closes in
    pass1: { t0: 400, dur: 380, p: 1.45 },
    bladeIn: 760, wordAt: 860, speed: 2.35, len: 170, openDur: 300,
    lag: 10, wind: 3.5, windAt: 1100, windEase: true,
    loadAt: 1080, pushAt: 1010, gapAt: 1610,
    rush: [[1145, 160], [1240, 140], [1322, 122], [1392, 106], [1450, 92], [1498, 80], [1538, 70]],
    // act 3 - ignition (after ~110 ms of held breath)
    release: 1694, strike: 26, hold: 33, peak: 13.2,
    spring: { tau: 40, w: 0.06 },
    pop: 0.035, recoil: 2.5, push: 0.04, punch: 0.032,
    // act 4 - resolution: the sweep; from `calm` on the word is at rest (done() may hand over)
    sweep: [2200, 350], calm: 2550, residual: 0.14,
    loadIn: 2400, loadDur: 400, settled: 3000,
  },
  short: {
    name: 'short', light: true, flash: true,
    bladeIn: 40, wordAt: 40, speed: 3.2, len: 120, openDur: 240, fromV: true,
    lag: -2, wind: 0.8, windAt: 300, release: 335, strike: 17, hold: 17, peak: 8.9,   // lag -2: ELOX wait 5 units behind (more would collide with the fixed V)
    spring: { tau: 30, w: 0.075 },
    pop: 0.012, recoil: 0.9, loadIn: 430, loadDur: 300, settled: 760,
  },
  reduced: { name: 'reduced', fade: 600, loadIn: 250, loadDur: 500, settled: 800 },
  still: { name: 'still', settled: 0 },
};
for (const V of Object.values(VARIANTS)) if (V.calm === undefined) V.calm = V.settled;   // the earliest hand-over
VARIANTS.full = VARIANTS.long;               // 'full' (1.2.0's 1.6 s intro) now plays the long one

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const expoOut = (u) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * u));
const cubicOut = (u) => 1 - Math.pow(1 - u, 3);
const smooth = (u) => u * u * (3 - 2 * u);
const inOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
// a pulse: fast rise (atk), exponential fall (dec)
const env = (x, atk, dec) => (x <= 0 ? 0 : (1 - Math.exp(-x / atk)) * Math.exp(-x / dec));

// position of the upper halves s ms after the hit-stop ends (starts at the peak, at rest)
function springAt(V, s) {
  const sp = V.spring, X = G.offset, A = V.peak - X;
  return X + A * Math.exp(-s / sp.tau) * (Math.cos(sp.w * s) + Math.sin(sp.w * s) / (sp.w * sp.tau));
}
// derived once per variant
for (const V of [VARIANTS.long, VARIANTS.short]) {
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

// a light streak crossing from `from` to `to` (glyph units) in dur ms, head = from + d u^p.
// Returns the head (it keeps going past `to`), its speed (units/ms) and u.
function streakAt(t, t0, dur, from, to, p = 1) {
  const u = (t - t0) / dur;
  if (u < 0) return null;
  return { head: from + (to - from) * Math.pow(u, p), v: (to - from) * p * Math.pow(Math.max(u, 1e-3), p - 1) / dur, u };
}

// the strike: upper-half offset, word scale, lower-half recoil at time t
function strikeAt(V, t) {
  if (t >= V.calm) return { dx: G.offset, scale: 1, rec: 0 };              // exact rest pose (the motion has died out by then)
  if (t < V.windAt) return { dx: -V.lag, scale: 1, rec: 0 };
  if (t < V.release) {
    const w = (t - V.windAt) / (V.release - V.windAt);
    return { dx: -V.lag - V.wind * (V.windEase ? inOut(w) : 1 - (1 - w) * (1 - w)), scale: 1, rec: 0 };
  }
  if (t < V.contact) { const u = (t - V.release) / V.strike; return { dx: V.from + (V.peak - V.from) * u * u, scale: 1, rec: 0 }; }
  if (t < V.contact + V.hold) return { dx: V.peak, scale: 1 + V.pop, rec: -V.recoil };   // hit-stop: hard, no easing
  const s = t - V.contact - V.hold;
  return {
    dx: springAt(V, s),
    scale: 1 + V.pop * Math.exp(-s / 28) * Math.cos(V.spring.w * s),
    rec: -V.recoil * Math.exp(-s / 30) * Math.cos(2 * Math.PI * s / 110),
  };
}

// ------------------------------------------------------------------ light
// Light is a list of primitives in glyph units, drawn additively on one canvas over the word.
// `back` is light inside the cut and behind the letters (the letters are cut out of it),
// `front` is light on the letters (outlines, lit faces, bloom, sweep) and the sparks.
// Colour is a temperature T on one ramp derived from the signal orange:
// deep ember -> signal #FF5A1F -> amber -> white-hot. Nothing else.
const HEAT = [[0, 46, 10, 4], [0.2, 128, 26, 6], [0.4, 255, 90, 31], [0.62, 255, 146, 56], [0.82, 255, 206, 148], [1, 255, 247, 236]];
export function heat(T) {
  T = clamp01(T);
  for (let i = 1; i < HEAT.length; i++) {
    if (T <= HEAT[i][0]) {
      const a = HEAT[i - 1], b = HEAT[i], u = (T - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }
  }
  return HEAT[HEAT.length - 1].slice(1);
}
const rgba = (T, a) => { const c = heat(T); return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(4)})`; };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// the leading edge of each upper half at the cut (its right-most corner on the cut line): where
// the strike makes contact, so that is where the sparks come from
export const LEAD = G.letters.map((l) => {
  const n = l.top.match(/-?\d+(\.\d+)?/g).map(Number);
  let x = -Infinity;
  for (let i = 0; i + 1 < n.length; i += 2) if (Math.abs(n[i + 1] - G.cutTop) < 0.01) x = Math.max(x, n[i]);
  return x;
});
// sparks thrown off the strike: from the leading edges of the five upper halves, forward only
// (the strike's direction) in a ~40 deg cone, with a slight gravity arc. Tapered streaks (a hot
// head cooling to an ember tail, length = speed x shutter) and three heavier, slower embers.
// Seeded: the same sparks every time. They fly behind the letters (light in the cut).
export const SPARKS = (() => {
  const r = mulberry32(9), out = [];
  [3, 2, 2, 3, 7].forEach((n, i) => {                      // per letter: the X throws into open space
    for (let j = 0; j < n; j++) {
      const sp = 0.7 + 1.9 * Math.pow(r(), 1.4), ang = (r() - 0.6) * 0.72;
      out.push({ i, x: LEAD[i] + 0.4, y: G.cutTop + 0.6 + 3 * r(), vx: sp * Math.cos(ang), vy: sp * Math.sin(ang),
        life: 170 + 380 * r(), drag: 140 + 130 * r(), g: 0.00024, w: 0.65 + 0.7 * r(), heavy: false });
    }
  });
  for (const i of [4, 3, 4]) {
    const sp = 0.2 + 0.22 * r(), ang = (r() - 0.55) * 0.5;
    out.push({ i, x: LEAD[i] + 0.4, y: G.cutTop + 1 + 3 * r(), vx: sp * Math.cos(ang), vy: sp * Math.sin(ang),
      life: 620 + 300 * r(), drag: 420, g: 0.00042, w: 1.9 + 0.8 * r(), heavy: true });
  }
  return out;
})();
const SPARKS_SMALL = SPARKS.filter((q, i) => !q.heavy && i % 2 === 0);
export function sparkAt(p, s) {
  const k = p.drag * (1 - Math.exp(-s / p.drag));
  return [p.x + p.vx * k, p.y + p.vy * k + (p.g === undefined ? 0.00028 : p.g) * s * s];
}

const push = (list, o) => { if (o.a > 0.003) list.push(o); };
const line = (list, x0, x1, y, h, T, a) => push(list, { k: 'line', x0, x1, y, h, T, a });
const streak = (list, x0, x1, y, h, T, a) => push(list, { k: 'streak', x0, x1, y, h, T, a });
const dot = (list, x, y, rx, ry, T, a) => push(list, { k: 'dot', x, y, rx, ry, T, a });

// one streak of light with motion blur: a white-hot core, a coloured halo, a hot head
function lightStreak(list, head, v, y, o) {
  const tail = Math.max(o.minTail || 30, Math.min(o.maxTail || 420, v * (o.shutter || 50)));
  const Lt = tail * 1.8;                      // halo + anamorphic head glint in one sprite, the hot core on top
  push(list, { k: 'comet', x0: head - 0.93 * Lt, x1: head + 0.07 * Lt, y, h: o.halo * 2.4, T: o.T - 0.12, a: o.a });
  streak(list, head - tail, head, y, o.core, Math.min(1, o.T + 0.12), o.a);
}

// the letters' own colours while the light plays on them (the word is SVG; render() only says
// which colour): bone and signal at rest, a warm near-black silhouette before the strike
const BONE = [236, 233, 226], SIGNAL = [255, 90, 31], SIL = [31, 25, 22], SILV = [48, 18, 9];
const mix = (a, b, u) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
// the x range (glyph units) the SVG light on the letters is computed over
export const OVX = [-12, G.w + 16];

// the light sweep: a narrow band (about 2.5 % of the word), sheared like the stems, a white-hot
// core with amber falloff; it catches the letters' edges (SVG) and glints in the cut (canvas)
function sweepAt(st, back, su, k) {
  if (su <= 0 || su >= 1) return;
  const x = OVX[0] + (OVX[1] - OVX[0]) * (0.45 * su + 0.55 * inOut(su)), e = Math.pow(Math.sin(Math.PI * su), 0.5);
  st.ovS = { x, w: 5.5, a: e * k };
  const inWord = clamp01((x - G.cutLo + 20) / 30) * clamp01((G.cutHi + 12 - x) / 30);
  dot(back, x + 0.4, CUT_MID, 24, 3, 0.95, 0.95 * e * inWord * k);
}
// the ember that stays in the cut once the word has settled (static: drawn once)
const restEmber = (back, V) => line(back, G.cutLo - 4, G.cutHi + 4, CUT_MID, 8, 0.3, V.residual);

function renderLong(V, t, live, st) {
  const E = live.edgeU === undefined ? -60 : live.edgeU, R = live.rightU === undefined ? 560 : live.rightU;
  const TU = Math.max(live.topU === undefined ? -150 : live.topU, BAND[0] + 14), BU = Math.min(live.botU === undefined ? 250 : live.botU, BAND[1] - 14);
  const pu = live.pu || 0.5;                                       // glyph units per CSS px
  const hiQ = live.q !== 'low';                                    // adaptive quality: 'low' drops the veil and the bloom
  const back = [], front = [];
  st.light = { back, front };
  const sk = strikeAt(V, t);
  st.scale = sk.scale;
  for (let i = 0; i < 5; i++) st.letters.push({ open: expoOut(clamp01((t - V.openAt[i]) / V.openDur)), tdx: sk.dx, bdx: sk.rec });
  if (t >= V.settled) {                                            // at rest: only the low ember in the cut
    st.cam = 1;
    restEmber(back, V);
    st.light.key = 'rest';
    return;
  }
  const ce = V.contact, hit = t >= ce, inHold = hit && t < ce + V.hold, sh = Math.max(0, t - ce - V.hold);
  // camera: a slow push through the build-up, a punch on the strike, then it relaxes to rest
  let cam = 1;
  if (t >= V.calm) cam = 1;
  else if (hit) cam = 1 + V.punch * Math.exp(-sh / 85) + V.push * (1 - smooth(clamp01(sh / 760)));
  else if (t > V.pushAt) cam = 1 + V.push * Math.pow(clamp01((t - V.pushAt) / (V.gapAt - V.pushAt)), 3);
  st.cam = cam;

  // ---- act 1: the ember catches (three crackles) and charges once; the charge fires the streak
  const ch = V.charge, cu = clamp01((t - ch[0]) / (ch[1] - ch[0]));
  const q = t < ch[1] ? cu * cu * cu : Math.exp(-(t - ch[1]) / 70);
  const flick = [[0, 1], [23, 0.6], [51, 0.8]].reduce((s, [d, g]) => s + g * env(t - V.ember - d, 2, 28), 0);
  const emberA = smooth(clamp01((t - V.ember) / 70)) * (1 - smooth(clamp01((t - 800) / 160)));
  if (emberA > 0) {
    dot(back, G.cutLo - 1, CUT_MID, 6 + 36 * q, 2.2 + 7 * q, 0.3 + 0.5 * q, Math.min(1, 0.32 + 0.5 * q + 0.4 * flick) * emberA);
    dot(back, G.cutLo - 1, CUT_MID, 1.8 + 2.6 * q, 1 + 0.7 * q, 0.72 + 0.28 * q, Math.min(1, 0.65 + 0.35 * flick + 0.3 * q) * emberA);
    if (cu > 0 && t < ch[1] + 150) line(back, G.cutLo - 2, G.cutLo + 4 + 46 * cu * cu, CUT_MID, 2 + 3 * q, 0.4 + 0.45 * q, 0.7 * q * emberA);
  }

  // ---- act 2a: pass 1 - the charge fires a streak along the cut; it draws the outlines
  const P = V.pass1, pf = G.cutLo - 2, pt = R + 40;
  const p1 = streakAt(t, P.t0, P.dur, pf, pt, P.p);
  if (p1) {
    if (p1.u < 1.3) lightStreak(back, p1.head, p1.v, CUT_MID, { T: 0.9, a: 1, core: 3.2 * pu + 1.2, halo: 11, shutter: 45, minTail: 18 });
    const fade = 1 - smooth(clamp01((t - 1000) / 320));
    if (fade > 0) {
      // the outlines (SVG, crisp): white-hot where the head touches an edge, then they cool to
      // an ember glow; almost no light on the faces
      const tp = (x) => P.t0 + P.dur * Math.pow(clamp01((x - pf) / (pt - pf)), 1 / P.p);   // when the head passed x
      const xs = [];
      for (let i = 0; i <= 16; i++) xs.push(OVX[0] + (OVX[1] - OVX[0]) * i / 16);
      for (let d = -12; d <= 12; d += 2) xs.push(p1.head + d);
      xs.sort((a, b) => a - b);
      const stops = [];
      for (const x of xs) {
        if (x < OVX[0] || x > OVX[1]) continue;
        let T = 1, a;
        if (x >= p1.head) a = Math.exp(-Math.pow((x - p1.head) / 4, 2));
        else {
          const age = t - tp(x);
          T = 0.2 + 0.8 * Math.exp(-age / 70);
          a = (0.4 + 0.6 * Math.exp(-age / 45)) * Math.exp(-age / 650);
        }
        stops.push([x, T, a]);
      }
      st.ovG = { stops, fill: { x: p1.head, w: 9, T: 0.75, a: 0.1 }, w: 1.75, per: st.letters.map((l) => (1 - l.open) * fade), lag: V.lag };
    }
  }

  // ---- act 2b: the blade opens the letters out of the cut; light spills from the gap
  const b = bladeAt(V, t, E);
  if (b) {
    const Lt = b.head - b.tail + 90;
    push(back, { k: 'comet', x0: b.head - 0.93 * Lt, x1: b.head + 0.07 * Lt, y: CUT_MID, h: 26, T: 0.46, a: 0.9 });
    streak(back, b.tail, b.head, CUT_MID, 3.2 * pu + 1, 0.68, 1);
  }
  st.letters.forEach((l, i) => { if (l.open > 0 && l.open < 1) dot(back, G.letters[i].cx, CUT_MID, 34, 12, 0.64, 0.9 * Math.pow(1 - l.open, 1.4)); });

  // the heat the blade leaves in the cut; it builds up while the strike is loaded, and the word
  // goes down into a warm near-black silhouette, step by step with the rushes of light
  if (t >= V.wordAt && !hit) {
    const hx = Math.min(b ? b.head : G.cutHi, G.cutHi);
    const lu = clamp01((t - V.loadAt) / (V.gapAt - V.loadAt));
    const rushP = V.rush.reduce((s, r) => s + env(t - r[0], 10, 90), 0);
    const ha = smooth(clamp01((t - V.wordAt) / 200)) * (0.36 + 0.5 * Math.pow(lu, 1.7)) + 0.18 * rushP;
    const hT = 0.36 + 0.44 * Math.pow(lu, 1.5) + 0.06 * rushP;
    if (t > V.pushAt) {
      const d = 0.2 * smooth(clamp01((t - V.pushAt) / 120)) + V.rush.reduce((s, r) => s + 0.8 / V.rush.length * smooth(clamp01((t - r[0]) / 70)), 0);
      st.tone = { f: mix(BONE, SIL, d), v: mix(SIGNAL, SILV, d) };
    }
    if (t < V.gapAt) {
      // the backlight: the light in the cut grows until the word stands as a silhouette in it
      if (lu > 0) {
        dot(back, WORD_CX, CUT_MID, 290 + 50 * lu, 26 + 30 * lu, 0.34 + 0.26 * lu, 0.75 * Math.pow(lu, 1.6) + 0.15 * rushP * lu);
      }
      line(back, G.cutLo - 3, hx + 3, CUT_MID, 9 + 12 * lu, hT - 0.06, ha * 0.95);
      line(back, G.cutLo - 3, hx + 3, CUT_MID, 3 * pu + 1.5 * lu, hT + 0.18, Math.min(1, ha * 1.6));
      const na = smooth(clamp01((t - V.loadAt) / 300)) * (0.3 + 0.7 * lu);
      if (na > 0) st.needle = { x0: G.cutLo - 3, x1: hx + 3, w: 1, T: Math.min(1, hT + 0.3), a: na };
      // a rim light on the edges that face the cut, growing with the light in it
      if (t > V.pushAt) st.ovA = { T: Math.min(1, hT + 0.15), a: 0.2 * lu, R: 8, rT: Math.min(1, hT + 0.3), ra: Math.min(1, 0.12 + 0.7 * lu + 0.25 * rushP * lu), rR: 7, w: 1 };
    } else {                                                       // the held breath: a needle of white-hot light, nothing else
      line(back, E - 40, R + 40, CUT_MID, 5, 0.8, 0.28);
      st.needle = { x0: E - 40, x1: R + 40, w: 1, T: 1, a: 1 };
      st.ovA = { T: 1, a: 0.1, R: 4, rT: 1, ra: 0.6, rR: 3.5, w: 1 };
    }
  }
  // light racing along the cut, faster and hotter each time
  V.rush.forEach((r, j) => {
    const s = streakAt(t, r[0], r[1], E - 10, R + 80, 1);
    if (s && s.u < 1.3) lightStreak(back, s.head, s.v, CUT_MID + [0, -1.5, 1.5, -0.7, 0.7, 0, 0][j], { T: 0.8 + 0.03 * j, a: 1, core: 3.6 * pu + 0.8, halo: 10, shutter: 48, minTail: 80, dot: 12 });
  });
  // the frame closes in: two hairlines from the window's top and bottom converge on the cut
  {
    const u = clamp01((t - V.windAt) / (V.gapAt - V.windAt));
    if (u > 0 && t < V.gapAt) {
      const e = Math.pow(u, 2.3), a = 0.1 + 0.7 * u * u, T = 0.42 + 0.48 * u;
      for (const y0 of [TU - 2, BU + 2]) {
        const y = y0 + (CUT_MID - y0) * e;
        line(back, E - 40, R + 40, y, 3 * pu + 3 + 2 * u, T, a);
      }
    }
  }

  // ---- act 3: ignition
  if (hit) {
    const f = Math.exp(-sh / 90), g = Math.exp(-sh / 120), e1 = Math.exp(-sh / 300);
    const Tf = 0.3 + 0.7 * Math.exp(-sh / 160);                    // the cut cools: white -> amber -> orange -> ember
    line(back, G.cutLo - 4 - 12 * e1, G.cutHi + 4 + 12 * e1, CUT_MID, 8 + 20 * f, Tf, Math.min(1, V.residual + (0.6 - V.residual) * e1 + g));   // the cut bursts, then holds an ember
    line(back, E - 40, R + 40, CUT_MID, 3 * pu + 3 * f, 1, f);                              // white-hot, edge to edge (the needle is its core)
    if (sh < 700) st.needle = { x0: E - 40, x1: R + 40, w: inHold ? 3 : 1 + 2 * f, T: 0.55 + 0.45 * Math.exp(-sh / 140), a: inHold ? 1 : Math.exp(-sh / 200) };
    line(front, E - 60, R + 60, CUT_MID, 4 + 8 * f, Math.min(1, Tf + 0.1), 0.85 * f);       // anamorphic flare
    if (hiQ) line(front, E - 60, R + 60, CUT_MID, 28 + 22 * f, 0.5, 0.2 * g);               // its veil
    if (hiQ) push(back, { k: 'bloom', T: Tf, a: g });                                       // the halo: from the cut, round the letters' edges
    push(back, { k: 'sparks', s: sh, a: 1, dx: V.peak });                                   // off the halves' leading edges
    // the word: overexposed for the two frames of the hit-stop, then lit from the cut outwards
    if (inHold) {
      st.tone = { f: heat(1), v: heat(1) };
      st.ovA = { T: 1, a: 1, R: 30, rT: 1, ra: 1, rR: 14, w: 1.75 };
    } else {
      const hot = Math.exp(-sh / 9), r = 0.12 + 0.88 * smooth(clamp01((sh - 60) / 520));
      st.tone = r >= 1 && hot < 0.002 ? null : { f: mix(mix(SIL, BONE, r), heat(0.9), 0.75 * hot), v: mix(SIGNAL, heat(0.85), 0.6 * hot) };
      const out = 1 - smooth(clamp01((sh - 400) / 400));          // gone by `calm`
      const Tl = 0.32 + 0.68 * Math.exp(-sh / 120), la = Math.exp(-sh / 220) * out, ra = Math.exp(-sh / 300) * out;
      if (ra > 0.01) st.ovA = { T: Tl, a: la, R: 22 + 14 * Math.exp(-sh / 150), rT: Math.min(1, Tl + 0.15), ra, rR: 9, w: 1.5 };
    }
  }

  // ---- act 4: the light sweep across the finished word (sheared like the letters)
  sweepAt(st, back, (t - V.sweep[0]) / V.sweep[1], 1);
}

// the short intro keeps the 1.2.0 choreography; its strike now ignites too (small)
function renderShortLight(V, t, live, st) {
  const back = [], front = [];
  st.light = { back, front };
  if (t < V.contact || t >= V.settled) return;
  const E = live.edgeU === undefined ? -60 : live.edgeU, R = live.rightU === undefined ? 560 : live.rightU, pu = live.pu || 0.5;
  const sh = Math.max(0, t - V.contact - V.hold), f = Math.exp(-sh / 60), g = Math.exp(-sh / 110), Tf = 0.32 + 0.68 * Math.exp(-sh / 160);
  line(back, G.cutLo - 10, G.cutHi + 10, CUT_MID, 8 + 10 * f, Tf, 0.8 * g);
  line(back, E - 30, R + 30, CUT_MID, 2.4 * pu + 2 * f, 1, 0.8 * f);
  line(front, E - 40, R + 40, CUT_MID, 3 + 5 * f, Tf, 0.55 * f);
  if (live.q !== 'low') push(back, { k: 'bloom', T: Tf, a: 0.6 * g });
  push(back, { k: 'sparks', s: sh * 1.25, a: 0.6, n: 8, dx: V.peak });
  const la = Math.exp(-sh / 90);
  if (la > 0.01) st.ovA = { T: 0.4 + 0.6 * Math.exp(-sh / 60), a: 0.7 * la, R: 16, rT: 1, ra: la, rR: 8, w: 1.25 };
}

// celebrate(): the installer's finish, 1.3 s. The identity's own motion, small: while a streak
// runs the cut (220 ms) the upper halves draw back 1.8 units, then snap forward into the stop
// (a short hit-stop, a spring); the cut flashes, a few sparks fly, a narrow sweep crosses the
// word. Calm variant (reduced motion / still): an ember pulse in the cut, nothing moves.
export const CELEBRATE = { run: 220, strike: 20, draw: 1.8, peak: 8.7, hold: 17, spring: { tau: 34, w: 0.075 }, sweep: [430, 340], total: 1300 };
function celebrateAt(cs, st, calm, live) {
  if (cs < 0 || cs > CELEBRATE.total) return;
  const C = CELEBRATE, back = st.light.back, front = st.light.front;
  st.light.key = null;
  if (calm) {
    const a = Math.sin(Math.PI * clamp01(cs / 1100));
    line(back, G.cutLo - 4, G.cutHi + 4, CUT_MID, 9, 0.42, 0.6 * a);
    return;
  }
  const X = G.offset, rel = C.run - C.strike;
  let dx;
  if (cs < rel) dx = X - C.draw * inOut(cs / rel);
  else if (cs < C.run) { const u = (cs - rel) / C.strike; dx = X - C.draw + (C.peak - X + C.draw) * u * u; }
  else if (cs < C.run + C.hold) dx = C.peak;
  else { const s = cs - C.run - C.hold, sp = C.spring; dx = X + (C.peak - X) * Math.exp(-s / sp.tau) * (Math.cos(sp.w * s) + Math.sin(sp.w * s) / (sp.w * sp.tau)); }
  for (const l of st.letters) l.tdx = dx;
  const pu = live.pu || 0.5;
  const s = streakAt(cs, 0, C.run, G.cutLo - 60, G.cutHi + 6, 1.6);
  if (cs < C.run + 40) lightStreak(back, s.head, s.v, CUT_MID, { T: 0.85, a: 0.95, core: 3 * pu + 1, halo: 9, shutter: 40, dot: 9 });
  const reach = Math.min(G.cutHi, s.head);
  if (reach > G.cutLo && cs < C.run) line(back, G.cutLo - 3, reach + 3, CUT_MID, 7, 0.42, 0.5);
  const cc = cs - C.run;
  if (cc >= 0) {
    const pulse = env(cc, 10, 260), f = Math.exp(-cc / 70);
    line(back, G.cutLo - 8, G.cutHi + 8, CUT_MID, 8 + 12 * pulse, 0.4 + 0.5 * pulse, Math.min(1, pulse + 0.35 * Math.exp(-cc / 300) * (1 - smooth(clamp01(cc / 1000)))));
    if (cc < 400) st.needle = { x0: G.cutLo - 40, x1: G.cutHi + 60, w: 1 + f, T: 0.7 + 0.3 * f, a: f };
    if (live.q !== 'low') push(back, { k: 'bloom', T: 0.5 + 0.4 * pulse, a: 0.55 * pulse });
    push(back, { k: 'sparks', s: Math.max(0, cc - C.hold), a: 0.75, n: 8, dx: C.peak });
    line(front, G.cutLo - 60, G.cutHi + 60, CUT_MID, 3 + 4 * f, 0.9, 0.55 * f);
    if (pulse > 0.01) st.ovA = { T: 0.45 + 0.5 * f, a: 0.6 * pulse, R: 14, rT: Math.min(1, 0.6 + 0.4 * f), ra: Math.min(1, 0.9 * pulse), rR: 8, w: 1.5 };
  }
  sweepAt(st, back, (cs - C.sweep[0]) / C.sweep[1], 0.9);
}

// The pure picture. live = { edgeU, rightU, topU, botU, pu, doneAt, fill, celebAt, calm, q } (the
// edges and pu from the layout; doneAt, fill and celebAt only when the host called done() /
// progress() / celebrate(); q = 'low' when the adaptive quality stepped down). Everything is in
// glyph units except opacities and the loader's lift (px). Besides the word's pose it returns
// the light: `light` (canvas primitives), `tone` (the letters' fill colours, null = bone and
// signal), `ovA` (light from the cut on the letters' faces and rims), `ovG` (pass 1's
// outlines), `ovS` (the sweep) and `needle` (the white-hot core line in the cut).
export function render(variant, t, live = {}) {
  const V = VARIANTS[variant];
  const st = { wordAlpha: 1, scale: 1, cam: 1, letters: [], blade: null, loadAlpha: 0, loadLift: 0, seg: null, skipAlpha: 0, line: null,
    light: { back: [], front: [] }, tone: null, ovA: null, ovG: null, ovS: null, needle: null };
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
    if (V.name === 'long') renderLong(V, t, live, st);
    else {
      const sk = strikeAt(V, t);
      st.scale = sk.scale;
      for (let i = 0; i < 5; i++) {
        const open = V.openAt[i] === -Infinity ? 1 : expoOut(clamp01((t - V.openAt[i]) / V.openDur));
        const fixed = V.fromV && i === 0;                  // short: the V is already in place
        st.letters.push({ open, tdx: fixed ? G.offset : sk.dx, bdx: fixed ? 0 : sk.rec });
      }
      st.blade = bladeAt(V, t, live.edgeU === undefined ? -60 : live.edgeU);
      renderShortLight(V, t, live, st);
    }
    const k = cubicOut(clamp01((t - V.loadIn) / V.loadDur));
    st.loadAlpha = k; st.loadLift = (1 - k) * 6;
    st.seg = loopSeg(t - (V.loadIn + 150));
    st.skipAlpha = 1 - clamp01((t - V.settled + 200) / 200);
  }
  if (live.celebAt !== undefined && live.celebAt !== null) celebrateAt(t - live.celebAt, st, !!live.calm, live);
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
  // any remaining light (the ember in the cut) goes out with the loader: the end pose has none
  const fl = (l) => l.filter((p) => p.k !== 'sparks').map((p) => ({ ...p, a: p.a * (1 - fade) })).filter((p) => p.a > 0.003);
  st.light = { back: fl(at.light.back), front: fl(at.light.front) };
  st.tone = null; st.ovA = null; st.ovG = null; st.ovS = null; st.needle = null;
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
  if (variant === 'long' || variant === 'full') return longPlan(geo, pan, edgeU);
  const V = VARIANTS[variant], ev = [];
  const wordPan = pan((G.cutLo + G.cutHi) / 2);
  ev.push({ type: 'impact', t: V.contact, v: V.vContact / REF_V, small: true,
    tau: V.spring.tau / 1000, halfPeriod: Math.min(0.07, Math.PI / V.spring.w / 1000), pan: wordPan * 0.5 });
  ev.push({ type: 'spark', t: V.contact + 4, gain: 0.5, pan: wordPan * 0.5 });
  return { events: ev, fadeFrom: V.contact + 300, end: V.contact + 420, gain: 1.84 };   // the small hit (about -20 LUFS, 2 LU under the long cue)
}

// a whoosh that follows a light streak: its pan is the head's position, its level and its
// brightness peak as the head passes the middle of the window, its pitch drops as it passes
function whooshFor(headAt, t0, t1, geo, pan, o) {
  const step = 5, freq = [], gain = [], pn = [];
  const c = geo.cw / 2;
  for (let t = t0; t <= t1; t += step) {
    const h = headAt(t), X = geo.X0 + h * geo.k;
    const prox = Math.exp(-Math.pow((X - c) / (0.45 * geo.cw), 2));
    const onScreen = clamp01((X + 0.15 * geo.cw) / (0.3 * geo.cw)) * clamp01((geo.cw * 1.15 - X) / (0.3 * geo.cw));
    freq.push(o.fc * (0.55 + 0.75 * prox) * (1 + 0.28 * Math.tanh(-(X - c) / (0.2 * geo.cw))));
    gain.push(o.level * (0.25 + 0.75 * prox) * onScreen);
    pn.push(pan(h));
  }
  gain[0] = 0; gain[gain.length - 1] = 0;
  return { type: 'whoosh', t: t0, dur: (freq.length - 1) * step / 1000, freq, gain, pan: pn, q: o.q || 1.2, body: o.body || 0, seed: o.seed };
}

const REF_V = 2 * (12.8 + 12.5) / 26;        // 1.2.0's full strike: the short hit keeps its level

function longPlan(geo, pan, edgeU) {
  const V = VARIANTS.long, ev = [];
  const rightU = (geo.cw - geo.X0) / geo.k;
  const wordPan = pan((G.cutLo + G.cutHi) / 2);
  // act 1: the ember catches (crackles), a low drone opens, the ember charges once
  ev.push({ type: 'ember', t: V.ember, pan: pan(G.cutLo) });
  ev.push({ type: 'charge', t: V.charge[0], dur: (V.charge[1] - V.charge[0]) / 1000, pan: pan(G.cutLo) });
  {
    const step = 10, gain = [];
    for (let t = V.ember; t <= V.gapAt; t += step) {
      const lu = clamp01((t - V.loadAt) / (V.gapAt - V.loadAt));
      gain.push(smooth(clamp01((t - V.ember) / 500)) * (0.55 + 0.45 * lu));
    }
    gain[gain.length - 1] = 0;                                     // hard stop into the held breath
    ev.push({ type: 'drone', t: V.ember, dur: (gain.length - 1) * step / 1000, gain });
  }
  // act 2: pass 1 (fired by the charge), the blade (+ one dry click per letter), the rush
  const P = V.pass1;
  ev.push(whooshFor((t) => streakAt(t, P.t0, P.dur, G.cutLo - 2, rightU + 40, P.p).head, P.t0, P.t0 + P.dur * 1.15, geo, pan, { fc: 1300, level: 0.8, q: 1.1, body: 0.7, seed: 61 }));
  const bEnd = V.wordAt + (G.cutHi - V.x0) / V.speed;
  ev.push(whooshFor((t) => { const b = bladeAt(V, t, edgeU); return b ? b.head : G.cutHi; }, V.bladeIn, bEnd + 130, geo, pan, { fc: 2300, level: 0.6, q: 1.6, body: 0.3, seed: 62 }));
  const maxMass = Math.max(...G.letters.map((l) => l.mass));
  G.letters.forEach((l, i) => {
    const m = l.mass / maxMass, f = 2200 - 1000 * (m - 24 / 53) / (1 - 24 / 53);
    ev.push({ type: 'click', t: V.openAt[i], i, gain: 0.9 * (0.55 + 0.45 * m) * Math.sqrt(1300 / f), f, pan: pan(l.cx) });
  });
  V.rush.forEach((r, j) => {
    ev.push(whooshFor((t) => streakAt(t, r[0], r[1], edgeU - 10, rightU + 80, 1).head, r[0], r[0] + r[1] * 1.1, geo, pan, { fc: 2000 + 420 * j, level: 0.24 + 0.035 * j, q: 1.4, body: 0.35, seed: 63 + (j % 3) }));
  });
  // the riser: a tonal cluster and a noise band rising together, pulsing with the rush, then
  // sucked back (a reversed swell) and cut dead at the held breath. It starts under the last
  // letter's click, so the held breath is the only silence before the hit.
  {
    const r0 = Math.round(V.openAt[4]) - 6, step = 5, gain = [], ngain = [];
    for (let t = r0; t <= V.gapAt; t += step) {
      const u = (t - r0) / (V.gapAt - r0);
      const p = V.rush.reduce((s, r) => s + env(t - r[0], 6, 70), 0);
      gain.push((0.18 + 0.82 * Math.pow(u, 1.8)) * (0.8 + 0.35 * p) * smooth(clamp01(u / 0.08)));
      ngain.push((0.2 + 0.8 * Math.pow(u, 2.6)) * (0.7 + 0.5 * p) * smooth(clamp01(u / 0.08)));
    }
    gain[0] = 0; ngain[0] = 0; gain[gain.length - 1] = 0; ngain[ngain.length - 1] = 0;
    ev.push({ type: 'riser', t: r0, dur: (gain.length - 1) * step / 1000, gain, ngain, f0: 96, f1: 192, cut0: 260, cut1: 2600, rev: 0.26 });
  }
  // act 3: the impact on the stop, on the same sample as the picture
  ev.push({ type: 'impactXL', t: V.contact, v: 1, tau: V.spring.tau / 1000, halfPeriod: Math.min(0.07, Math.PI / V.spring.w / 1000), pan: wordPan * 0.5 });
  // act 4: the tail (the impact's metal rings on into a quiet chord that resolves with the
  // sweep), the sweep's glint
  const resolveAt = V.sweep[0] + V.sweep[1] * 0.5;
  ev.push({ type: 'tail', t: V.contact + 20, resolve: (resolveAt - V.contact - 20) / 1000, dur: (V.settled + 600 - V.contact) / 1000 });
  {
    const step = 10, pn = [];
    for (let t = V.sweep[0]; t <= V.sweep[0] + V.sweep[1]; t += step) pn.push(pan(OVX[0] + (OVX[1] - OVX[0]) * (0.45 * (t - V.sweep[0]) / V.sweep[1] + 0.55 * inOut((t - V.sweep[0]) / V.sweep[1]))));
    ev.push({ type: 'glint', t: V.sweep[0], dur: (pn.length - 1) * step / 1000, pan: pn, ting: null });
  }
  return { events: ev, fadeFrom: V.settled + 400, end: V.settled + 700, gain: 1, name: 'long', reverb: true, gate: [V.gapAt + 2, V.contact] };
}

export function handoverPlan(pan = 0) {
  return { events: [{ type: 'snap', t: 0, pan }], fadeFrom: 160, end: 220, gain: 1 };
}

// celebrate(): a small cue - the streak's whoosh, a thump on the stop of the re-lock, a bright
// resolved chord (the tail's G major, two octaves up) and the sweep's glint
export function celebratePlan(geo = { k: 1, X0: 60, cw: 880 }, calm = false) {
  const pan = (u) => Math.max(-0.85, Math.min(0.85, -0.85 + 1.7 * (geo.X0 + u * geo.k) / geo.cw));
  const C = CELEBRATE, ev = [];
  if (!calm) {
    ev.push(whooshFor((t) => streakAt(t, 0, C.run, G.cutLo - 60, G.cutHi + 6, 1.6).head, 0, C.run + 20, geo, pan, { fc: 2600, level: 0.5, q: 1.5, body: 0.2, seed: 66 }));
    const pn = [];
    for (let t = C.sweep[0]; t <= C.sweep[0] + C.sweep[1]; t += 10) pn.push(pan(OVX[0] + (OVX[1] - OVX[0]) * (0.45 * (t - C.sweep[0]) / C.sweep[1] + 0.55 * inOut((t - C.sweep[0]) / C.sweep[1]))));
    ev.push({ type: 'glint', t: C.sweep[0], dur: (pn.length - 1) * 10 / 1000, pan: pn, ting: null, quiet: true });
    ev.push({ type: 'thump', t: C.run, gain: 1, pan: pan((G.cutLo + G.cutHi) / 2) * 0.5 });
  } else ev.push({ type: 'beat', t: 80, gain: 0.35 });
  ev.push({ type: 'chime', t: calm ? 80 : C.run, pan: pan(G.cutHi) * 0.4 });
  return { events: ev, fadeFrom: 1700, end: 1900, gain: 3.2, name: 'celebrate', reverb: true };   // about -22 LUFS: small, but clear
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
  return { cw, ch, m, cap, k, top, X0, fs, edgeU: -X0 / k, rightU: (cw - X0) / k, topU: -top / k, botU: (ch - top) / k, pu: 1 / k, place, dpr, band, ox, oy };
}

// camera (about the word's centre) and pop (about the V's foot), folded into one transform:
// glyph u -> px A + B u. At rest A = (X0, top), B = k: the device-pixel-snapped pose.
export function cameraXf(st, L) {
  const k = L.k, c = st.cam || 1, p = st.scale;
  const Cx = L.X0 + WORD_CX * k, Cy = L.top + 50 * k, Fx = L.X0 + V_FOOT * k, Fy = L.top + 100 * k;
  return { c, p, B: c * p * k, Ax: Cx + c * (Fx + p * (L.X0 - Fx) - Cx), Ay: Cy + c * (Fy + p * (L.top - Fy) - Cy) };
}
export const lightParams = (L, xf, res, lag) => ({ dpr: res, pu: Math.max(L.pu, 1.4 / (res * L.k)) / (xf.c * xf.p), lag, fade: 12 * L.k });
export const liveOf = (L, extra) => ({ edgeU: L.edgeU, rightU: L.rightU, topU: L.topU, botU: L.botU, pu: L.pu, ...extra });

// ------------------------------------------------------------------ the light painter
// One canvas over the word, cleared and redrawn only while there is light. Sprites (a streak,
// a soft line, a soft dot) are rendered once in white and tinted per temperature on first use
// (49 steps), so a frame is a few dozen drawImage calls: no blur filters, no shadows per frame.
const SPRITE = { line: [256, 32], streak: [256, 32], dot: [64, 64], comet: [256, 64], spark: [128, 16] };
function spriteAlpha(shape, x, y) {          // x, y in 0..1
  const yn = y * 2 - 1, prof = (0.72 * Math.exp(-Math.pow(yn / 0.14, 2)) + 0.28 * Math.exp(-Math.pow(yn / 0.46, 2))) * (1 - yn * yn);
  if (shape === 'line') return prof * smooth(clamp01(x / 0.035)) * smooth(clamp01((1 - x) / 0.035));
  if (shape === 'streak') return prof * Math.pow(x, 2.1) * (1 - smooth(clamp01((x - 0.965) / 0.035)));
  if (shape === 'comet') {                   // halo with a motion-blurred tail, and an anamorphic glint at the head (x = 0.93)
    const halo = 0.42 * Math.exp(-Math.pow(yn / 0.36, 2)) * Math.pow(x, 2.4) * (1 - smooth(clamp01((x - 0.94) / 0.06)));
    const gl = Math.exp(-Math.pow((x - 0.93) / 0.045, 2)) * (0.75 * Math.exp(-Math.pow(yn / 0.1, 2)) + 0.25 * Math.exp(-Math.pow(yn / 0.45, 2)));
    return Math.min(1, (halo + gl) * (1 - yn * yn));
  }
  if (shape === 'spark') {                   // a tapered streak: thin, faint tail (x = 0) -> full width at the head (x = 1)
    const wd = 0.22 + 0.78 * x;
    return Math.exp(-3.2 * Math.pow(yn / wd, 2)) * (1 - yn * yn) * Math.pow(x, 1.4) * (1 - smooth(clamp01((x - 0.96) / 0.04)));
  }
  const xn = x * 2 - 1, r2 = xn * xn + yn * yn;
  return r2 >= 1 ? 0 : (0.62 * Math.exp(-r2 / 0.03) + 0.38 * Math.exp(-r2 / 0.2)) * (1 - r2);
}
const TOPS = typeof Path2D === 'undefined' ? [] : G.letters.map((l) => new Path2D(l.top));
const BOTS = typeof Path2D === 'undefined' ? [] : G.letters.map((l) => new Path2D(l.bot));
const BLOOM_PAD = 32, BLOOM_RES = 0.5;
const BLOOM_T = [0.32, 0.4, 0.48, 0.56, 0.64, 0.72, 0.8, 0.9, 1];   // the bloom's pre-tinted temperatures (nearest is drawn)
const BAND = [-30, 130];                      // the light canvas: glyph rows it covers (at camera 1)
const WORKER_WAIT = 900;                        // ms the boot waits for the light worker before drawing on the main thread
export const LIGHT_PX = 150000;               // the light canvas's pixel budget ('low' quality: half)

export function makePainter(canvas) {
  const ctx = canvas.getContext('2d');
  const cache = new Map();
  let dirty = false, queue = null, lastKey = null;
  const mk = (w, h) => { if (typeof document === 'undefined') return new OffscreenCanvas(w, h); const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function base(shape) {
    const key = 'b' + shape;
    if (cache.has(key)) return cache.get(key);
    const [w, h] = SPRITE[shape], c = mk(w, h), g = c.getContext('2d'), img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * clamp01(spriteAlpha(shape, (x + 0.5) / w, (y + 0.5) / h)));
    }
    g.putImageData(img, 0, 0);
    cache.set(key, c);
    return c;
  }
  // the bloom: light from the cut wrapping round the letters' edges. The settled word, blurred
  // tight (4 + 12 units), weighted by its distance from the cut (falls off over ~12 units), so
  // the halo hugs the edges that face the cut instead of outlining every letter evenly.
  function bloomMask() {
    const key = 'm';
    if (cache.has(key)) return cache.get(key);
    const w = Math.ceil((G.w + 2 * BLOOM_PAD) * BLOOM_RES), h = Math.ceil((100 + 2 * BLOOM_PAD) * BLOOM_RES);
    const src = mk(w, h), s = src.getContext('2d');
    s.setTransform(BLOOM_RES, 0, 0, BLOOM_RES, BLOOM_PAD * BLOOM_RES, BLOOM_PAD * BLOOM_RES);
    s.fillStyle = '#fff';
    s.save(); s.translate(G.offset, 0); for (const p of TOPS) s.fill(p); s.restore();
    for (const p of BOTS) s.fill(p);
    const c = mk(w, h), g = c.getContext('2d');
    if ('filter' in g) {
      g.filter = 'blur(2px)'; g.drawImage(src, 0, 0);
      g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.7; g.filter = 'blur(6px)'; g.drawImage(src, 0, 0);
      g.filter = 'none';
    } else g.drawImage(src, 0, 0);
    const img = g.getImageData(0, 0, w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      const gy = y / BLOOM_RES - BLOOM_PAD, wy = Math.exp(-Math.max(0, Math.abs(gy - CUT_MID) - 4) / 12);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4 + 3, v = d[i] * wy;
        d[i] = v <= 6 ? 0 : Math.round((v - 6) * 255 / 249);   // the blur's last 8-bit steps: nothing, not a faint dark box
      }
    }
    g.putImageData(img, 0, 0);
    cache.set(key, c);
    return c;
  }
  function tinted(key, make, T) {
    const q = Math.round(clamp01(T) * 48), k = key + ':' + q;
    let c = cache.get(k);
    if (c) return c;
    const b = make();
    c = mk(b.width, b.height);
    const g = c.getContext('2d');
    g.drawImage(b, 0, 0); g.globalCompositeOperation = 'source-in';
    const col = heat(q / 48); g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`; g.fillRect(0, 0, c.width, c.height);
    cache.set(k, c);
    return c;
  }
  const spr = (shape, T) => tinted(shape, () => base(shape), T);

  function lettersPath(pose, half) {
    const p = new Path2D(), set = half === 't' ? TOPS : BOTS;
    pose.forEach((l, i) => {
      if (l.open <= 0) return;
      const dy = half === 't' ? (1 - l.open) * (G.cutTop + 4) : -(1 - l.open) * (100 - G.cutBot + 4);
      p.addPath(set[i], { a: 1, b: 0, c: 0, d: 1, e: half === 't' ? l.tdx : l.bdx, f: dy });
    });
    return p;
  }
  function eachHalf(pose, fn) {
    for (const half of ['t', 'b']) {
      ctx.save();
      ctx.beginPath();
      if (half === 't') ctx.rect(-400, -400, G.w + 800, G.cutTop + 400); else ctx.rect(-400, G.cutBot, G.w + 800, 500);
      ctx.clip();
      fn(lettersPath(pose, half), half);
      ctx.restore();
    }
  }

  function prim(p, st, P) {
    ctx.globalAlpha = 1;
    switch (p.k) {
      case 'line': case 'streak': case 'comet':
        if (p.x1 - p.x0 <= 0.01) return;
        ctx.globalAlpha = Math.min(1, p.a);
        ctx.drawImage(spr(p.k, p.T), p.x0, p.y - p.h / 2, p.x1 - p.x0, p.h);
        return;
      case 'dot':
        ctx.globalAlpha = Math.min(1, p.a);
        ctx.drawImage(spr('dot', p.T), p.x - p.rx, p.y - p.ry, 2 * p.rx, 2 * p.ry);
        return;
      case 'bloom': {
        // a few pre-tinted levels (a fresh tint per frame would allocate a canvas per frame)
        const W = G.w + 2 * BLOOM_PAD, H = 100 + 2 * BLOOM_PAD;
        const lt = st.letters[1] || st.letters[0];
        let T = BLOOM_T[0];
        for (const b of BLOOM_T) if (Math.abs(b - p.T) < Math.abs(T - p.T)) T = b;
        ctx.globalAlpha = Math.min(1, p.a);
        ctx.drawImage(tinted('m', bloomMask, T), -BLOOM_PAD + (lt.tdx - G.offset) / 2, -BLOOM_PAD, W, H);
        return;
      }
      case 'sparks': {
        const list = p.n ? SPARKS_SMALL.slice(0, p.n) : SPARKS, dx = p.dx || 0;
        for (const q of list) {
          const s = p.s;
          if (s <= 0 || s >= q.life) continue;
          const age = s / q.life;
          const [hx, hy] = sparkAt(q, s), [tx, ty] = sparkAt(q, Math.max(0, s - (q.heavy ? 34 : 22)));   // shutter: the streak is speed x 22 ms long
          const a = p.a * (1 - age * age) * clamp01((64 - Math.abs(hy - CUT_MID)) / 16);
          if (a <= 0.004) continue;
          const x1 = hx + dx, x0 = tx + dx, len = Math.hypot(x1 - x0, hy - ty);
          const w = q.w * P.pu * (q.heavy ? 1.1 : 1.7);
          const T = q.heavy ? 0.66 - 0.36 * age : 1 - 0.72 * Math.pow(age, 0.7);   // a hot head, cooling to ember
          if (len > 0.2) {
            ctx.save();
            ctx.translate(x0, ty); ctx.rotate(Math.atan2(hy - ty, x1 - x0));
            ctx.globalAlpha = Math.min(1, a);
            ctx.drawImage(spr('spark', T - 0.12), 0, -w / 2, len, w);
            ctx.restore();
          }
          ctx.globalAlpha = Math.min(1, a * (q.heavy ? 1 : 1 - age));
          const r = w * (q.heavy ? 1.3 : 0.8);
          ctx.drawImage(spr('dot', Math.min(1, T + 0.15)), x1 - r, hy - r, 2 * r, 2 * r);
        }
        return;
      }
      default:
    }
  }

  return {
    // xf: [scale, tx, ty] maps glyph units to CSS px of the canvas; dpr: device px per CSS px
    paint(st, xf, P) {
      const L = st.light || { back: [], front: [] };
      const any = L.back.length + L.front.length > 0;
      if (!any && !dirty) return;
      // a static light (the ember at rest) is drawn once, not every frame of the loader
      const key = any && L.key ? L.key + ':' + xf.map((v) => v.toFixed(3)).join(',') + ':' + canvas.width + 'x' + canvas.height : null;
      if (key && key === lastKey) return;
      lastKey = key;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = any;
      if (!any) return;
      const d = P.dpr;
      ctx.setTransform(xf[0] * d, 0, 0, xf[0] * d, xf[1] * d, xf[2] * d);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of L.back) prim(p, st, P);
      if (L.back.length) {                       // the letters stand in front of the light in the cut
        ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1;
        eachHalf(st.letters, (path) => { ctx.fillStyle = '#000'; ctx.fill(path); });
        ctx.globalCompositeOperation = 'lighter';
      }
      for (const p of L.front) prim(p, st, P);
      // soft top and bottom edges: no light ever ends on a hard line
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'destination-out';
      const fp = Math.max(4, Math.round(P.fade * P.dpr)), H = canvas.height, W = canvas.width;
      for (const [y0, y1] of [[0, fp], [H, H - fp]]) {
        const gr = ctx.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, Math.min(y0, y1), W, fp);
      }
      ctx.globalCompositeOperation = 'source-over';
    },
    // build what the first frames need, ahead of time (boot, in its own task) ...
    warm(Ts) { for (const T of Ts) { spr('line', T); spr('streak', T); spr('dot', T); spr('comet', T); } },
    // ... and everything else in small slices while act 1 is still dark (returns false when done)
    warmStep(n) {
      if (!queue) {
        queue = [];
        for (const T of BLOOM_T) queue.push(() => tinted('m', bloomMask, T));
        for (let q = 48; q >= 0; q--) for (const sh of ['line', 'streak', 'dot', 'comet', 'spark']) queue.push(() => spr(sh, q / 48));
      }
      for (let k = 0; k < n && queue.length; k++) queue.shift()();
      return queue.length > 0;
    },
    // the canvas was resized (or handed new content from outside): the next paint draws again
    invalidate() { lastKey = null; dirty = true; },
    get dirty() { return dirty; },
    lit() { const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; return n; },
  };
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
    variant: 'long', sound: true, muted: undefined, reducedMotion: 'auto', place: 'hero', loader: true,
    labels: null, statusText: 'Dienst wird gestartet', clock: 'auto', onMuteChange: null, handedOver: false, ...opts,
  };
  let reduced = o.reducedMotion === true;
  if (o.reducedMotion === 'auto') {
    reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    try { if (new URLSearchParams(location.search).get('reduced') === '1') reduced = true; } catch (e) { /* opaque origin */ }
  }
  // the timeline that plays ('full' is the long one) and the name the host asked for
  const variant = o.variant === 'still' ? 'still' : reduced ? 'reduced' : (o.variant === 'short' ? 'short' : 'long');
  const asked = variant === 'long' ? (o.variant === 'full' ? 'full' : 'long') : variant;
  const V = VARIANTS[variant];
  const manual = o.clock === 'manual';
  const hasSound = !!o.sound && variant !== 'still';        // still never plays a cue: no sound UI either

  // ---- DOM
  container.classList.add('vx-host');
  const root = el('div', 'vx vx--' + asked + (asked !== variant ? ' vx--' + variant : '') + ' vx--' + o.place + (o.loader ? '' : ' vx--noload'), container);
  root.classList.add('vx--boot');
  const labels = el('div', 'vx-labels', root);
  const labL = el('span', 'vx-label', labels), labR = el('span', 'vx-label vx-label-r', labels);
  if (o.labels) { const lb = Array.isArray(o.labels) ? o.labels : [null, o.labels]; labL.textContent = lb[0] || ''; labR.textContent = lb[1] || ''; }
  labels.setAttribute('aria-hidden', 'true');
  const blade = el('div', 'vx-blade', root); blade.setAttribute('aria-hidden', 'true');
  const needle = el('div', 'vx-needle', root); needle.setAttribute('aria-hidden', 'true');   // the white-hot core of the cut: whole device pixels, crisp
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
  // The light ON the letters is SVG as well (as crisp as the letters at any scale): three
  // overlay layers per half, each a copy of the five pieces painted with a gradient that
  // render() describes every frame - A: light from the cut (faces + a rim on the edges facing
  // it), G: pass 1's outlines (ghost pose), S: the sweep. Hidden while render() has none.
  const grads = {};
  function gradient(id, n) {
    const g = document.createElementNS(SVGNS, 'linearGradient');
    g.setAttribute('id', uid + id); g.setAttribute('gradientUnits', 'userSpaceOnUse');
    const stops = [];
    for (let i = 0; i < n; i++) { const s = document.createElementNS(SVGNS, 'stop'); g.appendChild(s); stops.push(s); }
    defs.appendChild(g);
    return (grads[id] = { g, stops, n, last: [] });
  }
  for (const h of ['t', 'b']) { gradient('Gs' + h, 30); gradient('Gf' + h, 5); gradient('S' + h, 9); }
  gradient('Af', 10); gradient('As', 10);
  const ov = { t: {}, b: {} };
  for (const [h, grp, set] of [['t', gT, 'top'], ['b', gB, 'bot']]) {
    for (const [layer, fill, stroke] of [['G', 'Gf' + h, 'Gs' + h], ['A', 'Af', 'As'], ['S', 'S' + h, 'S' + h]]) {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('fill', `url(#${uid}${fill})`); g.setAttribute('stroke', `url(#${uid}${stroke})`);
      g.setAttribute('stroke-linejoin', 'round'); g.setAttribute('display', 'none'); g.setAttribute('class', 'vx-ov');
      const paths = G.letters.map((l) => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', l[set]); g.appendChild(p); return p; });
      grp.appendChild(g);
      ov[h][layer] = { g, paths, on: false };
    }
  }
  // the light: one canvas over the word (created when a variant or celebrate() needs it)
  // In real time it is drawn by a worker (light-worker.js, an OffscreenCanvas): the main thread
  // only moves the word, so the light's raster never competes with the DOM, input and the host.
  // The worker runs the same render(t) on the same clock. Manual clock (capture), no worker
  // support, or a worker that fails to load (e.g. a CSP without worker-src): drawn right here.
  let canvas = null, painter = null, worker = null, probeId = 0, workerUp = null;
  // adaptive quality: 'auto' measures the first ~30 frames and steps down to 'low' (half the
  // light canvas's pixels, no veil, no bloom) if their 95th percentile is over 18 ms
  let quality = o.quality === 'low' ? 'low' : 'high';
  const adaptive = o.quality === undefined || o.quality === 'auto';
  const probes = new Map();
  function newCanvas() {
    if (canvas) canvas.remove();
    canvas = document.createElement('canvas'); canvas.className = 'vx-light'; canvas.setAttribute('aria-hidden', 'true');
    svg.after(canvas);
  }
  function ensureLight(onMain = false) {
    if (painter || worker || typeof HTMLCanvasElement === 'undefined') return painter || worker;
    newCanvas();
    if (!onMain && !manual && o.lightWorker !== false && typeof Worker !== 'undefined' && canvas.transferControlToOffscreen) {
      try {
        const off = canvas.transferControlToOffscreen();
        let up; workerUp = new Promise((r) => { up = r; });
        worker = new Worker(new URL('./light-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('error', () => { up(false); if (worker) { workerFallback(); kick(); } });
        worker.addEventListener('message', (e) => {
          if (e.data && e.data.up) { up(true); return; }                 // the module loaded and has the canvas
          const r = probes.get(e.data.id); if (r) { probes.delete(e.data.id); r(e.data.n); }
        });
        worker.postMessage({ type: 'init', canvas: off, variant }, [off]);
        sizeCanvas(); syncClock(); syncLive();
        return worker;
      } catch (e) { worker = null; newCanvas(); }
    }
    try { painter = makePainter(canvas); } catch (e) { canvas.remove(); canvas = null; painter = null; return null; }
    sizeCanvas();
    return painter;
  }
  // the worker failed (or never came up): the light on the main thread, from a fresh canvas
  function workerFallback() { if (worker) { worker.terminate(); worker = null; } workerUp = null; ensureLight(true); }
  const post = (m) => { if (worker) worker.postMessage(m); };
  function syncClock() { post({ type: 'clock', t0Abs: performance.timeOrigin + t0 }); }
  function syncLive() { post({ type: 'live', live: { doneAt, celebAt, calm: variant === 'reduced' || variant === 'still', q: quality } }); }
  // The canvas is a band around the word, full width: the light lives along the cut, and a
  // smaller canvas is far cheaper to hand to the compositor each frame (software compositing
  // spent most of a frame on a full-stage canvas).
  let bandTop = 0, lightRes = 1;
  function sizeCanvas() {
    if (!canvas) return;
    bandTop = Math.max(0, Math.round(L.top + BAND[0] * L.k));
    const bh = Math.max(1, Math.min(L.ch, Math.round(L.top + BAND[1] * L.k)) - bandTop);
    // light is soft: it is drawn on a budget of about 150k pixels and the compositor scales it
    // up (a full-resolution band cost a 4x-throttled frame its whole budget in raster alone)
    lightRes = Math.min(L.dpr || 1, Math.sqrt((quality === 'low' ? LIGHT_PX / 2 : LIGHT_PX) / (L.cw * bh)));
    const w = Math.max(1, Math.round(L.cw * lightRes)), h = Math.max(1, Math.round(bh * lightRes));
    if (worker) post({ type: 'size', w, h, L: { ...L }, bandTop, lightRes });
    else {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      if (painter) painter.invalidate();
    }
    canvas.style.width = L.cw + 'px'; canvas.style.height = bh + 'px'; canvas.style.top = bandTop + 'px';
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
    svg.style.transformOrigin = '0 0';
    blade.style.width = L.cw + 'px'; needle.style.width = L.cw + 'px';
    sizeCanvas();
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
  let fill = null, fillShown = null, doneAt = null, celebAt = null;
  // ---- the light on the letters (SVG overlays) and the letters' own colour
  const rgbT = (T) => { const c = heat(Math.round(clamp01(T) * 64) / 64); return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; };   // quantised: fewer attribute writes
  const rgbA = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  function attr(node, cache, key, name, val) { if (cache[key] !== val) { cache[key] = val; node.setAttribute(name, val); } }
  function setGrad(id, vec, list) {          // list: [[offset 0..1, T, alpha]]; padded with its last stop
    const g = grads[id], c = g.last;
    attr(g.g, c, 'x1', 'x1', vec[0].toFixed(3)); attr(g.g, c, 'y1', 'y1', vec[1].toFixed(3));
    attr(g.g, c, 'x2', 'x2', vec[2].toFixed(3)); attr(g.g, c, 'y2', 'y2', vec[3].toFixed(3));
    for (let i = 0; i < g.n; i++) {
      const v = list[Math.min(i, list.length - 1)];
      attr(g.stops[i], c, 'o' + i, 'offset', clamp01(v[0]).toFixed(4));
      attr(g.stops[i], c, 'c' + i, 'stop-color', rgbT(v[1]));
      attr(g.stops[i], c, 'a' + i, 'stop-opacity', clamp01(v[2]).toFixed(2));
    }
  }
  function layer(name, on) {
    for (const h of ['t', 'b']) { const l = ov[h][name]; if (l.on !== on) { l.on = on; l.g.setAttribute('display', on ? 'inline' : 'none'); } }
    return on;
  }
  const ovc = { t: {}, b: {} }, AD = [1, 0.55, 0.25, 0.08, 0];
  function cutProfile(T, a, R, k = 3.5) {    // light falling off from both edges of the cut, over R units
    const y1 = G.cutTop - R, y2 = G.cutBot + R, f = (d) => a * (Math.exp(-k * d) - Math.exp(-k)) / (1 - Math.exp(-k));
    const out = [];
    for (const d of AD) out.push([(G.cutTop - R * d - y1) / (y2 - y1), T - 0.15 * d, f(d)]);
    for (const d of AD.slice().reverse()) out.push([(G.cutBot + R * d - y1) / (y2 - y1), T - 0.15 * d, f(d)]);
    return [[0, y1, 0, y2], out];
  }
  function paintLetterLight(st, B, dpr) {
    const tn = st.tone, wf = tn ? rgbA(tn.f) : '', wv = tn ? rgbA(tn.v) : '';
    // the letters' colour: written on the ten pieces themselves ('' = back to bone / signal from
    // intro.css) - cheaper than a custom property that restyles every node in the word
    if (last.wf !== wf) { last.wf = wf; for (let i = 0; i < 5; i++) { tops[i].style.fill = wf; if (!G.letters[i].signal) bots[i].style.fill = wf; } }
    if (last.wv !== wv) { last.wv = wv; G.letters.forEach((l, i) => { if (l.signal) bots[i].style.fill = wv; }); }
    const unit = 1 / (dpr * B);              // glyph units per device pixel (stroke widths)
    const pose = (name) => {
      for (let i = 0; i < 5; i++) {
        const s = st.letters[i], ty = (1 - s.open) * (G.cutTop + 4), by = -(1 - s.open) * (100 - G.cutBot + 4);
        set(name + 't' + i, ov.t[name].paths[i], 'transform', `translate(${s.tdx.toFixed(3)}px,${ty.toFixed(3)}px)`);
        set(name + 'b' + i, ov.b[name].paths[i], 'transform', `translate(${s.bdx.toFixed(3)}px,${by.toFixed(3)}px)`);
      }
    };
    // A: light from the cut on the faces, and a rim on the edges that face it
    const A = st.ovA;
    if (layer('A', !!(A && (A.a > 0.004 || A.ra > 0.004)))) {
      pose('A');
      // the profiles' shape changes slowly (quantised); their strength is the group's fill / stroke opacity
      const q = (v, n) => Math.round(v * n) / n;
      const [vf, lf] = cutProfile(A.T, 1, q(A.R, 2), 2.2), [vs, ls] = cutProfile(A.rT, 1, q(A.rR, 2));
      setGrad('Af', vf, lf); setGrad('As', vs, ls);
      for (const h of ['t', 'b']) {
        attr(ov[h].A.g, ovc[h], 'w', 'stroke-width', (A.w * unit).toFixed(3));
        attr(ov[h].A.g, ovc[h], 'fo', 'fill-opacity', clamp01(A.a).toFixed(3));
        attr(ov[h].A.g, ovc[h], 'so', 'stroke-opacity', clamp01(A.ra).toFixed(3));
      }
    }
    // G: pass 1's outlines, in the ghost pose (the letters open, not yet out of the cut)
    const Gh = st.ovG;
    if (layer('G', !!Gh)) {
      const span = OVX[1] - OVX[0];
      for (const h of ['t', 'b']) {
        const dx = h === 't' ? -Gh.lag : 0;
        const vec = [OVX[0] - dx, 0, OVX[1] - dx, 0];
        setGrad('Gs' + h, vec, Gh.stops.map(([x, T, a]) => [(x - OVX[0]) / span, T, a]));
        const fx = Gh.fill.x - dx, fw = Gh.fill.w;           // the faint light on the faces, round the head
        setGrad('Gf' + h, [fx - 2 * fw, 0, fx + 2 * fw, 0], [[0, Gh.fill.T, 0], [0.25, Gh.fill.T, Gh.fill.a * 0.37], [0.5, Gh.fill.T, Gh.fill.a], [0.75, Gh.fill.T, Gh.fill.a * 0.37], [1, Gh.fill.T, 0]]);
        attr(ov[h].G.g, ovc[h], 'gw', 'stroke-width', (Gh.w * unit).toFixed(4));
        for (let i = 0; i < 5; i++) {
          set('G' + h + i, ov[h].G.paths[i], 'transform', `translate(${dx}px,0px)`);
          set('Go' + h + i, ov[h].G.paths[i], 'opacity', Gh.per[i].toFixed(3));
        }
      }
    }
    // S: the sweep - a narrow band sheared like the stems; the same gradient on the edges (a
    // 1.5 px stroke) makes them glint as it passes
    const S = st.ovS;
    if (layer('S', !!(S && S.a > 0.004))) {
      pose('S');
      const W = 16, n = Math.hypot(1, G.shear), nx = 1 / n, ny = G.shear / n, w = S.w;
      const prof = [[-W, 0.6, 0], [-9, 0.62, 0.2], [-w, 0.84, 0.55], [-2, 1, 0.95], [0, 1, 1], [2, 1, 0.95], [w, 0.84, 0.55], [9, 0.62, 0.2], [W, 0.6, 0]];
      const list = prof.map(([d, T, a]) => [(d + W) / (2 * W), T, a]);
      for (const h of ['t', 'b']) {
        const dx = h === 't' ? st.letters[1].tdx : st.letters[1].bdx, x = S.x - dx;
        setGrad('S' + h, [x - nx * W, 50 - ny * W, x + nx * W, 50 + ny * W], list);
        attr(ov[h].S.g, ovc[h], 'sw', 'stroke-width', (1.5 * unit).toFixed(3));
        attr(ov[h].S.g, ovc[h], 'sfo', 'fill-opacity', clamp01(S.a).toFixed(3));
        attr(ov[h].S.g, ovc[h], 'sso', 'stroke-opacity', clamp01(S.a).toFixed(3));
      }
    }
  }

  function paint(t) {
    const st = render(variant, t, liveOf(L, { doneAt, fill: fillShown, celebAt, calm: variant === 'reduced' || variant === 'still', q: quality }));
    const k = L.k, dpr = L.dpr;
    const xf = cameraXf(st, L), { c, p, B, Ax, Ay } = xf;
    set('svgT', svg, 'transform', `translate(${(Ax - B * M).toFixed(3)}px,${(Ay - B * M).toFixed(3)}px) scale(${(c * p).toFixed(5)})`);
    set('svgO', svg, 'opacity', st.wordAlpha >= 1 ? '1' : st.wordAlpha.toFixed(3));
    for (let i = 0; i < 5; i++) {
      const s = st.letters[i];
      const ty = (1 - s.open) * (G.cutTop + 4), by = -(1 - s.open) * (100 - G.cutBot + 4);
      set('t' + i, tops[i], 'transform', `translate(${s.tdx.toFixed(3)}px,${ty.toFixed(3)}px)`);
      set('b' + i, bots[i], 'transform', `translate(${s.bdx.toFixed(3)}px,${by.toFixed(3)}px)`);
    }
    // light: only when there is some (or was, last frame)
    const lit = st.light && (st.light.back.length || st.light.front.length);
    if (lit && !painter && !worker) ensureLight();
    if (painter) painter.paint(st, [B, Ax, Ay - bandTop], lightParams(L, xf, lightRes, V.lag || 0));
    paintLetterLight(st, B, dpr);
    // the needle: the white-hot core of the light in the cut (whole device pixels, on top of
    // the soft light; it lies in the cut band, where no letter ever is while it shows)
    const nd = st.needle;
    if (nd && nd.a > 0.004) {
      const nx0 = Math.max(0, Ax + nd.x0 * B), nx1 = Math.min(L.cw, Ax + nd.x1 * B), wd = Math.max(1, Math.round(nd.w));
      const y = Math.round((Ay + CUT_MID * B + L.oy) * dpr - wd / 2) / dpr - L.oy;
      set('ndO', needle, 'opacity', nx1 > nx0 ? Math.min(1, nd.a).toFixed(3) : '0');
      set('ndC', needle, 'backgroundColor', rgbT(nd.T));
      set('ndH', needle, 'height', wd / dpr + 'px');
      set('ndT', needle, 'transform', `translate(${nx0.toFixed(2)}px,${y.toFixed(3)}px) scaleX(${((nx1 - nx0) / L.cw).toFixed(5)})`);
    } else set('ndO', needle, 'opacity', '0');
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
  let t0 = performance.now(), raf = 0, destroyed = false, skipped = false, manualT = 0, warming = !!V.light;
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
    if (warming && painter) warming = painter.warmStep(6);
    if (qa) measureQuality();
    if (!settledFired && t >= V.settled) fireSettled();
    if (handoverTick(t)) return;
    const celebrating = celebAt !== null && t - celebAt <= CELEBRATE.total + 40;
    const moving = !settledFired || celebrating || (o.loader && doneAt === null && (fill === null ? variant !== 'still' && variant !== 'reduced' : fillShown !== fill)) || doneAt !== null;
    if (moving) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && !destroyed && !manual) raf = requestAnimationFrame(frame); };
  // adaptive quality (see `quality`): frame intervals 4..34 after the start
  let qa = adaptive && V.light && !manual ? [] : null, qPrev = 0;
  function measureQuality() {
    if (started === null) return;
    const now = performance.now();
    if (qPrev) qa.push(now - qPrev);
    qPrev = now;
    if (qa.length < 34) return;
    const d = qa.slice(4).sort((a, b) => a - b), p95 = d[Math.floor(0.95 * (d.length - 1))];
    qa = null;
    if (p95 > 18) { quality = 'low'; sizeCanvas(); syncLive(); }
  }

  // ---- sound
  // States the sound button shows: 'on' (playing / allowed), 'off' (muted, remembered),
  // 'blocked' (wanted, but the browser has not allowed audio yet: "Ton: klicken").
  let ctx = null, cue = null, audible = false, replayed = false, unlocking = false, earlyResume = null;
  let muted = o.muted !== undefined ? !!o.muted : readMuted();
  function audioReady() { return hasSound && !muted && ctx && ctx.state === 'running'; }
  function blocked() { return hasSound && !muted && !manual && !!ctx && ctx.state !== 'running' && !settledFired; }
  // staged (the start of the intro): the cue is scheduled 250 ms ahead, a few events per task,
  // and the picture's t = 0 is put on that moment - building ~200 audio nodes in one go was a
  // 170 ms long task with the CPU 4x slower. Mid-intro (unmute, unlock): at once, 20 ms ahead.
  function startCue(fromMs, staged = false) {
    if (!audioReady()) return false;
    if (variant !== 'reduced' && fromMs > V.contact - 30) return false;     // too late to land the hit in sync
    const plan = soundPlan(variant, L);
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0), lead = staged ? 0.25 : 0.02;
    const when = ctx.currentTime + lead;
    const c = cue = Sound.scheduleCue(ctx, ctx.destination, when, plan, fromMs, { staged });
    if (staged) {
      const step = () => {
        if (destroyed || cue !== c) return;
        const s0 = performance.now();
        while (c.jobs.length && performance.now() - s0 < 6) c.jobs.shift()();
        if (c.jobs.length) setTimeout(step, 0);
      };
      setTimeout(step, 0);
    }
    // keep the picture on the sound: plan time fromMs is heard at `when + lat`
    if (!manual) { t0 = performance.now() - fromMs + lead * 1000 + lat * 1000; if (staged) started = t0; syncClock(); }
    audible = true;
    muteUi();
    return true;
  }
  // (audible: false from here on - muting mid-intro must not report sound, and an unmute
  // must be free to start what is still ahead)
  function stopCue(ms = 60) { if (cue) { cue.stop(ms); cue = null; } audible = false; }
  function watchCtx() {
    if (ctx && !ctx.__vxWatched) { ctx.__vxWatched = true; ctx.addEventListener('statechange', () => { if (!destroyed) muteUi(); }); }
  }

  let started = null, skipQueued = false;
  function begin() {
    t0 = performance.now(); started = t0; skipped = false; settledFired = false; root.classList.remove('vx--settled');
    syncClock();
    armSettleTimer();
    // skipped during boot (Esc right away, or a host's skip() for an early error): honour it now,
    // without a sound - begin() would otherwise restart the clock and play the whole intro
    if (skipQueued) { skipQueued = false; muteUi(); skip(); return; }
    if (hasSound && !muted && !manual) {
      if (!ctx) ctx = Sound.createContext();
      if (ctx) {
        watchCtx();
        if (ctx.state === 'running') startCue(0, true);
        else (earlyResume || ctx.resume()).then(() => { if (!audible && !unlocking && !destroyed && ctx.state === 'running') startCue(curT()); }, () => {});
      }
    }
    muteUi();
    kick();
  }

  // ---- input
  function skip() {
    if (skipped || settledFired || variant === 'still') return;
    if (!manual && started === null) { skipQueued = true; return; }   // still booting: begin() applies it
    skipped = true; stopCue(60);
    if (manual) manualT = V.settled; else { t0 = performance.now() - V.settled; syncClock(); }
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
  // a click on the intro: unlocks the sound if the browser blocked it (see above), otherwise
  // it skips - the long intro is skippable at any time
  function onPointer(e) {
    if (destroyed || manual) return;
    if (e.target.closest && e.target.closest('.vx-bar')) return;
    if (e.target.closest && slot.contains(e.target)) return;
    if (blocked() && canReplay()) unlock();
    else if (started !== null && performance.now() - started > 150) skip();
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
    fireSettled();                         // done() may hand over before the loader is in: settled comes first
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
    if (h >= HANDOVER.total) { paint(t); finishHandover(); return true; }
    return false;
  }
  // done() hands over as soon as the motion is over (the end of the light sweep, `calm`), not
  // when the loader has come in - the backend is often ready long before that
  function whenCalm() {
    return new Promise((r) => {
      const chk = () => { if (destroyed || settledFired || ((manual || started !== null) && curT() >= V.calm)) r(); else setTimeout(chk, Math.max(16, Math.min(200, V.calm - curT()))); };
      chk();
    });
  }
  function done() {
    if (donePromise) return donePromise;
    donePromise = whenCalm().then(() => new Promise((resolve) => {
      if (destroyed) { resolve(); return; }
      doneResolve = resolve;
      doneAt = curT(); syncLive();
      if (manual) { finishHandover(); return; }
      kick();
      setTimeout(() => { if (doneResolve === resolve) finishHandover(); }, HANDOVER.total + 250);
    }));
    return donePromise;
  }

  // ---- celebrate (the installer's done screen): a streak along the cut while the upper halves
  // draw back, the re-lock (snap, hit-stop, spring) with a flash and a few sparks, a light
  // sweep, a small sound. Waits for the settle; resolves at 1.3 s, the word at rest again.
  let celebPromise = null;
  function celebrate() {
    if (celebPromise) return celebPromise;
    celebPromise = settled.then(() => new Promise((resolve) => {
      if (destroyed) { resolve(); return; }
      ensureLight();
      celebAt = curT(); syncLive();
      if (audioReady()) Sound.scheduleCue(ctx, ctx.destination, ctx.currentTime + 0.01, celebratePlan(L, variant === 'reduced' || variant === 'still'), 0);
      if (manual) { resolve(); return; }
      kick();
      setTimeout(() => { celebPromise = null; resolve(); }, CELEBRATE.total + 60);
    }));
    return celebPromise;
  }

  // ---- start
  muteUi();
  if (o.handedOver) {                        // in-app continuation of VELOX.exe's start screen: the canonical end pose
    doneAt = -(HANDOVER.total + 1); snapped = true;
    donePromise = Promise.resolve();
    root.classList.add('vx--done');
    releaseKeys();
  }
  // Start-up is split over separate tasks (create the audio context / build its buffers /
  // prepare the light's sprites), each well under the 50 ms long-task line, and finished
  // before the clock starts - so the first frames are never blocked by it.
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  const wantsAudio = hasSound && !muted && !manual;
  const audioBoot = !wantsAudio ? Promise.resolve() : (async () => {
    await nextTask();
    if (!destroyed && !ctx) { ctx = Sound.createContext(); watchCtx(); }
    if (ctx && ctx.state !== 'running') earlyResume = ctx.resume().catch(() => {});   // the one autoplay attempt (as 1.2.0)
    for (const f of Sound.noiseSteps(variant)) { await nextTask(); if (destroyed) return; f(); }   // the samples, a few per task
    await nextTask();
    if (!destroyed && ctx) Sound.prewarm(ctx, variant);
    await nextTask();
    if (!destroyed && ctx && variant !== 'still') Sound.prewarmRoom(ctx);
    await nextTask();
  })();
  // The clock starts only once the light can draw: a worker whose script never arrives (a host that does
  // not serve worker requests, a request left hanging) would otherwise leave the light dark for the whole
  // intro. It normally comes up well inside the audio boot; after WORKER_WAIT the main thread draws.
  const lightBoot = !V.light ? Promise.resolve() : nextTask().then(() => {
    if (destroyed || !ensureLight()) return null;
    if (worker && workerUp) {
      return Promise.race([workerUp, new Promise((r) => setTimeout(() => r(false), WORKER_WAIT))]).then((ok) => {
        if (destroyed || ok || !worker) return;
        workerFallback();
      }).then(() => { if (painter && !destroyed) painter.warm([0.25, 0.3, 0.36, 0.4, 0.55, 0.6, 0.62]); });
    }
    if (painter) painter.warm([0.25, 0.3, 0.36, 0.4, 0.55, 0.6, 0.62]);
    return nextTask();
  });
  const boot = Promise.all([o.css === false ? Promise.resolve() : ensureCss(), audioBoot, lightBoot]).then(() => {
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
    variant: asked,
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
    celebrate,
    replay() { stopCue(30); audible = false; doneAt = null; snapped = false; donePromise = null; celebAt = null; syncLive(); root.classList.remove('vx--done'); if (variant !== 'still' && !manual && !keysOn) { keysOn = true; window.addEventListener('keydown', onKey); } begin(); },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); clearTimeout(settleTimer); stopCue(30);
      if (worker) { worker.terminate(); worker = null; }
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
      if (live.celebAt !== undefined) { celebAt = live.celebAt; if (celebAt !== null) ensureLight(); }
      if (!settledFired && ms >= V.settled) fireSettled();
      root.classList.toggle('vx--settled', ms >= V.settled);
      if (!o.handedOver) root.classList.toggle('vx--done', doneAt !== null && ms >= doneAt + HANDOVER.total);
      paint(ms);
    },
    plan() { return soundPlan(variant, L); },
    // tests: how many pixels of the light canvas are lit right now (worker or main thread)
    lightProbe() {
      if (worker) return new Promise((r) => { const id = ++probeId; probes.set(id, r); post({ type: 'probe', id }); });
      return Promise.resolve(painter ? painter.lit() : 0);
    },
    lightStats() { return worker ? new Promise((r) => { const id = ++probeId; probes.set(id, r); post({ type: 'stats', id }); }) : Promise.resolve(null); },
    get lightThread() { return worker ? 'worker' : painter ? 'main' : 'none'; },
    get lightQuality() { return quality; },   // 'high', or 'low' once the adaptive quality stepped down
    celebratePlan() { return celebratePlan(L, variant === 'reduced' || variant === 'still'); },
    layout() { return { ...L }; },
    timeline() { return { ...V, letters: undefined, name: variant }; },
    get keysActive() { return keysOn; },    // tests: is the window keydown listener attached
  };
}

// The long intro on every launch (the owner's choice: like a console boot); 'short' only for
// people who chose "Kurz" (opts.prefer 'short', or localStorage velox.intro = 'short').
// The second argument may still be the storage key (1.2.0 signature).
export function pickVariant(version, keyOrOpts = 'velox.intro.seen') {
  const o = typeof keyOrOpts === 'string' ? { key: keyOrOpts } : { key: 'velox.intro.seen', ...keyOrOpts };
  let pref = o.prefer;
  try {
    if (!pref) pref = localStorage.getItem('velox.intro');
    localStorage.setItem(o.key, String(version));
  } catch (e) { /* no storage: still the long one */ }
  return pref === 'short' || pref === 'kurz' ? 'short' : 'long';
}

export const VeloxIntro = { mount, pickVariant, render, soundPlan, handoverPlan, celebratePlan, layoutFor, heat, VARIANTS, HANDOVER, CELEBRATE, HANDOVER_TRAVEL: HANDOVER.travel, Sound };
export default VeloxIntro;
