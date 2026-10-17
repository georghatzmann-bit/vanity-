// Bridge between UI code and the background FX engine (src/renderer/fx/engine.js).
// All methods are safe no-ops until an engine is attached; the last state / progress / quality /
// anchor / scrims / intensity are replayed when it arrives, so screens never need to care whether
// the engine is loaded (or whether WebGL exists at all – the engine falls back to a CSS tier).
//
// Screen helpers (prefer these over raw rects – they follow layout changes and clean up after
// themselves when the elements leave the DOM):
//   const release = fx.scrimFor([panelEl, listEl]);   // FX darkens beneath these panels (max 4)
//   const release = fx.anchorFor(heroSlotEl);         // emblem lives in this box; release() = centre
// Intro / splash (used by main.js and the boot screen):
//   await fx.splash('short')          later app starts: intro over the empty app, resolves when the
//                                     content may enter (logo starts gliding, skip, or not ready)
//   fx.introClock()                   { tau, live, marks, ... } while an intro is on screen, else null
//   fx.onIntroDone(cb) / fx.onTierChange(cb) -> unsubscribe
import '../fx/intro.css';

let engine = null;
let initPromise = null;
let readyResolve = null;
const ready = new Promise((res) => (readyResolve = res));
const last = { state: null, stateOpts: undefined, progress: undefined, quality: null, anchor: undefined, scrim: null, intensity: null, paused: false };
const introListeners = new Set();
const tierListeners = new Set();
const root = typeof document !== 'undefined' ? document.documentElement : null;

// ---- intro tracking: titlebar logo hand-off + state hold during the launch splash ---------------
const intro = { active: false, hold: false, pending: null, timer: 0 };
let successAt = -1e9; // last 'success' (install screen -> done screen must not climax twice)

function beginIntro() {
  intro.active = true;
  if (root) root.dataset.fxIntro = 'playing'; // fx/intro.css hides the titlebar logo until it lands
  clearTimeout(intro.timer);
  intro.timer = setTimeout(endIntro, 9500); // failsafe: never keep the logo hidden / a state held
}

function endIntro() {
  clearTimeout(intro.timer);
  const pending = intro.pending;
  const wasActive = intro.active;
  intro.active = false;
  intro.hold = false;
  intro.pending = null;
  if (root && root.dataset.fxIntro) delete root.dataset.fxIntro;
  if (pending) {
    last.state = pending.name;
    call('setState', pending.name, pending.opts);
  }
  return wasActive;
}

/** After anything that may have started an intro in the engine: mirror it in the DOM flag. */
function syncIntroFlag() {
  const c = call('introClock');
  if (c && c.live && !c.fired) beginIntro();
  else if (intro.active && !intro.hold) endIntro();
}

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
  endIntro();
  for (const fn of [...introListeners]) {
    try {
      fn();
    } catch (err) {
      console.error('[fx] onIntroDone listener failed', err);
    }
  }
}

function emitTierChange(tier, reason) {
  // a live intro cannot finish on the CSS tier: release the logo / held state right away
  if (tier === 'static' && intro.active) setTimeout(emitIntroDone, 0);
  for (const fn of [...tierListeners]) {
    try {
      fn(tier, reason);
    } catch (err) {
      console.error('[fx] onTierChange listener failed', err);
    }
  }
}

const timeout = (ms, value) => new Promise((res) => setTimeout(() => res(value), ms));
const toRect = (r) => ({ left: r.left ?? r.x, top: r.top ?? r.y, width: r.width, height: r.height });
const effectsOff = () => last.quality === 'off';

// ---- element trackers (scrims + anchor) -------------------------------------------------------
const scrimOwners = new Set(); // { els: Element[] }
let anchorOwner = null; // { el }
let trackTimer = 0;
let lastScrimKey = '';
let lastAnchorKey = '';

function measure(el) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function track() {
  // scrims: every registered panel, biggest four win
  if (scrimOwners.size || lastScrimKey) {
    const rects = [];
    for (const owner of [...scrimOwners]) {
      const alive = owner.els.filter((el) => el && el.isConnected);
      if (!alive.length) {
        scrimOwners.delete(owner);
        continue;
      }
      for (const el of alive) {
        const r = measure(el);
        if (r) rects.push(r);
      }
    }
    rects.sort((a, b) => b.width * b.height - a.width * a.height);
    const top = rects.slice(0, 4);
    const key = JSON.stringify(top);
    if (key !== lastScrimKey) {
      lastScrimKey = top.length ? key : '';
      fx.setScrim(top);
    }
  }
  // anchor: one owner (the latest registration wins)
  if (anchorOwner) {
    if (!anchorOwner.el.isConnected) {
      anchorOwner = null;
      lastAnchorKey = '';
      fx.setAnchor(null);
    } else {
      const r = measure(anchorOwner.el);
      const key = r ? `${r.left},${r.top},${r.width},${r.height}` : '';
      if (r && key !== lastAnchorKey) {
        lastAnchorKey = key;
        fx.setAnchor(r);
      }
    }
  }
  if (!scrimOwners.size && !anchorOwner && !lastScrimKey) stopTracking();
}

