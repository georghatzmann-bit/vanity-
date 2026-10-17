// PHOENIX FX – public entry (loaded lazily by core/fx-bridge.js).
//
//   const fx = await createFx(canvas, {
//     quality: 'ultra'|'high'|'low'|'off',      // user setting "Effekte" (caps the tier)
//     tier: 'auto'|'ultra'|'high'|'low'|'static',
//     reducedMotion, intro: 'full'|'short'|'none', gpuHint: { software, renderer, vendorId },
//     header: { emb: DOMRect, word: DOMRect } | () => that,   // glide target of the intro logo
//     onIntroDone(), onTierChange(tier, reason), onError(err),
//   });
//   fx.setState('boot'|'idle'|'home'|'installing'|'success'|'error'|'scan', { immediate })
//   fx.setProgress(p|null, { reset }) · fx.pulse(strength) · fx.burst({ count }) · await fx.warp(ms)
//   fx.setAnchor(rect|null) · fx.setScrim(rects) · fx.setIntensity(0..1) · fx.setPaused(bool)
//   fx.playIntro('full'|'short'|'none') · fx.skipIntro() · fx.setQuality(q) · fx.resize()
//   fx.renderAt(t, snapshot?) · fx.snapshot() · fx.tier · fx.info · fx.dispose() / fx.destroy()
//
// Every frame is a pure function of (t, snapshot) – see state.js. Deterministic test frames:
//   index.html?fxt=<seconds>&fxstate=<state>&fxp=<progress|null>[&fxq=<tier>&fxrm=1&fxintro=short
//   &fxscrim=x,y,w,h;...&fxanchor=x,y,w,h] renders exactly that frame and sets window.__fxReady.
import { createSnapshot, cloneSnapshot, evaluate, createFrame, pushState, setProgress as snapProgress, addPulse, addBurst, normState, P } from './state.js';
import { TIERS, TIER_ORDER, detectGpu, tierForSetting, lowerTier, tierBelow, tierFromProbe, Governor, loadSavedTier, saveTier } from './tiers.js';
import { INTRO_FULL, INTRO_SHORT } from './timeline.js';
import { prepareFont } from './bake.js';
import { FxRenderer } from './renderer.js';
import { createStaticLayer } from './static/static.js';

export { emblemSvg, emblemPaths } from './emblem/svg.js';
export { decode } from './text/decode.js';

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const rectArr = (r) => {
  if (!r) return null;
  if (Array.isArray(r)) return r.slice(0, 4).map(Number);
  const x = r.left ?? r.x ?? 0;
  const y = r.top ?? r.y ?? 0;
  return [x, y, r.width ?? 0, r.height ?? 0];
};

function envFor(cssW, cssH) {
  const aspect = cssW / Math.max(1, cssH);
  return { cssW, cssH, aspect, content: Math.min(1, aspect / 1.25) };
}

function readTestParams(search = location.search) {
  try {
    const q = new URLSearchParams(search);
    if (!q.has('fxt')) return null;
    const num = (k, d) => (q.has(k) && q.get(k) !== '' && q.get(k) !== 'null' ? Number(q.get(k)) : d);
    const rects = (k) =>
      (q.get(k) || '')
        .split(';')
        .map((s) => s.split(',').map(Number))
        .filter((a) => a.length === 4 && a.every((n) => Number.isFinite(n)));
    return {
      t: num('fxt', 0),
      state: q.get('fxstate') || 'boot',
      p: q.get('fxp') === 'null' ? null : num('fxp', 0.5),
      tier: q.get('fxq') || 'high',
      rm: q.get('fxrm') === '1',
      intro: q.get('fxintro') || 'full',
      scrim: rects('fxscrim'),
      anchor: rects('fxanchor')[0] || null,
      noFlash: q.get('fxnoflash') === '1',
    };
  } catch {
    return null;
  }
}

