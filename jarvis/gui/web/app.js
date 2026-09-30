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
    listening: 'Hört zu',
    thinking: 'Denkt nach',
    speaking: 'Spricht',
    muted: 'Mikrofon aus',
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
    micLine: $('micLine'),
    micName: $('micName'),
    micChange: $('micChange'),
    modelLine: $('modelLine'),
    modelName: $('modelName'),
    weatherLine: $('weatherLine'),
    weatherText: $('weatherText'),
    clockHM: $('clockHM'),
    clockDate: $('clockDate'),
    chat: document.querySelector('.chat'),
    messages: $('messages'),
    form: $('cmdForm'),
    input: $('cmdInput'),
    sendBtn: $('sendBtn'),
    micBtn: $('micBtn'),
    micBtnText: $('micBtnText'),
    stopBtn: $('stopBtn'),
    newBtn: $('newBtn'),
    setupBtn: $('setupBtn'),
    tryList: $('tryList'),
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

  /** "claude-sonnet-5-5" -> "Sonnet 5.5". Unbekanntes bleibt, wie es ist. */
  function prettyModel(model) {
    const text = String(model || '').trim();
    const m = text.match(/claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?![\d])/i);
    if (!m) return text;
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return m[3] ? name + ' ' + m[2] + '.' + m[3] : name + ' ' + m[2];
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
    // Antwort ist vorbei: Schreibmarken entfernen, leere Platzhalter verwerfen
    if (value === 'idle' || value === 'muted' || value === 'listening') finalizeStreaming();
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
    el.stopBtn.disabled = !(st === 'speaking' || st === 'thinking');
    renderHint(st);
    Reactor.setState(st);
    if (changed && el.stateLabel.animate && !reducedMotion) {
      el.stateLabel.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
  }

  function renderHint(st) {
    const h = el.stateHint;
    h.textContent = '';
    switch (st) {
      case 'idle':
        h.textContent = 'Sag „Hey Jarvis“ oder klick auf den Kreis';
        break;
      case 'listening':
        h.textContent = 'Sprich jetzt, ich höre zu';
        break;
      case 'thinking':
        h.textContent = 'Claude arbeitet an deiner Anfrage';
        break;
      case 'speaking':
        h.textContent = 'Esc oder Stopp unterbricht';
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
          h.append(' schaltet das Mikrofon wieder ein');
        } else {
          h.textContent = 'Das Mikrofon ist aus';
        }
        break;
      }
      case 'error':
        h.textContent = 'Das hat nicht geklappt. Bitte noch einmal versuchen.';
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
    el.micBtnText.textContent = S.muted ? 'Mikrofon einschalten' : 'Stumm schalten';
    b.title = (S.muted ? 'Das Mikrofon ist aus. Einschalten' : 'Mikrofon ausschalten') + hk;
  }

  // ------------------------------------------------------------------ Einstellungen vom Kern

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
      el.modelName.textContent = prettyModel(S.model);
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
      el.setupBtn.title = 'Einstellungen: Mikrofon, Stimme, Wohnort, Claude' + (S.version ? ' · Jarvis ' + S.version : '');
    }
    if (typeof cfg.muted === 'boolean') S.muted = cfg.muted;
    renderState();
  }

  function setLink(mode) {
    S.link = mode;
    el.body.dataset.link = mode;
    el.linkText.textContent = { wait: 'Verbinde …', live: 'Verbunden', demo: 'Demo', offline: 'Getrennt' }[mode] || '';
  }

  // ------------------------------------------------------------------ Uhr

  function tickClock() {
    const d = new Date();
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (el.clockHM.textContent !== hm) el.clockHM.textContent = hm;
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
    // Hinweise ("Bereit ...") zählen nicht als Unterhaltung: die Beispiele bleiben sichtbar.
    el.chat.classList.toggle('has-msgs', !!el.messages.querySelector('.msg-user, .msg-jarvis'));
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
      m._parts.model.textContent = prettyModel(model);
      m._parts.model.title = model;
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

  function finalizeStreaming() {
    const open = el.messages.querySelectorAll('.msg.streaming');
    if (!open.length) return;
    open.forEach((m) => {
      m.classList.remove('streaming');
      if (m.classList.contains('empty')) {
        const oid = m.dataset.id;
        if (oid && msgById.get(oid) === m) msgById.delete(oid);
        m.remove();
      }
    });
    updateChatMeta();
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

  const TOAST_ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    error: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17h.01"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 10"/>',
  };

  function toast(text, kind) {
    const isErr = kind === 'error';
    const type = isErr ? 'error' : kind === 'ok' ? 'ok' : 'info';
    const t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.setAttribute('role', isErr ? 'alert' : 'status');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'ico');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = TOAST_ICONS[type];
    const body = document.createElement('span');
    body.className = 'toast-text';
    body.textContent = text == null ? '' : String(text);
    t.append(icon, body);
    el.toasts.append(t);
    while (el.toasts.childElementCount > 3) el.toasts.firstElementChild.remove();
    const hide = () => {
      if (!t.isConnected || t.classList.contains('out')) return;
      t.classList.add('out');
      setTimeout(() => t.remove(), 200);
    };
    setTimeout(hide, isErr ? 7000 : 4000);
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
        break; // CPU/RAM zeigt das Fenster bewusst nicht mehr an
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
      try { evs = JSON.parse(evs); } catch { return; }
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
          try { cfg = JSON.parse(cfg); } catch { cfg = null; }
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
    open_setup: () => window.pywebview.api.open_setup(),
    listen_now: () => window.pywebview.api.listen_now(),
  };

  function realApiReady() {
    try {
      const a = window.pywebview && window.pywebview.api;
      return !!(a && typeof a.poll === 'function');
    } catch {
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

  function openSetup() {
    if (!api) {
      toast('Noch keine Verbindung zu Jarvis.', 'error');
      return;
    }
    if (api === demo) {
      location.href = 'setup.html';
      return;
    }
    el.setupBtn.disabled = true;
    toast('Die Einrichtung öffnet sich. Danach startet Jarvis von selbst neu.', 'info');
    callApi('open_setup')
      .then((ok) => {
        if (ok === false) {
          el.setupBtn.disabled = false;
          toast('Die Einrichtung ließ sich nicht öffnen.', 'error');
        }
      })
      .catch((err) => {
        console.warn('Jarvis: open_setup() fehlgeschlagen', err);
        el.setupBtn.disabled = false;
        toast('Die Einrichtung ließ sich nicht öffnen.', 'error');
      });
  }

  /** Klick auf den Reaktor: Jarvis hört sofort zu, ohne „Hey Jarvis“. */
  function listenNow() {
    if (!api) {
      toast('Noch keine Verbindung zu Jarvis.', 'error');
      return;
    }
    if (S.shown === 'listening') return;
    callApi('listen_now')
      .then((res) => {
        if (typeof res === 'string') {
          try { res = JSON.parse(res); } catch { res = null; }
        }
        if (!res || res.ok) return;
        if (res.reason === 'muted') {
          toast('Das Mikrofon ist stumm. Erst die Mikrofon-Taste drücken.', 'info');
        } else if (res.reason === 'novoice') {
          toast('Die Sprachsteuerung ist gerade aus. Tippen geht aber.', 'info');
        }
      })
      .catch((err) => {
        console.warn('Jarvis: listen_now() fehlgeschlagen', err);
        toast('Zuhören hat nicht geklappt.', 'error');
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
    el.setupBtn.addEventListener('click', openSetup);
    el.micChange.addEventListener('click', openSetup);
    el.reactorWrap.addEventListener('click', listenNow);
    el.reactorWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        listenNow();
      }
    });
    el.tryList.addEventListener('click', (e) => {
      const chip = e.target.closest('.try-chip');
      if (!chip) return;
      el.input.value = chip.textContent;
      updateSendBtn();
      sendText();
    });
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
  //   Der Kreis (Canvas): zeigt ruhig, was Jarvis gerade tut
  // ==================================================================

  const Reactor = (() => {
    const canvas = el.canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    let W = 0;
    let H = 0;
    let dpr = 1;

    // Farben je Zustand (eine Akzentfarbe, Grau für stumm, Rot nur bei Fehlern)
    const COL = {
      idle: [76, 157, 255],
      listening: [110, 182, 255],
      thinking: [76, 157, 255],
      speaking: [128, 190, 255],
      muted: [112, 120, 136],
      error: [240, 85, 90],
    };

    // Zielwerte je Zustand; alles gleitet weich dorthin
    const LOOK = {
      idle: { glow: 0.28, core: 0.8, ring: 0.3, wave: 0, spin: 0, breath: 1, speed: 0.12 },
      listening: { glow: 0.5, core: 1, ring: 0.55, wave: 1, spin: 0, breath: 0.4, speed: 0.2 },
      thinking: { glow: 0.42, core: 0.9, ring: 0.45, wave: 0, spin: 1, breath: 0.6, speed: 0.35 },
      speaking: { glow: 0.5, core: 1, ring: 0.5, wave: 0.55, spin: 0, breath: 0.3, speed: 0.18 },
      muted: { glow: 0.08, core: 0.45, ring: 0.18, wave: 0, spin: 0, breath: 0.3, speed: 0.05 },
    };

    let visState = 'idle';
    const cur = { ...LOOK.idle, col: COL.idle.slice() };
    let target = LOOK.idle;
    let targetCol = COL.idle;
    let time = 0;
    let angle = 0;
    let spinAngle = 0;
    let lvl = 0;
    let flash = 0;
    let running = false;

    function rgba(c, a) {
      return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
    }

    function light(c, t) {
      return [lerp(c[0], 255, t), lerp(c[1], 255, t), lerp(c[2], 255, t)];
    }

    function resize() {
      const r = el.reactorWrap.getBoundingClientRect();
      dpr = clamp(window.devicePixelRatio || 1, 1, 2);
      W = Math.max(1, Math.floor(r.width));
      H = Math.max(1, Math.floor(r.height));
      const cw = Math.round(W * dpr);
      const ch = Math.round(H * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
    }

    function setState(st) {
      if (st === 'error') {
        flash = 1;
        return;
      }
      visState = LOOK[st] ? st : 'idle';
      target = LOOK[visState];
      targetCol = COL[visState];
    }

    function flashNow() {
      flash = 1;
    }

    function update(dt) {
      const k = 1 - Math.exp(-dt / 0.18);
      for (const key of ['glow', 'core', 'ring', 'wave', 'spin', 'breath', 'speed']) {
        cur[key] += (target[key] - cur[key]) * k;
      }
      const col = flash > 0.01 ? COL.error : targetCol;
      const kc = 1 - Math.exp(-dt / (flash > 0.01 ? 0.08 : 0.3));
      for (let i = 0; i < 3; i++) cur.col[i] += (col[i] - cur.col[i]) * kc;

      const motion = reducedMotion ? 0.25 : 1;
      time += dt * motion;
      angle += dt * cur.speed * motion;
      spinAngle += dt * (1.2 + 2.2 * cur.spin) * motion;

      // Pegel: schnell hoch, langsam runter, nach kurzer Funkstille auf 0
      const fresh = nowMs() - S.levelAt < 400;
      const want = fresh && (visState === 'listening' || visState === 'speaking') ? S.levelTarget : 0;
      lvl += (want - lvl) * (1 - Math.exp(-dt / (want > lvl ? 0.05 : 0.22)));

      flash *= Math.exp(-dt / 0.5);
      if (flash < 0.004) flash = 0;
    }

    function draw() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) * 0.34;
      if (R < 12) return;

      const c = cur.col;
      const breath = 0.5 + 0.5 * Math.sin(time * 1.6);
      const pulse = cur.breath * breath * 0.04 + lvl * 0.14;

      // 1) Weiches Licht hinter dem Kreis
      const glowR = R * (1.55 + lvl * 0.25);
      const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, glowR);
      g.addColorStop(0, rgba(c, 0.22 * cur.glow + lvl * 0.12));
      g.addColorStop(0.55, rgba(c, 0.07 * cur.glow));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();

      // 2) Äußerer Ring, dezent
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(c, 0.12 + 0.1 * cur.ring);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // 3) Zwölf kurze Bögen (angelehnt an den Arc Reactor), drehen sich langsam
      const segR = R * 0.8;
      const segs = 12;
      const gap = 0.09;
      ctx.lineWidth = Math.max(2, R * 0.035);
      ctx.lineCap = 'round';
      for (let i = 0; i < segs; i++) {
        const a0 = angle + (i / segs) * Math.PI * 2 + gap;
        const a1 = angle + ((i + 1) / segs) * Math.PI * 2 - gap;
        ctx.strokeStyle = rgba(c, 0.16 + 0.34 * cur.ring + lvl * 0.25);
        ctx.beginPath();
        ctx.arc(cx, cy, segR, a0, a1);
        ctx.stroke();
      }

      // 4) Nachdenken: ein heller Bogen mit weichem Schweif läuft um den Kreis
      if (cur.spin > 0.02) {
        const len = Math.PI * 0.7;
        const head = rgba(light(c, 0.45), 0.95 * cur.spin);
        ctx.lineWidth = Math.max(2.5, R * 0.04);
        if (ctx.createConicGradient) {
          const cgrad = ctx.createConicGradient(spinAngle - len, cx, cy);
          const f = len / (Math.PI * 2);
          cgrad.addColorStop(0, rgba(c, 0));
          cgrad.addColorStop(f * 0.97, head);
          cgrad.addColorStop(f, rgba(c, 0));
          cgrad.addColorStop(1, rgba(c, 0));
          ctx.strokeStyle = cgrad;
          ctx.beginPath();
          ctx.arc(cx, cy, segR, spinAngle - len, spinAngle);
          ctx.stroke();
        } else {
          ctx.strokeStyle = head;
          ctx.beginPath();
          ctx.arc(cx, cy, segR, spinAngle - len * 0.4, spinAngle);
          ctx.stroke();
        }
      }

      // 5) Zuhören und Sprechen: weiche Welle, die dem Pegel folgt
      if (cur.wave > 0.02) {
        const base = R * 0.62;
        const amp = R * (0.02 + 0.16 * lvl) * cur.wave;
        for (let pass = 0; pass < 2; pass++) {
          ctx.beginPath();
          const n = 120;
          for (let i = 0; i <= n; i++) {
            const th = (i / n) * Math.PI * 2;
            const off = pass ? 1.7 : 0;
            const w = 0.55 * Math.sin(3 * th + time * 2.1 + off)
              + 0.3 * Math.sin(5 * th - time * 3.3 + off)
              + 0.15 * Math.sin(9 * th + time * 5.2);
            const r = base + amp * w;
            const x = cx + Math.cos(th) * r;
            const y = cy + Math.sin(th) * r;
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.closePath();
          ctx.lineWidth = pass ? 1 : 1.8;
          ctx.strokeStyle = rgba(light(c, 0.2), (pass ? 0.3 : 0.75) * cur.wave);
          ctx.stroke();
        }
      }

      // 6) Kern: leuchtende Scheibe, innen hell, außen in der Akzentfarbe
      const coreR = R * 0.38 * (1 + pulse);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, rgba(light(c, 0.8), cur.core));
      cg.addColorStop(0.45, rgba(light(c, 0.35), 0.95 * cur.core));
      cg.addColorStop(0.85, rgba(light(c, 0.02), 0.9 * cur.core));
      cg.addColorStop(1, rgba(c, 0.8 * cur.core));
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // feiner Ring im Kern und ein Rand darum
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba([255, 255, 255], 0.22 * cur.core);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 0.62, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = rgba(light(c, 0.5), 0.3 * cur.core);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    let last = 0;
    let lastDraw = 0;

    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (document.hidden) return;
      const calm = (visState === 'idle' || visState === 'muted') && flash === 0;
      const minGap = calm ? 1000 / 30 - 3 : 1000 / 60 - 3;
      if (now - lastDraw < minGap) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      lastDraw = now;
      update(dt);
      draw();
    }

    function start() {
      if (running) return;
      running = true;
      resize();
      if (window.ResizeObserver) {
        new ResizeObserver(() => resize()).observe(el.reactorWrap);
      }
      window.addEventListener('resize', resize);
      requestAnimationFrame(frame);
    }

    return { start, setState, flash: flashNow };
  })();

  // ==================================================================
  //   Demo-Modus (gefälschte API mit denselben Methoden)
  // ==================================================================

  function createDemo(freeze) {
    const FROZEN = STATES.includes(freeze) ? freeze : null;
    const MODEL = 'claude-sonnet-5-5';
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

    async function speak(g, id, answer) {
      setState('speaking');
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
      if (!(await pause(g, 500))) return false;
      // Antwortblase erscheint schon beim Nachdenken (Tipp-Punkte), dann wird sie gefüllt.
      const id = 'demo-' + ++msgSeq;
      push({ type: 'message', role: 'jarvis', id, text: '', model: MODEL, final: false });
      if (!(await pause(g, byVoice ? 1400 : 900))) {
        push({ type: 'message', role: 'jarvis', id, text: '…', model: MODEL, final: true });
        return false;
      }
      return speak(g, id, answer);
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
          version: '1.1.0',
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
      listen_now() {
        if (muted) return Promise.resolve({ ok: false, reason: 'muted' });
        gen += 1;
        const g = gen;
        const [q, a] = CONVO[turn % CONVO.length];
        turn += 1;
        (async () => {
          const ok = await exchange(g, q, a(), true);
          if (ok && g === gen) resume(1500);
        })();
        return Promise.resolve({ ok: true, reason: '' });
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
      try { el.input.focus({ preventScroll: true }); } catch { /* egal */ }
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
