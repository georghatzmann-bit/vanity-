/* ==========================================================================
   Jarvis – Peitsche und Lob wie im Video "Response Accelerator"
   Knopf "Antreiben" (oder der Hinweis, wenn Jarvis länger nachdenkt): Eine Peitsche hängt an der Maus,
   das Seil schwingt mit (eine Kette aus Punkten, Verlet-Physik). Ein Klick lässt sie knallen: Das Fenster
   zuckt, es knallt, Jarvis antwortet ("Autsch. Ich lege einen Zahn zu, Sir.") und denkt eine Viertelstunde
   lang eine Stufe flotter. Knopf "Loben": eine Hand, ein Klick tätschelt, Herzen steigen auf, und Jarvis
   denkt wieder so gründlich wie nötig. Esc, Rechtsklick oder derselbe Knopf legt das Werkzeug weg.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motionQuery && motionQuery.matches);
  const SLOW_SECONDS = 8;     // so lange denkt Jarvis, bevor "Dauert's? Antreiben" erscheint
  const IDLE_SECONDS = 25;    // so lange ohne Bewegung, dann legt Jarvis das Werkzeug von selbst weg
  const SEGMENTS = 22;
  const SEG_LEN = 10;

  let audio = null;

  function sound(kind) {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audio;
      const t = ctx.currentTime;
      if (kind === 'knall') {
        // kurzes, scharfes Rauschen mit tiefem Schlag darunter
        const len = Math.round(ctx.sampleRate * 0.09);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1600;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.55, t);
        src.connect(hp).connect(g).connect(ctx.destination);
        src.start(t);
        const thump = ctx.createOscillator();
        const tg = ctx.createGain();
        thump.frequency.setValueAtTime(160, t);
        thump.frequency.exponentialRampToValueAtTime(60, t + 0.06);
        tg.gain.setValueAtTime(0.25, t);
        tg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
        thump.connect(tg).connect(ctx.destination);
        thump.start(t);
        thump.stop(t + 0.09);
      } else {
        // weiches "Tapp" und zwei helle Töne für die Herzen
        [[300, 0, 0.18, 0.09], [880, 0.08, 0.06, 0.18], [1320, 0.16, 0.05, 0.2]].forEach(([f, at, vol, dur]) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(f, t + at);
          if (f === 300) o.frequency.exponentialRampToValueAtTime(150, t + at + dur);
          g.gain.setValueAtTime(0.0001, t + at);
          g.gain.exponentialRampToValueAtTime(vol, t + at + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
          o.connect(g).connect(ctx.destination);
          o.start(t + at);
          o.stop(t + at + dur + 0.02);
        });
      }
    } catch {
      /* ohne Ton */
    }
  }

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const gesture = opts.gesture || (() => {});
    const body = document.body;
    const el = {
      layer: $('toolLayer'), hand: $('patHand'), hint: $('toolHint'), slow: $('slowChip'),
      whipBtn: $('whipBtn'), patBtn: $('patBtn'),
    };
    if (!el.layer) return null;
    const g = el.layer.getContext('2d');
    let tool = '';           // '', 'peitsche', 'lob'
    let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
    let last = { x: mouse.x, y: mouse.y };
    let speed = 0;
    let crack = -1;          // Zeitpunkt des Knalls (ms), -1 = keiner
    let cracked = false;
    let movedAt = performance.now();
    let frame = 0;
    let slowTimer = 0;
    let busySince = 0;
    let rope = [];

    function resetRope() {
      rope = Array.from({ length: SEGMENTS }, (_, i) => ({ x: mouse.x, y: mouse.y + i * SEG_LEN, px: mouse.x, py: mouse.y + i * SEG_LEN }));
    }

    function size() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.layer.width = Math.round(innerWidth * dpr);
      el.layer.height = Math.round(innerHeight * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ---------------------------------------------------------------- Werkzeug in die Hand nehmen

    function arm(kind) {
      if (tool === kind) {
        disarm();
        return;
      }
      disarm(true);
      tool = kind;
      body.dataset.tool = kind;
      movedAt = performance.now();
      if (kind === 'peitsche') {
        size();
        resetRope();
        el.layer.hidden = false;
      } else {
        el.hand.hidden = false;
        placeHand();
      }
      el.hint.hidden = false;
      el.hint.textContent = kind === 'peitsche' ? 'Klicken zum Antreiben · Esc legt die Peitsche weg' : 'Klicken zum Loben · Esc legt die Hand weg';
      placeHint();
      [el.whipBtn, el.patBtn].forEach((b) => b && b.setAttribute('aria-pressed', String(b.dataset.tool === kind)));
      hideSlow();
      if (!frame) frame = requestAnimationFrame(loop);
    }

    function disarm(quiet) {
      if (!tool && quiet) return;
      tool = '';
      delete body.dataset.tool;
      el.layer.hidden = true;
      el.hand.hidden = true;
      el.hint.hidden = true;
      g.clearRect(0, 0, el.layer.width, el.layer.height);
      [el.whipBtn, el.patBtn].forEach((b) => b && b.setAttribute('aria-pressed', 'false'));
    }

    function placeHand() {
      el.hand.style.transform = 'translate(' + (mouse.x - 28) + 'px,' + (mouse.y - 30) + 'px)';
    }

    function placeHint() {
      const x = Math.min(innerWidth - 300, mouse.x + 28);
      const y = Math.min(innerHeight - 40, mouse.y + 36);
      el.hint.style.transform = 'translate(' + Math.max(8, x) + 'px,' + Math.max(8, y) + 'px)';
    }

    // ---------------------------------------------------------------- die Peitsche zeichnen

    function handleAngle(now) {
      // Ruhig leicht nach rechts gekippt, mit der Bewegung schwingt sie mit; beim Knall schlägt sie nach vorne
      let a = -0.35 + Math.max(-0.5, Math.min(0.5, (mouse.x - last.x) * 0.02));
      if (crack >= 0) {
        const k = (now - crack) / 160;
        if (k < 1) a = -1.3 + 2.2 * Math.sin(Math.min(1, k) * Math.PI * 0.5);
      }
      return a;
    }

    function step(now) {
      const angle = handleAngle(now);
      const len = 64;
      const tip = { x: mouse.x + Math.sin(angle) * len, y: mouse.y - Math.cos(angle) * len };
      const swing = crack >= 0 && now - crack < 160;
      // Verlet: Schwerkraft und Trägheit, dann Länge der Glieder halten
      for (let i = 1; i < rope.length; i += 1) {
        const p = rope[i];
        const vx = (p.x - p.px) * 0.985;
        const vy = (p.y - p.py) * 0.985;
        p.px = p.x;
        p.py = p.y;
        p.x += vx;
        p.y += vy + 0.55;
        if (swing) {
          // der Schwung läuft von der Hand zur Spitze
          const push = (i / rope.length) * 9;
          p.x += Math.cos(angle) * push;
          p.y += Math.sin(angle) * push * 0.6;
        }
      }
      rope[0].x = tip.x;
      rope[0].y = tip.y;
      for (let n = 0; n < 6; n += 1) {
        for (let i = 1; i < rope.length; i += 1) {
          const a = rope[i - 1];
          const b = rope[i];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.001;
          const diff = (d - SEG_LEN) / d;
          if (i === 1) {
            b.x -= dx * diff;
            b.y -= dy * diff;
          } else {
            a.x += dx * diff * 0.5;
            a.y += dy * diff * 0.5;
            b.x -= dx * diff * 0.5;
            b.y -= dy * diff * 0.5;
          }
        }
        rope[0].x = tip.x;
        rope[0].y = tip.y;
      }
      return { angle, tip };
    }

    function drawWhip(now) {
      const { angle, tip } = step(now);
      g.clearRect(0, 0, innerWidth, innerHeight);
      // Seil: zur Spitze hin dünner
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let i = 1; i < rope.length; i += 1) {
        const a = rope[i - 1];
        const b = rope[i];
        g.strokeStyle = 'rgba(236, 240, 248, ' + (0.95 - i * 0.012).toFixed(3) + ')';
        g.lineWidth = Math.max(1.4, 5.2 - i * 0.17);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
      // Griff: goldener Zylinder mit Wicklung
      g.save();
      g.translate(mouse.x, mouse.y);
      g.rotate(angle);
      const grad = g.createLinearGradient(-6, 0, 6, 0);
      grad.addColorStop(0, '#8a5a12');
      grad.addColorStop(0.45, '#f4c75a');
      grad.addColorStop(1, '#9a6614');
      g.fillStyle = grad;
      g.beginPath();
      g.roundRect ? g.roundRect(-6, -64, 12, 64, 5) : g.rect(-6, -64, 12, 64);
      g.fill();
      g.strokeStyle = 'rgba(80, 48, 8, 0.6)';
      g.lineWidth = 1.2;
      for (let y = -54; y < -6; y += 6) {
        g.beginPath();
        g.moveTo(-6, y);
        g.lineTo(6, y + 3);
        g.stroke();
      }
      g.fillStyle = '#5b3a0b';
      g.beginPath();
      g.arc(0, -64, 5, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // Knall an der Spitze
      if (crack >= 0) {
        const k = (now - crack) / 1000;
        const end = rope[rope.length - 1];
        if (!cracked && k > 0.09) {
          cracked = true;
          sound('knall');
          shake();
          hit('peitsche', end.x, end.y);
        }
        if (k > 0.09 && k < 0.35) {
          const r = 10 + (k - 0.09) * 160;
          g.strokeStyle = 'rgba(255, 244, 214, ' + (1 - (k - 0.09) / 0.26).toFixed(3) + ')';
          g.lineWidth = 2;
          for (let i = 0; i < 8; i += 1) {
            const a = (i / 8) * Math.PI * 2;
            g.beginPath();
            g.moveTo(end.x + Math.cos(a) * r * 0.4, end.y + Math.sin(a) * r * 0.4);
            g.lineTo(end.x + Math.cos(a) * r, end.y + Math.sin(a) * r);
            g.stroke();
          }
        }
        if (k > 0.5) crack = -1;
      }
      void tip;
    }

    function loop(now) {
      frame = 0;
      if (!tool) return;
      if (now - movedAt > IDLE_SECONDS * 1000 && crack < 0) {
        disarm();
        return;
      }
      if (tool === 'peitsche') drawWhip(now);
      last = { x: last.x + (mouse.x - last.x) * 0.3, y: last.y + (mouse.y - last.y) * 0.3 };
      frame = requestAnimationFrame(loop);
    }

    // ---------------------------------------------------------------- treffen

    function shake() {
      if (reduced()) return;
      const hud = document.querySelector('.hud');
      if (!hud) return;
      hud.classList.remove('is-shaken');
      void hud.offsetWidth;
      hud.classList.add('is-shaken');
      setTimeout(() => hud.classList.remove('is-shaken'), 260);
    }

    function floatText(text, x, y, kind) {
      const n = document.createElement('div');
      n.className = 'hit-text hit-' + kind;
      n.textContent = text;
      n.style.left = Math.max(16, Math.min(innerWidth - 16, x)) + 'px';
      n.style.top = Math.max(24, y - 24) + 'px';
      document.body.append(n);
      setTimeout(() => n.remove(), reduced() ? 2400 : 2200);
    }

    function hearts(x, y) {
      for (let i = 0; i < 5; i += 1) {
        const h = document.createElement('i');
        h.className = 'pat-heart';
        h.style.left = x - 14 + (i - 2) * 22 + 'px';
        h.style.top = y - 44 - Math.abs(i - 2) * 6 + 'px';
        h.style.animationDelay = i * 90 + 'ms';
        document.body.append(h);
        setTimeout(() => h.remove(), 1500);
      }
    }

    function hit(kind, x, y) {
      gesture(kind === 'lob' ? 'thanks' : 'hint');
      call('feedback', kind).then((line) => {
        if (line) floatText(line, x, y, kind);
      }).catch(() => toast('Jarvis ist gerade nicht verbunden.', 'error'));
    }

    function pat() {
      el.hand.classList.remove('is-patting');
      void el.hand.offsetWidth;
      el.hand.classList.add('is-patting');
      sound('lob');
      hearts(mouse.x, mouse.y);
      hit('lob', mouse.x, mouse.y);
    }

    // ---------------------------------------------------------------- Maus und Tasten

    window.addEventListener('pointermove', (e) => {
      mouse = { x: e.clientX, y: e.clientY };
      movedAt = performance.now();
      if (!tool) return;
      speed = Math.hypot(e.movementX || 0, e.movementY || 0);
      if (tool === 'lob') placeHand();
      placeHint();
    }, { passive: true });

    window.addEventListener('pointerdown', (e) => {
      if (!tool) return;
      const target = e.target;
      if (target && target.closest && target.closest('#whipBtn, #patBtn, #slowChip')) return;
      if (e.button === 2) {
        disarm();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      movedAt = performance.now();
      if (tool === 'peitsche') {
        if (crack >= 0) return;
        crack = performance.now();
        cracked = false;
      } else {
        pat();
      }
    }, true);

    // Klicks, solange ein Werkzeug in der Hand ist, sollen nichts darunter auslösen
    window.addEventListener('click', (e) => {
      if (!tool) return;
      const target = e.target;
      if (target && target.closest && target.closest('#whipBtn, #patBtn, #slowChip')) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    window.addEventListener('contextmenu', (e) => {
      if (!tool) return;
      e.preventDefault();
      disarm();
    });

    window.addEventListener('keydown', (e) => {
      if (tool && e.key === 'Escape') {
        e.stopPropagation();
        disarm();
      }
    }, true);

    window.addEventListener('resize', () => {
      if (tool === 'peitsche') size();
    });

    if (el.whipBtn) el.whipBtn.addEventListener('click', () => arm('peitsche'));
    if (el.patBtn) el.patBtn.addEventListener('click', () => arm('lob'));
    if (el.slow) el.slow.addEventListener('click', () => arm('peitsche'));

    // ---------------------------------------------------------------- "Dauert's? Antreiben"

    function hideSlow() {
      clearTimeout(slowTimer);
      slowTimer = 0;
      if (el.slow) el.slow.hidden = true;
    }

    function state(value) {
      if (value === 'thinking') {
        if (!busySince) busySince = performance.now();
        if (!slowTimer && el.slow && el.slow.hidden && !tool) {
          slowTimer = setTimeout(() => {
            slowTimer = 0;
            if (document.body.dataset.state === 'thinking' && !tool && body.dataset.view === 'hud') el.slow.hidden = false;
          }, SLOW_SECONDS * 1000);
        }
      } else {
        busySince = 0;
        hideSlow();
      }
    }

    void speed;
    return { arm, disarm, state, active: () => tool };
  }

  window.JarvisAntreiber = { create };
})();
