/* ==========================================================================
   J.A.R.V.I.S. – Oberfläche
   Brücke zu Python über pywebview (window.pywebview.api), sonst Demo-Modus.
   Alle Texte aus Ereignissen werden ausschließlich als Klartext (textContent)
   eingesetzt.
   ========================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------------ Helfer

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const pad2 = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => performance.now();

  const params = new URLSearchParams(location.search);

  const motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedMotion = !!(motionMQ && motionMQ.matches);
  if (motionMQ && motionMQ.addEventListener) {
    motionMQ.addEventListener('change', (e) => { reducedMotion = e.matches; });
  }

  const STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted', 'error'];
  const LABELS = {
    idle: 'Bereit',
    listening: 'Ich höre zu …',
    thinking: 'Einen Moment …',
    speaking: 'Jarvis spricht',
    muted: 'Stumm',
    error: 'Fehler',
  };

  // ------------------------------------------------------------------ Zustand

  const S = {
    state: 'idle',      // letzter Zustand vom Backend (ohne "error")
    shown: '',          // aktuell angezeigter Zustand
    muted: false,
    errorActive: false,
    hotkey: 'STRG+ALT+M',
    mic: '',
    model: '',
    weather: '',
    version: '',
    link: 'wait',       // wait | live | demo | offline
    levelTarget: 0,
    levelAt: 0,
  };

  let api = null;       // aktive API (echt oder Demo)
  let bridgeGen = 0;    // erhöht sich bei jedem Wechsel der API
  let demo = null;
  let errorTimer = 0;

  // ------------------------------------------------------------------ DOM

  const el = {
    body: document.body,
    stateLabel: $('stateLabel'),
    stateHint: $('stateHint'),
    linkText: $('linkText'),
    cpu: $('cpuMeter'),
    ram: $('ramMeter'),
    micLine: $('micLine'),
    micName: $('micName'),
    modelLine: $('modelLine'),
    modelName: $('modelName'),
    version: $('versionTag'),
    weatherLine: $('weatherLine'),
    weatherText: $('weatherText'),
    clockHM: $('clockHM'),
    clockS: $('clockS'),
    clockDate: $('clockDate'),
    chat: document.querySelector('.chat'),
    messages: $('messages'),
    msgCount: $('msgCount'),
    form: $('cmdForm'),
    input: $('cmdInput'),
    sendBtn: $('sendBtn'),
    micBtn: $('micBtn'),
    stopBtn: $('stopBtn'),
    newBtn: $('newBtn'),
    toasts: $('toasts'),
    canvas: $('reactor'),
    reactorWrap: $('reactorWrap'),
  };

  // ------------------------------------------------------------------ Tastenkürzel hübsch machen

  const KEYNAMES = {
    ctrl: 'Strg', control: 'Strg', strg: 'Strg', alt: 'Alt', altgr: 'AltGr', shift: 'Shift',
    umschalt: 'Umschalt', win: 'Win', windows: 'Win', super: 'Win', cmd: 'Win', meta: 'Win',
    space: 'Leertaste', leertaste: 'Leertaste', esc: 'Esc', escape: 'Esc', enter: 'Enter',
    return: 'Enter', tab: 'Tab', pause: 'Pause', entf: 'Entf', del: 'Entf', delete: 'Entf',
    einfg: 'Einfg', insert: 'Einfg', pos1: 'Pos1', home: 'Pos1', ende: 'Ende', end: 'Ende',
  };

  /** "STRG+ALT+M" -> ["Strg","Alt","M"]; null, wenn es kein gültiges Kürzel ist. */
  function hotkeyParts(hk) {
    if (typeof hk !== 'string') return null;
    const s = hk.trim();
    if (!s || /[()]/.test(s)) return null;
    const parts = s.split('+').map((p) => p.trim().replace(/^<(.+)>$/, '$1'));
    if (!parts.length || parts.some((p) => !p || /\s/.test(p) || p.length > 12)) return null;
    return parts.map((p) => {
      const low = p.toLowerCase();
      if (KEYNAMES[low]) return KEYNAMES[low];
      if (/^f\d{1,2}$/i.test(p) || p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    });
  }

  // ------------------------------------------------------------------ Zustandsanzeige

  function effectiveState() {
    if (S.errorActive) return 'error';
    if (S.muted && (S.state === 'idle' || S.state === 'muted' || S.state === 'listening')) return 'muted';
    if (!S.muted && S.state === 'muted') return 'idle';
    return S.state;
  }

  function applyState(value) {
    if (typeof value !== 'string') return;
    value = value.toLowerCase();
    if (!STATES.includes(value)) return;
    if (value === 'error') {
      triggerError();
      return;
    }
    clearTimeout(errorTimer);
    S.errorActive = false;
    if (value === 'muted') S.muted = true;
    else if (value === 'listening') S.muted = false;
    S.state = value;
    renderState();
  }

  function triggerError() {
    S.errorActive = true;
    Reactor.flash();
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      S.errorActive = false;
      renderState();
    }, 2800);
    renderState(true);
  }

  function setMuted(v) {
    S.muted = !!v;
    renderState();
  }

  function renderState(force) {
    const st = effectiveState();
    renderMicButton();
    if (st === S.shown && !force) {
      if (st === 'muted') renderHint(st); // Kürzel kann sich geändert haben
      return;
    }
    const changed = st !== S.shown;
    S.shown = st;
    el.body.dataset.state = st;
    el.stateLabel.textContent = LABELS[st];
    renderHint(st);
    Reactor.setState(st);
    if (changed && el.stateLabel.animate && !reducedMotion) {
      el.stateLabel.animate(
        [
          { opacity: 0, transform: 'translateY(5px)', filter: 'blur(4px)' },
          { opacity: 1, transform: 'none', filter: 'blur(0)' },
        ],
        { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
  }

  function renderHint(st) {
    const h = el.stateHint;
    h.textContent = '';
    switch (st) {
      case 'idle':
        h.textContent = 'Sag „Hey Jarvis“';
        break;
      case 'listening':
        h.textContent = 'Sprich jetzt – ich höre dir zu';
        break;
      case 'thinking':
        h.textContent = 'Deine Anfrage wird verarbeitet';
        break;
      case 'speaking':
        h.textContent = 'Esc oder Stopp zum Unterbrechen';
        break;
      case 'muted': {
        const parts = hotkeyParts(S.hotkey);
        if (parts) {
          parts.forEach((p, i) => {
            if (i) h.append('+');
            const k = document.createElement('kbd');
            k.textContent = p;
            h.append(k);
          });
          h.append(' zum Einschalten');
        } else {
          h.textContent = 'Mikrofon-Taste zum Einschalten';
        }
        break;
      }
      case 'error':
        h.textContent = 'Da ist etwas schiefgelaufen – bitte noch einmal versuchen';
        break;
      default:
        break;
    }
  }

  function renderMicButton() {
    const b = el.micBtn;
    const parts = hotkeyParts(S.hotkey);
    const hk = parts ? ` (${parts.join('+')})` : '';
    b.classList.toggle('is-muted', S.muted);
    b.setAttribute('aria-pressed', S.muted ? 'true' : 'false');
    b.title = (S.muted ? 'Laut schalten – Mikrofon ist stumm' : 'Stumm schalten') + hk;
  }

  // ------------------------------------------------------------------ Systemanzeige

  function setMeter(meter, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const p = clamp(v, 0, 100);
    meter.querySelector('.meter-fill').style.width = p.toFixed(1) + '%';
    meter.querySelector('.meter-value').textContent = Math.round(p) + ' %';
    meter.classList.toggle('crit', p >= 90);
    meter.classList.toggle('warn', p >= 75 && p < 90);
  }

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.hotkey === 'string') S.hotkey = cfg.hotkey;
    if (typeof cfg.mic === 'string') {
      S.mic = cfg.mic.trim();
      el.micName.textContent = S.mic;
      el.micName.title = S.mic;
      el.micLine.hidden = !S.mic;
    }
    if (typeof cfg.model === 'string') {
      S.model = cfg.model.trim();
      el.modelName.textContent = S.model;
      el.modelName.title = S.model;
      el.modelLine.hidden = !S.model;
    }
    if (typeof cfg.weather === 'string' || cfg.weather === null) {
      S.weather = (cfg.weather || '').trim();
      el.weatherText.textContent = S.weather;
      el.weatherLine.title = S.weather;
      el.weatherLine.hidden = !S.weather;
    }
    if (typeof cfg.version === 'string' || typeof cfg.version === 'number') {
      S.version = String(cfg.version).trim();
      el.version.textContent = S.version ? 'Version ' + S.version : '';
    }
    if (typeof cfg.muted === 'boolean') S.muted = cfg.muted;
    renderState();
  }

  function setLink(mode) {
    S.link = mode;
    el.body.dataset.link = mode;
    el.linkText.textContent = { wait: 'Verbinde …', live: 'Online', demo: 'Demo', offline: 'Getrennt' }[mode] || '';
  }

  // ------------------------------------------------------------------ Uhr

  function tickClock() {
    const d = new Date();
    el.clockHM.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    el.clockS.textContent = pad2(d.getSeconds());
    const ds = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
    if (el.clockDate.textContent !== ds) el.clockDate.textContent = ds;
    setTimeout(tickClock, 1000 - d.getMilliseconds() + 8);
  }

  // ------------------------------------------------------------------ Verlauf

  const MAX_MSG = 200;
  const msgById = new Map();
  const pendingEchoes = []; // lokal angezeigte, getippte Nachrichten, die Python evtl. noch meldet

  function hhmm(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function isNearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function updateChatMeta() {
    const n = el.messages.childElementCount;
    el.chat.classList.toggle('has-msgs', n > 0);
    el.msgCount.textContent = n ? String(n).padStart(2, '0') : '';
  }

  function createMsg(role, id) {
    const m = document.createElement('div');
    m.className = 'msg msg-' + role;
    const parts = {};
    if (role !== 'info') {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const who = document.createElement('span');
      who.className = 'msg-who';
      who.textContent = role === 'user' ? 'Du' : 'Jarvis';
      const time = document.createElement('span');
      time.className = 'msg-time';
      time.textContent = hhmm(new Date());
      meta.append(who, time);
      m.append(meta);
    }
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    parts.text = document.createElement('span');
    parts.text.className = 'msg-text';
    bubble.append(parts.text);
    if (role === 'jarvis') {
      const typing = document.createElement('span');
      typing.className = 'typing';
      typing.setAttribute('aria-label', 'Jarvis schreibt');
      typing.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      bubble.append(typing);
    }
    m.append(bubble);
    if (role === 'jarvis') {
      parts.model = document.createElement('div');
      parts.model.className = 'msg-model';
      parts.model.hidden = true;
      m.append(parts.model);
    }
    m._parts = parts;
    m._role = role;
    if (id) setMsgId(m, id);
    return m;
  }

  function setMsgId(m, id) {
    m.dataset.id = id;
    msgById.set(id, m);
  }

  function fillMsg(m, text, model, final) {
    m._parts.text.textContent = text;
    m.classList.toggle('streaming', !final);
    m.classList.toggle('empty', text.length === 0);
    if (m._parts.model && typeof model === 'string') {
      m._parts.model.textContent = model;
      m._parts.model.hidden = !model;
    }
  }

  function appendMsg(m) {
    el.messages.append(m);
    let extra = el.messages.childElementCount - MAX_MSG;
    while (extra-- > 0) {
      const old = el.messages.firstElementChild;
      if (!old) break;
      const oid = old.dataset.id;
      if (oid && msgById.get(oid) === old) msgById.delete(oid);
      old.remove();
    }
    updateChatMeta();
  }

  function takePendingEcho(text) {
    const t = nowMs();
    for (let i = pendingEchoes.length - 1; i >= 0; i--) {
      const p = pendingEchoes[i];
      if (t - p.t > 20000 || !p.el.isConnected) pendingEchoes.splice(i, 1);
    }
    const idx = pendingEchoes.findIndex((p) => p.text === text.trim());
    return idx >= 0 ? pendingEchoes.splice(idx, 1)[0] : null;
  }

  function handleMessage(ev) {
    const role = ev.role === 'user' || ev.role === 'jarvis' ? ev.role : 'info';
    const text = ev.text == null ? '' : String(ev.text);
    const id = ev.id == null || ev.id === '' ? null : String(ev.id);
    const final = ev.final !== false;
    const model = ev.model == null ? undefined : String(ev.model);
    const stick = isNearBottom();

    let m = id ? msgById.get(id) : null;
    if (m && !m.isConnected) {
      msgById.delete(id);
      m = null;
    }

    if (!m && role === 'user') {
      // Getippter Text wurde bereits lokal angezeigt -> nicht doppelt zeigen.
      const echo = takePendingEcho(text);
      if (echo) {
        echo.el.classList.remove('local', 'failed');
        if (id) setMsgId(echo.el, id);
        fillMsg(echo.el, text, undefined, true);
        if (stick) scrollToBottom();
        return;
      }
    }

    if (m) {
      fillMsg(m, text, model, final);
    } else {
      m = createMsg(role, id);
      fillMsg(m, text, model, final);
      appendMsg(m);
    }
    if (stick || role === 'user') scrollToBottom();
  }

  function clearMessages() {
    const old = Array.from(el.messages.children);
    old.forEach((m) => {
      const oid = m.dataset.id;
      if (oid && msgById.get(oid) === m) msgById.delete(oid);
    });
    pendingEchoes.length = 0;
    if (!old.length) return;
    old.forEach((m) => m.classList.add('leaving'));
    setTimeout(() => {
      old.forEach((m) => m.remove());
      updateChatMeta();
    }, reducedMotion ? 60 : 260);
  }

  function clearMessagesNow() {
    el.messages.replaceChildren();
    msgById.clear();
    pendingEchoes.length = 0;
    updateChatMeta();
  }

  // ------------------------------------------------------------------ Hinweise

  function toast(text, kind) {
    const isErr = kind === 'error';
    const t = document.createElement('div');
    t.className = 'toast ' + (isErr ? 'toast-error' : 'toast-info');
    t.setAttribute('role', isErr ? 'alert' : 'status');
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = isErr ? '!' : 'i';
    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = text == null ? '' : String(text);
    t.append(icon, body);
    el.toasts.append(t);
    while (el.toasts.childElementCount > 3) el.toasts.firstElementChild.remove();
    const hide = () => {
      if (!t.isConnected || t.classList.contains('out')) return;
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    };
    setTimeout(hide, 4000);
    t.addEventListener('click', hide);
  }

  // ------------------------------------------------------------------ Ereignisse

  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'state':
        applyState(ev.value);
        break;
      case 'level': {
        const v = Number(ev.value);
        if (Number.isFinite(v)) {
          S.levelTarget = clamp(v, 0, 1);
          S.levelAt = nowMs();
        }
        break;
      }
      case 'message':
        handleMessage(ev);
        break;
      case 'stats':
        if (ev.cpu != null) setMeter(el.cpu, ev.cpu);
        if (ev.ram != null) setMeter(el.ram, ev.ram);
        break;
      case 'config':
        applyConfig(ev);
        break;
      case 'toast':
        toast(ev.text, ev.kind);
        break;
      default:
        break;
    }
  }

  function handleEvents(evs) {
    if (typeof evs === 'string') {
      try { evs = JSON.parse(evs); } catch (e) { return; }
    }
    if (!evs) return;
    if (!Array.isArray(evs)) evs = [evs];
    for (const ev of evs) {
      try {
        handleEvent(ev);
      } catch (err) {
        console.error('Jarvis: Ereignis konnte nicht verarbeitet werden', ev, err);
      }
    }
  }

  // ------------------------------------------------------------------ Brücke

  function callApi(name, ...args) {
    if (!api || typeof api[name] !== 'function') {
      return Promise.reject(new Error('API nicht verfügbar: ' + name));
    }
    try {
      return Promise.resolve(api[name](...args));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function connect(newApi, mode) {
    bridgeGen += 1;
    const gen = bridgeGen;
    api = newApi;
    setLink(mode);
    callApi('hello')
      .then((cfg) => {
        if (gen !== bridgeGen) return;
        if (typeof cfg === 'string') {
          try { cfg = JSON.parse(cfg); } catch (e) { cfg = null; }
        }
        applyConfig(cfg);
      })
      .catch((err) => console.warn('Jarvis: hello() fehlgeschlagen', err));
    pollLoop(gen, mode);
  }

  async function pollLoop(gen, mode) {
    let fails = 0;
    while (gen === bridgeGen) {
      let evs;
      try {
        evs = await callApi('poll');
      } catch (err) {
        if (gen !== bridgeGen) return;
        fails += 1;
        if (fails === 1) console.warn('Jarvis: poll() fehlgeschlagen', err);
        if (fails >= 3 && S.link !== 'offline') setLink('offline');
        await sleep(1000);
        continue;
      }
      if (gen !== bridgeGen) return;
      if (fails && S.link === 'offline') setLink(mode);
      fails = 0;
      handleEvents(evs);
      await sleep(80);
    }
  }

  /** Greift bei jedem Aufruf frisch auf window.pywebview.api zu (pywebview kann das Objekt ersetzen). */
  const realApi = {
    hello: () => window.pywebview.api.hello(),
    poll: () => window.pywebview.api.poll(),
    send_text: (t) => window.pywebview.api.send_text(t),
    toggle_mute: () => window.pywebview.api.toggle_mute(),
    stop: () => window.pywebview.api.stop(),
    new_conversation: () => window.pywebview.api.new_conversation(),
  };

  function realApiReady() {
    try {
      const a = window.pywebview && window.pywebview.api;
      return !!(a && typeof a.poll === 'function');
    } catch (e) {
      return false;
    }
  }

  function connectReal() {
    if (S.link === 'live' || S.link === 'offline') {
      if (api === realApi) return true;
    }
    if (!realApiReady()) return false;
    if (demo) {
      demo.destroy();
      demo = null;
      clearMessagesNow();
      S.state = 'idle';
      S.muted = false;
      S.errorActive = false;
      S.levelTarget = 0;
      renderState();
    }
    connect(realApi, 'live');
    return true;
  }

  // ------------------------------------------------------------------ Bedienung

  function sendText() {
    const text = el.input.value.trim();
    if (!text) return;
    if (!api) {
      toast('Noch keine Verbindung zu Jarvis.', 'error');
      return;
    }
    el.input.value = '';
    updateSendBtn();
    const m = createMsg('user', null);
    m.classList.add('local');
    fillMsg(m, text, undefined, true);
    appendMsg(m);
    scrollToBottom();
    const echo = { el: m, text, t: nowMs() };
    pendingEchoes.push(echo);
    callApi('send_text', text)
      .then((ok) => {
        if (ok === false) {
          m.classList.add('failed');
          const i = pendingEchoes.indexOf(echo);
          if (i >= 0) pendingEchoes.splice(i, 1);
          toast('Jarvis konnte die Nachricht gerade nicht annehmen.', 'error');
        }
      })
      .catch((err) => {
        console.warn('Jarvis: send_text() fehlgeschlagen', err);
        m.classList.add('failed');
        const i = pendingEchoes.indexOf(echo);
        if (i >= 0) pendingEchoes.splice(i, 1);
        toast('Nachricht konnte nicht gesendet werden.', 'error');
      });
  }

  function toggleMute() {
    if (!api) {
      toast('Noch keine Verbindung zu Jarvis.', 'error');
      return;
    }
    const before = S.muted;
    setMuted(!before); // sofortige Rückmeldung
    callApi('toggle_mute')
      .then((v) => {
        if (typeof v === 'boolean') setMuted(v);
      })
      .catch((err) => {
        console.warn('Jarvis: toggle_mute() fehlgeschlagen', err);
        setMuted(before);
        toast('Stummschaltung hat nicht geklappt.', 'error');
      });
  }

  function stopAnswer() {
    if (!api) return;
    callApi('stop').catch((err) => {
      console.warn('Jarvis: stop() fehlgeschlagen', err);
      toast('Stopp hat nicht geklappt.', 'error');
    });
  }

  function newConversation() {
    if (!api) {
      toast('Noch keine Verbindung zu Jarvis.', 'error');
      return;
    }
    clearMessages();
    callApi('new_conversation')
      .then(() => toast('Neue Unterhaltung begonnen.', 'info'))
      .catch((err) => {
        console.warn('Jarvis: new_conversation() fehlgeschlagen', err);
        toast('Neue Unterhaltung konnte nicht gestartet werden.', 'error');
      });
  }

  function updateSendBtn() {
    el.sendBtn.disabled = el.input.value.trim().length === 0;
  }

  function bindUi() {
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendText();
    });
    el.input.addEventListener('input', updateSendBtn);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendText();
      }
    });
    el.micBtn.addEventListener('click', toggleMute);
    el.stopBtn.addEventListener('click', stopAnswer);
    el.newBtn.addEventListener('click', newConversation);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (S.shown === 'speaking' || S.shown === 'thinking') {
          e.preventDefault();
          stopAnswer();
        } else if (document.activeElement === el.input && el.input.value) {
          el.input.value = '';
          updateSendBtn();
        }
      }
    });
    updateSendBtn();
  }

  // ==================================================================
  //   Arc Reactor (Canvas)
  // ==================================================================

  const Reactor = (() => {
    const canvas = el.canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    let W = 0;
    let H = 0;
    let dpr = 1;

    const PAL = {
      cyan: [79, 216, 255],
      cyanHi: [125, 230, 255],
      white: [205, 244, 255],
      amber: [255, 181, 71],
      red: [255, 77, 94],
      grey: [112, 130, 146],
    };

    const T = {
      idle: {
        p: PAL.cyan, a: PAL.cyan, core: [150, 232, 255],
        rot: 1, seg: 0.16, pulseHz: 0.2, pulseAmp: 0.11, bright: 0.8,
        expand: 0, listen: 0, eq: 0, orbit: 0, mute: 0,
      },
      listening: {
        p: PAL.cyanHi, a: PAL.cyanHi, core: [196, 244, 255],
        rot: 1.8, seg: 0.4, pulseHz: 0.95, pulseAmp: 0.13, bright: 1.05,
        expand: 1, listen: 1, eq: 0, orbit: 0, mute: 0,
      },
      thinking: {
        p: PAL.cyan, a: PAL.amber, core: [255, 222, 170],
        rot: 1.4, seg: 1.9, pulseHz: 0.7, pulseAmp: 0.09, bright: 0.95,
        expand: 0.35, listen: 0, eq: 0, orbit: 1, mute: 0,
      },
      speaking: {
        p: PAL.white, a: PAL.cyan, core: [236, 252, 255],
        rot: 1.25, seg: 0.3, pulseHz: 0.4, pulseAmp: 0.05, bright: 1.08,
        expand: 0.55, listen: 0, eq: 1, orbit: 0, mute: 0,
      },
      muted: {
        p: PAL.grey, a: PAL.red, core: [118, 134, 150],
        rot: 0.2, seg: 0.04, pulseHz: 0.09, pulseAmp: 0.05, bright: 0.46,
        expand: -0.5, listen: 0, eq: 0, orbit: 0, mute: 1,
      },
    };

    const cloneT = (t) => ({ ...t, p: t.p.slice(), a: t.a.slice(), core: t.core.slice() });
    const cur = cloneT(T.idle);
    let target = T.idle;
    let visState = 'idle';

    // Animationswerte
    let aTicks = 0;
    let aSeg = 0;
    let aCoil = 0;
    let aInner = 0;
    let aDash = 0;
    let aSweep = 0;
    let phase = 0;
    let time = 0;
    let lvl = 0;
    let flash = 0;
    let errHold = 0;
    let boot = 0;
    const N_EQ = 72;
    const eqVals = new Float32Array(N_EQ);
    const ripples = [];
    let nextRipple = 0;

    const SEGMENTS = [
      [0.0, 0.95], [1.08, 0.3], [1.5, 1.25], [2.9, 0.16], [3.2, 1.45], [4.8, 0.55], [5.48, 0.62],
    ];
    const ORBITS = [
      { r: 0.765, speed: 2.1, ph: 0 },
      { r: 0.765, speed: 2.1, ph: Math.PI },
      { r: 0.935, speed: -1.35, ph: 1.2 },
    ];

    function rgba(c, a) {
      return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
    }

    function mix(c1, c2, t) {
      return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
    }

    function resize() {
      // Canvas nur so groß wie der Reaktor (plus Rand für das Fadenkreuz),
      // nicht die ganze Bühne -> deutlich weniger Pixel pro Bild.
      const r = el.reactorWrap.getBoundingClientRect();
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      const side = Math.max(1, Math.min(r.width, r.height));
      W = Math.max(1, Math.floor(Math.min(r.width, side * 1.1)));
      H = Math.max(1, Math.floor(side));
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      const cw = Math.round(W * dpr);
      const ch = Math.round(H * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    }

    function setState(st) {
      if (st === 'error') {
        // Fehler: der Blitz liegt über dem bisherigen Zustand
        return;
      }
      visState = st;
      target = T[st] || T.idle;
    }

    function flashNow() {
      flash = 1;
    }

    function update(dt) {
      const sf = reducedMotion ? 0.3 : 1;
      const k = 1 - Math.exp(-dt / 0.13);
      for (const key of ['rot', 'seg', 'pulseHz', 'pulseAmp', 'bright', 'expand', 'listen', 'eq', 'orbit', 'mute']) {
        cur[key] += (target[key] - cur[key]) * k;
      }
      for (const key of ['p', 'a', 'core']) {
        for (let i = 0; i < 3; i++) cur[key][i] += (target[key][i] - cur[key][i]) * k;
      }

      time += dt * sf;
      aTicks += dt * 0.05 * cur.rot * sf;
      aSeg -= dt * cur.seg * sf;
      aCoil += dt * 0.07 * cur.rot * sf;
      aInner -= dt * 0.3 * cur.rot * sf;
      aDash += dt * 14 * cur.rot * sf;
      aSweep += dt * 2.3 * sf;
      phase += dt * Math.PI * 2 * cur.pulseHz * (reducedMotion ? 0.5 : 1);

      // Pegel glätten (schneller Anstieg, langsamer Abfall)
      const fresh = nowMs() - S.levelAt < 450;
      const want = fresh && (visState === 'listening' || visState === 'speaking') ? S.levelTarget : 0;
      const tau = want > lvl ? 0.055 : 0.2;
      lvl += (want - lvl) * (1 - Math.exp(-dt / tau));

      // Equalizer
      const ke = 1 - Math.exp(-dt / 0.07);
      for (let i = 0; i < N_EQ; i++) {
        const u = Math.abs((i / N_EQ) * 2 - 1); // gespiegelt
        const n = 0.5 + 0.28 * Math.sin(u * 9.0 + time * 4.2) + 0.22 * Math.sin(u * 23.0 - time * 6.9);
        const tgt = lvl * (0.18 + 0.82 * clamp(n, 0, 1));
        eqVals[i] += (tgt - eqVals[i]) * ke;
      }

      // Wellen beim Zuhören
      if (cur.listen > 0.5 && time >= nextRipple) {
        ripples.push(time);
        nextRipple = time + 1.25 / (1 + lvl * 1.5);
      }
      while (ripples.length && time - ripples[0] > 1.7) ripples.shift();

      flash *= Math.exp(-dt / 0.42);
      if (flash < 0.003) flash = 0;
      errHold += ((S.errorActive ? 0.32 : 0) - errHold) * (1 - Math.exp(-dt / 0.2));
      boot = Math.min(1, boot + dt / (reducedMotion ? 0.6 : 1.7));
    }

    const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);

    let cx = 0;
    let cy = 0;

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      cx = W / 2;
      cy = H / 2;
      const base = Math.min(W, H) * 0.42;
      if (base < 8) return;

      const redMix = Math.max(flash * 0.85, errHold);
      const P = mix(cur.p, PAL.red, redMix);
      const A = mix(cur.a, PAL.red, redMix);
      const CORE = mix(cur.core, [255, 170, 178], redMix);
      const breathe = 0.5 - 0.5 * Math.cos(phase);
      const pulse = breathe * cur.pulseAmp;
      const B = cur.bright * (0.88 + 0.24 * breathe) + lvl * 0.35 * (cur.listen + cur.eq * 0.6);
      const scale = 1 + 0.035 * cur.expand + 0.03 * lvl * cur.listen;
      const R = base * scale;
      const lb = (i) => easeOut(boot * 1.7 - i * 0.11); // gestaffelter Aufbau
      const rb = (i) => 0.86 + 0.14 * lb(i);

      ctx.lineCap = 'butt';
      ctx.globalCompositeOperation = 'lighter';

      // (Das weiche Umgebungsglühen liegt als CSS-Ebene hinter dem Canvas – spart Füllrate.)

      // --- Fadenkreuz-Linien (statisch)
      {
        const a = 0.28 * lb(0) * (0.6 + 0.4 * B);
        ctx.strokeStyle = rgba(P, a);
        ctx.lineWidth = 1;
        ctx.beginPath();
        const r1 = R * 1.07;
        const r2 = R * 1.24;
        ctx.moveTo(cx - r2, cy); ctx.lineTo(cx - r1, cy);
        ctx.moveTo(cx + r1, cy); ctx.lineTo(cx + r2, cy);
        ctx.moveTo(cx, cy - R * 1.055); ctx.lineTo(cx, cy - R * 1.1);
        ctx.moveTo(cx, cy + R * 1.055); ctx.lineTo(cx, cy + R * 1.1);
        // kleine Endhaken
        ctx.moveTo(cx - r2, cy - 4); ctx.lineTo(cx - r2, cy + 4);
        ctx.moveTo(cx + r2, cy - 4); ctx.lineTo(cx + r2, cy + 4);
        ctx.stroke();
      }

      // --- äußerer Skalenring
      {
        const sc = rb(0);
        const rO = R * 0.995 * sc;
        const rI = R * 0.965 * sc;
        const rL = R * 0.935 * sc;
        const n = 120;
        const step = (Math.PI * 2) / n;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const ang = aTicks + i * step;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          const ri = i % 10 === 0 ? rL : rI;
          ctx.moveTo(cx + c * ri, cy + sn * ri);
          ctx.lineTo(cx + c * rO, cy + sn * rO);
        }
        ctx.strokeStyle = rgba(P, 0.4 * B * lb(0));
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, R * 1.025 * sc, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(P, 0.13 * B * lb(0));
        ctx.stroke();
      }

      // --- segmentierter Ring (Akzentfarbe)
      {
        const r = R * 0.875 * rb(1);
        const lw = Math.max(2, R * 0.022);
        ctx.beginPath();
        for (const [st, len] of SEGMENTS) {
          const a0 = st + aSeg;
          ctx.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
          ctx.arc(cx, cy, r, a0, a0 + len);
        }
        ctx.strokeStyle = rgba(A, 0.12 * B * lb(1));
        ctx.lineWidth = lw * 3.2;
        ctx.stroke();
        ctx.strokeStyle = rgba(A, 0.85 * B * lb(1));
        ctx.lineWidth = lw;
        ctx.stroke();

        // feiner Begleitring
        ctx.beginPath();
        ctx.arc(cx, cy, r + lw * 2.2, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(A, 0.14 * B * lb(1));
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // --- gestrichelter Ring
      {
        ctx.setLineDash([2, 6]);
        ctx.lineDashOffset = -aDash;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.8 * rb(2), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(P, 0.38 * B * lb(2));
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      // --- Denk-Sweep (Konusverlauf)
      if (cur.orbit > 0.01 && ctx.createConicGradient) {
        const g = ctx.createConicGradient(aSweep, cx, cy);
        g.addColorStop(0, rgba(A, 0));
        g.addColorStop(0.8, rgba(A, 0));
        g.addColorStop(0.995, rgba(A, 0.26 * cur.orbit));
        g.addColorStop(1, rgba(A, 0));
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.84, 0, Math.PI * 2);
        ctx.arc(cx, cy, R * 0.36, 0, Math.PI * 2, true);
        ctx.fillStyle = g;
        ctx.fill();
      }

      // --- Wellenring beim Sprechen
      if (cur.eq > 0.01) {
        const r0 = R * 0.735;
        const M = 90;
        ctx.beginPath();
        for (let i = 0; i <= M; i++) {
          const ang = (i / M) * Math.PI * 2;
          const w =
            Math.sin(ang * 6 + time * 3.1) * 0.55 +
            Math.sin(ang * 11 - time * 4.7) * 0.3 +
            Math.sin(ang * 17 + time * 7.3) * 0.15;
          const rr = r0 + w * R * 0.038 * (0.25 + lvl) * cur.eq;
          const x = cx + Math.cos(ang) * rr;
          const y = cy + Math.sin(ang) * rr;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba(P, 0.45 * cur.eq * B);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // --- Ringe um den Spulenkranz
      {
        const sc = rb(3);
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.68 * sc, 0, Math.PI * 2);
        ctx.moveTo(cx + R * 0.465 * sc, cy);
        ctx.arc(cx, cy, R * 0.465 * sc, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(P, 0.42 * B * lb(3));
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // --- Spulenkranz (10 Segmente)
      {
        const sc = rb(4);
        const rO = R * 0.64 * sc;
        const rI = R * 0.5 * sc;
        const n = 10;
        const gap = 0.1;
        const seg = (Math.PI * 2) / n;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const a0 = aCoil + i * seg + gap / 2;
          const a1 = a0 + seg - gap;
          ctx.moveTo(cx + Math.cos(a0) * rO, cy + Math.sin(a0) * rO);
          ctx.arc(cx, cy, rO, a0, a1);
          ctx.arc(cx, cy, rI, a1, a0, true);
          ctx.closePath();
        }
        const fillA = (0.1 + 0.08 * B + lvl * 0.3 * cur.listen + lvl * 0.12 * cur.eq) * lb(4);
        const g = ctx.createRadialGradient(cx, cy, rI, cx, cy, rO);
        g.addColorStop(0, rgba(P, fillA * 1.5));
        g.addColorStop(1, rgba(P, fillA * 0.45));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = rgba(P, 0.62 * B * lb(4));
        ctx.lineWidth = 1.1;
        ctx.stroke();

        // Wicklungen
        const w0 = rI + (rO - rI) * 0.22;
        const w1 = rO - (rO - rI) * 0.22;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const a0 = aCoil + i * seg + gap / 2;
          for (let j = 1; j <= 3; j++) {
            const ang = a0 + ((seg - gap) * j) / 4;
            const c = Math.cos(ang);
            const sn = Math.sin(ang);
            ctx.moveTo(cx + c * w0, cy + sn * w0);
            ctx.lineTo(cx + c * w1, cy + sn * w1);
          }
        }
        ctx.strokeStyle = rgba(P, 0.26 * B * lb(4));
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // --- innerer Skalenring
      {
        const sc = rb(5);
        const rO = R * 0.415 * sc;
        const rI = R * 0.395 * sc;
        const rL = rI - R * 0.015;
        const n = 60;
        const step = (Math.PI * 2) / n;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const ang = aInner + i * step;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          const ri = i % 5 === 0 ? rL : rI;
          ctx.moveTo(cx + c * ri, cy + sn * ri);
          ctx.lineTo(cx + c * rO, cy + sn * rO);
        }
        ctx.strokeStyle = rgba(P, 0.45 * B * lb(5));
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // --- Equalizer um den Kern
      if (cur.eq > 0.01) {
        const r0 = R * 0.335;
        const maxLen = R * 0.12;
        ctx.beginPath();
        for (let i = 0; i < N_EQ; i++) {
          const ang = (i / N_EQ) * Math.PI * 2 - Math.PI / 2;
          const len = (R * 0.01 + eqVals[i] * maxLen) * cur.eq;
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          ctx.moveTo(cx + c * r0, cy + sn * r0);
          ctx.lineTo(cx + c * (r0 + len), cy + sn * (r0 + len));
        }
        ctx.strokeStyle = rgba(mix(P, [255, 255, 255], 0.3), 0.85 * cur.eq);
        ctx.lineWidth = Math.max(1.3, ((Math.PI * 2 * r0) / N_EQ) * 0.42);
        ctx.stroke();
      }

      // --- Kreisende Punkte (Denken)
      if (cur.orbit > 0.01) {
        for (const o of ORBITS) {
          const r = R * o.r;
          const head = o.ph + time * o.speed;
          const dir = Math.sign(o.speed);
          for (let j = 9; j >= 0; j--) {
            const ang = head - dir * j * 0.055;
            const f = 1 - j / 10;
            ctx.beginPath();
            ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, Math.max(1, R * 0.016 * f), 0, Math.PI * 2);
            ctx.fillStyle = rgba(A, (j === 0 ? 1 : 0.5 * f) * cur.orbit);
            ctx.fill();
          }
          const hx = cx + Math.cos(head) * r;
          const hy = cy + Math.sin(head) * r;
          const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.07);
          g.addColorStop(0, rgba(A, 0.5 * cur.orbit));
          g.addColorStop(1, rgba(A, 0));
          ctx.fillStyle = g;
          ctx.fillRect(hx - R * 0.07, hy - R * 0.07, R * 0.14, R * 0.14);
        }
      }

      // --- Wellen (Zuhören)
      for (const born of ripples) {
        const a = (time - born) / 1.7;
        const r = R * (0.9 + a * 0.24);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(P, Math.pow(1 - a, 2) * 0.5 * cur.listen * (0.6 + lvl));
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // --- Kern
      {
        const coreR = R * 0.25 * (1 + pulse + lvl * 0.38 * cur.listen + lvl * 0.12 * cur.eq) * (1 - 0.12 * cur.mute) * (0.6 + 0.4 * lb(6));
        const glowR = coreR * 2.5;
        let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        g.addColorStop(0, rgba(CORE, 0.55 * B));
        g.addColorStop(0.3, rgba(P, 0.28 * B));
        g.addColorStop(0.62, rgba(P, 0.07 * B));
        g.addColorStop(1, rgba(P, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
        ctx.fill();

        g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
        g.addColorStop(0, rgba([255, 255, 255], 0.95 * B * lb(6)));
        g.addColorStop(0.35, rgba(CORE, 0.8 * B * lb(6)));
        g.addColorStop(0.8, rgba(P, 0.3 * B * lb(6)));
        g.addColorStop(1, rgba(P, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
        ctx.fill();

        // Kernring
        const rr = R * 0.3 * rb(6);
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(P, 0.16 * B * lb(6));
        ctx.lineWidth = Math.max(4, R * 0.06);
        ctx.stroke();
        ctx.strokeStyle = rgba(CORE, 0.9 * B * lb(6));
        ctx.lineWidth = Math.max(1.5, R * 0.016);
        ctx.stroke();

        // kleiner innerer Ring
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.165, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(CORE, 0.35 * B * lb(6));
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // --- Stumm: rote Kontur und durchgestrichenes Mikrofon
      if (cur.mute > 0.01) {
        const m = cur.mute;
        const r = R * 0.915;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(PAL.red, 0.55 * m);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a0 = Math.PI / 4 + (i * Math.PI) / 2 - 0.16 + aTicks * 0.5;
          ctx.moveTo(cx + Math.cos(a0) * (r + 6), cy + Math.sin(a0) * (r + 6));
          ctx.arc(cx, cy, r + 6, a0, a0 + 0.32);
        }
        ctx.strokeStyle = rgba(PAL.red, 0.7 * m);
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.globalCompositeOperation = 'source-over';
        const sz = R * 0.13;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = 'rgba(12,4,8,' + (0.72 * m).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(0, 0, sz * 1.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rgba(PAL.red, 0.95 * m);
        ctx.lineWidth = Math.max(1.5, sz * 0.13);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // Kapsel
        const cw = sz * 0.5;
        const top = -sz * 0.78;
        const bot = sz * 0.12;
        ctx.beginPath();
        ctx.moveTo(-cw / 2, top + cw / 2);
        ctx.arc(0, top + cw / 2, cw / 2, Math.PI, 0);
        ctx.lineTo(cw / 2, bot - cw / 2);
        ctx.arc(0, bot - cw / 2, cw / 2, 0, Math.PI);
        ctx.closePath();
        // Bügel, Stiel, Fuß
        ctx.moveTo(-sz * 0.52, -sz * 0.22);
        ctx.arc(0, -sz * 0.22, sz * 0.52, Math.PI, 0, true);
        ctx.moveTo(0, sz * 0.3);
        ctx.lineTo(0, sz * 0.62);
        ctx.moveTo(-sz * 0.3, sz * 0.62);
        ctx.lineTo(sz * 0.3, sz * 0.62);
        // Schrägstrich
        ctx.moveTo(-sz * 0.72, -sz * 0.82);
        ctx.lineTo(sz * 0.72, sz * 0.82);
        ctx.stroke();
        ctx.restore();
        ctx.lineCap = 'butt';
        ctx.globalCompositeOperation = 'lighter';
      }

      // --- Fehler: roter Schockring
      if (flash > 0.01) {
        const r = R * (0.95 + (1 - flash) * 0.38);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(PAL.red, 0.85 * flash);
        ctx.lineWidth = 2 + 4 * flash;
        ctx.stroke();
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
        g.addColorStop(0, rgba(PAL.red, 0.28 * flash));
        g.addColorStop(1, rgba(PAL.red, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cx - R * 1.3, cy - R * 1.3, R * 2.6, R * 2.6);
      }

      ctx.globalCompositeOperation = 'source-over';
    }

    let last = 0;
    let lastDraw = 0;

    function frame(now) {
      requestAnimationFrame(frame);
      // Ruhige Zustände (oder Fenster ohne Fokus) mit 30 fps, sonst 60 fps -> spart CPU.
      const calm = ((visState === 'idle' || visState === 'muted') && flash === 0 && boot >= 1) || !document.hasFocus();
      const minGap = calm ? 1000 / 30 - 3 : 1000 / 60 - 3;
      if (now - lastDraw < minGap) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      lastDraw = now;
      update(dt);
      draw();
    }

    function start() {
      resize();
      if (window.ResizeObserver) {
        new ResizeObserver(() => resize()).observe(el.reactorWrap);
      }
      window.addEventListener('resize', resize);
      if (window.matchMedia) {
        // Wechsel der Bildschirmskalierung (z. B. Fenster auf anderen Monitor gezogen)
        const watchDpr = () => {
          const mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
          const onChange = () => { resize(); watchDpr(); };
          if (mq.addEventListener) mq.addEventListener('change', onChange, { once: true });
        };
        watchDpr();
      }
      requestAnimationFrame(frame);
    }

    return { start, setState, flash: flashNow };
  })();

  // ==================================================================
  //   Demo-Modus (gefälschte API mit denselben Methoden)
  // ==================================================================

  function createDemo(freeze) {
    const FROZEN = STATES.includes(freeze) ? freeze : null;
    const MODEL = 'Claude Sonnet 4.5';
    const queue = [];
    const push = (ev) => queue.push(ev);
    let gen = 0;
    let muted = FROZEN === 'muted';
    let mode = 'idle';
    let msgSeq = 0;
    let cpu = 18;
    let ram = 47;
    let turn = 0;
    const timers = [];

    const nowText = () => {
      const d = new Date();
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    };

    const CONVO = [
      ['Wie wird das Wetter morgen?', () => 'Morgen wird es sonnig, Sir, bei etwa achtzehn Grad.'],
      ['Wie spät ist es?', () => 'Es ist ' + nowText() + ' Uhr, Sir.'],
      ['Erinnere mich in zehn Minuten an den Tee.', () => 'Sehr wohl, Sir. In zehn Minuten erinnere ich Sie an den Tee.'],
      ['Spiel etwas Musik.', () => 'Gern, Sir. Ich starte Ihre Wiedergabeliste „Werkstatt“.'],
    ];

    function setState(s) {
      mode = s;
      push({ type: 'state', value: s });
    }

    // Pegel und Systemwerte simulieren
    timers.push(setInterval(() => {
      if (mode !== 'listening' && mode !== 'speaking') return;
      const t = nowMs() / 1000;
      let v;
      if (mode === 'speaking') {
        const syl = Math.max(0, Math.sin(t * 8.5) * 0.55 + Math.sin(t * 21.0) * 0.25 + 0.3);
        v = syl * (0.65 + 0.35 * Math.sin(t * 1.6)) + Math.random() * 0.08;
      } else {
        v = 0.12 + 0.6 * Math.abs(Math.sin(t * 2.9)) * Math.abs(Math.sin(t * 0.8 + 1)) + Math.random() * 0.1;
      }
      push({ type: 'level', value: clamp(v, 0, 1) });
    }, 70));

    const pushStats = () => {
      const busy = mode === 'thinking' ? 22 : mode === 'speaking' ? 10 : 0;
      cpu = clamp(cpu + (Math.random() - 0.5) * 9 + (12 + busy - cpu) * 0.25, 3, 97);
      ram = clamp(ram + (Math.random() - 0.5) * 1.2 + (47 - ram) * 0.05, 20, 95);
      push({ type: 'stats', cpu: +cpu.toFixed(1), ram: +ram.toFixed(1) });
    };
    timers.push(setInterval(pushStats, 1500));

    const pause = (g, ms) => sleep(ms).then(() => g === gen);

    async function speak(g, answer) {
      const id = 'demo-' + ++msgSeq;
      setState('speaking');
      push({ type: 'message', role: 'jarvis', id, text: '', model: MODEL, final: false });
      if (!(await pause(g, 450))) return false;
      const words = answer.split(' ');
      for (let k = 1; k <= words.length; k++) {
        push({ type: 'message', role: 'jarvis', id, text: words.slice(0, k).join(' '), model: MODEL, final: k === words.length });
        if (!(await pause(g, 120 + Math.random() * 90))) {
          push({ type: 'message', role: 'jarvis', id, text: words.slice(0, k).join(' ') + ' …', model: MODEL, final: true });
          return false;
        }
      }
      return pause(g, Math.max(1400, answer.length * 30));
    }

    async function exchange(g, question, answer, byVoice) {
      if (byVoice) {
        setState('listening');
        if (!(await pause(g, 2600))) return false;
      }
      push({ type: 'message', role: 'user', text: question });
      setState('thinking');
      if (!(await pause(g, byVoice ? 1900 : 1200))) return false;
      return speak(g, answer);
    }

    async function cycle(g) {
      while (g === gen) {
        setState(muted ? 'muted' : 'idle');
        if (!(await pause(g, turn === 0 ? 2200 : 7000))) return;
        if (muted) continue;
        const [q, a] = CONVO[turn % CONVO.length];
        turn += 1;
        if (!(await exchange(g, q, a(), true))) return;
      }
    }

    function frozenLoop(g) {
      if (FROZEN === 'error') {
        setState('idle');
        const tick = () => {
          if (g !== gen) return;
          push({ type: 'state', value: 'error' });
          timers.push(setTimeout(tick, 2400));
        };
        tick();
        return;
      }
      if (muted) setState('muted');
      else setState(FROZEN === 'muted' ? 'idle' : FROZEN);
    }

    function resume(delay) {
      gen += 1;
      const g = gen;
      if (FROZEN) {
        frozenLoop(g);
      } else {
        sleep(delay || 0).then(() => {
          if (g === gen) cycle(g);
        });
      }
    }

    function seedFrozen() {
      push({ type: 'message', role: 'info', text: 'Demo-Modus – keine Verbindung zum Jarvis-Kern, alle Daten sind simuliert.' });
      push({ type: 'message', role: 'user', text: CONVO[0][0] });
      push({ type: 'message', role: 'jarvis', id: 'seed-1', text: CONVO[0][1](), model: MODEL, final: true });
      push({ type: 'message', role: 'user', text: CONVO[1][0] });
      push({ type: 'message', role: 'jarvis', id: 'seed-2', text: CONVO[1][1](), model: MODEL, final: true });
      if (FROZEN === 'thinking') {
        push({ type: 'message', role: 'user', text: CONVO[2][0] });
        push({ type: 'message', role: 'jarvis', id: 'seed-3', text: '', model: MODEL, final: false });
      } else if (FROZEN === 'speaking') {
        push({ type: 'message', role: 'user', text: CONVO[2][0] });
        push({ type: 'message', role: 'jarvis', id: 'seed-3', text: 'Sehr wohl, Sir. In zehn Minuten', model: MODEL, final: false });
      }
    }

    function cannedReply(text) {
      const t = text.toLowerCase();
      if (/wetter|regen|sonne|temperatur/.test(t)) return CONVO[0][1]();
      if (/uhr|spät|zeit/.test(t)) return CONVO[1][1]();
      if (/hallo|hi\b|hey|guten (morgen|tag|abend)/.test(t)) return 'Guten Tag, Sir. Womit kann ich dienen?';
      const short = text.length > 60 ? text.slice(0, 57) + '…' : text;
      return 'Verstanden, Sir: „' + short + '“. Im Demo-Modus kann ich das leider nicht wirklich ausführen – dafür muss ich mit dem Jarvis-Kern verbunden sein.';
    }

    const fake = {
      hello() {
        return Promise.resolve({
          hotkey: 'STRG+ALT+M',
          mic: 'Mikrofon (Realtek High Definition Audio)',
          model: MODEL,
          muted,
          version: '1.0.0',
          weather: '16° · leicht bewölkt · Berlin',
        });
      },
      poll() {
        return new Promise((resolve) => setTimeout(() => resolve(queue.splice(0)), 12));
      },
      send_text(text) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return Promise.resolve(false);
        gen += 1;
        const g = gen;
        (async () => {
          const ok = await exchange(g, t, cannedReply(t), false);
          if (ok && g === gen) resume(1500);
        })();
        return Promise.resolve(true);
      },
      toggle_mute() {
        muted = !muted;
        gen += 1;
        push({ type: 'config', muted });
        setState(muted ? 'muted' : 'idle');
        if (!muted) resume(FROZEN ? 0 : 2500);
        else if (FROZEN) resume(0);
        return Promise.resolve(muted);
      },
      stop() {
        const busy = mode === 'speaking' || mode === 'thinking';
        gen += 1;
        if (busy) push({ type: 'message', role: 'info', text: 'Antwort abgebrochen.' });
        setState(muted ? 'muted' : 'idle');
        resume(4000);
        return Promise.resolve(true);
      },
      new_conversation() {
        gen += 1;
        setState(muted ? 'muted' : 'idle');
        resume(3000);
        return Promise.resolve(true);
      },
      destroy() {
        gen += 1;
        timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
        queue.length = 0;
      },
      start() {
        pushStats();
        if (FROZEN) {
          seedFrozen();
          if (FROZEN === 'muted') push({ type: 'config', muted: true });
        } else {
          push({ type: 'message', role: 'info', text: 'Demo-Modus – keine Verbindung zum Jarvis-Kern, alle Daten sind simuliert.' });
        }
        resume(0);
      },
    };
    return fake;
  }

  function startDemo() {
    if (demo || api) return;
    const freeze = (params.get('state') || '').toLowerCase();
    demo = createDemo(freeze);
    demo.start();
    connect(demo, 'demo');
  }

  // ------------------------------------------------------------------ Start

  function boot() {
    bindUi();
    tickClock();
    renderState(true);
    Reactor.start();
    updateChatMeta();
    setLink('wait');

    const demoAllowed = params.get('demo') !== '0';
    window.addEventListener('pywebviewready', () => {
      if (!connectReal()) setTimeout(connectReal, 50);
    });
    if (connectReal()) return;

    const t0 = nowMs();
    const watcher = setInterval(() => {
      if (connectReal()) {
        clearInterval(watcher);
        return;
      }
      if (!api && nowMs() - t0 >= 1500) {
        if (typeof window.pywebview === 'undefined' && demoAllowed) startDemo();
      }
    }, 100);

    // Fokus ins Eingabefeld, damit man direkt tippen kann
    setTimeout(() => {
      try { el.input.focus({ preventScroll: true }); } catch (e) { /* egal */ }
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
