/* ==========================================================================
   Jarvis – Kommandozentrale und Gespräch (zentrale.css)
   Zeigt, was zentrale.py meldet: Aktivität, Kennzahlen, Tagesplan, Posteingang, Nachrichten live,
   Spezialisten. Beim Briefing hebt sie hervor, wovon Jarvis gerade spricht (Ereignis "focus").
   Dazu das Gespräch im HUD-Look: Menü, aktuelle Aufgabe, Assistent mit Verstehen, Denken, Erledigen,
   Sprechen. Texte aus Python kommen nur als Klartext (textContent) ins Fenster.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const pad2 = (n) => String(n).padStart(2, '0');
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(motionQuery && motionQuery.matches);
  const HOME_KEY = 'jarvis.ansicht';

  const STATE_WORDS = {
    idle: 'Bereit', listening: 'Hört zu', thinking: 'Denkt nach', speaking: 'Antwortet', muted: 'Stumm', error: 'Störung',
  };
  const AGENT_WORDS = {
    bereit: 'Bereit', arbeitet: 'Arbeitet', schreibt: 'Schreibt', wartet: 'Wartet auf Sie', fertig: 'Fertig', fehler: 'Fehler',
  };
  const MAIL_WORDS = { wichtig: 'wichtig', offen: 'offen', beantwortet: 'beantwortet', werbung: 'Werbung' };

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function minutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const listenNow = opts.listenNow || (() => {});
    const body = document.body;
    const el = {
      grid: document.querySelector('.zt-grid'),
      tabs: Array.from(document.querySelectorAll('.view-tab')),
      nav: Array.from(document.querySelectorAll('.hud-nav-item')),
      liveMark: $('liveMark'), liveText: $('liveText'), topEvents: $('topEvents'), topClock: $('topClock'),
      briefing: $('ztBriefing'), refresh: $('ztRefresh'),
      kontoTitle: $('ztKontoTitle'), kontoWerte: $('ztKontoWerte'), kontoZeilen: $('ztKontoZeilen'), kontoEmpty: $('ztKontoEmpty'),
      stars: $('ztStars'),
      feed: $('ztFeed'), aktCount: $('ztAktCount'), chips: $('ztChips'),
      orb: $('ztOrb'), orbBtn: $('ztOrbBtn'), wave: $('ztWave'), orbState: $('ztOrbState'), wissen: $('ztWissen'),
      ringCpu: $('ztRingCpu'), ringRam: $('ztRingRam'), ringGpu: $('ztRingGpu'),
      cpu: $('ztCpu'), ram: $('ztRam'), gpu: $('ztGpu'), gpuRow: $('ztGpuRow'), pcNote: $('ztPcNote'),
      kpis: $('ztKpis'),
      planWeek: $('ztPlanWeek'), allday: $('ztAllday'), timeline: $('ztTimeline'), planEmpty: $('ztPlanEmpty'),
      mails: $('ztMails'), postCount: $('ztPostCount'), postEmpty: $('ztPostEmpty'),
      news: document.querySelector('.zt-news'), video: $('ztVideo'), newsImg: $('ztNewsImg'), newsLabel: $('ztNewsLabel'),
      newsHeadline: $('ztNewsHeadline'),
      sound: $('ztSound'), soundText: $('ztSoundText'), ticker: $('ztTicker'), tickerText: $('ztTickerText'),
      notes: $('ztNotes'), notesEmpty: $('ztNotesEmpty'),
      agents: $('ztAgents'),
      chat: $('ztChat'), listen: $('ztListen'),
      micPill: $('micPill'), micPillText: $('micPillText'),
      pipe: Array.from(document.querySelectorAll('#pipe li')),
      task: document.querySelector('.task-card'), taskTitle: $('taskTitle'), taskDetail: $('taskDetail'),
      coreWrap: $('coreWrap'),
    };

    const S = {
      data: null,
      focus: null,          // {bereich, titel, detail, zeit, ziel} während des Briefings
      state: 'idle',
      level: 0,
      steps: new Map(),     // laufende Arbeitsschritte
      lastStep: null,
      hidden: false,        // das Fenster ist versteckt (Tray)
      news: { mode: '', src: '', hls: null, tried: {} },
      gaming: false,
    };

    // ---------------------------------------------------------------- Ansicht: Zentrale oder Gespräch

    function home() {
      return body.dataset.home === 'gespraech' ? 'gespraech' : 'zentrale';
    }

    function setHome(name, remember) {
      const want = name === 'gespraech' ? 'gespraech' : 'zentrale';
      body.dataset.home = want;
      el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.home === want)));
      el.nav.forEach((n) => {
        if (n.dataset.go === want) n.setAttribute('aria-current', 'page');
        else n.removeAttribute('aria-current');
      });
      if (remember !== false) {
        try { localStorage.setItem(HOME_KEY, want); } catch { /* egal */ }
      }
      if (want === 'zentrale') layoutTimeline();
      syncVideo();
    }

    function visible() {
      return body.dataset.view === 'hud' && home() === 'zentrale' && !S.hidden && !document.hidden;
    }

    // ---------------------------------------------------------------- Kopfzeile

    function tick() {
      const d = new Date();
      if (el.topClock) el.topClock.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      if (d.getSeconds() === 0) placeNow();
      setTimeout(tick, 1000 - (d.getMilliseconds() % 1000) + 5);
    }

    function renderLive(lage) {
      const info = lage || {};
      let state = 'aus';
      let text = 'Ohne Konnektoren';
      let title = 'Post, Kalender und Shop liest Jarvis über Claude Code und Ihre Konnektoren.';
      if (info.laeuft) {
        state = 'laeuft';
        text = 'Lagebild lädt …';
        title = 'Jarvis liest gerade Post, Kalender und Shop (nur lesend).';
      } else if (info.zeit && info.alter !== null && info.alter !== undefined && info.alter <= 35) {
        state = 'live';
        text = 'Live';
        title = 'Stand ' + info.zeit + ' Uhr. Jarvis holt alle halbe Stunde neu.';
      } else if (info.fehler) {
        state = 'fehler';
        text = info.zeit ? 'Stand ' + info.zeit : 'Kein Lagebild';
        title = 'Zuletzt nicht geklappt: ' + info.fehler;
      } else if (info.zeit) {
        state = 'alt';
        text = 'Stand ' + info.zeit;
        title = 'Älter als eine halbe Stunde. Mit dem Pfeil holen Sie es neu.';
      } else if (info.moeglich) {
        state = 'alt';
        text = 'Noch kein Lagebild';
        title = 'Kommt kurz nach dem Start von selbst, oder mit dem Pfeil sofort.';
      }
      el.liveMark.dataset.state = state;
      el.liveText.textContent = text;
      el.liveMark.title = title;
      el.refresh.dataset.busy = info.laeuft ? '1' : '0';
      el.refresh.disabled = !info.moeglich;
    }

    // ---------------------------------------------------------------- Konto (Werbekonten, Shop, Spiele)

    function renderKonto(konto) {
      el.kontoWerte.textContent = '';
      const rows = el.kontoZeilen.tBodies[0];
      rows.textContent = '';
      if (!konto) {
        el.kontoTitle.textContent = 'Kennzahlen';
        el.kontoEmpty.hidden = false;
        el.kontoEmpty.textContent = waiting() || 'Verbinden Sie Shopify oder Windsor.ai auf claude.ai (Einstellungen › Konnektoren), dann stehen hier Umsatz, Bestellungen und Werbekonten.';
        el.kontoZeilen.hidden = true;
        return;
      }
      el.kontoTitle.textContent = konto.titel || 'Kennzahlen';
      el.kontoEmpty.hidden = true;
      (konto.werte || []).slice(0, 4).forEach((w) => {
        const box = node('div');
        box.append(node('dt', '', w.name), node('dd', '', w.wert));
        el.kontoWerte.append(box);
      });
      const lines = (konto.zeilen || []).slice(0, 4);
      el.kontoZeilen.hidden = !lines.length;
      lines.forEach((z) => {
        const tr = document.createElement('tr');
        const trend = node('td', '', z.trend || '');
        if (z.trend === 'Update') trend.className = 'zt-trend-down';
        tr.append(node('td', '', z.name), node('td', '', z.wert), trend);
        rows.append(tr);
      });
    }

    // ---------------------------------------------------------------- Aktivität

    function renderFeed(events, chips, count) {
      el.feed.textContent = '';
      el.aktCount.textContent = (count || 0) + ' heute';
      const f = S.focus;
      if (f && (f.titel || f.detail)) {
        const li = node('li', 'zt-feed-live');
        const now = new Date();
        li.append(node('time', '', f.zeit || pad2(now.getHours()) + ':' + pad2(now.getMinutes())));
        li.append(node('b', '', f.titel || f.detail));
        if (f.titel && f.detail) li.append(node('small', '', f.detail));
        el.feed.append(li);
      }
      const list = (events || []).slice(0, f ? 4 : 5);
      list.forEach((e) => {
        const li = node('li');
        li.dataset.art = e.art || '';
        li.append(node('time', '', e.zeit || ''), node('b', '', e.text || ''));
        if (e.detail && !/^[A-Za-z]:\\|^\//.test(e.detail)) li.append(node('small', '', e.detail));
        el.feed.append(li);
      });
      if (!el.feed.children.length) {
        el.feed.append(node('li', 'zt-empty-row', 'Noch nichts erledigt heute. Sagen Sie „Briefing“ oder geben Sie Jarvis einen Auftrag.'));
      }
      el.chips.textContent = '';
      (chips || []).forEach((c) => {
        const li = node('li', '', c.text);
        li.dataset.ok = c.ok ? '1' : '0';
        li.title = c.ok ? 'Erledigt' : 'Noch offen';
        el.chips.append(li);
      });
      fitFeed();
    }

    // Was nicht ganz in die Karte passt, fällt weg, statt halb abgeschnitten dazustehen
    function fitFeed() {
      const items = Array.from(el.feed.children);
      items.forEach((li) => { li.hidden = false; });
      const bottom = el.feed.getBoundingClientRect().bottom + 1;
      let full = false;
      items.forEach((li, i) => {
        if (!full && i > 0 && li.getBoundingClientRect().bottom > bottom) full = true;
        if (full) li.hidden = true;
      });
    }

    // ---------------------------------------------------------------- Kennzahlen

    function renderKpis(list) {
      el.kpis.textContent = '';
      const items = (list || []).slice(0, 5);
      el.kpis.style.gridTemplateColumns = items.length > 1 ? '2fr repeat(' + (items.length - 1) + ', minmax(0, 1fr))' : '1fr';
      items.forEach((k, i) => {
        const box = node('div', 'zt-kpi' + (k.gross || i === 0 ? ' gross' : ''));
        box.setAttribute('role', 'listitem');
        box.dataset.warn = k.warn ? '1' : '0';
        box.dataset.ziel = /bestell|umsatz|warenkorb|versand/i.test(k.name) ? 'shop' : /roas|ausgaben|klick/i.test(k.name) ? 'werbung' : '';
        box.append(node('span', '', k.name), node('b', '', k.wert), node('small', '', k.unter || ''));
        el.kpis.append(box);
      });
    }

    // ---------------------------------------------------------------- Tagesplan

    let planItems = [];

    function renderPlan(plan) {
      const p = plan || {};
      planItems = (p.eintraege || []).filter((e) => e && e.titel);
      const week = Number(p.woche) || 0;
      el.planWeek.textContent = p.verbunden ? week + (week === 1 ? ' Termin diese Woche' : ' Termine diese Woche') : (waiting() ? '' : 'Kalender nicht verbunden');
      const allday = planItems.filter((e) => e.start === 'Tag');
      el.allday.hidden = !allday.length;
      el.allday.textContent = '';
      allday.forEach((e) => el.allday.append(node('span', '', 'Ganztägig: ' + e.titel)));
      const timed = planItems.filter((e) => minutes(e.start) !== null);
      el.planEmpty.hidden = !!timed.length;
      if (!timed.length) {
        el.planEmpty.textContent = p.verbunden
          ? 'Heute stehen keine Termine an. Erinnerungen erscheinen hier auch.'
          : waiting() || 'Verbinden Sie Google Kalender auf claude.ai (Einstellungen › Konnektoren). Erinnerungen von Jarvis stehen trotzdem hier.';
      }
      layoutTimeline();
    }

    function hourRange(items) {
      let lo = 8;
      let hi = 18;
      items.forEach((e) => {
        const a = minutes(e.start);
        const b = minutes(e.ende);
        if (a !== null) lo = Math.min(lo, Math.floor(a / 60));
        if (b !== null && b > (a || 0)) hi = Math.max(hi, Math.ceil(b / 60));
        else if (a !== null) hi = Math.max(hi, Math.ceil((a + 30) / 60));
      });
      const now = new Date();
      const h = now.getHours();
      if (h >= lo - 1 && h <= hi + 1) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h + 1);
      }
      return [clamp(lo, 0, 23), clamp(hi, lo + 1, 24)];
    }

    let range = [8, 18];

    function xOf(mins) {
      return ((mins - range[0] * 60) / ((range[1] - range[0]) * 60)) * 100;
    }

    function layoutTimeline() {
      const box = el.timeline;
      if (!box) return;
      box.textContent = '';
      const timed = planItems.filter((e) => minutes(e.start) !== null);
      range = hourRange(timed);
      const span = range[1] - range[0];
      const step = span > 12 ? 2 : 1;
      const hours = node('div', 'zt-hours');
      for (let h = range[0]; h <= range[1]; h += step) {
        const x = xOf(h * 60);
        const line = node('i', 'zt-gridline');
        line.style.left = x + '%';
        box.append(line);
        const label = node('span', '', pad2(h));
        label.style.left = x + '%';
        hours.append(label);
      }
      box.append(hours);
      // Bahnen, damit sich überlappende Termine nicht verdecken
      const lanes = [];
      const placed = timed.map((e) => {
        const a = minutes(e.start);
        let b = minutes(e.ende);
        if (b === null || b <= a) b = a + 30;
        let lane = lanes.findIndex((end) => end <= a);
        if (lane < 0) {
          lane = lanes.length;
          lanes.push(b);
        } else {
          lanes[lane] = b;
        }
        return { e, a, b, lane };
      });
      const count = Math.max(1, Math.min(3, lanes.length));
      const height = box.clientHeight || 120;
      const usable = Math.max(40, height - 24);
      const laneH = Math.min(52, (usable - (count - 1) * 4) / count);
      const top0 = Math.max(0, (usable - (laneH * count + (count - 1) * 4)) / 2);
      placed.forEach(({ e, a, b, lane }) => {
        if (lane > 2) return;
        const block = node('button', 'zt-block');
        block.type = 'button';
        block.setAttribute('role', 'listitem');
        block.dataset.art = e.art || 'termin';
        block.dataset.wichtig = e.wichtig ? '1' : '0';
        block.dataset.key = e.start + ' ' + e.titel;
        block.style.left = clamp(xOf(a), 0, 100) + '%';
        block.style.width = 'max(28px, ' + Math.max(1.5, xOf(b) - xOf(a)) + '%)';
        block.style.top = top0 + lane * (laneH + 4) + 'px';
        block.style.height = laneH + 'px';
        block.title = e.start + (e.ende && e.ende !== e.start ? '–' + e.ende : '') + ' Uhr: ' + e.titel + (e.ort ? ' · ' + e.ort : '')
          + (e.art === 'erinnerung' ? ' (Erinnerung)' : '');
        block.append(node('span', '', e.titel));
        if (e.art !== 'erinnerung') block.addEventListener('click', () => call('zentrale_open', 'kalender').catch(() => {}));
        box.append(block);
      });
      const now = node('i', 'zt-now');
      now.id = 'ztNow';
      box.append(now);
      placeNow();
      markTarget();
    }

    function placeNow() {
      const line = $('ztNow');
      if (!line) return;
      const d = new Date();
      const x = xOf(d.getHours() * 60 + d.getMinutes());
      line.hidden = x < 0 || x > 100;
      line.style.left = clamp(x, 0, 100) + '%';
    }

    // ---------------------------------------------------------------- Posteingang

    // Noch kein Lagebild (gleich nach dem Start): "kommt gleich" statt "nicht verbunden"
    function waiting() {
      const lage = (S.data && S.data.lage) || {};
      if (lage.zeit || !lage.moeglich) return '';
      return lage.laeuft ? 'Jarvis liest gerade Post, Kalender und Shop …' : 'Kommt mit dem ersten Lagebild, kurz nach dem Start.';
    }

    function renderPost(post) {
      const p = post || {};
      el.mails.textContent = '';
      const mails = (p.mails || []).slice(0, 8);
      if (!p.verbunden) {
        el.postCount.textContent = '';
        el.postEmpty.hidden = false;
        el.postEmpty.textContent = waiting() || 'Gmail ist nicht verbunden. Auf claude.ai unter Einstellungen › Konnektoren verbinden, dann sichtet Jarvis hier Ihre Post (nur lesend).';
        return;
      }
      const neu = p.neu === null || p.neu === undefined ? mails.length : p.neu;
      el.postCount.textContent = neu + ' neu seit gestern';
      el.postEmpty.hidden = !!mails.length;
      el.postEmpty.textContent = 'Seit gestern nichts Neues.';
      mails.forEach((m) => {
        const li = node('li');
        const row = node('button', 'zt-mail');
        row.type = 'button';
        row.dataset.status = m.status || 'offen';
        row.dataset.id = m.id || m.betreff || '';
        row.title = (m.kurz || m.betreff || '') + ' · In Gmail öffnen';
        row.append(node('i'), node('b', '', m.von), node('span', 'zt-mail-subject', m.betreff), node('time', '', m.zeit || ''),
          node('em', '', MAIL_WORDS[m.status] || m.status || ''));
        row.addEventListener('click', () => call('zentrale_open', 'mail', m.id || '').catch(() => {}));
        li.append(row);
        el.mails.append(li);
      });
    }

    // ---------------------------------------------------------------- Nachrichten live

    let hlsLoading = null;

    function loadHls() {
      if (window.Hls) return Promise.resolve(window.Hls);
      if (hlsLoading) return hlsLoading;
      hlsLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/hls.light.min.js';
        s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js fehlt')));
        s.onerror = () => reject(new Error('hls.js nicht geladen'));
        document.head.append(s);
      });
      return hlsLoading;
    }

    function headlines() {
      return ((S.data && S.data.nachrichten && S.data.nachrichten.schlagzeilen) || []).filter((h) => h && h.titel);
    }

    function renderNews() {
      const items = headlines();
      const text = items.map((h) => (h.oben ? h.oben + ': ' : '') + h.titel).join('   ·   ');
      // Ohne Meldungen kein Laufband: die Kachel sagt es schon in der Mitte
      el.ticker.hidden = !items.length;
      if (el.tickerText.textContent !== text) {
        el.tickerText.textContent = text;
        el.ticker.style.setProperty('--ticker-s', Math.max(18, Math.round(text.length * 0.2)) + 's');
      }
      el.ticker.disabled = !(items[0] && items[0].link);
      syncVideo();
    }

    function setNewsMode(mode) {
      S.news.mode = mode;
      el.news.dataset.mode = mode;
      const items = headlines();
      if (mode === 'live') el.newsLabel.textContent = 'Nachrichten · Live';
      else if (mode === 'video') el.newsLabel.textContent = (S.data && S.data.nachrichten && S.data.nachrichten.video_titel) || 'tagesschau';
      else if (mode === 'bild') el.newsLabel.textContent = (items[0] && items[0].oben) || 'Nachrichten';
      else el.newsLabel.textContent = 'Nachrichten';
      el.video.dataset.on = mode === 'live' || mode === 'video' ? '1' : '0';
      el.newsHeadline.textContent = items[0] ? items[0].titel : 'Die Schlagzeilen kommen, sobald Jarvis online ist.';
      const img = mode === 'bild' ? (items.find((h) => h.bild) || {}).bild : '';
      if (img) {
        if (el.newsImg.src !== img) el.newsImg.src = img;
        el.newsImg.hidden = false;
      } else {
        el.newsImg.hidden = true;
      }
    }

    function stopVideo() {
      if (S.news.hls) {
        try { S.news.hls.destroy(); } catch { /* egal */ }
        S.news.hls = null;
      }
      try {
        el.video.pause();
        el.video.removeAttribute('src');
        el.video.load();
      } catch { /* egal */ }
      S.news.src = '';
    }

    function fallback(from) {
      S.news.tried[from] = true;
      stopVideo();
      const n = (S.data && S.data.nachrichten) || {};
      if (from === 'live' && n.video && !S.news.tried.video) {
        playMp4(n.video);
        return;
      }
      setNewsMode(headlines().length ? 'bild' : 'leer');
    }

    function playMp4(url) {
      S.news.src = url;
      setNewsMode('video');
      el.video.loop = true;
      el.video.poster = (S.data && S.data.nachrichten && S.data.nachrichten.video_bild) || '';
      el.video.src = url;
      el.video.play().catch(() => {});
    }

    function playLive(url) {
      S.news.src = url;
      setNewsMode('live');
      el.video.loop = false;
      el.video.poster = '';
      if (el.video.canPlayType('application/vnd.apple.mpegurl')) {
        el.video.src = url;
        el.video.play().catch(() => {});
        return;
      }
      loadHls().then((Hls) => {
        if (S.news.src !== url) return;
        if (!Hls.isSupported()) {
          fallback('live');
          return;
        }
        const hls = new Hls({ maxBufferLength: 12, backBufferLength: 10, capLevelToPlayerSize: true, startLevel: -1 });
        S.news.hls = hls;
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data && data.fatal) fallback('live');
        });
        hls.loadSource(url);
        hls.attachMedia(el.video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => el.video.play().catch(() => {}));
      }).catch(() => fallback('live'));
    }

    el.video.addEventListener('error', () => {
      if (S.news.mode === 'video') fallback('video');
      else if (S.news.mode === 'live' && !S.news.hls) fallback('live');
    });

    function syncVideo() {
      const n = (S.data && S.data.nachrichten) || null;
      const want = visible() && !S.gaming && n && window.JarvisDemoNews !== false && !(T.box && !T.box.hidden);
      if (!want) {
        if (S.news.src) {
          stopVideo();
          S.news.mode = '';
        }
        if (!S.news.mode) setNewsMode(headlines().length ? 'bild' : 'leer');
        return;
      }
      if (S.news.src) return; // läuft schon
      if (n.live && !S.news.tried.live) playLive(n.live);
      else if (n.video && !S.news.tried.video) playMp4(n.video);
      else setNewsMode(headlines().length ? 'bild' : 'leer');
    }

    el.sound.addEventListener('click', () => {
      el.video.muted = !el.video.muted;
      el.sound.setAttribute('aria-pressed', String(!el.video.muted));
      el.soundText.textContent = el.video.muted ? 'Ton einschalten' : 'Ton ausschalten';
      if (!el.video.muted) el.video.play().catch(() => {});
    });

    el.ticker.addEventListener('click', () => {
      const first = headlines()[0];
      if (first && first.link) call('zentrale_open', 'nachrichten').catch(() => {});
    });

    // ---------------------------------------------------------------- Trailer ("Zeig mir den Trailer")

    const T = { box: $('trailer'), title: $('trailerTitle'), video: $('trailerVideo'), close: $('trailerClose'), hls: null };

    function trailerClose() {
      if (!T.box || T.box.hidden) return;
      if (T.hls) {
        try { T.hls.destroy(); } catch { /* egal */ }
        T.hls = null;
      }
      try {
        T.video.pause();
        T.video.removeAttribute('src');
        T.video.load();
      } catch { /* egal */ }
      T.box.hidden = true;
      syncVideo();
    }

    function trailer(ev) {
      const url = String(ev.url || '');
      if (!T.box || !/^https:\/\//.test(url)) return;
      trailerClose();
      T.title.textContent = ev.titel ? 'Trailer: ' + ev.titel : 'Trailer';
      T.video.poster = /^https:\/\//.test(String(ev.bild || '')) ? ev.bild : '';
      T.box.hidden = false;
      stopVideo(); // die Nachrichten schweigen solange
      S.news.mode = '';
      T.video.muted = false;
      const play = () => T.video.play().catch((err) => {
        // Kam der Befehl per Stimme, fehlt dem Fenster der Klick: dann ohne Ton starten, unten lässt er sich einschalten
        if (!err || err.name !== 'NotAllowedError' || T.box.hidden) return;
        T.video.muted = true;
        T.video.play().then(() => toast('Der Trailer läuft ohne Ton. Unten am Lautsprecher schalten Sie ihn ein.', 'info')).catch(() => {});
      });
      if (!/\.m3u8(\?|$)/.test(url) || T.video.canPlayType('application/vnd.apple.mpegurl')) {
        T.video.src = url;
        play();
      } else {
        loadHls().then((Hls) => {
          if (T.box.hidden) return;
          if (!Hls.isSupported()) {
            toast('Diesen Trailer kann das Fenster nicht abspielen.', 'error');
            trailerClose();
            return;
          }
          T.hls = new Hls({ capLevelToPlayerSize: true });
          T.hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data && data.fatal) {
              toast('Der Trailer lädt gerade nicht.', 'error');
              trailerClose();
            }
          });
          T.hls.loadSource(url);
          T.hls.attachMedia(T.video);
          T.hls.on(Hls.Events.MANIFEST_PARSED, play);
        }).catch(() => trailerClose());
      }
      setTimeout(() => T.close && T.close.focus(), 50);
    }

    if (T.close) T.close.addEventListener('click', trailerClose);
    if (T.box) {
      T.box.addEventListener('click', (e) => {
        if (e.target === T.box) trailerClose();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && T.box && !T.box.hidden) {
        e.stopPropagation();
        trailerClose();
      }
    }, true);

    // ---------------------------------------------------------------- Notizen und Spezialisten

    function renderNotes(notes) {
      el.notes.textContent = '';
      (notes || []).slice(0, 3).forEach((t) => el.notes.append(node('li', '', t)));
      el.notesEmpty.hidden = !!(notes && notes.length);
    }

    function renderAgents(list) {
      el.agents.textContent = '';
      const items = (list || []).slice(0, 6);
      el.agents.style.gridTemplateColumns = 'repeat(' + Math.max(1, items.length) + ', minmax(0, 1fr))';
      items.forEach((a) => {
        const card = node('article', 'zt-agent');
        card.setAttribute('role', 'listitem');
        card.dataset.status = a.status || 'bereit';
        card.dataset.id = a.id || '';
        card.style.setProperty('--agent', /^#[0-9a-f]{6}$/i.test(a.farbe || '') ? a.farbe : '#6e8cff');
        const head = node('header');
        head.append(node('span', 'zt-avatar', a.kuerzel || '?'), node('b', '', a.name));
        const bar = node('div', 'zt-bar');
        const fill = node('i');
        const p = a.fortschritt === null || a.fortschritt === undefined ? (a.status === 'fertig' ? 1 : 0) : a.fortschritt;
        fill.style.setProperty('--p', Math.round(clamp(Number(p) || 0, 0, 1) * 100) + '%');
        bar.append(fill);
        const word = AGENT_WORDS[a.status] || a.status || '';
        card.append(head, node('p', '', a.text || ''), bar, node('small', '', word));
        card.title = a.name + ': ' + (a.text || '') + ' (' + word + (a.zeit && a.status !== 'bereit' ? ', ' + a.zeit + ' Uhr' : '') + ')';
        el.agents.append(card);
      });
    }

    // ---------------------------------------------------------------- alles

    function render(data) {
      if (!data || typeof data !== 'object') return;
      S.data = data;
      const kopf = data.kopf || {};
      el.topEvents.textContent = String(kopf.ereignisse || 0);
      renderLive(data.lage);
      renderKonto(data.konto);
      renderFeed(data.aktivitaet, data.erledigt, kopf.ereignisse);
      const w = data.wissen || {};
      el.wissen.textContent = w.notizen ? 'Wissensnetz · ' + w.notizen.toLocaleString('de-DE') + ' Notizen'
        : w.fakten ? 'Gedächtnis · ' + w.fakten + (w.fakten === 1 ? ' Eintrag' : ' Einträge') : 'Wissensnetz';
      renderKpis(data.kennzahlen);
      renderPlan(data.tagesplan);
      renderPost(data.post);
      renderNews();
      renderNotes(data.notizen);
      renderAgents(data.agenten);
      markTarget();
    }

    // ---------------------------------------------------------------- Briefing: hervorheben

    const AREAS = {
      kopf: '.zt-akt', aktivitaet: '.zt-akt', post: '.zt-post', kennzahlen: '.zt-kpis', tagesplan: '.zt-plan',
      rueckfragen: '.zt-kpis', nachrichten: '.zt-news', orb: '.zt-orb', agenten: '.zt-agents', notizen: '.zt-notes',
    };

    function focus(ev) {
      const area = String(ev.bereich || '');
      S.focus = area ? { bereich: area, titel: ev.titel || '', detail: ev.detail || '', zeit: ev.zeit || '', ziel: ev.ziel || '' } : null;
      el.grid.querySelectorAll('.is-focus').forEach((n) => n.classList.remove('is-focus'));
      const sel = AREAS[area];
      const target = sel ? el.grid.querySelector(sel) : null;
      el.grid.classList.toggle('has-focus', !!target && area !== 'orb');
      if (target) target.classList.add('is-focus');
      if (area === 'kennzahlen' || area === 'rueckfragen') {
        const kpis = Array.from(el.kpis.children);
        const pick = area === 'rueckfragen' ? kpis[kpis.length - 1]
          : kpis.find((k) => k.dataset.ziel && k.dataset.ziel === S.focus.ziel) || kpis[0];
        if (pick) pick.classList.add('is-focus');
      }
      if (S.data) renderFeed(S.data.aktivitaet, S.data.erledigt, (S.data.kopf || {}).ereignisse);
      markTarget();
      if (target && target.scrollIntoView && document.querySelector('.zt').scrollHeight > document.querySelector('.zt').clientHeight + 4) {
        target.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
      }
    }

    function markTarget() {
      document.querySelectorAll('.zt .is-target').forEach((n) => n.classList.remove('is-target'));
      const f = S.focus;
      if (!f || !f.ziel) return;
      if (f.bereich === 'post') {
        const row = Array.from(el.mails.querySelectorAll('.zt-mail')).find((r) => r.dataset.id === f.ziel);
        if (row) row.classList.add('is-target');
      } else if (f.bereich === 'tagesplan') {
        const block = Array.from(el.timeline.querySelectorAll('.zt-block')).find((b) => b.dataset.key === f.ziel);
        if (block) block.classList.add('is-target');
      }
    }

    // ---------------------------------------------------------------- Rechner

    function ring(circle, value) {
      if (!circle) return;
      const r = Number(circle.getAttribute('r')) || 40;
      const len = 2 * Math.PI * r;
      const v = clamp(Number(value) || 0, 0, 100) / 100;
      circle.style.strokeDasharray = (len * v).toFixed(1) + ' ' + len.toFixed(1);
    }

    function stats(ev) {
      const cpu = Number(ev.cpu);
      const ram = Number(ev.ram);
      ring(el.ringCpu, cpu);
      ring(el.ringRam, ram);
      el.cpu.textContent = Number.isFinite(cpu) ? Math.round(cpu) + ' %' : '–';
      el.ram.textContent = Number.isFinite(ram) ? Math.round(ram) + ' %' : '–';
      const gpu = ev.gpu && typeof ev.gpu === 'object' ? ev.gpu : null;
      const load = gpu ? Number(gpu.load !== undefined ? gpu.load : gpu.util) : NaN;
      el.gpuRow.hidden = !Number.isFinite(load);
      if (Number.isFinite(load)) {
        el.gpu.textContent = Math.round(load) + ' %';
        ring(el.ringGpu, load);
      } else {
        ring(el.ringGpu, 0);
      }
      const temp = gpu ? Number(gpu.temp) : NaN;
      let note = 'Läuft ruhig.';
      let warn = false;
      if (cpu >= 90) { note = 'Prozessor am Anschlag.'; warn = true; }
      else if (ram >= 90) { note = 'Arbeitsspeicher fast voll.'; warn = true; }
      else if (Number.isFinite(temp) && temp >= 85) { note = 'Grafikkarte heiß: ' + Math.round(temp) + ' °C.'; warn = true; }
      else if (cpu >= 60 || load >= 60) note = 'Gut ausgelastet.';
      el.pcNote.textContent = note;
      el.pcNote.dataset.warn = warn ? '1' : '0';
    }

    // ---------------------------------------------------------------- Zustand, Stimme, Schritte

    function state(value) {
      S.state = value;
      el.orbState.textContent = STATE_WORDS[value] || 'Bereit';
      if (orbs.zt) orbs.zt.state(value);
      renderPipe();
      renderTask();
    }

    function level(v) {
      S.level = clamp(Number(v) || 0, 0, 1);
      if (orbs.zt) orbs.zt.level(S.level);
    }

    function muted(on) {
      if (!el.micPill) return;
      el.micPill.setAttribute('aria-pressed', String(!!on));
      el.micPillText.textContent = on ? 'Stumm' : 'Mikrofon an';
      el.micPill.title = on ? 'Mikrofon wieder einschalten' : 'Mikrofon stumm schalten';
    }

    function gaming(on) {
      S.gaming = !!on;
      syncVideo();
    }

    function step(st) {
      if (!st || typeof st !== 'object' || st.workshop) return;
      const id = String(st.id || '');
      if (st.state === 'running') S.steps.set(id, Object.assign({ at: performance.now() }, st));
      else {
        S.steps.delete(id);
        S.lastStep = st;
      }
      renderPipe();
      renderTask();
    }

    function runningStep() {
      let last = null;
      S.steps.forEach((s) => { last = s; });
      return last;
    }

    function renderPipe() {
      const run = runningStep();
      const phase = S.state === 'listening' ? 'verstehen' : S.state === 'speaking' ? 'sprechen'
        : run ? 'erledigen' : S.state === 'thinking' ? 'denken' : '';
      el.pipe.forEach((li) => {
        if (li.dataset.phase === phase) li.dataset.on = '1';
        else delete li.dataset.on;
      });
    }

    function renderTask() {
      if (!el.task) return;
      const run = runningStep();
      let title = 'Bereit für Ihren nächsten Befehl';
      let detail = '„Hey Jarvis“ sagen oder unten schreiben';
      let busy = false;
      if (run) {
        title = run.label || 'Arbeitet';
        detail = run.detail || 'läuft';
        busy = true;
      } else if (S.state === 'listening') {
        title = 'Hört zu';
        detail = 'Sprechen Sie ruhig weiter';
        busy = true;
      } else if (S.state === 'thinking') {
        title = 'Denkt nach';
        detail = 'gleich geht es los';
        busy = true;
      } else if (S.state === 'speaking') {
        title = 'Antwortet';
        detail = S.lastStep && S.lastStep.label ? 'Zuletzt: ' + S.lastStep.label : 'spricht';
      } else if (S.state === 'muted') {
        title = 'Mikrofon ist aus';
        detail = 'Schreiben geht weiterhin';
      } else if (S.lastStep && S.lastStep.label) {
        title = 'Zuletzt: ' + S.lastStep.label;
        detail = S.lastStep.state === 'error' ? 'hat nicht geklappt' : 'erledigt';
      }
      el.taskTitle.textContent = title;
      el.taskDetail.textContent = detail;
      el.task.dataset.busy = busy ? '1' : '0';
    }

    // ---------------------------------------------------------------- Kugel, Stimme, Sternenfeld

    const orbs = { zt: null };

    function startOrb() {
      const vis = () => visible();
      if (window.JarvisPlasma && el.orb) orbs.zt = window.JarvisPlasma.create(el.orb, { size: 'small', visible: vis });
      if (!orbs.zt && window.JarvisOrb && el.orb) orbs.zt = window.JarvisOrb.create(el.orb, { mode: 'hero', visible: vis });
      if (orbs.zt) orbs.zt.state(S.state);
    }

    function canvasSize(c, dprMax) {
      const dpr = Math.min(window.devicePixelRatio || 1, dprMax || 2);
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      return [w, h, dpr];
    }

    const stars = Array.from({ length: 70 }, () => ({
      x: Math.random(), y: Math.random(), r: 0.4 + Math.random() * 1.2, s: 0.4 + Math.random() * 1.6, p: Math.random() * 6.3,
    }));
    const bars = Array.from({ length: 34 }, (_, i) => ({ p: i * 0.6, v: 0 }));
    let animT = 0;

    function animate(now) {
      requestAnimationFrame(animate);
      if (!visible()) return;
      const t = now / 1000;
      const slow = reduced() ? 0 : 1;
      if (now - animT < 33) return; // 30 Bilder pro Sekunde reichen hier
      animT = now;
      if (el.stars && el.stars.clientWidth) {
        const [w, h, dpr] = canvasSize(el.stars, 1.5);
        const g = el.stars.getContext('2d');
        g.clearRect(0, 0, w, h);
        stars.forEach((s) => {
          const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * s.s * slow + s.p));
          const drift = Math.sin(t * 0.05 * slow + s.p) * 4 * dpr;
          g.fillStyle = 'rgba(170, 190, 255,' + a.toFixed(3) + ')';
          g.beginPath();
          g.arc(s.x * w + drift, s.y * h, s.r * dpr, 0, Math.PI * 2);
          g.fill();
        });
      }
      if (el.wave && el.wave.clientWidth) {
        const [w, h] = canvasSize(el.wave, 2);
        const g = el.wave.getContext('2d');
        g.clearRect(0, 0, w, h);
        const speaking = S.state === 'speaking' || S.state === 'listening';
        const gap = w / bars.length;
        const grad = g.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, 'rgba(79, 140, 255, 0.9)');
        grad.addColorStop(0.5, 'rgba(110, 200, 255, 1)');
        grad.addColorStop(1, 'rgba(79, 140, 255, 0.9)');
        g.fillStyle = grad;
        bars.forEach((b, i) => {
          const centre = 1 - Math.abs(i - bars.length / 2) / (bars.length / 2);
          const want = speaking
            ? (0.25 + 0.75 * S.level) * (0.35 + 0.65 * Math.abs(Math.sin(t * 7 * slow + b.p))) * (0.4 + 0.6 * centre)
            : 0.08 + 0.05 * Math.sin(t * 2 * slow + b.p);
          b.v += (want - b.v) * 0.35;
          const bh = Math.max(2, b.v * h);
          g.fillRect(i * gap + gap * 0.2, (h - bh) / 2, gap * 0.6, bh);
        });
      }
    }

    // ---------------------------------------------------------------- Bedienung

    el.tabs.forEach((t) => t.addEventListener('click', () => setHome(t.dataset.home)));
    el.tabs.forEach((t) => t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const other = el.tabs.find((x) => x !== t);
      if (other) {
        setHome(other.dataset.home);
        other.focus();
      }
    }));
    el.nav.forEach((n) => n.addEventListener('click', () => {
      const go = n.dataset.go;
      if (go === 'gespraech' || go === 'zentrale') setHome(go);
      else if (go === 'wissen') {
        const open = $('memOpenTop') || $('memOpen');
        if (open) open.click();
      } else if (go === 'einstellungen') {
        const setup = $('setupBtn');
        if (setup) setup.click();
      }
    }));
    el.briefing.addEventListener('click', () => {
      call('zentrale_briefing').then((ok) => {
        if (ok === false) toast('Die Kommandozentrale ist ausgeschaltet.', 'info');
      }).catch(() => toast('Jarvis ist gerade nicht verbunden.', 'error'));
    });
    el.refresh.addEventListener('click', () => {
      el.refresh.dataset.busy = '1';
      call('zentrale_refresh').then((ok) => {
        if (ok) toast('Jarvis sieht in Post, Kalender und Shop nach. Das dauert etwa eine Minute.', 'info');
        else {
          el.refresh.dataset.busy = '0';
          toast(S.data && S.data.lage && S.data.lage.laeuft ? 'Läuft schon.' : 'Dafür braucht Jarvis Claude Code mit Ihren Konnektoren.', 'info');
        }
      }).catch(() => {
        el.refresh.dataset.busy = '0';
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      });
    });
    el.chat.addEventListener('click', () => {
      setHome('gespraech');
      const input = $('cmdInput');
      if (input) setTimeout(() => input.focus(), 30);
    });
    el.listen.addEventListener('click', () => listenNow());
    el.orbBtn.addEventListener('click', () => listenNow());
    if (el.micPill) {
      el.micPill.addEventListener('click', () => {
        const btn = $('micBtn');
        if (btn) btn.click();
      });
    }

    if (window.ResizeObserver && el.timeline) {
      let pending = 0;
      new ResizeObserver(() => {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = 0;
          layoutTimeline();
        });
      }).observe(el.timeline);
    }
    if (window.ResizeObserver && el.feed) {
      let pending = 0;
      new ResizeObserver(() => {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = 0;
          fitFeed();
        });
      }).observe(el.feed);
    }
    document.addEventListener('visibilitychange', syncVideo);
    setInterval(syncVideo, 4000);

    // Fenster versteckt (Tray) oder wieder da: der Livestream läuft nur, wenn man ihn sieht
    const shownBefore = window.jarvisShown;
    window.jarvisHidden = () => {
      S.hidden = true;
      syncVideo();
    };
    window.jarvisShown = () => {
      S.hidden = false;
      if (typeof shownBefore === 'function') shownBefore();
      syncVideo();
    };

    let wanted = 'zentrale';
    try { wanted = localStorage.getItem(HOME_KEY) || 'zentrale'; } catch { /* egal */ }
    const asked = new URLSearchParams(location.search).get('home');
    if (asked) wanted = asked;
    setHome(wanted, false);
    tick();
    startOrb();
    requestAnimationFrame(animate);
    renderTask();

    return {
      load(data) {
        if (data) render(data);
      },
      handle(ev) {
        if (!ev || typeof ev !== 'object') return;
        if (ev.action === 'update') render(ev.data);
        else if (ev.action === 'focus') focus(ev);
        else if (ev.action === 'show') setHome('zentrale');
      },
      stats,
      state,
      level,
      muted,
      gaming,
      step,
      trailer,
      setHome,
      home,
      shown() {
        S.hidden = false;
        syncVideo();
      },
    };
  }

  // ------------------------------------------------------------------ Demo (?zentrale, ohne Python)

  function demoData() {
    const d = new Date();
    const hh = (h, m) => pad2(h) + ':' + pad2(m || 0);
    const nowStr = hh(d.getHours(), d.getMinutes());
    return {
      kopf: { ereignisse: 17, seit: '06:52', uhr: nowStr },
      aktivitaet: [
        { zeit: '07:12', art: 'konnektor', text: 'Posteingang gesichtet: 17 neue Mails', detail: '1 wichtig, 11 beantwortet' },
        { zeit: '07:05', art: 'lage', text: 'Lagebild aktualisiert', detail: '17 Mails, 3 Termine, 4 Bestellungen' },
        { zeit: '06:58', art: 'befehl', text: 'Öffnet Spotify', detail: '' },
        { zeit: '06:52', art: 'befehl', text: 'Seit 06:52 im Dienst', detail: 'Tag sortiert, Vormittag geplant' },
      ],
      erledigt: [
        { text: 'Posteingang gesichtet', ok: true }, { text: 'Kalender sortiert', ok: true },
        { text: 'Shop geprüft', ok: true }, { text: 'Briefing', ok: false }, { text: 'Termin vorbereitet', ok: true },
      ],
      wissen: { notizen: 412, fakten: 38 },
      konto: {
        titel: 'Shop · Demo-Laden', werte: [
          { name: 'Bestellungen heute', wert: '4' }, { name: 'Umsatz heute', wert: '312,50 €' },
          { name: 'Offen', wert: '2' }, { name: 'Gestern', wert: '840 €' }],
        zeilen: [{ name: 'Meta', wert: '61 €', trend: '4,6' }, { name: 'Google', wert: '42 €', trend: '3,3' },
          { name: 'TikTok', wert: '14 €', trend: '3,9' }],
      },
      kennzahlen: [
        { name: 'Umsatz heute', wert: '312,50 €', unter: 'gestern 840 €', gross: true },
        { name: 'Bestellungen heute', wert: '4', unter: 'gestern 9' },
        { name: 'Ø Warenkorb', wert: '78,12 €', unter: 'heute' },
        { name: 'Neue Mails', wert: '17', unter: '5 ungelesen' },
        { name: 'Rückfragen an Sie', wert: '1', unter: 'aktuell offen', warn: true },
      ],
      tagesplan: {
        eintraege: [
          { start: '09:00', ende: '10:00', titel: 'Gespräch Team', art: 'termin' },
          { start: '10:30', ende: '11:30', titel: 'Angebot prüfen', art: 'termin' },
          { start: '14:00', ende: '15:30', titel: 'Vertragsabschluss', art: 'termin', wichtig: true },
          { start: '17:30', ende: '18:00', titel: 'Paket abholen', art: 'erinnerung' },
        ], woche: 9, verbunden: true,
      },
      post: {
        verbunden: true, neu: 17, mails: [
          { von: 'Tobias L.', betreff: 'Budgetfreigabe Q4 – bis heute 12 Uhr', zeit: '07:03', status: 'wichtig', id: 'demo1' },
          { von: 'Katrin A.', betreff: 'Kooperationsanfrage Herbst', zeit: '06:41', status: 'beantwortet', id: 'demo2' },
          { von: 'Steuerkanzlei', betreff: 'Belege Q2 – drittes Quartal', zeit: '06:52', status: 'beantwortet', id: 'demo3' },
          { von: 'Nadine K.', betreff: 'Terminvorschlag Donnerstag', zeit: '06:58', status: 'offen', id: 'demo4' },
          { von: 'Adtech Vertrieb', betreff: 'Ihre Kampagnen auf Autopilot', zeit: 'gestern', status: 'werbung', id: 'demo5' },
        ],
      },
      nachrichten: {
        live: '', video: '', video_titel: '', video_bild: '',
        schlagzeilen: [
          { titel: 'Beispielmeldung: Hier laufen die Schlagzeilen der Tagesschau', oben: 'Demo', bild: '', link: '' },
          { titel: 'Im echten Jarvis läuft oben tagesschau24 live', oben: 'Nachrichten', bild: '', link: '' },
        ],
      },
      agenten: [
        { id: 'post', name: 'Posteingang', kuerzel: 'PO', farbe: '#4f8cff', status: 'wartet', text: '17 neue Mails · 1 wichtig', zeit: '07:12', fortschritt: 1 },
        { id: 'kalender', name: 'Kalender', kuerzel: 'KA', farbe: '#c86bff', status: 'fertig', text: '3 Termine heute · 9 diese Woche', zeit: '07:12', fortschritt: 1 },
        { id: 'shop', name: 'Shop', kuerzel: 'SH', farbe: '#ff9f43', status: 'fertig', text: '4 Bestellungen heute · 2 offen', zeit: '07:12', fortschritt: 1 },
        { id: 'recherche', name: 'Recherche', kuerzel: 'RE', farbe: '#5ad1ff', status: 'arbeitet', text: 'Vergleicht Preise für Monitore', zeit: '07:14', fortschritt: null },
        { id: 'texte', name: 'Texte', kuerzel: 'TX', farbe: '#ff6bb5', status: 'schreibt', text: 'Antwort an Nadine: Donnerstag passt', zeit: '07:14', fortschritt: null },
        { id: 'technik', name: 'Technik', kuerzel: 'TE', farbe: '#3ddc84', status: 'bereit', text: 'Wacht über den Rechner', zeit: '', fortschritt: null },
      ],
      notizen: ['Hook: Vorher/Nachher in 3 Sekunden', 'Budget ab Q4 klären', 'Belege Q2 an die Kanzlei'],
      hinweise: ['Die Budgetfreigabe braucht heute bis 12 Uhr Ihre Antwort.'],
      lage: { zeit: '07:05', alter: 10, laeuft: false, fehler: '', moeglich: true },
    };
  }

  // Das Briefing im Demo-Modus: dieselben Ereignisse, wie zentrale.py sie schickt
  const DEMO_BRIEFING = [
    { bereich: 'kopf', text: 'Guten Morgen, Sir. Ich bin seit 6:52 Uhr im Dienst.', titel: 'Seit 06:52 im Dienst', detail: 'Heute 9 bis 18 Grad, leicht bewölkt', zeit: '06:52' },
    { bereich: 'post', text: 'Beginnen wir mit Ihren Mails. Seit gestern sind 17 neue Nachrichten eingegangen. Und eine sollten Sie sich tatsächlich ansehen.', titel: 'Eine Mail sollten Sie ansehen', detail: 'Tobias L. · Budgetfreigabe Q4 – bis heute 12 Uhr', zeit: '07:03', ziel: 'demo1' },
    { bereich: 'kennzahlen', text: 'Kommen wir zum Shop. Heute 4 Bestellungen mit 312,50 € Umsatz.', titel: 'Shop: 4 Bestellungen heute', detail: 'Umsatz 312,50 €', ziel: 'shop' },
    { bereich: 'tagesplan', text: 'Dann noch ein Blick in Ihren Kalender. Der wichtigste um 14 Uhr: Vertragsabschluss.', titel: 'Vertragsabschluss', detail: 'Der wichtigste Termin des Tages.', zeit: '14:00', ziel: '14:00 Vertragsabschluss' },
    { bereich: 'orb', text: 'Das wäre alles für den Moment, Sir. Was kann ich für Sie tun?' },
  ];

  // So sieht es direkt nach dem ersten Start aus: noch kein Lagebild, nichts erledigt (?leer)
  function firstStartData() {
    const d = demoData();
    return Object.assign(d, {
      kopf: { ereignisse: 0, seit: d.kopf.seit, uhr: d.kopf.uhr },
      aktivitaet: [],
      erledigt: [{ text: 'Posteingang gesichtet', ok: false }, { text: 'Kalender sortiert', ok: false }, { text: 'Briefing', ok: false }],
      wissen: { notizen: 0, fakten: 0 },
      konto: null,
      kennzahlen: [
        { name: 'Heute erledigt', wert: '0', unter: 'seit 06:52 Uhr', gross: true },
        { name: 'Erinnerungen heute', wert: '0', unter: 'noch offen' },
        { name: 'Gesprochen', wert: '0', unter: 'Befehle heute' },
        { name: 'Rückfragen an Sie', wert: '0', unter: 'aktuell offen', warn: false },
      ],
      tagesplan: { eintraege: [], woche: 0, verbunden: false },
      post: { verbunden: false, neu: null, mails: [] },
      nachrichten: { live: '', video: '', video_titel: '', video_bild: '', schlagzeilen: [] },
      agenten: d.agenten.filter((a) => a.id !== 'shop').map((a) => Object.assign({}, a, {
        status: 'bereit', zeit: '', fortschritt: null,
        text: { post: 'Sichtet Ihre Mails', kalender: 'Hält Ihren Tag im Blick', recherche: 'Bereit für Ihre Fragen',
          texte: 'Schreibt Mails und Posts', technik: 'Wacht über den Rechner' }[a.id] || '',
      })),
      notizen: [],
      hinweise: [],
      lage: { zeit: '', alter: null, laeuft: true, fehler: '', moeglich: true },
    });
  }

  function demo(push) {
    const data = /[?&]leer\b/.test(location.search) ? firstStartData() : demoData();
    let briefRun = 0;
    function briefing() {
      briefRun += 1;
      const run = briefRun;
      push({ type: 'zentrale', action: 'show' });
      DEMO_BRIEFING.forEach((part, i) => {
        setTimeout(() => {
          if (run !== briefRun) return;
          push({ type: 'zentrale', action: 'focus', bereich: part.bereich, titel: part.titel || '', detail: part.detail || '', zeit: part.zeit || '', ziel: part.ziel || '' });
          push({ type: 'message', role: 'jarvis', text: part.text });
          push({ type: 'state', value: 'speaking' });
        }, i * 3200);
      });
      setTimeout(() => {
        if (run !== briefRun) return;
        push({ type: 'zentrale', action: 'focus', bereich: '' });
        push({ type: 'state', value: 'idle' });
      }, DEMO_BRIEFING.length * 3200);
      return true;
    }
    return {
      data,
      briefing,
      api: {
        zentrale_state: () => data,
        zentrale_refresh: () => {
          data.lage = Object.assign({}, data.lage, { laeuft: true });
          push({ type: 'zentrale', action: 'update', data });
          setTimeout(() => {
            data.lage = Object.assign({}, data.lage, { laeuft: false, alter: 0 });
            push({ type: 'zentrale', action: 'update', data });
          }, 2500);
          return true;
        },
        zentrale_briefing: () => briefing(),
        zentrale_stop: () => {
          briefRun += 1;
          push({ type: 'zentrale', action: 'focus', bereich: '' });
          return true;
        },
        zentrale_open: () => true,
      },
      focusOnly(index) {
        const part = DEMO_BRIEFING[clamp(index, 0, DEMO_BRIEFING.length - 1)];
        push({ type: 'zentrale', action: 'focus', bereich: part.bereich, titel: part.titel || '', detail: part.detail || '', zeit: part.zeit || '', ziel: part.ziel || '' });
      },
    };
  }

  window.JarvisZentrale = { create, demo, demoData };
})();
