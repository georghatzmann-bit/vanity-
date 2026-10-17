// PLACEHOLDER FX engine (2D canvas). The WebGL engine replaces this file later; keep the API:
//   createFx(canvas, { quality }) -> { setState, setProgress, pulse, burst, setQuality, dispose }
// Draws a slow violet aurora with drifting dust, energy pulses and particle bursts.

const STATES = {
  boot: { energy: 0.45, speed: 0.5, bloom: 0.7, tint: [139, 92, 246] },
  idle: { energy: 0.7, speed: 0.7, bloom: 0.85, tint: [139, 92, 246] },
  home: { energy: 0.8, speed: 0.8, bloom: 1, tint: [139, 92, 246] },
  scan: { energy: 1.05, speed: 1.6, bloom: 1.15, tint: [150, 110, 255] },
  installing: { energy: 1.15, speed: 1.9, bloom: 1.2, tint: [160, 120, 255] },
  success: { energy: 1.3, speed: 1.1, bloom: 1.45, tint: [196, 181, 253] },
  error: { energy: 0.65, speed: 0.6, bloom: 0.8, tint: [230, 90, 110] },
};

const QUALITY = {
  ultra: { scale: 0.5, dust: 150 },
  high: { scale: 0.42, dust: 100 },
  low: { scale: 0.3, dust: 40 },
  off: { scale: 0.3, dust: 0 },
};

const BLOBS = [
  { color: [139, 92, 246], r: 0.62, ax: 0.32, ay: 0.22, fx: 0.07, fy: 0.05, ph: 0.0, a: 0.55, cx: 0.32, cy: 0.38 },
  { color: [109, 40, 217], r: 0.75, ax: 0.28, ay: 0.2, fx: 0.05, fy: 0.08, ph: 2.1, a: 0.6, cx: 0.72, cy: 0.62 },
  { color: [76, 29, 149], r: 0.9, ax: 0.2, ay: 0.16, fx: 0.04, fy: 0.03, ph: 4.2, a: 0.5, cx: 0.5, cy: 0.95 },
  { color: [196, 181, 253], r: 0.35, ax: 0.3, ay: 0.18, fx: 0.09, fy: 0.06, ph: 1.3, a: 0.16, cx: 0.6, cy: 0.3 },
];

const lerp = (a, b, t) => a + (b - a) * t;

