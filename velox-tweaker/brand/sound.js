// VELOX brand sound - Web Audio synthesis, no samples, no files.
//
// The cue is not composed here. intro.js derives a *plan* (a list of events with their
// parameters) from the same render(t) that draws the picture: the click times are the
// moments the blade crosses each letter, the hit is the moment the spring reaches the
// lock, its strength is the spring's velocity there, the ring-out decays with the spring.
// This file only turns such a plan into sound, identically in an AudioContext (live) and
// an OfflineAudioContext (WAV / video render).
//
// Deterministic: noise comes from a seeded PRNG; no convolver, no compressor, no oversampled
// shaper (the only waveshaper runs without oversampling). Main-thread cost of scheduling a
// cue: one 0.5 s noise buffer (24k samples) plus ~30 nodes, well under 2 ms.

const LEVEL = {          // calibrated with ffmpeg ebur128 (see README)
  master: 0.67,          // full cue: -18.7 LUFS, -3.3 dBTP
  air: 0.07,             // the blade's air band: steady, ~11 dB under the old swell, never a whoosh
  click: 1.25,           // letter clicks (x 0.55..1 by the material the cut runs through)
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noiseCache = new WeakMap();
function noise(ctx, seconds, seed) {
  let per = noiseCache.get(ctx);
  if (!per) { per = new Map(); noiseCache.set(ctx, per); }
  const key = seconds + ':' + seed;
  if (per.has(key)) return per.get(key);
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0), rnd = mulberry32(seed);
  for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
  per.set(key, buf);
  return buf;
}

let satCurve = null;
function saturation() {             // gentle tanh, adds 2nd/3rd harmonics to the thud
  if (satCurve) return satCurve;
  const n = 2049; satCurve = new Float32Array(n);         // odd length: x = 0 maps exactly to 0 (no DC at rest)
  const drive = 2.2, norm = Math.tanh(drive + 0.08);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    satCurve[i] = Math.tanh(drive * x + 0.08 * x * x) / norm;   // slight asymmetry -> even harmonics
  }
  return satCurve;
}

let quiet = 0;                     // audio time after the current cue's fade (see scheduleCue)

function panned(ctx, node, pan) {
  if (pan === undefined || !ctx.createStereoPanner) return node;
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  node.connect(p);
  return p;
}

// a filtered noise burst: ticks, clicks, the crack of the hit
function burst(ctx, out, at, o) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx, 0.08, o.seed);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = o.f; bp.Q.value = o.q;
  const g = ctx.createGain();
  const a = o.attack || 0.0005, h = o.hold || 0;
  g.gain.value = 0;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(o.gain, at + a);
  if (h) g.gain.setValueAtTime(o.gain, at + a + h);
  g.gain.setTargetAtTime(0, at + a + h, o.tau);
  src.connect(bp); bp.connect(g);
  panned(ctx, g, o.pan).connect(out);
  src.start(at); src.stop(Math.max(at + Math.min(0.08, a + h + o.tau * 12 + 0.002), quiet));
}

function tone(ctx, out, at, o) {
  const osc = ctx.createOscillator(); osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f0, at);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, at + o.glide);
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(o.gain, at + o.attack);
  g.gain.setTargetAtTime(0, at + o.attack + (o.hold || 0), o.tau);
  let node = osc;
  if (o.sat) { const ws = ctx.createWaveShaper(); ws.curve = saturation(); ws.oversample = 'none'; osc.connect(ws); node = ws; }
  node.connect(g);
  let last = g;
  if (o.lp) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; lp.Q.value = 0.5; g.connect(lp); last = lp; }
  panned(ctx, last, o.pan).connect(out);
  // Sources stop only after the cue's master fade has reached zero (`quiet`): a stop inside
  // the audible cue left a one-sample spike in Chromium's render (~-44 dBFS) even with the
  // envelope at -100 dB.
  osc.start(at); osc.stop(Math.max(at + Math.max(o.len, o.attack + (o.hold || 0) + 12 * o.tau), quiet));
}

