/* Jarvis' Kugel: eine lebendige, flüssige Form statt eines einfachen Kreises.

   Innen fließt Licht in mehreren Blau- und Violetttönen, die Form selbst atmet und verformt sich
   langsam wie ein Tropfen. Hinter ihr liegen farbige Lichtschleier: Hört Jarvis zu oder spricht er,
   blühen sie mit der Stimme auf und die Form wellt sich. Beim Nachdenken kreisen die Schleier.

   Gemeinsam für Hauptfenster, Einrichtung und Handy-App (handy/orb.js ist eine Kopie, ein Test
   hält beide gleich). Zeichnet nur, wenn die Kugel zu sehen ist.

   const orb = JarvisOrb.create(canvas, { mode: 'hero' | 'mark', visible: () => true });
   orb.state('listening'); orb.level(0.6); orb.pulse(); orb.boot();
*/
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const mixc = (x, y, k) => [lerp(x[0], y[0], k), lerp(x[1], y[1], k), lerp(x[2], y[2], k)];
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motionQuery && motionQuery.matches);

  // Farben je Zustand (tief, mitte, hell und zwei Nebenfarben für Licht und Schleier) und wie lebhaft:
  // shape = wie stark die Form atmet, ripple = wie stark sie mit der Stimme wellt, speed = Tempo des Lichts,
  // spin = wie schnell die Schleier kreisen, halo = Leuchten, aura = Stärke der farbigen Schleier
  const LOOKS = {
    idle: {
      deep: [16, 22, 84], mid: [62, 92, 255], light: [196, 206, 255], hueA: [138, 92, 255], hueB: [48, 182, 255],
      shape: 0.085, ripple: 0.06, speed: 0.45, spin: 0.16, halo: 0.18, aura: 0.85,
    },
    listening: {
      deep: [12, 34, 104], mid: [52, 128, 255], light: [204, 236, 255], hueA: [104, 112, 255], hueB: [40, 214, 255],
      shape: 0.065, ripple: 0.085, speed: 0.85, spin: 0.25, halo: 0.28, aura: 0.85,
    },
    thinking: {
      deep: [26, 16, 92], mid: [98, 84, 255], light: [214, 204, 255], hueA: [170, 96, 255], hueB: [72, 148, 255],
      shape: 0.065, ripple: 0.03, speed: 1.2, spin: 1.1, halo: 0.22, aura: 0.8,
    },
    speaking: {
      deep: [16, 24, 100], mid: [70, 104, 255], light: [204, 214, 255], hueA: [146, 98, 255], hueB: [52, 192, 255],
      shape: 0.06, ripple: 0.1, speed: 0.95, spin: 0.3, halo: 0.3, aura: 0.9,
    },
    muted: {
      deep: [26, 28, 36], mid: [80, 85, 98], light: [150, 154, 166], hueA: [96, 100, 114], hueB: [90, 98, 112],
      shape: 0.012, ripple: 0, speed: 0.12, spin: 0.03, halo: 0.03, aura: 0.08,
    },
    error: {
      deep: [86, 18, 28], mid: [226, 84, 84], light: [255, 204, 198], hueA: [255, 120, 104], hueB: [214, 70, 128],
      shape: 0.05, ripple: 0.05, speed: 0.6, spin: 0.2, halo: 0.24, aura: 0.6,
    },
  };
  const COLORS = ['deep', 'mid', 'light', 'hueA', 'hueB'];
  const NUMBERS = ['shape', 'ripple', 'speed', 'spin', 'halo', 'aura'];

  // Der Körper: eine Form, die sich langsam und weich verformt (nur sanfte Wellen, keine Zacken)
  const BODY = { scale: 1, amp: 1, voice: 1, p: [0.0, 1.9, 4.1], dir: 1 };
  // Farbige Schleier hinter dem Körper: Farbe, Abstand vom Mittelpunkt, Größe, Richtung
  const VEILS = [
    { color: 'hueA', dist: 0.26, size: 1.36, phase: 0.0, dir: 1 },
    { color: 'hueB', dist: 0.28, size: 1.3, phase: 2.1, dir: 1 },
    { color: 'mid', dist: 0.18, size: 1.45, phase: 4.2, dir: -1 },
  ];
  // Lichtflecken im Inneren (Lissajous-Bahnen): Farbe, Größe, Tempo
  const SPOTS = [
    { color: 'hueB', r: 0.46, fx: 0.71, fy: 0.53, px: 0.0, py: 1.7, a: 0.8 },
    { color: 'hueA', r: 0.5, fx: 0.43, fy: 0.89, px: 2.1, py: 0.4, a: 0.85 },
    { color: 'mid', r: 0.55, fx: 0.97, fy: 0.61, px: 4.2, py: 3.3, a: 0.7 },
    { color: 'light', r: 0.26, fx: 0.57, fy: 0.37, px: 5.1, py: 2.2, a: 0.55 },
  ];

  function create(canvas, options) {
    if (!canvas || !canvas.getContext) return null;
    const opts = Object.assign({ mode: 'hero', visible: null }, options || {});
    const hero = opts.mode !== 'mark';
    const ctx = canvas.getContext('2d');
    // Licht und Schleier entstehen klein und werden groß gezogen: so werden sie weich wie ein Farbverlauf
    const L = hero ? 72 : 32;
    const liquid = document.createElement('canvas');
    liquid.width = L;
    liquid.height = L;
    const lctx = liquid.getContext('2d');
    const A = 96;
    const veil = hero ? document.createElement('canvas') : null;
    const vctx = veil ? veil.getContext('2d') : null;
    if (veil) {
      veil.width = A;
      veil.height = A;
    }
    const POINTS = hero ? 96 : 40;
    const pts = new Float32Array(POINTS * 2);

    const look = {};
    for (const key of COLORS) look[key] = LOOKS.idle[key].slice();
    for (const key of NUMBERS) look[key] = LOOKS.idle[key];
    let target = LOOKS.idle;
    let current = 'idle';
    let w = 0;
    let h = 0;
    let dpr = 1;
    let t = 0;
    let flow = 0;
    let spin = 0;
    let last = 0;
    let level = 0;
    let levelTarget = 0;
    let levelAt = 0;
    let bootT = hero ? 0 : 1;
    let pulseT = -10;
    let running = true;

    function resize() {
      // Layout-Größe ohne Transformationen (beim Einblenden ist die Kugel kurz skaliert)
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      w = Math.max(1, canvas.clientWidth);
      h = Math.max(1, canvas.clientHeight);
      const cw = Math.round(w * dpr);
      const ch = Math.round(h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    }

    function visible() {
      if (document.hidden || canvas.offsetParent === null) return false;
      return typeof opts.visible === 'function' ? !!opts.visible() : true;
    }

    // Radius der Form bei Winkel th (1 = Kreis): langsame, weiche Wellen, mit der Stimme etwas mehr
    function radius(th) {
      const a = look.shape * (0.8 + 0.2 * Math.sin(t * 0.37));
      const v = look.ripple * level;
      const x = th + spin * 0.35;
      // Die Stimme verstärkt dieselben weichen Wellen und macht sie schneller: die Form wabbelt wie ein
      // Tropfen, statt Ecken zu bekommen. Nur eine kleine schnelle Welle gibt ihr etwas Struktur.
      return 1
        + a * (0.6 * Math.sin(2 * x + t * 0.8) + 0.4 * Math.sin(3 * x - t * 0.6 + 1.9))
        + v * (0.55 * Math.sin(2 * x - t * 2.6 + 4.1) + 0.45 * Math.sin(3 * x + t * 3.3 + 0.7)
          + 0.2 * Math.sin(5 * x - t * 4.4 + 2.2));
    }

    function trace(R) {
      for (let i = 0; i < POINTS; i += 1) {
        const th = (i / POINTS) * TAU;
        const r = R * radius(th);
        pts[i * 2] = Math.cos(th) * r;
        pts[i * 2 + 1] = Math.sin(th) * r;
      }
      // Glatte Kurve durch die Mitten zwischen den Punkten
      const n = POINTS;
      ctx.beginPath();
      ctx.moveTo((pts[(n - 1) * 2] + pts[0]) / 2, (pts[(n - 1) * 2 + 1] + pts[1]) / 2);
      for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        ctx.quadraticCurveTo(pts[i * 2], pts[i * 2 + 1], (pts[i * 2] + pts[j * 2]) / 2, (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2);
      }
      ctx.closePath();
    }

    // Farbige Schleier hinter der Form: kreisen langsam, blühen mit der Stimme auf
    function paintVeils(rb) {
      const c = A / 2;
      vctx.globalCompositeOperation = 'source-over';
      vctx.clearRect(0, 0, A, A);
      vctx.globalCompositeOperation = 'lighter';
      VEILS.forEach((v, i) => {
        const ang = spin * v.dir + v.phase;
        const d = rb * (v.dist + level * 0.12 + 0.04 * Math.sin(t * 0.7 + i * 2.3));
        const x = c + Math.cos(ang) * d;
        const y = c + Math.sin(ang) * d;
        const r = rb * (v.size + level * 0.42 + 0.05 * Math.sin(t * 0.9 + i * 1.7));
        const g = vctx.createRadialGradient(x, y, r * 0.35, x, y, r);
        const a = look.aura * (0.44 + level * 0.3);
        g.addColorStop(0, rgba(look[v.color], a));
        g.addColorStop(1, rgba(look[v.color], 0));
        vctx.fillStyle = g;
        vctx.fillRect(0, 0, A, A);
      });
      // Weich und rund ausblenden, damit nie eine eckige Kante zu sehen ist
      vctx.globalCompositeOperation = 'destination-in';
      const fade = vctx.createRadialGradient(c, c, c * 0.62, c, c, c);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      vctx.fillStyle = fade;
      vctx.fillRect(0, 0, A, A);
      vctx.globalCompositeOperation = 'source-over';
    }

    function paintLiquid() {
      const c = L / 2;
      lctx.globalCompositeOperation = 'source-over';
      const base = lctx.createRadialGradient(c * 0.75, c * 0.65, 0, c, c, c * 1.15);
      base.addColorStop(0, rgba(look.mid, 1));
      base.addColorStop(1, rgba(look.deep, 1));
      lctx.fillStyle = base;
      lctx.fillRect(0, 0, L, L);
      lctx.globalCompositeOperation = 'screen';
      const reach = 0.34 + look.speed * 0.08 + level * 0.12;
      for (const s of SPOTS) {
        const x = c + Math.cos(flow * s.fx + s.px) * c * reach;
        const y = c + Math.sin(flow * s.fy + s.py) * c * reach;
        const r = c * s.r * 2 * (1 + level * 0.2);
        const g = lctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(look[s.color], s.a));
        g.addColorStop(1, rgba(look[s.color], 0));
        lctx.fillStyle = g;
        lctx.fillRect(0, 0, L, L);
      }
      // Ein dunkler Fleck wandert gegenläufig: Tiefe statt einer gleichmäßig hellen Fläche
      lctx.globalCompositeOperation = 'multiply';
      const dx = c + Math.cos(-flow * 0.47 + 1.3) * c * 0.45;
      const dy = c + Math.sin(-flow * 0.63 + 0.2) * c * 0.45;
      const dark = lctx.createRadialGradient(dx, dy, 0, dx, dy, c * 0.8);
      dark.addColorStop(0, rgba(look.deep, 0.24));
      dark.addColorStop(1, 'rgba(255,255,255,0)');
      lctx.fillStyle = dark;
      lctx.fillRect(0, 0, L, L);
      lctx.globalCompositeOperation = 'source-over';
    }

    function draw() {
      const S = Math.min(canvas.width, canvas.height);
      if (S < 8) return;
      const ease = 1 - Math.pow(1 - bootT, 3);
      const click = t - pulseT < 0.5 ? Math.sin(((t - pulseT) / 0.5) * Math.PI) * 0.06 : 0;
      const breath = Math.sin(t * 1.1) * 0.014;
      const R = S * (hero ? 0.29 : 0.4) * (0.9 + 0.1 * ease) * (1 + breath + click + level * 0.05);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.globalAlpha = ease;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Leuchten und farbige Schleier hinter der Form
      if (hero) {
        const span = Math.min(R * 1.9, S * 0.5);
        const halo = ctx.createRadialGradient(0, 0, R * 0.6, 0, 0, span);
        halo.addColorStop(0, rgba(look.mid, look.halo * (0.8 + level * 0.8)));
        halo.addColorStop(1, rgba(look.mid, 0));
        ctx.fillStyle = halo;
        ctx.fillRect(-span, -span, span * 2, span * 2);
        paintVeils((A / 2) * (R / span));
        ctx.drawImage(veil, -span, -span, span * 2, span * 2);
      }

      // Der Körper: fließendes Licht in der lebendigen Form
      paintLiquid();
      ctx.save();
      trace(R);
      ctx.clip();
      const span = R * 1.3;
      ctx.drawImage(liquid, -span, -span, span * 2, span * 2);
      // Tiefe am Rand, Glanz oben links: wirkt wie Glas
      const shade = ctx.createRadialGradient(-R * 0.2, -R * 0.25, R * 0.35, 0, 0, R * 1.2);
      shade.addColorStop(0, 'rgba(4,6,16,0)');
      shade.addColorStop(1, 'rgba(4,6,16,0.36)');
      ctx.fillStyle = shade;
      ctx.fillRect(-span, -span, span * 2, span * 2);
      const gx = -R * 0.3 + Math.cos(t * 0.3) * R * 0.04;
      const gy = -R * 0.38 + Math.sin(t * 0.4) * R * 0.03;
      const gloss = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.55);
      gloss.addColorStop(0, 'rgba(255,255,255,0.3)');
      gloss.addColorStop(0.55, 'rgba(255,255,255,0.06)');
      gloss.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gloss;
      ctx.fillRect(-span, -span, span * 2, span * 2);
      // Licht, das durch das Glas fällt: ein heller Schimmer innen am unteren Rand
      const cx = R * 0.3;
      const cy = R * 0.62;
      const caustic = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.62);
      caustic.addColorStop(0, rgba(look.light, 0.2 + level * 0.12));
      caustic.addColorStop(1, rgba(look.light, 0));
      ctx.fillStyle = caustic;
      ctx.fillRect(-span, -span, span * 2, span * 2);
      // Kleiner, scharfer Glanzpunkt
      if (hero) {
        const sx = gx - R * 0.06;
        const sy = gy - R * 0.04;
        const spec = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.14);
        spec.addColorStop(0, 'rgba(255,255,255,0.36)');
        spec.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = spec;
        ctx.fillRect(sx - R * 0.14, sy - R * 0.14, R * 0.28, R * 0.28);
      }
      ctx.restore();

      // Lichtkante: oben links hell, unten rechts fast unsichtbar
      trace(R);
      const rim = ctx.createLinearGradient(-R, -R, R, R);
      rim.addColorStop(0, 'rgba(255,255,255,0.4)');
      rim.addColorStop(0.5, 'rgba(255,255,255,0.06)');
      rim.addColorStop(1, rgba(look.light, 0.18));
      ctx.strokeStyle = rim;
      ctx.lineWidth = (hero ? 1.2 : 0.8) * dpr;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function frame(now) {
      if (!running) return;
      if (!visible()) {
        last = now;
        setTimeout(() => requestAnimationFrame(frame), 250);
        return;
      }
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      const slow = reduced() ? 0.25 : 1;
      t += dt * slow;
      bootT = Math.min(1, bootT + dt / 1.1);
      const k = Math.min(1, dt * 3.2);
      for (const key of COLORS) look[key] = mixc(look[key], target[key], k);
      for (const key of NUMBERS) look[key] = lerp(look[key], target[key], k);
      // Pegel: schnell rauf, langsam runter; nach 300 ms ohne Meldung klingt er ab
      const want = performance.now() - levelAt > 300 ? 0 : levelTarget;
      level += (want - level) * Math.min(1, dt * (want > level ? 14 : 4));
      flow += dt * look.speed * slow * (1 + level * 0.8);
      spin += dt * look.spin * slow;
      draw();
      // Ruhig reichen 30 Bilder pro Sekunde (die kleine Marke 20), sonst flüssig
      const calm = (current === 'idle' || current === 'muted') && level < 0.02;
      if (!hero) setTimeout(() => requestAnimationFrame(frame), 50);
      else if (calm || reduced()) setTimeout(() => requestAnimationFrame(frame), 33);
      else requestAnimationFrame(frame);
    }

    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener('resize', resize);
    requestAnimationFrame(frame);

    return {
      state(name) {
        current = LOOKS[name] ? name : 'idle';
        target = LOOKS[current];
      },
      level(v) {
        levelTarget = clamp(Number(v) || 0, 0, 1);
        levelAt = performance.now();
      },
      pulse() {
        pulseT = t;
      },
      boot() {
        bootT = 0;
      },
      resize,
      stop() {
        running = false;
      },
    };
  }

  window.JarvisOrb = { create, LOOKS };
})();
