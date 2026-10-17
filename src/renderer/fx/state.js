// FX state model. Every frame is a pure function of (t, snapshot):
//  - state changes are time-stamped records; each blends in with smoothstep(t0, t0 + dur)
//  - progress uses a closed-form critically damped spring (omega = 7/s), only the last segment is stored
//  - pulses are a ring buffer of the last 4 (t0, amp, cx, cy); bursts / warps are start times
// evaluate() writes everything the renderer needs into a preallocated frame object (no allocations).
import { INTRO_FULL, INTRO_SHORT, ASM_W, ASM_J, bootLook, introTau, sstep, mix, clamp01, flashEnv, climaxEnv, shakeN } from './timeline.js';
import { WORD_DY, WORD_H } from './emblem/raster.js';

export const STATES = ['boot', 'idle', 'home', 'installing', 'success', 'error'];
const ALIAS = { scan: 'installing' };
const BLEND = { boot: 0.0, idle: 0.6, home: 0.6, installing: 0.6, success: 0.6, error: 0.35 };
export const DEFAULT_ANCHOR = Object.freeze([0, 0.16, 0.45]); // world centre + scale of the hero emblem

export const PARAMS = [
  'intensity', 'swirl', 'idle', 'reveal', 'rim', 'heatAmt', 'wordHeat', 'fill', 'plasmaClimax', 'flameY', 'hue', 'desat', 'flameBoost',
  'diskGrow', 'cloudA', 'diskA', 'asm', 'asmW', 'asmJ', 'indet', 'flashW', 'wordAsm', 'wordA', 'jitter', 'emberRate', 'emberDir', 'emberA',
  'lineReveal', 'lineAlpha', 'lineEnergy', 'penHead', 'packet', 'glowAmt', 'occl', 'crack',
  'wordAlpha', 'wordWipe', 'sweep', 'wordIgnite', 'wordGlow',
  'ancX', 'ancY', 'ancS', 'embX', 'embY', 'embS', 'wordX', 'wordY', 'wordH',
  'bloomAmt', 'raysAmt', 'streakAmt', 'vig', 'grain', 'scrimAmt', 'exposure', 'ca', 'spark', 'flare',
];
export const P = Object.freeze(Object.fromEntries(PARAMS.map((n, i) => [n, i])));
const NP = PARAMS.length;

// ---------------------------------------------------------------------------------------------
// snapshot
export function createSnapshot({ reducedMotion = false, intensity = 1 } = {}) {
  return {
    v: 1,
    rm: !!reducedMotion,
    intensity,
    states: [{ s: 'idle', t0: -1000, dur: 0, p0: 0, cloud0: 0, asm0: 0, rev0: 0, alpha0: 0 }],
    intro: null, // { mode, t0, skipT, head: {emb:[x,y,w,h], word:[x,y,w,h]} | null }
    prog: { x0: 0, v0: 0, target: 0, tSet: -1000, indet: 0, indetT: -1000 },
    pulses: [
      [-1000, 0, 0, 0],
      [-1000, 0, 0, 0],
      [-1000, 0, 0, 0],
      [-1000, 0, 0, 0],
    ],
    pulseIdx: 0,
    bursts: [], // [{ t, amp, frac }] (last 2)
    warp: { t0: -1000, dur: 0.7 },
    anchor: { from: null, to: null, t0: -1000 }, // CSS rects [x,y,w,h] or null (= default)
    scrim: [], // CSS rects [x,y,w,h], up to 4
  };
}

export const cloneSnapshot = (s) => JSON.parse(JSON.stringify(s));

export const normState = (name) => {
  const n = ALIAS[name] || name;
  return STATES.includes(n) ? n : null;
};

const OMEGA = 7;
/** Closed-form critically damped spring of the last progress segment. */
export function springAt(prog, t, out) {
  const dt = Math.max(0, t - prog.tSet);
  const d = prog.x0 - prog.target;
  const e = Math.exp(-OMEGA * dt);
  out.x = prog.target + (d + (prog.v0 + OMEGA * d) * dt) * e;
  out.v = (prog.v0 - OMEGA * (prog.v0 + OMEGA * d) * dt) * e;
  return out;
}
const SP = { x: 0, v: 0 };

