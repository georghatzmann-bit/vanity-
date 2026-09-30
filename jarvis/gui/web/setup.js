/* ==========================================================================
   J.A.R.V.I.S. – Einrichtung
   Spricht über window.pywebview.api mit setup_wizard.SetupApi (Python).
   Ohne pywebview (normaler Browser) läuft ein Demo-Modus mit Beispieldaten.
   Texte aus Python kommen nur als Klartext (textContent) auf die Seite.
   ========================================================================== */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const params = new URLSearchParams(location.search);
  const motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(motionMQ && motionMQ.matches);

  // ------------------------------------------------------------------ Schritte

  const STEPS = [
    {
      id: 'welcome', nav: 'Willkommen', eyebrow: 'Willkommen',
      title: 'Guten Tag, Sir.',
      lead: 'Ich bin J.A.R.V.I.S., Ihr Sprachassistent am PC.',
      next: 'Einrichtung starten',
    },
    {
      id: 'mic', nav: 'Mikrofon', eyebrow: 'Mikrofon',
      title: 'Womit soll ich Sie hören?',
      lead: 'Klicken Sie Ihr Mikrofon an und sprechen Sie. Der Balken zeigt sofort, ob es Sie hört.',
    },
    {
      id: 'voice', nav: 'Stimme', eyebrow: 'Stimme',
      title: 'Wie soll ich klingen?',
      lead: 'Hören Sie die Stimmen probe und wählen Sie Ihren Favoriten.',
    },
    {
      id: 'place', nav: 'Wohnort', eyebrow: 'Wohnort',
      title: 'Wo sind Sie zu Hause?',
      lead: 'Für das Wetter und alles, was mit Ihrer Umgebung zu tun hat.',
    },
    {
      id: 'claude', nav: 'Claude', eyebrow: 'Gehirn',
      title: 'Mein Gehirn verbinden',
      lead: 'Jarvis denkt mit Claude Code. Ich frage Claude kurz, ob alles bereit ist.',
    },
    {
      id: 'extras', nav: 'Extras', eyebrow: 'Extras',
      title: 'Noch ein paar Extras',
      lead: 'Alles hier ist freiwillig und lässt sich später ändern.',
    },
    {
      id: 'done', nav: 'Fertig', eyebrow: 'Fertig',
      title: 'Alle Systeme bereit, Sir.',
      lead: 'So habe ich mich eingerichtet. Ein Klick auf eine Kachel führt zurück zu dem Schritt.',
      next: 'Jarvis starten',
    },
  ];
  const INDEX = Object.fromEntries(STEPS.map((s, i) => [s.id, i]));

  const CLAUDE_TEXT = {
    idle:    ['Noch nicht geprüft', 'Jarvis fragt Claude einmal, ob alles funktioniert.'],
    running: ['Ich frage Claude …', 'Das dauert meistens ein paar Sekunden.'],
    ok:      ['Claude antwortet', ''],
    missing: ['Claude Code fehlt', ''],
    login:   ['Noch nicht angemeldet', ''],
    refused: ['Claude hat abgelehnt', ''],
    error:   ['Das hat nicht geklappt', ''],
  };

  // ------------------------------------------------------------------ Zustand

  const S = {
    step: 0,
    visited: new Set([0]),
    hello: null,
    first: true,
    mic: {
      list: null, selected: undefined, savedName: '', loading: false,
      running: false, polling: false, startedAt: 0, maxLevel: 0, threshold: 0.5, detected: false,
    },
    voices: [], voice: '', playing: '',
    place: { saved: '', lastChecked: '', result: null },
    claude: { state: 'idle', message: '', model: '', version: '', polling: false },
    hotkeys: [], hotkey: '', autostart: false,
    ha: { url: '', tokenSet: false, echos: [] },
    finishing: false,
  };

  // ------------------------------------------------------------------ Brücke

  let api = null;
  let demo = false;

  function call(name, ...args) {
    if (!api || typeof api[name] !== 'function') {
      return Promise.reject(new Error('Einrichtung nicht verbunden: ' + name));
    }
    try {
      return Promise.resolve(api[name](...args)).then((v) => {
        if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
          try { return JSON.parse(v); } catch { return v; }
        }
        return v;
      });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  const realApi = new Proxy({}, {
    get(_t, name) {
      return (...args) => window.pywebview.api[name](...args);
    },
  });

  function realReady() {
    try {
      return !!(window.pywebview && window.pywebview.api && typeof window.pywebview.api.hello === 'function');
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ Hinweise

  function toast(text, kind) {
    const box = $('toasts');
    const isErr = kind === 'error';
    const t = document.createElement('div');
    t.className = 'toast ' + (isErr ? 'toast-error' : 'toast-info');
    t.setAttribute('role', isErr ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = isErr ? '!' : 'i';
    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = String(text == null ? '' : text);
    t.append(icon, body);
    box.append(t);
    while (box.childElementCount > 3) box.firstElementChild.remove();
    const hide = () => {
      if (!t.isConnected || t.classList.contains('out')) return;
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    };
    setTimeout(hide, isErr ? 6500 : 3800);
    t.addEventListener('click', hide);
  }

  function failed(err) {
    console.warn('Jarvis-Einrichtung:', err);
    toast('Da ist etwas schiefgelaufen. Bitte noch einmal versuchen.', 'error');
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svg(markup) {
    const t = document.createElement('template');
    t.innerHTML = markup.trim(); // nur feste Symbole aus diesem Skript, nie Text von außen
    return t.content.firstChild;
  }

  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7.5"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/></svg>',
    headset: '<svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3.5" y="13.5" width="4" height="6" rx="1.5"/><rect x="16.5" y="13.5" width="4" height="6" rx="1.5"/><path d="M18.5 19.5c0 1.5-2 2-4.5 2"/></svg>',
    cam: '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="6"/><circle cx="12" cy="10" r="2.2"/><path d="M8 20h8M12 16v4"/></svg>',
    laptop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/><path d="M10 10h.01M12 10h.01M14 10h.01"/></svg>',
    windows: '<svg viewBox="0 0 24 24"><path d="M4 5.5 11 4.5v7H4zM13 4.2l7-1.2v8.5h-7zM4 13h7v7l-7-1zM13 13h7v8l-7-1.2z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  };

  // ------------------------------------------------------------------ Arc Reactor (Canvas)

  const reactors = [];

  function reactor(canvas, opts) {
    const ctx = canvas.getContext('2d');
    const r = {
      canvas, ctx, w: 0, h: 0, dpr: 1,
      color: (opts.color || [79, 216, 255]).slice(),
      target: (opts.color || [79, 216, 255]).slice(),
      spin: opts.spin || 1, spinTarget: opts.spin || 1,
      mode: opts.mode || 'idle',
      level: 0, levelTarget: 0,
      boot: opts.boot === false ? 1 : 0,
      small: !!opts.small,
      a: [0, 0, 0, 0],
      set(o) {
        if (o.color) this.target = o.color.slice();
        if (o.spin != null) this.spinTarget = o.spin;
        if (o.mode) this.mode = o.mode;
        if (o.level != null) this.levelTarget = clamp(o.level, 0, 1);
      },
    };
    const fit = () => {
      const b = canvas.getBoundingClientRect();
      r.dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      r.w = Math.max(1, b.width);
      r.h = Math.max(1, b.height);
      const cw = Math.round(r.w * r.dpr);
      const ch = Math.round(r.h * r.dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    };
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas);
    reactors.push(r);
    return r;
  }

  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;

  function drawReactor(r, dt, t) {
    if (!r.canvas.isConnected || r.canvas.offsetParent === null) return;
    const k = 1 - Math.exp(-dt / 0.25);
    for (let i = 0; i < 3; i++) r.color[i] += (r.target[i] - r.color[i]) * k;
    r.spin += (r.spinTarget - r.spin) * k;
    r.level += (r.levelTarget - r.level) * (1 - Math.exp(-dt / 0.08));
    r.boot = Math.min(1, r.boot + dt / (reducedMotion() ? 0.3 : 1.4));
    const sf = reducedMotion() ? 0.25 : 1;
    r.a[0] += dt * 0.12 * r.spin * sf;
    r.a[1] -= dt * 0.45 * r.spin * sf;
    r.a[2] += dt * 0.8 * r.spin * sf;
    r.a[3] += dt * (r.mode === 'run' ? 4.2 : 0) * sf;

    const { ctx, w, h, dpr } = r;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const ease = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
    const R = Math.min(w, h) * 0.46 * (0.9 + 0.1 * ease(r.boot));
    if (R < 6) return;
    const C = r.color;
    const breathe = 0.5 - 0.5 * Math.cos(t * 1.4);
    const B = (0.78 + 0.22 * breathe + r.level * 0.5) * ease(r.boot * 1.2);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';

    // Außenring mit Skala
    ctx.strokeStyle = rgba(C, 0.18 * B);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    if (!r.small) {
      const n = 72;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const ang = r.a[0] + (i * Math.PI * 2) / n;
        const r1 = R * (i % 6 === 0 ? 0.9 : 0.93);
        ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        ctx.lineTo(cx + Math.cos(ang) * R * 0.97, cy + Math.sin(ang) * R * 0.97);
      }
      ctx.strokeStyle = rgba(C, 0.35 * B);
      ctx.stroke();
    }

    // Segmentring
    {
      const rr = R * 0.8;
      const segs = [[0, 1.1], [1.35, 0.55], [2.1, 1.2], [3.55, 0.35], [4.1, 1.3], [5.6, 0.45]];
      const lw = Math.max(2, R * 0.05);
      ctx.beginPath();
      for (const [st, len] of segs) {
        const a0 = st + r.a[1];
        ctx.moveTo(cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr);
        ctx.arc(cx, cy, rr, a0, a0 + len);
      }
      ctx.strokeStyle = rgba(C, 0.14 * B);
      ctx.lineWidth = lw * 3;
      ctx.stroke();
      ctx.strokeStyle = rgba(C, 0.85 * B);
      ctx.lineWidth = lw;
      ctx.stroke();
    }

    // Suchlauf beim Prüfen
    if (r.mode === 'run') {
      const rr = R * 0.66;
      for (let i = 0; i < 14; i++) {
        const a0 = r.a[3] - i * 0.07;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, a0 - 0.07, a0);
        ctx.strokeStyle = rgba(C, (1 - i / 14) * 0.9 * B);
        ctx.lineWidth = Math.max(2, R * 0.035);
        ctx.stroke();
      }
    } else {
      ctx.setLineDash([Math.max(2, R * 0.04), Math.max(2, R * 0.05)]);
      ctx.lineDashOffset = -r.a[2] * R * 0.2;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.66, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(C, 0.35 * B);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Spulen
    {
      const n = r.small ? 8 : 10;
      const r1 = R * 0.36;
      const r2 = R * 0.52;
      for (let i = 0; i < n; i++) {
        const mid = (i * Math.PI * 2) / n - r.a[0] * 0.5;
        const half = (Math.PI / n) * 0.62;
        ctx.beginPath();
        ctx.arc(cx, cy, r2, mid - half, mid + half);
        ctx.arc(cx, cy, r1, mid + half * 0.85, mid - half * 0.85, true);
        ctx.closePath();
        ctx.fillStyle = rgba(C, (0.1 + 0.08 * breathe + r.level * 0.2) * B);
        ctx.fill();
        ctx.strokeStyle = rgba(C, 0.45 * B);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Kern
    {
      const core = R * (0.25 + 0.03 * breathe + 0.06 * r.level);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 2.2);
      g.addColorStop(0, rgba([255, 255, 255], 0.95 * B));
      g.addColorStop(0.28, rgba([Math.min(255, C[0] + 110), Math.min(255, C[1] + 40), Math.min(255, C[2] + 10)], 0.85 * B));
      g.addColorStop(0.55, rgba(C, 0.3 * B));
      g.addColorStop(1, rgba(C, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, core * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rgba(C, 0.8 * B);
      ctx.lineWidth = Math.max(1.5, R * 0.018);
      ctx.beginPath();
      ctx.arc(cx, cy, core * 1.08, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  let lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    const t = now / 1000;
    for (const r of reactors) drawReactor(r, dt, t);
  }

  const CYAN = [79, 216, 255];
  const AMBER = [255, 181, 71];
  const GREEN = [93, 255, 196];
  const RED = [255, 77, 94];

  // ------------------------------------------------------------------ Navigation

  function renderRail() {
    const list = $('steps');
    list.replaceChildren();
    STEPS.forEach((step, i) => {
      const li = document.createElement('li');
      if (i === S.step) li.classList.add('current');
      else if (S.visited.has(i) && i < S.step) li.classList.add('done');
      else if (S.visited.has(i) && isComplete(step.id)) li.classList.add('done');
      const b = el('button', 'step-btn');
      b.type = 'button';
      if (i === S.step) b.setAttribute('aria-current', 'step');
      const num = el('span', 'step-num');
      if (li.classList.contains('done')) num.append(svg(ICON.check));
      else num.textContent = String(i + 1);
      b.append(num, el('span', 'step-title', step.nav), el('span', 'step-sum', summaryFor(step.id)));
      b.addEventListener('click', () => go(i));
      li.append(b);
      list.append(li);
    });
  }

  function isComplete(id) {
    switch (id) {
      case 'mic': return S.mic.selected !== undefined;
      case 'voice': return !!S.voice;
      case 'place': return !!S.place.saved;
      case 'claude': return S.claude.state === 'ok';
      case 'extras': return !!S.hotkey;
      default: return false;
    }
  }

  function summaryFor(id) {
    switch (id) {
      case 'mic': return micLabel();
      case 'voice': return voiceName();
      case 'place': return S.place.saved;
      case 'claude': return S.claude.state === 'ok' ? 'verbunden' : S.claude.state === 'running' ? 'wird geprüft …' : '';
      case 'extras': return S.hotkey ? hotkeyLabel(S.hotkey) : '';
      default: return '';
    }
  }

  function micLabel() {
    if (S.mic.selected === undefined) return S.mic.savedName || '';
    if (S.mic.selected === '') return 'Windows-Standard';
    const m = (S.mic.list || []).find((d) => d.id === S.mic.selected);
    return m ? m.name : S.mic.savedName;
  }

  function voiceName() {
    const v = S.voices.find((x) => x.id === S.voice);
    return v ? v.name : (S.voice || '').replace(/^de-\w\w-|Neural$|Multilingual/g, '');
  }

  function hotkeyLabel(id) {
    const hk = S.hotkeys.find((h) => h.id === id);
    return hk ? hk.label : id.toUpperCase();
  }

  async function go(index, opts) {
    index = clamp(index, 0, STEPS.length - 1);
    const from = S.step;
    if (index === from && !(opts && opts.force)) return;
    await leave(STEPS[from].id);
    S.step = index;
    S.visited.add(index);
    const step = STEPS[index];
    document.body.dataset.step = step.id;
    document.querySelectorAll('.step').forEach((sec) => {
      const on = sec.dataset.step === step.id;
      sec.hidden = !on;
      if (on) {
        sec.classList.toggle('back', index < from);
        sec.style.animation = 'none';
        void sec.offsetWidth; // Einblendung neu starten
        sec.style.animation = '';
      }
    });
    $('eyebrow').textContent = step.eyebrow;
    $('stepCount').textContent = `Schritt ${index + 1} / ${STEPS.length}`;
    $('title').textContent = index === 0 && !S.first ? 'Einstellungen, Sir.' : step.title;
    $('lead').textContent = index === 0 && !S.first
      ? 'Klicken Sie links auf das, was Sie ändern möchten. Alles andere bleibt, wie es ist.'
      : step.lead;
    $('progressFill').style.width = ((index / (STEPS.length - 1)) * 100).toFixed(1) + '%';
    $('cardBody').scrollTop = 0;
    renderFoot();
    renderRail();
    await enter(step.id);
  }

  function renderFoot() {
    const step = STEPS[S.step];
    const next = $('nextBtn');
    const back = $('backBtn');
    back.hidden = S.step === 0;
    next.textContent = step.next || 'Weiter';
    next.classList.toggle('launch', step.id === 'done');
    next.disabled = S.finishing;
    const hint = $('footHint');
    hint.replaceChildren();
    if (step.id === 'done') {
      const later = el('button', 'link-btn', 'Nur speichern und schließen');
      later.type = 'button';
      later.addEventListener('click', () => finish(false));
      hint.append(later);
    } else if (step.id === 'welcome') {
      hint.textContent = S.first ? 'Etwa zwei Minuten' : '';
    } else if (step.id === 'claude' && S.claude.state !== 'ok' && S.claude.state !== 'running') {
      hint.textContent = 'Sie können auch ohne Claude weitermachen.';
    } else {
      hint.textContent = 'Wird sofort gespeichert';
    }
  }

  async function leave(id) {
    if (id === 'mic') await micStop();
  }

  async function enter(id) {
    switch (id) {
      case 'welcome': startBoot(); break;
      case 'mic': await micEnter(); break;
      case 'voice': await voiceEnter(); break;
      case 'place': placeEnter(); break;
      case 'claude': claudeEnter(); break;
      case 'extras': await extrasEnter(); break;
      case 'done': doneEnter(); break;
      default: break;
    }
  }

  async function next() {
    const id = STEPS[S.step].id;
    if (id === 'place') {
      const ok = await placeCommit();
      if (!ok) return;
    }
    if (id === 'done') {
      finish(true);
      return;
    }
    go(S.step + 1);
  }

  // ------------------------------------------------------------------ 1 Willkommen

  let bootGen = 0;
  async function startBoot() {
    const gen = ++bootGen;
    const line = $('bootLine');
    const text = S.first
      ? 'Bevor wir loslegen, richten wir fünf Dinge ein. Sie klicken nur, den Rest erledige ich.'
      : 'Schön, Sie wiederzusehen. Was möchten Sie ändern?';
    line.replaceChildren();
    const span = el('span');
    const caret = el('span', 'caret');
    line.append(span, caret);
    if (reducedMotion()) {
      span.textContent = text;
      return;
    }
    await sleep(350);
    for (let i = 1; i <= text.length; i++) {
      if (gen !== bootGen) return;
      span.textContent = text.slice(0, i);
      await sleep(text[i - 1] === '.' || text[i - 1] === ',' ? 160 : 22);
    }
  }

  // ------------------------------------------------------------------ 2 Mikrofon

  function micIcon(name) {
    const n = name.toLowerCase();
    if (/headset|kopfh|arctis|hyperx|airpods|buds|headphone|steelseries|corsair|jabra|logitech g/.test(n)) return ICON.headset;
    if (/cam|brio|c9\d\d|c270|kamera/.test(n)) return ICON.cam;
    if (/array|intern|realtek|conexant|laptop|notebook/.test(n)) return ICON.laptop;
    return ICON.mic;
  }

  async function micEnter() {
    buildVu();
    if (!S.mic.list) await micLoad();
    // Das, was Jarvis gerade nimmt, gleich testen (ohne neu zu speichern).
    let pick = S.mic.selected;
    if (pick === undefined) {
      const cur = S.mic.list.find((d) => d.current);
      pick = cur ? cur.id : S.mic.savedName ? undefined : '';
    }
    if (pick !== undefined) micStart(pick, false);
    else if (S.mic.savedName) {
      setMicStatus('warn', `Ihr gespeichertes Mikrofon „${S.mic.savedName}“ ist gerade nicht angeschlossen. Stecken Sie es an und klicken Sie „Liste neu laden“, oder wählen Sie ein anderes.`);
    }
  }

  async function micLoad() {
    S.mic.loading = true;
    try {
      const list = await call('mics');
      S.mic.list = Array.isArray(list) ? list : [];
    } catch (err) {
      S.mic.list = [];
      failed(err);
    }
    S.mic.loading = false;
    renderMics();
  }

  function renderMics() {
    const box = $('micList');
    box.replaceChildren();
    const def = (S.mic.list || []).find((d) => d.default);
    const options = [{
      id: '', name: 'Windows-Standard', icon: ICON.windows, current: !S.mic.savedName,
      sub: def ? 'Zurzeit: ' + (def.label || def.name) : 'Folgt der Einstellung in Windows',
    }];
    for (const d of S.mic.list || []) {
      options.push({
        id: d.id, name: d.label || d.name, icon: micIcon(d.name), current: d.current,
        sub: d.default ? 'In Windows als Standard eingestellt' : '',
      });
    }
    for (const o of options) {
      const b = el('button', 'choice');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(S.mic.selected === o.id));
      const radio = el('span', 'radio');
      const ico = el('span', 'choice-ico');
      ico.append(svg(o.icon));
      const txt = el('span', 'choice-text');
      txt.append(el('span', 'choice-name', o.name));
      if (o.sub) txt.append(el('span', 'choice-sub', o.sub));
      b.title = o.name;
      b.append(radio, ico, txt);
      if (o.current) {
        const badges = el('span', 'badges');
        badges.append(el('span', 'badge ok', 'Aktuell'));
        b.append(badges);
      }
      b.addEventListener('click', () => micStart(o.id, true));
      box.append(b);
    }
    if (!(S.mic.list || []).length) {
      const p = el('p', 'form-msg', 'Windows meldet keine weiteren Mikrofone. Ist eins angesteckt? Dann „Liste neu laden“.');
      p.dataset.tone = 'warn';
      box.append(p);
    }
    renderRail();
  }

  function buildVu() {
    const vu = $('vu');
    if (vu.childElementCount) return;
    for (let i = 0; i < 32; i++) vu.append(document.createElement('i'));
  }

  function setMicStatus(tone, text) {
    const box = $('micStatus');
    box.dataset.tone = tone;
    $('micStatusText').textContent = text;
  }

  async function micStart(id, save) {
    S.mic.selected = id;
    S.mic.detected = false;
    S.mic.maxLevel = 0;
    S.mic.startedAt = performance.now();
    $('micLive').classList.remove('detected');
    renderMics();
    setMicStatus('run', 'Öffne das Mikrofon …');
    let res;
    try {
      res = await call('mic_start', id);
    } catch (err) {
      failed(err);
      return;
    }
    if (S.mic.selected !== id) return; // inzwischen ein anderes angeklickt
    if (!res || !res.ok) {
      S.mic.running = false;
      setMicStatus('error', (res && res.error) || 'Dieses Mikrofon lässt sich nicht öffnen.');
      return;
    }
    S.mic.running = true;
    setMicStatus('run', 'Hört zu. Sprechen Sie etwas und sagen Sie „Hey Jarvis“.');
    if (save) {
      call('mic_save', id).then((r) => {
        if (r && r.ok) {
          S.mic.savedName = id === '' ? '' : r.name || '';
          (S.mic.list || []).forEach((d) => { d.current = d.id === id; });
          renderMics();
        } else if (r) toast(r.error || 'Konnte das Mikrofon nicht speichern.', 'error');
      }).catch(failed);
    }
    micPoll();
  }

  async function micPoll() {
    if (S.mic.polling) return;
    S.mic.polling = true;
    try {
      while (S.mic.running && STEPS[S.step].id === 'mic') {
        let st;
        try {
          st = await call('mic_poll');
        } catch {
          await sleep(500);
          continue;
        }
        renderMicState(st || {});
        if (st && !st.running) {
          S.mic.running = false;
          break;
        }
        await sleep(80);
      }
    } finally {
      S.mic.polling = false;
    }
  }

  function renderMicState(st) {
    const level = clamp(Number(st.level) || 0, 0, 1);
    const wake = clamp(Number(st.wake) || 0, 0, 1);
    const best = clamp(Number(st.best) || 0, 0, 1);
    const threshold = clamp(Number(st.threshold) || S.mic.threshold, 0.05, 0.95);
    S.mic.threshold = threshold;
    S.mic.maxLevel = Math.max(S.mic.maxLevel, level);

    const segs = $('vu').children;
    const lit = Math.round(Math.sqrt(level) * segs.length); // Wurzel: leises Sprechen sieht man auch
    for (let i = 0; i < segs.length; i++) {
      const on = i < lit;
      segs[i].classList.toggle('on', on);
      segs[i].classList.toggle('hot', on && i >= segs.length * 0.72);
      segs[i].classList.toggle('peak', on && i >= segs.length * 0.9);
    }
    $('levelNum').textContent = Math.round(level * 100) + ' %';
    $('wakeNum').textContent = st.ready ? wake.toFixed(2) + ' / ' + threshold.toFixed(2) : 'lädt …';
    $('wakeFill').style.width = (wake * 100).toFixed(1) + '%';
    $('wakeBest').style.left = 'calc(' + (best * 100).toFixed(1) + '% - 1px)';
    $('wakeMark').style.left = 'calc(' + (threshold * 100).toFixed(1) + '% - 1px)';

    const detected = !!st.detected;
    if (detected && !S.mic.detected) {
      S.mic.detected = true;
      $('micLive').classList.add('detected');
      if (bigReactorRef) bigReactorRef.set({ color: GREEN });
    }
    const running = performance.now() - S.mic.startedAt;
    if (st.error) setMicStatus('error', st.error);
    else if (st.silent) setMicStatus('error', 'Von diesem Mikrofon kommt absolute Stille. Meist blockiert Windows den Zugriff: Einstellungen › Datenschutz und Sicherheit › Mikrofon › „Desktop-Apps den Zugriff erlauben“ einschalten. Oder es ist das falsche Mikrofon.');
    else if (S.mic.detected) setMicStatus('ok', '„Hey Jarvis“ erkannt! Dieses Mikrofon passt.');
    else if (!st.ready) setMicStatus('run', 'Der Pegel läuft schon. Die Hey-Jarvis-Erkennung lädt noch ein paar Sekunden …');
    else if (running > 6000 && S.mic.maxLevel < 0.03) setMicStatus('warn', 'Kaum etwas zu hören. Sprechen Sie etwas – bleibt der Balken leer, ist es wohl das falsche Mikrofon.');
    else if (best >= 0.15) setMicStatus('warn', `Fast erkannt (${best.toFixed(2)}). Noch einmal deutlich „Hey Dschaarwis“ sagen – oder unten „Empfindlicher“ einschalten.`);
    else setMicStatus('run', 'Hört zu. Sagen Sie jetzt „Hey Jarvis“ (englisch ausgesprochen).');
  }

  async function micStop() {
    if (!S.mic.running) return;
    S.mic.running = false;
    try { await call('mic_stop'); } catch { /* egal */ }
  }

  // ------------------------------------------------------------------ 3 Stimme

  async function voiceEnter() {
    if (!S.voices.length) {
      try {
        const list = await call('voices');
        S.voices = Array.isArray(list) ? list : [];
      } catch (err) {
        failed(err);
      }
    }
    if (!S.voice && S.voices.length) S.voice = S.voices[0].id;
    renderVoices();
  }

  function renderVoices() {
    const grid = $('voiceGrid');
    grid.replaceChildren();
    for (const v of S.voices) {
      const card = el('div', 'voice');
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', String(S.voice === v.id));
      card.tabIndex = 0;
      if (S.playing === v.id) card.classList.add('playing');
      const avatar = el('span', 'avatar', (v.name || '?').charAt(0));
      const txt = el('span', 'voice-text');
      txt.append(el('span', 'voice-name', v.name), el('span', 'voice-desc', v.desc));
      const tag = el('span', 'badge voice-tag', v.gender === 'w' ? 'weiblich' : 'männlich');
      txt.append(tag);
      const play = el('button', 'play');
      play.type = 'button';
      play.title = v.name + ' anhören';
      play.setAttribute('aria-label', v.name + ' anhören');
      play.append(svg(ICON.play));
      const bars = el('span', 'bars');
      bars.append(el('i'), el('i'), el('i'));
      play.append(bars);
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        preview(v);
      });
      card.append(avatar, txt, play);
      const pick = () => chooseVoice(v, true);
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      });
      grid.append(card);
    }
  }

  function chooseVoice(v, andPreview) {
    const changed = S.voice !== v.id;
    S.voice = v.id;
    renderVoices();
    renderRail();
    if (changed) {
      call('voice_save', v.id).then((r) => {
        if (r && !r.ok) toast(r.error || 'Konnte die Stimme nicht speichern.', 'error');
      }).catch(failed);
    }
    if (andPreview && changed && !S.playing) preview(v);
  }

  async function preview(v) {
    if (S.playing) {
      toast('Einen Moment, es spricht gerade noch eine Stimme.', 'info');
      return;
    }
    S.playing = v.id;
    renderVoices();
    try {
      const r = await call('voice_preview', v.id);
      if (r && !r.ok) toast(r.error || 'Die Stimme lässt sich gerade nicht abspielen.', 'error');
    } catch (err) {
      failed(err);
    }
    S.playing = '';
    renderVoices();
  }

  // ------------------------------------------------------------------ 4 Wohnort

  function placeEnter() {
    const input = $('placeInput');
    if (!S.place.result) showWeather(null);
    if (!input.value && S.place.saved) input.value = S.place.saved;
    if (S.place.saved && !S.place.result) placeCheck(false);
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { /* egal */ } }, 250);
  }

  function placeMsg(tone, text) {
    const p = $('placeMsg');
    p.dataset.tone = tone || '';
    p.textContent = text || '';
  }

  function showWeather(res) {
    const card = $('weatherCard');
    const ok = !!(res && res.ok);
    card.classList.toggle('empty', !ok);
    if (!ok) {
      $('weatherTemp').textContent = '--°';
      $('weatherPlace').textContent = 'Hier erscheint gleich das Wetter';
      $('weatherText').textContent = 'Ort eintippen und „Prüfen“ klicken (oder Enter).';
      return;
    }
    $('weatherTemp').textContent = res.temp == null ? '–' : res.temp + '°';
    $('weatherPlace').textContent = res.place || '';
    $('weatherText').textContent = res.text ? 'Gerade ' + res.text : '';
  }

  /** Prüft den Ort. Gibt 'ok', 'network' oder 'unknown' zurück. */
  async function placeCheck(save) {
    const input = $('placeInput');
    const text = input.value.trim();
    const btn = $('placeCheck');
    if (!text) {
      showWeather(null);
      placeMsg('', '');
      return 'empty';
    }
    btn.classList.add('busy');
    placeMsg('', 'Ich schaue nach …');
    let res;
    try {
      res = await call('place_check', text);
    } catch (err) {
      btn.classList.remove('busy');
      failed(err);
      return 'network';
    }
    btn.classList.remove('busy');
    S.place.lastChecked = text;
    S.place.result = res;
    showWeather(res);
    if (res && res.ok) {
      if (save) await placeSave(text);
      placeMsg('ok', save ? 'Gefunden und gespeichert.' : 'Gefunden.');
      return 'ok';
    }
    const msg = (res && res.error) || 'Das hat nicht geklappt.';
    if (/gespeichert/i.test(msg)) {
      if (save) await placeSave(text);
      placeMsg('warn', msg);
      return 'network';
    }
    placeMsg('error', msg);
    return 'unknown';
  }

  async function placeSave(text) {
    try {
      const r = await call('place_save', text);
      if (r && r.ok) {
        S.place.saved = text;
        renderRail();
        return true;
      }
      toast((r && r.error) || 'Konnte den Ort nicht speichern.', 'error');
    } catch (err) {
      failed(err);
    }
    return false;
  }

  /** Beim Weiter: Ort übernehmen. False = auf dem Schritt bleiben. */
  async function placeCommit() {
    const text = $('placeInput').value.trim();
    if (text === S.place.saved) return true;
    if (!text) {
      await placeSave('');
      return true;
    }
    const result = await placeCheck(true);
    if (result === 'unknown') {
      $('placeInput').focus();
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ 5 Claude

  let claudeReactorRef = null;

  function claudeEnter() {
    if (S.claude.state === 'idle' || S.claude.state === 'error') claudeCheck();
    else renderClaude();
  }

  async function claudeCheck() {
    S.claude.state = 'running';
    renderClaude();
    try {
      await call('claude_check');
    } catch (err) {
      failed(err);
    }
    claudePoll();
  }

  async function claudePoll() {
    if (S.claude.polling) return;
    S.claude.polling = true;
    try {
      for (;;) {
        await sleep(600);
        let r;
        try {
          r = await call('claude_poll');
        } catch {
          continue;
        }
        if (!r) continue;
        S.claude.state = r.state || 'error';
        S.claude.message = r.message || '';
        S.claude.model = r.model || '';
        S.claude.version = r.version || '';
        renderClaude();
        if (S.claude.state !== 'running') break;
      }
    } finally {
      S.claude.polling = false;
    }
  }

  function prettyModel(model) {
    const m = String(model || '').match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i);
    if (!m) return model || '';
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return m[3] && m[3].length <= 2 ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
  }

  function renderClaude() {
    const st = S.claude.state;
    const card = $('claudeCard');
    card.dataset.state = st;
    const [title, fallback] = CLAUDE_TEXT[st] || CLAUDE_TEXT.error;
    $('claudeTitle').textContent = title;
    $('claudeMsg').textContent = S.claude.message && st !== 'running' ? S.claude.message : fallback;
    const meta = [];
    if (st === 'ok' && S.claude.model) meta.push('Modell: ' + prettyModel(S.claude.model));
    if (S.claude.version) meta.push('Claude Code ' + S.claude.version.replace(/\s*\(Claude Code\)\s*/i, ''));
    $('claudeMeta').textContent = meta.join('   ·   ');
    $('claudeInstall').hidden = st !== 'missing';
    $('claudeLogin').hidden = st !== 'login';
    $('claudeRetry').hidden = st === 'running';
    $('claudeRetry').textContent = st === 'ok' ? 'Noch einmal prüfen' : 'Nochmal prüfen';

    const howto = $('claudeHowto');
    howto.replaceChildren();
    howto.hidden = true;
    const steps = {
      missing: ['So geht es:', ['Auf „Claude Code installieren“ klicken. Ein blaues Fenster installiert es (etwa eine Minute).', 'Ist es fertig, das Fenster schließen und hier „Nochmal prüfen“ klicken.', 'Danach führt Jarvis Sie durch die Anmeldung mit Ihrem Claude-Konto.']],
      login: ['So geht es:', ['Auf „Bei Claude anmelden“ klicken. Ein Fenster mit Claude Code öffnet sich.', 'Der Browser fragt nach Ihrem Claude-Konto (Pro-Abo). Anmelden und zurück ins Fenster.', 'Das Fenster schließen und hier „Nochmal prüfen“.']],
      refused: ['Was das heißt:', ['Claudes Sicherheitsfilter schlägt manchmal fälschlich an, sogar bei harmlosen Fragen.', 'Jarvis probiert dann automatisch andere Modelle und einen einfachen Modus.', 'Sie können trotzdem weitermachen. Hilft das nicht, zeigt werkzeuge\\Claude-Test.bat mehr.']],
    }[st];
    if (steps) {
      howto.append(el('b', null, steps[0]));
      const ol = el('ol');
      steps[1].forEach((s) => ol.append(el('li', null, s)));
      howto.append(ol);
      howto.hidden = false;
    }

    if (claudeReactorRef) {
      const color = st === 'ok' ? GREEN : st === 'running' ? AMBER : st === 'error' ? RED : st === 'idle' ? CYAN : AMBER;
      claudeReactorRef.set({ color, mode: st === 'running' ? 'run' : 'idle', spin: st === 'running' ? 2.4 : 1 });
    }
    if (STEPS[S.step].id === 'claude') renderFoot();
    renderRail();
  }

  // ------------------------------------------------------------------ 6 Extras

  let extrasLoaded = false;

  async function extrasEnter() {
    if (!extrasLoaded) {
      extrasLoaded = true;
      if (!S.hotkeys.length) {
        try {
          const list = await call('hotkeys');
          S.hotkeys = Array.isArray(list) ? list : [];
        } catch (err) {
          failed(err);
        }
      }
      $('autostart').checked = !!S.autostart;
      $('haUrl').value = S.ha.url || '';
      if (S.ha.tokenSet) $('haToken').placeholder = 'gespeichert – nur für einen neuen Token ausfüllen';
      if (S.ha.url) $('alexa').open = true;
    }
    renderHotkeys();
  }

  function renderHotkeys() {
    const box = $('hotkeys');
    box.replaceChildren();
    for (const hk of S.hotkeys) {
      const b = el('button', 'keycap');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(S.hotkey === hk.id));
      String(hk.label).split('+').forEach((part, i) => {
        if (i) b.append(el('span', null, '+'));
        b.append(el('kbd', null, part.trim()));
      });
      b.addEventListener('click', () => {
        if (S.hotkey === hk.id) return;
        S.hotkey = hk.id;
        renderHotkeys();
        renderRail();
        call('hotkey_save', hk.id).then((r) => {
          if (r && !r.ok) toast(r.error || 'Konnte die Taste nicht speichern.', 'error');
          else toast('Stumm-Taste: ' + hk.label + '. Gilt ab dem nächsten Start von Jarvis.', 'info');
        }).catch(failed);
      });
      box.append(b);
    }
  }

  async function autostartChanged() {
    const box = $('autostart');
    const want = box.checked;
    try {
      const r = await call('autostart_set', want);
      if (r) {
        S.autostart = !!r.enabled;
        box.checked = S.autostart;
        if (!r.ok) toast('Autostart ging nicht: ' + (r.error || 'unbekannter Fehler'), 'error');
      }
    } catch (err) {
      box.checked = !want;
      failed(err);
    }
  }

  function guessRoom(entity, name) {
    const base = String(entity || '').replace(/^media_player\./, '').replace(/^(echo|alexa)(_dot|_show|_studio|_pop)?_?/, '');
    const n = String(name || '').toLowerCase().replace(/echo( dot| show| studio| pop)?|alexa|von \w+|['’]s/g, '').trim();
    return (base || n || '').replace(/_/g, ' ').trim();
  }

  async function haCheck() {
    const btn = $('haCheck');
    const url = $('haUrl').value.trim();
    const token = $('haToken').value.trim();
    const msg = $('haMsg');
    if (!url) {
      msg.dataset.tone = 'error';
      msg.textContent = 'Bitte die Adresse von Home Assistant eintragen.';
      return;
    }
    btn.classList.add('busy');
    msg.dataset.tone = '';
    msg.textContent = 'Verbinde …';
    let r;
    try {
      r = await call('ha_check', url, token);
    } catch (err) {
      btn.classList.remove('busy');
      failed(err);
      return;
    }
    btn.classList.remove('busy');
    msg.dataset.tone = r && r.ok ? 'ok' : 'error';
    msg.textContent = (r && r.message) || 'Keine Antwort.';
    S.ha.echos = (r && r.echos) || [];
    renderEchos();
    $('haSave').hidden = !(r && r.ok);
  }

  function renderEchos() {
    const box = $('echos');
    box.replaceChildren();
    for (const e of S.ha.echos) {
      if (e.room == null) e.room = guessRoom(e.entity, e.name);
      const row = el('div', 'echo');
      const left = el('div');
      left.append(el('div', 'echo-name', e.name || e.entity), el('span', 'echo-entity', e.entity));
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Raum, z. B. wohnzimmer';
      input.value = e.room || '';
      input.setAttribute('aria-label', 'Raum für ' + (e.name || e.entity));
      input.addEventListener('input', () => { e.room = input.value; });
      row.append(left, input);
      box.append(row);
    }
  }

  async function haSave() {
    const btn = $('haSave');
    btn.classList.add('busy');
    try {
      const echos = S.ha.echos.map((e) => ({ entity: e.entity, room: e.room || '' }));
      const r = await call('ha_save', $('haUrl').value.trim(), $('haToken').value.trim(), echos);
      if (r && r.ok) {
        toast('Alexa gespeichert.', 'info');
        S.ha.url = $('haUrl').value.trim();
        if ($('haToken').value.trim()) S.ha.tokenSet = true;
      } else toast((r && r.error) || 'Konnte Alexa nicht speichern.', 'error');
    } catch (err) {
      failed(err);
    }
    btn.classList.remove('busy');
  }

  // ------------------------------------------------------------------ 7 Fertig

  let doneReactorRef = null;

  function doneEnter() {
    const box = $('summary');
    box.replaceChildren();
    const claudeOk = S.claude.state === 'ok';
    const tiles = [
      ['Mikrofon', micLabel() || 'Windows-Standard', 'mic', S.mic.detected ? 'ok' : ''],
      ['Stimme', voiceName() || 'Conrad', 'voice', ''],
      ['Wohnort', S.place.saved || 'nicht eingetragen', 'place', S.place.saved ? '' : 'warn'],
      ['Claude', claudeOk ? (S.claude.model ? prettyModel(S.claude.model) : 'verbunden') : 'noch nicht bereit', 'claude', claudeOk ? 'ok' : 'warn'],
      ['Stumm-Taste', S.hotkey ? hotkeyLabel(S.hotkey) : 'keine', 'extras', ''],
      ['Autostart', S.autostart ? 'startet mit Windows' : 'aus', 'extras', ''],
    ];
    tiles.forEach(([k, v, step, tone], i) => {
      const b = el('button', 'sum' + (tone ? ' ' + tone : ''));
      b.type = 'button';
      b.style.animationDelay = (0.08 * i + 0.15).toFixed(2) + 's';
      b.append(el('span', 'sum-k', k), el('span', 'sum-v', v));
      b.title = v;
      b.addEventListener('click', () => go(INDEX[step]));
      box.append(b);
    });
    if (doneReactorRef) doneReactorRef.set({ color: claudeOk ? GREEN : CYAN, spin: 1.6 });
  }

  async function finish(start) {
    if (S.finishing) return;
    S.finishing = true;
    await micStop();
    const btn = $('nextBtn');
    btn.disabled = true;
    btn.classList.add('busy');
    btn.textContent = start ? 'Jarvis startet …' : 'Wird geschlossen …';
    try {
      await call('finish', !!start);
      if (demo) {
        toast(start ? 'Demo: Hier würde sich jetzt Jarvis öffnen.' : 'Demo: Hier würde sich das Fenster schließen.', 'info');
        await sleep(1500);
        S.finishing = false;
        btn.classList.remove('busy');
        renderFoot();
      }
    } catch (err) {
      S.finishing = false;
      btn.classList.remove('busy');
      renderFoot();
      failed(err);
    }
  }

  // ------------------------------------------------------------------ Start

  let bigReactorRef = null;

  function applyHello(info) {
    S.hello = info || {};
    S.first = S.hello.first_run !== false;
    const v = S.hello.values || {};
    S.mic.savedName = String(v.mic || '');
    S.mic.threshold = Number(v.threshold) || 0.5;
    $('sensitive').checked = S.mic.threshold <= 0.4;
    S.voice = String(v.voice || '');
    S.place.saved = String(v.ort || '');
    S.hotkey = String(v.hotkey || '');
    S.autostart = !!v.autostart;
    S.ha.url = String(v.ha_url || '');
    S.ha.tokenSet = !!v.ha_token_set;
    $('railVersion').textContent = S.hello.version ? 'Version ' + S.hello.version : '';
    if (S.hello.claude && S.hello.claude.installed === false) {
      S.claude.state = 'missing';
      S.claude.message = 'Claude Code ist noch nicht installiert.';
    }
    if (!S.first) {
      for (let i = 0; i < STEPS.length; i++) S.visited.add(i);
    }
  }

  function bind() {
    $('nextBtn').addEventListener('click', next);
    $('backBtn').addEventListener('click', () => go(S.step - 1));
    $('micReload').addEventListener('click', async () => {
      await micStop();
      S.mic.list = null;
      await micLoad();
      toast('Mikrofonliste neu geladen.', 'info');
    });
    $('sensitive').addEventListener('change', async (e) => {
      try {
        const r = await call('wake_sensitive', e.target.checked);
        if (r && typeof r.threshold === 'number') S.mic.threshold = r.threshold;
        if (r && !r.ok) toast(r.error || 'Konnte das nicht speichern.', 'error');
      } catch (err) {
        failed(err);
      }
    });
    $('placeForm').addEventListener('submit', (e) => {
      e.preventDefault();
      placeCheck(true);
    });
    $('claudeRetry').addEventListener('click', claudeCheck);
    $('claudeInstall').addEventListener('click', async () => {
      try {
        const r = await call('claude_install');
        if (r && r.ok) toast('Ein Fenster installiert jetzt Claude Code. Danach „Bei Claude anmelden“.', 'info');
        else toast((r && r.error) || 'Das Installationsfenster ging nicht auf.', 'error');
      } catch (err) {
        failed(err);
      }
    });
    $('claudeLogin').addEventListener('click', async () => {
      try {
        const r = await call('claude_login');
        if (r && r.ok) toast('Melden Sie sich im neuen Fenster an und klicken Sie danach „Nochmal prüfen“.', 'info');
        else toast((r && r.error) || 'Das Anmeldefenster ging nicht auf.', 'error');
      } catch (err) {
        failed(err);
      }
    });
    $('autostart').addEventListener('change', autostartChanged);
    $('haCheck').addEventListener('click', haCheck);
    $('haSave').addEventListener('click', haSave);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'SUMMARY' || t.getAttribute('role') === 'radio')) return;
      e.preventDefault();
      next();
    });
  }

  async function connect(newApi, isDemo) {
    api = newApi;
    demo = isDemo;
    document.body.dataset.link = isDemo ? 'demo' : 'live';
    let info = {};
    try {
      info = await call('hello');
    } catch (err) {
      failed(err);
    }
    applyHello(info);
    // Stimmen und Tasten gleich laden, damit die Leiste links schöne Namen zeigt.
    await Promise.all([
      call('voices').then((v) => { if (Array.isArray(v)) S.voices = v; }).catch(() => {}),
      call('hotkeys').then((h) => { if (Array.isArray(h)) S.hotkeys = h; }).catch(() => {}),
    ]);
    const want = params.get('step');
    const start = want && INDEX[want] != null ? INDEX[want] : 0;
    if (start) for (let i = 0; i <= start; i++) S.visited.add(i);
    await go(start, { force: true });
  }

  function boot() {
    bind();
    reactor($('railReactor'), { small: true, spin: 0.8 });
    bigReactorRef = reactor($('bigReactor'), { spin: 1 });
    claudeReactorRef = reactor($('claudeReactor'), { spin: 1 });
    doneReactorRef = reactor($('doneReactor'), { spin: 1.4 });
    requestAnimationFrame(frame);
    renderRail();

    let connected = false;
    const tryReal = () => {
      if (connected || !realReady()) return false;
      connected = true;
      connect(realApi, false);
      return true;
    };
    window.addEventListener('pywebviewready', () => {
      // Kam die echte Verbindung erst nach dem Demo-Start (langsamer PC): neu laden,
      // damit nie Beispieldaten statt der echten Einstellungen zu sehen sind.
      if (demo) {
        location.reload();
        return;
      }
      if (!tryReal()) setTimeout(tryReal, 50);
    });
    if (tryReal()) return;
    const t0 = performance.now();
    const watch = setInterval(() => {
      if (tryReal()) {
        clearInterval(watch);
        return;
      }
      if (performance.now() - t0 > 2500 && typeof window.pywebview === 'undefined' && params.get('demo') !== '0') {
        clearInterval(watch);
        connected = true;
        connect(createDemo(), true);
      }
    }, 100);
  }

  // ==================================================================
  //   Demo-Modus: gleiche Methoden wie SetupApi, mit Beispieldaten
  // ==================================================================

  function createDemo() {
    const micMode = params.get('mic') || 'detected';
    const claudeMode = params.get('claude') || 'ok';
    let micOn = false;
    let micT0 = 0;
    let best = 0;
    let threshold = 0.5;
    let claudeT0 = 0;
    const later = (v, ms) => sleep(ms).then(() => v);
    const VOICES = [
      { id: 'de-DE-ConradNeural', name: 'Conrad', desc: 'Tief und ruhig, der klassische Butler (Standard)', gender: 'm' },
      { id: 'de-DE-KillianNeural', name: 'Killian', desc: 'Jünger und freundlich', gender: 'm' },
      { id: 'de-DE-FlorianMultilingualNeural', name: 'Florian', desc: 'Sehr natürlich, klingt fast wie ein Mensch', gender: 'm' },
      { id: 'de-AT-JonasNeural', name: 'Jonas', desc: 'Mit österreichischem Klang', gender: 'm' },
      { id: 'de-DE-SeraphinaMultilingualNeural', name: 'Seraphina', desc: 'Warm und natürlich', gender: 'w' },
      { id: 'de-DE-KatjaNeural', name: 'Katja', desc: 'Klar und sachlich', gender: 'w' },
    ];
    return {
      hello: () => later({
        version: '1.1.0',
        first_run: params.get('first') !== '0',
        values: {
          mic: params.get('first') === '0' ? 'Headset (Arctis 7 Chat)' : '', ort: params.get('first') === '0' ? 'Wien' : '',
          voice: 'de-DE-ConradNeural', hotkey: 'ctrl+alt+m', threshold: 0.5, autostart: false,
          ha_url: '', ha_token_set: false,
        },
        claude: { installed: claudeMode !== 'missing', path: 'C:\\Users\\Georg\\.local\\bin\\claude.exe' },
      }, 60),
      mics: () => later([
        { id: 1, name: 'Mikrofonarray (Realtek(R) Audi', label: 'Mikrofonarray (Realtek(R) Audio)', api: 'MME', default: true, current: false },
        { id: 2, name: 'Headset (Arctis 7 Chat)', api: 'MME', default: false, current: params.get('first') === '0' },
        { id: 3, name: 'Mikrofon (HD Pro Webcam C920)', api: 'MME', default: false, current: false },
      ], 120),
      mic_start: (id) => {
        micOn = true;
        micT0 = performance.now();
        best = 0;
        return later({ ok: true, name: String(id), error: '' }, 150);
      },
      mic_poll: () => {
        const t = (performance.now() - micT0) / 1000;
        const speaking = micMode !== 'silent' && Math.sin(t * 2.1) > -0.2;
        const level = micMode === 'silent' ? 0 : speaking ? 0.08 + 0.35 * Math.abs(Math.sin(t * 9)) * Math.abs(Math.sin(t * 1.7 + 1)) : 0.01;
        const wake = micMode === 'detected' && t > 2.2 && t < 3.4 ? Math.min(0.93, (t - 2.2) * 1.4) : micMode === 'near' ? 0.12 + 0.24 * Math.abs(Math.sin(t)) : 0.02;
        best = Math.max(best, wake);
        return later({
          running: micOn, level, wake, best, detected: best >= threshold, silent: micMode === 'silent' && t > 3,
          ready: t > 0.8, error: '', threshold,
        }, 10);
      },
      mic_stop: () => { micOn = false; return later(true, 20); },
      mic_save: (id) => later({ ok: true, error: '', name: String(id) }, 80),
      wake_sensitive: (on) => { threshold = on ? 0.35 : 0.5; return later({ ok: true, error: '', threshold }, 80); },
      voices: () => later(VOICES, 60),
      voice_preview: () => later({ ok: true, error: '' }, 2600),
      voice_save: () => later({ ok: true, error: '' }, 80),
      place_check: (text) => later(/^x+$/i.test(text) || /unbekannt/i.test(text)
        ? { ok: false, place: '', temp: null, text: '', error: `"${text}" kenne ich leider nicht. Vielleicht mit Land, z. B. "Wien, Österreich"?` }
        : { ok: true, place: String(text).split(',')[0].trim(), temp: 16, text: 'teils bewölkt', error: '' }, 600),
      place_save: () => later({ ok: true, error: '' }, 60),
      claude_check: () => { claudeT0 = performance.now(); return later({ started: true }, 50); },
      claude_poll: () => {
        const running = claudeMode === 'running' || performance.now() - claudeT0 < 2200;
        if (running) return later({ state: 'running', message: 'Ich frage Claude ...', model: '', version: '' }, 30);
        const msg = {
          ok: 'Das Gehirn ist verbunden. Jarvis kann denken.',
          missing: 'Claude Code ist noch nicht installiert.',
          login: 'Claude Code ist installiert, aber noch nicht mit deinem Pro-Konto angemeldet.',
          refused: 'Claude hat abgelehnt. Jarvis probiert später automatisch andere Modelle.',
          error: 'Ich erreiche Claude gerade nicht, Sir. Ist das Internet verbunden?',
        }[claudeMode] || '';
        return later({ state: claudeMode, message: msg, model: claudeMode === 'ok' ? 'claude-sonnet-5-5' : '', version: claudeMode === 'missing' ? '' : '2.1.286 (Claude Code)' }, 30);
      },
      claude_install: () => later({ ok: true, error: '' }, 100),
      claude_login: () => later({ ok: true, error: '' }, 100),
      hotkeys: () => later([
        { id: 'ctrl+alt+m', label: 'Strg + Alt + M' },
        { id: 'ctrl+alt+j', label: 'Strg + Alt + J' },
        { id: 'f9', label: 'F9' },
        { id: 'pause', label: 'Pause' },
      ], 40),
      hotkey_save: () => later({ ok: true, error: '' }, 60),
      autostart_set: (on) => later({ ok: true, enabled: !!on, error: '' }, 120),
      ha_check: () => later({
        ok: true, message: 'Verbunden. 2 Echo-Gerät(e) gefunden.',
        echos: [
          { entity: 'media_player.echo_wohnzimmer', name: 'Echo Wohnzimmer' },
          { entity: 'media_player.echo_dot_kueche', name: 'Echo Dot Küche' },
        ],
      }, 700),
      ha_save: () => later({ ok: true, error: '' }, 200),
      finish: () => later({ ok: true }, 300),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
