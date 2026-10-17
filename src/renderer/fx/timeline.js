// Boot timeline v2 (spec 4.4). All timing lives here as plain numbers that become uniforms – no
// time constant is hard-coded in GLSL. Every value is a pure function of the intro time tau.

export const INTRO_FULL = Object.freeze({
  DUR: 7.0,
  IGN0: 0.1, // ignition spark + starburst
  IGN1: 0.55,
  BEAT1: 0.5, // heartbeat flashes of the spark
  BEAT2: 0.74,
  REV0: 0.12, // plasma reveal front
  REV1: 1.7,
  DISK0: 0.08, // vortex disk spins up
  DISK1: 1.35,
  ASM0: 1.0, // particles assemble in pen order (body, crest, wings, tail, ring)
  ASM1: 3.3,
  WORD0: 2.2, // wordmark ignites left -> right
  WORD1: 3.05,
  SWEEP0: 2.85, // CHROME light sweep over the wordmark
  SWEEP1: 3.4,
  INH0: 3.2, // inhale (30 % darker)
  INH1: 3.52,
  CLX: 3.56, // capped climax
  BURN0: 5.0, // particle cloud burns into embers
  GLIDE0: 5.0, // neon emblem + wordmark glide to the header slot
  GLIDE1: 6.35,
  DONE: 6.35, // DOM logo takes over, onIntroDone
  IDLE: 7.0,
  CS: 1.0, // climax scale
  SHAKE: 6.0, // screen shake in CSS px (decays)
});

export const INTRO_SHORT = Object.freeze({
  DUR: 3.2,
  IGN0: 0.02,
  IGN1: 0.4,
  BEAT1: 0.2,
  BEAT2: 0.32,
  REV0: 0.04,
  REV1: 0.95,
  DISK0: 0.0,
  DISK1: 0.55,
  ASM0: 0.3,
  ASM1: 1.5,
  WORD0: 0.85,
  WORD1: 1.35,
  SWEEP0: 1.2,
  SWEEP1: 1.62,
  INH0: 1.4,
  INH1: 1.56,
  CLX: 1.6,
  BURN0: 2.0,
  GLIDE0: 2.0,
  GLIDE1: 3.0,
  DONE: 3.0,
  IDLE: 3.2,
  CS: 0.6,
  SHAKE: 0,
});