export function setProgress(snap, t, p, reset = false) {
  const pr = snap.prog;
  springAt(pr, t, SP);
  if (p == null || Number.isNaN(p)) {
    if (!pr.indet) {
      pr.indet = 1;
      pr.indetT = t;
    }
    return;
  }
  const v = clamp01(Number(p));
  if (pr.indet) {
    pr.indet = 0;
    pr.indetT = t;
  }
  pr.x0 = reset ? v : SP.x;
  pr.v0 = reset ? 0 : SP.v;
  pr.target = reset ? v : Math.max(pr.target, v); // the shown value only rises unless reset
  pr.tSet = t;
}

/** Pushes a state record. F = frame evaluated at t with the previous snapshot (entry values). */
export function pushState(snap, name, t, F, immediate = false) {
  const s = normState(name);
  if (!s) return false;
  const top = snap.states[snap.states.length - 1];
  if (top.s === s && s !== 'success') return false;
  springAt(snap.prog, t, SP);
  const rec = {
    s,
    t0: t,
    dur: immediate ? 0 : BLEND[s],
    p0: clamp01(SP.x),
    cloud0: F ? F.cloudA : 0,
    asm0: F ? F.asm : 0,
    rev0: F ? F.lineReveal : 0,
    alpha0: F ? F.lineAlpha : 0,
  };
  // drop records that are fully covered by a completed blend
  const st = snap.states;
  for (let i = st.length - 1; i > 0; i--) {
    if (t >= st[i].t0 + st[i].dur) {
      st.splice(0, i);
      break;
    }
  }
  st.push(rec);
  while (st.length > 4) st.shift();
  if (s === 'installing' && snap.prog.target >= 0.999 && top.s !== 'installing') setProgress(snap, t, 0, true);
  return true;
}

export function addPulse(snap, t, amp, cx, cy) {
  const p = snap.pulses[snap.pulseIdx];
  p[0] = t;
  p[1] = amp;
  p[2] = cx;
  p[3] = cy;
  snap.pulseIdx = (snap.pulseIdx + 1) % 4;
}

export function addBurst(snap, t, amp = 0.7, frac = 1) {
  snap.bursts.push({ t, amp, frac });
  while (snap.bursts.length > 2) snap.bursts.shift();
}

// ---------------------------------------------------------------------------------------------
// frame
export function createFrame() {
  return {
    t: 0,
    plasmaT: 0,
    p: new Float32Array(NP), // blended params (indices P)
    // discrete
    introT: -100,
    igniteT: -100,
    penT0: 0,
    penK: 1,
    penGain: 0,
    burnT: -100,
    dropT: -100,
    climaxT: -100, // time since the active climax (s)
    climaxAmt: 0,
    climax: 0,
    inhale: 0,
    shock: 0,
    shockR: 0,
    shockAmp: 0,
    shockW: 0.1,
    shockGlow: 0,
    flash: 0,
    flashCap: 0.6,
    punch: 0,
    shakeX: 0,
    shakeY: 0, // CSS px
    burstT: -100,
    sparkFrac: 1,
    sparkGain: 0,
    pulseSoft: 0,
    pulses: new Float32Array(16),
    pulseActive: false,
    scrims: new Float32Array(16), // CSS px rects
    scrimCount: 0,
    warpEnv: 0,
    warpU: 0,
    warpRB: 0,
    warpTunnel: 0,
    introDoneAt: Infinity, // engine time at which onIntroDone is due
    bootActive: false,
    // convenience mirrors used by pushState
    cloudA: 0,
    asm: 0,
    lineReveal: 0,
    lineAlpha: 0,
  };
}

const A0 = new Float32Array(NP);
const A1 = new Float32Array(NP);
const D = { climaxLocal: 0, burnT: -100, dropT: -100, introT: -100, igniteT: -100, penT0: 0, penK: 1, penGain: 0, inhale: 0, shakeAmp: 0 };
const XF = { boot: [0, 0, 0], head: [0, 0, 0], bootWord: [0, 0, 0], headWord: [0, 0, 0] };
const C = { anc: [0, 0, 0.45], pv: 0, indet: 0, env: null };