/** Snapshot for a deterministic test frame: the state was entered at t = 0. */
function testSnapshot(T) {
  const s = createSnapshot({ reducedMotion: T.rm });
  const st = T.state;
  if (T.anchor) s.anchor = { from: null, to: T.anchor, t0: -1000 };
  if (T.scrim.length) s.scrim = T.scrim.slice(0, 4);
  if (T.noFlash) s.noFlash = true; // test only: isolates the flash term for the duration check
  const at = (name, t0, p0 = 0) => s.states.push({ s: name, t0, dur: 0.6, p0, cloud0: p0 > 0 ? 1 : 0, asm0: p0 * 1.03, rev0: p0, alpha0: 0.15 + 0.45 * p0 });
  if (st === 'boot') {
    s.intro = { mode: T.intro, t0: 0, skipT: null, head: null };
    s.states.push({ s: 'boot', t0: 0, dur: 0, p0: 0, cloud0: 0, asm0: 0, rev0: 0, alpha0: 0 });
  } else if (st === 'home' || st === 'warp') {
    at('home', -10);
    if (st === 'warp') s.warp = { t0: 0, dur: 0.7 };
  } else if (st === 'installing' || st === 'scan') {
    at('installing', -10);
    snapProgress(s, -10, T.p == null ? 0.3 : T.p, true);
    if (T.p == null) snapProgress(s, -10, null);
  } else if (st === 'success') {
    at('installing', -10);
    snapProgress(s, -10, 0.85, true);
    at('success', 0, 0.85);
  } else if (st === 'error') {
    at('installing', -10);
    snapProgress(s, -10, 0.6, true);
    at('error', 0, 0.6);
    s.states[s.states.length - 1].dur = 0.35;
  }
  return s;
}

/** Typical steady frame (installing at 60 %, t = 20) for the software-renderer probe. */
function steadySnapshot() {
  const s = createSnapshot();
  s.states.push({ s: 'installing', t0: 0, dur: 0.6, p0: 0, cloud0: 0, asm0: 0, rev0: 0, alpha0: 0 });
  snapProgress(s, 0, 0.6, true);
  return s;
}

/** Heavy frame used by the speed probe (boot climax, t = 3.6). */
function probeSnapshot() {
  const s = createSnapshot();
  s.intro = { mode: 'full', t0: 0, skipT: null, head: null };
  s.states.push({ s: 'boot', t0: 0, dur: 0, p0: 0, cloud0: 0, asm0: 0, rev0: 0, alpha0: 0 });
  return s;
}

