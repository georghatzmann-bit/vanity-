// WebAudio-synthesized SFX – no audio files. Volume / mute come from store.settings.
//   sound.play('click') or sound.click() · names: hover click whoosh boom success error type scan rise
//   sound.attach(el, { hover: true, click: true }) -> cleanup

const THROTTLE = { hover: 70, type: 22, click: 40, scan: 300, whoosh: 120 };

let ac = null;
let master = null;
let fxSend = null;
let noiseBuf = null;
let shaper = null;
let volume = 0.6;
let muted = false;
let unlockBound = false;
const lastAt = Object.create(null);

function ensureContext() {
  if (ac) return ac;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ac = new AC({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
  master = ac.createGain();
  master.gain.value = muted ? 0 : volume;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.18;
  master.connect(comp).connect(ac.destination);

  // Shimmer delay send for bright sounds.
  fxSend = ac.createGain();
  fxSend.gain.value = 0.32;
  const delay = ac.createDelay(1);
  delay.delayTime.value = 0.16;
  const fb = ac.createGain();
  fb.gain.value = 0.32;
  const damp = ac.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 4200;
  fxSend.connect(delay).connect(damp).connect(fb).connect(delay);
  damp.connect(master);

  // 2 s white noise.
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  // Soft clipper for the boom.
  shaper = ac.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2);
  }
  shaper.curve = curve;
  shaper.connect(master);
  return ac;
}