function rectToXf(env, r, out, ringFit = true) {
  const wpp = 2 / (env.cssH * env.content); // world units per CSS px
  const cx = r[0] + r[2] / 2;
  const cy = r[1] + r[3] / 2;
  out[0] = ((cx / env.cssW) * 2 - 1) * (env.aspect / env.content);
  out[1] = (1 - (cy / env.cssH) * 2) / env.content;
  out[2] = ringFit ? (Math.min(r[2], r[3]) * 0.5 * wpp) / 1.1 : r[3] * wpp;
  return out;
}

const T3a = [0, 0, 0];
const T3b = [0, 0, 0];
function anchorAt(snap, env, t, out) {
  const a = snap.anchor;
  const from = a.from ? rectToXf(env, a.from, T3a) : DEFAULT_ANCHOR;
  const to = a.to ? rectToXf(env, a.to, T3b) : DEFAULT_ANCHOR;
  const w = sstep(a.t0, a.t0 + 0.6, t);
  out[0] = mix(from[0], to[0], w);
  out[1] = mix(from[1], to[1], w);
  out[2] = mix(from[2], to[2], w);
  return out;
}

function setXf(A, anc) {
  A[P.ancX] = anc[0];
  A[P.ancY] = anc[1];
  A[P.ancS] = anc[2];
  A[P.embX] = anc[0];
  A[P.embY] = anc[1];
  A[P.embS] = anc[2];
  A[P.wordX] = anc[0];
  A[P.wordY] = anc[1] + WORD_DY * anc[2];
  A[P.wordH] = WORD_H * anc[2];
}

function idleLook(A, t) {
  A[P.intensity] = 0.62;
  A[P.swirl] = 0.3;
  A[P.idle] = 1;
  A[P.reveal] = 3.3;
  A[P.rim] = 0;
  A[P.heatAmt] = 0;
  A[P.wordHeat] = 0;
  A[P.fill] = 0;
  A[P.plasmaClimax] = 0;
  A[P.flameY] = -0.84;
  A[P.hue] = 0.45;
  A[P.desat] = 0;
  A[P.flameBoost] = 0;
  A[P.diskGrow] = 1;
  A[P.cloudA] = 0;
  A[P.diskA] = 0.25;
  A[P.asm] = 0;
  A[P.asmW] = 0.03;
  A[P.asmJ] = 0;
  A[P.indet] = 0;
  A[P.flashW] = 0.012;
  A[P.wordAsm] = 0;
  A[P.wordA] = 0;
  A[P.jitter] = 0;
  A[P.emberRate] = 1;
  A[P.emberDir] = 1;
  A[P.emberA] = 1;
  A[P.lineReveal] = 1;
  A[P.lineAlpha] = 0;
  A[P.lineEnergy] = 0;
  A[P.penHead] = 0;
  A[P.packet] = 0;
  A[P.glowAmt] = 1;
  A[P.occl] = 1;
  A[P.crack] = 0;
  A[P.wordAlpha] = 0;
  A[P.wordWipe] = 1.05;
  A[P.sweep] = 0;
  A[P.wordIgnite] = 0;
  A[P.wordGlow] = 1;
  setXf(A, C.anc);
  A[P.bloomAmt] = 0.55;
  A[P.raysAmt] = 0;
  A[P.streakAmt] = 0.4;
  A[P.vig] = 0.55;
  A[P.grain] = 0.035;
  A[P.scrimAmt] = 1;
  A[P.exposure] = 1;
  A[P.ca] = 0.0012;
  A[P.spark] = 0;
  A[P.flare] = 0;
}

function homeLook(A, t) {
  idleLook(A, t);
  A[P.intensity] = 0.68;
  A[P.hue] = 0.35;
  // ghost neon emblem at the anchor, breathing +-0.03 at 0.1 Hz
  A[P.lineAlpha] = 0.1 + 0.03 * Math.sin(t * Math.PI * 0.2);
  A[P.glowAmt] = 0.7;
  A[P.occl] = 0.3;
  A[P.packet] = 0.6;
  A[P.emberRate] = 1.2;
}

