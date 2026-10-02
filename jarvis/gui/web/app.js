/* ==========================================================================
   Jarvis – Hauptfenster
   Brücke zu Python über pywebview (window.pywebview.api), sonst Demo-Modus.
   Texte aus Ereignissen werden nur als Klartext (textContent) eingesetzt.
   ========================================================================== */
(() => {
  'use strict';

  // ------------------------------------------------------------------ Helfer

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const pad2 = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const params = new URLSearchParams(location.search);
  const motionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => !!(motionMQ && motionMQ.matches);

  // 2,4 s · 12 s · 1:05 min
  function fmtSecs(value) {
    const v = Math.max(0, Number(value) || 0);
    if (v < 10) return v.toFixed(1).replace('.', ',') + ' s';
    if (v < 59.5) return Math.round(v) + ' s';
    const total = Math.round(v);
    return Math.floor(total / 60) + ':' + pad2(total % 60) + ' min';
  }

  const STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted', 'error'];
  const LABELS = {
    idle: 'Bereit',
    listening: 'Hört zu',
    thinking: 'Denkt nach',
    speaking: 'Spricht',
    muted: 'Mikrofon aus',
    error: 'Störung',
  };
  const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September',
    'Oktober', 'November', 'Dezember'];

  // ------------------------------------------------------------------ Zustand

  const S = {
    state: 'idle',
    shown: '',
    muted: false,
    error: false,
    voice: null,          // false = kein Mikrofon, nur Tippen
    listenKey: 'ctrl+alt+j',
    link: 'wait',
    level: 0,
    history: [],          // {key, role, text, time, el}
    pendingEchoes: [],    // getippte Texte, deren Echo vom Backend nicht doppelt erscheinen soll
    subtitleTimer: 0,
    hintTimer: 0,
    gaming: false,
    cpuHistory: [],       // Prozessor der letzten zwei Minuten (alle 2 s ein Wert)
    name: '',             // Vorname für die Begrüßung ([ich] name)
  };

  let api = null;
  let bridgeGen = 0;
  let pollFails = 0;
  let Werkstatt = null; // Ansicht für Programmier-Aufträge (werkstatt.js)
  let Projekte = null; // alle Werkstatt-Projekte (projekte.js)
  let Gedaechtnis = null; // was Jarvis über Georg weiß, Vorschläge (gedaechtnis.js)
  let Koppeln = null; // Handy, Alexa, Konnektoren (koppeln.js)
  let Blaupause = null; // 3D-Modelle als Hologramm (blaupause.js)
  let Weltlage = null; // Satelliten-Erde mit Lagebericht (weltlage.js)
  let handsAllowed = true; // [weltlage] handsteuerung in config.toml

  // ------------------------------------------------------------------ Python-Brücke

  // Alle Aufrufe an Python an einer Stelle. Im Demo-Modus antwortet ein Nachbau.
  const REAL = {
    hello: () => window.pywebview.api.hello(),
    poll: () => window.pywebview.api.poll(),
    send_text: (text) => window.pywebview.api.send_text(text),
    toggle_mute: () => window.pywebview.api.toggle_mute(),
    stop: () => window.pywebview.api.stop(),
    listen_now: () => window.pywebview.api.listen_now(),
    new_conversation: () => window.pywebview.api.new_conversation(),
    open_setup: () => window.pywebview.api.open_setup(),
    reminders: () => window.pywebview.api.reminders(),
    toggle_gaming: () => window.pywebview.api.toggle_gaming(),
    touched: () => window.pywebview.api.touched(),
    workshop_state: () => window.pywebview.api.workshop_state(),
    workshop_cancel: () => window.pywebview.api.workshop_cancel(),
    workshop_projects: () => window.pywebview.api.workshop_projects(),
    workshop_new: (text) => window.pywebview.api.workshop_new(text),
    workshop_continue: (folder, text) => window.pywebview.api.workshop_continue(folder, text),
    workshop_run: (folder) => window.pywebview.api.workshop_run(folder),
    workshop_project: (folder) => window.pywebview.api.workshop_project(folder),
    blueprint_state: () => window.pywebview.api.blueprint_state(),
    blueprint_active: (on) => window.pywebview.api.blueprint_active(on),
    blueprint_select: (id) => window.pywebview.api.blueprint_select(id),
    blueprint_edit: (id, changes) => window.pywebview.api.blueprint_edit(id, changes),
    blueprint_undo: (redo) => window.pywebview.api.blueprint_undo(redo),
    blueprint_cancel: () => window.pywebview.api.blueprint_cancel(),
    blueprint_save: (name) => window.pywebview.api.blueprint_save(name),
    blueprint_library: () => window.pywebview.api.blueprint_library(),
    blueprint_load: (name) => window.pywebview.api.blueprint_load(name),
    blueprint_delete: (name) => window.pywebview.api.blueprint_delete(name),
    blueprint_export: (name, data) => window.pywebview.api.blueprint_export(name, data),
    blueprint_folder: () => window.pywebview.api.blueprint_folder(),
    weltlage_state: () => window.pywebview.api.weltlage_state(),
    weltlage_active: (on) => window.pywebview.api.weltlage_active(on),
    weltlage_briefing: (kind) => window.pywebview.api.weltlage_briefing(kind),
    weltlage_focus: (index) => window.pywebview.api.weltlage_focus(index),
    weltlage_stop: () => window.pywebview.api.weltlage_stop(),
    weltlage_fly: (name) => window.pywebview.api.weltlage_fly(name),
    weltlage_markets: () => window.pywebview.api.weltlage_markets(),
    weltlage_flights: (box) => window.pywebview.api.weltlage_flights(box),
    weltlage_look: (mode) => window.pywebview.api.weltlage_look(mode),
    workshop_delete: (folder) => window.pywebview.api.workshop_delete(folder),
    workshop_tell: (text) => window.pywebview.api.workshop_tell(text),
    workshop_preview: (folder) => window.pywebview.api.workshop_preview(folder),
    open_folder: (path) => window.pywebview.api.open_folder(path),
    memory_state: () => window.pywebview.api.memory_state(),
    phone_info: () => window.pywebview.api.phone_info(),
    connections: () => window.pywebview.api.connections(),
    push_info: () => window.pywebview.api.push_info(),
    push_enable: (on) => window.pywebview.api.push_enable(on),
    push_test: () => window.pywebview.api.push_test(),
    phone_enable: (on) => window.pywebview.api.phone_enable(on),
    phone_new_key: () => window.pywebview.api.phone_new_key(),
    alexa_info: () => window.pywebview.api.alexa_info(),
    alexa_enable: (on) => window.pywebview.api.alexa_enable(on),
    alexa_copy: (which) => window.pywebview.api.alexa_copy(which),
    alexa_console: () => window.pywebview.api.alexa_console(),
    alexa_test: () => window.pywebview.api.alexa_test(),
    wol_prepare: () => window.pywebview.api.wol_prepare(),
    tailscale_info: () => window.pywebview.api.tailscale_info(),
    tailscale_enable: (on) => window.pywebview.api.tailscale_enable(on),
    tailscale_help: (which) => window.pywebview.api.tailscale_help(which),
    connectors: (fresh) => window.pywebview.api.connectors(!!fresh),
    connectors_help: () => window.pywebview.api.connectors_help(),
    remember: (text) => window.pywebview.api.remember(text),
    forget: (text) => window.pywebview.api.forget(text),
    command_forget: (key) => window.pywebview.api.command_forget(key),
    skill_forget: (name) => window.pywebview.api.skill_forget(name),
    schedule_forget: (id) => window.pywebview.api.schedule_forget(id),
    notebook_open: () => window.pywebview.api.notebook_open(),
    answer_suggestion: (answer) => window.pywebview.api.answer_suggestion(answer),
  };

  function call(name, ...args) {
    if (!api || typeof api[name] !== 'function') return Promise.reject(new Error('nicht verbunden: ' + name));
    try {
      return Promise.resolve(api[name](...args));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function realReady() {
    try {
      return !!(window.pywebview && window.pywebview.api && typeof window.pywebview.api.hello === 'function');
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ DOM

  const el = {
    body: document.body,
    linkText: $('linkText'),
    weather: $('weather'),
    weatherText: $('weatherText'),
    clockTime: $('clockTime'),
    clockDate: $('clockDate'),
    greetTitle: $('greetTitle'),
    cpuNum: $('cpuNum'),
    cpuRing: $('cpuRing'),
    ramNum: $('ramNum'),
    ramRing: $('ramRing'),
    sparkLine: $('sparkLine'),
    sparkFill: $('sparkFill'),
    micName: $('micName'),
    micHint: $('micHint'),
    listenKey: $('listenKey'),
    micChange: $('micChange'),
    gamingToggle: $('gamingToggle'),
    gamingText: $('gamingText'),
    coreWrap: $('coreWrap'),
    core: $('core'),
    stateLabel: $('stateLabel'),
    stateHint: $('stateHint'),
    status: document.querySelector('.status'),
    activity: $('activity'),
    subtitles: $('subtitles'),
    subUser: $('subUser'),
    subJarvis: $('subJarvis'),
    today: $('today'),
    todayEmpty: $('todayEmpty'),
    recent: $('recent'),
    recentEmpty: $('recentEmpty'),
    historyOpen: $('historyOpen'),
    drawer: $('drawer'),
    drawerShade: $('drawerShade'),
    history: $('history'),
    historyEmpty: $('historyEmpty'),
    historyClose: $('historyClose'),
    newBtn: $('newBtn'),
    micBtn: $('micBtn'),
    micBtnText: $('micBtnText'),
    form: $('cmdForm'),
    input: $('cmdInput'),
    sendBtn: $('sendBtn'),
    stopBtn: $('stopBtn'),
    setupBtn: $('setupBtn'),
    toasts: $('toasts'),
  };

  // ------------------------------------------------------------------ Tastenkürzel

  const KEYNAMES = {
    ctrl: 'Strg', control: 'Strg', strg: 'Strg', alt: 'Alt', altgr: 'AltGr', shift: 'Umschalt',
    umschalt: 'Umschalt', win: 'Win', windows: 'Win', space: 'Leertaste', pause: 'Pause',
  };

  function hotkeyLabel(hk) {
    if (typeof hk !== 'string' || !hk.trim()) return '';
    return hk.split('+').map((p) => {
      const low = p.trim().toLowerCase();
      if (KEYNAMES[low]) return KEYNAMES[low];
      return low.length === 1 || /^f\d{1,2}$/.test(low) ? low.toUpperCase() : low.charAt(0).toUpperCase() + low.slice(1);
    }).join(' + ');
  }

  // ------------------------------------------------------------------ Hinweise (Toasts)

  const TOAST_ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 10"/>',
    error: '<path d="M12 4 2.8 20h18.4L12 4z"/><path d="M12 10v4M12 17h.01"/>',
  };

  function toast(text, kind) {
    kind = TOAST_ICONS[kind] ? kind : 'info';
    const box = document.createElement('div');
    box.className = 'toast toast-' + kind;
    box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const ns = 'http://www.w3.org/2000/svg';
    const ico = document.createElementNS(ns, 'svg');
    ico.setAttribute('viewBox', '0 0 24 24');
    ico.setAttribute('class', 'ico');
    ico.innerHTML = TOAST_ICONS[kind];
    const span = document.createElement('span');
    span.className = 'toast-text';
    span.textContent = String(text || '');
    box.append(ico, span);
    const close = () => {
      if (!box.isConnected) return;
      box.classList.add('out');
      setTimeout(() => box.remove(), 200);
    };
    box.addEventListener('click', close);
    el.toasts.append(box);
    while (el.toasts.childElementCount > 3) el.toasts.firstElementChild.remove();
    setTimeout(close, kind === 'error' ? 9000 : 4500);
  }

  // ------------------------------------------------------------------ Zustand anzeigen

  function effectiveState() {
    if (S.error) return 'error';
    if (S.muted && (S.state === 'idle' || S.state === 'muted' || S.state === 'listening')) return 'muted';
    if (!S.muted && S.state === 'muted') return 'idle';
    return S.state;
  }

  function hintFor(state) {
    if (state === 'idle' && S.voice === false) return 'Kein Mikrofon gefunden. Unten können Sie mir schreiben.';
    return {
      idle: '„Hey Jarvis“ sagen, auf die Kugel klicken oder unten schreiben',
      listening: S.talking ? 'Einfach weiterreden … „Danke“ beendet das Gespräch' : 'Ich höre …',
      thinking: 'Einen Moment …',
      speaking: '„Stopp“ unterbricht mich',
      muted: 'Das Mikrofon ist aus. Der Knopf unten links schaltet es wieder ein.',
      error: 'Da ist etwas schiefgelaufen. Einzelheiten stehen im Protokoll.',
    }[state];
  }

  // Beim Nachdenken steht oben, was Jarvis gerade wirklich tut ("Installiert Spotify")
  function labelFor(state) {
    const run = state === 'thinking' ? Activity.running() : null;
    return run ? String(run.label || LABELS[state]) : LABELS[state];
  }

  function setLabel(text, force) {
    if (el.stateLabel.textContent === text && !force) return;
    el.stateLabel.textContent = text;
    el.stateLabel.title = text;
    el.stateLabel.classList.remove('swap');
    void el.stateLabel.offsetWidth;
    el.stateLabel.classList.add('swap');
  }

  function renderState(force) {
    const state = effectiveState();
    if (state === S.shown && !force) return;
    S.shown = state;
    el.body.dataset.state = state;
    setLabel(labelFor(state), force);
    if (!S.hintTimer) el.stateHint.textContent = hintFor(state);
    el.stopBtn.disabled = !(state === 'speaking' || state === 'thinking');
    Core.setState(state);
    if (state === 'listening') {
      // Neue Frage: alte Untertitel und Schritte weg
      clearTimeout(S.subtitleTimer);
      el.subtitles.classList.remove('fade');
      el.subUser.textContent = '';
      setJarvisText('');
      Activity.reset();
    }
    if (state === 'idle' && (el.subJarvis.textContent || Activity.count())) scheduleSubtitleFade();
  }

  function applyState(value) {
    if (typeof value !== 'string' || !STATES.includes(value)) return;
    if (value === 'error') {
      S.error = true;
      renderState();
      setTimeout(() => {
        S.error = false;
        renderState();
      }, 2600);
      return;
    }
    S.state = value;
    renderState();
  }

  function showHint(text, ms) {
    clearTimeout(S.hintTimer);
    el.stateHint.textContent = text;
    S.hintTimer = setTimeout(() => {
      S.hintTimer = 0;
      el.stateHint.textContent = hintFor(effectiveState());
    }, ms || 4000);
  }

  // ------------------------------------------------------------------ Untertitel

  let shownWords = [];

  function setJarvisText(text) {
    const words = String(text || '').split(/(\s+)/).filter((w) => w.length);
    // Gleicher Anfang: nur die neuen Wörter einblenden
    let same = 0;
    while (same < shownWords.length && same < words.length && shownWords[same] === words[same]) same += 1;
    if (same < shownWords.length) {
      el.subJarvis.replaceChildren();
      same = 0;
    }
    const delayBase = reducedMotion() ? 0 : 28;
    for (let i = same; i < words.length; i += 1) {
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = words[i];
      span.style.animationDelay = ((i - same) * delayBase) + 'ms';
      el.subJarvis.append(span);
    }
    shownWords = words;
  }

  function scheduleSubtitleFade() {
    clearTimeout(S.subtitleTimer);
    S.subtitleTimer = setTimeout(() => {
      if (effectiveState() !== 'idle') return;
      el.subtitles.classList.add('fade');
      Activity.fade();
      setTimeout(() => {
        if (!el.subtitles.classList.contains('fade')) return;
        el.subUser.textContent = '';
        setJarvisText('');
        el.subtitles.classList.remove('fade');
        Activity.reset();
      }, 650);
    }, 14000);
  }

  // ------------------------------------------------------------------ Verlauf

  function timeNow() {
    const d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function addMessage(role, text, id, final, model) {
    role = ['user', 'jarvis', 'info'].includes(role) ? role : 'info';
    text = String(text || '');
    if (role === 'user') {
      // Getippter Text erscheint sofort; das Echo vom Backend nicht noch einmal.
      const i = S.pendingEchoes.findIndex((p) => p.text === text.trim() && Date.now() - p.at < 20000);
      if (i >= 0) {
        S.pendingEchoes.splice(i, 1);
        return;
      }
    }
    const key = id ? role + ':' + id : '';
    let item = key ? S.history.find((h) => h.key === key) : null;
    if (item) {
      item.text = text;
      if (item.el) item.el.querySelector('.text').textContent = text;
      if (model && item.model !== model) {
        // Womit Jarvis gedacht hat ("Opus · gründlich"), kommt mit der fertigen Antwort.
        item.model = model;
        if (item.el) item.el.querySelector('time').textContent = metaLine(item);
      }
    } else {
      item = { key, role, text, time: timeNow(), model: model || '', el: null };
      S.history.push(item);
      if (S.history.length > 300) {
        const old = S.history.shift();
        if (old.el) old.el.remove();
      }
      item.el = historyItem(item);
      el.history.append(item.el);
    }
    el.historyEmpty.hidden = S.history.length > 0;
    if (el.drawer.classList.contains('open')) el.history.scrollTop = el.history.scrollHeight;
    renderRecent();

    if (role === 'user') {
      clearTimeout(S.subtitleTimer);
      el.subtitles.classList.remove('fade');
      el.subUser.textContent = text;
      setJarvisText('');
      Activity.reset();
    } else if (role === 'jarvis') {
      clearTimeout(S.subtitleTimer);
      el.subtitles.classList.remove('fade');
      setJarvisText(text);
      if (final !== false && effectiveState() === 'idle') scheduleSubtitleFade();
      if (final !== false) refreshToday();
    } else {
      showHint(text, 5000);
    }
  }

  function historyItem(item) {
    const li = document.createElement('li');
    li.className = item.role;
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = item.text;
    li.append(text);
    if (item.role !== 'info') {
      const time = document.createElement('time');
      time.textContent = metaLine(item);
      li.append(time);
    }
    return li;
  }

  function metaLine(item) {
    const who = (item.role === 'user' ? 'Sie · ' : 'Jarvis · ') + item.time;
    return item.model ? who + ' · ' + item.model : who;
  }

  function renderRecent() {
    if (!el.recent) return; // die Spalte "Zuletzt" gibt es nicht mehr; der Verlauf steht in der Schublade
    const items = S.history.filter((h) => h.role !== 'info' && h.text).slice(-5);
    el.recent.replaceChildren(...items.map((h) => {
      const li = document.createElement('li');
      li.className = h.role;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = h.role === 'user' ? 'Sie' : 'Jarvis';
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = h.text;
      li.append(who, what);
      return li;
    }));
    el.recentEmpty.hidden = items.length > 0;
  }

  function openDrawer(open) {
    el.drawer.classList.toggle('open', open);
    el.drawer.setAttribute('aria-hidden', String(!open));
    el.drawerShade.hidden = !open;
    if (open) {
      el.history.scrollTop = el.history.scrollHeight;
      el.historyClose.focus({ preventScroll: true });
    }
  }

  // ------------------------------------------------------------------ Arbeitsschritte

  const MARK_PATHS = {
    done: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    error: '<path d="M7 7l10 10M17 7 7 17"/>',
  };
  const MARK_WORDS = { running: 'läuft', done: 'erledigt', error: 'Fehler' };

  // Zustandszeichen: drehender Ring, Haken oder Kreuz (nie nur Farbe)
  function markFor(state) {
    const span = document.createElement('span');
    span.className = 'mark mark-' + (state === 'running' ? 'run' : state);
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', MARK_WORDS[state] || '');
    if (MARK_PATHS[state]) {
      const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ico.setAttribute('viewBox', '0 0 24 24');
      ico.innerHTML = MARK_PATHS[state];
      span.append(ico);
    }
    return span;
  }

  // Unter den Untertiteln: was Jarvis für diese Frage tut, höchstens drei Zeilen.
  const Activity = (() => {
    const steps = new Map(); // id -> {data, el, firstSeen}
    const more = document.createElement('li');
    more.className = 'act-more';
    let timer = 0;

    function count() {
      return steps.size;
    }

    function running() {
      let found = null;
      for (const item of steps.values()) if (item.data.state === 'running') found = item.data;
      return found;
    }

    function row() {
      const li = document.createElement('li');
      li.className = 'act';
      const label = document.createElement('span');
      label.className = 'act-label';
      const time = document.createElement('span');
      time.className = 'act-time';
      li.append(document.createElement('span'), label, time);
      return li;
    }

    function paint(item) {
      const d = item.data;
      const state = ['running', 'done', 'error'].includes(d.state) ? d.state : 'done';
      if (item.el.dataset.state !== state) {
        item.el.dataset.state = state;
        item.el.firstElementChild.replaceWith(markFor(state));
      }
      const label = String(d.label || 'Arbeitet');
      item.el.querySelector('.act-label').textContent = label;
      item.el.title = d.detail ? label + ' · ' + d.detail : label;
      item.el.querySelector('.act-time').textContent = state === 'running'
        ? fmtSecs((Date.now() - item.firstSeen) / 1000)
        : fmtSecs(d.seconds);
    }

    function layout() {
      const items = [...steps.values()];
      const extra = items.length - 3;
      items.forEach((item, i) => {
        item.el.hidden = i < extra;
        item.el.classList.toggle('old', i < items.length - 1 && item.data.state !== 'running');
      });
      if (extra > 0) {
        more.textContent = '+ ' + extra + (extra === 1 ? ' früherer Schritt' : ' frühere Schritte');
        if (more.parentNode !== el.activity) el.activity.prepend(more);
      } else {
        more.remove();
      }
    }

    function tick() {
      for (const item of steps.values()) if (item.data.state === 'running') paint(item);
    }

    function sync() {
      const busy = !!running();
      if (busy && !timer) timer = setInterval(tick, 1000);
      if (!busy && timer) {
        clearInterval(timer);
        timer = 0;
      }
    }

    function update(data) {
      if (!data || typeof data !== 'object' || data.id == null) return;
      const id = String(data.id);
      let item = steps.get(id);
      if (!item) {
        item = { data: {}, el: row(), firstSeen: Date.now() - (Number(data.seconds) || 0) * 1000 };
        steps.set(id, item);
        el.activity.append(item.el);
      }
      item.data = Object.assign({}, item.data, data);
      paint(item);
      layout();
      el.activity.classList.remove('fade');
      el.status.classList.add('busy');
      sync();
      if (effectiveState() === 'thinking') setLabel(labelFor('thinking'));
    }

    function reset() {
      steps.clear();
      more.remove();
      el.activity.replaceChildren();
      el.activity.classList.remove('fade');
      el.status.classList.remove('busy');
      sync();
      if (effectiveState() === 'thinking') setLabel(labelFor('thinking'));
    }

    function fade() {
      el.activity.classList.add('fade');
    }

    return { update, reset, running, count, fade };
  })();

  function onProgress(step) {
    if (!step || typeof step !== 'object') return;
    if (step.workshop) {
      if (Werkstatt) Werkstatt.step(step);
      Core.gesture('build', step.state === 'running');
      return;
    }
    Activity.update(step);
    // Die Kugel zeigt, was gerade läuft: Suchen, Öffnen, Installieren ... (eigene Bewegung je Art)
    const run = Activity.running();
    if (run) Core.gesture(run.kind, true);
    else if (step.state === 'done') Core.gesture(step.kind);
    else Core.gesture(null);
  }

  // ------------------------------------------------------------------ Heute (Erinnerungen)

  let todayTimer = 0;

  function refreshToday() {
    clearTimeout(todayTimer);
    todayTimer = setTimeout(async () => {
      try {
        const list = await call('reminders');
        renderToday(Array.isArray(list) ? list : []);
      } catch {
        /* ältere Version ohne Erinnerungs-Abfrage */
      }
    }, 300);
  }

  const KINDS = { termin: 'Termin', erinnerung: 'Erinnerung', wecker: 'Wecker', timer: 'Timer' };

  function renderToday(list) {
    el.today.replaceChildren(...list.slice(0, 6).map((r) => {
      const li = document.createElement('li');
      const time = document.createElement('time');
      const uhr = String(r.uhr || '');
      time.textContent = uhr === 'Tag' ? 'ganz' : uhr;
      li.classList.toggle('all-day', uhr === 'Tag');
      const what = document.createElement('span');
      what.className = 'what';
      const b = document.createElement('b');
      b.textContent = String(r.text || '');
      b.title = b.textContent;
      const small = document.createElement('small');
      const kind = KINDS[String(r.art || '')] || 'Erinnerung';
      const day = r.tag && r.tag !== 'heute' ? String(r.tag) : '';
      small.textContent = [uhr === 'Tag' ? 'ganztägig' : '', kind, day].filter(Boolean).join(' · ');
      what.append(b, small);
      li.append(time, what);
      return li;
    }));
    el.todayEmpty.hidden = list.length > 0;
  }

  // ------------------------------------------------------------------ System, Mikrofon, Gaming

  // Ein Balken je Wert (Prozessor, Speicher, Grafik); ab 85 % orange
  function setGauge(num, bar, value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    const v = clamp(value, 0, 100);
    num.textContent = String(Math.round(v));
    bar.style.width = v.toFixed(1) + '%';
    bar.classList.toggle('high', v >= 85);
  }

  async function sendText(text) {
    addMessage('user', text);
    S.pendingEchoes.push({ text, at: Date.now() });
    try {
      const ok = await call('send_text', text);
      if (ok === false) toast('Das ließ sich nicht senden.', 'error');
    } catch {
      toast('Jarvis ist gerade nicht verbunden.', 'error');
    }
  }

  // Schnellbefehle unter dem Kern: die eigenen Befehle zuerst, dann die häufigsten
  const DECK_DEFAULT = [['Briefing', 'Briefing bitte'], ['Was steht heute an?', 'Was steht heute an?'],
    ['Gaming-Modus', 'Gaming-Modus an']];

  async function refreshDeck() {
    const deck = document.getElementById('deck');
    if (!deck) return;
    let own = [];
    try {
      const state = await call('memory_state');
      own = (state && state.commands) || [];
    } catch {
      own = [];
    }
    const items = own.slice(0, 4).map((c) => [c.name, c.name, c.action]).concat(DECK_DEFAULT).slice(0, 6);
    deck.replaceChildren(...items.map(([label, say, hint]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'deck-chip';
      b.textContent = label;
      b.title = hint ? label + ': ' + hint : say;
      b.addEventListener('click', () => sendText(say));
      return b;
    }));
  }

  // Grafikkarte (nur mit NVIDIA): Auslastung als Balken, Temperatur im Namen
  function renderGpu(gpu) {
    const box = document.getElementById('gpuGauge');
    if (!box || !gpu || typeof gpu.load !== 'number') return;
    box.hidden = false;
    setGauge(document.getElementById('gpuNum'), document.getElementById('gpuRing'), gpu.load);
    const name = document.getElementById('gpuName');
    name.textContent = typeof gpu.temp === 'number' ? 'Grafikkarte · ' + gpu.temp + ' °C' : 'Grafikkarte';
    name.classList.toggle('hot', gpu.temp >= 85);
    box.title = 'Grafikkarte: ' + gpu.load + ' % Last, ' + gpu.temp + ' °C, Grafikspeicher ' + gpu.mem + ' % belegt';
  }

  // Verlaufslinie des Prozessors: die neuesten Werte rechts
  function pushCpu(value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    S.cpuHistory.push(clamp(value, 0, 100));
    if (S.cpuHistory.length > 60) S.cpuHistory.shift();
    const n = S.cpuHistory.length;
    if (n < 6) return; // erst nach ein paar Werten zeichnen, sonst ist es nur ein Strich
    const box = document.getElementById('sparkBox');
    if (box && box.hidden) box.hidden = false;
    const step = 120 / 59;
    const pts = S.cpuHistory.map((v, i) => [120 - (n - 1 - i) * step, 27 - (v / 100) * 24]);
    const line = pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
    el.sparkLine.setAttribute('d', line);
    el.sparkFill.setAttribute('d', line + ' L120 28 L' + pts[0][0].toFixed(1) + ' 28 Z');
  }

  function applyConfig(c) {
    if (!c || typeof c !== 'object') return;
    if ('muted' in c) {
      S.muted = !!c.muted;
      el.micBtn.setAttribute('aria-pressed', String(S.muted));
      el.micBtn.title = S.muted ? 'Mikrofon wieder einschalten' : 'Mikrofon stumm schalten';
      el.micBtnText.textContent = el.micBtn.title;
      renderState();
    }
    if (typeof c.mic === 'string' && c.mic) el.micName.textContent = c.mic;
    if ('voice' in c) {
      S.voice = c.voice;
      if (c.voice === false) el.micName.textContent = 'Kein Mikrofon';
      renderState(true);
    }
    if (typeof c.listen_hotkey === 'string' && c.listen_hotkey) {
      el.listenKey.textContent = c.listen_hotkey.includes('+') && c.listen_hotkey.includes(' ')
        ? c.listen_hotkey : hotkeyLabel(c.listen_hotkey) || c.listen_hotkey;
    }
    if (typeof c.weather === 'string') {
      el.weatherText.textContent = c.weather;
      el.weather.hidden = !c.weather;
    }
    if ('gespraech' in c) {
      // Gespräch: Jarvis hört nach der Antwort weiter zu, ohne "Hey Jarvis"
      S.talking = !!c.gespraech;
      Core.talk(S.talking);
      if (!S.hintTimer) el.stateHint.textContent = hintFor(effectiveState());
    }
    if ('gaming' in c) {
      S.gaming = !!c.gaming;
      el.gamingToggle.checked = S.gaming;
      el.gamingText.textContent = S.gaming ? 'An' : 'Aus';
    }
    if (typeof c.version === 'string' && c.version) el.linkText.title = 'Jarvis ' + c.version;
    if (typeof c.name === 'string') {
      S.name = c.name.trim();
      renderGreeting(new Date());
    }
  }

  function setLink(link) {
    S.link = link;
    el.body.dataset.link = link;
    el.linkText.textContent = { wait: 'Verbinde …', live: 'Online', demo: 'Demo', offline: 'Getrennt' }[link] || link;
  }

  // ------------------------------------------------------------------ Uhr

  // "Guten Abend, Georg" je nach Tageszeit
  function renderGreeting(d) {
    if (!el.greetTitle) return;
    const h = d.getHours();
    const part = h >= 5 && h < 11 ? 'Guten Morgen' : h >= 11 && h < 18 ? 'Guten Tag' : 'Guten Abend';
    const text = S.name ? part + ', ' + S.name : part;
    if (el.greetTitle.textContent !== text) el.greetTitle.textContent = text;
  }

  function tickClock() {
    const d = new Date();
    el.clockTime.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    el.clockDate.textContent = WEEKDAYS[d.getDay()] + ', ' + d.getDate() + '. ' + MONTHS[d.getMonth()];
    renderGreeting(d);
    setTimeout(tickClock, 1000 - (d.getMilliseconds() % 1000) + 5);
  }

  // ------------------------------------------------------------------ Ereignisse

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'state': applyState(String(ev.value || '')); break;
      case 'message':
        addMessage(ev.role, ev.text, ev.id, ev.final, ev.model);
        // In der Blaupause steht, was Jarvis zuletzt gesagt hat, unten neben der Befehlszeile
        if (Blaupause && Blaupause.isOpen() && ev.role === 'jarvis' && ev.final !== false) Blaupause.say(ev.text);
        if (Weltlage && Weltlage.isOpen() && ev.role === 'jarvis' && ev.final !== false) Weltlage.say(ev.text);
        if (ev.model === 'Hinweis' && ev.final !== false) Core.gesture('hint');
        break;
      case 'action': Core.gesture(ev.kind); break;
      case 'progress': onProgress(ev.step); break;
      case 'blueprint':
        if (Blaupause) Blaupause.handle(ev);
        break;
      case 'weltlage':
        if (ev.action === 'hands') setHands(!!ev.on);
        else if (Weltlage) Weltlage.handle(ev);
        break;
      case 'workshop':
        if (Blaupause && Blaupause.isOpen() && ['projects', 'project', 'start'].includes(ev.state)) Blaupause.close();
        if (Weltlage && Weltlage.isOpen() && ['projects', 'project', 'start'].includes(ev.state)) Weltlage.close();
        if (ev.state === 'projects') {
          if (Projekte) Projekte.open();
        } else if (ev.state === 'project') {
          if (Projekte) Projekte.show(ev.folder); // "Zeig mir das Projekt …"
        } else if (ev.state === 'deleted') {
          if (Werkstatt) Werkstatt.handle(ev);
          if (Projekte && Projekte.isOpen()) Projekte.refresh();
        } else if (Werkstatt) {
          if (ev.state === 'start' && Projekte && Projekte.isOpen()) Projekte.close();
          Werkstatt.handle(ev);
        }
        break;
      case 'level': S.level = clamp(Number(ev.value) || 0, 0, 1); Core.level(S.level); break;
      case 'toast': toast(ev.text, ev.kind); break;
      case 'suggestion': if (Gedaechtnis) Gedaechtnis.offer(ev.offer); break;
      case 'config': applyConfig(ev); break;
      case 'stats':
        setGauge(el.cpuNum, el.cpuRing, ev.cpu);
        setGauge(el.ramNum, el.ramRing, ev.ram);
        pushCpu(ev.cpu);
        renderGpu(ev.gpu);
        break;
      default: break;
    }
  }

  async function pollLoop(gen) {
    while (gen === bridgeGen) {
      try {
        const events = await call('poll');
        pollFails = 0;
        if (S.link === 'offline') setLink(api === REAL ? 'live' : 'demo');
        if (Array.isArray(events)) events.forEach(handle);
      } catch {
        pollFails += 1;
        if (pollFails >= 25) setLink('offline');
      }
      await sleep(document.hidden ? 300 : 80);
    }
  }

  async function connect(target, link) {
    bridgeGen += 1;
    api = target;
    setLink(link);
    const gen = bridgeGen;
    try {
      const info = await call('hello');
      applyConfig(info || {});
    } catch {
      /* egal, die Ereignisse kommen trotzdem */
    }
    syncWorkshop();
    call('weltlage_state').then((s) => {
      if (!s) return;
      handsAllowed = s.hands_allowed !== false;
      if (s.active && Weltlage && !Weltlage.isOpen()) Weltlage.handle(Object.assign({ action: 'open' }, s));
      else if (s.look && Weltlage) Weltlage.handle({ action: 'look', mode: s.look, quiet: true });
    }).catch(() => {});
    if (Gedaechtnis) Gedaechtnis.refresh();
    if (Koppeln && Koppeln.dots) Koppeln.dots();
    refreshDeck();
    refreshToday();
    setInterval(refreshToday, 60000);
    pollLoop(gen);
  }

  // ------------------------------------------------------------------ Bedienung

  // Handsteuerung (handsteuerung.js): steuert, was offen ist (Blaupause oder Erde), sonst geht die Erde auf
  function setHands(want) {
    const H = window.JarvisHands;
    if (!H) return;
    if (!want) {
      H.stop();
      if (Weltlage) Weltlage.setHands(false);
      return;
    }
    if (!handsAllowed) {
      toast('Die Handsteuerung ist ausgeschaltet (config.toml, [weltlage] handsteuerung).', 'info');
      if (Weltlage) Weltlage.setHands(false);
      return;
    }
    let target = Blaupause && Blaupause.isOpen() ? Blaupause : null;
    if (!target && Weltlage) {
      if (!Weltlage.isOpen()) Weltlage.open();
      target = Weltlage;
    }
    if (!target) return;
    H.start(target, { toast, onChange: (on) => Weltlage && Weltlage.setHands(on) });
  }

  async function listenNow() {
    Core.pulse();
    try {
      const r = await call('listen_now');
      if (r && r.ok === false) {
        if (r.reason === 'muted') toast('Das Mikrofon ist aus. Schalte es unten links wieder ein.', 'info');
        else toast('Kein Mikrofon bereit. Schreiben Sie Jarvis einfach unten.', 'info');
      }
    } catch {
      toast('Jarvis ist gerade nicht verbunden.', 'error');
    }
  }

  function bindUi() {
    // Schmales Fenster: kürzerer Platzhalter, damit er nicht abgeschnitten wird
    const narrow = window.matchMedia ? window.matchMedia('(max-width: 480px)') : null;
    const placeholder = () => {
      el.input.placeholder = narrow && narrow.matches ? 'Nachricht …' : 'Nachricht an Jarvis …';
    };
    placeholder();
    if (narrow && narrow.addEventListener) narrow.addEventListener('change', placeholder);
    el.input.addEventListener('input', () => {
      el.sendBtn.disabled = !el.input.value.trim();
    });
    el.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = el.input.value.trim();
      if (!text) return;
      el.input.value = '';
      el.sendBtn.disabled = true;
      sendText(text);
    });
    el.micBtn.addEventListener('click', async () => {
      try {
        const muted = await call('toggle_mute');
        if (typeof muted === 'boolean') applyConfig({ muted });
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    });
    el.stopBtn.addEventListener('click', () => call('stop').catch(() => {}));
    el.setupBtn.addEventListener('click', openSetup);
    el.micChange.addEventListener('click', openSetup);
    el.coreWrap.addEventListener('click', listenNow);
    el.coreWrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        listenNow();
      }
    });
    el.historyOpen.addEventListener('click', () => openDrawer(true));
    el.historyClose.addEventListener('click', () => openDrawer(false));
    el.drawerShade.addEventListener('click', () => openDrawer(false));
    el.newBtn.addEventListener('click', async () => {
      try {
        await call('new_conversation');
        S.history.forEach((h) => h.el && h.el.remove());
        S.history = [];
        el.historyEmpty.hidden = false;
        renderRecent();
        el.subUser.textContent = '';
        setJarvisText('');
        toast('Neue Unterhaltung. Jarvis fängt von vorne an.', 'ok');
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      }
    });
    el.gamingToggle.addEventListener('change', async () => {
      const wanted = el.gamingToggle.checked;
      try {
        const on = await call('toggle_gaming');
        applyConfig({ gaming: typeof on === 'boolean' ? on : wanted });
      } catch {
        el.gamingToggle.checked = !wanted;
        toast('Der Gaming-Modus ließ sich gerade nicht umschalten.', 'error');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.drawer.classList.contains('open')) openDrawer(false);
    });

    // Kommt das Fenster nach vorn, setzt Windows den Fokus auf den ersten Knopf (mit
    // Fokus-Rahmen). Ohne Klick oder Taste gehört der Cursor ins Eingabefeld:
    // Fenster auf, lostippen.
    let touched = 0;
    const touch = () => { touched = performance.now(); };
    document.addEventListener('pointerdown', touch, true);
    // Hintergrund-Modus: Wer ins Fenster klickt, will es behalten (sonst verschwindet es nach dem Gespräch).
    document.addEventListener('pointerdown', () => { call('touched').catch(() => {}); }, true);
    document.addEventListener('keydown', touch, true);
    window.addEventListener('focus', () => {
      const shownAt = performance.now();
      const toInput = () => {
        if (touched > shownAt - 400) return;
        if (el.drawer.classList.contains('open')) return;
        if (document.activeElement === el.input) return;
        el.input.focus({ preventScroll: true });
      };
      setTimeout(toInput, 0);
      setTimeout(toInput, 150);
    });
  }

  async function openSetup() {
    toast('Die Einstellungen öffnen sich …', 'info');
    try {
      const ok = await call('open_setup');
      if (ok === false) toast('Die Einstellungen ließen sich nicht öffnen.', 'error');
    } catch {
      toast('Im Demo-Modus gibt es keine Einstellungen.', 'info');
    }
  }

  // Läuft gerade etwas in der Werkstatt? (nach dem Verbinden und wenn das Fenster wieder erscheint)
  async function syncWorkshop() {
    if (!Werkstatt) return;
    try {
      const snap = await call('workshop_state');
      if (snap && typeof snap === 'object') Werkstatt.load(snap);
    } catch {
      /* ältere Version ohne Werkstatt */
    }
  }

  // Python ruft das auf, wenn das versteckte Fenster wieder erscheint.
  window.jarvisShown = () => {
    Core.boot();
    renderRecent();
    syncWorkshop();
  };

  // ==================================================================
  //   Die Kugel: Jarvis' Gesicht. Eine lebendige, flüssige Form (orb.js):
  //   innen fließendes Licht, außen farbige Schleier, die mit der Stimme
  //   aufblühen. Hier nur die Verbindung zum Fenster.
  // ==================================================================

  const Core = (() => {
    let orb = null;
    let state = 'idle';
    return {
      start(node) {
        if (!window.JarvisOrb) return;
        // Liegt die Werkstatt darüber, muss die Kugel nicht zeichnen
        orb = window.JarvisOrb.create(node, { mode: 'hero', visible: () => document.body.dataset.view === 'hud' });
        if (orb) orb.state(state);
        document.querySelectorAll('canvas.brand-orb').forEach((mark) => window.JarvisOrb.create(mark, { mode: 'mark' }));
      },
      setState(value) {
        state = value;
        if (orb) orb.state(value);
      },
      level(value) {
        if (orb) orb.level(value);
      },
      boot() {
        if (orb) orb.boot();
      },
      pulse() {
        if (orb) orb.pulse();
      },
      gesture(kind, hold) {
        if (orb && orb.gesture) orb.gesture(kind, hold);
      },
      talk(on) {
        if (orb && orb.talk) orb.talk(on);
      },
    };
  })();

  // ==================================================================
  //   Demo-Modus: gleiche Methoden wie die Python-Api, mit Beispieldaten
  // ==================================================================

  function createDemo(freeze) {
    const queue = [];
    const push = (ev) => queue.push(ev);
    let muted = false;
    let gaming = false;
    let gen = 0;
    // [Frage, Antwort, Arbeitsschritte dazwischen]
    const CONVO = [
      ['Öffne Spotify', 'Spotify läuft, Sir.', [{ label: 'Öffnet Spotify', kind: 'app', ms: 500 }]],
      ['Wie wird das Wetter morgen?', 'Morgen in Wien bis zu 18 Grad und meist sonnig, Sir. Ein Schirm wäre übertrieben.', [
        { label: 'Sucht im Netz: Wetter Wien morgen', kind: 'web', ms: 1300 },
        { label: 'Liest wetter.orf.at', kind: 'web', ms: 900 },
      ]],
      ['Mach den Gaming-Modus an', 'Gaming-Modus aktiv, Sir. Volle Leistung, und ich halte mich im Hintergrund. Viel Erfolg.'],
      ['Wer bist du eigentlich?', 'Jarvis, Sir. Butler, Techniker und gelegentlich die Stimme der Vernunft.'],
    ];
    const shopMode = (params.get('werkstatt') || '').toLowerCase();
    // ?blaupause=bau (Drohne baut sich auf) oder =fertig (liegt schon da), dazu &ansicht=explosion|holo|echt|oben
    const bpMode = (params.get('blaupause') || '').toLowerCase();
    const bpDemo = window.JarvisBlaupause ? window.JarvisBlaupause.demoApi(push) : null;
    // ?weltlage (Lagebericht Welt) oder =deutschland, &ziel=2 (bleibt bei Meldung 2), &flug (Flugverkehr)
    const wlMode = params.has('weltlage') ? (params.get('weltlage') || 'welt').toLowerCase() : '';
    const wlDemo = window.JarvisWeltlage ? window.JarvisWeltlage.demoApi(push) : null;
    let shop = null;
    const startShop = (mode) => {
      if (!window.JarvisWerkstatt) return;
      if (shop) shop.cancel();
      shop = window.JarvisWerkstatt.demo(push, mode);
      shop.start();
    };
    let turn = 0;
    let cpu = 18;
    let ram = 46;

    const state = (v) => push({ type: 'state', value: v });

    async function levels(ms, strength) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        push({ type: 'level', value: clamp(strength * (0.3 + 0.7 * Math.abs(Math.sin(Date.now() / 90))) * Math.random() + 0.05, 0, 1) });
        await sleep(60);
      }
    }

    async function exchange(g, question, answer, spoken, steps) {
      if (spoken) {
        state('listening');
        await levels(1600, 0.7);
        if (g !== gen) return;
      }
      push({ type: 'message', role: 'user', text: question });
      state('thinking');
      if (steps && steps.length) {
        await sleep(350);
        for (const st of steps) {
          const id = 'd' + Math.random().toString(36).slice(2);
          const base = { id, tool: 'PowerShell', label: st.label, detail: st.detail || '', kind: st.kind || 'command' };
          push({ type: 'progress', step: Object.assign({ state: 'running', seconds: 0 }, base) });
          await sleep(st.ms || 900);
          if (g !== gen) return;
          push({ type: 'progress', step: Object.assign({ state: 'done', seconds: (st.ms || 900) / 1000 }, base) });
        }
        await sleep(250);
      } else {
        await sleep(1100);
      }
      if (g !== gen) return;
      state('speaking');
      const id = 'd' + Math.random().toString(36).slice(2);
      const words = answer.split(' ');
      for (let i = 1; i <= words.length; i += 1) {
        if (g !== gen) return;
        push({ type: 'message', role: 'jarvis', id, text: words.slice(0, i).join(' '), final: false });
        push({ type: 'level', value: 0.4 + Math.random() * 0.5 });
        await sleep(170);
      }
      push({ type: 'message', role: 'jarvis', id, text: answer, final: true,
        model: steps && steps.length ? 'Sonnet · normal' : 'Sonnet · schnell' });
      await levels(700, 0.6);
      state(muted ? 'muted' : 'idle');
    }

    async function cycle(g) {
      while (g === gen) {
        await sleep(3800);
        if (g !== gen || muted) return;
        const [q, a, steps] = CONVO[turn % CONVO.length];
        turn += 1;
        await exchange(g, q, a, true, steps);
      }
    }

    function frozen() {
      push({ type: 'message', role: 'user', text: CONVO[0][0] });
      push({ type: 'message', role: 'jarvis', id: 'f1', text: CONVO[0][1], final: true });
      push({ type: 'message', role: 'user', text: CONVO[3][0] });
      push({ type: 'message', role: 'jarvis', id: 'f2', text: CONVO[3][1], final: true });
      if (freeze === 'listening') {
        state('listening');
        setInterval(() => push({ type: 'level', value: 0.3 + Math.random() * 0.5 }), 60);
      } else if (freeze === 'thinking') {
        push({ type: 'message', role: 'user', text: 'Installier mir bitte Spotify' });
        state('thinking');
        push({ type: 'progress', step: { id: 'f1', tool: 'PowerShell', label: 'Sucht nach Programmen', detail: 'winget search Spotify', kind: 'search', state: 'done', seconds: 1.2 } });
        push({ type: 'progress', step: { id: 'f2', tool: 'PowerShell', label: 'Installiert Spotify', detail: 'winget install --id Spotify.Spotify', kind: 'install', state: 'running', seconds: 3.4 } });
      } else if (freeze === 'speaking') {
        push({ type: 'message', role: 'user', text: CONVO[1][0] });
        push({ type: 'message', role: 'jarvis', id: 'f3', text: CONVO[1][1], final: false });
        state('speaking');
        setInterval(() => push({ type: 'level', value: 0.35 + Math.random() * 0.55 }), 60);
      } else if (freeze === 'muted') {
        muted = true;
        push({ type: 'config', muted: true });
        state('muted');
      } else {
        state('idle');
      }
    }

    return {
      hello: () => Promise.resolve({
        hotkey: 'ctrl+alt+m', listen_hotkey: 'ctrl+alt+j', mic: 'Headset (Arctis 7 Chat)', muted: false,
        version: '2.0.0', weather: '14° · leicht bewölkt · Wien', voice: true, gaming: false, name: 'Georg',
      }),
      poll: () => Promise.resolve(queue.splice(0)),
      send_text: (text) => {
        gen += 1;
        const g = gen;
        const t = String(text || '').trim();
        if (wlDemo && /was in der welt|lagebericht|weltlage|was (?:passiert|ist los) in deutschland|handsteuerung/i.test(t)) {
          push({ type: 'message', role: 'user', text: t });
          if (/handsteuerung/i.test(t)) {
            const off = /aus|beend|stopp/i.test(t);
            push({ type: 'weltlage', action: 'hands', on: !off });
            push({ type: 'message', role: 'jarvis', id: 'wl' + g, text: off ? 'Handsteuerung aus, Sir.' : 'Sehr wohl, Sir. Handsteuerung aktiv.', final: true });
          } else {
            wlDemo.demoBriefing(/deutschland/i.test(t) ? 'deutschland' : 'welt');
            push({ type: 'message', role: 'jarvis', id: 'wl' + g, text: 'Lagebericht, Sir.', final: true });
          }
          return Promise.resolve(true);
        }
        if (bpDemo && Blaupause && Blaupause.isOpen()) {
          const said = bpDemo.handles(t);
          if (said) {
            push({ type: 'message', role: 'user', text: t });
            push({ type: 'message', role: 'jarvis', id: 'bp' + g, text: said, final: true });
            return Promise.resolve(true);
          }
        }
        if (/^(bau|programmier|schreib mir ein (skript|programm|tool))|werkstatt/i.test(t)) {
          // Bauaufträge gehen in die Werkstatt, wie bei Jarvis selbst
          exchange(g, t, 'Sehr wohl, Sir. Ich gehe in die Werkstatt. Sie können mir im Fenster zusehen.', false)
            .then(() => startShop('live'));
          return Promise.resolve(true);
        }
        const known = CONVO.find(([q]) => q.toLowerCase() === t.toLowerCase());
        exchange(g, t, known ? known[1] : 'Im Demo-Modus spiele ich nur vor, Sir. Verbunden mit Jarvis erledige ich das sofort.', false,
          known ? known[2] : null)
          .then(() => { if (g === gen && !freeze) cycle(g); });
        return Promise.resolve(true);
      },
      toggle_mute: () => {
        muted = !muted;
        gen += 1;
        push({ type: 'config', muted });
        state(muted ? 'muted' : 'idle');
        if (!muted && !freeze) cycle(gen);
        return Promise.resolve(muted);
      },
      stop: () => {
        gen += 1;
        state(muted ? 'muted' : 'idle');
        if (!freeze) cycle(gen);
        return Promise.resolve(true);
      },
      listen_now: () => {
        if (muted) return Promise.resolve({ ok: false, reason: 'muted' });
        gen += 1;
        const g = gen;
        const [q, a, steps] = CONVO[turn % CONVO.length];
        turn += 1;
        exchange(g, q, a, true, steps).then(() => { if (g === gen && !freeze) cycle(g); });
        return Promise.resolve({ ok: true, reason: '' });
      },
      new_conversation: () => Promise.resolve(true),
      open_setup: () => Promise.resolve(false),
      // wie gui/app.py: nur, was heute noch kommt, und morgen
      reminders: () => {
        const now = new Date();
        const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        return Promise.resolve([
          { uhr: '12:30', text: 'Pizza ist fertig', tag: 'heute', art: 'timer' },
          { uhr: '14:00', text: 'Tee aufgießen', tag: 'heute', art: 'erinnerung' },
          { uhr: '18:30', text: 'Training', tag: 'heute', art: 'erinnerung' },
          { uhr: '21:00', text: 'Zocken mit Max', tag: 'heute', art: 'erinnerung' },
          { uhr: '08:00', text: 'Zahnarzt anrufen', tag: 'morgen' },
        ].filter((r) => r.tag !== 'heute' || r.uhr >= hm));
      },
      toggle_gaming: () => {
        gaming = !gaming;
        push({ type: 'config', gaming });
        return Promise.resolve(gaming);
      },
      touched: () => Promise.resolve(null),
      workshop_state: () => Promise.resolve(null),
      workshop_cancel: () => {
        if (!shop) return Promise.resolve(false);
        shop.cancel();
        return Promise.resolve(true);
      },
      open_folder: () => Promise.reject(new Error('Demo')),
      workshop_projects: () => Promise.resolve(DEMO_PROJECTS),
      workshop_new: () => Promise.resolve(true),
      workshop_continue: () => Promise.resolve(true),
      workshop_run: () => Promise.reject(new Error('Demo')),
      workshop_project: (folder) => Promise.resolve(demoProject(folder)),
      workshop_delete: (folder) => {
        const at = DEMO_PROJECTS.findIndex((p) => p.folder === folder);
        if (at >= 0) DEMO_PROJECTS.splice(at, 1);
        return Promise.resolve({ ok: at >= 0, trash: true, error: at >= 0 ? '' : 'Das Projekt gibt es nicht mehr.' });
      },
      workshop_tell: () => Promise.resolve(true),
      workshop_preview: () => Promise.reject(new Error('Demo')),
      memory_state: () => Promise.resolve(DEMO_MEMORY),
      phone_info: () => Promise.resolve(DEMO_PHONE),
      connections: () => Promise.resolve({ phone: !!DEMO_PHONE.enabled, alexa: !!DEMO_ALEXA.enabled }),
      push_info: () => Promise.resolve(DEMO_PUSH),
      push_enable: (on) => Promise.resolve(Object.assign(DEMO_PUSH, { enabled: !!on })),
      push_test: () => Promise.resolve({ ok: true, error: '' }),
      phone_enable: (on) => Promise.resolve(Object.assign(DEMO_PHONE, { enabled: !!on, running: !!on })),
      phone_new_key: () => Promise.resolve(DEMO_PHONE),
      alexa_info: () => Promise.resolve(DEMO_ALEXA),
      tailscale_info: () => Promise.resolve({ installed: true, running: true, name: 'georgs-pc.tail1234.ts.net', error: '', url: DEMO_TS.url }),
      tailscale_enable: (on) => { DEMO_TS.url = on ? 'https://georgs-pc.tail1234.ts.net/' : ''; return Promise.resolve({ ok: true, url: DEMO_TS.url, error: '' }); },
      tailscale_help: () => Promise.resolve(true),
      connectors: (fresh) => new Promise((done) => setTimeout(() => done({ an: true, liste: DEMO_KONN, fehler: '' }), fresh ? 1200 : 80)),
      connectors_help: () => Promise.resolve(true),
      labor_info: () => (/[?&]labor\b/.test(location.search) ? Promise.resolve(DEMO_LABOR) : Promise.reject(new Error('kein Labor'))),
      labor_open: () => Promise.resolve({ ok: false, error: 'Im Demo-Modus öffnet sich kein Ordner.' }),
      werkzeug_loeschen: () => Promise.resolve(true),
      alexa_enable: (on) => Promise.resolve(Object.assign(DEMO_ALEXA, { enabled: !!on, connected: !!on })),
      alexa_copy: () => Promise.resolve({ ok: true, text: '{}' }),
      alexa_console: () => Promise.resolve(true),
      alexa_test: () => Promise.resolve({ ok: true, answer: 'Es ist 22 Uhr 40, Sir.' }),
      remember: () => Promise.resolve(true),
      forget: () => Promise.resolve(true),
      command_forget: () => Promise.resolve(true),
      skill_forget: () => Promise.resolve(true),
      schedule_forget: () => Promise.resolve(true),
      notebook_open: () => Promise.resolve({ ok: true, folder: 'C:\\Users\\Georg\\Jarvis-Notizbuch' }),
      answer_suggestion: () => Promise.resolve(true),
      ...(bpDemo ? bpDemo.api : {}),
      ...(wlDemo || {}),
      start() {
        setInterval(() => {
          cpu = clamp(cpu + (Math.random() - 0.5) * 9, 4, 96);
          ram = clamp(ram + (Math.random() - 0.5) * 2, 30, 80);
          push({ type: 'stats', cpu, ram, gpu: { load: Math.round(40 + 30 * Math.abs(Math.sin(Date.now() / 9000))), temp: 64, mem: 52 } });
        }, 2000);
        push({ type: 'stats', cpu, ram });
        if (bpDemo && bpMode) {
          const look = (params.get('ansicht') || '').toLowerCase();
          setTimeout(() => {
            if (bpMode === 'fertig') push(Object.assign({ type: 'blueprint', action: 'open' }, bpDemo.load()));
            else {
              push({ type: 'blueprint', action: 'open', scene: { name: '', teile: [] }, selected: '', busy: false });
              setTimeout(() => bpDemo.build('Bau mir eine Aufklärungsdrohne'), 600);
            }
            if (look) {
              setTimeout(() => {
                if (look === 'explosion') push({ type: 'blueprint', action: 'view', what: 'explode', on: true });
                else if (look === 'oben' || look === 'vorne' || look === 'seite') push({ type: 'blueprint', action: 'view', what: 'camera', side: look });
                else push({ type: 'blueprint', action: 'view', what: 'look', mode: look });
              }, bpMode === 'fertig' ? 900 : 5200);
            }
          }, 700);
        }
        if (wlDemo && wlMode) {
          // &holo: gleich als Hologramm
          if (params.has('holo')) push({ type: 'weltlage', action: 'look', mode: 'holo' });
          setTimeout(() => {
            const ziel = params.get('ziel');
            if (params.has('flug')) {
              push({ type: 'weltlage', action: 'open', items: [], index: -1 });
              setTimeout(() => {
                push({ type: 'weltlage', action: 'layer', name: 'flights', on: true });
                push({ type: 'weltlage', action: 'fly', ort: { name: 'Frankfurt', lat: 50.11, lon: 8.68, km: 220 } });
              }, 1500);
            } else if (ziel !== null) {
              const items = window.JarvisWeltlage.demoItems();
              push({ type: 'weltlage', action: 'news', items, kind: 'welt', title: 'Lage · Welt' });
              setTimeout(() => {
                const i = Number(ziel) || 0;
                push({ type: 'weltlage', action: 'focus', index: i });
                if (items[i]) push({ type: 'message', role: 'jarvis', text: items[i].sprechen });
              }, 1500);
            } else {
              wlDemo.demoBriefing(wlMode);
            }
          }, 700);
        }
        if (shopMode) {
          // ?werkstatt=live|running|done|error: ein Auftrag zum Zuschauen
          setTimeout(() => startShop(shopMode), ['running', 'done', 'error'].includes(shopMode) ? 0 : 900);
        }
        if (freeze) {
          frozen();
        } else if (shopMode) {
          push({ type: 'message', role: 'user', text: 'Bau mir einen Discord-Bot, der jeden Morgen Hallo sagt' });
          push({ type: 'message', role: 'jarvis', id: 'w0', text: 'Sehr wohl, Sir. Ich gehe in die Werkstatt. Sie können mir im Fenster zusehen.', final: true });
          state('idle');
        } else {
          push({ type: 'message', role: 'jarvis', id: 'begruessung', text: 'Guten Tag, Sir. Draußen 14 Grad und leicht bewölkt. Heute stehen noch zwei Erinnerungen an.', final: true });
          gen += 1;
          cycle(gen);
        }
      },
    };
  }

  // Logos, wie sie die Werkstatt zeichnet (logo.svg im Projektordner)
  const DEMO_ROCKET = 'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'
    + '<path d="M128 26c34 26 50 68 46 120l-18 22h-56l-18-22c-4-52 12-94 46-120z" fill="#E8EEF8"/>'
    + '<circle cx="128" cy="100" r="18" fill="#3B82F6"/>'
    + '<path d="M82 144l-32 42 42-8zM174 144l32 42-42-8z" fill="#EF4444"/>'
    + '<path d="M108 172h40l-20 54z" fill="#F59E0B"/></svg>');
  const DEMO_PROJECTS = [
    { name: 'Discord Bot Wetter', folder: 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-10-01_1530_discord-bot-wetter', state: 'done',
      task: 'Bau mir einen Discord-Bot, der jeden Morgen das Wetter postet', model: 'sonnet', start: true,
      summary: 'Der Bot ist fertig, Sir. Tragen Sie den Token in .env ein und starten Sie ihn mit start.bat.',
      updated: new Date(Date.now() - 2 * 3600e3).toISOString(), history: [{}, {}],
      logo: (window.JarvisWerkstatt && window.JarvisWerkstatt.DEMO_LOGO) || '' },
    { name: 'Weltraum Shooter', folder: 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-09-30_2010_weltraum-shooter', state: 'done',
      task: 'Programmier mir ein Weltraum-Spiel mit Highscore, Levels und Sound', model: 'opus', start: true,
      summary: 'Das Spiel läuft, Sir: drei Level, Highscore-Liste und Soundeffekte. Steuerung mit Pfeiltasten und Leertaste.',
      updated: new Date(Date.now() - 26 * 3600e3).toISOString(), history: [{}, {}, {}], logo: DEMO_ROCKET },
    { name: 'Downloads Sortieren', folder: 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-09-28_1112_downloads-sortieren', state: 'error',
      task: 'Schreib ein Skript, das meine Downloads nach Typ sortiert', model: 'sonnet', start: false,
      summary: 'Das Claude-Kontingent war erschöpft. Sagen Sie einfach: Arbeite an Downloads Sortieren weiter.',
      updated: new Date(Date.now() - 4 * 86400e3).toISOString(), history: [{}] },
  ];
  // So sieht ein Projekt zum Ansehen aus (workshop_project in gui/app.py)
  function demoProject(folder) {
    const p = DEMO_PROJECTS.find((x) => x.folder === folder);
    if (!p) return null;
    const ok = p.state === 'done';
    const plan = ok
      ? ['Projektordner und Umgebung anlegen', 'Code schreiben', 'Testen und Fehler beheben', 'LIESMICH.txt mit Startanleitung']
      : ['Projektordner anlegen', 'Skript schreiben', 'Testen'];
    const todos = plan.map((text, i) => ({ text, state: ok || i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' }));
    const files = ok
      ? [['main.py', 6400], ['start.bat', 120], ['LIESMICH.txt', 900], ['logo.svg', 1300], ['requirements.txt', 40]]
      : [['sortieren.py', 2100]];
    const steps = [
      { id: 'p1', tool: 'TodoWrite', label: 'Plan erstellt', kind: 'plan', state: 'done', seconds: 1 },
      { id: 'c1', tool: 'Bash', label: 'Legt die Umgebung an', detail: 'python -m venv .venv', kind: 'command', state: 'done', seconds: 9 },
      ...files.map(([name], i) => ({ id: 'f' + i, tool: 'Write', label: 'Schreibt ' + name, detail: folder + '\\' + name,
        kind: 'file', state: 'done', seconds: 1 })),
      { id: 'c2', tool: 'Bash', label: 'Testet', detail: 'python -m pytest -q', kind: 'command', state: ok ? 'done' : 'error', seconds: 4 },
    ];
    const history = [
      { zeit: p.updated, wunsch: p.task, zustand: p.state },
      ...(p.history || []).slice(1).map((_, i) => ({
        zeit: new Date(Date.parse(p.updated) - (i + 1) * 3600e3).toISOString(),
        wunsch: ['Füg noch einen !würfel-Befehl hinzu', 'Mach das Design dunkler'][i % 2], zustand: 'done',
      })),
    ].reverse();
    return Object.assign({}, p, {
      live: false, todos, steps, history, preview: false, seconds: ok ? 412 : 95, begun: '01.10. 15:30',
      files: files.map(([name, size]) => ({ path: folder + '\\' + name, size })),
    });
  }

  const DEMO_PHONE = {
    enabled: true, running: true, ip: '192.168.1.20', port: 8765, mac: '3C:7C:3F:12:AB:9E',
    url: 'http://192.168.1.20:8765/app/#t=demo-schluessel-123456',
    qr: '<svg viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0z" fill="#000"/><path d="M1 1h5v5H1zM15 1h5v5h-5zM1 15h5v5H1z" fill="#fff"/><path d="M2 2h3v3H2zM16 2h3v3h-3zM2 16h3v3H2zM9 1h1v2H9zM11 3h2v1h-2zM8 8h5v1H8zM9 10h1v3H9zM12 11h2v2h-2zM15 9h2v1h-2zM17 12h3v1h-3zM14 15h2v2h-2zM18 16h2v4h-2zM9 15h3v1H9zM10 18h1v3h-1z" fill="#000"/></svg>',
  };
  const DEMO_ALEXA = { enabled: true, connected: true };
  const DEMO_PUSH = { enabled: true, topic: 'jarvis-3f9c2a71b0d84e6c5a1f7d22', url: 'https://ntfy.sh/jarvis-3f9c2a71b0d84e6c5a1f7d22' };
  const DEMO_TS = { url: '' };

  // wie connectors() in gui/app.py: die Konnektoren, die Claude über Georgs Konto meldet
  const DEMO_KONN = [
    { name: 'Gmail', ok: true }, { name: 'Google Calendar', ok: true }, { name: 'Shopify', ok: true },
    { name: 'Spotify', ok: true }, { name: 'Canva', ok: true },
  ];

  const DEMO_LABOR = {
    werkzeuge: [
      { name: 'wetterradar', titel: 'Wetterradar', beschreibung: 'Regenradar für einen Ort als kurzer Satz, ohne Browser.',
        aufruf: 'werkzeug wetterradar Wien', freigegeben: true, geaendert: false, test_ok: true, test_ergebnis: '4 Tests, alle grün',
        laeufe: 14, zuletzt_benutzt: new Date(Date.now() - 3 * 3600e3).toISOString() },
      { name: 'downloads-sortieren', titel: 'Downloads sortieren', beschreibung: 'Sortiert den Download-Ordner nach Dateityp in Unterordner.',
        aufruf: 'werkzeug downloads-sortieren C:\\Users\\Georg\\Downloads', freigegeben: true, geaendert: false, test_ok: true,
        test_ergebnis: '6 Tests, alle grün', laeufe: 3, zuletzt_benutzt: new Date(Date.now() - 26 * 3600e3).toISOString() },
      { name: 'bild-verkleinern', titel: 'Bild verkleinern', beschreibung: 'Verkleinert Bilder für Discord auf höchstens 8 MB.',
        aufruf: 'werkzeug bild-verkleinern <datei>', freigegeben: false, geaendert: false, test_ok: false,
        test_ergebnis: '1 von 3 Tests fehlgeschlagen', laeufe: 1, zuletzt_benutzt: new Date(Date.now() - 1 * 3600e3).toISOString() },
    ],
    letzte_laeufe: [
      { wann: new Date(Date.now() - 50 * 60e3).toISOString(), was: 'Tests: bild-verkleinern', ok: false, dauer: 1.2, abgebrochen: false },
      { wann: new Date(Date.now() - 55 * 60e3).toISOString(), was: 'pip: pillow', ok: true, dauer: 6.4, abgebrochen: false },
      { wann: new Date(Date.now() - 3 * 3600e3).toISOString(), was: 'werkzeug wetterradar Wien', ok: true, dauer: 0.8, abgebrochen: false },
      { wann: new Date(Date.now() - 9 * 3600e3).toISOString(), was: 'Versuch: import time; time.sleep(120)', ok: false, dauer: 60, abgebrochen: true },
    ],
    ordner: 'C:\\Users\\Georg\\AppData\\Local\\Programs\\Jarvis\\daten\\labor',
  };

  const DEMO_MEMORY = {
    facts: [
      { text: 'Georg spielt gern Valorant und Minecraft', source: 'gelernt' },
      { text: 'Georg sagt: Ich höre beim Zocken gern Rock', source: 'georg' },
      { text: 'Max ist Georgs bester Freund, sie schreiben über Discord', source: 'gelernt' },
      { text: 'Georg baut einen Discord-Bot für seinen Clan', source: 'jarvis' },
    ],
    contacts: [{ name: 'Max', app: 'discord', count: 14 }, { name: 'Anna', app: 'whatsapp', count: 6 }],
    notebook: true,
    schedules: [
      { id: 'a1', days: 'täglich', time: '08:00', command: 'Briefing' },
      { id: 'b2', days: 'Freitags', time: '20:00', command: 'Zockmodus' },
    ],
    skills: [
      { name: 'morgen-briefing', description: 'Morgen-Briefing, wenn Sie „Guten Morgen“ oder „Briefing“ sagen.', learned: false },
      { name: 'recherche', description: 'Gründliche Recherche oder Vergleich, mit Bericht im Notizbuch.', learned: false },
      { name: 'obs-aufnahme', description: 'Ein Video mit OBS aufnehmen und für YouTube exportieren.', learned: true },
    ],
    commands: [
      { key: 'zockmodus', name: 'Zockmodus', action: 'öffne Discord und Steam und mach den Gaming-Modus an', count: 12 },
      { key: 'feierabend', name: 'Feierabend', action: 'schließ Discord und Steam und spiel Lofi auf Spotify', count: 3 },
    ],
    routines: [
      { key: 'a', label: 'Discord und Spotify', uhrzeit: '18:05', tage: 'werktags', anzahl: 7 },
      { key: 'b', label: 'YouTube', uhrzeit: '21:30', tage: 'täglich', anzahl: 9 },
    ],
    birthdays: (() => {
      const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      return [
        { shown: 'Max', date: day(3), days: 3, own: false },
        { shown: 'Ihre Mutter', date: day(41), days: 41, own: false },
      ];
    })(),
  };

  // ------------------------------------------------------------------ Start

  function boot() {
    if (window.JarvisWerkstatt) {
      Werkstatt = window.JarvisWerkstatt.create({
        call, toast, onHub: () => Projekte && Projekte.open(), onDeleted: () => Projekte && Projekte.refresh(),
      });
      if (Werkstatt) Werkstatt.renderPill();
    }
    if (window.JarvisProjekte) Projekte = window.JarvisProjekte.create({ call, toast, werkstatt: Werkstatt });
    if (window.JarvisBlaupause) {
      Blaupause = window.JarvisBlaupause.create({
        call, toast,
        onOpen: () => {
          if (Werkstatt && Werkstatt.isOpen()) Werkstatt.close();
          if (Projekte && Projekte.isOpen()) Projekte.close();
          if (Weltlage && Weltlage.isOpen()) Weltlage.close();
          // Läuft die Handsteuerung, dreht sie ab jetzt das Modell
          if (window.JarvisHands && window.JarvisHands.isOn()) setTimeout(() => window.JarvisHands.retarget(Blaupause), 0);
        },
      });
    }
    if (window.JarvisWeltlage) {
      Weltlage = window.JarvisWeltlage.create({
        call, toast,
        onOpen: () => {
          if (Werkstatt && Werkstatt.isOpen()) Werkstatt.close();
          if (Projekte && Projekte.isOpen()) Projekte.close();
          if (Blaupause && Blaupause.isOpen()) Blaupause.close();
          if (window.JarvisHands && window.JarvisHands.isOn()) setTimeout(() => window.JarvisHands.retarget(Weltlage), 0);
        },
        onClose: () => {
          if (window.JarvisHands && window.JarvisHands.target() === Weltlage) window.JarvisHands.stop();
        },
        onHands: (on) => setHands(on),
      });
    }
    if (window.JarvisKoppeln) Koppeln = window.JarvisKoppeln.create({ call, toast });
    if (window.JarvisGedaechtnis) Gedaechtnis = window.JarvisGedaechtnis.create({ call, toast });
    refreshDeck();
    setInterval(refreshDeck, 60000);
    if (Gedaechtnis && /[?&]vorschlag\b/.test(location.search)) {
      Gedaechtnis.offer({ frage: 'Sir, um diese Zeit öffnen Sie meist Discord und Spotify. Soll ich?' });
    }
    bindUi();
    tickClock();
    Core.start(el.core);
    renderState(true);
    renderRecent();
    setLink('wait');
    requestAnimationFrame(() => {
      el.body.dataset.boot = '2';
    });

    const connectReal = () => {
      if (api || !realReady()) return false;
      connect(REAL, 'live');
      return true;
    };
    window.addEventListener('pywebviewready', () => {
      if (!connectReal()) setTimeout(connectReal, 50);
    });
    if (connectReal()) return;
    const t0 = performance.now();
    const watcher = setInterval(() => {
      if (connectReal()) {
        clearInterval(watcher);
        return;
      }
      if (performance.now() - t0 > 1500 && typeof window.pywebview === 'undefined' && params.get('demo') !== '0') {
        clearInterval(watcher);
        const demo = createDemo((params.get('state') || '').toLowerCase());
        demo.start();
        connect(demo, 'demo');
      }
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