function bindUnlock() {
  if (unlockBound) return;
  unlockBound = true;
  const unlock = () => {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (ctx.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

// ---- primitives -------------------------------------------------------------------------------

function env(g, t0, peak, attack, dur) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + Math.max(0.002, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

function tone({ type = 'sine', freq = 440, to, dur = 0.2, gain = 0.2, attack = 0.004, when = 0, out, filter, send = 0, detune = 0 }) {
  const t0 = ac.currentTime + when;
  const o = ac.createOscillator();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ac.createGain();
  env(g, t0, gain, attack, dur);
  let node = o;
  if (filter) {
    const f = ac.createBiquadFilter();
    f.type = filter.type || 'lowpass';
    f.frequency.setValueAtTime(filter.freq, t0);
    if (filter.to) f.frequency.exponentialRampToValueAtTime(filter.to, t0 + dur);
    f.Q.value = filter.q ?? 0.7;
    node.connect(f);
    node = f;
  }
  node.connect(g);
  g.connect(out || master);
  if (send) {
    const s = ac.createGain();
    s.gain.value = send;
    g.connect(s).connect(fxSend);
  }
  o.start(t0);
  o.stop(t0 + dur + 0.05);
  return { osc: o, gain: g, t0 };
}

function noise({ dur = 0.3, gain = 0.2, attack = 0.004, when = 0, type = 'bandpass', freq = 1000, to, q = 1, pan, panTo, out }) {
  const t0 = ac.currentTime + when;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const f = ac.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  f.Q.value = q;
  const g = ac.createGain();
  env(g, t0, gain, attack, dur);
  src.connect(f).connect(g);
  let node = g;
  if (pan != null && ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.setValueAtTime(pan, t0);
    if (panTo != null) p.pan.linearRampToValueAtTime(panTo, t0 + dur);
    node.connect(p);
    node = p;
  }
  node.connect(out || master);
  src.start(t0, Math.random() * 1.2);
  src.stop(t0 + dur + 0.05);
}

// ---- sound design ---------------------------------------------------------------------------

const SFX = {
  hover() {
    tone({ type: 'sine', freq: 2400, to: 1900, dur: 0.05, gain: 0.03, attack: 0.002 });
    noise({ type: 'highpass', freq: 6500, dur: 0.018, gain: 0.018, attack: 0.001 });
  },
  click() {
    tone({ type: 'sine', freq: 210, to: 52, dur: 0.16, gain: 0.5, attack: 0.002 });
    tone({ type: 'triangle', freq: 1500, to: 900, dur: 0.05, gain: 0.07, attack: 0.001 });
    noise({ type: 'highpass', freq: 2800, dur: 0.025, gain: 0.1, attack: 0.001 });
  },
  whoosh() {
    noise({ type: 'bandpass', freq: 380, to: 2600, dur: 0.32, gain: 0.2, attack: 0.16, q: 1.4, pan: -0.7, panTo: 0.2 });
    noise({ type: 'bandpass', freq: 2600, to: 500, dur: 0.38, gain: 0.12, attack: 0.03, q: 1.1, when: 0.26, pan: 0.2, panTo: 0.8 });
  },
  boom() {
    tone({ type: 'sine', freq: 95, to: 30, dur: 1.5, gain: 0.95, attack: 0.004, out: shaper });
    tone({ type: 'triangle', freq: 58, to: 34, dur: 1.1, gain: 0.3, attack: 0.004 });
    noise({ type: 'lowpass', freq: 1100, to: 110, dur: 1.0, gain: 0.5, attack: 0.002, q: 0.6 });
    noise({ type: 'highpass', freq: 3000, dur: 0.06, gain: 0.12, attack: 0.001 });
  },
  success() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51];
    notes.forEach((f, i) => {
      tone({ type: 'triangle', freq: f, dur: 0.55, gain: 0.11, attack: 0.006, when: i * 0.065, send: 0.6 });
      tone({ type: 'sine', freq: f * 2, dur: 0.35, gain: 0.03, attack: 0.004, when: i * 0.065, send: 0.4 });
    });
    tone({ type: 'sine', freq: 130.8, to: 130.8, dur: 0.8, gain: 0.12, attack: 0.01 });
  },
  error() {
    for (const when of [0, 0.17]) {
      tone({ type: 'sawtooth', freq: 146, dur: 0.15, gain: 0.09, attack: 0.004, when, filter: { type: 'lowpass', freq: 900, q: 2 } });
      tone({ type: 'square', freq: 73, dur: 0.15, gain: 0.05, attack: 0.004, when, filter: { type: 'lowpass', freq: 500 } });
    }
  },
  type() {
    tone({ type: 'square', freq: 1700 + Math.random() * 700, dur: 0.02, gain: 0.014, attack: 0.001, filter: { type: 'lowpass', freq: 4200 } });
  },
  scan() {
    const { gain, t0 } = tone({ type: 'sine', freq: 280, to: 1500, dur: 0.95, gain: 0.07, attack: 0.08, send: 0.3 });
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = 16;
    depth.gain.value = 0.03;
    lfo.connect(depth).connect(gain.gain);
    lfo.start(t0);
    lfo.stop(t0 + 1);
    tone({ type: 'sine', freq: 283, to: 1512, dur: 0.95, gain: 0.03, attack: 0.08, detune: 8 });
  },
  rise() {
    noise({ type: 'bandpass', freq: 180, to: 7000, dur: 1.6, gain: 0.24, attack: 1.45, q: 1.6, pan: -0.3, panTo: 0.3 });
    tone({ type: 'sawtooth', freq: 110, to: 880, dur: 1.6, gain: 0.05, attack: 1.4, filter: { type: 'lowpass', freq: 300, to: 5200, q: 4 } });
    tone({ type: 'sine', freq: 55, to: 110, dur: 1.6, gain: 0.18, attack: 1.3 });
  },
};

export const SOUND_NAMES = Object.keys(SFX);

export const sound = {
  /** Wires volume/mute to store.settings and arms the gesture unlock. */
  init(store) {
    const apply = (s) => {
      sound.setVolume(s.volume);
      sound.setMuted(!s.sound);
    };
    apply(store.get('settings'));
    store.subscribe((s) => s.settings, apply);
    bindUnlock();
    ensureContext();
  },

  play(name, opts) {
    if (muted || volume <= 0 || !SFX[name]) return;
    const ctx = ensureContext();
    if (!ctx || ctx.state !== 'running') {
      ctx?.resume?.().catch(() => {});
      return;
    }
    const now = performance.now();
    const gap = THROTTLE[name] || 0;
    if (gap && now - (lastAt[name] || 0) < gap) return;
    lastAt[name] = now;
    try {
      SFX[name](opts);
    } catch (err) {
      console.warn('[sound]', name, err);
    }
  },

  setVolume(v) {
    volume = Math.min(1, Math.max(0, Number(v) || 0));
    if (master && !muted) master.gain.setTargetAtTime(volume, ac.currentTime, 0.03);
  },

  setMuted(m) {
    muted = !!m;
    if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.03);
  },

  get muted() {
    return muted;
  },

  get volume() {
    return volume;
  },

  /** Adds hover / click sounds to an element. @returns cleanup() */
  attach(el, { hover = true, click = true, clickSound = 'click' } = {}) {
    if (!el) return () => {};
    const onEnter = () => !el.disabled && sound.play('hover');
    const onClick = () => !el.disabled && sound.play(clickSound);
    if (hover) el.addEventListener('pointerenter', onEnter);
    if (click) el.addEventListener('click', onClick);
    return () => {
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('click', onClick);
    };
  },
};

for (const name of SOUND_NAMES) sound[name] = (opts) => sound.play(name, opts);
