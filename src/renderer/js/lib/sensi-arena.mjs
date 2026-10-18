// Sensi-Kalibrierung: die Test-Arena (Canvas + Mausfang). Zeichnet, was TestSession vorgibt,
// und gibt rohe Mausbewegungen und Klicks an die Session weiter.
//
// Mausfang: requestPointerLock({ unadjustedMovement: true }) = Rohdaten ohne Windows-Beschleunigung.
// Geht das nicht, normaler Mausfang. Esc gibt die Maus frei und pausiert; noch einmal Esc bricht ab.
// Bild: Ziele liegen als Winkel (yaw/pitch) im Raum, Projektion wie Fortnite (80° horizontal bei 16:9).

import { cameraBasis, toCamera, dirVec, projectCam, focalPx, VFOV_DEG, clamp } from './sensi-math.mjs';
import { ZONE } from './sensi-rounds.mjs';
import { ROUND_INFO, createSpikeFilter } from './sensi-session.mjs';

const RAD = Math.PI / 180;
const ACCENT = '79, 216, 255';

/** Zeichnet ein Bild der Arena. Ohne DOM-Zugriff außer dem Canvas-Kontext (auch für Vorschaubilder). */
export function drawScene(g, W, H, view, fx = {}) {
  const dpr = fx.dpr || 1;
  const f = focalPx(H, VFOV_DEG);
  const cam = view.cam || { yaw: 0, pitch: 0 };
  const basis = cameraBasis(cam.yaw, cam.pitch);
  const project = (v) => projectCam(toCamera(v, basis), W, H, f);

  // Himmel und Boden (ohne Rollen ist der Horizont immer waagerecht)
  const hy = clamp(H / 2 + f * Math.tan(cam.pitch * RAD), -H, 2 * H);
  const sky = g.createLinearGradient(0, Math.min(0, hy - H), 0, Math.max(1, hy));
  sky.addColorStop(0, '#04060b');
  sky.addColorStop(1, '#0b1322');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, clamp(hy, 0, H));
  if (hy < H) {
    const floor = g.createLinearGradient(0, Math.max(0, hy), 0, H);
    floor.addColorStop(0, '#0a101b');
    floor.addColorStop(1, '#05070c');
    g.fillStyle = floor;
    g.fillRect(0, clamp(hy, 0, H), W, H - clamp(hy, 0, H));
  }

  // Bodenraster (Ebene unter dem Spieler) – Linien werden an der Kamera-Ebene abgeschnitten
  const EYE = 1.6; const SPAN = 48; const STEP = 3;
  g.lineWidth = Math.max(1, dpr);
  const seg = (a, b, alpha) => {
    let ca = toCamera(a, basis); let cb = toCamera(b, basis);
    const near = 0.05;
    if (ca[2] < near && cb[2] < near) return;
    if (ca[2] < near || cb[2] < near) {
      const t = (near - ca[2]) / (cb[2] - ca[2]);
      const c = [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, near];
      if (ca[2] < near) ca = c; else cb = c;
    }
    const pa = projectCam(ca, W, H, f); const pb = projectCam(cb, W, H, f);
    if (!pa || !pb) return;
    g.strokeStyle = `rgba(${ACCENT}, ${alpha})`;
    g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); g.stroke();
  };
  for (let i = -SPAN; i <= SPAN; i += STEP) {
    const a = 0.10 * (1 - Math.abs(i) / (SPAN + STEP));
    seg([i, -EYE, -SPAN], [i, -EYE, 0], a);
    seg([i, -EYE, 0], [i, -EYE, SPAN], a);
    seg([-SPAN, -EYE, i], [0, -EYE, i], a);
    seg([0, -EYE, i], [SPAN, -EYE, i], a);
  }

  // Horizont
  if (hy > 0 && hy < H) {
    g.strokeStyle = `rgba(${ACCENT}, 0.22)`;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.moveTo(0, hy); g.lineTo(W, hy); g.stroke();
  }

  // Rahmen des Zielbereichs (zur Orientierung)
  const fy = ZONE.yaw + 3; const fp = ZONE.pitch + 3;
  const edge = [];
  for (let y = -fy; y <= fy; y += 2) edge.push([y, fp]);
  for (let p = fp; p >= -fp; p -= 2) edge.push([fy, p]);
  for (let y = fy; y >= -fy; y -= 2) edge.push([y, -fp]);
  for (let p = -fp; p <= fp; p += 2) edge.push([-fy, p]);
  g.strokeStyle = `rgba(${ACCENT}, 0.16)`;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  let pen = false;
  for (const [y, p] of edge) {
    const s = project(dirVec(y, p));
    if (!s || Math.abs(s.x) > 4 * W || Math.abs(s.y) > 4 * H) { pen = false; continue; }
    if (pen) g.lineTo(s.x, s.y); else { g.moveTo(s.x, s.y); pen = true; }
  }
  g.stroke();

  // Ziele
  const now = fx.now || 0;
  for (const t of view.targets || []) {
    const c = toCamera(dirVec(t.yaw, t.pitch), basis);
    const s = c[2] > 0.02 ? projectCam(c, W, H, f) : null;
    const r = s ? (f * Math.tan(t.radius * RAD)) / Math.max(0.2, c[2]) : 0;
    if (!s || s.x < -r || s.x > W + r || s.y < -r || s.y > H + r) { offscreen(g, W, H, c, dpr); continue; }
    const hot = view.roundType === 'tracking' ? !!t.hot : false;
    g.save();
    g.shadowColor = `rgba(${ACCENT}, ${hot ? 0.95 : 0.7})`;
    g.shadowBlur = (hot ? 26 : 18) * dpr;
    const grad = g.createRadialGradient(s.x - r * 0.25, s.y - r * 0.3, r * 0.1, s.x, s.y, r);
    if (view.roundType === 'tracking' && !hot) {
      grad.addColorStop(0, `rgba(${ACCENT}, 0.55)`);
      grad.addColorStop(1, `rgba(${ACCENT}, 0.18)`);
    } else {
      grad.addColorStop(0, '#f2fdff');
      grad.addColorStop(0.45, '#8ce8ff');
      grad.addColorStop(1, `rgba(${ACCENT}, 0.55)`);
    }
    g.fillStyle = grad;
    g.beginPath(); g.arc(s.x, s.y, r, 0, Math.PI * 2); g.fill();
    g.restore();
    g.strokeStyle = `rgba(${ACCENT}, ${hot ? 1 : 0.9})`;
    g.lineWidth = Math.max(1.5, 1.5 * dpr);
    g.beginPath(); g.arc(s.x, s.y, r + 2 * dpr, 0, Math.PI * 2); g.stroke();
  }

  // Treffer-Ringe (kurz, ≤ 180 ms)
  for (const e of fx.hits || []) {
    const age = now - e.at;
    if (age < 0 || age > 180) continue;
    const c = toCamera(dirVec(e.yaw, e.pitch), basis);
    const s = c[2] > 0.02 ? projectCam(c, W, H, f) : null;
    if (!s) continue;
    const r0 = (f * Math.tan(e.radius * RAD)) / Math.max(0.2, c[2]);
    const k = age / 180;
    g.strokeStyle = `rgba(${ACCENT}, ${0.8 * (1 - k)})`;
    g.lineWidth = Math.max(1.5, 2 * dpr);
    g.beginPath(); g.arc(s.x, s.y, r0 * (1 + 0.8 * k), 0, Math.PI * 2); g.stroke();
  }

  crosshair(g, W / 2, H / 2, dpr, now - (fx.hitAt ?? -1e9) < 120);
}