export async function createFx(canvas, options = {}) {
  let opts = options;
  const T = readTestParams();
  const test = !!T;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = test ? T.rm : opts.reducedMotion != null ? !!opts.reducedMotion : !!(mq && mq.matches);
  const onError = (e) => {
    try {
      opts.onError && opts.onError(e);
    } catch {
      /* ignore */
    }
  };

  let snap = test ? testSnapshot(T) : createSnapshot({ reducedMotion });
  const F = createFrame();
  const Fx = createFrame(); // scratch (entry values for state changes)
  // dev override (?fxtier=low) to look at a tier on any machine
  let devTier = null;
  try {
    devTier = new URLSearchParams(location.search).get('fxtier');
  } catch {
    /* ignore */
  }
  if (devTier && !TIER_ORDER.includes(devTier)) devTier = null;
  if (devTier && !opts.tier) opts = { ...opts, tier: devTier };
  let cap = test ? T.tier : opts.tier && opts.tier !== 'auto' ? opts.tier : tierForSetting(opts.quality || 'ultra');
  const forced = test || (opts.tier && opts.tier !== 'auto');
  const forcedTier = forced && !test ? cap : 'ultra';
  let maxTier = 'ultra'; // what the hardware allows (probe result)
  let tier = 'static';
  let gl = null;
  let gpu = { renderer: 'none', software: false, dedicated: false, hdr: false };
  let R = null; // FxRenderer
  let stat = null; // static layer
  let probeMs = null;
  let lost = false;
  let disposed = false;
  let raf = 0;
  let userPaused = false;
  let blurred = typeof document !== 'undefined' && document.hasFocus ? !document.hasFocus() : false;
  let onBattery = false;
  let lastFrame = 0;
  let lastRenderAt = -1;
  let lastPulseAt = -1e9;
  let introFiredFor = null;
  let staticState = 'idle';
  const gov = new Governor();
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  let initMs = 0;
  let env = envFor(1, 1);
  let pendingResize = true;

  const cssSize = () => {
    const w = canvas.clientWidth || window.innerWidth || 1;
    const h = canvas.clientHeight || window.innerHeight || 1;
    return [w, h];
  };

  function doResize() {
    pendingResize = false;
    const [w, h] = cssSize();
    env = envFor(w, h);
    if (R) R.resize(w, h, window.devicePixelRatio || 1, gov.scale);
  }

  function ensureGl() {
    if (gl) return gl;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: test,
      });
    } catch {
      gl = null;
    }
    if (gl) {
      gpu = detectGpu(gl, opts.gpuHint);
      gov.software = gpu.software;
      canvas.addEventListener('webglcontextlost', onLost, false);
      canvas.addEventListener('webglcontextrestored', onRestored, false);
    }
    return gl;
  }

  function buildRenderer(name) {
    if (R) {
      R.dispose();
      R = null;
    }
    R = new FxRenderer(canvas, TIERS[name], {
      context: gl,
      onError: (msg) => {
        console.error(msg);
        onError(new Error(msg));
        if (!test) queueMicrotask(() => switchTier('static', 'shader-error'));
      },
    });
    gov.scale = 1;
    doResize();
    return R;
  }

  function showStatic() {
    if (R) {
      R.dispose();
      R = null;
    }
    if (!stat) {
      stat = createStaticLayer(canvas, { reducedMotion });
      staticState = '';
      syncStatic();
      stat.setProgress(F.p[P.lineReveal] || 0);
    }
  }

  function switchTier(name, reason) {
    if (disposed || name === tier) return;
    const prev = tier;
    tier = name;
    gov.reset();
    if (name === 'static') showStatic();
    else {
      if (!ensureGl() || lost) {
        tier = 'static';
        showStatic();
      } else {
        try {
          buildRenderer(name);
          if (stat) {
            stat.dispose();
            stat = null;
          }
          precompileSoon();
        } catch (err) {
          console.warn('[fx] renderer failed, using the static tier', err);
          onError(err);
          tier = 'static';
          showStatic();
        }
      }
    }
    if (tier !== prev) {
      try {
        opts.onTierChange && opts.onTierChange(tier, reason);
      } catch {
        /* ignore */
      }
    }
    schedule();
  }

  // ------------------------------------------------------------------ variants: pre-compile
  function variantKeys() {
    const keys = { plasma: new Set(), comp: new Set(), emb: new Set() };
    const s1 = probeSnapshot();
    const e = env;
    const add = (t, s) => {
      evaluate(t, s, e, Fx);
      keys.plasma.add(R.plasmaKeyFor(Fx));
      keys.comp.add(R.compKeyFor(Fx));
      keys.emb.add(R.embKeyFor(Fx));
    };
    const K = snap.intro && snap.intro.mode === 'short' ? INTRO_SHORT : INTRO_FULL;
    for (let t = 0; t <= K.IDLE + 0.5; t += 0.05) add(t, s1);
    const s2 = createSnapshot();
    s2.scrim = [[100, 100, 400, 300]];
    s2.states.push({ s: 'installing', t0: 0, dur: 0.6, p0: 0, cloud0: 0, asm0: 0, rev0: 0, alpha0: 0 });
    addPulse(s2, 1, 0.6, 0, 0);
    add(0.3, s2);
    add(1.2, s2);
    add(3, s2);
    s2.states.push({ s: 'success', t0: 4, dur: 0.6, p0: 1, cloud0: 1, asm0: 1, rev0: 1, alpha0: 0.6 });
    for (let t = 4; t < 10; t += 0.1) add(t, s2);
    s2.states.push({ s: 'error', t0: 11, dur: 0.35, p0: 1, cloud0: 1, asm0: 1, rev0: 1, alpha0: 0.6 });
    for (let t = 11; t < 14; t += 0.2) add(t, s2);
    s2.warp = { t0: 15, dur: 0.7 };
    add(15.35, s2);
    return keys;
  }
  function precompileSoon() {
    if (!R || test) return;
    const r = R;
    (async () => {
      await new Promise((res) => setTimeout(res, 50));
      if (r !== R) return;
      try {
        await r.precompile(variantKeys(), { async: true });
      } catch (err) {
        console.warn('[fx] precompile failed', err);
      }
    })();
  }

  // ------------------------------------------------------------------ frames
  function frameAt(t, s = snap) {
    if (pendingResize) doResize();
    evaluate(t, s, env, F);
    // idle caching: quantise the plasma clock in calm states (spec 4.6.7)
    const top = s.states[s.states.length - 1];
    const calm = (top.s === 'idle' || top.s === 'home' || top.s === 'installing') && t > top.t0 + top.dur;
    if (calm && R && !test) {
      const rate = R.tier.plasmaRate;
      F.plasmaT = Math.floor(t * rate) / rate;
    }
    if (R && !lost) R.render(F, env);
    else if (stat) syncStatic();
    return F;
  }

  function syncStatic() {
    const top = snap.states[snap.states.length - 1].s;
    if (top !== staticState) {
      staticState = top;
      stat.setState(top);
    }
  }

  function fpsCap() {
    if (!R) return 0;
    const fp = R.tier.fps;
    let f;
    if (F.bootActive && F.introT < (snap.intro && snap.intro.mode === 'short' ? INTRO_SHORT.IDLE : INTRO_FULL.IDLE)) f = fp.intro;
    else {
      const top = snap.states[snap.states.length - 1];
      const age = now() - top.t0;
      const busy = (top.s === 'success' && age < 5.2) || (top.s === 'error' && age < 3) || F.warpEnv > 0 || F.climax > 0.02 || age < top.dur + 0.2;
      f = busy ? fp.intro : top.s === 'installing' ? fp.installing : fp.idle;
    }
    if (now() - lastPulseAt < 1.0) f = Math.max(f, fp.pulse);
    if (blurred || onBattery) f = Math.min(f, 30);
    if (gpu.software && f > 30) f = 30;
    return f;
  }

  function loop(ts) {
    raf = 0;
    if (disposed || lost || !R) return;
    if (userPaused || document.hidden) return; // resumes via visibilitychange / setPaused(false)
    raf = requestAnimationFrame(loop);
    const nowMs = performance.now();
    if (lastRenderAt > 0 && !forced) {
      const target = 1000 / Math.max(1, fpsCap());
      const steady = !F.bootActive && F.climax < 0.02 && F.warpEnv === 0;
      const act = gpu.software && !steady ? null : gov.sample(nowMs - lastRenderAt, Math.max(target, 16.7), nowMs);
      lastRenderAt = -1;
      if (act === 'scale') {
        R.resize(env.cssW, env.cssH, window.devicePixelRatio || 1, gov.scale);
      } else if (act === 'drop' || act === 'static') {
        const next = act === 'static' ? 'static' : tierBelow(tier);
        maxTier = next;
        saveTier(gpu.renderer, next);
        switchTier(next, 'governor');
        return;
      }
    }
    const fps = fpsCap();
    if (fps > 0 && nowMs - lastFrame < 1000 / fps - 3) return;
    lastFrame = nowMs;
    const t = (nowMs - t0) / 1000;
    try {
      lastRenderAt = performance.now();
      frameAt(t);
    } catch (err) {
      console.error('[fx] frame failed', err);
      onError(err);
      switchTier('static', 'error');
      return;
    }
    checkIntroDone(t);
  }

  function checkIntroDone(t) {
    if (!snap.intro || !F.bootActive) return;
    if (introFiredFor === snap.intro) return;
    if (t >= F.introDoneAt) {
      introFiredFor = snap.intro;
      setTimeout(() => {
        try {
          opts.onIntroDone && opts.onIntroDone();
          api.onIntroDone && api.onIntroDone !== opts.onIntroDone && api.onIntroDone();
        } catch (err) {
          console.error('[fx] onIntroDone failed', err);
        }
      }, 0);
    }
  }

  // static tier: intro "done" after a 400 ms fade
  function staticIntroTimer() {
    if (!stat || !snap.intro) return;
    const intro = snap.intro;
    setTimeout(() => {
      if (introFiredFor === intro || snap.intro !== intro) return;
      introFiredFor = intro;
      try {
        opts.onIntroDone && opts.onIntroDone();
        api.onIntroDone && api.onIntroDone !== opts.onIntroDone && api.onIntroDone();
      } catch (err) {
        console.error('[fx] onIntroDone failed', err);
      }
    }, intro.mode === 'none' ? 0 : 400);
  }

  function schedule() {
    if (test || disposed || raf || !R || lost || userPaused || document.hidden) return;
    raf = requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ events
  function onLost(e) {
    e.preventDefault();
    lost = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lostTimer = setTimeout(() => {
      if (lost && !disposed) {
        // no restore within 3 s: keep the UI alive with the static tier
        if (R) {
          try {
            R.dispose();
          } catch {
            /* ignore */
          }
          R = null;
        }
        tier = 'static';
        showStatic();
        opts.onTierChange && opts.onTierChange('static', 'context-lost');
      }
    }, 3000);
  }
  let lostTimer = 0;
  function onRestored() {
    clearTimeout(lostTimer);
    lost = false;
    if (disposed) return;
    // rebuild the engine in place (never reload the page); the snapshot keeps the state
    const name = tier === 'static' ? lowerTier(cap, maxTier) : tier;
    tier = 'none';
    if (R) {
      try {
        R.dispose();
      } catch {
        /* ignore */
      }
      R = null;
    }
    switchTier(name === 'static' ? 'static' : name, 'context-restored');
    if (test && R) frameAt(T.t);
  }
  const onVis = () => {
    if (!document.hidden) {
      lastRenderAt = -1;
      schedule();
    }
  };
  const onResize = () => {
    pendingResize = true;
    if (test && R) frameAt(T.t);
  };
  const onBlur = () => (blurred = true);
  const onFocus = () => {
    blurred = false;
    schedule();
  };

  // ------------------------------------------------------------------ boot sequence
  const fontReady = Promise.race([prepareFont(), new Promise((res) => setTimeout(() => res(false), 1500))]);
  await fontReady;

  let start = test ? (TIER_ORDER.includes(T.tier) ? T.tier : 'high') : cap;
  if (start !== 'static' && !ensureGl()) start = 'static';
  if (start !== 'static' && !forced) {
    const saved = loadSavedTier(gpu.renderer); // re-probed only when the renderer string changes
    if (saved) maxTier = saved;
    if (gpu.software) start = 'low';
    else if (!saved && !gpu.dedicated && start === 'ultra') start = 'high';
    start = lowerTier(start, maxTier);
  }

  if (start !== 'static') {
    try {
      tier = start;
      buildRenderer(start);
      // speed probe (spec 4.6.3) on the heaviest phase unless a saved result exists for this GPU
      if (!forced && !loadSavedTier(gpu.renderer)) {
        // hardware: heaviest phase (intro climax); software: the steady installing look (spec: the
        // intro may run at 30 fps, idle / installing must stay under ~70 ms or the tier is static)
        const ps = gpu.software ? steadySnapshot() : probeSnapshot();
        evaluate(gpu.software ? 20 : 3.6, ps, env, Fx);
        Fx.p[P.exposure] = 0; // dark while probing
        probeMs = R.probe(Fx, env, gpu.software ? 4 : 12, gpu.software ? 450 : 350);
        let res = tierFromProbe(probeMs, gpu);
        if (res === 'low-slow') {
          if (tier !== 'low') {
            buildRenderer('low');
            tier = 'low';
            evaluate(3.6, ps, env, Fx);
            Fx.p[P.exposure] = 0;
            probeMs = R.probe(Fx, env, 6, 300);
          }
          res = probeMs <= 45 ? 'low' : 'static';
        }
        maxTier = res;
        saveTier(gpu.renderer, res);
        const want = lowerTier(cap, res);
        if (want !== tier) {
          if (want === 'static') {
            tier = 'static';
            showStatic();
          } else {
            tier = want;
            buildRenderer(want);
          }
        }
      }
    } catch (err) {
      console.warn('[fx] WebGL engine unavailable, using the static tier', err);
      onError(err);
      tier = 'static';
      showStatic();
    }
  } else {
    tier = 'static';
    showStatic();
  }

  initMs = Math.round(performance.now() - t0);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  try {
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        const upd = () => (onBattery = !b.charging);
        upd();
        b.addEventListener('chargingchange', upd);
      });
    }
  } catch {
    /* ignore */
  }
  if (!forced) precompileSoon();

  // ------------------------------------------------------------------ public API
  const frozen = () => test || disposed;
  const anchorWorld = () => {
    evaluate(now(), snap, env, Fx);
    return [Fx.p[P.ancX], Fx.p[P.ancY]];
  };
  const readHeader = () => {
    try {
      const h = typeof opts.header === 'function' ? opts.header() : opts.header;
      if (h && (h.emb || h.word)) return { emb: rectArr(h.emb), word: rectArr(h.word) };
      const logo = document.querySelector('.titlebar__brand svg');
      const word = document.querySelector('.titlebar__wordmark');
      if (logo || word) return { emb: logo ? rectArr(logo.getBoundingClientRect()) : null, word: word ? rectArr(word.getBoundingClientRect()) : null };
    } catch {
      /* ignore */
    }
    return null;
  };

  const api = {
    onIntroDone: null,
    get tier() {
      return tier;
    },
    get info() {
      return {
        renderer: gpu.renderer,
        software: gpu.software,
        dedicated: gpu.dedicated,
        hdr: R ? R.hdr : false,
        fpsCap: R ? fpsCap() : 0,
        scale: R ? R.tier.scale * gov.scale : 0,
        tier,
        maxTier,
        probeMs,
        initMs,
        size: R ? { w: R.size.W, h: R.size.H } : null,
      };
    },
    get state() {
      return snap.states[snap.states.length - 1].s;
    },
    get introPlaying() {
      return F.bootActive && F.introT < (snap.intro && snap.intro.mode === 'short' ? INTRO_SHORT.DONE : INTRO_FULL.DONE);
    },
    /** Bridge compatibility: the engine is already initialised by createFx. */
    init() {
      return api;
    },
    setState(name, o = {}) {
      if (frozen()) return;
      const s = normState(name);
      if (!s) return;
      const t = now();
      if (s === 'boot') {
        if (api.state !== 'boot') api.playIntro(opts.intro || 'full');
        return;
      }
      evaluate(t, snap, env, Fx);
      pushState(snap, s, t, Fx, !!o.immediate || reducedMotion);
      if (s === 'success' && !reducedMotion) lastPulseAt = t;
      if (stat) syncStatic();
      schedule();
    },
    setProgress(p, o = {}) {
      if (frozen()) return;
      snapProgress(snap, now(), p == null ? null : Number(p), !!o.reset);
      if (stat) stat.setProgress(p);
    },
    pulse(strength = 0.6) {
      if (frozen()) return;
      const amp = Math.max(0, Math.min(1.5, Number(strength) || 0.6));
      const [x, y] = anchorWorld();
      addPulse(snap, now(), amp, x, y);
      lastPulseAt = now();
      if (stat) stat.pulse(amp);
      schedule();
    },
    burst(o = {}) {
      if (frozen()) return;
      const count = o && o.count ? Number(o.count) : 220;
      if (reducedMotion) return api.pulse(0.5);
      addBurst(snap, now(), o && o.amp ? Number(o.amp) : 0.7, Math.max(0.25, Math.min(1, count / 220)));
      lastPulseAt = now();
      if (stat) stat.pulse(0.9);
      schedule();
    },
    /** Screen transition; resolves at the peak (swap the DOM then). */
    warp(ms = 700) {
      const dur = Math.max(200, Math.min(2000, Number(ms) || 700));
      if (!frozen()) {
        snap.warp = { t0: now(), dur: dur / 1000 };
        lastPulseAt = now();
        if (stat) stat.warp(dur);
        schedule();
      }
      return new Promise((res) => setTimeout(res, dur * 0.5));
    },
    setAnchor(rect) {
      if (frozen()) return;
      const t = now();
      evaluate(t, snap, env, Fx);
      snap.anchor = { from: { w: [Fx.p[P.ancX], Fx.p[P.ancY], Fx.p[P.ancS]] }, to: rectArr(rect), t0: t };
      if (stat) stat.setAnchor(rect || null);
    },
    setScrim(rects) {
      if (frozen()) return;
      snap.scrim = (rects || []).slice(0, 4).map(rectArr).filter((r) => r && r[2] > 0 && r[3] > 0);
    },
    setIntensity(k) {
      if (frozen()) return;
      snap.intensity = clamp01(Number(k));
      if (stat) stat.setIntensity(snap.intensity);
    },
    setPaused(p) {
      userPaused = !!p;
      if (!userPaused) {
        lastRenderAt = -1;
        schedule();
      }
    },
    playIntro(mode = 'full') {
      if (frozen()) return;
      const m = mode === 'short' || mode === 'none' ? mode : 'full';
      const t = now();
      snap.intro = { mode: m, t0: t, skipT: null, head: readHeader() };
      introFiredFor = null;
      evaluate(t, snap, env, Fx);
      snap.states.push({ s: 'boot', t0: t, dur: 0, p0: 0, cloud0: 0, asm0: 0, rev0: 0, alpha0: 0 });
      while (snap.states.length > 4) snap.states.shift();
      if (stat) {
        syncStatic();
        staticIntroTimer();
      }
      schedule();
    },
    skipIntro() {
      if (frozen() || !snap.intro || api.state !== 'boot') return;
      const K = snap.intro.mode === 'short' ? INTRO_SHORT : INTRO_FULL;
      const t = now();
      if (t - snap.intro.t0 < K.BURN0 && snap.intro.skipT == null) snap.intro.skipT = t;
    },
    setQuality(q) {
      if (test || disposed) return;
      cap = lowerTier(tierForSetting(q), forcedTier);
      const want = lowerTier(cap, maxTier);
      if (want !== tier) switchTier(want, 'setting');
    },
    resize() {
      pendingResize = true;
      schedule();
    },
    /** Renders frame t immediately (deterministic: pure function of t + snapshot). */
    renderAt(t, s) {
      return frameAt(Number(t) || 0, s || snap);
    },
    snapshot() {
      return cloneSnapshot(snap);
    },
    /** Replaces the snapshot (tests / tools). */
    restore(s) {
      if (s) snap = cloneSnapshot(s);
    },
    get renderer() {
      return R;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(lostTimer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      if (R) R.dispose();
      R = null;
      if (stat) stat.dispose();
      stat = null;
    },
    destroy() {
      api.dispose();
    },
  };

  if (test) {
    exposeTestHooks(api, T, () => R, () => gl, () => snap);
    // re-targets the frozen test frame without a reload: __fxFrame('fxt=3.2&fxstate=boot')
    window.__fxFrame = (qs) => {
      const T2 = readTestParams(qs);
      if (!T2) return false;
      Object.assign(T, { t: T2.t, state: T2.state, p: T2.p, rm: T2.rm, intro: T2.intro, scrim: T2.scrim, anchor: T2.anchor });
      snap = testSnapshot(T2);
      if (R) {
        R.plasmaValid = false;
        frameAt(T2.t);
      } else if (stat) {
        staticState = '';
        syncStatic();
        stat.setProgress(T2.p);
      }
      return true;
    };
    if (tier === 'static') {
      syncStatic();
      stat.setProgress(T.p);
    } else frameAt(T.t);
    requestAnimationFrame(() => {
      if (R) frameAt(T.t);
      requestAnimationFrame(() => {
        window.__fxReady = true;
      });
    });
  } else {
    schedule();
  }
  return api;
}

