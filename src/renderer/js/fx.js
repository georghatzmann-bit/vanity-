// Bewegung und Effekte: 3D-Hintergrund (Partikel-Kugel, Sterne, Polarlicht, Gitterboden),
// Maus-Effekte (Lichtschein, Spotlight, 3D-Neigung, Magnet-Knöpfe, Klick-Welle),
// Funken und Konfetti. Alles läuft auf Canvas 2D ohne Bibliotheken und lässt sich
// abschalten. Ist im System "Bewegung reduzieren" an, startet alles ausgeschaltet.
(function () {
  'use strict';

  // ---------- Grundwerte ----------
  const VIOLET = [124, 108, 255];
  const CYAN = [34, 211, 238];
  const PULSE_RGB = { success: [52, 211, 153], warning: [251, 146, 60], info: [139, 124, 255] };
  const BURST_COLORS = ['124,108,255', '34,211,238', '255,255,255'];
  const PARTY_COLORS = ['124,108,255', '34,211,238', '255,255,255', '52,211,153', '244,114,182', '250,204,21'];
  const MAX_DPR = 1.5;
  const TILT_MAX = 6;    // Grad
  const MAGNET_MAX = 6;  // Pixel
  const MAX_PARTS = 1600;
  const TAU = Math.PI * 2;

  const SEL_HOVER = 'a, button, input, textarea, select, [role=button], label.check, .switch, .step-item, .nav-item';
  const SEL_SPOT = '.card, .data-tile, .big-action, .found-item, .open-box, .drop, .nav, .check, .step-item';
  const SEL_TILT = '.fx-tilt';
  const SEL_MAGNET = '.btn, .big-action, .nav-item';
  const SEL_RIPPLE = '.btn, .big-action, .nav-item, .step-item, .segmented button';
  const SEL_SPARK = '.btn-primary, .btn-success';
  const SEL_ENTER = '.page > *, .card, .data-tile, .big-action, .found-item, .step-item, .todo-list li';

  // ---------- Zustand ----------
  const mql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduceMotion = Boolean(mql && mql.matches);
  let wanted = true;       // Wunsch der App (setEnabled)
  let forced = false;      // trotz "Bewegung reduzieren" erzwungen
  let initialized = false;
  let rafId = 0;
  let lastTime = 0;
  let windowFocused = true;
  let clock = 0;           // Sekunden Animationszeit (läuft nur, solange aktiv)

  function isOn() {
    return wanted && (!reduceMotion || forced);
  }

  function now() {
    return performance.now();
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function rgb(c, alpha) {
    const s = Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]);
    return alpha === undefined ? 'rgb(' + s + ')' : 'rgba(' + s + ',' + alpha + ')';
  }

  function parseRgb(str) {
    const p = String(str).split(',').map((v) => clamp(Number(v) || 0, 0, 255));
    return p.length >= 3 ? [p[0], p[1], p[2]] : [255, 255, 255];
  }

  // Immer gleiche Zufallszahlen, damit die Kugel bei jedem Start gleich aussieht
  function seeded(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Leuchtpunkte (vorgezeichnet, damit pro Bild nur kopiert wird) ----------
  function makeCanvas(size) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    return c;
  }

  // Punkt mit hellem Kern und weichem Schein. Der feste Kern hat 1/5 der Bildbreite.
  function dotSprite(c) {
    const size = 32;
    const cv = makeCanvas(size);
    const g = cv.getContext('2d');
    const r = size / 2;
    const core = mix(c, [255, 255, 255], 0.55);
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgb(core, 1));
    grad.addColorStop(0.14, rgb(c, 1));
    grad.addColorStop(0.22, rgb(c, 0.8));
    grad.addColorStop(0.36, rgb(c, 0.28));
    grad.addColorStop(0.6, rgb(c, 0.07));
    grad.addColorStop(1, rgb(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return cv;
  }

  // Großer weicher Farbfleck (Polarlicht, Aufleuchten)
  function blobSprite(c) {
    const size = 128;
    const cv = makeCanvas(size);
    const g = cv.getContext('2d');
    const r = size / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgb(c, 1));
    grad.addColorStop(0.22, rgb(c, 0.62));
    grad.addColorStop(0.45, rgb(c, 0.26));
    grad.addColorStop(0.7, rgb(c, 0.07));
    grad.addColorStop(1, rgb(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return cv;
  }

  const spriteCache = new Map();
  function spriteFor(key, c) {
    let s = spriteCache.get(key);
    if (!s) {
      s = dotSprite(c);
      spriteCache.set(key, s);
    }
    return s;
  }

  // ---------- Maus ----------
  const pointer = {
    x: 0, y: 0, inside: false, touch: false, seen: false,
    target: null, dirty: false, refresh: false,
    lastX: 0, lastY: 0, lastT: 0, speed: 0,
  };
  const cursor = { glow: null, dot: null, gx: 0, gy: 0, dx: 0, dy: 0, hover: false, hidden: true, placed: false };
  let spotEls = [];
  let tiltEl = null;
  let magnetEl = null;
  const tilting = new Set();   // Elemente mit Neigung (auch beim Zurückfedern)
  const pulling = new Set();   // Magnet-Elemente (auch beim Zurückfedern)
  const elState = new WeakMap();
  let focusPt = null;          // { x, y, until } aus FX.focusPoint

  function stateOf(el) {
    let s = elState.get(el);
    if (!s) {
      s = { rx: 0, ry: 0, tx: 0, ty: 0 };
      elState.set(el, s);
    }
    return s;
  }

  function elementOf(t) {
    if (!t) return null;
    if (t.nodeType === 1) return t;
    return t.parentElement || null;
  }

  // Wird nur aufgerufen, wenn sich das Element unter der Maus ändert
  function setTarget(t) {
    pointer.target = t;
    const el = elementOf(t);
    spotEls = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.matches(SEL_SPOT)) spotEls.push(n);
    }
    const canMove = el && !pointer.touch && pointer.inside;
    const nextTilt = canMove ? el.closest(SEL_TILT) : null;
    if (nextTilt !== tiltEl) {
      tiltEl = nextTilt;
      if (tiltEl) tilting.add(tiltEl);
    }
    const nextMagnet = canMove ? el.closest(SEL_MAGNET) : null;
    if (nextMagnet !== magnetEl) {
      magnetEl = nextMagnet;
      if (magnetEl) pulling.add(magnetEl);
    }
    setHover(Boolean(el && pointer.inside && el.closest(SEL_HOVER)));
  }

  function setHover(on) {
    if (cursor.hover === on) return;
    cursor.hover = on;
    if (cursor.glow) {
      cursor.glow.classList.toggle('fx-cursor-hover', on);
      cursor.dot.classList.toggle('fx-cursor-hover', on);
    }
  }

  function setCursorHidden(hidden) {
    if (cursor.hidden === hidden) return;
    cursor.hidden = hidden;
    if (cursor.glow) {
      cursor.glow.classList.toggle('fx-cursor-hidden', hidden);
      cursor.dot.classList.toggle('fx-cursor-hidden', hidden);
    }
    if (hidden) cursor.placed = false;
  }

  function makeCursorEl(cls) {
    const d = document.createElement('div');
    d.className = cls + ' fx-cursor-hidden';
    d.setAttribute('aria-hidden', 'true');
    d.style.pointerEvents = 'none';
    d.style.position = 'fixed';
    d.style.left = '0';
    d.style.top = '0';
    d.style.willChange = 'transform';
    return d;
  }

  function attachCursor() {
    if (!cursor.glow) {
      cursor.glow = makeCursorEl('fx-cursor');
      cursor.dot = makeCursorEl('fx-cursor-dot');
    }
    const host = document.body || document.documentElement;
    if (!cursor.glow.isConnected) host.appendChild(cursor.glow);
    if (!cursor.dot.isConnected) host.appendChild(cursor.dot);
    cursor.hidden = true;
    cursor.placed = false;
    cursor.glow.classList.add('fx-cursor-hidden');
    cursor.dot.classList.add('fx-cursor-hidden');
    cursor.glow.classList.toggle('fx-cursor-hover', cursor.hover);
    cursor.dot.classList.toggle('fx-cursor-hover', cursor.hover);
  }

  function detachCursor() {
    if (!cursor.glow) return;
    cursor.glow.remove();
    cursor.dot.remove();
    cursor.glow.classList.remove('fx-cursor-hover');
    cursor.dot.classList.remove('fx-cursor-hover');
    cursor.hidden = true;
    cursor.placed = false;
  }

  function onPointerMove(e) {
    if (!isOn()) return;
    const t = now();
    const dx = e.clientX - pointer.lastX;
    const dy = e.clientY - pointer.lastY;
    const dtm = Math.max(1, t - pointer.lastT);
    pointer.speed = pointer.speed * 0.6 + (Math.sqrt(dx * dx + dy * dy) / dtm) * 1000 * 0.4;
    pointer.lastX = e.clientX;
    pointer.lastY = e.clientY;
    pointer.lastT = t;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.seen = true;
    pointer.dirty = true;
    const touch = e.pointerType === 'touch';
    const wasOutside = !pointer.inside;
    pointer.inside = true;
    if (touch !== pointer.touch || wasOutside || e.target !== pointer.target) {
      pointer.touch = touch;
      setTarget(e.target);
    }
    setCursorHidden(touch);
  }

  function onPointerOut(e) {
    if (e.relatedTarget) return;
    leaveWindow();
  }

  function leaveWindow() {
    pointer.inside = false;
    pointer.target = null;
    spotEls = [];
    tiltEl = null;
    magnetEl = null;
    setHover(false);
    setCursorHidden(true);
  }

  function onScroll() {
    if (!isOn() || !pointer.inside) return;
    pointer.refresh = true;
  }

  // Welle beim Drücken
  function onPointerDown(e) {
    if (!isOn() || !e.target || !e.target.closest) return;
    const el = e.target.closest(SEL_RIPPLE);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // Ohne eigene Position würde die Welle irgendwo anders landen
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    const size = 2.2 * Math.max(r.width, r.height);
    const span = document.createElement('span');
    span.className = 'fx-ripple';
    span.setAttribute('aria-hidden', 'true');
    span.style.pointerEvents = 'none';
    span.style.left = (e.clientX - r.left - el.clientLeft).toFixed(1) + 'px';
    span.style.top = (e.clientY - r.top - el.clientTop).toFixed(1) + 'px';
    span.style.width = size.toFixed(1) + 'px';
    span.style.height = size.toFixed(1) + 'px';
    let timer = 0;
    const done = () => {
      clearTimeout(timer);
      span.remove();
    };
    span.addEventListener('animationend', done, { once: true });
    timer = setTimeout(done, 700);
    el.appendChild(span);
  }

  // Kleine Funken bei wichtigen Knöpfen
  function onClick(e) {
    if (!isOn() || !e.target || !e.target.closest) return;
    const el = e.target.closest(SEL_SPARK);
    if (!el || el.disabled) return;
    let x = e.clientX;
    let y = e.clientY;
    if (!e.detail || (!x && !y)) {
      // Per Tastatur ausgelöst: Mitte des Knopfes
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    burst(x, y, { count: 18, small: true });
  }

  // Pro Bild: erst alle Maße lesen, dann schreiben (kein Layout-Hin-und-Her)
  const readBuf = [];
  function updateUi(dt) {
    if (pointer.refresh) {
      pointer.refresh = false;
      const t = document.elementFromPoint(pointer.x, pointer.y);
      if (t !== pointer.target) setTarget(t);
      pointer.dirty = true;
    }

    // Lichtschein folgt weich, der Punkt eng
    if (cursor.glow && !cursor.hidden) {
      if (!cursor.placed) {
        cursor.gx = cursor.dx = pointer.x;
        cursor.gy = cursor.dy = pointer.y;
        cursor.placed = true;
        moveCursor(cursor.glow, cursor.gx, cursor.gy);
        moveCursor(cursor.dot, cursor.dx, cursor.dy);
      } else {
        const kg = 1 - Math.exp(-dt * 9);
        const kd = 1 - Math.exp(-dt * 38);
        const ngx = cursor.gx + (pointer.x - cursor.gx) * kg;
        const ngy = cursor.gy + (pointer.y - cursor.gy) * kg;
        const ndx = cursor.dx + (pointer.x - cursor.dx) * kd;
        const ndy = cursor.dy + (pointer.y - cursor.dy) * kd;
        if (Math.abs(ngx - cursor.gx) + Math.abs(ngy - cursor.gy) > 0.05) moveCursor(cursor.glow, ngx, ngy);
        if (Math.abs(ndx - cursor.dx) + Math.abs(ndy - cursor.dy) > 0.05) moveCursor(cursor.dot, ndx, ndy);
        cursor.gx = ngx;
        cursor.gy = ngy;
        cursor.dx = ndx;
        cursor.dy = ndy;
      }
    }

    // Lesen
    readBuf.length = 0;
    if (pointer.dirty && pointer.inside && !pointer.touch) {
      for (let i = 0; i < spotEls.length; i++) readBuf.push(spotEls[i], spotEls[i].getBoundingClientRect());
    }
    const tiltRect = tiltEl ? tiltEl.getBoundingClientRect() : null;
    const magRect = magnetEl ? (magnetEl === tiltEl ? tiltRect : magnetEl.getBoundingClientRect()) : null;

    // Schreiben: Spotlight
    for (let i = 0; i < readBuf.length; i += 2) {
      const el = readBuf[i];
      const r = readBuf[i + 1];
      el.style.setProperty('--mx', (pointer.x - r.left).toFixed(1) + 'px');
      el.style.setProperty('--my', (pointer.y - r.top).toFixed(1) + 'px');
    }
    pointer.dirty = false;

    const k = 1 - Math.exp(-dt * 10);

    // 3D-Neigung: die Seite unter der Maus gibt nach (wie gedrückt)
    for (const el of tilting) {
      const s = stateOf(el);
      let trx = 0;
      let try_ = 0;
      if (el === tiltEl && tiltRect && tiltRect.width > 0 && tiltRect.height > 0) {
        const u = clamp((pointer.x - tiltRect.left) / tiltRect.width, 0, 1);
        const v = clamp((pointer.y - tiltRect.top) / tiltRect.height, 0, 1);
        trx = (0.5 - v) * 2 * TILT_MAX;
        try_ = (u - 0.5) * 2 * TILT_MAX;
      }
      const nrx = s.rx + (trx - s.rx) * k;
      const nry = s.ry + (try_ - s.ry) * k;
      const settled = el !== tiltEl && Math.abs(nrx) < 0.02 && Math.abs(nry) < 0.02;
      s.rx = settled ? 0 : nrx;
      s.ry = settled ? 0 : nry;
      el.style.setProperty('--rx', s.rx.toFixed(2) + 'deg');
      el.style.setProperty('--ry', s.ry.toFixed(2) + 'deg');
      if (settled) tilting.delete(el);
    }

    // Magnet: Knopf rückt bis zu 6 px zur Maus
    for (const el of pulling) {
      const s = stateOf(el);
      let ttx = 0;
      let tty = 0;
      if (el === magnetEl && magRect && magRect.width > 0 && magRect.height > 0) {
        // Mitte ohne die eigene Verschiebung, sonst schaukelt es sich auf
        const cx = magRect.left + magRect.width / 2 - s.tx;
        const cy = magRect.top + magRect.height / 2 - s.ty;
        ttx = clamp((pointer.x - cx) / (magRect.width / 2), -1, 1) * MAGNET_MAX;
        tty = clamp((pointer.y - cy) / (magRect.height / 2), -1, 1) * MAGNET_MAX;
      }
      const ntx = s.tx + (ttx - s.tx) * k;
      const nty = s.ty + (tty - s.ty) * k;
      const settled = el !== magnetEl && Math.abs(ntx) < 0.03 && Math.abs(nty) < 0.03;
      s.tx = settled ? 0 : ntx;
      s.ty = settled ? 0 : nty;
      el.style.setProperty('--tx', s.tx.toFixed(2) + 'px');
      el.style.setProperty('--ty', s.ty.toFixed(2) + 'px');
      if (settled) pulling.delete(el);
    }

    // Feine Leuchtspur bei schnellen Mausbewegungen
    if (pointer.inside && !pointer.touch && pointer.speed > 900 && !cursor.hidden) {
      const s = pointer.speed;
      pointer.speed *= 0.9;
      if (Math.random() < Math.min(0.9, s / 3000)) spawnTrail(pointer.x, pointer.y);
    } else {
      pointer.speed *= 0.85;
    }
  }

  function moveCursor(node, x, y) {
    node.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) translate(-50%,-50%)';
  }

  function resetElements() {
    for (const el of tilting) {
      const s = stateOf(el);
      s.rx = 0;
      s.ry = 0;
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    }
    for (const el of pulling) {
      const s = stateOf(el);
      s.tx = 0;
      s.ty = 0;
      el.style.setProperty('--tx', '0px');
      el.style.setProperty('--ty', '0px');
    }
    tilting.clear();
    pulling.clear();
    tiltEl = null;
    magnetEl = null;
    pointer.target = null;
    spotEls = [];
    setHover(false);
  }

  // ---------- Hintergrund ----------
  const scene = {
    canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
    n: 0, bx: null, by: null, bz: null, ph: null, inner: null,
    px: null, py: null, pd: null, ps: null, ox: null, oy: null, glow: null, scan: null,
    pairs: null, pairCount: 0, adj: null, buckets: null, counts: new Int32Array(5),
    stars: null, starCount: 0,
    signals: [],
    yaw: 0.6, spin: 0, lookX: 0, lookY: 0,
    gx: 0, gy: 0, R: 100,
    dots: null, starDot: null, hotDot: null, blobs: null,
    gridV: null, gridH: null, horizon: null,
    pulse: null,
  };

  const PALETTE_STEPS = 8;
  const RING_SEG = 72;
  const ringX = new Float32Array(RING_SEG + 1);
  const ringY = new Float32Array(RING_SEG + 1);
  const ringZ = new Float32Array(RING_SEG + 1);

  function ensureSprites() {
    if (scene.dots) return;
    scene.dots = [];
    for (let i = 0; i < PALETTE_STEPS; i++) scene.dots.push(dotSprite(mix(VIOLET, CYAN, i / (PALETTE_STEPS - 1))));
    scene.starDot = dotSprite([225, 232, 255]);
    scene.hotDot = dotSprite([190, 240, 255]);
    scene.blobs = [blobSprite(VIOLET), blobSprite(CYAN), blobSprite([92, 62, 220])];
  }

  function attachCanvas(canvas) {
    let ctx = null;
    try {
      ctx = canvas.getContext('2d');
    } catch (err) {
      ctx = null;
    }
    if (!ctx) return;
    scene.canvas = canvas;
    scene.ctx = ctx;
    canvas.style.pointerEvents = 'none';
    canvas.setAttribute('aria-hidden', 'true');
    ensureSprites();
    resizeScene();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(scheduleResize);
      ro.observe(canvas);
    }
  }

  function pointCountFor(w, h) {
    const t = clamp((w * h - 900 * 600) / (2560 * 1440 - 900 * 600), 0, 1);
    return Math.round(450 + t * 250);
  }

  function resizeScene() {
    const c = scene.canvas;
    if (!c || !scene.ctx) return;
    const w = Math.max(1, c.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, c.clientHeight || window.innerHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    scene.w = w;
    scene.h = h;
    scene.dpr = dpr;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    scene.gx = w * 0.68;
    scene.gy = h * 0.52;
    scene.R = Math.min(w, h) * 0.36;
    const want = pointCountFor(w, h);
    if (!scene.n || Math.abs(want - scene.n) > 40) buildGlobe(want);
    if (!scene.stars) buildStars(150);
    buildGrid();
    if (!isOn()) scene.ctx.clearRect(0, 0, c.width, c.height);
  }

  let resizeTimer = 0;
  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeScene();
      if (overlay.canvas && overlay.parts.length) sizeOverlay();
    }, 120);
  }

  // Punkte auf einer Kugel (Fibonacci-Verteilung) plus einige im Inneren
  function buildGlobe(n) {
    const rnd = seeded(20240611);
    const nIn = Math.round(n * 0.16);
    const nS = n - nIn;
    const bx = new Float32Array(n);
    const by = new Float32Array(n);
    const bz = new Float32Array(n);
    const ph = new Float32Array(n);
    const inner = new Uint8Array(n);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < nS; i++) {
      const y = 1 - ((i + 0.5) / nS) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * golden;
      bx[i] = Math.cos(th) * r;
      by[i] = y;
      bz[i] = Math.sin(th) * r;
      ph[i] = rnd() * TAU;
    }
    for (let i = nS; i < n; i++) {
      let x;
      let y;
      let z;
      let l;
      do {
        x = rnd() * 2 - 1;
        y = rnd() * 2 - 1;
        z = rnd() * 2 - 1;
        l = x * x + y * y + z * z;
      } while (l > 1 || l < 0.01);
      l = Math.sqrt(l);
      const rr = 0.32 + 0.52 * Math.cbrt(rnd());
      bx[i] = (x / l) * rr;
      by[i] = (y / l) * rr;
      bz[i] = (z / l) * rr;
      ph[i] = rnd() * TAU;
      inner[i] = 1;
    }

    // Nachbarn einmal vorab suchen (die nächsten 3, innen 2)
    const spacing = Math.sqrt((4 * Math.PI) / nS);
    const thr2 = Math.pow(spacing * 1.7, 2);
    const seen = new Set();
    const list = [];
    const bestD = new Float32Array(3);
    const bestJ = new Int32Array(3);
    for (let i = 0; i < n; i++) {
      const K = inner[i] ? 2 : 3;
      bestD.fill(Infinity);
      bestJ.fill(-1);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = bx[i] - bx[j];
        const dy = by[i] - by[j];
        const dz = bz[i] - bz[j];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > thr2 || d2 >= bestD[K - 1]) continue;
        let k = K - 1;
        while (k > 0 && bestD[k - 1] > d2) {
          bestD[k] = bestD[k - 1];
          bestJ[k] = bestJ[k - 1];
          k--;
        }
        bestD[k] = d2;
        bestJ[k] = j;
      }
      for (let k = 0; k < K; k++) {
        const j = bestJ[k];
        if (j < 0) continue;
        const a = Math.min(i, j);
        const b = Math.max(i, j);
        const key = a * n + b;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(a, b);
      }
    }
    const pairs = Uint16Array.from(list);
    const pairCount = pairs.length / 2;
    const adj = [];
    for (let i = 0; i < n; i++) adj.push([]);
    for (let q = 0; q < pairCount; q++) {
      adj[pairs[q * 2]].push(q);
      adj[pairs[q * 2 + 1]].push(q);
    }

    Object.assign(scene, {
      n, bx, by, bz, ph, inner, pairs, pairCount, adj,
      px: new Float32Array(n), py: new Float32Array(n), pd: new Float32Array(n), ps: new Float32Array(n),
      ox: new Float32Array(n), oy: new Float32Array(n), glow: new Float32Array(n), scan: new Float32Array(n),
      buckets: [0, 1, 2, 3, 4].map(() => new Uint16Array(pairCount)),
    });
    scene.signals = [];
    for (let s = 0; s < 9; s++) scene.signals.push(newSignal());
  }

  function newSignal() {
    const q = Math.floor(Math.random() * Math.max(1, scene.pairCount));
    return { q, dir: Math.random() < 0.5 ? 0 : 1, t: Math.random(), speed: 1.1 + Math.random() * 1.2, hops: 4 + Math.floor(Math.random() * 6) };
  }

  function buildStars(count) {
    const rnd = seeded(77);
    const st = { x: new Float32Array(count), y: new Float32Array(count), z: new Float32Array(count), s: new Float32Array(count), ph: new Float32Array(count), tw: new Float32Array(count), tint: new Uint8Array(count) };
    for (let i = 0; i < count; i++) {
      st.x[i] = rnd();
      st.y[i] = rnd();
      st.z[i] = 0.15 + Math.pow(rnd(), 1.6) * 0.85;
      st.s[i] = 0.5 + rnd() * 0.9;
      st.ph[i] = rnd() * TAU;
      st.tw[i] = 0.6 + rnd() * 2.2;
      const r = rnd();
      st.tint[i] = r < 0.18 ? 1 : r < 0.32 ? 2 : 0;
    }
    scene.stars = st;
    scene.starCount = count;
  }

  // Gitterboden: Verläufe hängen nur von der Fenstergröße ab
  function buildGrid() {
    const ctx = scene.ctx;
    const { w, h } = scene;
    const y0 = h * 0.74;
    const gv = ctx.createLinearGradient(0, y0, 0, h);
    gv.addColorStop(0, rgb(VIOLET, 0));
    gv.addColorStop(0.45, rgb(VIOLET, 0.35));
    gv.addColorStop(1, rgb([110, 130, 255], 0.75));
    const gh = ctx.createLinearGradient(0, 0, w, 0);
    gh.addColorStop(0, rgb(VIOLET, 0));
    gh.addColorStop(0.3, rgb(VIOLET, 1));
    gh.addColorStop(0.65, rgb(CYAN, 1));
    gh.addColorStop(1, rgb(CYAN, 0));
    const hz = ctx.createLinearGradient(0, 0, w, 0);
    hz.addColorStop(0, rgb(CYAN, 0));
    hz.addColorStop(0.5, rgb(CYAN, 1));
    hz.addColorStop(1, rgb(CYAN, 0));
    scene.gridV = gv;
    scene.gridH = gh;
    scene.horizon = hz;
  }

  function pulseAmount(t) {
    const p = scene.pulse;
    if (!p) return 0;
    const e = (t - p.start) / 1000;
    if (e < 0) return 0;
    if (e >= 1.2) {
      scene.pulse = null;
      return 0;
    }
    if (e < 0.14) return e / 0.14;
    const k = 1 - (e - 0.14) / 1.06;
    return k * k;
  }

  function drawScene(dt, t, ms) {
    const ctx = scene.ctx;
    if (!ctx || !scene.n) return;
    const { w, h, dpr } = scene;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);

    // Wohin die Kugel schaut: Maus, oder kurz ein Fokuspunkt (z. B. Reiter-Wechsel)
    let tx = 0;
    let ty = 0;
    if (focusPt && ms < focusPt.until) {
      tx = clamp((focusPt.x / w) * 2 - 1, -1, 1);
      ty = clamp((focusPt.y / h) * 2 - 1, -1, 1);
    } else if (pointer.inside && !pointer.touch) {
      focusPt = null;
      tx = clamp((pointer.x / w) * 2 - 1, -1, 1);
      ty = clamp((pointer.y / h) * 2 - 1, -1, 1);
    }
    const kl = 1 - Math.exp(-dt * 2.2);
    scene.lookX += (tx - scene.lookX) * kl;
    scene.lookY += (ty - scene.lookY) * kl;

    const p = pulseAmount(ms);
    ctx.globalCompositeOperation = 'lighter';
    drawAurora(ctx, t, p);
    drawStars(ctx, dt, t, p);
    drawGrid(ctx, t, p);
    drawGlobe(ctx, dt, t, p);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  const AURORA = [
    { i: 0, x: 0.16, y: 0.1, r: 0.6, a: 0.2, sp: 0.05, ph: 0.0 },
    { i: 1, x: 0.92, y: 0.88, r: 0.5, a: 0.12, sp: 0.041, ph: 2.1 },
    { i: 2, x: 0.6, y: 0.38, r: 0.42, a: 0.13, sp: 0.033, ph: 4.2 },
  ];

  function drawAurora(ctx, t, p) {
    const { w, h } = scene;
    const m = Math.max(w, h);
    for (let i = 0; i < AURORA.length; i++) {
      const b = AURORA[i];
      const x = (b.x + Math.sin(t * b.sp * TAU * 0.5 + b.ph) * 0.07) * w - scene.lookX * 26;
      const y = (b.y + Math.cos(t * b.sp * TAU * 0.4 + b.ph) * 0.06) * h - scene.lookY * 18;
      const r = b.r * m * (1 + 0.07 * Math.sin(t * b.sp * 4 + b.ph));
      ctx.globalAlpha = b.a * (1 + p * 0.6);
      ctx.drawImage(scene.blobs[b.i], x - r, y - r, r * 2, r * 2);
    }
    // Aufleuchten hinter der Kugel
    if (p > 0.01 && scene.pulse) {
      const r = scene.R * 2.4;
      ctx.globalAlpha = 0.4 * p;
      ctx.drawImage(scene.pulse.blob, scene.gx - r, scene.gy - r, r * 2, r * 2);
    }
  }

  function drawStars(ctx, dt, t, p) {
    const st = scene.stars;
    const { w, h } = scene;
    const lx = scene.lookX * 26;
    const ly = scene.lookY * 16;
    const glowBoost = 1 + p * 0.5;
    for (let i = 0; i < scene.starCount; i++) {
      const z = st.z[i];
      let x = st.x[i] - dt * z * 0.004;
      if (x < -0.02) x += 1.04;
      st.x[i] = x;
      const sx = x * w - lx * z;
      const sy = st.y[i] * h - ly * z;
      const tw = 0.55 + 0.45 * Math.sin(t * st.tw[i] + st.ph[i]);
      const a = (0.18 + 0.62 * z) * tw * glowBoost;
      const size = (0.6 + z * 1.5) * st.s[i];
      ctx.globalAlpha = a > 1 ? 1 : a;
      const spr = st.tint[i] === 1 ? scene.dots[0] : st.tint[i] === 2 ? scene.dots[PALETTE_STEPS - 1] : scene.starDot;
      const e = size * 2.5;
      ctx.drawImage(spr, sx - e, sy - e, e * 2, e * 2);
    }
  }

  // Leicht leuchtender Perspektiv-Boden unten, läuft langsam auf einen zu
  function drawGrid(ctx, t, p) {
    const { w, h } = scene;
    const y0 = h * 0.74;
    const fh = h - y0;
    const vx = w * 0.5 - scene.lookX * 60;
    const base = 0.16 * (1 + p * 0.6);
    // Linien in die Tiefe
    ctx.globalAlpha = base;
    ctx.strokeStyle = scene.gridV;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const spread = w * 0.11;
    for (let k = -16; k <= 16; k++) {
      ctx.moveTo(vx + k * spread * 0.02, y0);
      ctx.lineTo(vx + k * spread * 1.25, h + fh * 0.25);
    }
    ctx.stroke();
    // Querlinien
    ctx.strokeStyle = scene.gridH;
    const scroll = (t * 0.22) % 1;
    for (let k = 0; k < 24; k++) {
      const z = 0.82 + (k + 1 - scroll) * 0.55;
      const y = y0 + fh / z;
      if (y > h + 1) continue;
      const fade = Math.min(1, 1.6 / z) * Math.min(1, (y - y0) / (fh * 0.08));
      ctx.globalAlpha = base * fade * 0.9;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    // Horizont
    ctx.strokeStyle = scene.horizon;
    ctx.globalAlpha = 0.22 * (1 + p);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();
  }

  function drawGlobe(ctx, dt, t, p) {
    const S = scene;
    const n = S.n;
    S.spin *= Math.exp(-dt * 1.3);
    S.yaw += dt * (0.075 + S.spin);
    const yaw = S.yaw + S.lookX * 0.6;
    const pitch = -0.24 + S.lookY * 0.36;
    const cyw = Math.cos(yaw);
    const syw = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const R = S.R * (1 + 0.012 * Math.sin(t * 0.9)) * (1 + p * 0.035);
    const cx = S.gx - S.lookX * 22;
    const cy = S.gy - S.lookY * 14;
    const D = R * 3.2;
    const repel = pointer.inside && !pointer.touch;
    const mx = pointer.x;
    const my = pointer.y;
    const RAD = Math.max(110, R * 0.45);
    const RAD2 = RAD * RAD;
    const PUSH = R * 0.12;
    const k = 1 - Math.exp(-dt * 7);
    const scanY = ((t * 0.14) % 1.6) * 2 - 1.3;
    const { bx, by, bz, ph, px, py, pd, ps, ox, oy, glow, scan, inner } = S;

    // Projektion, Abstoßen von der Maus, Lichtband
    for (let i = 0; i < n; i++) {
      const wob = 1 + 0.022 * Math.sin(by[i] * 5 + t * 1.2 + ph[i] * 0.35);
      const x = bx[i] * wob;
      const y = by[i] * wob;
      const z = bz[i] * wob;
      const x1 = x * cyw + z * syw;
      const z1 = z * cyw - x * syw;
      const y1 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const s = D / (D - z2 * R);
      const sx = cx + x1 * R * s;
      const sy = cy + y1 * R * s;
      let tx = 0;
      let ty = 0;
      let tg = 0;
      if (repel && z2 > -0.25) {
        const dx = sx - mx;
        const dy = sy - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < RAD2) {
          const d = Math.sqrt(d2) || 1;
          const f = 1 - d / RAD;
          tx = (dx / d) * f * f * PUSH;
          ty = (dy / d) * f * f * PUSH;
          tg = f;
        }
      }
      ox[i] += (tx - ox[i]) * k;
      oy[i] += (ty - oy[i]) * k;
      glow[i] += (tg - glow[i]) * k;
      const sc = Math.abs(y1 - scanY);
      scan[i] = sc < 0.1 ? 1 - sc / 0.1 : 0;
      px[i] = sx + ox[i];
      py[i] = sy + oy[i];
      pd[i] = (z2 + 1) * 0.5;
      ps[i] = s;
    }

    const bright = 1 + p * 0.8;
    const pc = S.pulse ? S.pulse.rgb : null;
    const c0 = pc ? mix(VIOLET, pc, p * 0.8) : VIOLET;
    const c1 = pc ? mix(CYAN, pc, p * 0.8) : CYAN;

    // Verbindungslinien, nach Tiefe gebündelt (wenige Zeichenaufrufe)
    const B = S.buckets;
    const cnt = S.counts;
    cnt.fill(0);
    const pairs = S.pairs;
    for (let q = 0; q < S.pairCount; q++) {
      const a = pairs[q * 2];
      const b = pairs[q * 2 + 1];
      const d = (pd[a] + pd[b]) * 0.5;
      if (d < 0.2) continue;
      let bk;
      if (glow[a] + glow[b] > 0.55 || scan[a] + scan[b] > 0.9) bk = 4;
      else bk = d < 0.42 ? 0 : d < 0.6 ? 1 : d < 0.76 ? 2 : 3;
      B[bk][cnt[bk]++] = q;
    }
    const grad = ctx.createLinearGradient(cx - R, cy + R, cx + R, cy - R);
    grad.addColorStop(0, rgb(c0));
    grad.addColorStop(1, rgb(c1));
    const LA = [0.05, 0.1, 0.17, 0.26, 0.5];
    const LW = [0.6, 0.7, 0.8, 0.9, 1];
    for (let bk = 0; bk < 5; bk++) {
      const c = cnt[bk];
      if (!c) continue;
      const arr = B[bk];
      ctx.beginPath();
      for (let m = 0; m < c; m++) {
        const q = arr[m];
        const a = pairs[q * 2];
        const b = pairs[q * 2 + 1];
        ctx.moveTo(px[a], py[a]);
        ctx.lineTo(px[b], py[b]);
      }
      ctx.globalAlpha = Math.min(1, LA[bk] * bright);
      ctx.strokeStyle = bk === 4 ? 'rgb(170,225,255)' : grad;
      ctx.lineWidth = LW[bk];
      ctx.stroke();
    }

    // Punkte
    const dots = S.dots;
    const sizeK = clamp(R / 300, 0.8, 1.35);
    const inv4R = 1 / (4 * R);
    const tintSprite = pc ? S.pulse.dot : null;
    for (let i = 0; i < n; i++) {
      const d = pd[i];
      const g = glow[i];
      let a = (0.1 + 0.9 * d * d) * (inner[i] ? 0.55 : 1) * (1 + g * 1.6 + scan[i] * 0.9) * bright;
      if (a > 1) a = 1;
      if (a < 0.02) continue;
      const size = (0.7 + 1.8 * d) * ps[i] * (inner[i] ? 0.75 : 1) * (1 + g * 0.9) * sizeK;
      let ci = Math.round(((px[i] - cx) - (py[i] - cy)) * inv4R * (PALETTE_STEPS - 1) + (PALETTE_STEPS - 1) * 0.5);
      ci = ci < 0 ? 0 : ci >= PALETTE_STEPS ? PALETTE_STEPS - 1 : ci;
      const e = size * 2.5;
      if (tintSprite && p > 0.02) {
        ctx.globalAlpha = a * (1 - p * 0.7);
        ctx.drawImage(dots[ci], px[i] - e, py[i] - e, e * 2, e * 2);
        ctx.globalAlpha = a * p;
        ctx.drawImage(tintSprite, px[i] - e, py[i] - e, e * 2, e * 2);
      } else {
        ctx.globalAlpha = a;
        ctx.drawImage(g > 0.5 ? S.hotDot : dots[ci], px[i] - e, py[i] - e, e * 2, e * 2);
      }
    }

    drawSignals(ctx, dt, R);
    drawRings(ctx, t, R, cx, cy, D, cyw, syw, cp, sp, p, c1);
  }

  // Lichtimpulse, die über das Netz wandern
  function drawSignals(ctx, dt, R) {
    const S = scene;
    const { px, py, pd, pairs, adj } = S;
    const sizeK = clamp(R / 300, 0.8, 1.35);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgb(200,240,255)';
    for (let i = 0; i < S.signals.length; i++) {
      const sg = S.signals[i];
      sg.t += dt * sg.speed;
      if (sg.t >= 1) {
        const end = pairs[sg.q * 2 + (sg.dir ? 0 : 1)];
        const opts = adj[end];
        sg.hops--;
        if (sg.hops <= 0 || !opts || opts.length < 2) {
          S.signals[i] = newSignal();
          S.signals[i].t = 0;
          continue;
        }
        let next = sg.q;
        for (let tries = 0; tries < 4 && next === sg.q; tries++) next = opts[Math.floor(Math.random() * opts.length)];
        sg.q = next;
        sg.dir = pairs[next * 2] === end ? 0 : 1;
        sg.t = 0;
      }
      const a = pairs[sg.q * 2 + (sg.dir ? 1 : 0)];
      const b = pairs[sg.q * 2 + (sg.dir ? 0 : 1)];
      const d = (pd[a] + pd[b]) * 0.5;
      if (d < 0.5) continue;
      const vis = Math.min(1, (d - 0.5) * 3);
      const x = px[a] + (px[b] - px[a]) * sg.t;
      const y = py[a] + (py[b] - py[a]) * sg.t;
      ctx.globalAlpha = 0.55 * vis;
      ctx.beginPath();
      ctx.moveTo(px[a], py[a]);
      ctx.lineTo(x, y);
      ctx.stroke();
      const e = 2.6 * sizeK * 2.5;
      ctx.globalAlpha = vis;
      ctx.drawImage(S.hotDot, x - e, y - e, e * 2, e * 2);
    }
  }

  // HUD-Ringe: zwei schräge Umlaufbahnen in 3D und feine Skalen-Bögen
  function drawRings(ctx, t, R, cx, cy, D, cyw, syw, cp, sp, p, cAccent) {
    const S = scene;
    const bright = 1 + p * 0.8;
    const accent = rgb(cAccent);
    ctx.strokeStyle = accent;
    ringPath(ctx, R * 1.24, 1.15, 0.32, t * 0.22, R, cx, cy, D, cyw, syw, cp, sp, 0.26 * bright, 0.05, false);
    ringPath(ctx, R * 1.42, 1.38, -0.5, -t * 0.14, R, cx, cy, D, cyw, syw, cp, sp, 0.16 * bright, 0.035, true);

    // Satelliten auf den Ringen
    satellite(ctx, R * 1.24, 1.15, 0.32, t * 0.22 + t * 0.55, R, cx, cy, D, cyw, syw, cp, sp, bright);
    satellite(ctx, R * 1.42, 1.38, -0.5, -t * 0.14 - t * 0.4 + 2, R, cx, cy, D, cyw, syw, cp, sp, bright);

    // Flache Bögen um die Kugel (wie ein Zielsucher)
    const r1 = R * 1.1;
    const rot = t * 0.12;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.2 * bright;
    ctx.beginPath();
    ctx.arc(cx, cy, r1, rot, rot + 0.95);
    ctx.moveTo(cx + Math.cos(rot + 1.35) * r1, cy + Math.sin(rot + 1.35) * r1);
    ctx.arc(cx, cy, r1, rot + 1.35, rot + 1.75);
    ctx.moveTo(cx + Math.cos(rot + 3.3) * r1, cy + Math.sin(rot + 3.3) * r1);
    ctx.arc(cx, cy, r1, rot + 3.3, rot + 4.9);
    ctx.stroke();
    const r2 = R * 1.16;
    const rot2 = -t * 0.05;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.11 * bright;
    ctx.beginPath();
    for (let k = 0; k < 90; k++) {
      const a = rot2 + (k / 90) * TAU;
      const len = k % 15 === 0 ? 9 : k % 5 === 0 ? 5 : 2.5;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.moveTo(cx + ca * r2, cy + sa * r2);
      ctx.lineTo(cx + ca * (r2 + len), cy + sa * (r2 + len));
    }
    ctx.stroke();

    // Antwort-Welle beim Aufleuchten
    if (S.pulse && p > 0.01) {
      const e = clamp((now() - S.pulse.start) / 1200, 0, 1);
      const rr = R * (1.02 + e * 0.75);
      ctx.strokeStyle = rgb(S.pulse.rgb);
      ctx.lineWidth = 2;
      ctx.globalAlpha = (1 - e) * 0.55;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.stroke();
    }
  }

  function ringPoint(a, rr, tiltX, tiltZ, R, cx, cy, D, cyw, syw, cp, sp, out, idx) {
    // Kreis in der Ebene, dann gekippt, dann wie die Kugel gedreht
    const x0 = Math.cos(a) * rr;
    const z0 = Math.sin(a) * rr;
    const cz = Math.cos(tiltZ);
    const sz = Math.sin(tiltZ);
    const xa = x0 * cz;
    const ya = x0 * sz;
    const ctl = Math.cos(tiltX);
    const stl = Math.sin(tiltX);
    const yb = ya * ctl - z0 * stl;
    const zb = ya * stl + z0 * ctl;
    const x1 = xa * cyw + zb * syw;
    const z1 = zb * cyw - xa * syw;
    const y1 = yb * cp - z1 * sp;
    const z2 = yb * sp + z1 * cp;
    const s = D / (D - z2);
    out[0][idx] = cx + x1 * s;
    out[1][idx] = cy + y1 * s;
    out[2][idx] = z2 / R;
  }

  const ringOut = [ringX, ringY, ringZ];
  function ringPath(ctx, rr, tiltX, tiltZ, spin, R, cx, cy, D, cyw, syw, cp, sp, aFront, aBack, dashed) {
    for (let k = 0; k <= RING_SEG; k++) ringPoint((k / RING_SEG) * TAU + spin, rr, tiltX, tiltZ, R, cx, cy, D, cyw, syw, cp, sp, ringOut, k);
    if (dashed) ctx.setLineDash([3, 7]);
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      for (let k = 0; k < RING_SEG; k++) {
        const front = ringZ[k] + ringZ[k + 1] > 0;
        if (front !== (pass === 1)) continue;
        ctx.moveTo(ringX[k], ringY[k]);
        ctx.lineTo(ringX[k + 1], ringY[k + 1]);
      }
      ctx.globalAlpha = pass === 1 ? aFront : aBack;
      ctx.lineWidth = pass === 1 ? 1.1 : 0.8;
      ctx.stroke();
    }
    if (dashed) ctx.setLineDash([]);
  }

  const satOut = [new Float32Array(1), new Float32Array(1), new Float32Array(1)];
  function satellite(ctx, rr, tiltX, tiltZ, a, R, cx, cy, D, cyw, syw, cp, sp, bright) {
    ringPoint(a, rr, tiltX, tiltZ, R, cx, cy, D, cyw, syw, cp, sp, satOut, 0);
    const z = satOut[2][0];
    const vis = clamp(0.25 + z * 0.6, 0.08, 1);
    const e = (2.2 + z * 0.8) * 2.5 * clamp(R / 300, 0.8, 1.35);
    ctx.globalAlpha = Math.min(1, vis * bright);
    ctx.drawImage(scene.hotDot, satOut[0][0] - e, satOut[1][0] - e, e * 2, e * 2);
  }

  // ---------- Partikel-Ebene (Funken, Konfetti) ----------
  const overlay = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1, parts: [], visible: false, partyUntil: 0, nextEmit: 0, rockets: [] };
  const SPARK = 1;
  const CONFETTI = 2;
  const RING = 3;
  const ROCKET = 4;
  const TRAIL = 5;

  function ensureOverlay() {
    if (overlay.canvas) return true;
    const host = document.body || document.documentElement;
    if (!host) return false;
    const c = document.createElement('canvas');
    c.className = 'fx-overlay';
    c.setAttribute('aria-hidden', 'true');
    const st = c.style;
    st.position = 'fixed';
    st.left = '0';
    st.top = '0';
    st.right = '0';
    st.bottom = '0';
    st.width = '100%';
    st.height = '100%';
    st.pointerEvents = 'none';
    st.zIndex = '9000';
    st.display = 'none';
    host.appendChild(c);
    overlay.canvas = c;
    overlay.ctx = c.getContext('2d');
    if (!overlay.ctx) {
      c.remove();
      overlay.canvas = null;
      return false;
    }
    sizeOverlay();
    return true;
  }

  function sizeOverlay() {
    const w = Math.max(1, window.innerWidth || 1);
    const h = Math.max(1, window.innerHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    overlay.w = w;
    overlay.h = h;
    overlay.dpr = dpr;
    const cw = Math.round(w * dpr);
    const ch = Math.round(h * dpr);
    if (overlay.canvas.width !== cw) overlay.canvas.width = cw;
    if (overlay.canvas.height !== ch) overlay.canvas.height = ch;
  }

  function showOverlay() {
    if (overlay.visible) return;
    overlay.visible = true;
    if (overlay.w !== window.innerWidth || overlay.h !== window.innerHeight) sizeOverlay();
    overlay.canvas.style.display = 'block';
  }

  function hideOverlay() {
    if (!overlay.canvas) return;
    overlay.visible = false;
    overlay.ctx.setTransform(1, 0, 0, 1, 0, 0);
    overlay.ctx.clearRect(0, 0, overlay.canvas.width, overlay.canvas.height);
    overlay.canvas.style.display = 'none';
  }

  function addPart(q) {
    if (overlay.parts.length >= MAX_PARTS) return;
    overlay.parts.push(q);
  }

  function makeSpark(x, y, vx, vy, colorStr, life, size, drag, grav) {
    const c = parseRgb(colorStr);
    return {
      type: SPARK, x, y, vx, vy, age: 0, life, size, drag, g: grav,
      col: rgb(c), sprite: spriteFor(colorStr, c), rot: 0, vr: 0, flip: 0, vf: 0,
    };
  }

  function spawnBurst(x, y, count, colors, scale, ring) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = (110 + Math.pow(Math.random(), 0.7) * 330) * scale;
      const col = colors[i % colors.length];
      addPart(makeSpark(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 60 * scale, col,
        0.65 + Math.random() * 0.35, (1.1 + Math.random() * 1.6) * (0.8 + scale * 0.25), 2.2, 520));
    }
    if (ring) {
      addPart({ type: RING, x, y, vx: 0, vy: 0, age: 0, life: 0.55, size: 14 * scale, r1: 70 * scale, col: rgb(parseRgb(colors[1 % colors.length])) });
    }
  }

  function spawnTrail(x, y) {
    if (!ensureOverlay()) return;
    const col = Math.random() < 0.5 ? '124,108,255' : '34,211,238';
    const a = Math.random() * TAU;
    const q = makeSpark(x, y, Math.cos(a) * 24, Math.sin(a) * 24, col, 0.45 + Math.random() * 0.2, 0.9 + Math.random() * 0.8, 3, 0);
    q.type = TRAIL;
    addPart(q);
  }

  function spawnConfetti(x, y, angle, speed) {
    const colStr = PARTY_COLORS[Math.floor(Math.random() * PARTY_COLORS.length)];
    addPart({
      type: CONFETTI, x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      age: 0, life: 2.4 + Math.random() * 1.2, size: 5 + Math.random() * 5, drag: 1.5, g: 820,
      col: rgb(parseRgb(colStr)), rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 14,
      flip: Math.random() * TAU, vf: 6 + Math.random() * 10,
    });
  }

  function spawnRocket(fromLeft) {
    const { w, h } = overlay;
    const x = fromLeft ? w * (0.04 + Math.random() * 0.08) : w * (0.88 + Math.random() * 0.08);
    const tx = fromLeft ? w * (0.25 + Math.random() * 0.25) : w * (0.5 + Math.random() * 0.25);
    const ty = h * (0.16 + Math.random() * 0.2);
    const T = 0.85 + Math.random() * 0.25;
    const g = 600;
    addPart({
      type: ROCKET, x, y: h + 6, vx: (tx - x) / T, vy: -((h - ty) / T + 0.5 * g * T),
      age: 0, life: T, size: 2.2, drag: 0, g, col: 'rgb(255,255,255)',
      colors: [PARTY_COLORS[Math.floor(Math.random() * 2)], PARTY_COLORS[2 + Math.floor(Math.random() * 4)], '255,255,255'],
    });
  }

  // Nachschub während FX.celebrate läuft: Fontänen aus beiden unteren Ecken
  function emitParty(ms) {
    if (ms < overlay.nextEmit) return;
    overlay.nextEmit = ms + 45;
    const { w, h } = overlay;
    const power = clamp(h / 800, 0.75, 1.4);
    for (let side = 0; side < 2; side++) {
      const left = side === 0;
      const x = left ? -4 : w + 4;
      const y = h + 4;
      for (let i = 0; i < 4; i++) {
        const spread = 0.12 + Math.random() * 0.5;
        const a = -Math.PI / 2 + (left ? spread : -spread);
        spawnConfetti(x, y, a, (900 + Math.random() * 650) * power);
      }
      for (let i = 0; i < 2; i++) {
        const spread = 0.15 + Math.random() * 0.45;
        const a = -Math.PI / 2 + (left ? spread : -spread);
        const sp = (850 + Math.random() * 700) * power;
        const col = PARTY_COLORS[Math.floor(Math.random() * PARTY_COLORS.length)];
        addPart(makeSpark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, col, 0.9 + Math.random() * 0.5, 1.4 + Math.random() * 1.4, 1.6, 700));
      }
    }
    while (overlay.rockets.length && ms >= overlay.rockets[0].at) {
      spawnRocket(overlay.rockets.shift().left);
    }
  }

  function stepOverlay(dt, ms) {
    if (!overlay.canvas) return;
    if (ms < overlay.partyUntil) emitParty(ms);
    else overlay.rockets.length = 0;
    const parts = overlay.parts;
    if (!parts.length) {
      if (overlay.visible) hideOverlay();
      return;
    }
    showOverlay();
    const ctx = overlay.ctx;
    const dpr = overlay.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, overlay.w, overlay.h);

    // Bewegen und Abgelaufenes entfernen
    let j = 0;
    for (let i = 0; i < parts.length; i++) {
      const q = parts[i];
      q.age += dt;
      if (q.type === ROCKET) {
        if (q.age >= q.life || q.vy > -40) {
          spawnBurst(q.x, q.y, 46, q.colors, 1.25, true);
          continue;
        }
        if (Math.random() < 0.8) addPart(makeSpark(q.x, q.y, (Math.random() - 0.5) * 40, 40 + Math.random() * 40, '255,220,180', 0.35, 1, 3, 200));
      } else if (q.age >= q.life) {
        continue;
      }
      if (q.drag) {
        const f = Math.exp(-q.drag * dt);
        q.vx *= f;
        q.vy *= f;
      }
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.type === CONFETTI) {
        q.rot += q.vr * dt;
        q.flip += q.vf * dt;
        q.x += Math.sin(q.flip * 0.5) * 18 * dt;
      }
      parts[j++] = q;
    }
    parts.length = j;

    // Konfetti (deckend)
    for (let i = 0; i < j; i++) {
      const q = parts[i];
      if (q.type !== CONFETTI) continue;
      const k = q.age / q.life;
      ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      const cr = Math.cos(q.rot);
      const sr = Math.sin(q.rot);
      const fy = Math.cos(q.flip);
      ctx.setTransform(cr * dpr, sr * dpr, -sr * fy * dpr, cr * fy * dpr, q.x * dpr, q.y * dpr);
      ctx.fillStyle = q.col;
      ctx.fillRect(-q.size / 2, -q.size * 0.3, q.size, q.size * 0.6);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Leuchtendes (addiert sich)
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < j; i++) {
      const q = parts[i];
      if (q.type === CONFETTI) continue;
      const k = 1 - q.age / q.life;
      if (q.type === RING) {
        const e = 1 - k;
        const r = q.size + (q.r1 - q.size) * (1 - (1 - e) * (1 - e));
        ctx.globalAlpha = k * 0.7;
        ctx.strokeStyle = q.col;
        ctx.lineWidth = 1.5 * k + 0.5;
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, TAU);
        ctx.stroke();
        continue;
      }
      if (q.type === ROCKET) {
        ctx.globalAlpha = 1;
        const e = 7;
        ctx.drawImage(scene.hotDot || spriteFor('255,255,255', [255, 255, 255]), q.x - e, q.y - e, e * 2, e * 2);
        continue;
      }
      const a = q.type === TRAIL ? k * k * 0.55 : Math.pow(k, 1.4);
      if (q.type === SPARK) {
        ctx.globalAlpha = a * 0.9;
        ctx.strokeStyle = q.col;
        ctx.lineWidth = q.size * 0.7;
        ctx.beginPath();
        ctx.moveTo(q.x - q.vx * 0.035, q.y - q.vy * 0.035);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
      ctx.globalAlpha = a;
      const e = q.size * 2.5 * (q.type === TRAIL ? 1 : 1.3);
      ctx.drawImage(q.sprite, q.x - e, q.y - e, e * 2, e * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ---------- Hauptschleife ----------
  function start() {
    if (rafId || !initialized || document.hidden) return;
    attachCursor();
    lastTime = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function frame(ms) {
    rafId = 0;
    if (!isOn() || !initialized || document.hidden) return;
    rafId = requestAnimationFrame(frame);
    // Fenster ohne Fokus: nur ~30 Bilder pro Sekunde
    if (!windowFocused && lastTime && ms - lastTime < 31) return;
    const dt = lastTime ? clamp((ms - lastTime) / 1000, 0, 0.05) : 1 / 60;
    lastTime = ms;
    clock += dt;
    updateUi(dt);
    drawScene(dt, clock, ms);
    stepOverlay(dt, ms);
  }

  function applyState() {
    const on = isOn();
    document.documentElement.classList.toggle('fx-off', !on);
    if (!initialized) return;
    if (on) {
      start();
    } else {
      stop();
      if (scene.ctx) {
        scene.ctx.setTransform(1, 0, 0, 1, 0, 0);
        scene.ctx.clearRect(0, 0, scene.canvas.width, scene.canvas.height);
      }
      overlay.parts.length = 0;
      overlay.partyUntil = 0;
      overlay.rockets.length = 0;
      hideOverlay();
      detachCursor();
      resetElements();
      scene.pulse = null;
      focusPt = null;
    }
  }

  // ---------- Öffentliche Schnittstelle ----------
  function init(opts) {
    const canvas = opts && opts.canvas;
    if (canvas && canvas !== scene.canvas && typeof canvas.getContext === 'function') attachCanvas(canvas);
    if (initialized) {
      applyState();
      return;
    }
    initialized = true;
    windowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

    const passive = { passive: true };
    document.addEventListener('pointermove', onPointerMove, passive);
    document.addEventListener('pointerdown', onPointerDown, passive);
    document.addEventListener('pointerout', onPointerOut, passive);
    document.addEventListener('click', onClick, { passive: true, capture: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', scheduleResize, passive);
    window.addEventListener('blur', () => {
      windowFocused = false;
    }, passive);
    window.addEventListener('focus', () => {
      windowFocused = true;
    }, passive);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (isOn()) start();
    }, passive);
    if (mql) {
      const onChange = (e) => {
        reduceMotion = e.matches;
        applyState();
      };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);
    }
    applyState();
  }

  function setEnabled(on, opts) {
    on = Boolean(on);
    // Bei "Bewegung reduzieren" nur mit { force: true } einschalten
    if (on && reduceMotion && !(opts && opts.force)) {
      applyState();
      return isOn();
    }
    wanted = on;
    forced = on && Boolean(opts && opts.force);
    applyState();
    return isOn();
  }

  // Einblenden einer frisch gezeichneten Seite (Stufen-Verzögerung per CSS-Variable)
  function onEnterEnd(e) {
    if (e.target !== this) return;
    this.classList.remove('fx-enter');
    this.removeEventListener('animationend', onEnterEnd);
  }

  function pageEnter(container) {
    if (!isOn() || !container || typeof container.querySelectorAll !== 'function') return;
    const nodes = container.querySelectorAll(SEL_ENTER);
    const list = [];
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.classList.contains('fx-enter')) continue;
      el.style.setProperty('--fx-delay', Math.min(list.length * 40, 600) + 'ms');
      el.classList.add('fx-enter');
      el.addEventListener('animationend', onEnterEnd);
      list.push(el);
    }
    if (!list.length) return;
    // Falls keine Animation läuft (z. B. CSS fehlt), Klasse trotzdem wieder entfernen
    setTimeout(() => {
      for (const el of list) {
        el.classList.remove('fx-enter');
        el.removeEventListener('animationend', onEnterEnd);
      }
    }, Math.min(list.length * 40, 600) + 1800);
    scene.spin += 0.55; // kleiner Schwung für die Kugel
  }

  function burst(x, y, opts) {
    if (!isOn() || !initialized || !ensureOverlay()) return;
    const o = opts || {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      x = window.innerWidth / 2;
      y = window.innerHeight / 2;
    }
    const colors = Array.isArray(o.colors) && o.colors.length ? o.colors.map(String) : BURST_COLORS;
    const count = clamp(Math.round(Number(o.count) || 40), 1, 300);
    const small = o.small || count < 25;
    spawnBurst(x, y, count, colors, small ? 0.6 : 1, true);
    showOverlay();
    start();
  }

  function celebrate() {
    if (!isOn() || !initialized || !ensureOverlay()) return;
    sizeOverlay();
    const ms = now();
    overlay.partyUntil = ms + 2000;
    overlay.nextEmit = 0;
    overlay.rockets = [
      { at: ms + 80, left: true }, { at: ms + 380, left: false }, { at: ms + 760, left: true },
      { at: ms + 1100, left: false }, { at: ms + 1450, left: true }, { at: ms + 1700, left: false },
    ];
    pulse('success');
    showOverlay();
    start();
  }

  function pulse(kind) {
    if (!isOn() || !scene.dots) return;
    const c = PULSE_RGB[kind] || PULSE_RGB.info;
    const key = 'pulse:' + c.join(',');
    let blob = spriteCache.get(key);
    if (!blob) {
      blob = blobSprite(c);
      spriteCache.set(key, blob);
    }
    scene.pulse = { rgb: c, start: now(), dot: spriteFor(c.join(','), c), blob };
  }

  function focusPoint(x, y) {
    if (!isOn() || !Number.isFinite(x) || !Number.isFinite(y)) return;
    focusPt = { x, y, until: now() + 1400 };
    scene.spin += 0.25;
  }

  document.documentElement.classList.toggle('fx-off', !isOn());

  window.FX = Object.freeze({
    init,
    setEnabled,
    enabled: isOn,
    pageEnter,
    burst,
    celebrate,
    pulse,
    focusPoint,
  });
})();
