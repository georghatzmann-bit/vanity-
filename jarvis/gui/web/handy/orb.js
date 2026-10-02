/* Jarvis' Kugel: ruhig, klug, aufgeräumt.

   Eine Kugel aus feinen Linien in fast weißem Ton, die sich langsam dreht. Ihre Oberfläche atmet
   kaum merklich. Hört Jarvis zu oder spricht er, schwingen die Linien mit der Stimme und bekommen
   einen leichten Blauton. Beim Nachdenken läuft ein heller Streifen von oben nach unten durch.
   Keine Glanzpunkte, keine Neonfarben: zurückhaltend statt Science-Fiction.

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

  // Je Zustand: Linienfarbe (ink), Tönung (tint) und wie stark sie einfließt (mix), Helligkeit der
  // Linien (alpha), leiser Schein dahinter (glow), wie stark die Oberfläche atmet (amp) und mit der
  // Stimme schwingt (ripple), Drehtempo (spin) und ob der helle Streifen durchläuft (wave)
  const LOOKS = {
    idle: {
      ink: [226, 230, 240], tint: [150, 168, 255], mix: 0.14, alpha: 0.5, glow: 0.05,
      amp: 0.035, ripple: 0.05, spin: 0.1, wave: 0,
    },
    listening: {
      ink: [236, 240, 252], tint: [150, 176, 255], mix: 0.42, alpha: 0.72, glow: 0.1,
      amp: 0.045, ripple: 0.09, spin: 0.16, wave: 0,
    },
    thinking: {
      ink: [232, 232, 250], tint: [172, 164, 255], mix: 0.34, alpha: 0.64, glow: 0.08,
      amp: 0.04, ripple: 0.03, spin: 0.34, wave: 1,
    },
    speaking: {
      ink: [236, 240, 252], tint: [142, 166, 255], mix: 0.4, alpha: 0.74, glow: 0.1,
      amp: 0.045, ripple: 0.1, spin: 0.18, wave: 0,
    },
    muted: {
      ink: [118, 122, 134], tint: [118, 122, 134], mix: 0, alpha: 0.34, glow: 0,
      amp: 0.012, ripple: 0, spin: 0.03, wave: 0,
    },
    error: {
      ink: [238, 206, 204], tint: [242, 100, 95], mix: 0.55, alpha: 0.62, glow: 0.07,
      amp: 0.03, ripple: 0.04, spin: 0.08, wave: 0,
    },
  };
  const COLORS = ['ink', 'tint'];
  const NUMBERS = ['mix', 'alpha', 'glow', 'amp', 'ripple', 'spin', 'wave'];
  const TILT = -0.36; // leicht von oben gesehen: so erscheinen die Ringe als ruhige Ellipsen

  function create(canvas, options) {
    if (!canvas || !canvas.getContext) return null;
    const opts = Object.assign({ mode: 'hero', visible: null }, options || {});
    const hero = opts.mode !== 'mark';
    const ctx = canvas.getContext('2d');
    const RINGS = hero ? 26 : 7;
    const SEG = hero ? 72 : 30;
    // Punkte eines Rings: x, y auf dem Bild und z (Tiefe: vorn > 0, hinten < 0)
    const ring = new Float32Array((SEG + 1) * 3);
    const sinT = Math.sin(TILT);
    const cosT = Math.cos(TILT);

    const look = {};
    for (const key of COLORS) look[key] = LOOKS.idle[key].slice();
    for (const key of NUMBERS) look[key] = LOOKS.idle[key];
    let target = LOOKS.idle;
    let current = 'idle';
    let dpr = 1;
    let t = 0;
    let spin = 0;
    let wave = 0;
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
      const cw = Math.round(Math.max(1, canvas.clientWidth) * dpr);
      const ch = Math.round(Math.max(1, canvas.clientHeight) * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    }

    function visible() {
      if (document.hidden || canvas.offsetParent === null) return false;
      return typeof opts.visible === 'function' ? !!opts.visible() : true;
    }

    // Wie weit die Oberfläche an dieser Stelle aus- oder einatmet (1 = glatte Kugel). An den Polen
    // (rho klein) bleibt sie glatt, sonst würden die kleinen Ringe dort knittern.
    function surface(phi, lam, rho) {
      const v = look.ripple * level;
      return 1 + rho * (
        look.amp * (0.55 * Math.sin(2 * lam + 3 * phi + t * 0.55) + 0.45 * Math.sin(3 * phi - lam - t * 0.4))
        // Die Stimme läuft als Welle von oben nach unten durch die Ringe, wie Schall
        + v * (0.7 * Math.sin(7 * phi - t * 6) + 0.3 * Math.sin(2 * lam + 3 * phi - t * 3)));
    }

    // Rechnet einen Ring (Breitengrad phi) in Bildpunkte um: drehen, neigen, abbilden
    function traceRing(phi, R) {
      const y0 = Math.cos(phi);
      const rho = Math.sin(phi);
      for (let j = 0; j <= SEG; j += 1) {
        const lam = (j / SEG) * TAU;
        const r = surface(phi, lam, rho);
        const a = lam + spin;
        const x = rho * Math.cos(a) * r;
        const z = rho * Math.sin(a) * r;
        const y = y0 * r;
        // um die waagrechte Achse neigen
        const y2 = y * cosT - z * sinT;
        const z2 = y * sinT + z * cosT;
        ring[j * 3] = x * R;
        ring[j * 3 + 1] = y2 * R;
        ring[j * 3 + 2] = z2;
      }
    }

    // Zeichnet die Teile eines Rings, deren Tiefe im Bereich [lo, hi) liegt, als einen Pfad
    function strokeDepth(lo, hi, color, alpha) {
      if (alpha <= 0.004) return;
      ctx.beginPath();
      let open = false;
      for (let j = 0; j < SEG; j += 1) {
        const z = (ring[j * 3 + 2] + ring[j * 3 + 5]) / 2;
        if (z >= lo && z < hi) {
          if (!open) ctx.moveTo(ring[j * 3], ring[j * 3 + 1]);
          ctx.lineTo(ring[j * 3 + 3], ring[j * 3 + 4]);
          open = true;
        } else {
          open = false;
        }
      }
      ctx.strokeStyle = rgba(color, alpha);
      ctx.stroke();
    }

    function draw() {
      const S = Math.min(canvas.width, canvas.height);
      if (S < 8) return;
      const ease = 1 - Math.pow(1 - bootT, 3);
      const click = t - pulseT < 0.6 ? Math.sin(((t - pulseT) / 0.6) * Math.PI) * 0.05 : 0;
      const R = S * (hero ? 0.3 : 0.42) * (0.94 + 0.06 * ease) * (1 + click + level * 0.035);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.globalAlpha = ease;

      // Ein ganz leiser Schein, mehr nicht
      if (hero && look.glow > 0.005) {
        const span = Math.min(R * 1.7, S * 0.5);
        const glow = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, span);
        glow.addColorStop(0, rgba(look.tint, look.glow * (0.8 + level * 1.2)));
        glow.addColorStop(1, rgba(look.tint, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(-span, -span, span * 2, span * 2);
      }

      // Ein leises Licht im Inneren: die Kugel wirkt wach, nicht wie ein Drahtmodell
      const core = ctx.createRadialGradient(0, -R * 0.2, 0, 0, 0, R);
      core.addColorStop(0, rgba(look.ink, look.alpha * (0.1 + level * 0.14)));
      core.addColorStop(1, rgba(look.ink, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, TAU);
      ctx.fill();

      const color = mixc(look.ink, look.tint, look.mix * (0.7 + level * 0.6));
      ctx.lineWidth = (hero ? 1 : 0.9) * dpr;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      const base = look.alpha * (0.85 + level * 0.3);
      for (let i = 0; i < RINGS; i += 1) {
        const v = (i + 0.5) / RINGS;
        const phi = v * Math.PI;
        traceRing(phi, R);
        // Der helle Streifen beim Nachdenken: läuft von oben nach unten durch die Ringe
        const band = look.wave > 0.01 ? look.wave * Math.exp(-Math.pow(v - wave, 2) / 0.006) : 0;
        const a = base * (1 + band * 1.4);
        // Hinten nur angedeutet, vorne klar: so wirkt sie räumlich
        strokeDepth(-2, -0.3, color, a * 0.16);
        strokeDepth(-0.3, 0.3, color, a * 0.45);
        strokeDepth(0.3, 2, color, a);
      }
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
      const k = Math.min(1, dt * 3);
      for (const key of COLORS) look[key] = mixc(look[key], target[key], k);
      for (const key of NUMBERS) look[key] = lerp(look[key], target[key], k);
      // Pegel: schnell rauf, langsam runter; nach 300 ms ohne Meldung klingt er ab
      const want = performance.now() - levelAt > 300 ? 0 : levelTarget;
      level += (want - level) * Math.min(1, dt * (want > level ? 14 : 4));
      spin += dt * look.spin * slow * (1 + level * 0.5);
      wave = (wave + dt * 0.55 * slow) % 1.3;
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