function offscreen(g, W, H, c, dpr) {
  // kleiner Pfeil am Rand in Richtung des Ziels
  const ang = Math.atan2(-c[1], c[0]);
  const rx = W / 2 - 28 * dpr; const ry = H / 2 - 28 * dpr;
  const x = W / 2 + Math.cos(ang) * rx; const y = H / 2 + Math.sin(ang) * ry;
  g.save();
  g.translate(x, y); g.rotate(ang);
  g.fillStyle = `rgba(${ACCENT}, 0.75)`;
  g.beginPath(); g.moveTo(10 * dpr, 0); g.lineTo(-6 * dpr, -7 * dpr); g.lineTo(-6 * dpr, 7 * dpr); g.closePath(); g.fill();
  g.restore();
}

function crosshair(g, x, y, dpr, hitMarker) {
  const gap = 4 * dpr; const len = 7 * dpr; const w = 2 * dpr;
  const lines = [[x - gap - len, y, x - gap, y], [x + gap, y, x + gap + len, y], [x, y - gap - len, x, y - gap], [x, y + gap, x, y + gap + len]];
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  g.lineWidth = w + 2 * dpr;
  g.beginPath(); for (const l of lines) { g.moveTo(l[0], l[1]); g.lineTo(l[2], l[3]); } g.stroke();
  g.strokeStyle = '#ffffff';
  g.lineWidth = w;
  g.beginPath(); for (const l of lines) { g.moveTo(l[0], l[1]); g.lineTo(l[2], l[3]); } g.stroke();
  g.fillStyle = '#ffffff';
  g.fillRect(x - dpr, y - dpr, 2 * dpr, 2 * dpr);
  if (hitMarker) {
    const a = 7 * dpr; const b = 13 * dpr;
    g.strokeStyle = `rgba(${ACCENT}, 1)`;
    g.lineWidth = w;
    g.beginPath();
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { g.moveTo(x + sx * a, y + sy * a); g.lineTo(x + sx * b, y + sy * b); }
    g.stroke();
  }
}