function installingLook(A, t) {
  idleLook(A, t);
  const p = clamp01(C.pv);
  A[P.intensity] = 0.62 + 0.25 * p;
  A[P.flameY] = mix(-1.05, -0.45, p);
  A[P.hue] = 0.3 + 0.3 * p;
  A[P.swirl] = 0.5;
  A[P.idle] = 0.78;
  A[P.heatAmt] = 0.12 + 0.3 * p;
  A[P.fill] = 0.25 * p;
  A[P.cloudA] = 1;
  A[P.diskA] = 0.25;
  A[P.asm] = p * 1.03;
  A[P.asmW] = 0.03;
  A[P.asmJ] = 0;
  A[P.indet] = C.indet;
  A[P.lineReveal] = p;
  A[P.lineAlpha] = 0.15 + 0.45 * p;
  A[P.penHead] = 0.6 * (1 - C.indet);
  A[P.packet] = 0.3;
  A[P.glowAmt] = 0.8;
  A[P.occl] = 0.8;
  A[P.bloomAmt] = 0.62;
  A[P.streakAmt] = 0.45;
}

function successLook(rec, A, t) {
  const sT = t - rec.t0;
  installingLook(A, t);
  const land = sstep(0, 0.4, sT);
  const tc = sT - 0.45;
  const climax = climaxEnv(tc);
  const ignite = tc < -0.02 ? 0 : Math.exp(-Math.max(tc, 0) * 2.6);
  A[P.indet] = 0;
  A[P.intensity] = 0.75 + 0.3 * climax;
  A[P.swirl] = mix(0.6, 0.35, sstep(0.5, 3.0, sT));
  A[P.idle] = mix(0.6, 0.95, sstep(0.6, 3.5, sT));
  A[P.flameY] = mix(-0.5, -0.8, sstep(1.0, 4.0, sT));
  A[P.hue] = mix(0.6, 0.4, sstep(0.5, 4.0, sT));
  A[P.heatAmt] = 0.5 * (1 - sstep(3.0, 4.5, sT));
  A[P.wordHeat] = 0.6 * sstep(0.35, 0.8, sT) * (1 - sstep(3.0, 4.2, sT));
  A[P.fill] = 0.4 * (1 - sstep(3.0, 4.2, sT));
  A[P.plasmaClimax] = 0.1 * climax;
  A[P.cloudA] = Math.max(rec.cloud0, land);
  A[P.asm] = mix(rec.p0 * 1.03, 1.06, land);
  A[P.flashW] = 0.02;
  A[P.lineReveal] = mix(rec.p0, 1, land);
  A[P.lineAlpha] = mix(0.6, 0.95, land);
  A[P.lineEnergy] = ignite;
  A[P.penHead] = 0;
  A[P.packet] = sstep(1.5, 2.5, sT);
  A[P.glowAmt] = 1;
  A[P.occl] = 1;
  A[P.wordAlpha] = sstep(0.3, 0.45, sT) * (1 - sstep(3.4, 4.4, sT));
  A[P.wordWipe] = clamp01((sT - 0.3) / 0.35) * 1.05;
  A[P.sweep] = clamp01((sT - 0.75) / 0.6);
  A[P.wordIgnite] = ignite;
  A[P.bloomAmt] = 0.75;
  A[P.streakAmt] = 0.5;
  A[P.scrimAmt] = 0.6;
  A[P.emberA] = 1;
  // returns to the home look after 5 s
  const back = sstep(3.8, 5.0, sT);
  if (back > 0) {
    homeLook(A1, t);
    for (let k = 0; k < NP; k++) A[k] += (A1[k] - A[k]) * back;
  }
}

