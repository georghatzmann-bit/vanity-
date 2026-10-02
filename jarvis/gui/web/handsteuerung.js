/* ==========================================================================
   Jarvis – Handsteuerung
   Die Webcam erkennt die Hände (MediaPipe Hand Landmarker, läuft hier im Fenster: kein Kamerabild verlässt
   den PC). Gesten wie bei Tony Stark:
     Daumen und Zeigefinger zusammen (greifen) und ziehen  -> verschieben (Erde) oder drehen (Blaupause)
     mit beiden Händen greifen, auseinander oder zusammen  -> zoomen
     mit beiden Händen greifen und kippen                  -> drehen
   Ziel ist die Ansicht, die gerade offen ist (Weltlage oder Blaupause): Sie bekommt gesture({kind, ...}).
   Die Erkennung (etwa 10 MB) lädt beim ersten Mal aus dem Internet (jsdelivr und Google), danach aus dem
   Zwischenspeicher des Fensters.
   ========================================================================== */
(() => {
  'use strict';

  const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  const PINCH_ON = 0.34; // Daumen und Zeigefinger so nah (im Verhältnis zur Handgröße): gegriffen
  const PINCH_OFF = 0.5; // erst ab hier losgelassen (sonst flackert es)
  const GAIN = 1.7;
  const SMOOTH = 0.5;
  // So lange darf eine Hand kurz verschwinden, ohne dass der Griff abreißt: ein paar Kamerabilder
  // (auf langsamen PCs kommen die seltener, darum Bilder und nicht Millisekunden), höchstens 1,5 Sekunden
  const GRACE_FRAMES = 5;
  const GRACE_MS = 1500;
  const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let landmarker = null;
  let loading = null;
  let stream = null;
  let raf = 0;
  let on = false;
  let target = null;
  let opts = {};
  let ui = null;
  let hands = [];
  let pair = null;
  let lastVideoTime = -1;
  let lastStatus = '';

  function model() {
    if (landmarker) return Promise.resolve(landmarker);
    if (!loading) {
      loading = (async () => {
        const vision = await import(`${VISION}/vision_bundle.mjs`);
        const files = await vision.FilesetResolver.forVisionTasks(`${VISION}/wasm`);
        const make = (delegate) => vision.HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.6,
          minTrackingConfidence: 0.5,
        });
        try {
          return await make('GPU');
        } catch (e) {
          return make('CPU'); // ohne passende Grafikkarte etwas langsamer, geht aber
        }
      })();
    }
    return loading.then((m) => (landmarker = m)).catch((e) => {
      loading = null;
      throw e;
    });
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function buildUi() {
    const panel = el('section', 'hands');
    panel.setAttribute('aria-label', 'Handsteuerung');
    const head = el('header', 'hands-head');
    const title = el('b', '', 'Handsteuerung');
    const close = el('button', 'hands-x', '×');
    close.type = 'button';
    close.title = 'Handsteuerung beenden';
    close.setAttribute('aria-label', 'Handsteuerung beenden');
    close.addEventListener('click', () => stop());
    head.append(title, close);
    const view = el('div', 'hands-view');
    const video = el('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    const bones = el('canvas');
    bones.width = 320;
    bones.height = 240;
    view.append(video, bones);
    const status = el('p', 'hands-status');
    status.setAttribute('role', 'status');
    const help = el('p', 'hands-help',
      'Daumen und Zeigefinger zusammen: greifen und ziehen. Mit beiden Händen greifen: zoomen und drehen.');
    panel.append(head, view, status, help);
    const overlay = el('canvas', 'hands-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.append(panel, overlay);
    ui = { panel, video, bones, status, overlay, octx: overlay.getContext('2d'), bctx: bones.getContext('2d') };
    sizeOverlay();
  }

  function sizeOverlay() {
    if (!ui) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ui.overlay.width = Math.round(window.innerWidth * dpr);
    ui.overlay.height = Math.round(window.innerHeight * dpr);
    ui.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setStatus(text, error) {
    if (!ui || text === lastStatus) return;
    lastStatus = text;
    ui.status.textContent = text;
    ui.status.classList.toggle('error', !!error);
  }

  function cameraError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'Die Kamera ist nicht erlaubt. Im Fenster „Zulassen“ wählen, oder in Windows unter Einstellungen > '
        + 'Datenschutz > Kamera den Zugriff für Desktop-Apps einschalten.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Keine Webcam gefunden.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'Die Webcam benutzt gerade ein anderes Programm.';
    return 'Die Webcam ließ sich nicht starten.';
  }

  function fail(text) {
    setStatus(text, true);
    if (opts.toast) opts.toast(text, 'error');
    stopStream();
    cancelAnimationFrame(raf);
    on = false;
    if (opts.onChange) opts.onChange(false);
  }

  async function start(t, o) {
    if (on) {
      target = t || target;
      return true;
    }
    if (ui) stop(); // altes Fenster mit Fehlermeldung weg
    on = true;
    target = t;
    opts = o || {};
    buildUi();
    if (opts.onChange) opts.onChange(true);
    setStatus('Kamera wird gestartet …');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('-'), { name: 'NotFoundError' });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 30 } }, audio: false,
      });
    } catch (e) {
      fail(cameraError(e));
      return false;
    }
    if (!on || !ui) {
      stopStream();
      return false;
    }
    ui.video.srcObject = stream;
    try {
      await ui.video.play();
    } catch (e) { /* startet mit dem ersten Bild */ }
    setStatus('Handerkennung wird geladen …');
    try {
      await model();
    } catch (e) {
      fail('Die Handerkennung ließ sich nicht laden. Beim ersten Mal braucht sie Internet.');
      return false;
    }
    if (!on) return false;
    setStatus('Bereit. Halten Sie eine Hand in die Kamera.');
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    return true;
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((tr) => tr.stop());
      stream = null;
    }
  }

  function stop() {
    const was = on;
    on = false;
    cancelAnimationFrame(raf);
    stopStream();
    if (ui) {
      ui.panel.remove();
      ui.overlay.remove();
      ui = null;
    }
    hands = [];
    pair = null;
    lastStatus = '';
    target = null;
    if (was && opts.onChange) opts.onChange(false);
  }

  function send(g) {
    if (target && typeof target.gesture === 'function') {
      try {
        target.gesture(g);
      } catch (e) { /* die Ansicht ist gerade zu */ }
    }
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!on || !landmarker || !ui || document.hidden) return;
    const v = ui.video;
    if (v.readyState < 2 || v.currentTime === lastVideoTime) return;
    lastVideoTime = v.currentTime;
    let res = null;
    try {
      res = landmarker.detectForVideo(v, performance.now());
    } catch (e) {
      return;
    }
    analyse((res && res.landmarks) || []);
  }

  // Bildschirmpunkt einer Hand: gespiegelt (wie ein Spiegel) und die Mitte des Kamerabilds auf den ganzen
  // Bildschirm gestreckt, damit niemand bis an den Rand greifen muss
  function toScreen(p) {
    return {
      x: clamp((1 - p.x - 0.15) / 0.7, 0, 1) * window.innerWidth,
      y: clamp((p.y - 0.12) / 0.7, 0, 1) * window.innerHeight,
    };
  }

  function analyse(found) {
    const now = performance.now();
    const next = [];
    // Hände, die gerade kurz nicht erkannt wurden, bleiben einen Augenblick (sonst reißt der Griff ab)
    const known = hands.filter((h) => (h.miss || 0) <= GRACE_FRAMES && now - h.seen < GRACE_MS);
    for (const lm of found.slice(0, 2)) {
      const size = Math.max(1e-4, dist(lm[0], lm[9]));
      const pinchDist = dist(lm[4], lm[8]) / size;
      const point = toScreen({ x: (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 });
      let best = null;
      let bestD = Infinity;
      for (const h of known) {
        if (next.includes(h)) continue;
        const d = Math.hypot(h.x - point.x, h.y - point.y);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      const h = best && bestD < window.innerWidth * 0.3 ? best : { x: point.x, y: point.y, pinch: false, held: false };
      h.px = h.x;
      h.py = h.y;
      h.x += (point.x - h.x) * SMOOTH;
      h.y += (point.y - h.y) * SMOOTH;
      h.pinch = h.pinch ? pinchDist < PINCH_OFF : pinchDist < PINCH_ON;
      h.lm = lm;
      h.seen = now;
      h.miss = 0;
      h.visible = true;
      next.push(h);
    }
    for (const h of known) {
      if (!next.includes(h)) {
        h.visible = false;
        h.miss = (h.miss || 0) + 1;
        next.push(h);
      }
    }
    hands = next;
    const grab = hands.filter((h) => h.pinch && h.visible);
    if (grab.length >= 2) {
      const [a, b] = grab;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pair && d > 24 && pair.d > 24) {
        const f = d / pair.d;
        if (Math.abs(f - 1) > 0.004) send({ kind: 'zoom', factor: Math.pow(f, 1.5) });
        let da = ang - pair.ang;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        if (Math.abs(da) > 0.004) send({ kind: 'twist', angle: da });
        send({ kind: 'drag', dx: (mid.x - pair.mid.x) * GAIN * 0.6, dy: (mid.y - pair.mid.y) * GAIN * 0.6 });
      }
      pair = { d, ang, mid };
    } else {
      pair = null;
      const h = grab[0];
      if (h && h.held) send({ kind: 'drag', dx: (h.x - h.px) * GAIN, dy: (h.y - h.py) * GAIN });
    }
    hands.forEach((h) => {
      if (h.visible) h.held = h.pinch;
    });
    draw();
    if (grab.length >= 2) setStatus('Beide Hände greifen: zoomen und drehen.');
    else if (grab.length === 1) setStatus('Gegriffen: ziehen zum Bewegen.');
    else if (hands.some((h) => h.visible)) setStatus('Hand erkannt. Zum Greifen Daumen und Zeigefinger zusammen.');
    else setStatus('Halten Sie eine Hand in die Kamera.');
  }

  function draw() {
    if (!ui) return;
    const o = ui.octx;
    o.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const seen = hands.filter((h) => h.visible);
    const grab = seen.filter((h) => h.pinch);
    if (grab.length >= 2) {
      o.strokeStyle = 'rgba(126, 232, 255, 0.55)';
      o.lineWidth = 2;
      o.setLineDash([6, 6]);
      o.beginPath();
      o.moveTo(grab[0].x, grab[0].y);
      o.lineTo(grab[1].x, grab[1].y);
      o.stroke();
      o.setLineDash([]);
    }
    for (const h of seen) {
      o.beginPath();
      o.arc(h.x, h.y, h.pinch ? 14 : 20, 0, Math.PI * 2);
      o.lineWidth = 2;
      o.strokeStyle = '#7ee8ff';
      o.fillStyle = h.pinch ? 'rgba(126, 232, 255, 0.45)' : 'rgba(126, 232, 255, 0.08)';
      o.fill();
      o.stroke();
      o.beginPath();
      o.arc(h.x, h.y, 3, 0, Math.PI * 2);
      o.fillStyle = '#e6f9ff';
      o.fill();
    }
    // Das Skelett über dem kleinen Kamerabild (beides per CSS gespiegelt)
    const b = ui.bctx;
    const w = ui.bones.width;
    const hgt = ui.bones.height;
    b.clearRect(0, 0, w, hgt);
    for (const h of seen) {
      b.strokeStyle = h.pinch ? '#7ee8ff' : 'rgba(126, 232, 255, 0.7)';
      b.lineWidth = 2;
      b.beginPath();
      for (const [i, j] of BONES) {
        b.moveTo(h.lm[i].x * w, h.lm[i].y * hgt);
        b.lineTo(h.lm[j].x * w, h.lm[j].y * hgt);
      }
      b.stroke();
      b.fillStyle = '#e6f9ff';
      for (const p of h.lm) {
        b.fillRect(p.x * w - 1.5, p.y * hgt - 1.5, 3, 3);
      }
    }
  }

  window.addEventListener('resize', sizeOverlay);

  window.JarvisHands = {
    start,
    stop,
    isOn: () => on,
    retarget: (t) => {
      target = t;
    },
    target: () => target,
    _feed: (landmarks) => analyse(landmarks || []), // nur für Tests: Handpunkte ohne Kamera einspeisen
  };
})();
