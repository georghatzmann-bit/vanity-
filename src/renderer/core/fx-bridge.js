// Bridge between UI code and the background FX engine (src/renderer/fx/engine.js).
// All methods are safe no-ops until an engine is attached; the last state / progress / quality /
// anchor / scrims / intensity are replayed when it arrives, so screens never need to care whether
// the engine is loaded (or whether WebGL exists at all – the engine falls back to a CSS tier).
//
// Screens without own scrims get automatic ones: the biggest glass panels / cards of the visible
// screen ([data-fx-scrim] opts an element in, [data-fx-noscrim] out). 'success' runs the climax only
// right after 'installing' / 'scan'; a follow-up results screen gets the engine's 'afterglow' look.
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
const last = { state: null, engineState: null, stateOpts: undefined, progress: undefined, quality: null, anchor: undefined, scrim: null, intensity: null, paused: false };
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
  if (pending) fx.setState(pending.name, pending.opts);
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
// Releasing the hero slot (home -> another screen): the emblem fades out with the state change, so
// it should do that where it is – the centre reset waits until it is gone (or until a state that
// shows the bird in the centre arrives first).
const ANCHOR_RESET_MS = 700;
const CENTRE_STATES = new Set(['boot', 'installing', 'success', 'error']);
let anchorResetTimer = 0;
function releaseAnchor() {
  clearTimeout(anchorResetTimer);
  anchorResetTimer = setTimeout(flushAnchorReset, ANCHOR_RESET_MS);
}
function flushAnchorReset() {
  if (!anchorResetTimer) return;
  clearTimeout(anchorResetTimer);
  anchorResetTimer = 0;
  if (!anchorOwner) fx.setAnchor(null);
}

function measure(el) {
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

// ---- automatic scrims ---------------------------------------------------------------------------
// A screen that registers no panels of its own (scrimFor) still gets calm FX behind its glass
// surfaces: the biggest glass panels / cards of the visible screen are found by a cheap, pruned DOM
// walk (on screen change, then every few seconds for content that arrives later) and scrimmed.
// Opt out per element with [data-fx-noscrim], opt in a non-glass element with [data-fx-scrim].
const AUTO_RESCAN_MS = 2500;
const auto = { screen: null, els: [], scanAt: 0 };

function activeScreen() {
  const app = typeof document !== 'undefined' ? document.getElementById('app') : null;
  if (!app) return null;
  let last = null;
  let live = null; // the newest screen that is not leaving (leaving screens are inert)
  for (const el of app.children) {
    if (!el.classList.contains('screen')) continue;
    last = el;
    if (!el.inert) live = el;
  }
  return live || last;
}

function scanPanels(screen) {
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const minArea = vw * vh * 0.025;
  const found = [];
  const walker = document.createTreeWalker(screen, NodeFilter.SHOW_ELEMENT, {
    acceptNode(el) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height < minArea) return NodeFilter.FILTER_REJECT; // nothing panel-sized below
      if (el.hasAttribute('data-fx-noscrim')) return NodeFilter.FILTER_REJECT;
      if (r.width < 120 || r.height < 60 || r.width > vw * 0.98 || r.height > vh * 0.92) return NodeFilter.FILTER_SKIP;
      let panel = el.matches('.card, .glass, [data-fx-scrim]');
      if (!panel) {
        const bf = getComputedStyle(el).backdropFilter;
        panel = !!bf && bf !== 'none';
      }
      if (!panel) return NodeFilter.FILTER_SKIP;
      found.push(el);
      return NodeFilter.FILTER_REJECT; // the panel covers its children
    },
  });
  while (walker.nextNode()) {
    /* acceptNode collects */
  }
  return found;
}

function autoScrimEls() {
  const screen = activeScreen();
  const now = performance.now();
  if (!screen) {
    auto.screen = null;
    auto.els = [];
    return auto.els;
  }
  if (screen !== auto.screen || now - auto.scanAt > AUTO_RESCAN_MS) {
    auto.screen = screen;
    auto.scanAt = now;
    try {
      auto.els = scanPanels(screen);
    } catch {
      auto.els = [];
    }
  }
  return auto.els;
}

function track() {
  // scrims: every registered panel (or, without any, the screen's own glass panels), biggest four win
  const autoMode = !scrimOwners.size && !!engine;
  if (scrimOwners.size || lastScrimKey || autoMode) {
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
    if (!scrimOwners.size && engine) {
      for (const el of autoScrimEls()) {
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
      releaseAnchor();
    } else {
      const r = measure(anchorOwner.el);
      const key = r ? `${r.left},${r.top},${r.width},${r.height}` : '';
      if (r && key !== lastAnchorKey) {
        lastAnchorKey = key;
        clearTimeout(anchorResetTimer);
        anchorResetTimer = 0;
        fx.setAnchor(r);
      }
    }
  }
  if (!scrimOwners.size && !anchorOwner && !lastScrimKey && !engine) stopTracking();
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
    let engineState = name;
    if (name === 'success') {
      // The climax (bird ignites, wordmark, shockwave) belongs to the screen where the bird was
      // being built (install). A follow-up results screen that sets 'success' again (install ->
      // done), or a success shown without a preceding install, gets the 'afterglow' look instead:
      // the bird burns away into embers, no wordmark behind a dense UI, and no second climax.
      const now = performance.now();
      const repeat = last.state === 'success' && now - successAt < 8000;
      const built = last.state === 'installing' || last.state === 'scan';
      successAt = now;
      if (repeat || !built) engineState = 'afterglow';
    }
    if (CENTRE_STATES.has(name) && engineState !== 'afterglow') flushAnchorReset(); // the bird is needed in the centre right away
    last.state = name;
    last.stateOpts = opts;
    last.engineState = engineState;
    call('setState', engineState, opts);
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
    clearTimeout(anchorResetTimer);
    anchorResetTimer = 0;
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
      releaseAnchor();
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
    last.engineState = null;
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
    last.engineState = null;
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
  /** Deterministic frame tools (tests / debugging): engine snapshot and render-at-time. */
  snapshot() {
    return call('snapshot') || null;
  },
  renderAt(t, snap) {
    return call('renderAt', t, snap);
  },
  dispose() {
    clearTimeout(anchorResetTimer);
    anchorResetTimer = 0;
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
    call('setState', last.engineState || last.state, last.stateOpts);
    if (last.state === 'boot') syncIntroFlag();
  }
  if (last.progress !== undefined) call('setProgress', last.progress);
  if (last.paused) call('setPaused', true);
  if (typeof window !== 'undefined') startTracking(); // automatic scrims behind glass panels
}
