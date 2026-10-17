// Bridge between UI code and the background FX engine (src/renderer/fx/engine.js).
// All methods are safe no-ops until an engine is attached; the last state/progress/quality is
// replayed when it arrives, so screens never need to care whether the engine is loaded.

let engine = null;
let initPromise = null;
const last = { state: null, progress: null, quality: null };

function call(method, ...args) {
  if (!engine || typeof engine[method] !== 'function') return undefined;
  try {
    return engine[method](...args);
  } catch (err) {
    console.warn(`[fx] ${method} failed`, err);
    return undefined;
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
        const options = { ...opts, quality: last.quality || opts.quality || 'high' };
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
  /** 'boot' | 'idle' | 'home' | 'scan' | 'installing' | 'success' | 'error' */
  setState(name) {
    if (!name) return;
    last.state = name;
    call('setState', name);
  },
  /** 0..1 */
  setProgress(p) {
    const v = Math.min(1, Math.max(0, Number(p) || 0));
    last.progress = v;
    call('setProgress', v);
  },
  /** Short energy wave (route changes, important clicks). */
  pulse(strength) {
    call('pulse', strength);
  },
  /** Particle explosion (success moments). */
  burst(opts) {
    call('burst', opts);
  },
  /** 'ultra' | 'high' | 'low' | 'off' */
  setQuality(q) {
    last.quality = q;
    call('setQuality', q);
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
};

/** Plugs a concrete engine in (also used by tests or a future WebGL engine). */
export function attachFx(next) {
  if (engine && engine !== next) call('dispose');
  engine = next;
  if (!engine) return;
  if (last.quality) call('setQuality', last.quality);
  if (last.state) call('setState', last.state);
  if (last.progress != null) call('setProgress', last.progress);
}