// ------------------------------------------------------------------ events
const EVENTS = {
  // the blade appears: one tight, bright "tk"
  tick(ctx, out, at, e) {
    burst(ctx, out, at, { seed: 11, f: 5200, q: 7, gain: 0.5 * e.gain, tau: 0.0032, pan: e.pan });
    burst(ctx, out, at, { seed: 12, f: 9800, q: 1.2, gain: 0.2 * e.gain, tau: 0.0011, pan: e.pan });
  },
  // the blade travelling along the cut: a thin, steady band of air above the clicks. Its pan
  // follows the blade head, its pitch rises only slightly (4.3 -> 5 kHz); level constant.
  air(ctx, out, at, e) {
    const dur = e.dur;
    const src = ctx.createBufferSource(); src.buffer = noise(ctx, 0.6, 21);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    const g = ctx.createGain();
    bp.frequency.setValueCurveAtTime(Float32Array.from(e.freq), at, dur);
    g.gain.setValueAtTime(0, at);
    g.gain.setValueCurveAtTime(Float32Array.from(e.gain, (x) => x * LEVEL.air), at, dur);
    src.connect(bp); bp.connect(g);
    let last = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.setValueCurveAtTime(Float32Array.from(e.pan), at, dur);
      g.connect(p); last = p;
    }
    last.connect(out);
    src.start(at); src.stop(Math.max(at + dur + 0.01, quiet));
  },
  // a letter opening out of the cut: one dry, woody click (1.2-2.2 kHz, under the air band),
  // lower and louder the more material the cut runs through. One excitation (seed 32) for all
  // five: the same blade, a different material - and an even level, letter to letter.
  click(ctx, out, at, e) {
    burst(ctx, out, at, { seed: 32, f: e.f, q: 4, gain: e.gain * LEVEL.click, attack: 0.0004, hold: 0.0006, tau: 0.0026, pan: e.pan });
  },
  // the lock. v = spring velocity at contact (1 = full intro), tau = the spring's decay
  impact(ctx, out, at, e) {
    const v = e.v, s = e.small ? 0.55 : 1;
    // crack: hard and short (4-5 ms: 0.3 ms attack, 1.5 ms hold, fast decay), plus an 8 kHz
    // edge and a resonant metal body at 2.9 / 3.4 kHz - this is what carries the hit on
    // laptop speakers, where nothing under ~180 Hz exists
    burst(ctx, out, at, { seed: 41, f: 1900, q: 0.9, gain: 2.4 * v * s, attack: 0.0003, hold: 0.0015, tau: 0.0012, pan: e.pan });
    burst(ctx, out, at, { seed: 42, f: 8200, q: 0.8, gain: 0.5 * v * s, attack: 0.0003, hold: 0.0008, tau: 0.0010, pan: e.pan });
    burst(ctx, out, at, { seed: 43, f: 2950, q: 9, gain: 1.4 * v * s, attack: 0.0004, hold: 0.001, tau: 0.009, pan: e.pan });
    tone(ctx, out, at, { f0: 3380, gain: 0.09 * v * s, attack: 0.0004, tau: 0.008, len: 0.1, pan: e.pan });
    // body: the thud of a heavy part seating, saturated so 2nd/3rd harmonics carry it on laptop speakers.
    // Everything after the hit sits on one 48 Hz harmonic series (thud lands on 48, ready tone 96/144/192),
    // so nothing beats against anything: the lock literally locks.
    // The body starts 1.8 ms after the crack (the crack is the contact, the thud the mass
    // arriving behind it): their peaks do not stack, so the hit is louder at the same true peak.
    const f0 = 70 + 80 * v, tb = at + 0.0018;
    tone(ctx, out, tb, { f0, f1: 48, glide: e.halfPeriod, gain: 0.56 * s, attack: 0.002, tau: 0.075, len: 0.5, sat: true, lp: 1400 });
    tone(ctx, out, tb, { f0: 2 * f0, f1: 96, glide: e.halfPeriod, gain: 0.28 * s, attack: 0.002, tau: 0.055, len: 0.35 });
    tone(ctx, out, tb, { f0: 3 * f0, f1: 144, glide: e.halfPeriod, gain: 0.12 * s, attack: 0.002, tau: 0.04, len: 0.3 });
    // the seat: two short partials higher up the same 48 Hz series (288 = 6 x 48, 432 = 9 x 48),
    // so the weight of the hit survives on speakers that have no bass
    tone(ctx, out, tb, { f0: 288, gain: 0.09 * s, attack: 0.0015, tau: 0.045, len: 0.4 });
    tone(ctx, out, tb, { f0: 432, gain: 0.06 * s, attack: 0.0015, tau: 0.03, len: 0.3 });
    if (!e.small) {
      // sub and its harmonics: felt on headphones; 96/144 Hz keep it audible on small speakers
      tone(ctx, out, at, { f0: 48, gain: 0.16, attack: 0.006, hold: 0.015, tau: 0.22, len: 1.0 });
      tone(ctx, out, at, { f0: 96, gain: 0.1, attack: 0.004, hold: 0.01, tau: 0.10, len: 0.6 });
      tone(ctx, out, at, { f0: 144, gain: 0.08, attack: 0.004, tau: 0.07, len: 0.5 });
    }
    // the latch: two inharmonic partials, ringing out with the spring that drives the picture
    tone(ctx, out, at + 0.002, { f0: 1180, gain: 0.13 * s, attack: 0.0008, tau: e.tau, len: 0.35, pan: e.pan });
    tone(ctx, out, at + 0.002, { f0: 2013, gain: 0.08 * s, attack: 0.0008, tau: e.tau * 0.7, len: 0.3, pan: e.pan });
  },
  // reduced motion only: one low, soft tone (96 Hz = 2 x the sub). The full cue has no
  // tone after the hit any more - Klack, then silence.
  ready(ctx, out, at) {        // levels x 1.31: same loudness as before the master moved 0.88 -> 0.67
    tone(ctx, out, at, { f0: 96, type: 'triangle', gain: 0.197, attack: 0.32, hold: 0.1, tau: 0.26, len: 1.5, lp: 560 });
    tone(ctx, out, at, { f0: 144, gain: 0.047, attack: 0.38, hold: 0.05, tau: 0.2, len: 1.3 });
    tone(ctx, out, at, { f0: 192, gain: 0.029, attack: 0.36, tau: 0.16, len: 1.1 });
  },
  // the hand-over: the loader's segment snaps into the cut. One quiet, dry click.
  snap(ctx, out, at, e) {
    burst(ctx, out, at, { seed: 51, f: 2600, q: 3, gain: 0.42, tau: 0.003, pan: e.pan });
    tone(ctx, out, at, { f0: 620, f1: 410, glide: 0.02, gain: 0.066, attack: 0.0008, tau: 0.018, len: 0.12, pan: e.pan });
  },
};