export const ASM_W = 0.35; // assembly window (order units) – flight duration
export const ASM_J = 0.12; // per-particle jitter of the landing time (order units)
export const WORD_W = 0.22; // must match the word particle window in POINTS_VS
export const WORD_J = 0.1;

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mix = (a, b, t) => a + (b - a) * t;
export const easeIO = (x) => {
  x = clamp01(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
// CHROME shakeN (verbatim)
export const shakeN = (t, s) => Math.sin(t * 31.7 + s) * 0.5 + Math.sin(t * 57.3 + s * 2.1) * 0.3 + Math.sin(t * 93.1 + s * 3.7) * 0.2;

/** Flash envelope around a climax: 30 ms rise, ~30 ms half-life decay (peak < 90 ms). */
export function flashEnv(tc) {
  if (tc < -0.03) return 0;
  if (tc < 0) return sstep(-0.03, 0, tc);
  return Math.exp(-tc * 22);
}

export function climaxEnv(tc) {
  if (tc < -0.1) return 0;
  if (tc < 0) return sstep(-0.1, 0, tc);
  return Math.exp(-tc * 1.6);
}

/** Intro time tau for engine time t (handles skipping: jumps to BURN0 with a 300 ms crossfade). */
export function introTau(intro, K, t) {
  if (intro.skipT != null && t >= intro.skipT) return Math.max(K.BURN0, intro.skipT - intro.t0) + (t - intro.skipT);
  return t - intro.t0;
}

/**
 * Writes the boot look for intro time tau into the param vector A (indices P) and the discrete
 * values into D. bootXf / headXf / bootWord / headWord: [x, y, s] world transforms.
 */
export function bootLook(tau, K, P, A, D, xf) {
  const tc = tau - K.CLX;
  const CS = K.CS;
  const idle = sstep(K.BURN0 - 0.4, K.IDLE, tau);
  const flick = tau < K.IGN1 + 0.15 ? 0.92 + 0.08 * Math.sin(tau * 23) : 1;
  const inhale = sstep(K.INH0, K.INH1, tau) * (1 - sstep(K.INH1, K.CLX + 0.02, tau));
  const climax = climaxEnv(tc);
  const W = ASM_W;
  const J = ASM_J;
  const asm = ((tau - K.ASM0) / (K.ASM1 - K.ASM0)) * (1 + W + J);
  const ignite = tau < K.CLX - 0.02 ? 0 : Math.exp(-Math.max(tc, 0) * 2.6) * CS;
  const glide = easeIO((tau - K.GLIDE0) / (K.GLIDE1 - K.GLIDE0));
  const gone = 1 - sstep(K.DONE, K.DONE + 0.15, tau);
  const fl = flashEnv(tc);

  // plasma
  const focus = 1 - 0.3 * sstep(K.ASM0 + 0.2, K.ASM0 + 0.9, tau) * (1 - sstep(K.ASM1 - 0.1, K.CLX, tau));
  A[P.intensity] = sstep(K.IGN0, K.IGN0 + 0.7, tau) * flick * focus * (1 + 0.15 * climax * CS - 0.3 * inhale) * (1 - 0.38 * idle);
  A[P.swirl] = (1 + 1.4 * (1 - sstep(0.1, K.REV1 + 0.1, tau))) * (1 - 0.7 * sstep(K.CLX, K.IDLE - 0.5, tau));
  A[P.idle] = idle;
  A[P.reveal] = 3.3 * Math.pow(clamp01((tau - K.REV0) / (K.REV1 - K.REV0)), 1.6);
  A[P.rim] = tau < K.REV0 ? 0 : 1.1 * (1 - sstep(mix(K.REV0, K.REV1, 0.45), K.REV1, tau));
  A[P.heatAmt] = sstep(K.ASM0 + 0.3, K.ASM1, tau) * (1 - sstep(K.BURN0 + 0.3, K.BURN0 + 1.8, tau)) + 0.12 * fl * CS;
  A[P.wordHeat] = 0.8 * sstep(K.WORD0, K.WORD1 + 0.2, tau) * (1 - sstep(K.GLIDE0 - 0.5, K.GLIDE0 + 0.2, tau));
  A[P.fill] = 0.55 * sstep(K.WORD0 - 0.1, K.ASM1 + 0.1, tau) * (1 - sstep(K.BURN0 + 0.1, K.BURN0 + 1.1, tau));
  A[P.plasmaClimax] = 0; // climax adds come from the event system (state.js)
  A[P.flameY] = mix(-0.52, -0.84, idle);
  A[P.hue] = mix(0.5, 0.45, idle);
  A[P.desat] = 0;
  // particles
  A[P.diskGrow] = sstep(K.DISK0, K.DISK1, tau);
  A[P.cloudA] = clamp01((tau - K.IGN0) / 0.5);
  A[P.diskA] = 0.35;
  A[P.asm] = asm;
  A[P.asmW] = W;
  A[P.asmJ] = J;
  A[P.indet] = 0;
  A[P.flashW] = 0.06;
  A[P.wordAsm] = ((tau - K.WORD0) / (K.WORD1 - K.WORD0)) * (1 + WORD_W + WORD_J);
  A[P.wordA] = 1 - sstep(K.GLIDE0 - 0.5, K.GLIDE0 + 0.15, tau);
  A[P.jitter] = 0;
  A[P.emberRate] = 1;
  A[P.emberDir] = 1;
  A[P.emberA] = sstep(K.CLX + 0.4, K.IDLE - 0.5, tau);
  // neon emblem line
  A[P.lineReveal] = clamp01(asm - (W + J) * 0.5);
  A[P.lineAlpha] = gone * sstep(K.ASM0 - 0.1, K.ASM0 + 0.1, tau);
  A[P.lineEnergy] = ignite;
  A[P.penHead] = tau > K.ASM0 && tau < K.ASM1 + 0.3 ? 1 : 0;
  A[P.packet] = sstep(K.CLX + 1.0, K.IDLE - 0.5, tau);
  A[P.glowAmt] = 1;
  A[P.occl] = 1;
  A[P.crack] = 0;
  A[P.halo] = 0;
  // SDF wordmark
  A[P.wordAlpha] = sstep(K.WORD0, K.WORD0 + 0.1, tau) * gone;
  A[P.wordWipe] = ((tau - K.WORD0) / (K.WORD1 - K.WORD0)) * 1.05;
  A[P.sweep] = clamp01((tau - K.SWEEP0) / (K.SWEEP1 - K.SWEEP0));
  A[P.wordIgnite] = ignite;
  A[P.wordGlow] = 1;
  // transforms: emblem/wordmark glide from the centre to the header slot
  const punch = tc > 0 ? 1 + 0.04 * Math.exp(-tc * 7) * Math.cos(tc * 30) : 1;
  A[P.embX] = mix(xf.boot[0], xf.head[0], glide);
  A[P.embY] = mix(xf.boot[1], xf.head[1], glide);
  A[P.embS] = mix(xf.boot[2] * punch, xf.head[2], glide);
  A[P.wordX] = mix(xf.bootWord[0], xf.headWord[0], glide);
  A[P.wordY] = mix(xf.bootWord[1], xf.headWord[1], glide);
  A[P.wordH] = mix(xf.bootWord[2], xf.headWord[2], glide);
  // composite
  A[P.bloomAmt] = 0.8 - 0.25 * idle;
  A[P.raysAmt] = (0.28 * sstep(K.ASM0 + 0.2, K.ASM1 - 0.3, tau) + 0.05) * (1 - idle);
  A[P.streakAmt] = 0.5;
  A[P.vig] = 0.55;
  A[P.grain] = 0.04;
  A[P.scrimAmt] = idle;
  A[P.exposure] = (1 - 0.3 * inhale) * sstep(K.IGN0 - 0.04, K.IGN0 + 0.04, tau);
  A[P.ca] = 0.0012 + 0.004 * inhale;
  const beats = 0.45 * Math.exp(-Math.pow((tau - K.BEAT1) * 16, 2)) + 0.7 * Math.exp(-Math.pow((tau - K.BEAT2) * 14, 2));
  A[P.spark] = sstep(K.IGN0 - 0.04, K.IGN0 + 0.04, tau) * (1 - sstep(K.IGN1 - 0.2, K.IGN1 + 0.65, tau)) + beats * (1 - sstep(K.IGN1, K.IGN1 + 0.6, tau));
  A[P.flare] = 0.9 * sstep(K.IGN0 - 0.05, K.IGN0 + 0.06, tau) * Math.exp(-Math.max(0, tau - K.IGN0 - 0.06) * 2.2);
  A[P.flameBoost] = 0;

  // discrete values
  D.climaxLocal = K.CLX; // climax happens at tau = CLX (converted to engine time by the caller)
  D.burnT = tau - K.BURN0;
  D.dropT = -100;
  D.introT = tau;
  D.igniteT = tau - K.IGN0;
  D.penT0 = K.ASM0 + (((W + J) * 0.5) / (1 + W + J)) * (K.ASM1 - K.ASM0);
  D.penK = (K.ASM1 - K.ASM0) / (1 + W + J);
  D.penGain = tau > K.ASM0 - 0.1 && tau < K.ASM1 + 1.2 ? 1 : 0;
  D.inhale = inhale;
  D.shakeAmp = K.SHAKE;
}