/** Mausfang mit Rohdaten, sonst normal. Gibt 'raw' oder 'normal' zurück; wirft, wenn gar nichts geht. */
export async function lockPointer(el) {
  if (typeof el.requestPointerLock !== 'function') {
    const e = new Error('Mausfang wird hier nicht unterstützt.');
    e.code = 'NO_POINTER_LOCK';
    throw e;
  }
  try {
    const p = el.requestPointerLock({ unadjustedMovement: true });
    if (p && typeof p.then === 'function') { await p; return 'raw'; }
    return 'normal'; // alte Schnittstelle ohne Rückmeldung: Rohdaten nicht sicher
  } catch (e) {
    if (e && e.name === 'NotSupportedError') {
      const p = el.requestPointerLock();
      if (p && typeof p.then === 'function') await p;
      return 'normal';
    }
    throw e;
  }
}

export const MODE_TEXT = {
  raw: 'Rohdaten (ohne Windows-Beschleunigung)',
  normal: 'normal',
};

/**
 * Baut die Arena. h = Element-Baukasten aus ui.js.
 * session: TestSession. Rückruf onFinish(outcome) am Ende, onAbort() bei Esc/Abbrechen, onMode(mode).
 */
export function createArena({ h, session, dpi, onFinish, onAbort, onMode, sound }) {
  const canvas = h('canvas.sensi-canvas', { 'aria-label': 'Aim-Test-Feld', role: 'img' });
  const progress = h('div.sensi-progress');
  const hudLeft = h('span.sensi-hud-left');
  const hudMid = h('span.sensi-hud-mid');
  const hudRight = h('span.sensi-hud-right');
  const hud = h('div.sensi-hud', hudLeft, hudMid, hudRight);
  const bannerTitle = h('strong');
  const bannerText = h('span');
  const banner = h('div.sensi-banner', { 'aria-live': 'polite' }, bannerTitle, bannerText);
  const ovTitle = h('h2');
  const ovText = h('div.sensi-overlay-text');
  const ovError = h('p.sensi-err', { role: 'alert' });
  const ovCard = h('div.sensi-overlay-card', ovTitle, ovText, ovError);
  const overlay = h('div.sensi-overlay', { role: 'button', tabindex: '0', 'aria-label': 'Klicke zum Starten' }, ovCard);
  const el = h('div.sensi-arena', canvas, progress, hud, banner, overlay);

  const g = canvas.getContext('2d');
  const filter = createSpikeFilter({ dpi: dpi || session.dpi });
  let state = 'idle'; // idle | running | paused | switch | finished
  let mode = null;
  let rawAll = true;
  let acc = 0; let since = null;
  let raf = 0;
  let lockLostAt = -1e9;
  let locking = false;
  const hits = [];
  let hitAt = -1e9;
  let lastHud = '';
  let destroyed = false;

  const perf = () => performance.now();
  const T = () => acc + (since != null ? perf() - since : 0);
  const pauseClock = () => { acc = T(); since = null; };
  const runClock = () => { if (since == null) since = perf(); };
  const locked = () => document.pointerLockElement === canvas;

  function setOverlay(kind, error = '') {
    ovError.textContent = error;
    if (!kind) { overlay.hidden = true; return; }
    overlay.hidden = false;
    const v = session.view();
    const lines = [];
    if (kind === 'start') {
      ovTitle.textContent = 'Klicke zum Starten – Esc zum Abbrechen';
      overlay.setAttribute('aria-label', 'Klicke zum Starten');
      lines.push('Die Maus wird eingefangen, solange der Test läuft. Du siehst dann keinen Mauszeiger.');
      lines.push(`Ablauf: kurz aufwärmen, dann ${v.blockCount} Durchgänge mit je Flicks, Tracking und bewegten Zielen.`);
      lines.push(session.plan.mode === 'dpi'
        ? 'Zwischendurch bittet dich HELIX, die DPI an der Maus umzustellen.'
        : 'In jedem Durchgang ist die Sensi etwas anders. Welche, siehst du erst am Ende.');
      lines.push('Mit Esc pausierst du jederzeit.');
    } else if (kind === 'paused') {
      ovTitle.textContent = 'Pause';
      overlay.setAttribute('aria-label', 'Klicke zum Weitermachen');
      lines.push('Klicke zum Weitermachen – Esc zum Abbrechen.');
      lines.push(v.warmup ? 'Gerade: Aufwärmen.' : `Gerade: Durchgang ${v.blockNo} von ${v.blockCount}.`);
    } else if (kind === 'switch') {
      ovTitle.textContent = `Stell deine Maus jetzt auf ${v.switchDpi} DPI um`;
      overlay.setAttribute('aria-label', 'Klicke, wenn du die DPI umgestellt hast');
      lines.push('Meist geht das mit der DPI-Taste unter dem Mausrad oder in der Software deiner Maus.');
      lines.push('HELIX passt die Sensi selbst an, damit eine Drehung gleich weit bleibt.');
      lines.push('Klicke hier, wenn du fertig bist – Esc zum Abbrechen.');
    }
    ovText.replaceChildren(...lines.map((t) => h('p', t)));
  }

  function setBanner(title, text) {
    if (!title) { banner.classList.remove('show'); return; }
    bannerTitle.textContent = title;
    bannerText.textContent = text || '';
    banner.classList.add('show');
  }

  function updateHud(v) {
    const left = v.warmup ? 'Aufwärmen – zählt nicht' : `Durchgang ${v.blockNo} von ${v.blockCount}`;
    const info = v.roundType ? ROUND_INFO[v.roundType] : null;
    const mid = info ? `${info.name} · Teil ${v.roundIndex + 1} von ${v.roundCount}` : '';
    let right = '';
    if (v.live && v.roundType === 'tracking') right = `Auf dem Ziel: ${v.live.trackingPct} %`;
    else if (v.live) right = `Treffer ${v.live.hits} · Daneben ${v.live.misses}`;
    const key = `${left}|${mid}|${right}|${Math.round(v.roundProgress * 200)}`;
    if (key === lastHud) return;
    lastHud = key;
    hudLeft.textContent = left;
    hudMid.textContent = mid;
    hudRight.textContent = right;
    progress.style.width = `${(v.roundProgress * 100).toFixed(1)}%`;
  }

  function resize() {
    const r = el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)); const hh = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
    render();
  }

  function render() {
    if (destroyed) return;
    const v = session.view();
    const now = perf();
    while (hits.length && now - hits[0].at > 200) hits.shift();
    drawScene(g, canvas.width, canvas.height, v, { dpr: Math.min(2, window.devicePixelRatio || 1), now, hits, hitAt });
    updateHud(v);
    if (state === 'running') {
      if (v.phase === 'round' && v.inLeadIn) {
        const info = ROUND_INFO[v.roundType];
        setBanner(`${info.name}`, info.task);
      } else if (v.phase === 'interlude') {
        if (v.warmup) setBanner('Aufwärmen geschafft', 'Jetzt zählt es. Gleich geht es los.');
        else setBanner(`Durchgang ${v.blockNo} von ${v.blockCount} geschafft`, session.plan.mode === 'dpi' ? 'Gleich geht es weiter.' : 'Gleich geht es mit einer anderen Sensi weiter.');
      } else setBanner(null);
    } else setBanner(null);
  }

  function handleEvents(events) {
    for (const e of events) {
      if (e.type === 'switch') {
        state = 'switch';
        pauseClock();
        if (locked()) document.exitPointerLock();
        filter.setDpi(e.dpi);
        setOverlay('switch');
      } else if (e.type === 'done') {
        state = 'finished';
        pauseClock();
        if (locked()) document.exitPointerLock();
        session.rawInput = rawAll && mode === 'raw';
        cancelAnimationFrame(raf);
        render();
        onFinish?.(session.outcome());
        return;
      }
    }
  }

  function loop() {
    if (destroyed || state === 'finished') return;
    if (state === 'running') handleEvents(session.update(T()));
    render();
    raf = requestAnimationFrame(loop);
  }

  async function requestLock() {
    if (locking || state === 'finished' || locked()) return;
    if (perf() - lockLostAt < 900) { setOverlay(state === 'idle' ? 'start' : state, 'Einen Moment – dann noch einmal klicken.'); return; }
    locking = true;
    ovError.textContent = '';
    try {
      const m = await lockPointer(canvas);
      if (destroyed) return;
      if (m !== 'raw') rawAll = false;
      mode = m;
      onMode?.(m);
    } catch (e) {
      if (!destroyed) {
        const msg = e && e.code === 'NO_POINTER_LOCK'
          ? 'Dein System kann die Maus hier nicht einfangen. Der Test geht deshalb nicht.'
          : 'Die Maus konnte nicht eingefangen werden. Klicke noch einmal ins Feld.';
        setOverlay(state === 'idle' ? 'start' : state, msg);
      }
    } finally {
      locking = false;
    }
  }

  function onLockChange() {
    if (destroyed) return;
    if (locked()) {
      if (state === 'idle') { handleEvents(session.start(T())); if (state === 'idle') state = 'running'; }
      else if (state === 'paused') state = 'running';
      else if (state === 'switch') { state = 'running'; handleEvents(session.confirmSwitch(T())); }
      if (state === 'running') { runClock(); setOverlay(null); }
      return;
    }
    lockLostAt = perf();
    if (state === 'running') {
      state = 'paused';
      pauseClock();
      setOverlay('paused');
      render();
    }
  }

  function onLockError() {
    if (destroyed) return;
    setOverlay(state === 'idle' ? 'start' : state === 'running' ? 'paused' : state, 'Die Maus konnte nicht eingefangen werden. Klicke noch einmal ins Feld.');
  }

  function onMove(e) {
    if (state !== 'running' || !locked()) return;
    const dx = e.movementX || 0; const dy = e.movementY || 0;
    if (!dx && !dy) return;
    if (!filter.accept(dx, dy)) return;
    session.move(dx, dy, T());
  }

  function onDown(e) {
    if (state !== 'running' || !locked() || e.button !== 0) return;
    e.preventDefault();
    const r = session.shoot(T());
    if (r.result === 'hit' && r.target) {
      const at = perf();
      hits.push({ ...r.target, at });
      hitAt = at;
      sound?.('click');
    }
  }

  function abort() {
    if (state === 'finished') return;
    state = 'finished';
    if (locked()) document.exitPointerLock();
    cancelAnimationFrame(raf);
    onAbort?.();
  }

  function onKey(e) {
    if (destroyed || state === 'finished') return;
    if (e.key === 'Escape') {
      // nie an die App weitergeben (die würde sonst zum Cockpit springen)
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      if (locked()) { document.exitPointerLock(); return; }
      if (perf() - lockLostAt < 500) return; // dieselbe Esc-Taste hat gerade den Mausfang beendet
      abort();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && !locked() && document.activeElement === overlay) {
      e.preventDefault();
      requestLock();
    }
  }

  function onBlur() {
    if (state === 'running' && locked()) document.exitPointerLock();
  }

  overlay.addEventListener('click', () => requestLock());
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockError);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mousedown', onDown);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(el);

  setOverlay('start');
  requestAnimationFrame(() => { resize(); raf = requestAnimationFrame(loop); });

  return {
    el,
    get state() { return state; },
    get mode() { return mode; },
    focus() { overlay.focus(); },
    abort,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(raf);
      if (locked()) document.exitPointerLock();
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('pointerlockerror', onLockError);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      ro?.disconnect();
    },
  };
}