// ------------------------------------------------------------------ test hooks (golden screenshots)
function lumStats(px, w, h, rects) {
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  const region = (x0, y0, x1, y1) => {
    const hist = new Uint32Array(1001);
    let sum = 0;
    let n = 0;
    let max = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const L = 0.2126 * lin[px[i]] + 0.7152 * lin[px[i + 1]] + 0.0722 * lin[px[i + 2]];
        sum += L;
        n++;
        if (L > max) max = L;
        hist[Math.min(1000, Math.round(L * 1000))]++;
      }
    }
    let acc = 0;
    let p99 = 0;
    for (let k = 0; k <= 1000; k++) {
      acc += hist[k];
      if (acc >= n * 0.99) {
        p99 = k / 1000;
        break;
      }
    }
    return { mean: n ? sum / n : 0, p99, max, n };
  };
  const all = region(0, 0, w, h);
  const scr = rects.map(([x0, y0, x1, y1]) => region(Math.max(0, x0), Math.max(0, y0), Math.min(w, x1), Math.min(h, y1)));
  const center = region(Math.round(w * 0.25), Math.round(h * 0.25), Math.round(w * 0.75), Math.round(h * 0.75));
  return { ...all, center, scrims: scr };
}

function exposeTestHooks(api, T, getR, getGl, getSnap) {
  window.__fx = api;
  window.__fxTest = T;
  window.__fxStats = () => {
    const R = getR();
    const gl = getGl();
    if (!R || !gl) return null;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const sx = w / R.size.cssW;
    const sy = h / R.size.cssH;
    const rects = getSnap().scrim.map(([x, y, rw, rh]) => [Math.round(x * sx), Math.round(h - (y + rh) * sy), Math.round((x + rw) * sx), Math.round(h - y * sy)]);
    return lumStats(px, w, h, rects);
  };
  window.__fxDeterminism = () => {
    const R = getR();
    const gl = getGl();
    if (!R || !gl) return null;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const a = new Uint8Array(w * h * 4);
    const b = new Uint8Array(w * h * 4);
    api.renderAt(T.t);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
    R.plasmaValid = false;
    api.renderAt(T.t);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff;
  };
  window.__fxResizeLeak = async (n = 50) => {
    const R = getR();
    if (!R) return null;
    const before = R.memory.textures;
    for (let i = 0; i < n; i++) {
      R.resize(600 + (i % 7) * 37, 400 + (i % 5) * 23, 1);
      api.renderAt(T.t);
    }
    R.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    api.renderAt(T.t);
    return { before, after: getR().memory.textures };
  };
  window.__fxLoseRestore = async () => {
    const gl = getGl();
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) return null;
    const state = api.state;
    ext.loseContext();
    await new Promise((r) => setTimeout(r, 150));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 400));
    return { state, after: api.state, tier: api.tier, rendered: !!getR() };
  };
}

export default { createFx };