function errorLook(rec, A, t) {
  const eT = t - rec.t0;
  idleLook(A, t);
  A[P.desat] = 0.55;
  A[P.intensity] = 0.35;
  A[P.hue] = 0;
  A[P.swirl] = 0.15;
  A[P.idle] = 0.9;
  A[P.flameY] = mix(-0.65, -0.95, sstep(0, 1.2, eT));
  A[P.heatAmt] = 0.08;
  A[P.cloudA] = rec.cloud0;
  A[P.asm] = rec.asm0;
  A[P.asmW] = 0.03;
  A[P.jitter] = 0.015;
  A[P.emberDir] = -1;
  A[P.emberA] = 0.8;
  A[P.emberRate] = 0.85;
  // neon line flickers off twice for 80 ms, then holds at 0.12; magenta cracks grow over 2.5 s
  const off = (eT > 0.1 && eT < 0.18) || (eT > 0.3 && eT < 0.38);
  A[P.lineReveal] = 1;
  A[P.lineAlpha] = off ? 0 : eT < 0.5 ? Math.max(rec.alpha0, 0.3) : 0.12 + (Math.max(rec.alpha0, 0.3) - 0.12) * (1 - sstep(0.5, 0.9, eT));
  A[P.glowAmt] = 0.6;
  A[P.occl] = 0.6;
  A[P.crack] = sstep(0.3, 2.8, eT);
  A[P.bloomAmt] = 0.45;
  A[P.streakAmt] = 0.25;
  A[P.vig] = 0.65;
  A[P.exposure] = 0.95;
}

function introConsts(snap) {
  return snap.intro && snap.intro.mode === 'short' ? INTRO_SHORT : INTRO_FULL;
}

function headerXf(env, head) {
  // header slot: titlebar logo + wordmark (CSS rects) – defaults match the titlebar layout
  rectToXf(env, head && head.emb ? head.emb : [14, 9, 22, 22], XF.head, true);
  const wr = head && head.word ? head.word : [44, 12, 74, 16];
  rectToXf(env, wr, XF.headWord, false);
  XF.headWord[2] *= 1.25; // DOM line box -> SDF text box (cap height ratio)
}

function look(rec, t, snap, env, A, isTop) {
  switch (rec.s) {
    case 'boot': {
      const K = introConsts(snap);
      const intro = snap.intro || { t0: rec.t0, skipT: null, mode: 'full' };
      let tau = introTau(intro, K, t);
      const rm = snap.rm || intro.mode === 'none';
      if (rm) tau = K.IDLE + Math.max(0, t - intro.t0);
      XF.boot[0] = DEFAULT_ANCHOR[0];
      XF.boot[1] = DEFAULT_ANCHOR[1];
      XF.boot[2] = DEFAULT_ANCHOR[2];
      XF.bootWord[0] = DEFAULT_ANCHOR[0];
      XF.bootWord[1] = DEFAULT_ANCHOR[1] + WORD_DY * DEFAULT_ANCHOR[2];
      XF.bootWord[2] = WORD_H * DEFAULT_ANCHOR[2];
      headerXf(env, intro.head);
      bootLook(tau, K, P, A, D, XF);
      A[P.ancX] = XF.boot[0];
      A[P.ancY] = XF.boot[1];
      A[P.ancS] = XF.boot[2];
      if (rm) A[P.exposure] = intro.mode === 'none' && !snap.rm ? 1 : sstep(intro.t0, intro.t0 + 0.4, t);
      // skip: 300 ms crossfade (exposure dip) at the jump
      if (intro.skipT != null && t >= intro.skipT) A[P.exposure] *= 0.35 + 0.65 * sstep(intro.skipT, intro.skipT + 0.3, t);
      if (isTop) {
        const fire = rm ? intro.t0 + (snap.rm ? 0.4 : 0) : intro.t0 + (t - intro.t0) - (tau - K.DONE);
        F_DONE.at = fire;
        F_DONE.tau = tau;
        F_DONE.K = K;
      }
      break;
    }
    case 'home':
      homeLook(A, t);
      break;
    case 'installing':
      installingLook(A, t);
      break;
    case 'success':
      successLook(rec, A, t);
      break;
    case 'error':
      errorLook(rec, A, t);
      break;
    default:
      idleLook(A, t);
  }
}
const F_DONE = { at: Infinity, tau: 0, K: INTRO_FULL };