// Schedule a plan on ctx. `when` = audio time of plan time 0. fromMs drops events already past.
// Returns { stop(fadeMs), end } - end is the audio time the cue is silent.
export function scheduleCue(ctx, dest, when, plan, fromMs = 0) {
  const from = fromMs / 1000;
  // close the cue: a clean fade, digital silence before plan.end
  const fa = Math.max(when + plan.fadeFrom / 1000 - from, ctx.currentTime);
  const fb = Math.max(when + plan.end / 1000 - from, fa + 0.02);
  quiet = fb + 0.03;                                      // every source stops after this (master is 0 by then)
  // voices -> 20 Hz high-pass (no DC, no rumble) -> master gain (level + the closing fade).
  // The fade sits after the filter, so the cue really ends in digital silence.
  const bus = ctx.createGain();
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 20; hp.Q.value = 0.707;
  const master = ctx.createGain();
  master.gain.value = LEVEL.master * (plan.gain || 1);
  bus.connect(hp); hp.connect(master); master.connect(dest);
  for (const e of plan.events) {
    const t = e.t / 1000;
    if (t < from - 0.004) continue;
    EVENTS[e.type](ctx, bus, when + t - from, e);
  }
  master.gain.setValueAtTime(master.gain.value, fa);
  master.gain.linearRampToValueAtTime(0, fb);
  return {
    end: fb,
    stop(fadeMs = 60) {
      const now = ctx.currentTime, g = master.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + fadeMs / 1000);
    },
  };
}

// Build the noise buffers and the shaper curve, and touch every node type once, so the first
// scheduleCue() is cheap. Call it in its own task after createContext() (each step stays far
// below the 50 ms long-task line; scheduling then costs ~1-3 ms).
export function prewarm(ctx) {
  if (!ctx) return;
  noise(ctx, 0.6, 21);
  for (const seed of [11, 12, 31, 32, 33, 34, 35, 41, 42, 43, 51]) noise(ctx, 0.08, seed);
  saturation();
  const sink = ctx.createGain(); sink.gain.value = 0;
  const nodes = [ctx.createOscillator(), ctx.createBiquadFilter(), ctx.createWaveShaper(), ctx.createBufferSource()];
  if (ctx.createStereoPanner) nodes.push(ctx.createStereoPanner());
  for (const n of nodes) { n.connect(sink); n.disconnect(); }
}

export function createContext() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { return new AC({ latencyHint: 'interactive' }); } catch (e) { return null; }
}

// Same code path, rendered offline. Returns an AudioBuffer (stereo, 48 kHz).
export function renderOffline(plan, seconds = 2, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.round(sampleRate * seconds), sampleRate);
  scheduleCue(ctx, ctx.destination, 0, plan, 0);
  return ctx.startRendering();
}

// AudioBuffer -> 24-bit PCM WAV (ArrayBuffer)
export function toWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, bps = 3;
  const out = new ArrayBuffer(44 + n * ch * bps), dv = new DataView(out);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * bps, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * bps, true); dv.setUint16(32, ch * bps, true); dv.setUint16(34, 24, true);
  str(36, 'data'); dv.setUint32(40, n * ch * bps, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const x = Math.max(-1, Math.min(1, data[c][i]));
    let v = Math.round(x * 8388607); if (v < 0) v += 16777216;
    dv.setUint8(o, v & 255); dv.setUint8(o + 1, (v >> 8) & 255); dv.setUint8(o + 2, (v >> 16) & 255); o += 3;
  }
  return out;
}

export function setMasterLevel(x) { LEVEL.master = x; }
export function masterLevel() { return LEVEL.master; }
