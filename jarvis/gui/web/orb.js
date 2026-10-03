/* Jarvis' Kugel: ruhig, klug, aufgeräumt.

   Eine Kugel aus feinen Linien in fast weißem Ton, die sich langsam dreht. Ihre Oberfläche atmet
   kaum merklich. Hört Jarvis zu oder spricht er, schwingen die Linien mit der Stimme und bekommen
   einen leichten Blauton. Beim Nachdenken läuft ein heller Streifen von oben nach unten durch.
   Keine Glanzpunkte, keine Neonfarben: zurückhaltend statt Science-Fiction.

   Gemeinsam für Hauptfenster, Einrichtung und Handy-App (handy/orb.js ist eine Kopie, ein Test
   hält beide gleich). Zeichnet nur, wenn die Kugel zu sehen ist.

   Dazu eine eigene kleine Bewegung je Aktion (orb.gesture): Beim Suchen kreist ein heller Meridian
   wie ein Radar, beim Öffnen einer App läuft ein Ring nach außen, beim Installieren fließen Bänder
   nach unten, eine Nachricht umkreist die Kugel als Lichtpunkt, Musik lässt die Ringe im Takt
   springen, beim Wetter wiegen sie sich im Wind, Timer und Termine zeigen einen Uhrzeiger, die
   Werkstatt blendet ein Konstruktionsgitter ein, beim Lesen läuft eine Scanlinie, bei Hinweisen
   klopft die Kugel zweimal an, und auf "Danke" nickt sie.
   Mit der Maus lässt sie sich anfassen: Sie neigt sich zum Zeiger, wölbt sich ihm entgegen und
   lässt sich mit gedrückter Taste drehen. Im Gespräch (orb.talk) zeigt ein ruhiger Ring: Jarvis hört weiter zu.

   const orb = JarvisOrb.create(canvas, { mode: 'hero' | 'mark', visible: () => true });
   orb.state('listening'); orb.level(0.6); orb.pulse(); orb.boot();
   orb.gesture('search', true); orb.gesture(null); orb.talk(true);
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

  // Welche Bewegung zu welcher Aktion gehört (Art der Schritte aus steps.py und der Sofort-Befehle)
  const GESTURES = {
    search: 'scan', web: 'scan', app: 'bloom', install: 'stream', message: 'orbit', music: 'beat',
    weather: 'sway', timer: 'clock', calendar: 'clock', reminder: 'clock', time: 'clock',
    build: 'grid', file: 'grid', command: 'grid', plan: 'grid', task: 'grid', read: 'scanline',
    screen: 'scanline', hint: 'knock', thanks: 'nod', bye: 'nod', power: 'dim', night: 'dim',
  };
  // So lange (Sekunden) läuft eine Bewegung, wenn sie nicht gehalten wird
  const GESTURE_SECONDS = 2.6;
  const GESTURE_MAX = 30;

  function create(canvas, options) {
    if (!canvas || !canvas.getContext) return null;
    const opts = Object.assign({ mode: 'hero', visible: null }, options || {});
    const hero = opts.mode !== 'mark';
    const ctx = canvas.getContext('2d');
    const RINGS = hero ? 26 : 7;
    const SEG = hero ? 72 : 30;
    // Punkte eines Rings: x, y auf dem Bild und z (Tiefe: vorn > 0, hinten < 0)
    const ring = new Float32Array((SEG + 1) * 3);

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
    // Bewegung je Aktion: welche, seit wann, ob sie gehalten wird (läuft, solange der Schritt läuft)
    let move = '';
    let moveT = -100;
    let moveHold = false;
    let moveAmt = 0;
    let talkOn = false;
    let talkAmt = 0;
    // Maus: Position (-1 bis 1 um die Mitte), wie nah (hover), Neigung zum Zeiger, Drehen per Ziehen
    let px = 0;
    let py = 0;
    let hover = 0;
    let hoverTarget = 0;
    let leanX = 0;
    let leanY = 0;
    let dragging = false;
    let dragged = false;
    let dragX = 0;
    let dragVel = 0;
    let tilt = TILT;
    let sinT = Math.sin(TILT);
    let cosT = Math.cos(TILT);
    let dragStart = 0;
    let dragAt = 0;

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
      let extra = 0;
      if (moveAmt > 0.01) {
        // Musik: die Ringe springen im Takt, jeder ein bisschen anders (wie ein Equalizer)
        if (move === 'beat') extra += moveAmt * 0.07 * Math.pow(Math.abs(Math.sin(t * 4.2 + phi * 5)), 3);
        // Ausschalten: die Kugel zieht sich leise zusammen
        if (move === 'dim') extra -= moveAmt * 0.06;
      }
      return 1 + extra + rho * (
        look.amp * (0.55 * Math.sin(2 * lam + 3 * phi + t * 0.55) + 0.45 * Math.sin(3 * phi - lam - t * 0.4))
        // Die Stimme läuft als Welle von oben nach unten durch die Ringe, wie Schall
        + v * (0.7 * Math.sin(7 * phi - t * 6) + 0.3 * Math.sin(2 * lam + 3 * phi - t * 3)));
    }

    // Bildpunkt eines Punkts der Kugel (Breite phi, Länge lam): drehen, neigen, zum Zeiger wölben
    function project(phi, lam, R, out, k) {
      const rho = Math.sin(phi);
      const r = surface(phi, lam, rho);
      const a = lam + spin + leanX;
      let x = rho * Math.cos(a) * r;
      const z = rho * Math.sin(a) * r;
      const y = Math.cos(phi) * r;
      // Wind: jeder Ring wiegt sich ein wenig seitlich
      if (move === 'sway' && moveAmt > 0.01) x += moveAmt * 0.05 * Math.sin(t * 1.6 + phi * 3.2);
      let y2 = y * cosT - z * sinT;
      const z2 = y * sinT + z * cosT;
      // Zum Zeiger hin wölbt sich die Oberfläche ein wenig (nur vorn)
      if (hover > 0.01 && z2 > 0) {
        const d2 = (x - px) * (x - px) + (y2 - py) * (y2 - py);
        const bump = 1 + hover * 0.075 * Math.exp(-d2 / 0.09) * z2;
        x *= bump;
        y2 *= bump;
      }
      out[k] = x * R;
      out[k + 1] = y2 * R;
      out[k + 2] = z2;
    }

    // Rechnet einen Ring (Breitengrad phi) in Bildpunkte um: drehen, neigen, abbilden
    function traceRing(phi, R) {
      for (let j = 0; j <= SEG; j += 1) project(phi, (j / SEG) * TAU, R, ring, j * 3);
    }

    // Ein Meridian (Längenkreis von Pol zu Pol, vorn und hinten) in dieselbe Punktliste
    function traceMeridian(lam, R) {
      for (let j = 0; j <= SEG; j += 1) {
        const v = (j / SEG) * TAU;
        // erst vorn hinunter, dann hinten wieder hinauf
        if (v <= Math.PI) project(Math.max(0.0001, v), lam, R, ring, j * 3);
        else project(Math.max(0.0001, TAU - v), lam + Math.PI, R, ring, j * 3);
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

    // Wie weit eine Bewegung schon läuft (Sekunden)
    const since = () => t - moveT;

    // Kurzer Schlag (0 bis 1 bis 0) ab Sekunde `at`, `len` Sekunden lang
    const knock = (at, len) => {
      const p = (since() - at) / len;
      return p > 0 && p < 1 ? Math.sin(p * Math.PI) : 0;
    };

    function draw() {
      const S = Math.min(canvas.width, canvas.height);
      if (S < 8) return;
      const ease = 1 - Math.pow(1 - bootT, 3);
      const click = t - pulseT < 0.6 ? Math.sin(((t - pulseT) / 0.6) * Math.PI) * 0.05 : 0;
      // Anklopfen (Hinweis) und Aufblühen (App): kurze Schläge der ganzen Kugel
      let beat = 0;
      if (move === 'knock') beat = (knock(0, 0.28) + knock(0.36, 0.28)) * 0.045 * moveAmt;
      if (move === 'bloom') beat = knock(0, 0.5) * 0.05 * moveAmt;
      const R = S * (hero ? 0.3 : 0.42) * (0.94 + 0.06 * ease) * (1 + click + beat + level * 0.035);
      sinT = Math.sin(tilt);
      cosT = Math.cos(tilt);
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
        let band = look.wave > 0.01 ? look.wave * Math.exp(-Math.pow(v - wave, 2) / 0.006) : 0;
        if (moveAmt > 0.01) {
          // Installieren: mehrere Bänder fließen nach unten, wie ein Download
          if (move === 'stream') {
            const f = (v - since() * 0.9) * 3;
            band += moveAmt * 0.9 * Math.pow(Math.max(0, Math.cos((f - Math.floor(f)) * TAU)), 12);
          }
          // Lesen: eine Scanlinie fährt hinunter und wieder hinauf
          if (move === 'scanline') {
            const p = (since() * 0.45) % 2;
            band += moveAmt * 1.2 * Math.exp(-Math.pow(v - (p < 1 ? p : 2 - p), 2) / 0.003);
          }
          // Hinweis: beim Anklopfen leuchten alle Ringe kurz auf
          if (move === 'knock') band += (knock(0, 0.28) + knock(0.36, 0.28)) * 0.5 * moveAmt;
        }
        const a = base * (1 + band * 1.4);
        // Hinten nur angedeutet, vorne klar: so wirkt sie räumlich
        strokeDepth(-2, -0.3, color, a * 0.16);
        strokeDepth(-0.3, 0.3, color, a * 0.45);
        strokeDepth(0.3, 2, color, a);
      }
      if (hero && moveAmt > 0.01) drawMove(R, color, base);
      if (hero && talkAmt > 0.01) drawTalk(R, color);
      ctx.globalAlpha = 1;
    }

    // Längenkreise, vorn klar und hinten nur angedeutet
    function meridian(lam, R, color, alpha) {
      traceMeridian(lam, R);
      strokeDepth(-2, -0.3, color, alpha * 0.16);
      strokeDepth(-0.3, 0.3, color, alpha * 0.45);
      strokeDepth(0.3, 2, color, alpha);
    }

    function drawMove(R, color, base) {
      const k = moveAmt;
      if (move === 'scan') {
        // Suchen: ein heller Meridian kreist wie ein Radar, ein schwächerer folgt
        const lam = -spin - leanX + since() * 2.4;
        meridian(lam, R, color, base * 1.5 * k);
        meridian(lam - 0.28, R, color, base * 0.5 * k);
      } else if (move === 'grid') {
        // Werkstatt: ein Konstruktionsgitter aus Längenkreisen blendet sich ein
        for (let i = 0; i < 12; i += 1) meridian((i / 12) * TAU, R, color, base * 0.55 * k);
      } else if (move === 'clock') {
        // Zeit: ein Zeiger springt im Sekundentakt weiter, der Äquator leuchtet als Zifferblatt
        const tick = Math.floor(since() * 2) / 2;
        meridian(-spin - leanX + tick * (TAU / 12), R, color, base * 1.6 * k);
        traceRing(Math.PI / 2, R);
        strokeDepth(0.3, 2, color, base * 0.9 * k);
      } else if (move === 'bloom') {
        // App öffnen: Ringe laufen von der Kugel nach außen und verblassen
        for (let i = 0; i < 2; i += 1) {
          const p = ((since() - i * 0.45) % 1.3) / 1.3;
          if (since() < i * 0.45 || p < 0) continue;
          ctx.beginPath();
          ctx.ellipse(0, 0, R * (1.02 + p * 0.5), R * (1.02 + p * 0.5) * 0.98, 0, 0, TAU);
          ctx.strokeStyle = rgba(color, base * 0.9 * k * (1 - p));
          ctx.stroke();
        }
      } else if (move === 'orbit') {
        // Nachricht: ein Lichtpunkt umkreist die Kugel und zieht einen kurzen Schweif
        for (let i = 0; i < 14; i += 1) {
          const ang = since() * 3.2 - i * 0.07;
          const x = Math.cos(ang) * R * 1.22;
          const y = Math.sin(ang) * R * 0.34 - Math.cos(ang) * R * 0.12;
          const front = Math.sin(ang) > -0.2;
          ctx.beginPath();
          ctx.arc(x, y, (i === 0 ? 2.6 : 2 - i * 0.12) * dpr, 0, TAU);
          ctx.fillStyle = rgba(look.tint, k * (front ? 0.9 : 0.35) * (1 - i / 14));
          ctx.fill();
        }
      }
    }

    // Gespräch: ein ruhiger, langsam drehender Ring um die Kugel zeigt "ich höre weiter zu"
    function drawTalk(R, color) {
      ctx.save();
      ctx.rotate(t * 0.25);
      ctx.setLineDash([R * 0.18, R * 0.1]);
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.24, 0, TAU);
      ctx.strokeStyle = rgba(color, 0.32 * talkAmt);
      ctx.stroke();
      ctx.restore();
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
      // Bewegung je Aktion: an, solange gehalten (höchstens GESTURE_MAX) oder kurz, dann sanft aus
      const live = move && (moveHold ? since() < GESTURE_MAX : since() < GESTURE_SECONDS);
      moveAmt = lerp(moveAmt, live ? 1 : 0, Math.min(1, dt * (live ? 6 : 2.5)));
      if (!live && moveAmt < 0.01) move = '';
      if (move === 'scan' || move === 'grid') spin += dt * 0.35 * moveAmt;
      talkAmt = lerp(talkAmt, talkOn ? 1 : 0, Math.min(1, dt * 4));
      // Maus: zum Zeiger neigen, nach dem Ziehen mit Schwung weiterdrehen
      hover = lerp(hover, hoverTarget, Math.min(1, dt * 6));
      leanX = lerp(leanX, hoverTarget ? px * 0.22 : 0, Math.min(1, dt * 4));
      leanY = lerp(leanY, hoverTarget ? py * 0.16 : 0, Math.min(1, dt * 4));
      if (!dragging && Math.abs(dragVel) > 0.001) {
        spin += dragVel * dt;
        dragVel *= Math.exp(-dt * 2.2);
      }
      // "Danke": die Kugel nickt einmal
      const nod = move === 'nod' ? -0.24 * knock(0, 0.8) : 0;
      tilt = TILT + leanY + nod;
      draw();
      // Ruhig reichen 30 Bilder pro Sekunde (die kleine Marke 20), sonst flüssig
      const calm = (current === 'idle' || current === 'muted') && level < 0.02 && moveAmt < 0.01
        && hover < 0.01 && talkAmt < 0.01 && Math.abs(dragVel) < 0.01;
      if (!hero) setTimeout(() => requestAnimationFrame(frame), 50);
      else if (calm || reduced()) setTimeout(() => requestAnimationFrame(frame), 33);
      else requestAnimationFrame(frame);
    }

    // Anfassen (nur die große Kugel): Zeiger, Ziehen zum Drehen. Wer gezogen hat, löst keinen Klick aus.
    if (hero && canvas.addEventListener) {
      const at = (e) => {
        const box = canvas.getBoundingClientRect();
        const rpx = Math.max(1, Math.min(box.width, box.height) * 0.3);
        return [(e.clientX - box.left - box.width / 2) / rpx, (e.clientY - box.top - box.height / 2) / rpx, rpx];
      };
      canvas.addEventListener('pointermove', (e) => {
        const [x, y, rpx] = at(e);
        px = clamp(x, -1.4, 1.4);
        py = clamp(y, -1.4, 1.4);
        hoverTarget = x * x + y * y < 2.2 ? 1 : 0;
        if (dragging) {
          const dx = e.clientX - dragX;
          const now = performance.now();
          dragX = e.clientX;
          spin += dx / rpx;
          dragVel = (dx / rpx) / Math.max(0.016, (now - dragAt) / 1000);
          dragAt = now;
          if (Math.abs(e.clientX - dragStart) > 6) dragged = true;
        }
      });
      canvas.addEventListener('pointerleave', () => {
        hoverTarget = 0;
        dragging = false;
      });
      canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        dragged = false;
        dragX = dragStart = e.clientX;
        dragAt = performance.now();
        dragVel = 0;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* ältere Browser */
        }
      });
      canvas.addEventListener('pointerup', () => {
        dragging = false;
        if (performance.now() - dragAt > 120) dragVel = 0; // losgelassen ohne Schwung
      });
      canvas.addEventListener('pointercancel', () => {
        dragging = false;
        hoverTarget = 0;
      });
      canvas.addEventListener('click', (e) => {
        if (!dragged) return;
        dragged = false;
        e.stopPropagation();
        e.preventDefault();
      }, true);
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
      // Eigene Bewegung für eine Aktion ("search", "app", "music", ...). hold = läuft, bis
      // gesture(null) kommt (z. B. solange ein Schritt läuft). Unbekannte Arten: keine Bewegung.
      gesture(kind, hold) {
        const name = GESTURES[String(kind || '')] || '';
        if (!name) {
          moveHold = false;
          return '';
        }
        if (name !== move || !moveHold || since() > GESTURE_SECONDS) moveT = t;
        move = name;
        moveHold = !!hold;
        return name;
      },
      talk(on) {
        talkOn = !!on;
      },
      resize,
      stop() {
        running = false;
      },
    };
  }

  window.JarvisOrb = { create, LOOKS, GESTURES };
})();