const EV = { tc: -100, cs: 0, rays: 0, shake: 0, frac: 1, flashOk: true, best: -1e9, prev: -1e9 };
function considerEv(t, tEv, s, r, sh, frac) {
  if (t - tEv < -0.12) return; // not yet (beyond the pre-ramp)
  if (tEv > EV.best) {
    EV.prev = EV.best;
    EV.best = tEv;
    EV.cs = s;
    EV.rays = r;
    EV.shake = sh;
    EV.frac = frac;
  } else if (tEv > EV.prev) EV.prev = tEv;
}
function pickClimax(snap, t, tauBoot) {
  // candidates: boot climax (intro-local), success climax (+0.45 s), bursts – the most recent wins
  EV.best = -1e9;
  EV.prev = -1e9;
  EV.cs = 0;
  EV.rays = 0;
  EV.shake = 0;
  EV.frac = 1;
  if (tauBoot != null && snap.intro && !snap.rm && snap.intro.mode !== 'none') {
    const K = introConsts(snap);
    const skipped = snap.intro.skipT != null && snap.intro.skipT - snap.intro.t0 < K.CLX;
    if (!skipped) considerEv(t, t - (tauBoot - K.CLX), K.CS, 0.8, K.SHAKE, 1);
  }
  const st = snap.states;
  for (let i = 0; i < st.length; i++) if (st[i].s === 'success') considerEv(t, st[i].t0 + 0.45, 1, 1.3, 3, 1);
  const bs = snap.bursts;
  for (let i = 0; i < bs.length; i++) considerEv(t, bs[i].t + 0.02, bs[i].amp, 0.5, 0, bs[i].frac);
  EV.tc = EV.best > -1e8 ? t - EV.best : -100;
  EV.flashOk = EV.best - EV.prev >= 1.0; // at most one flash per second
  return EV;
}

/**
 * Evaluates the frame at engine time t. env: { cssW, cssH, aspect, content }.
 * Writes into F (from createFrame()).
 */
