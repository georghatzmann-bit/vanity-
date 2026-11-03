// VELOX brand sound - Web Audio synthesis, no samples, no files.
//
// The cue is not composed here. intro.js derives a *plan* (a list of events with their
// parameters) from the same render(t) that draws the picture: the click times are the
// moments the blade crosses each letter, the hit is the moment the spring reaches the
// lock, its strength is the spring's velocity there, the ring-out decays with the spring.
// This file only turns such a plan into sound, identically in an AudioContext (live) and
// an OfflineAudioContext (WAV / video render).
//
// Deterministic: noise and the room's impulse response come from a seeded PRNG; no compressor.
// The long cue and celebrate() send the impact, the tail and the glint into a room (one
// ConvolverNode with a generated, darkened 1.3 s stereo response - built once per context,
// in its own task at start-up, because preparing it is the expensive part).

const LEVEL = {          // calibrated with ffmpeg ebur128 (see README)
  master: 0.67,          // short / reduced / hand-over (1.2.0 levels)
  long: 1.1,             // the long cue's master (its own gain in the plan): about -18 LUFS
  air: 0.07,             // the blade's air band: steady, ~11 dB under the old swell, never a whoosh
  click: 1.25,           // letter clicks (x 0.55..1 by the material the cut runs through)
  whoosh: 0.55,          // light streaks
  riser: 0.06,           // the tonal riser (three saws through a rising low-pass)
  noise: 0.04,           // the riser's noise band (-9.5 dB: the hit must stand out above 1 kHz)
  rev: 0.035,            // the suck-back before the held breath (-10.7 dB)
  drone: 0.07,           // the anticipation drone
  charge: 0.05,          // the ember charging (act 1)
  beat: 0.3,             // celebrate()'s calm pulse (the long cue has no heartbeat any more)
  tail: 2.2,             // the chord after the hit
  wet: 0.5,              // the room (convolver send return)
  ceiling: 0.82,         // long cue: soft ceiling after the master (true peak <= -1 dBTP)
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The samples are generated once per (length, seed) - before any context exists if the host
// calls noiseSteps() (the heavy part of start-up, run over several tasks) - and copied into a
// buffer per context. White noise does not care about the sample rate.
const noiseData = new Map();
function noiseSamples(len, seed) {
  const key = seed + ':' + len;
  let d = noiseData.get(key);
  if (!d) {
    for (const [k, v] of noiseData) if (k.startsWith(seed + ':') && v.length >= len) return v.subarray(0, len);
    d = new Float32Array(len); const rnd = mulberry32(seed);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
    noiseData.set(key, d);
  }
  return d;
}
const noiseCache = new WeakMap();
function noise(ctx, seconds, seed) {
  let per = noiseCache.get(ctx);
  if (!per) { per = new Map(); noiseCache.set(ctx, per); }
  const key = seconds + ':' + seed;
  if (per.has(key)) return per.get(key);
  const len = Math.ceil(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  buf.copyToChannel(noiseSamples(len, seed), 0);
  per.set(key, buf);
  return buf;
}
const NOISE = {                   // every (seconds, seed) a cue uses
  base: [[0.6, 21], ...[11, 12, 13, 14, 15, 31, 32, 33, 34, 35, 41, 42, 43, 51, 73].map((s) => [0.08, s]), [0.25, 72], [0.6, 77], [0.5, 81], [0.7, 82], [0.4, 83]],
  long: [[2, 71], ...[61, 62, 63, 64, 65, 66, 74, 75, 76, 91, 92, 93, 94].map((s) => [1, s])],
};
// Generate the samples ahead of the audio context (48 kHz lengths; 44.1 kHz uses a prefix).
export function noiseSteps(variant) {
  const list = [...NOISE.base, ...(variant === 'long' || variant === undefined ? NOISE.long : [])], steps = [];
  for (let i = 0; i < list.length; i += 4) steps.push(() => { for (const [sec, seed] of list.slice(i, i + 4)) noiseSamples(Math.ceil(sec * 48000), seed); });
  if (variant !== 'still') { steps.push(() => irSamples(48000, 0)); steps.push(() => irSamples(48000, 1)); }
  return steps;
}

// The room: a stereo impulse response from seeded noise, 1.3 s (RT60), darkening as it decays
// (a one-pole low-pass whose cutoff falls from ~7 kHz to ~1.1 kHz), a few early reflections,
// normalised to unit energy so LEVEL.wet is the send's level. Same samples every time.
const irData = new Map();
function irSamples(sr, ch) {
  const key = sr + ':' + ch;
  if (irData.has(key)) return irData.get(key);
  const len = Math.round(1.3 * sr), d = new Float32Array(len), rnd = mulberry32(101 + ch);
  let y = 0, e = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr, fc = 1100 + 6000 * Math.exp(-t / 0.35), a = 1 - Math.exp(-2 * Math.PI * fc / sr);
    y += a * (rnd() * 2 - 1 - y);
    const env = Math.exp(-t / 0.19) * Math.min(1, t / 0.018);
    d[i] = y * env;
  }
  const er = mulberry32(201 + ch);
  for (let k = 0; k < 7; k++) {                       // early reflections, 7-41 ms, alternating sign
    const i = Math.round((0.007 + 0.034 * k / 6 + 0.003 * er()) * sr);
    d[i] += (k % 2 ? -1 : 1) * 0.5 * Math.exp(-k / 3);
  }
  for (let i = 0; i < len; i++) e += d[i] * d[i];
  const g = 1 / Math.sqrt(e);
  for (let i = 0; i < len; i++) d[i] *= g;
  irData.set(key, d);
  return d;
}
const roomCache = new WeakMap();
function room(ctx) {                     // one convolver per context (preparing it costs ~15 ms; 60 ms at 4x CPU)
  let r = roomCache.get(ctx);
  if (r) return r;
  const buf = ctx.createBuffer(2, Math.round(1.3 * ctx.sampleRate), ctx.sampleRate);
  buf.copyToChannel(irSamples(ctx.sampleRate, 0), 0); buf.copyToChannel(irSamples(ctx.sampleRate, 1), 1);
  const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = buf;
  r = { conv, wet: null };
  roomCache.set(ctx, r);
  return r;
}
// send a voice into the room (only inside a cue that has one)
function toRoom(ctx, out, node, amount) {
  if (!out.room || !amount) return;
  const g = ctx.createGain(); g.gain.value = amount;
  node.connect(g); g.connect(out.room);
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

let ceilCurve = null, ceilAt = 0;
function ceilingCurve() {                 // odd length, symmetric: 0 -> exactly 0 (silence stays digital silence)
  if (ceilCurve && ceilAt === LEVEL.ceiling) return ceilCurve;
  const n = 4097, c = LEVEL.ceiling, k = 0.6 * c / 0.84; ceilCurve = new Float32Array(n); ceilAt = c;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1, ax = Math.abs(x);
    const y = ax <= k ? ax : k + (c - k) * Math.tanh((ax - k) / (c - k));
    ceilCurve[i] = Math.sign(x) * y;
  }
  ceilCurve[(n - 1) / 2] = 0;
  return ceilCurve;
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
  src.buffer = noise(ctx, o.len || 0.08, o.seed);      // o.len: long enough for the envelope to reach silence
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = o.f; bp.Q.value = o.q;
  const g = ctx.createGain();
  const a = o.attack || 0.0005, h = o.hold || 0;
  g.gain.value = 0;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(o.gain, at + a);
  if (h) g.gain.setValueAtTime(o.gain, at + a + h);
  g.gain.setTargetAtTime(0, at + a + h, o.tau);
  src.connect(bp); bp.connect(g);
  const pn = panned(ctx, g, o.pan);
  pn.connect(out); toRoom(ctx, out, pn, o.rev);
  src.start(at); src.stop(Math.max(at + Math.min(o.len || 0.08, a + h + o.tau * 12 + 0.002), quiet));
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
  const pn = panned(ctx, last, o.pan);
  pn.connect(out); toRoom(ctx, out, pn, o.rev);
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
    const v = e.v, s = e.small ? 0.55 : 1, cr = e.crack || 1, rv = e.rev || 0;   // crack: the 2-5 kHz layers' gain (impactXL: +3.5 dB)
    // crack: hard and short (4-5 ms: 0.3 ms attack, 1.5 ms hold, fast decay), plus an 8 kHz
    // edge and a resonant metal body at 2.9 / 3.4 kHz - this is what carries the hit on
    // laptop speakers, where nothing under ~180 Hz exists
    burst(ctx, out, at, { seed: 41, f: 1900, q: 0.9, gain: 2.4 * v * s * cr, attack: 0.0003, hold: 0.0015, tau: 0.0012, pan: e.pan, rev: rv });
    burst(ctx, out, at, { seed: 42, f: 8200, q: 0.8, gain: 0.5 * v * s * cr, attack: 0.0003, hold: 0.0008, tau: 0.0010, pan: e.pan });
    burst(ctx, out, at, { seed: 43, f: 2950, q: 9, gain: 1.4 * v * s * cr, attack: 0.0004, hold: 0.001, tau: 0.009, pan: e.pan, rev: rv });
    tone(ctx, out, at, { f0: 3380, gain: 0.09 * v * s * cr, attack: 0.0004, tau: 0.008, len: 0.1, pan: e.pan, rev: rv });
    // body: the thud of a heavy part seating, saturated so 2nd/3rd harmonics carry it on laptop speakers.
    // Everything after the hit sits on one 48 Hz harmonic series (thud lands on 48, ready tone 96/144/192),
    // so nothing beats against anything: the lock literally locks.
    // The body starts 1.8 ms after the crack (the crack is the contact, the thud the mass
    // arriving behind it): their peaks do not stack, so the hit is louder at the same true peak.
    const f0 = 70 + 80 * v, tb = at + 0.0018;
    tone(ctx, out, tb, { f0, f1: 48, glide: e.halfPeriod, gain: 0.56 * s * (e.body || 1), attack: 0.002, tau: 0.075, len: 0.5, sat: true, lp: 1400 });
    tone(ctx, out, tb, { f0: 2 * f0, f1: 96, glide: e.halfPeriod, gain: 0.28 * s, attack: 0.002, tau: 0.055, len: 0.35 });
    tone(ctx, out, tb, { f0: 3 * f0, f1: 144, glide: e.halfPeriod, gain: 0.12 * s, attack: 0.002, tau: 0.04, len: 0.3 });
    // the seat: two short partials higher up the same 48 Hz series (288 = 6 x 48, 432 = 9 x 48),
    // so the weight of the hit survives on speakers that have no bass
    tone(ctx, out, tb, { f0: 288, gain: 0.09 * s, attack: 0.0015, tau: 0.045, len: 0.4 });
    tone(ctx, out, tb, { f0: 432, gain: 0.06 * s, attack: 0.0015, tau: 0.03, len: 0.3 });
    if (!e.small) {
      // sub and its harmonics: felt on headphones; 96/144 Hz keep it audible on small speakers
      tone(ctx, out, at, { f0: 48, gain: 0.085, attack: 0.006, hold: 0.008, tau: 0.16, len: 1.0 });
      tone(ctx, out, at, { f0: 96, gain: 0.1, attack: 0.004, hold: 0.01, tau: 0.10, len: 0.6 });
      tone(ctx, out, at, { f0: 144, gain: 0.08, attack: 0.004, tau: 0.07, len: 0.5 });
    }
    // the latch: two inharmonic partials, ringing out with the spring that drives the picture
    tone(ctx, out, at + 0.002, { f0: 1180, gain: 0.13 * s, attack: 0.0008, tau: e.tau, len: 0.35, pan: e.pan, rev: rv });
    tone(ctx, out, at + 0.002, { f0: 2013, gain: 0.08 * s, attack: 0.0008, tau: e.tau * 0.7, len: 0.3, pan: e.pan, rev: rv });
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
  // ---------------------------------------------------------------- the long cue
  // the ember catches: three tiny dry crackles
  ember(ctx, out, at, e) {
    [[0, 1], [0.023, 0.6], [0.051, 0.8]].forEach(([d, g], i) =>
      burst(ctx, out, at + d, { seed: 13 + i, f: 3100 + 700 * i, q: 2.2, gain: 0.16 * g, attack: 0.0004, tau: 0.0018, pan: e.pan }));
  },
  // anticipation: a low drone (48 / 72 Hz, a dark rumble) that swells and is cut dead
  drone(ctx, out, at, e) {
    const dur = e.dur, g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.setValueCurveAtTime(Float32Array.from(e.gain, (x) => x * LEVEL.drone), at, dur);
    const stopAt = Math.max(at + dur + 0.02, quiet);
    for (const [f, a, type] of [[48, 1, 'sine'], [72, 0.42, 'sine'], [96, 0.16, 'triangle'], [144, 0.05, 'sine']]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(g);
      o.start(at); o.stop(stopAt);
    }
    const n = ctx.createBufferSource(); n.buffer = noise(ctx, 2, 71); n.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 170; lp.Q.value = 0.6;
    const ng = ctx.createGain(); ng.gain.value = 0.9;
    n.connect(lp); lp.connect(ng); ng.connect(g);
    g.connect(out);
    n.start(at); n.stop(stopAt);
  },
  // the ember charging (act 1): a capacitor whine rising three octaves under a soft spool of
  // filtered noise, both swelling, cut the instant the streak fires
  charge(ctx, out, at, e) {
    const dur = e.dur, end = at + dur, stopAt = Math.max(end + 0.02, quiet);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at);
    g.gain.setTargetAtTime(LEVEL.charge, at, dur * 0.45);
    g.gain.setValueAtTime(LEVEL.charge * 0.9, end - 0.006); g.gain.linearRampToValueAtTime(0, end);
    for (const [det, a] of [[0, 1], [7, 0.6]]) {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.detune.value = det;
      o.frequency.setValueAtTime(220, at); o.frequency.exponentialRampToValueAtTime(1760, end);
      const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(g);
      o.start(at); o.stop(stopAt);
    }
    const n = ctx.createBufferSource(); n.buffer = noise(ctx, 1, 65); n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 5;
    bp.frequency.setValueAtTime(600, at); bp.frequency.exponentialRampToValueAtTime(4800, end);
    const ng = ctx.createGain(); ng.gain.value = 2.2; n.connect(bp); bp.connect(ng); ng.connect(g);
    n.start(at); n.stop(stopAt);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.5;
    g.connect(lp); panned(ctx, lp, e.pan).connect(out);
  },
  // celebrate()'s re-lock lands: a short, dry thump (no sub: a knock with a little body)
  thump(ctx, out, at, e) {
    const a = e.gain || 1;
    tone(ctx, out, at, { f0: 150, f1: 70, glide: 0.035, gain: 0.2 * a, attack: 0.002, tau: 0.045, len: 0.4, sat: true, lp: 900, pan: e.pan });
    burst(ctx, out, at, { seed: 72, f: 260, q: 1.1, gain: 0.35 * a, attack: 0.0015, tau: 0.014, len: 0.25, pan: e.pan });
    burst(ctx, out, at, { seed: 41, f: 2400, q: 1.2, gain: 0.5 * a, attack: 0.0003, hold: 0.001, tau: 0.0015, pan: e.pan, rev: 0.4 });
    burst(ctx, out, at, { seed: 43, f: 2950, q: 9, gain: 0.35 * a, attack: 0.0004, tau: 0.008, pan: e.pan, rev: 0.6 });
  },
  // a soft low pulse (celebrate()'s calm variant)
  beat(ctx, out, at, e) {
    const a = e.gain * LEVEL.beat;
    tone(ctx, out, at, { f0: 66, f1: 40, glide: 0.09, gain: 0.62 * a, attack: 0.004, tau: 0.08, len: 0.7, sat: true, lp: 520 });
    tone(ctx, out, at, { f0: 132, f1: 80, glide: 0.09, gain: 0.14 * a, attack: 0.003, tau: 0.045, len: 0.4 });
    burst(ctx, out, at, { seed: 72, f: 240, q: 1.1, gain: 0.55 * a, attack: 0.002, tau: 0.016, len: 0.25 });
    burst(ctx, out, at, { seed: 73, f: 900, q: 1.4, gain: 0.08 * a, attack: 0.001, tau: 0.006 });
  },
  // a light streak passing: noise through a band-pass that follows the head (pitch drops as
  // it passes, brightest in the middle), plus a low-passed body; pan follows the head
  whoosh(ctx, out, at, e) {
    const dur = e.dur, stopAt = Math.max(at + dur + 0.02, quiet);
    const src = ctx.createBufferSource(); src.buffer = noise(ctx, 1, e.seed || 61); src.loop = true;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at);
    g.gain.setValueCurveAtTime(Float32Array.from(e.gain, (x) => x * LEVEL.whoosh), at, dur);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = e.q;
    bp.frequency.setValueCurveAtTime(Float32Array.from(e.freq), at, dur);
    src.connect(bp); bp.connect(g);
    if (e.body) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
      lp.frequency.setValueCurveAtTime(Float32Array.from(e.freq, (f) => f * 0.4), at, dur);
      const bg = ctx.createGain(); bg.gain.value = e.body * 0.9;
      src.connect(lp); lp.connect(bg); bg.connect(g);
    }
    let last = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.setValueCurveAtTime(Float32Array.from(e.pan), at, dur);
      g.connect(p); last = p;
    }
    last.connect(out);
    src.start(at); src.stop(stopAt);
  },
  // the riser, locked to the light: three detuned saws an octave up through a resonant low-pass
  // that opens, a sub an octave below, a noise band rising with them - both pulsing with each
  // rush of light - then a reversed swell (the suck-back) and a dead cut into silence
  riser(ctx, out, at, e) {
    const dur = e.dur, end = at + dur, stopAt = Math.max(end + 0.02, quiet);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at);
    g.gain.setValueCurveAtTime(Float32Array.from(e.gain, (x) => x * LEVEL.riser), at, dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
    lp.frequency.setValueAtTime(e.cut0, at); lp.frequency.exponentialRampToValueAtTime(e.cut1, end);
    for (const [det, a] of [[-11, 0.8], [0, 1], [8, 0.8]]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = det;
      o.frequency.setValueAtTime(e.f0, at); o.frequency.exponentialRampToValueAtTime(e.f1, end);
      const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(lp);
      o.start(at); o.stop(stopAt);
    }
    const sub = ctx.createOscillator(); sub.type = 'sine';
    sub.frequency.setValueAtTime(e.f0 / 2, at); sub.frequency.exponentialRampToValueAtTime(e.f1 / 2, end);
    const sg = ctx.createGain(); sg.gain.value = 1.6; sub.connect(sg); sg.connect(g);
    sub.start(at); sub.stop(stopAt);
    lp.connect(g); g.connect(out);
    // noise band
    const n = ctx.createBufferSource(); n.buffer = noise(ctx, 1, 74); n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(700, at); bp.frequency.exponentialRampToValueAtTime(7500, end);
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0, at);
    ng.gain.setValueCurveAtTime(Float32Array.from(e.ngain, (x) => x * LEVEL.noise), at, dur);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(at); n.stop(stopAt);
    // the suck-back: a reversed swell, high-passed air rising exponentially into the cut
    const r = ctx.createBufferSource(); r.buffer = noise(ctx, 1, 75); r.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2400; hp.Q.value = 0.7;
    const rg = ctx.createGain(); const rs = end - e.rev;
    rg.gain.setValueAtTime(0, at); rg.gain.setValueAtTime(0.0001, rs);
    rg.gain.exponentialRampToValueAtTime(LEVEL.rev, end - 0.004); rg.gain.linearRampToValueAtTime(0, end);
    r.connect(hp); hp.connect(rg); rg.connect(out);
    r.start(at); r.stop(stopAt);
  },
  // the ignition: the 1.2.0 hit (crack, metal body, thud, seat, sub, latch) plus a sub drop,
  // a punch, a metallic ring and an airy, wide tail
  impactXL(ctx, out, at, e) {
    EVENTS.impact(ctx, out, at, { ...e, crack: 1.5, rev: 0.5, body: 0.75, halfPeriod: Math.min(e.halfPeriod, 0.022) });   // the thud lands on 48 Hz in 22 ms
    // the sub drop: reaches 48 Hz within ~30 ms (everything after the hit lands on 48 Hz, no
    // beating), short (tau 0.16 s): felt as part of the hit on headphones, not a late boom
    tone(ctx, out, at, { f0: 98, f1: 48, glide: 0.02, gain: 0.22, attack: 0.003, hold: 0.006, tau: 0.15, len: 1.6, sat: true, lp: 240 });
    tone(ctx, out, at, { f0: 56, f1: 48, glide: 0.02, gain: 0.145, attack: 0.003, hold: 0.008, tau: 0.16, len: 1.6 });
    burst(ctx, out, at + 0.001, { seed: 81, f: 170, q: 0.7, gain: 1.5, attack: 0.0015, hold: 0.004, tau: 0.03, len: 0.5 });
    burst(ctx, out, at + 0.0015, { seed: 82, f: 700, q: 0.9, gain: 0.5, attack: 0.0015, tau: 0.05, len: 0.7, rev: 0.3 });
    // the mid body: what makes the hit land on laptop speakers (nothing below ~180 Hz there)
    burst(ctx, out, at + 0.0008, { seed: 83, f: 1250, q: 1.1, gain: 0.9, attack: 0.0006, hold: 0.002, tau: 0.022, len: 0.4, rev: 0.4 });
    // the shatter: bright metal noise (2-6 kHz) that outlasts the crack - the hit stays on top
    // of the riser above 1 kHz, where laptops and phones still play
    burst(ctx, out, at + 0.0004, { seed: 82, f: 3900, q: 0.75, gain: 0.85, attack: 0.0004, hold: 0.004, tau: 0.032, len: 0.7, rev: 0.6 });
    tone(ctx, out, at + 0.0018, { f0: 330, f1: 220, glide: 0.06, gain: 0.16, attack: 0.002, tau: 0.09, len: 1.0, sat: true });
    // the metal: inharmonic partials of the struck part. They ring on (0.4-1.1 s) into the
    // chord and through the room - the tail grows out of the hit instead of being pasted on
    for (const [f, g, tau, pan] of [[1571, 0.04, 1.1, -0.2], [2953, 0.034, 0.85, 0.15], [4733, 0.02, 0.6, -0.1], [6112, 0.012, 0.4, 0.25], [3797, 0.018, 0.7, 0.3]])
      tone(ctx, out, at + 0.001, { f0: f, gain: g, attack: 0.0006, tau, len: 5 * tau + 0.2, pan, rev: 0.7 });
    // the air: two decorrelated noise sources, left and right, high-passed, decaying, into the room
    for (const [seed, pan] of [[91, -0.75], [92, 0.75]]) {
      const n = ctx.createBufferSource(); n.buffer = noise(ctx, 1, seed); n.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3200; hp.Q.value = 0.6;
      const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 7000; pk.gain.value = 5; pk.Q.value = 0.8;
      const ng = ctx.createGain(); ng.gain.setValueAtTime(0, at);
      ng.gain.linearRampToValueAtTime(0.16, at + 0.006); ng.gain.setTargetAtTime(0, at + 0.006, 0.2);
      n.connect(hp); hp.connect(pk); pk.connect(ng);
      const pn = panned(ctx, ng, pan); pn.connect(out); toRoom(ctx, out, pn, 0.5);
      n.start(at); n.stop(Math.max(at + 3, quiet));
    }
  },
  // the tail: the metal rings into a quiet chord on the 48 Hz series (G: 192 / 288 and the
  // suspension 256) that resolves to the major third (240) with the light sweep; detuned
  // pairs an octave and two up shimmer (slow beating only - no tremolo). Low voices decay
  // fast (tau <= 0.5 s): no pad sitting in the 150-500 Hz band. Through the room.
  tail(ctx, out, at, e) {
    const res = at + e.resolve, end = at + e.dur, stopAt = Math.max(end + 0.05, quiet);
    const bus = ctx.createGain(); bus.gain.value = LEVEL.tail; bus.connect(out); toRoom(ctx, out, bus, 0.8);
    const voice = (f, gain, on, atk, tau, off, pan) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.setValueAtTime(0, on);
      g.gain.linearRampToValueAtTime(gain, on + atk); g.gain.setTargetAtTime(0, on + atk, tau);
      if (off) { g.gain.cancelScheduledValues(off); g.gain.setTargetAtTime(0, off, 0.09); }
      o.connect(g); panned(ctx, g, pan).connect(bus);
      o.start(at); o.stop(stopAt);
      return g;
    };
    voice(192, 0.026, at, 0.06, 0.45, 0, 0);
    voice(96, 0.014, at, 0.04, 0.35, 0, 0);
    voice(288, 0.018, at, 0.1, 0.55, 0, 0.1);
    voice(256, 0.015, at + 0.04, 0.14, 0.6, res, -0.15);          // the suspension ...
    voice(240, 0.016, res - 0.03, 0.2, 0.55, 0, 0.15);            // ... resolves
    voice(480, 0.014, res, 0.25, 0.7, 0, 0.3);
    const shimmer = (f, gain, on, tau, pan) => {
      for (const [d, p] of [[1, -pan], [1.0021, pan]]) {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * d;
        const g = ctx.createGain(); g.gain.setValueAtTime(0, at); g.gain.setValueAtTime(0, on);
        g.gain.linearRampToValueAtTime(gain, on + 0.3); g.gain.setTargetAtTime(0, on + 0.3, tau);
        o.connect(g); panned(ctx, g, p).connect(bus);
        o.start(at); o.stop(stopAt);
      }
    };
    shimmer(768, 0.009, at + 0.05, 0.7, 0.5);
    shimmer(1152, 0.007, at + 0.1, 0.6, 0.6);
    shimmer(960, 0.008, res, 0.6, 0.55);
    shimmer(1536, 0.0045, res + 0.05, 0.5, 0.7);
  },
  // the light sweep: high air that travels with it, and one soft bell at its middle
  glint(ctx, out, at, e) {
    const dur = e.dur, q = e.quiet ? 0.6 : 1;
    const n = ctx.createBufferSource(); n.buffer = noise(ctx, 1, 76); n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 7800; bp.Q.value = 1.6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.11 * q, at + dur * 0.48); g.gain.linearRampToValueAtTime(0, at + dur);
    n.connect(bp); bp.connect(g);
    let last = g;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.setValueCurveAtTime(Float32Array.from(e.pan), at, dur); g.connect(p); last = p; }
    last.connect(out); toRoom(ctx, out, last, 0.6);
    n.start(at); n.stop(Math.max(at + dur + 0.02, quiet));
    if (!e.quiet && typeof e.ting === 'number') {        // the old bell, 6 dB down (the long cue no longer asks for it)
      tone(ctx, out, at + e.ting, { f0: 1536, gain: 0.011, attack: 0.004, tau: 0.5, len: 2.0, pan: 0.2, rev: 0.5 });
      tone(ctx, out, at + e.ting, { f0: 2304, gain: 0.006, attack: 0.004, tau: 0.32, len: 1.5, pan: 0.3, rev: 0.5 });
    }
  },
  // celebrate(): a bright resolved chord (G major, two octaves above the tail), shimmering
  chime(ctx, out, at, e) {
    [[768, 0.03, 0.7], [960, 0.024, 0.6], [1152, 0.02, 0.55], [1536, 0.012, 0.45], [1920, 0.006, 0.35]].forEach(([f, g, tau], i) => {
      tone(ctx, out, at + i * 0.012, { f0: f, gain: g, attack: 0.006, tau, len: 2.2, pan: e.pan + (i % 2 ? 0.25 : -0.25), rev: 0.6 });
      tone(ctx, out, at + i * 0.012, { f0: f * 1.0023, gain: g * 0.6, attack: 0.02, tau: tau * 1.2, len: 2.2, pan: e.pan + (i % 2 ? -0.25 : 0.25), rev: 0.6 });
    });
  },
  // the short intro's strike: a small sizzle of sparks after the hit
  spark(ctx, out, at, e) {
    burst(ctx, out, at, { seed: 77, f: 6500, q: 1.2, gain: 0.12 * e.gain, attack: 0.002, hold: 0.01, tau: 0.04, pan: e.pan, len: 0.6 });
  },
};

