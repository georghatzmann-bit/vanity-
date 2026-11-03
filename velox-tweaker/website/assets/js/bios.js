/* VELOX BIOS checklist - the phone page behind the QR code of the BIOS-Optimierer.
 *
 * Link format v1 (docs/ARCHITECTURE.md, "BIOS checklist link format"):
 *   bios.html#v=1&p=<vendor>&c=<amd|intel|other>&s=<code><o|t|u>.<code><status>...
 *             [&w=<warning codes>][&g=<game codes>][&b=<board>][&i=<bios version>][&d=YYYYMMDD]
 * Everything about the PC lives in the fragment, which browsers never send to a server.
 * This script reads it locally and never sends it anywhere: the only request it makes is
 * for the static texts (assets/data/bios/recommendations.json, a copy of
 * data/bios/recommendations.json), and that URL never contains the fragment.
 * All texts are rendered with textContent. Ticks live in localStorage only. */
(function () {
  'use strict';
  var DATA_URL = 'assets/data/bios/recommendations.json';
  var STORE_PREFIX = 'velox.bios.';
  var STORE_MAX = 20;
  var VENDORS = ['asus', 'msi', 'gigabyte', 'asrock', 'generic'];
  var CPUS = { amd: 'AMD', intel: 'Intel', other: 'Andere' };
  var NEED_NAMES = { secureBoot: 'Secure Boot', tpm: 'TPM 2.0', vbs: 'VBS', uefi: 'UEFI' };
  var SEVERITY = { bad: ['Wichtig', 'i-alert'], warn: ['Achtung', 'i-alert'], info: ['Hinweis', 'i-info'] };
  var STATUS_ICON = { o: 'i-ok', t: 'i-todo', u: 'i-unknown' };

  var doc = document;
  var $ = function (id) { return doc.getElementById(id); };
  var data = null;          // recommendations.json
  var state = null;         // parsed link
  var done = {};            // code -> true (ticked on this phone)
  var storeKey = '';

  // ------------------------------------------------------------ small helpers
  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(id, extra) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon icon-sm' + (extra ? ' ' + extra : ''));
    svg.setAttribute('aria-hidden', 'true');
    var use = doc.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }
  function show(id) {
    ['bios-loading', 'bios-empty', 'bios-error', 'bios-app'].forEach(function (x) { $(x).hidden = x !== id; });
  }
  function listOf(v) { return (v || '').split('.').map(function (s) { return s.trim(); }).filter(Boolean); }
  function joinDe(names) {
    if (names.length < 2) return names.join('');
    return names.slice(0, -1).join(', ') + ' und ' + names[names.length - 1];
  }
  function hash(str) {          // djb2, only to name the storage slot of this link
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // ------------------------------------------------------------ the link
  function parse(raw) {
    var q;
    try { q = new URLSearchParams(raw); } catch (e) { return null; }
    var p = (q.get('p') || '').toLowerCase();
    var c = (q.get('c') || '').toLowerCase();
    var items = [];
    listOf(q.get('s')).forEach(function (entry) {
      var status = entry.slice(-1), code = entry.slice(0, -1);
      if (code && (status === 'o' || status === 't' || status === 'u')) items.push({ code: code, status: status });
    });
    var d = (q.get('d') || '').trim();
    return {
      v: q.get('v'),
      p: VENDORS.indexOf(p) >= 0 ? p : 'generic',
      c: CPUS[c] ? c : 'other',
      items: items,
      warnings: listOf(q.get('w')),
      games: listOf(q.get('g')),
      board: (q.get('b') || '').trim().slice(0, 48),
      bios: (q.get('i') || '').trim().slice(0, 24),
      date: /^\d{8}$/.test(d) ? d.slice(6, 8) + '.' + d.slice(4, 6) + '.' + d.slice(0, 4) : '',
    };
  }

  // ------------------------------------------------------------ storage (this phone only)
  function loadTicks() {
    done = {};
    try {
      var raw = localStorage.getItem(storeKey);
      var obj = raw ? JSON.parse(raw) : null;
      if (obj && Array.isArray(obj.done)) obj.done.forEach(function (code) { done[code] = true; });
    } catch (e) { /* storage blocked or broken: start empty */ }
  }
  function saveTicks() {
    try {
      localStorage.setItem(storeKey, JSON.stringify({ t: Date.now(), done: Object.keys(done) }));
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(STORE_PREFIX) === 0) {
          var t = 0;
          try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch (e) { /* ignore */ }
          keys.push([k, t]);
        }
      }
      keys.sort(function (a, b) { return b[1] - a[1]; });
      keys.slice(STORE_MAX).forEach(function (kt) { localStorage.removeItem(kt[0]); });
    } catch (e) { /* storage blocked: ticks just do not survive a reload */ }
  }

  // ------------------------------------------------------------ texts from the JSON
  function stepsFor(item) {
    var st = item.steps || {};
    var list = st[state.p] || st.generic;
    if (list && !Array.isArray(list)) {
      var gen = st.generic;
      list = list[state.c] || list.any || (gen && !Array.isArray(gen) ? (gen[state.c] || gen.any) : gen);
    }
    return Array.isArray(list) ? list : [];
  }
  function gamesFor(feature) {
    if (!feature || !data.games) return [];
    return data.games.filter(function (g) {
      return state.games.indexOf(g.code) >= 0 && Array.isArray(g.needs) && g.needs.indexOf(feature) >= 0;
    }).map(function (g) { return g.name; });
  }

  // ------------------------------------------------------------ render
  function renderItem(item, entry) {
    var li = el('li', 'item');
    li.setAttribute('data-status', entry.status);
    li.setAttribute('data-code', entry.code);
    var id = 'item-' + entry.code.replace(/[^a-z0-9]/gi, '');
    var label = data.statusLabels && data.statusLabels[entry.status] || entry.status;

    var head = el('div', 'item-head');
    if (entry.status === 'o') {
      var okMark = el('span', 'ok-mark');
      okMark.appendChild(icon('i-check'));
      head.appendChild(okMark);
      head.appendChild(el('h3', 'item-title', item.title));
    } else {
      var lab = el('label', 'tick');
      var input = el('input');
      input.type = 'checkbox';
      input.className = 'tick-input';
      input.checked = !!done[entry.code];
      input.setAttribute('aria-describedby', id + '-status');
      var box = el('span', 'tick-box');
      box.setAttribute('aria-hidden', 'true');
      box.appendChild(icon('i-check'));
      lab.appendChild(input);
      lab.appendChild(box);
      lab.appendChild(el('span', 'item-title', item.title));
      input.addEventListener('change', function () {
        if (input.checked) done[entry.code] = true; else delete done[entry.code];
        li.classList.toggle('is-done', input.checked);
        saveTicks();
        updateProgress();
      });
      head.appendChild(lab);
      li.classList.toggle('is-done', input.checked);
    }
    li.appendChild(head);

    var chips = el('div', 'chips');
    var st = el('span', 'status status-' + entry.status);
    st.id = id + '-status';
    st.appendChild(icon(STATUS_ICON[entry.status]));
    st.appendChild(doc.createTextNode(label));
    chips.appendChild(st);
    if (item.risk && data.riskLabels && data.riskLabels[item.risk]) {
      var rk = el('span', 'risk ' + (item.risk === 'safe' ? 'risk-safe' : 'risk-mid'));
      rk.appendChild(icon(item.risk === 'safe' ? 'i-shield' : 'i-info'));
      rk.appendChild(doc.createTextNode(data.riskLabels[item.risk]));
      chips.appendChild(rk);
    }
    li.appendChild(chips);

    if (item.why) li.appendChild(el('p', 'why', item.why));
    var forGames = gamesFor(item.feature);
    if (forGames.length) {
      var fg = el('p', 'for-games');
      fg.appendChild(icon('i-shield'));
      fg.appendChild(el('span', '', 'Wichtig für ' + joinDe(forGames)));
      li.appendChild(fg);
    }

    var steps = stepsFor(item);
    if (steps.length || item.info) {
      var open = entry.status !== 'o';
      var btn = el('button', 'steps-toggle');
      btn.type = 'button';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-controls', id + '-steps');
      btn.appendChild(el('span', '', steps.length ? 'So geht’s · ' + steps.length + (steps.length === 1 ? ' Schritt' : ' Schritte') : 'Mehr dazu'));
      btn.appendChild(icon('i-chevron', 'chev'));
      var box2 = el('div', 'steps-box');
      box2.id = id + '-steps';
      box2.hidden = !open;
      if (steps.length) {
        var ol = el('ol', 'steps-list');
        steps.forEach(function (s) { ol.appendChild(el('li', '', s)); });
        box2.appendChild(ol);
        var verified = Array.isArray(item.verified) && item.verified.indexOf(state.p) >= 0;
        if (!verified && data.general && data.general.pathNote) box2.appendChild(el('p', 'path-note', data.general.pathNote));
      }
      if (item.info) {
        var info = el('p', 'info');
        info.appendChild(el('strong', '', 'Gut zu wissen: '));
        info.appendChild(doc.createTextNode(item.info));
        box2.appendChild(info);
      }
      btn.addEventListener('click', function () {
        var nowOpen = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        box2.hidden = !nowOpen;
      });
      li.appendChild(btn);
      li.appendChild(box2);
    }
    return li;
  }

  var coreEntries = [];
  function updateProgress() {
    var total = coreEntries.length, finished = 0;
    coreEntries.forEach(function (e) { if (e.status === 'o' || done[e.code]) finished++; });
    var pct = total ? Math.round(finished / total * 100) : 0;
    $('tick-count').textContent = finished + ' / ' + total + ' erledigt';
    $('tick-fill').classList.toggle('is-full', pct >= 100);
    $('tick-fill').setAttribute('data-pct', String(pct));
    $('tick-fill').style.transform = 'scaleX(' + (pct / 100) + ')';
    $('tick-bar').setAttribute('aria-valuenow', String(pct));
    $('tick-bar').setAttribute('aria-valuetext', finished + ' von ' + total + ' erledigt');
  }

  function render() {
    var vendor = data.vendors && (data.vendors[state.p] || data.vendors.generic) || {};
    $('version-banner').hidden = state.v === '1';
    // non-breaking hyphens: "B550-F" stays on one line
    $('pc-board').textContent = (state.board || 'Dein Mainboard').replace(/-/g, '\u2011');
    if (state.bios || state.date) {
      $('pc-bios-row').hidden = false;
      $('pc-bios').textContent = [state.bios, state.date].filter(Boolean).join(' · ');
    } else {
      $('pc-bios-row').hidden = true;
    }
    $('pc-vendor').textContent = state.p === 'generic' ? 'nicht erkannt – allgemeine Anleitung' : (vendor.name || state.p);
    $('pc-cpu').textContent = CPUS[state.c];
    $('vendor-key').textContent = vendor.biosKey || '';
    $('vendor-advanced').textContent = vendor.advanced || '';
    $('vendor-save').textContent = vendor.save || '';
    $('general-intro').textContent = data.general && data.general.intro || '';
    $('save-note').textContent = [data.general && data.general.saveNote, vendor.help].filter(Boolean).join(' ');

    // games that need Secure Boot / TPM / VBS
    var gl = $('games-line');
    var games = (data.games || []).filter(function (g) { return state.games.indexOf(g.code) >= 0; });
    if (games.length) {
      var needs = [];
      games.forEach(function (g) { (g.needs || []).forEach(function (n) { if (NEED_NAMES[n] && needs.indexOf(NEED_NAMES[n]) < 0) needs.push(NEED_NAMES[n]); }); });
      gl.lastElementChild.textContent = 'Wichtig für ' + joinDe(games.map(function (g) { return g.name; })) +
        (needs.length ? ' – ' + (games.length > 1 ? 'die brauchen ' : 'braucht ') + joinDe(needs) + '.' : '.');
      gl.hidden = false;
    } else {
      gl.hidden = true;
    }

    // the lists, in the order of the link
    var byCode = {};
    (data.items || []).forEach(function (it) { if (it && it.code) byCode[it.code] = it; });
    var core = $('core-list'), opt = $('optional-list');
    core.textContent = ''; opt.textContent = '';
    coreEntries = [];
    var okCount = 0, optCount = 0, seen = {};
    state.items.forEach(function (entry) {
      var item = byCode[entry.code];
      if (!item || seen[entry.code]) return;            // unknown codes are skipped (newer app)
      seen[entry.code] = true;
      if (item.section === 'optional') { opt.appendChild(renderItem(item, entry)); optCount++; return; }
      core.appendChild(renderItem(item, entry));
      coreEntries.push(entry);
      if (entry.status === 'o') okCount++;
    });
    if (!coreEntries.length) {
      var empty = el('li', 'item item-empty');
      empty.appendChild(el('p', '', 'Für deinen PC gibt es in der Checkliste gerade nichts zu tun.'));
      core.appendChild(empty);
    }
    $('optional').hidden = optCount === 0;
    $('ok-count').textContent = okCount + ' von ' + coreEntries.length;

    // warnings
    var wl = $('warning-list');
    wl.textContent = '';
    var byW = {};
    (data.warnings || []).forEach(function (w) { if (w && w.code) byW[w.code] = w; });
    var wCount = 0;
    state.warnings.forEach(function (code) {
      var w = byW[code];
      if (!w) return;
      var sev = SEVERITY[w.severity] || SEVERITY.info;
      var li = el('li', 'warning warning-' + (SEVERITY[w.severity] ? w.severity : 'info'));
      var top = el('p', 'warning-top');
      var tag = el('span', 'warning-tag');
      tag.appendChild(icon(sev[1]));
      tag.appendChild(doc.createTextNode(sev[0]));
      top.appendChild(tag);
      li.appendChild(top);
      li.appendChild(el('h3', '', w.title));
      li.appendChild(el('p', '', w.text));
      if (w.id === 'bitlocker' && data.general && /^https:\/\//.test(data.general.recoveryUrl || '')) {
        var p = el('p', 'warning-link');
        var a = el('a', '', 'Wiederherstellungsschlüssel finden');
        a.href = data.general.recoveryUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        p.appendChild(a);
        li.appendChild(p);
      }
      wl.appendChild(li);
      wCount++;
    });
    $('warnings').hidden = wCount === 0;
    var jump = $('warn-jump');
    jump.hidden = wCount === 0;
    jump.querySelector('span').textContent = wCount === 1 ? 'Erst lesen: 1 Hinweis zu deinem PC' : 'Erst lesen: ' + wCount + ' Hinweise zu deinem PC';

    updateProgress();
    doc.title = (state.board ? state.board + ' – ' : '') + 'BIOS-Checkliste – VELOX';
    show('bios-app');
  }

  // ------------------------------------------------------------ keep the screen on (Wake Lock API)
  var wakeLock = null, wantWake = true;
  var wakeBtn = $('wake-btn'), wakeHint = $('wake-hint');
  function wakeUi() {
    if (!wakeBtn) return;
    var on = !!wakeLock;
    wakeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    wakeBtn.querySelector('[data-label]').textContent = on ? 'Bildschirm bleibt an' : 'Bildschirm anlassen';
  }
  function requestWake() {
    if (!('wakeLock' in navigator) || !wantWake || doc.visibilityState !== 'visible' || wakeLock) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      wakeHint.textContent = 'Dein Bildschirm bleibt an, solange diese Seite offen ist.';
      lock.addEventListener('release', function () { wakeLock = null; wakeUi(); });
      wakeUi();
    }).catch(function () {
      wakeLock = null;
      wakeHint.textContent = 'Dein Handy hat das Anlassen gerade abgelehnt (zum Beispiel im Stromsparmodus).';
      wakeUi();
    });
  }
  function initWake() {
    if (!('wakeLock' in navigator)) {
      wakeHint.textContent = 'Tipp: Stell die automatische Bildschirmsperre deines Handys für die Zeit im BIOS länger ein.';
      return;
    }
    wakeBtn.hidden = false;
    wakeUi();
    wakeBtn.addEventListener('click', function () {
      if (wakeLock) {
        wantWake = false;
        wakeLock.release().catch(function () { /* already released */ });
        wakeLock = null;
        wakeHint.textContent = 'Der Bildschirm darf wieder ausgehen.';
        wakeUi();
      } else {
        wantWake = true;
        requestWake();
      }
    });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') requestWake(); });
    requestWake();
  }

  // ------------------------------------------------------------ start
  function load() {
    return fetch(DATA_URL, { cache: 'no-cache', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function route() {
    var raw = location.hash.replace(/^#/, '');
    state = raw ? parse(raw) : null;
    if (!state || (!state.v && !state.items.length)) { show('bios-empty'); return; }
    storeKey = STORE_PREFIX + hash(raw);
    loadTicks();
    render();
  }
  function start() {
    show('bios-loading');
    load().then(function (json) {
      if (!json || !Array.isArray(json.items)) throw new Error('unexpected data');
      data = json;
      route();
    }).catch(function () {
      if (location.protocol === 'file:') $('bios-error-text').textContent = 'Diese Seite muss über eine Web-Adresse geöffnet werden (nicht als Datei). Öffne sie über den QR-Code in VELOX.';
      show('bios-error');
    });
  }

  $('bios-retry').addEventListener('click', start);
  $('reset-btn').addEventListener('click', function () {
    done = {};
    try { localStorage.removeItem(storeKey); } catch (e) { /* storage blocked */ }
    if (state && data) render();
  });
  window.addEventListener('hashchange', function () { if (data) { route(); window.scrollTo(0, 0); } });
  initWake();
  start();

  // offline: once loaded, the page and its texts are cached by sw.js (only on https or localhost)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* offline cache is a bonus */ }); });
  }
})();
