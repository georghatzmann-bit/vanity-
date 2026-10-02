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
  let Koppeln = null; // Handy, Alexa, Discord (koppeln.js)

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
    discord_info: () => window.pywebview.api.discord_info(),
    discord_save: (token) => window.pywebview.api.discord_save(token),
    discord_invite: () => window.pywebview.api.discord_invite(),
    tailscale_info: () => window.pywebview.api.tailscale_info(),
    tailscale_enable: (on) => window.pywebview.api.tailscale_enable(on),
    tailscale_help: (which) => window.pywebview.api.tailscale_help(which),
    calendar_info: () => window.pywebview.api.calendar_info(),
    calendar_add: (url) => window.pywebview.api.calendar_add(url),
    calendar_remove: (url) => window.pywebview.api.calendar_remove(url),
    calendar_help: (which) => window.pywebview.api.calendar_help(which),
    shop_info: () => window.pywebview.api.shop_info(),
    shop_connect: (domain, client, secret) => window.pywebview.api.shop_connect(domain, client, secret),
    shop_disconnect: () => window.pywebview.api.shop_disconnect(),
    shop_help: (which) => window.pywebview.api.shop_help(which),
    apple_info: () => window.pywebview.api.apple_info(),
    apple_connect: (email, password) => window.pywebview.api.apple_connect(email, password),
    apple_choose_calendar: (id) => window.pywebview.api.apple_choose_calendar(id),
    apple_refresh: () => window.pywebview.api.apple_refresh(),
    apple_disconnect: () => window.pywebview.api.apple_disconnect(),
    apple_help: () => window.pywebview.api.apple_help(),
    mail_accounts: () => window.pywebview.api.mail_accounts(),
    mail_add: (provider, email, password, server) => window.pywebview.api.mail_add(provider, email, password, server || ''),
    mail_remove: (id) => window.pywebview.api.mail_remove(id),
    mail_help: (provider) => window.pywebview.api.mail_help(provider),
    discord_portal: () => window.pywebview.api.discord_portal(),
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
    if (state === 'idle' && S.voice === false) return 'Kein Mikrofon gefunden. Du kannst Jarvis unten schreiben.';
    return {
      idle: 'Sag „Hey Jarvis“, klick auf die Kugel oder schreib unten',
      listening: 'Ich höre …',
      thinking: 'Einen Moment …',
      speaking: 'Sag „Stopp“, um mich zu unterbrechen',
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

  function addMessage(role, text, id, final) {
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
    } else {
      item = { key, role, text, time: timeNow(), el: null };
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
      time.textContent = (item.role === 'user' ? 'Du · ' : 'Jarvis · ') + item.time;
      li.append(time);
    }
    return li;
  }

  function renderRecent() {
    if (!el.recent) return; // die Spalte "Zuletzt" gibt es nicht mehr; der Verlauf steht in der Schublade
    const items = S.history.filter((h) => h.role !== 'info' && h.text).slice(-5);
    el.recent.replaceChildren(...items.map((h) => {
      const li = document.createElement('li');
      li.className = h.role;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = h.role === 'user' ? 'Du' : 'Jarvis';
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
      return;
    }
    Activity.update(step);
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

  // Shop-Karte rechts: nur wenn ein Shop verbunden ist (heute, diese Woche, was auf den Versand wartet)
  async function refreshShopCard() {
    const card = document.getElementById('shopCard');
    if (!card) return;
    let info = null;
    try {
      info = await call('shop_info');
    } catch {
      info = null;
    }
    const on = !!(info && info.verbunden && !info.fehler);
    card.hidden = !on;
    if (!on) return;
    const count = (n) => n + (n === 1 ? ' Bestellung' : ' Bestellungen');
    const short = (text) => String(text || '').replace(/ Euro$/, ' €');
    document.getElementById('shopName').textContent = info.name || '';
    document.getElementById('shopToday').textContent = short(info.heute.umsatz);
    document.getElementById('shopTodayN').textContent = count(info.heute.anzahl);
    document.getElementById('shopWeek').textContent = short(info.woche.umsatz);
    document.getElementById('shopWeekN').textContent = count(info.woche.anzahl);
    const open = document.getElementById('shopOpen');
    open.hidden = !info.offen;
    open.textContent = info.offen === 1 ? 'Eine Bestellung wartet auf den Versand.' : info.offen + ' Bestellungen warten auf den Versand.';
  }

  // Post: die letzten Mails (ohne Newsletter), nur wenn ein Postfach verbunden ist. Klick: Jarvis liest vor.
  function mailWhen(iso) {
    const text = String(iso || '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return '';
    const now = new Date();
    const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0');
    return text.slice(0, 10) === today ? text.slice(11, 16) : Number(text.slice(8, 10)) + '.' + Number(text.slice(5, 7)) + '.';
  }

  async function refreshMailCard() {
    const card = document.getElementById('mailCard');
    if (!card) return;
    let accounts = [];
    let info = null;
    try {
      accounts = (await call('mail_accounts')) || [];
      if (accounts.length) info = await call('apple_info');
    } catch {
      accounts = [];
    }
    const mail = info && info.mail;
    card.hidden = !(accounts.length && mail);
    if (card.hidden) return;
    const unread = Number(mail.ungelesen) || 0;
    document.getElementById('mailCount').textContent = unread ? (unread > 99 ? '99+' : unread) + ' ungelesen' : '';
    const items = (mail.letzte || []).filter((m) => !m.newsletter).slice(0, 3);
    document.getElementById('mailRail').replaceChildren(...items.map((m) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mail-item' + (m.ungelesen ? ' unread' : '');
      const sender = String(m.von || m.adresse || 'Unbekannt');
      btn.title = 'Von Jarvis vorlesen lassen';
      btn.setAttribute('aria-label', (m.ungelesen ? 'Ungelesen: ' : '') + sender + ', ' + String(m.betreff || '') + '. Vorlesen lassen');
      const time = document.createElement('time');
      time.textContent = mailWhen(m.datum);
      const what = document.createElement('span');
      what.className = 'what';
      const b = document.createElement('b');
      b.textContent = sender;
      const small = document.createElement('small');
      small.textContent = String(m.betreff || '(ohne Betreff)');
      what.append(b, small);
      btn.append(time, what);
      btn.addEventListener('click', () => sendText('Lies mir die letzte Mail von ' + sender + ' vor'));
      li.append(btn);
      return li;
    }));
    const empty = document.getElementById('mailEmpty');
    empty.hidden = items.length > 0;
    empty.textContent = mail.fehler ? String(mail.fehler)
      : 'Nichts Wichtiges. Fragen Sie jederzeit „Hab ich neue Mails?“.';
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
      case 'message': addMessage(ev.role, ev.text, ev.id, ev.final); break;
      case 'progress': onProgress(ev.step); break;
      case 'workshop':
        if (ev.state === 'projects') {
          if (Projekte) Projekte.open();
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
    if (Gedaechtnis) Gedaechtnis.refresh();
    if (Koppeln && Koppeln.dots) Koppeln.dots();
    refreshDeck();
    refreshToday();
    refreshShopCard();
    refreshMailCard();
    setInterval(refreshToday, 60000);
    setInterval(refreshShopCard, 300000);
    setInterval(refreshMailCard, 300000);
    document.addEventListener('jarvis-mail', refreshMailCard);
    document.addEventListener('jarvis-shop', refreshShopCard);
    pollLoop(gen);
  }

  // ------------------------------------------------------------------ Bedienung

  async function listenNow() {
    Core.pulse();
    try {
      const r = await call('listen_now');
      if (r && r.ok === false) {
        if (r.reason === 'muted') toast('Das Mikrofon ist aus. Schalte es unten links wieder ein.', 'info');
        else toast('Kein Mikrofon bereit. Schreib Jarvis einfach unten.', 'info');
      }
    } catch {
      toast('Jarvis ist gerade nicht verbunden.', 'error');
    }
  }

  function bindUi() {
    // Schmales Fenster: kürzerer Platzhalter, damit er nicht abgeschnitten wird
    const narrow = window.matchMedia ? window.matchMedia('(max-width: 480px)') : null;
    const placeholder = () => {
      el.input.placeholder = narrow && narrow.matches ? 'Nachricht …' : 'Schreib Jarvis etwas …';
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
  //   Die Kugel: Jarvis' Gesicht. Eine weiche, leuchtende Kugel, in der
  //   langsam Licht fließt. Hört sie zu oder spricht sie, wird sie heller
  //   und atmet mit der Stimme. Keine Ringe, keine Skalen.
  // ==================================================================

  const Core = (() => {
    // Farben je Zustand: hell (Glanz), Mitte, Rand; dazu wie lebhaft das Licht fließt
    const LOOK = {
      idle:      { a: [176, 190, 255], b: [110, 140, 255], c: [40, 52, 150], energy: 0.3, speed: 0.35, halo: 0.16 },
      listening: { a: [190, 232, 255], b: [104, 176, 255], c: [36, 78, 178], energy: 0.75, speed: 0.75, halo: 0.3 },
      thinking:  { a: [206, 198, 255], b: [138, 128, 255], c: [56, 46, 160], energy: 0.6, speed: 1.25, halo: 0.22 },
      speaking:  { a: [186, 200, 255], b: [112, 142, 255], c: [40, 54, 172], energy: 0.95, speed: 0.85, halo: 0.32 },
      muted:     { a: [150, 154, 166], b: [92, 97, 110], c: [36, 39, 47], energy: 0.06, speed: 0.12, halo: 0.04 },
      error:     { a: [255, 190, 186], b: [242, 100, 95], c: [120, 32, 36], energy: 0.45, speed: 0.6, halo: 0.24 },
    };
    const look = JSON.parse(JSON.stringify(LOOK.idle));
    let target = LOOK.idle;
    let canvas = null;
    let ctx = null;
    let size = 0;
    let dpr = 1;
    let t = 0;
    let flow = 0;
    let last = 0;
    let level = 0;
    let levelTarget = 0;
    let levelAt = 0;
    let bootT = 0;
    let pulseT = -10;
    // Drei Lichtflecken, die in der Kugel kreisen (Lissajous-Bahnen)
    const BLOBS = [
      { fx: 0.71, fy: 0.53, px: 0.0, py: 1.7, r: 0.62, mix: 0.0 },
      { fx: 0.43, fy: 0.89, px: 2.1, py: 0.4, r: 0.55, mix: 0.6 },
      { fx: 0.97, fy: 0.61, px: 4.2, py: 3.3, r: 0.48, mix: 1.0 },
    ];

    const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
    const mix = (x, y, k) => [lerp(x[0], y[0], k), lerp(x[1], y[1], k), lerp(x[2], y[2], k)];

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const s = Math.max(120, Math.round(Math.min(rect.width, rect.height) * dpr));
      if (s !== size) {
        size = s;
        canvas.width = s;
        canvas.height = s;
      }
    }

    function setState(state) {
      target = LOOK[state] || LOOK.idle;
    }

    function levelIn(v) {
      levelTarget = v;
      levelAt = performance.now();
    }

    function boot() {
      bootT = 0;
    }

    function pulse() {
      pulseT = t;
    }

    function frame(now) {
      if (document.body.dataset.view !== 'hud' || document.hidden) {
        // Werkstatt liegt darüber oder das Fenster ist versteckt: nicht zeichnen, nur ab und zu nachsehen
        last = now;
        setTimeout(() => requestAnimationFrame(frame), 250);
        return;
      }
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      t += dt;
      bootT = Math.min(1, bootT + dt / 1.2);
      const k = Math.min(1, dt * 3.5);
      for (const key of ['a', 'b', 'c']) look[key] = mix(look[key], target[key], k);
      for (const key of ['energy', 'speed', 'halo']) look[key] = lerp(look[key], target[key], k);
      // Pegel: schnell rauf, langsam runter; nach 300 ms ohne Meldung abklingen
      const stale = performance.now() - levelAt > 300;
      const want = stale ? 0 : levelTarget;
      level += (want - level) * Math.min(1, dt * (want > level ? 16 : 4));
      flow += dt * look.speed * (reducedMotion() ? 0.2 : 1) * (1 + level * 0.8);
      draw();
      const calm = target === LOOK.idle || target === LOOK.muted;
      if (calm && !reducedMotion()) {
        setTimeout(() => requestAnimationFrame(frame), 33); // ruhig: 30 Bilder pro Sekunde reichen
      } else {
        requestAnimationFrame(frame);
      }
    }

    function draw() {
      if (!ctx) return;
      const ease = 1 - Math.pow(1 - bootT, 3);
      const lv = level;
      const breath = Math.sin(t * 1.15) * 0.012;
      const click = t - pulseT < 0.45 ? Math.sin(((t - pulseT) / 0.45) * Math.PI) * 0.05 : 0;
      const R = size * 0.34 * (0.92 + 0.08 * ease) * (1 + breath + click + lv * 0.06 * look.energy);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.translate(size / 2, size / 2);
      ctx.globalAlpha = ease;

      // Weiches Licht um die Kugel (wird mit der Stimme stärker)
      const haloA = look.halo * (0.7 + lv * 0.9);
      const halo = ctx.createRadialGradient(0, 0, R * 0.8, 0, 0, R * 1.45);
      halo.addColorStop(0, rgba(look.b, haloA));
      halo.addColorStop(1, rgba(look.b, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.45, 0, Math.PI * 2);
      ctx.fill();

      // Die Kugel selbst
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.clip();
      const base = ctx.createRadialGradient(-R * 0.3, -R * 0.36, R * 0.05, 0, 0, R * 1.02);
      base.addColorStop(0, rgba(look.a, 1));
      base.addColorStop(0.42, rgba(look.b, 1));
      base.addColorStop(1, rgba(look.c, 1));
      ctx.fillStyle = base;
      ctx.fillRect(-R, -R, R * 2, R * 2);

      // Fließendes Licht
      ctx.globalCompositeOperation = 'screen';
      const reach = 0.28 + look.energy * 0.22 + lv * 0.18;
      for (const blob of BLOBS) {
        const x = Math.cos(flow * blob.fx + blob.px) * R * reach;
        const y = Math.sin(flow * blob.fy + blob.py) * R * reach;
        const r = R * blob.r * (1 + lv * 0.25);
        const color = mix(look.a, look.b, blob.mix);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, rgba(color, 0.42 + look.energy * 0.18));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(-R, -R, R * 2, R * 2);
      }
      // Beim Nachdenken wandert ein sanfter Schimmer im Kreis
      if (ctx.createConicGradient && look.speed > 1) {
        const sheen = ctx.createConicGradient(flow * 1.4, 0, 0);
        const a = clamp((look.speed - 1) * 0.5, 0, 0.16);
        sheen.addColorStop(0, 'rgba(255,255,255,0)');
        sheen.addColorStop(0.12, `rgba(255,255,255,${a.toFixed(3)})`);
        sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
        sheen.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sheen;
        ctx.fillRect(-R, -R, R * 2, R * 2);
      }
      ctx.globalCompositeOperation = 'source-over';

      // Schatten unten, Glanz oben: so wirkt sie rund
      const shade = ctx.createRadialGradient(R * 0.1, R * 0.55, R * 0.1, 0, R * 0.2, R * 1.1);
      shade.addColorStop(0, 'rgba(4,6,14,0)');
      shade.addColorStop(1, 'rgba(4,6,14,0.38)');
      ctx.fillStyle = shade;
      ctx.fillRect(-R, -R, R * 2, R * 2);
      const gloss = ctx.createRadialGradient(-R * 0.34, -R * 0.42, 0, -R * 0.34, -R * 0.42, R * 0.62);
      gloss.addColorStop(0, 'rgba(255,255,255,0.34)');
      gloss.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gloss;
      ctx.fillRect(-R, -R, R * 2, R * 2);
      ctx.restore();

      // Feine Kante
      ctx.beginPath();
      ctx.arc(0, 0, R - 0.5 * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function start(node) {
      canvas = node;
      ctx = canvas.getContext('2d');
      resize();
      if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
      else window.addEventListener('resize', resize);
      requestAnimationFrame(frame);
    }

    return { start, setState, level: levelIn, boot, pulse };
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
      push({ type: 'message', role: 'jarvis', id, text: answer, final: true });
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
      reminders: () => Promise.resolve([
        { uhr: '12:00', text: 'Mittagessen mit Max · Pizzeria', tag: 'heute', art: 'termin' },
        { uhr: '14:00', text: 'Tee aufgießen', tag: 'heute', art: 'erinnerung' },
        { uhr: '18:30', text: 'Training', tag: 'heute', art: 'termin' },
        { uhr: '08:00', text: 'Zahnarzt anrufen', tag: 'morgen' },
      ]),
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
      memory_state: () => Promise.resolve(DEMO_MEMORY),
      phone_info: () => Promise.resolve(DEMO_PHONE),
      connections: () => Promise.resolve({ phone: !!DEMO_PHONE.enabled, iphone: !!DEMO_APPLE.verbunden, alexa: !!DEMO_ALEXA.enabled, discord: true, mail: true }),
      push_info: () => Promise.resolve(DEMO_PUSH),
      push_enable: (on) => Promise.resolve(Object.assign(DEMO_PUSH, { enabled: !!on })),
      push_test: () => Promise.resolve({ ok: true, error: '' }),
      phone_enable: (on) => Promise.resolve(Object.assign(DEMO_PHONE, { enabled: !!on, running: !!on })),
      phone_new_key: () => Promise.resolve(DEMO_PHONE),
      alexa_info: () => Promise.resolve(DEMO_ALEXA),
      discord_info: () => Promise.resolve({ configured: true, name: 'Jarvis', guilds: ['Georgs Gaming-Zentrale'], error: '' }),
      discord_save: () => Promise.resolve({ configured: true, name: 'Jarvis', guilds: [], error: '' }),
      discord_invite: () => Promise.resolve({ ok: true }),
      tailscale_info: () => Promise.resolve({ installed: true, running: true, name: 'georgs-pc.tail1234.ts.net', error: '', url: DEMO_TS.url }),
      tailscale_enable: (on) => { DEMO_TS.url = on ? 'https://georgs-pc.tail1234.ts.net/' : ''; return Promise.resolve({ ok: true, url: DEMO_TS.url, error: '' }); },
      tailscale_help: () => Promise.resolve(true),
      calendar_info: () => Promise.resolve(DEMO_CAL),
      calendar_add: (url) => {
        if (!/^(https|webcal):\/\//.test(url)) return Promise.resolve({ ok: false, error: 'Das ist keine iCal-Adresse. Sie beginnt mit https:// oder webcal:// und endet meist auf .ics.' });
        DEMO_CAL.feeds.push({ url, shown: url.replace(/^(\w+:\/\/[^/]+\/).*/, '$1…'), error: '' });
        return Promise.resolve({ ok: true, error: '', count: 9, next: ['morgen um 9 Uhr Daily Standup', 'morgen um 18 Uhr Training'] });
      },
      calendar_remove: (url) => { DEMO_CAL.feeds = DEMO_CAL.feeds.filter((f) => f.url !== url); return Promise.resolve({ ok: true }); },
      calendar_help: () => Promise.resolve(true),
      apple_info: () => Promise.resolve(DEMO_APPLE),
      apple_connect: () => Promise.resolve(Object.assign({ ok: true }, DEMO_APPLE)),
      apple_choose_calendar: (id) => {
        DEMO_APPLE.kalender.forEach((c) => { c.gewaehlt = c.id === id && c.schreibbar; });
        return Promise.resolve({ ok: true, fehler: '', kalender: DEMO_APPLE.kalender });
      },
      apple_refresh: () => Promise.resolve(DEMO_APPLE),
      apple_disconnect: () => Promise.resolve({ ok: true, fehler: '' }),
      apple_help: () => Promise.resolve(true),
      mail_accounts: () => Promise.resolve(DEMO_MAIL),
      mail_add: () => Promise.resolve({ ok: true, fehler: '', konto: null }),
      mail_remove: () => Promise.resolve({ ok: true, fehler: '' }),
      mail_help: () => Promise.resolve(true),
      labor_info: () => (/[?&]labor\b/.test(location.search) ? Promise.resolve(DEMO_LABOR) : Promise.reject(new Error('kein Labor'))),
      labor_open: () => Promise.resolve({ ok: false, error: 'Im Demo-Modus öffnet sich kein Ordner.' }),
      werkzeug_loeschen: () => Promise.resolve(true),
      shop_info: () => Promise.resolve(DEMO_SHOP),
      shop_connect: () => Promise.resolve({ ok: true, error: '', name: 'Georgs Laden' }),
      shop_disconnect: () => Promise.resolve({ ok: true, error: '' }),
      shop_help: () => Promise.resolve(true),
      discord_portal: () => Promise.resolve(true),
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
      start() {
        setInterval(() => {
          cpu = clamp(cpu + (Math.random() - 0.5) * 9, 4, 96);
          ram = clamp(ram + (Math.random() - 0.5) * 2, 30, 80);
          push({ type: 'stats', cpu, ram, gpu: { load: Math.round(40 + 30 * Math.abs(Math.sin(Date.now() / 9000))), temp: 64, mem: 52 } });
        }, 2000);
        push({ type: 'stats', cpu, ram });
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

  const DEMO_PROJECTS = [
    { name: 'Discord Bot Wetter', folder: 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-10-01_1530_discord-bot-wetter', state: 'done',
      task: 'Bau mir einen Discord-Bot, der jeden Morgen das Wetter postet', model: 'sonnet', start: true,
      summary: 'Der Bot ist fertig, Sir. Tragen Sie den Token in .env ein und starten Sie ihn mit start.bat.',
      updated: new Date(Date.now() - 2 * 3600e3).toISOString(), history: [{}, {}] },
    { name: 'Weltraum Shooter', folder: 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-09-30_2010_weltraum-shooter', state: 'done',
      task: 'Programmier mir ein Weltraum-Spiel mit Highscore, Levels und Sound', model: 'opus', start: true,
      summary: 'Das Spiel läuft, Sir: drei Level, Highscore-Liste und Soundeffekte. Steuerung mit Pfeiltasten und Leertaste.',
      updated: new Date(Date.now() - 26 * 3600e3).toISOString(), history: [{}, {}, {}] },
    { name: 'Downloads Sortieren', folder: 'C:\\Users\\Georg\\Jarvis-Werkstatt\\2026-09-28_1112_downloads-sortieren', state: 'error',
      task: 'Schreib ein Skript, das meine Downloads nach Typ sortiert', model: 'sonnet', start: false,
      summary: 'Das Claude-Kontingent war erschöpft. Sagen Sie einfach: Arbeite an Downloads Sortieren weiter.',
      updated: new Date(Date.now() - 4 * 86400e3).toISOString(), history: [{}] },
  ];
  const DEMO_PHONE = {
    enabled: true, running: true, ip: '192.168.1.20', port: 8765, mac: '3C:7C:3F:12:AB:9E',
    url: 'http://192.168.1.20:8765/app/#t=demo-schluessel-123456',
    qr: '<svg viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h7v7H0zM14 0h7v7h-7zM0 14h7v7H0z" fill="#000"/><path d="M1 1h5v5H1zM15 1h5v5h-5zM1 15h5v5H1z" fill="#fff"/><path d="M2 2h3v3H2zM16 2h3v3h-3zM2 16h3v3H2zM9 1h1v2H9zM11 3h2v1h-2zM8 8h5v1H8zM9 10h1v3H9zM12 11h2v2h-2zM15 9h2v1h-2zM17 12h3v1h-3zM14 15h2v2h-2zM18 16h2v4h-2zM9 15h3v1H9zM10 18h1v3h-1z" fill="#000"/></svg>',
  };
  const DEMO_ALEXA = { enabled: true, connected: true };
  const DEMO_PUSH = { enabled: true, topic: 'jarvis-3f9c2a71b0d84e6c5a1f7d22', url: 'https://ntfy.sh/jarvis-3f9c2a71b0d84e6c5a1f7d22' };
  const DEMO_TS = { url: '' };

  // wie apple_info() und mail_accounts() in gui/app.py (DEMO_APPLE, DEMO_MAIL_ACCOUNTS)
  // "2026-10-02T09:15" für heute (0) oder vor ein paar Tagen, wie mail.py es liefert
  const demoStamp = (days, hm) => {
    const d = new Date(Date.now() - days * 86400000);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + 'T' + hm;
  };
  const DEMO_APPLE = {
    verbunden: true, email: 'ge•••g@icloud.com', geburtstage: 14, fehler: '',
    kalender: [
      { id: 'home', name: 'Privat', farbe: '#FF2968', schreibbar: true, gewaehlt: true },
      { id: 'work', name: 'Arbeit', farbe: '#1BADF8', schreibbar: true, gewaehlt: false },
      { id: 'familie', name: 'Familie', farbe: '#63DA38', schreibbar: false, gewaehlt: false },
    ],
    mail: {
      ungelesen: 3, fehler: '',
      letzte: [
        { id: 'icloud:4711', von: 'Max Mustermann', adresse: 'max@example.com', betreff: 'Grillen am Samstag?', datum: demoStamp(0, '09:15'), ungelesen: true, newsletter: false, vorschau: 'Hast du Lust, am Samstag zu grillen? Um sechs bei mir.' },
        { id: 'icloud:4710', von: 'Amazon', adresse: 'versand-bestaetigung@amazon.de', betreff: 'Ihr Paket kommt heute', datum: demoStamp(0, '08:40'), ungelesen: true, newsletter: false, vorschau: 'Ihre Bestellung ist unterwegs: Controller für die Xbox.' },
        { id: 'gmail:813', von: 'Steam', adresse: 'noreply@steampowered.com', betreff: 'Herbst-Sale: bis zu 90 %', datum: demoStamp(0, '07:02'), ungelesen: true, newsletter: true, vorschau: '' },
        { id: 'gmail:812', von: 'Sparkasse', adresse: 'info@sparkasse.de', betreff: 'Ihr Kontoauszug für Oktober', datum: demoStamp(1, '18:05'), ungelesen: false, newsletter: false, vorschau: 'Ihr Kontoauszug für Oktober liegt bereit.' },
      ],
    },
  };
  const DEMO_MAIL = [
    { id: 'icloud', anbieter: 'icloud', name: 'iCloud', email: 'ge•••g@icloud.com', server: 'imap.mail.me.com', automatisch: true, fehler: '' },
    { id: 'gmail', anbieter: 'gmail', name: 'Gmail', email: 'ge•••r@gmail.com', server: 'imap.gmail.com', automatisch: false, fehler: '' },
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

  const DEMO_SHOP = {
    verbunden: true, name: 'Georgs Laden', adresse: 'georg.myshopify.com', fehler: '',
    heute: { anzahl: 2, umsatz: '58 Euro' }, woche: { anzahl: 7, umsatz: '203,50 Euro' }, offen: 3,
    bestseller: ['Mauspad Jarvis'],
  };

  const DEMO_CAL = {
    feeds: [{ url: 'https://calendar.google.com/calendar/ical/georg/private-abc/basic.ics', shown: 'https://calendar.google.com/…', error: '' }],
    count: 6,
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
      { name: 'discord-server', description: 'Einen Discord-Server gestalten oder umbauen, im Hintergrund ohne Maus.', learned: false },
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
      Werkstatt = window.JarvisWerkstatt.create({ call, toast, onHub: () => Projekte && Projekte.open() });
      if (Werkstatt) Werkstatt.renderPill();
    }
    if (window.JarvisProjekte) Projekte = window.JarvisProjekte.create({ call, toast, werkstatt: Werkstatt });
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