// Schedule a plan on ctx. `when` = audio time of plan time 0. fromMs drops events already past.
// Returns { stop(fadeMs), end } - end is the audio time the cue is silent.
// opt.staged: the events are returned as `jobs` (one closure per event, in time order) for the
// caller to run over several tasks, instead of all at once - see intro.js startCue().
export function scheduleCue(ctx, dest, when, plan, fromMs = 0, opt = {}) {
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
  master.gain.value = (plan.name === 'long' ? LEVEL.long : LEVEL.master) * (plan.gain || 1);
  bus.connect(hp); hp.connect(master);
  if (plan.reverb && ctx.createConvolver) {   // the room: sends -> convolver -> this cue's return -> the same high-pass, master, fade
    const r = room(ctx), ret = ctx.createGain(); ret.gain.value = LEVEL.wet;
    try { r.conv.disconnect(); } catch (e) { /* first use */ }
    r.conv.connect(ret); ret.connect(hp);
    const send = ctx.createGain(), shp = ctx.createBiquadFilter();   // the send is high-passed: no low mid in the room (no mud)
    shp.type = 'highpass'; shp.frequency.value = 380; shp.Q.value = 0.6;
    send.connect(shp); shp.connect(r.conv);
    bus.room = send;
  }
  if (plan.name === 'long') {               // a soft ceiling: linear below 0.6, then rounds off to LEVEL.ceiling
    const ws = ctx.createWaveShaper(); ws.curve = ceilingCurve(); ws.oversample = '4x';
    master.connect(ws); ws.connect(dest);
  } else master.connect(dest);
  const q = quiet, jobs = [];
  for (const e of [...plan.events].sort((a, b) => a.t - b.t)) {
    const t = e.t / 1000;
    if (t < from - 0.004) continue;
    jobs.push(() => { const keep = quiet; quiet = q; EVENTS[e.type](ctx, bus, when + t - from, e); quiet = keep; });
  }
  if (!opt.staged) for (const j of jobs.splice(0)) j();
  const level = master.gain.value;
  if (plan.gate) {                          // the held breath: digital silence before the hit (filter and sub tails cut)
    const g0 = when + plan.gate[0] / 1000 - from, g1 = when + plan.gate[1] / 1000 - from;
    if (g0 > ctx.currentTime) {
      master.gain.setValueAtTime(level, g0); master.gain.linearRampToValueAtTime(0, g0 + 0.012);
      master.gain.setValueAtTime(0, g1 - 0.0008); master.gain.setValueAtTime(level, g1 - 0.0004);
    }
  }
  master.gain.setValueAtTime(level, fa);
  master.gain.linearRampToValueAtTime(0, fb);
  return {
    jobs,
    end: fb,
    stop(fadeMs = 60) {
      const now = ctx.currentTime, g = master.gain;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + fadeMs / 1000);
    },
  };
}