export function evaluate(t, snap, env, F) {
  C.env = env;
  anchorAt(snap, env, t, C.anc);
  const pr = snap.prog;
  springAt(pr, t, SP);
  C.pv = clamp01(SP.x);
  C.indet = pr.indet ? sstep(pr.indetT, pr.indetT + 0.6, t) : 1 - sstep(pr.indetT, pr.indetT + 0.6, t);
  F_DONE.at = Infinity;

  const st = snap.states;
  const topIdx = st.length - 1;
  look(st[0], t, snap, env, A0, topIdx === 0);
  for (let i = 1; i < st.length; i++) {
    const r = st[i];
    const w = r.dur > 0 ? sstep(r.t0, r.t0 + r.dur, t) : t >= r.t0 ? 1 : 0;
    if (w <= 0 && i !== topIdx) continue;
    look(r, t, snap, env, A1, i === topIdx);
    for (let k = 0; k < NP; k++) A0[k] += (A1[k] - A0[k]) * w;
  }
  const top = st[topIdx];
  const p = F.p;
  for (let k = 0; k < NP; k++) p[k] = A0[k];

  // discrete values from the top state
  let tauBoot = null;
  if (top.s === 'boot') {
    look(top, t, snap, env, A1, true); // refresh D for the top boot state
    tauBoot = D.introT;
    F.introT = D.introT;
    F.igniteT = D.igniteT;
    F.penT0 = D.penT0;
    F.penK = D.penK;
    F.penGain = snap.rm || (snap.intro && snap.intro.mode === 'none') ? 0 : D.penGain;
    F.burnT = D.burnT;
    F.inhale = D.inhale;
    F.introDoneAt = F_DONE.at;
    F.bootActive = true;
  } else {
    F.introT = -100;
    F.igniteT = -100;
    F.penGain = 0;
    F.burnT = top.s === 'success' ? t - top.t0 - 3.0 : -100;
    F.inhale = 0;
    F.introDoneAt = Infinity;
    F.bootActive = false;
  }
  F.dropT = top.s === 'error' ? t - top.t0 : -100;
  if (top.s === 'boot' && snap.rm) F.igniteT = -100;

  // climax events (boot, success, bursts): shock, flash (capped, max 1/s), sparks, shake
  const ev = pickClimax(snap, t, tauBoot);
  const tc = ev.tc;
  const climax = ev.cs > 0 ? climaxEnv(tc) * ev.cs : 0;
  F.climaxT = tc;
  F.climaxAmt = ev.cs;
  F.climax = climax;
  F.shock = climax;
  F.shockR = Math.max(tc, 0) * 1.7;
  F.shockAmp = tc > 0 ? 0.075 * Math.exp(-tc * 1.5) * ev.cs : 0;
  F.shockW = 0.08 + Math.max(tc, 0) * 0.14;
  F.shockGlow = tc > 0 ? 1.0 * Math.exp(-tc * 2.3) * sstep(0, 0.04, tc) * ev.cs : 0;
  F.flashCap = snap.rm ? 0.2 : 0.6;
  F.flash = ev.flashOk ? flashEnv(tc) * 0.6 * ev.cs : 0;
  F.punch = snap.rm ? 0 : tc > 0 ? 0.03 * Math.exp(-tc * 7.5) * ev.cs : 0;
  const shakePx = snap.rm ? 0 : tc > 0 ? ev.shake * Math.exp(-tc * 4.5) : 0;
  F.shakeX = shakeN(t, 1.3) * shakePx;
  F.shakeY = shakeN(t, 7.9) * shakePx;
  F.burstT = tc;
  F.sparkGain = ev.cs > 0 ? Math.min(1, ev.cs * 1.2) : 0;
  F.sparkFrac = ev.frac;
  p[P.raysAmt] += climax * ev.rays;
  p[P.bloomAmt] += 0.3 * climax;
  p[P.streakAmt] += 0.3 * climax;
  p[P.ca] += snap.rm ? 0 : 0.016 * (tc > 0 ? Math.exp(-tc * 3) : 0) * ev.cs;
  p[P.flare] += 0.5 * flashEnv(tc) * ev.cs;
  p[P.plasmaClimax] = Math.max(p[P.plasmaClimax], 0.1 * climax);

  // pulses
  F.pulseSoft = snap.rm ? 1 : 0;
  let active = false;
  for (let i = 0; i < 4; i++) {
    const q = snap.pulses[i];
    F.pulses[i * 4] = q[0];
    F.pulses[i * 4 + 1] = q[1] * (0.5 + 0.5 * snap.intensity);
    F.pulses[i * 4 + 2] = q[2];
    F.pulses[i * 4 + 3] = q[3];
    if (t - q[0] < 2.6 && t >= q[0] && q[1] > 0) active = true;
  }
  F.pulseActive = active;

  // warp overlay (resolves at its peak, 50 %)
  const wu = (t - snap.warp.t0) / snap.warp.dur;
  let wenv = 0;
  if (wu > 0 && wu < 1) wenv = wu < 0.4 ? sstep(0, 0.4, wu) : wu < 0.5 ? 1 : 1 - sstep(0.5, 1.0, wu);
  F.warpEnv = wenv;
  F.warpU = clamp01(wu);
  F.warpRB = snap.rm ? 0 : 0.22 * wenv;
  F.warpTunnel = snap.rm ? 0 : wenv;
  if (wenv > 0) {
    p[P.intensity] *= 1 - 0.45 * wenv;
    p[P.scrimAmt] *= 1 - wenv;
    if (snap.rm) p[P.exposure] *= 1 - 0.5 * wenv;
  }

  // user "Effekte" intensity
  const k = snap.intensity;
  if (k < 1) {
    p[P.intensity] *= k;
    p[P.heatAmt] *= k;
    p[P.wordHeat] *= k;
    p[P.emberA] *= k;
    p[P.bloomAmt] *= 0.5 + 0.5 * k;
    p[P.raysAmt] *= k;
  }

  // scrims (CSS px)
  const n = Math.min(4, snap.scrim.length);
  for (let i = 0; i < 16; i++) F.scrims[i] = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) F.scrims[i * 4 + j] = snap.scrim[i][j];
  F.scrimCount = n;

  F.t = t;
  F.plasmaT = t;
  F.cloudA = p[P.cloudA];
  F.asm = p[P.asm];
  F.lineReveal = p[P.lineReveal];
  F.lineAlpha = p[P.lineAlpha];
  return F;
}

export { ASM_W, ASM_J, INTRO_FULL, INTRO_SHORT };
