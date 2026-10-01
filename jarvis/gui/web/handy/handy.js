/* Jarvis auf dem Handy. Spricht nur mit dem eigenen PC (gleiche Adresse), mit dem
   geheimen Schlüssel aus dem QR-Code. Ohne Python (Datei direkt geöffnet): Demo. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEY = 'jarvisSchluessel';
  const SPEAK = 'jarvisVorlesen';
  const DEMO = location.protocol === 'file:' || /[?&]demo\b/.test(location.search);

  const el = {
    body: document.body,
    stateText: $('stateText'),
    weather: $('weather'),
    speakBtn: $('speakBtn'),
    speakText: $('speakText'),
    pair: $('pair'),
    offer: $('offer'),
    offerText: $('offerText'),
    tabs: $('tabs'),
    feed: $('feed'),
    feedEmpty: $('feedEmpty'),
    quickGrid: $('quickGrid'),
    job: $('job'),
    jobTask: $('jobTask'),
    jobState: $('jobState'),
    jobBar: $('jobBar'),
    jobHint: $('jobHint'),
    projects: $('projects'),
    projectsEmpty: $('projectsEmpty'),
    composer: $('composer'),
    input: $('input'),
    send: $('send'),
    stop: $('stop'),
    toast: $('toast'),
  };

  const STATES = {
    idle: 'Bereit', listening: 'Hört zu …', thinking: 'Arbeitet …', speaking: 'Spricht …', muted: 'Mikrofon aus',
    error: 'Fehler',
  };

  // ------------------------------------------------------------------ Schlüssel

  function storage(action, value) {
    try {
      if (action === 'get') return localStorage.getItem(value) || '';
      localStorage.setItem(value[0], value[1]);
    } catch {
      /* privater Modus: dann eben nur für diese Sitzung */
    }
    return '';
  }

  let token = '';
  (function takeToken() {
    const found = /[#&]t=([A-Za-z0-9_-]{12,})/.exec(location.hash);
    if (found) {
      token = found[1];
      storage('set', [KEY, token]);
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      token = storage('get', KEY);
    }
  })();

  // ------------------------------------------------------------------ Verbindung

  async function api(path, body) {
    if (DEMO) return Demo.api(path, body);
    const options = { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { Authorization: 'Bearer ' + token } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(path, options);
    if (res.status === 401) {
      const err = new Error('Schlüssel falsch');
      err.code = 401;
      throw err;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const S = { link: 'wait', state: 'idle', last: 0, busy: false, waiting: 0, speak: storage('get', SPEAK) === '1', tab: 'talk' };

  function setLink(link) {
    if (S.link === link) return;
    S.link = link;
    el.body.dataset.link = link;
    el.pair.hidden = link !== 'pair';
    renderState();
  }

  function renderState() {
    let text = STATES[S.state] || 'Bereit';
    if (S.link === 'off') text = 'PC nicht erreichbar';
    else if (S.link === 'wait') text = 'Verbinde …';
    else if (S.link === 'pair') text = 'Nicht verbunden';
    el.stateText.textContent = text;
    el.body.dataset.state = S.link === 'ok' ? S.state : 'idle';
    const busy = S.link === 'ok' && (S.busy || S.state === 'thinking' || S.state === 'speaking');
    el.stop.hidden = !busy;
    el.send.hidden = busy && !el.input.value.trim();
    renderTyping(busy && S.state === 'thinking');
  }

  // ------------------------------------------------------------------ Status

  async function pollStatus() {
    if (!token && !DEMO) {
      setLink('pair');
      return;
    }
    try {
      const data = await api('/api/status');
      setLink('ok');
      S.state = String(data.zustand || 'idle');
      S.busy = !!data.beschaeftigt;
      el.weather.hidden = !data.wetter;
      el.weather.textContent = String(data.wetter || '').split(' · ').slice(0, 2).join(' · ');
      renderOffer(data.vorschlag);
      renderJob(data.werkstatt);
      renderState();
    } catch (err) {
      if (err && err.code === 401) {
        token = '';
        storage('set', [KEY, '']);
        setLink('pair');
      } else {
        setLink('off');
      }
    }
  }

  function renderOffer(offer) {
    if (!offer || !offer.frage) {
      el.offer.hidden = true;
      return;
    }
    el.offerText.textContent = String(offer.frage);
    el.offer.hidden = false;
  }

  // ------------------------------------------------------------------ Gespräch

  const seen = new Set();
  let typing = null;

  function renderTyping(on) {
    if (on && !typing) {
      typing = document.createElement('li');
      typing.className = 'typing';
      typing.setAttribute('aria-label', 'Jarvis arbeitet');
      typing.innerHTML = '<i></i><i></i><i></i>';
      el.feed.appendChild(typing);
      scrollFeed();
    } else if (!on && typing) {
      typing.remove();
      typing = null;
    }
  }

  function scrollFeed() {
    const view = el.feed.closest('.view');
    if (view) view.scrollTop = view.scrollHeight;
  }

  function addItem(item) {
    if (!item || seen.has(item.n)) return;
    seen.add(item.n);
    S.last = Math.max(S.last, Number(item.n) || 0);
    const li = document.createElement('li');
    const kind = { user: 'user', jarvis: 'jarvis', schritt: 'step', fehler: 'error' }[item.art] || 'jarvis';
    li.className = 'msg ' + kind;
    li.textContent = String(item.text || '');
    if (kind === 'user' || kind === 'jarvis') {
      const time = document.createElement('small');
      time.textContent = String(item.zeit || '');
      li.appendChild(time);
    }
    if (typing) el.feed.insertBefore(li, typing);
    else el.feed.appendChild(li);
    while (el.feed.children.length > 120) el.feed.firstElementChild.remove();
    el.feedEmpty.hidden = true;
    scrollFeed();
  }

  async function pollFeed() {
    if (S.link !== 'ok') return;
    try {
      const data = await api('/api/verlauf?seit=' + S.last);
      (data.eintraege || []).forEach(addItem);
    } catch {
      /* der Status merkt es */
    }
  }

  async function send(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (S.link !== 'ok') {
      toast('Jarvis ist gerade nicht erreichbar.', 'error');
      return;
    }
    try {
      await api('/api/befehl', { text, sprechen: S.speak });
      S.waiting = Date.now();
      S.busy = true;
      renderState();
      setTimeout(pollFeed, 150);
      setTimeout(pollStatus, 400);
    } catch {
      toast('Senden ging nicht. Ist der PC an?', 'error');
    }
  }

  // ------------------------------------------------------------------ Schnellaktionen

  const ICON = {
    app: '<path d="M4 5h16v11H4z"/><path d="M9 20h6M12 16v4"/>',
    discord: '<path d="M7 8.5c3-1.5 7-1.5 10 0M7.5 16c3 1.4 6 1.4 9 0"/><path d="M6.5 8.5 5 15.5c1 1 2.3 1.6 3.5 2l1-1.8M17.5 8.5l1.5 7c-1 1-2.3 1.6-3.5 2l-1-1.8"/><circle cx="9.5" cy="12.5" r="1"/><circle cx="14.5" cy="12.5" r="1"/>',
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    next: '<path d="M6 6l8 6-8 6zM17 6v12"/>',
    up: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    down: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 12h4"/>',
    game: '<path d="M7 9h10a4 4 0 0 1 3.9 4.8l-.6 3a2 2 0 0 1-3.4 1L15 16H9l-1.9 1.8a2 2 0 0 1-3.4-1l-.6-3A4 4 0 0 1 7 9z"/><path d="M8 11.5v3M6.5 13h3M15.5 12.5h.01M17.5 14h.01"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    power: '<path d="M12 3v8"/><path d="M6.4 7a7.5 7.5 0 1 0 11.2 0"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v4.5h4.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    mute: '<path d="M15 9.5V6a3 3 0 0 0-5.6-1.5M9 9v2a3 3 0 0 0 5 2.2"/><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M12 17.5V21M4 4l16 16"/>',
    brain: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.3A3 3 0 0 0 9 17.5V4.5zM15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.3 3 3 0 0 1-4.5 4.7V4.5z"/>',
  };

  const QUICK = [
    ['Programme'],
    ['Discord', 'Öffnen, ohne Maus', 'Öffne Discord', 'discord'],
    ['Spotify', 'Musik starten', 'Öffne Spotify', 'music'],
    ['YouTube', 'Im Browser', 'Öffne YouTube', 'app'],
    ['Steam', 'Spiele', 'Öffne Steam', 'game'],
    ['Musik und Ton'],
    ['Pause / Weiter', 'Musik anhalten', 'Pause', 'music'],
    ['Nächstes Lied', 'Weiter springen', 'Nächstes Lied', 'next'],
    ['Lauter', 'Lautstärke hoch', 'Lauter', 'up'],
    ['Leiser', 'Lautstärke runter', 'Leiser', 'down'],
    ['Discord stumm', 'Mikrofon umschalten', 'Schalte mich in Discord stumm', 'mute'],
    ['PC'],
    ['Gaming-Modus', 'Volle Leistung', 'Gaming-Modus an', 'game'],
    ['PC sperren', 'Sofort', 'Sperre den PC', 'lock'],
    ['Energiesparen', 'PC schlafen legen', 'Schick den PC in den Energiesparmodus', 'moon'],
    ['Herunterfahren', 'Zweimal tippen', 'Fahr den PC herunter', 'power', true],
    ['Neustart', 'Zweimal tippen', 'Starte den PC neu', 'restart', true],
    ['Jarvis'],
    ['Wetter', 'Heute', 'Wie wird das Wetter heute?', 'sun'],
    ['Was weißt du?', 'Gedächtnis', 'Was weißt du über mich?', 'brain'],
  ];

  function buildQuick() {
    el.quickGrid.textContent = '';
    for (const [label, hint, say, icon, danger] of QUICK) {
      if (!say) {
        const h = document.createElement('h2');
        h.className = 'group-title';
        h.textContent = label;
        el.quickGrid.appendChild(h);
        continue;
      }
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile' + (danger ? ' danger' : '');
      tile.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" class="ico">' + (ICON[icon] || ICON.app) + '</svg>';
      const b = document.createElement('b');
      b.textContent = label;
      const small = document.createElement('small');
      small.textContent = hint;
      tile.append(b, small);
      let armed = 0;
      tile.addEventListener('click', () => {
        if (danger && !armed) {
          tile.classList.add('armed');
          small.textContent = 'Nochmal tippen zum Bestätigen';
          armed = setTimeout(() => {
            armed = 0;
            tile.classList.remove('armed');
            small.textContent = hint;
          }, 3500);
          return;
        }
        clearTimeout(armed);
        armed = 0;
        tile.classList.remove('armed');
        small.textContent = hint;
        send(say);
        toast(label + ' …', 'ok');
      });
      el.quickGrid.appendChild(tile);
    }
  }

  // ------------------------------------------------------------------ Werkstatt

  function renderJob(job) {
    if (!job) {
      el.job.hidden = true;
      return;
    }
    el.job.hidden = false;
    el.jobTask.textContent = String(job.auftrag || 'Auftrag');
    const state = String(job.zustand || 'running');
    el.jobState.textContent = { running: 'Arbeitet', done: 'Fertig', error: 'Fehler', cancelled: 'Abgebrochen' }[state] || state;
    el.jobState.className = 'pill ' + (state === 'done' ? 'done' : state === 'error' ? 'error' : '');
    const total = Number(job.schritte) || 0;
    const done = Number(job.erledigt) || 0;
    el.jobBar.style.width = (state === 'done' ? 100 : total ? Math.round((done / total) * 100) : 8) + '%';
    el.jobHint.textContent = state === 'running'
      ? (total ? 'Schritt ' + Math.min(done + 1, total) + ' von ' + total : 'Plant die Schritte …')
      : String(job.zusammenfassung || '');
  }

  async function loadProjects() {
    try {
      const data = await api('/api/projekte');
      const items = data.projekte || [];
      el.projects.textContent = '';
      el.projectsEmpty.hidden = items.length > 0;
      for (const p of items) {
        const li = document.createElement('li');
        li.className = 'project';
        const head = document.createElement('div');
        head.className = 'project-head';
        const name = document.createElement('b');
        name.textContent = String(p.name || 'Projekt');
        const pill = document.createElement('span');
        const state = String(p.state || '');
        pill.className = 'pill ' + (state === 'done' ? 'done' : state === 'error' ? 'error' : '');
        pill.textContent = { running: 'Arbeitet', done: 'Fertig', error: 'Fehler', cancelled: 'Abgebrochen' }[state] || 'Offen';
        head.append(name, pill);
        li.appendChild(head);
        if (p.summary || p.task) {
          const text = document.createElement('p');
          text.textContent = String(p.summary || p.task);
          li.appendChild(text);
        }
        const actions = document.createElement('div');
        actions.className = 'project-actions';
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn primary';
        more.textContent = 'Weiterbauen';
        more.addEventListener('click', () => {
          showTab('talk');
          el.input.value = 'Arbeite am ' + (p.name || 'Projekt') + ' weiter: ';
          grow();
          el.input.focus();
        });
        actions.appendChild(more);
        if (p.start) {
          const run = document.createElement('button');
          run.type = 'button';
          run.className = 'btn';
          run.textContent = 'Am PC starten';
          run.addEventListener('click', () => {
            send('Starte das Projekt ' + (p.name || ''));
            toast((p.name || 'Projekt') + ' startet am PC.', 'ok');
          });
          actions.appendChild(run);
        }
        li.appendChild(actions);
        el.projects.appendChild(li);
      }
    } catch {
      el.projectsEmpty.hidden = false;
    }
  }

  // ------------------------------------------------------------------ Bedienung

  function showTab(tab) {
    S.tab = tab;
    el.body.dataset.view = tab;
    for (const b of el.tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
    if (tab === 'shop') loadProjects();
    if (tab === 'talk') scrollFeed();
  }

  function grow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 140) + 'px';
    el.send.disabled = !el.input.value.trim();
    renderState();
  }

  let toastTimer = 0;
  function toast(text, kind) {
    el.toast.textContent = text;
    el.toast.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 2400);
  }

  function renderSpeak() {
    el.speakBtn.setAttribute('aria-pressed', String(S.speak));
    el.speakText.textContent = 'Am PC vorlesen: ' + (S.speak ? 'an' : 'aus');
    el.speakBtn.title = S.speak ? 'Jarvis liest Antworten am PC vor' : 'Antworten nur hier anzeigen (am PC still)';
  }

  el.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  el.input.addEventListener('input', grow);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.composer.requestSubmit();
    }
  });
  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value;
    el.input.value = '';
    grow();
    send(text);
  });
  el.stop.addEventListener('click', async () => {
    try {
      await api('/api/stopp', {});
      toast('Gestoppt.', 'ok');
    } catch {
      toast('Stopp ging nicht.', 'error');
    }
  });
  el.speakBtn.addEventListener('click', () => {
    S.speak = !S.speak;
    storage('set', [SPEAK, S.speak ? '1' : '0']);
    renderSpeak();
    toast(S.speak ? 'Jarvis liest am PC vor.' : 'Antworten nur hier, am PC still.', 'ok');
  });
  el.offer.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-answer]');
    if (!b) return;
    el.offer.hidden = true;
    try {
      await api('/api/vorschlag', { antwort: b.dataset.answer });
      setTimeout(pollFeed, 300);
    } catch {
      toast('Das ging gerade nicht.', 'error');
    }
  });
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-say]');
    if (chip) send(chip.dataset.say);
  });

  // Nur abfragen, solange die App sichtbar ist (schont den Akku)
  let statusTimer = 0;
  let feedTimer = 0;
  function loop() {
    clearInterval(statusTimer);
    clearInterval(feedTimer);
    if (document.hidden) return;
    pollStatus().then(pollFeed);
    statusTimer = setInterval(pollStatus, 3000);
    feedTimer = setInterval(() => {
      if (S.busy || Date.now() - S.waiting < 60000 || Math.random() < 0.4) pollFeed();
    }, 1200);
  }
  document.addEventListener('visibilitychange', loop);

  // ------------------------------------------------------------------ Demo (Datei ohne PC)

  const Demo = {
    n: 0,
    items: [],
    state: 'idle',
    add(art, text) {
      this.n += 1;
      const now = new Date();
      this.items.push({ n: this.n, art, text, zeit: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') });
    },
    api(path, body) {
      if (path.startsWith('/api/status')) {
        return Promise.resolve({
          zustand: this.state, beschaeftigt: this.state !== 'idle', wetter: '14° · leicht bewölkt · Wien',
          vorschlag: /[?&]vorschlag\b/.test(location.search) ? { frage: 'Sir, um diese Zeit öffnen Sie meist Discord und Spotify. Soll ich?' } : null,
          werkstatt: { auftrag: 'Bau mir einen Discord-Bot, der jeden Morgen das Wetter postet', zustand: 'running', schritte: 5, erledigt: 2 },
        });
      }
      if (path.startsWith('/api/verlauf')) {
        const since = Number((/seit=(\d+)/.exec(path) || [0, 0])[1]);
        return Promise.resolve({ eintraege: this.items.filter((i) => i.n > since) });
      }
      if (path.startsWith('/api/projekte')) {
        return Promise.resolve({ projekte: [
          { name: 'Discord Bot Wetter', state: 'running', task: 'Bau mir einen Discord-Bot, der jeden Morgen das Wetter postet', start: false },
          { name: 'Weltraum Shooter', state: 'done', summary: 'Das Spiel läuft, Sir: drei Level, Highscore-Liste und Soundeffekte.', start: true },
        ] });
      }
      if (path === '/api/befehl') {
        this.add('user', body.text);
        this.state = 'thinking';
        setTimeout(() => {
          this.add('schritt', 'Öffnet ' + body.text.replace(/^Öffne /, ''));
          this.add('jarvis', 'Erledigt, Sir.');
          this.state = 'idle';
        }, 900);
      }
      return Promise.resolve({ ok: true });
    },
  };
  if (DEMO) {
    Demo.add('user', 'Öffne Spotify und Discord');
    Demo.add('schritt', 'Öffnet Spotify');
    Demo.add('schritt', 'Öffnet Discord');
    Demo.add('jarvis', 'Spotify und Discord starten, Sir.');
    Demo.add('user', 'Sag Max, dass ich in zehn Minuten online bin');
    Demo.add('schritt', 'Schreibt Max auf Discord');
    Demo.add('jarvis', 'An Max ist raus, Sir.');
  }

  // ------------------------------------------------------------------ Start

  buildQuick();
  renderSpeak();
  grow();
  const startTab = (/[?&]tab=(\w+)/.exec(location.search) || [0, 'talk'])[1];
  showTab(['talk', 'quick', 'shop'].includes(startTab) ? startTab : 'talk');
  if (!token && !DEMO) setLink('pair');
  loop();
})();