// Build the noise buffers (from noiseSteps()' samples: a copy, cheap) and the shaper curves,
// and touch every node type once, so the first scheduleCue() is cheap. intro.js runs
// noiseSteps() one per task before it creates the context, then this in its own task.
export function prewarm(ctx, variant) {
  if (!ctx) return;
  const long = variant === 'long' || variant === undefined;
  for (const [sec, seed] of [...NOISE.base, ...(long ? NOISE.long : [])]) noise(ctx, sec, seed);
  saturation(); if (long) ceilingCurve();
  const sink = ctx.createGain(); sink.gain.value = 0;
  const nodes = [ctx.createOscillator(), ctx.createBiquadFilter(), ctx.createWaveShaper(), ctx.createBufferSource()];
  if (ctx.createStereoPanner) nodes.push(ctx.createStereoPanner());
  for (const n of nodes) { n.connect(sink); n.disconnect(); }
}

// The room's convolver for this context: the one expensive step (~15 ms, ~60 ms with the CPU
// 4x slower), so intro.js runs it in a task of its own at start-up, before the clock starts.
export function prewarmRoom(ctx) { if (ctx && ctx.createConvolver) room(ctx); }

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
export function setLevel(name, x) { LEVEL[name] = x; }
export function levels() { return { ...LEVEL }; }
export function masterLevel() { return LEVEL.master; }
