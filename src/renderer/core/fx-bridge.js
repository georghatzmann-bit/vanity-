// Bridge between UI code and the background FX engine (src/renderer/fx/engine.js).
// All methods are safe no-ops until an engine is attached; the last state / progress / quality /
// anchor / scrims / intensity are replayed when it arrives, so screens never need to care whether
// the engine is loaded (or whether WebGL exists at all – the engine falls back to a CSS tier).

let engine = null;
let initPromise = null;
const last = { state: null, progress: undefined, quality: null, anchor: undefined, scrim: null, intensity: null, paused: false };
const introListeners = new Set();

function call(method, ...args) {
  if (!engine || typeof engine[method] !== 'function') return undefined;
  try {
    return engine[method](...args);
  } catch (err) {
    console.warn(`[fx] ${method} failed`, err);
    return undefined;
  }
}

function emitIntroDone() {
  for (const fn of [...introListeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[fx] onIntroDone listener failed', err);
    }
  }
}

export const fx = {
  /** Loads the engine lazily. Resolves with `fx` even if the engine is missing or fails. */
  init(canvas, opts = {}) {
    if (initPromise) return initPromise;
    if (opts.quality) last.quality = opts.quality;
    initPromise = (async () => {
      try {
        const mod = await import('../fx/engine.js');
        const options = { ...opts, quality: last.quality || opts.quality || 'high', onIntroDone: emitIntroDone };
        let instance = null;
        if (typeof mod.createFx === 'function') {
          instance = await mod.createFx(canvas, options);
        } else if (mod.default && typeof mod.default.init === 'function') {
          await mod.default.init(canvas, options);
          instance = mod.default;
        }
        if (instance) attachFx(instance);
      } catch (err) {
        console.warn('[fx] engine unavailable – continuing without background effects', err);
      }
      return fx;
    })();
    return initPromise;
  },
  /** 'boot' | 'idle' | 'home' | 'scan' | 'installing' | 'success' | 'error'  (opts: { immediate }) */
  setState(name, opts) {
    if (!name) return;
    last.state = name;
    call('setState', name, opts);
  },
  /** 0..1, or exactly null for "indeterminate" (unknown download size). opts: { reset } */
  setProgress(p, opts) {
    const v = p === null ? null : Math.min(1, Math.max(0, Number(p) || 0));
    last.progress = v;
    call('setProgress', v, opts);
  },
  /** Short energy wave (route changes, one app finished: 0.6, failed package: 0.25). */
  pulse(strength) {
    call('pulse', strength);
  },
  /** Success burst: sparks + capped flash (opts.count scales the spark amount). */
  burst(opts) {
    call('burst', opts);
  },
  /** Hyperspace screen transition; resolves at its peak – swap the DOM then. */
  warp(ms = 700) {
    const r = call('warp', ms);
    return r && typeof r.then === 'function' ? r : Promise.resolve();
  },
  /** Where the emblem lives (CSS px rect, e.g. the hero logo), null = default centre. */
  setAnchor(rect) {
    last.anchor = rect ? { left: rect.left ?? rect.x, top: rect.top ?? rect.y, width: rect.width, height: rect.height } : null;
    call('setAnchor', last.anchor);
  },
  /** Up to 4 UI panel rects (CSS px): the FX darkens beneath them so text stays readable. */
  setScrim(rects) {
    last.scrim = (rects || []).slice(0, 4).map((r) => ({ left: r.left ?? r.x, top: r.top ?? r.y, width: r.width, height: r.height }));
    call('setScrim', last.scrim);
  },
  /** User intensity 0..1. */
  setIntensity(k) {
    last.intensity = k;
    call('setIntensity', k);
  },
  setPaused(p) {
    last.paused = !!p;
    call('setPaused', !!p);
  },
  /** 'full' (first launch) | 'short' (later launches) | 'none'. setState('boot') plays the default. */
  playIntro(mode) {
    last.state = 'boot';
    if (!engine) return;
    call('playIntro', mode);
  },
  skipIntro() {
    call('skipIntro');
  },
  /** Registers a callback for the end of the intro (the DOM logo takes over). Returns an unsubscribe. */
  onIntroDone(fn) {
    introListeners.add(fn);
    return () => introListeners.delete(fn);
  },
  /** 'ultra' | 'high' | 'low' | 'off' */
  setQuality(q) {
    last.quality = q;
    call('setQuality', q);
  },
  resize() {
    call('resize');
  },
  dispose() {
    call('dispose');
    engine = null;
    initPromise = null;
  },
  get attached() {
    return !!engine;
  },
  get state() {
    return last.state;
  },
  /** 'ultra' | 'high' | 'low' | 'static' (null until the engine is attached). */
  get tier() {
    return engine ? engine.tier : null;
  },
  /** { renderer, software, hdr, fpsCap, scale, tier, maxTier, probeMs } */
  get info() {
    return engine && engine.info ? engine.info : null;
  },
};

/** Plugs a concrete engine in (also used by tests). */
export function attachFx(next) {
  if (engine && engine !== next) call('dispose');
  engine = next;
  if (!engine) return;
  if (last.quality) call('setQuality', last.quality);
  if (last.intensity != null) call('setIntensity', last.intensity);
  if (last.anchor !== undefined) call('setAnchor', last.anchor);
  if (last.scrim) call('setScrim', last.scrim);
  if (last.state) call('setState', last.state);
  if (last.progress !== undefined) call('setProgress', last.progress);
  if (last.paused) call('setPaused', true);
}