export function createFx(canvas, opts = {}) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let quality = QUALITY[opts.quality] ? opts.quality : 'high';
  let target = { ...STATES.idle };
  const cur = { ...STATES.idle, tint: [...STATES.idle.tint] };
  let progress = 0;
  let progressShown = 0;
  let pulseAmt = 0;
  let w = 0;
  let h = 0;
  let raf = 0;
  let disposed = false;
  let t = Math.random() * 100;
  let last = performance.now();
  let dust = [];
  const sparks = [];
  const rings = [];

  function resize() {
    const q = QUALITY[quality];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(2, Math.round(window.innerWidth * dpr * q.scale));
    h = Math.max(2, Math.round(window.innerHeight * dpr * q.scale));
    canvas.width = w;
    canvas.height = h;
    seedDust();
    if (quality === 'off') draw(0);
  }

  function seedDust() {
    const n = QUALITY[quality].dust;
    dust = Array.from({ length: n }, () => ({
      x: Math.random(),
      y: Math.random(),
      z: 0.3 + Math.random() * 0.7,
      tw: Math.random() * Math.PI * 2,
    }));
  }

  function draw(dt) {
    const k = Math.min(1, dt * 2.2);
    cur.energy = lerp(cur.energy, target.energy, k);
    cur.speed = lerp(cur.speed, target.speed, k);
    cur.bloom = lerp(cur.bloom, target.bloom, k);
    for (let i = 0; i < 3; i++) cur.tint[i] = lerp(cur.tint[i], target.tint[i], k);
    progressShown = lerp(progressShown, progress, Math.min(1, dt * 3));
    pulseAmt *= Math.pow(0.12, dt);
    t += dt * cur.speed;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);

    const m = Math.max(w, h);
    const energy = cur.energy + pulseAmt * 0.6;
    ctx.globalCompositeOperation = 'lighter';
    BLOBS.forEach((b, i) => {
      const x = (b.cx + Math.sin(t * b.fx * 6 + b.ph) * b.ax) * w;
      const y = (b.cy + Math.cos(t * b.fy * 6 + b.ph * 1.3) * b.ay) * h;
      const r = b.r * m * (0.85 + 0.15 * Math.sin(t * 0.4 + i)) * (1 + pulseAmt * 0.25);
      const c = i === 0 ? cur.tint.map(Math.round) : b.color;
      const a = Math.min(0.9, b.a * energy * 0.55);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
      g.addColorStop(0.45, `rgba(${c[0]},${c[1]},${c[2]},${a * 0.35})`);
      g.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });

    // Horizon glow grows with progress.
    const hz = 0.25 + progressShown * 0.75;
    const hg = ctx.createRadialGradient(w / 2, h * 1.15, 0, w / 2, h * 1.15, h * (0.6 + hz * 0.5));
    hg.addColorStop(0, `rgba(167,139,250,${0.22 * hz * cur.bloom})`);
    hg.addColorStop(1, 'rgba(167,139,250,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, w, h);

    // Dust.
    const drift = dt * 0.012 * cur.speed;
    for (const d of dust) {
      d.y -= drift * d.z;
      d.x += Math.sin(t * 0.5 + d.tw) * drift * 0.3;
      if (d.y < -0.02) {
        d.y = 1.02;
        d.x = Math.random();
      }
      const tw = 0.5 + 0.5 * Math.sin(t * 2 + d.tw * 5);
      const a = (0.15 + 0.45 * tw) * d.z * Math.min(1.2, energy);
      ctx.fillStyle = `rgba(220,210,255,${a})`;
      const s = Math.max(1, d.z * m * 0.0016);
      ctx.fillRect(d.x * w, d.y * h, s, s);
    }

    // Pulse rings.
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life += dt;
      const p = r.life / 1.3;
      if (p >= 1) {
        rings.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = `rgba(196,181,253,${(1 - p) * 0.35 * r.s})`;
      ctx.lineWidth = Math.max(1, m * 0.004 * (1 - p));
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.45, m * (0.05 + p * 0.7), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Sparks.
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life += dt;
      if (s.life > s.max) {
        sparks.splice(i, 1);
        continue;
      }
      s.vx *= Math.pow(0.25, dt);
      s.vy = s.vy * Math.pow(0.25, dt) + dt * 0.04;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const a = 1 - s.life / s.max;
      ctx.fillStyle = `rgba(${s.c},${a})`;
      const size = Math.max(1, m * 0.003 * a);
      ctx.fillRect(s.x * w, s.y * h, size, size);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    if (disposed) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!document.hidden) draw(dt);
    raf = quality === 'off' ? 0 : requestAnimationFrame(loop);
  }

  function start() {
    cancelAnimationFrame(raf);
    last = performance.now();
    if (quality === 'off') draw(0.016);
    else raf = requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  start();

  return {
    setState(name) {
      const s = STATES[name] || STATES.idle;
      target = { ...s, tint: [...s.tint] };
      if (quality === 'off') draw(1);
    },
    setProgress(p) {
      progress = Math.min(1, Math.max(0, Number(p) || 0));
    },
    pulse(strength = 1) {
      if (quality === 'off') return;
      pulseAmt = Math.min(1.5, pulseAmt + 0.8 * strength);
      if (rings.length < 4) rings.push({ life: 0, s: strength });
    },
    burst({ count } = {}) {
      if (quality === 'off') return;
      const n = count || (quality === 'ultra' ? 160 : quality === 'high' ? 100 : 40);
      for (let i = 0; i < n; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 0.15 + Math.random() * 0.55;
        sparks.push({
          x: 0.5,
          y: 0.45,
          vx: (Math.cos(ang) * sp * h) / w,
          vy: Math.sin(ang) * sp,
          life: 0,
          max: 0.8 + Math.random() * 1.2,
          c: Math.random() < 0.3 ? '255,255,255' : Math.random() < 0.5 ? '196,181,253' : '139,92,246',
        });
      }
      pulseAmt = Math.min(1.5, pulseAmt + 1);
    },
    setQuality(q) {
      if (!QUALITY[q] || q === quality) return;
      quality = q;
      resize();
      start();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    },
  };
}
