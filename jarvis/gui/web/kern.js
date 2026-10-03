/* Partikel-Kern wie im Video „Claude OS“: eine Wolke aus leuchtenden Punkten, zu einem feinen Netz verbunden,
   die sich langsam dreht und mit der Stimme atmet. Je Zustand eine eigene Farbe: Bereit türkis, Zuhören heller
   und unruhiger, Nachdenken violett und schneller, Sprechen pulsiert mit der Stimme, stumm grau, Störung rot.

   Canvas 2D, keine Bibliothek, dieselbe Schnittstelle wie plasma.js:
   const kern = JarvisKern.create(canvas, { visible: () => true });
   kern.state('listening'); kern.level(0.6); kern.pulse(); kern.boot(); kern.gesture('search', true); kern.stop();
   Mit gedrückter Maustaste lässt sich der Kern drehen.
*/
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motionQuery && motionQuery.matches);

  // Farbe (rgb), Drehtempo (spin), Zittern (jitter), wie hell das Netz ist (net), Puls (beat)
  const LOOKS = {
    idle: { rgb: [64, 226, 178], spin: 0.10, jitter: 0.006, net: 0.55, beat: 0.25 },
    listening: { rgb: [96, 224, 255], spin: 0.20, jitter: 0.014, net: 0.75, beat: 0.6 },
    thinking: { rgb: [168, 132, 255], spin: 0.52, jitter: 0.020, net: 0.85, beat: 1.4 },
    speaking: { rgb: [120, 206, 255], spin: 0.24, jitter: 0.012, net: 0.8, beat: 0.4 },
    muted: { rgb: [138, 148, 164], spin: 0.04, jitter: 0.002, net: 0.3, beat: 0.1 },
    error: { rgb: [255, 104, 92], spin: 0.12, jitter: 0.010, net: 0.6, beat: 0.5 },
  };

  // Pseudo-Zufall mit festem Startwert: der Kern sieht bei jedem Start gleich aus
  function random(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Punkte: die meisten nahe der Oberfläche (wie eine Kugel aus Licht), ein Teil im Inneren
  function makePoints(count) {
    const rnd = random(20261003);
    const points = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (i / (count - 1)) * 2;
      const ring = Math.sqrt(1 - y * y);
      const turn = golden * i;
      const inside = rnd() < 0.3;
      const r = inside ? 0.25 + 0.6 * Math.sqrt(rnd()) : 0.86 + 0.14 * rnd();
      const wobble = (rnd() - 0.5) * 0.08;
      points.push({
        x: Math.cos(turn) * ring * r + wobble,
        y: y * r + (rnd() - 0.5) * 0.06,
        z: Math.sin(turn) * ring * r - wobble,
        size: 0.6 + rnd() * 1.4 + (rnd() < 0.06 ? 1.6 : 0),
        phase: rnd() * Math.PI * 2,
        from: [(rnd() - 0.5) * 6, (rnd() - 0.5) * 6, (rnd() - 0.5) * 6],
      });
    }
    return points;
  }

  // Netz: jeder Punkt mit seinen nächsten Nachbarn (einmal vorab, die Abstände bleiben ja gleich)
  function makeLinks(points, near, most) {
    const links = [];
    const seen = new Set();
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const close = [];
      for (let j = 0; j < points.length; j += 1) {
        if (i === j) continue;
        const b = points[j];
        const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
        if (d < near * near) close.push([d, j]);
      }
      close.sort((p, q) => p[0] - q[0]);
      for (const [, j] of close.slice(0, most)) {
        const key = i < j ? i * 100000 + j : j * 100000 + i;
        if (!seen.has(key)) {
          seen.add(key);
          links.push([i, j]);
        }
      }
    }
    return links;
  }

  function create(canvas, options) {
    const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return null;
    const opts = options || {};
    const visible = typeof opts.visible === 'function' ? opts.visible : () => true;
    const points = makePoints(opts.count || 760);
    const links = makeLinks(points, 0.28, 3);
    const projected = points.map(() => ({ x: 0, y: 0, z: 0, s: 1 }));

    const look = Object.assign({}, LOOKS.idle, { rgb: LOOKS.idle.rgb.slice() });
    let target = LOOKS.idle;
    let levelTarget = 0;
    let level = 0;
    let flash = 0;
    let hold = 0;
    let boot = 1;
    let turn = 0;
    let tilt = 0.32;
    let drag = null;
    let moved = false; // die letzte Geste hat gedreht (dann ist der Klick danach kein "Zuhören")
    let push = 0; // Schwung nach dem Drehen mit der Maus
    let time = 0;
    let last = 0;
    let frame = 0;
    let stopped = false;

    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, turn, tilt, moved: false };
      moved = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      push = dx * 0.0004;
      turn = drag.turn + dx * 0.008;
      tilt = clamp(drag.tilt + dy * 0.006, -1.1, 1.1);
    });
    window.addEventListener('pointerup', () => {
      if (drag) moved = drag.moved;
      drag = null;
    });

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return [w, h, dpr];
    }

    function draw(now) {
      frame = 0;
      if (stopped) return;
      schedule();
      if (document.hidden || !visible() || !canvas.clientWidth) {
        last = now;
        return;
      }
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      const slow = reduced() ? 0.15 : 1;
      const k = 1 - Math.pow(0.02, dt);
      for (const key of ['spin', 'jitter', 'net', 'beat']) look[key] = lerp(look[key], target[key], k);
      for (let i = 0; i < 3; i += 1) look.rgb[i] = lerp(look.rgb[i], target.rgb[i], k);
      level = lerp(level, levelTarget, 1 - Math.pow(0.0005, dt));
      flash = Math.max(hold * 0.4, flash * Math.pow(0.05, dt));
      boot = boot * Math.pow(0.04, dt);
      time += dt * slow;
      if (!drag) {
        turn += dt * slow * look.spin + push;
        push *= Math.pow(0.08, dt);
      }

      const [w, h, dpr] = resize();
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const breathe = 1 + 0.025 * Math.sin(time * (1.2 + look.beat)) + level * 0.14 + flash * 0.06;
      const radius = Math.min(w, h) * 0.38 * breathe;
      const cosT = Math.cos(turn);
      const sinT = Math.sin(turn);
      const cosX = Math.cos(tilt);
      const sinX = Math.sin(tilt);
      const shake = look.jitter * (1 + level * 2);
      const fly = boot * boot;

      for (let i = 0; i < points.length; i += 1) {
        const p = points[i];
        const wob = Math.sin(time * 2.1 + p.phase) * shake;
        let x = p.x * (1 + wob) + p.from[0] * fly;
        let y = p.y * (1 + wob) + p.from[1] * fly;
        let z = p.z * (1 + wob) + p.from[2] * fly;
        // drehen um die Hochachse, dann leicht nach vorn kippen
        const x1 = x * cosT + z * sinT;
        const z1 = -x * sinT + z * cosT;
        const y2 = y * cosX - z1 * sinX;
        const z2 = y * sinX + z1 * cosX;
        x = x1;
        y = y2;
        z = z2;
        const depth = 1 / Math.max(0.3, 1 + (z + 1.6) * 0.18); // näher = größer
        const q = projected[i];
        q.x = cx + x * radius * depth * 1.25;
        q.y = cy + y * radius * depth * 1.25;
        q.z = z;
        q.s = depth;
      }

      const [r, g, b] = look.rgb.map((c) => Math.round(c));
      ctx.globalCompositeOperation = 'lighter';
      // Netz in vier Tiefenstufen, damit es nur wenige Striche sind
      ctx.lineWidth = Math.max(0.6, dpr * 0.55);
      for (let band = 0; band < 4; band += 1) {
        ctx.beginPath();
        for (const [i, j] of links) {
          const a = projected[i];
          const c = projected[j];
          const zz = (a.z + c.z) / 2;
          const which = zz < -0.5 ? 0 : zz < 0 ? 1 : zz < 0.5 ? 2 : 3;
          if (which !== band) continue;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
        }
        const alpha = (0.07 + band * 0.07) * (look.net + flash * 0.6) * (1 - fly * 0.8);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
        ctx.stroke();
      }
      // Punkte: vorne heller und größer, ein paar funkeln
      for (let i = 0; i < points.length; i += 1) {
        const p = points[i];
        const q = projected[i];
        const front = clamp((q.z + 1.2) / 2.4, 0, 1); // beim Einfliegen auch weit hinten
        const twinkle = 0.75 + 0.25 * Math.sin(time * 3 + p.phase * 3);
        const alpha = clamp((0.35 + front * 0.65) * twinkle * (0.85 + level * 0.5 + flash * 0.5), 0.05, 1);
        const size = Math.max(0.2, p.size * dpr * (0.6 + front * 0.9) * (1 + level * 0.4));
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, size, 0, Math.PI * 2);
        ctx.fill();
        if (p.size > 2 && front > 0.5) {
          ctx.fillStyle = `rgba(255, 255, 255, ${(alpha * 0.55).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(q.x, q.y, size * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // weicher Schein in der Mitte
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.1);
      glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(0.16 + level * 0.12 + flash * 0.1).toFixed(3)})`);
      glow.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    function schedule() {
      if (!frame && !stopped) frame = requestAnimationFrame(draw);
    }

    schedule();
    return {
      state(name) {
        target = LOOKS[name] || LOOKS.idle;
      },
      level(v) {
        levelTarget = clamp(Number(v) || 0, 0, 1);
      },
      pulse() {
        flash = 1;
      },
      boot() {
        boot = 1;
      },
      gesture(kind, keep) {
        if (!kind) {
          hold = 0;
          return;
        }
        flash = Math.max(flash, 0.7);
        hold = keep ? 1 : 0;
      },
      talk() {},
      dragged() {
        return moved || !!(drag && drag.moved);
      },
      stop() {
        stopped = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      },
    };
  }

  window.JarvisKern = { create, LOOKS };
})();