function startTracking() {
  if (trackTimer) return;
  trackTimer = setInterval(track, 250); // a handful of getBoundingClientRect() calls, 4x per second
  window.addEventListener('resize', track);
}

function stopTracking() {
  clearInterval(trackTimer);
  trackTimer = 0;
  window.removeEventListener('resize', track);
}

// ------------------------------------------------------------------------------------------------
export const fx = {
  /**
   * Loads the engine lazily. Resolves with `fx` even if the engine is missing or fails.
   * opts.gpuHint may be a Promise (Electron main-process GPU info) – waited for at most 300 ms.
   */
  init(canvas, opts = {}) {
    if (initPromise) return initPromise;
    if (opts.quality) last.quality = opts.quality;
    initPromise = (async () => {
      try {
        const [mod, gpuHint] = await Promise.all([
          import('../fx/engine.js'),
          opts.gpuHint && typeof opts.gpuHint.then === 'function' ? Promise.race([opts.gpuHint.catch(() => null), timeout(300, null)]) : opts.gpuHint || null,
        ]);
        const options = {
          ...opts,
          gpuHint: gpuHint || undefined,
          quality: last.quality || opts.quality || 'high',
          onIntroDone: emitIntroDone,
          onTierChange: (tier, reason) => {
            opts.onTierChange?.(tier, reason);
            emitTierChange(tier, reason);
          },
        };
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
      readyResolve(fx);
      return fx;
    })();
    return initPromise;
  },
  /** Resolves true once the engine is attached, false after `ms` (or when it failed to load). */
  async whenReady(ms = Infinity) {
    if (engine) return true;
    if (!Number.isFinite(ms)) await ready;
    else await Promise.race([ready, timeout(ms)]);
    return !!engine;
  },
  /** 'boot' | 'idle' | 'home' | 'scan' | 'installing' | 'success' | 'error'  (opts: { immediate }) */
  setState(name, opts) {
    if (!name) return;
    if (name !== 'boot' && intro.active && intro.hold) {
      // launch splash still on screen: the screen's look takes over when the logo has landed
      intro.pending = { name, opts };
      return;
    }
    if (name === 'success') {
      // the engine re-triggers the success climax on every call; a follow-up screen that sets
      // 'success' again (install -> done) keeps the running celebration instead
      const now = performance.now();
      const repeat = last.state === 'success' && now - successAt < 8000;
      successAt = now;
      if (repeat) return;
    }
    last.state = name;
    last.stateOpts = opts;
    call('setState', name, opts);
    if (name === 'boot') syncIntroFlag();
    else if (intro.active) endIntro();
  },
  /** 0..1, or exactly null for "indeterminate" (unknown download size). opts: { reset } */
  setProgress(p, opts) {
    const v = p === null ? null : Math.min(1, Math.max(0, Number(p) || 0));
    last.progress = v;
    call('setProgress', v, opts);
  },
  /** Short energy wave (route changes, one app finished: 0.6, failed package: 0.25). */
  pulse(strength) {
    if (effectsOff()) return;
    call('pulse', strength);
  },
  /** Success burst: sparks + capped flash (opts.count scales the spark amount). */
  burst(opts) {
    if (effectsOff()) return;
    call('burst', opts);
  },
  /** True when warp() renders a real hyperspace transition (live WebGL tier). */
  canWarp() {
    return !!engine && !effectsOff() && engine.tier !== 'static' && typeof engine.warp === 'function';
  },
  /** Hyperspace screen transition; resolves at its peak – swap the DOM then. */
  warp(ms = 700) {
    if (effectsOff()) return Promise.resolve();
    const r = call('warp', ms);
    return r && typeof r.then === 'function' ? r : Promise.resolve();
  },
  /** Where the emblem lives (CSS px rect, e.g. the hero slot), null = default centre. */
  setAnchor(rect) {
    last.anchor = rect ? toRect(rect) : null;
    call('setAnchor', last.anchor);
  },
  /** Up to 4 UI panel rects (CSS px): the FX darkens beneath them so text stays readable. */
  setScrim(rects) {
    last.scrim = (rects || []).slice(0, 4).map(toRect);
    call('setScrim', last.scrim);
  },
  /**
   * Registers UI panels the FX should darken beneath (glass cards, lists, dialogs). Rects follow
   * layout / resize / entrance animations; detached elements drop out on their own.
   * @returns release()
   */
  scrimFor(elements) {
    const els = (Array.isArray(elements) ? elements : [elements]).filter(Boolean);
    if (!els.length) return () => {};
    const owner = { els };
    scrimOwners.add(owner);
    startTracking();
    requestAnimationFrame(track);
    return () => {
      if (scrimOwners.delete(owner)) track();
    };
  },
  /**
   * Puts the emblem into an element's box (e.g. an empty hero slot) and keeps it there.
   * @returns release() – the emblem eases back to the centre.
   */
  anchorFor(el) {
    if (!el) return () => {};
    const owner = { el };
    anchorOwner = owner;
    lastAnchorKey = '';
    startTracking();
    requestAnimationFrame(track);
    return () => {
      if (anchorOwner !== owner) return;
      anchorOwner = null;
      lastAnchorKey = '';
      fx.setAnchor(null);
    };
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
    syncIntroFlag();
  },
  skipIntro() {
    call('skipIntro');
  },
  /**
   * Launch splash for later app starts: plays the short intro over the still-empty app and resolves
   * when the screen may enter – when the logo starts gliding to the titlebar (~2 s), on a click /
   * Esc / Space / Enter (skip), or right away when the engine is not ready within `waitMs`, runs the
   * CSS tier, or motion is reduced. Screen states set meanwhile are held until the logo has landed.
   * @returns Promise<{ played: boolean, skipped?: boolean }>
   */
  async splash(mode = 'short', { waitMs = 900, maxMs = 3200 } = {}) {
    if (effectsOff() || !(await fx.whenReady(waitMs))) return { played: false };
    if (engine.tier === 'static') return { played: false };
    intro.hold = true;
    last.state = 'boot';
    call('playIntro', mode);
    const c0 = call('introClock');
    if (!c0 || !c0.live) {
      endIntro();
      return { played: false };
    }
    beginIntro();
    return new Promise((resolve) => {
      let raf = 0;
      let done = false;
      const finish = (skipped) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        window.removeEventListener('pointerdown', onSkip, true);
        window.removeEventListener('keydown', onSkip, true);
        resolve({ played: true, skipped });
      };
      const onSkip = (e) => {
        if (e.type === 'keydown' && !['Escape', ' ', 'Enter'].includes(e.key)) return;
        if (e.type === 'pointerdown' && e.target && e.target.closest && e.target.closest('#titlebar')) return; // window controls
        call('skipIntro');
        finish(true);
      };
      const tick = () => {
        const c = call('introClock');
        if (!c || c.tau >= c.marks.glide - 0.05) finish(false);
        else raf = requestAnimationFrame(tick);
      };
      const timer = setTimeout(() => finish(false), maxMs); // hidden window: rAF stops, never block
      window.addEventListener('pointerdown', onSkip, true);
      window.addEventListener('keydown', onSkip, true);
      raf = requestAnimationFrame(tick);
    });
  },
  /** { mode, tau, live, skipped, fired, marks } while an intro is on screen, else null. */
  introClock() {
    return call('introClock') || null;
  },
  /** CSS rects { emb, word } of the centred intro logo (for DOM overlays such as the tagline). */
  bootLayout() {
    return call('bootLayout') || null;
  },
  /** True while a cinematic intro is playing (the titlebar logo is hidden meanwhile). */
  get introActive() {
    return intro.active;
  },
  /** Registers a callback for the end of the intro (the DOM logo takes over). Returns an unsubscribe. */
  onIntroDone(fn) {
    introListeners.add(fn);
    return () => introListeners.delete(fn);
  },
  /** Called with (tier, reason) whenever the engine changes tier. Returns an unsubscribe. */
  onTierChange(fn) {
    tierListeners.add(fn);
    return () => tierListeners.delete(fn);
  },
  /** 'ultra' | 'high' | 'low' | 'off' (settings "Effekte"; switches the tier live) */
  setQuality(q) {
    last.quality = q;
    call('setQuality', q);
  },
  resize() {
    call('resize');
  },
  dispose() {
    call('dispose');
    endIntro();
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
  /** { renderer, software, dedicated, hdr, fpsCap, scale, tier, maxTier, probeMs, initMs, size } */
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
  if (last.state) {
    call('setState', last.state, last.stateOpts);
    if (last.state === 'boot') syncIntroFlag();
  }
  if (last.progress !== undefined) call('setProgress', last.progress);
  if (last.paused) call('setPaused', true);
}
