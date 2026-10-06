// Spiele: the game library - every detected game as a card with its real art (cover from the
// launcher, else the game's icon, else gradient initials), launcher filter chips + search, three
// boost switches per game, add by file dialog or path, plus the "games" category tweaks.
// Art: GET /api/game-art/<id>?kind=cover|icon&v=<v>&t=<token> (core/Server.ps1) - requested only
// when games-detect said that image exists (game.art.cover / game.art.icon).
import { icon } from '../icons.js';
import { h, clear, button, toggle, avatar, emptyState, stagger, toast, append, plural, countUp, radioKeys } from '../ui.js';
import { renderList } from '../tweakrow.js';

// launcher id -> label + a small colour dot (text badges only, no launcher logos)
const SOURCES = {
  steam: { label: 'Steam', dot: '#66C0F4' }, epic: { label: 'Epic Games', dot: '#D9DEE7' }, gog: { label: 'GOG', dot: '#B98CFF' },
  ubisoft: { label: 'Ubisoft', dot: '#3D8BFF' }, ea: { label: 'EA', dot: '#FF5A5F' }, battlenet: { label: 'Battle.net', dot: '#36A3FF' },
  riot: { label: 'Riot', dot: '#FF5864' }, xbox: { label: 'Xbox', dot: '#5DC21E' }, rockstar: { label: 'Rockstar', dot: '#FCAF17' },
  fivem: { label: 'FiveM & Co.', dot: '#F7567C' }, minecraft: { label: 'Minecraft', dot: '#7BC24F' }, roblox: { label: 'Roblox', dot: '#E8EAF0' },
  other: { label: 'Weitere', dot: '#9AA3B2' }, manual: { label: 'Manuell', dot: '#9AA3B2' }
};
const ORDER = Object.keys(SOURCES);
// older backends sent source "running" for a game found only as a running process
const srcKey = (s) => { const k = String(s || '').toLowerCase(); return k === 'manuell' ? 'manual' : k === 'running' ? 'other' : (k || 'other'); };
const sourceInfo = (s) => SOURCES[srcKey(s)] || { label: String(s), dot: '#9AA3B2' };

const BOOSTS = [
  { key: 'priority', label: 'Hohe CPU-Priorität', desc: 'Vorrang vor Hintergrund-Programmen', icon: 'cpu' },
  { key: 'gpu', label: 'Grafikkarte: Höchstleistung', desc: 'Immer die schnellste Grafikkarte nutzen', icon: 'gpu' },
  { key: 'fso', label: 'Vollbild-Optimierung aus', desc: 'Echtes Vollbild, weniger Verzögerung', icon: 'monitor' }
];

// filter + search survive page changes (per window)
const view = { q: '', src: 'all' };

// <img> cannot send the X-Velox-Token header; the art endpoint takes the token as ?t= instead.
function token() { try { return sessionStorage.getItem('velox.token') || ''; } catch { return ''; } }
function artUrl(g, kind) {
  const t = token();
  if (!t || !g.id) return null;
  return '/api/game-art/' + encodeURIComponent(g.id) + '?kind=' + kind + '&v=' + encodeURIComponent((g.art && g.art.v) || '') + '&t=' + encodeURIComponent(t);
}
function initials(name) {
  return String(name).replace(/[^A-Za-z0-9ÄÖÜäöü ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** <img> that tells its banner/slot when it loaded or failed. */
function img(src, cls, onLoad, onError) {
  const el = h('img', { class: cls, alt: '', decoding: 'async', loading: 'lazy', attrs: { draggable: 'false' } });
  el.addEventListener('load', () => onLoad && onLoad(el), { once: true });
  el.addEventListener('error', () => onError && onError(el), { once: true });
  el.src = src;
  return el;
}

/**
 * Banner of a card: cover art (wide header, or a tall capsule as poster on its own blurred copy),
 * else the game icon big and blurred, else a gradient with the initials. Shimmer while loading;
 * a failed image falls back one step.
 */
function banner(g, coverUrl, iconUrl) {
  const el = h('div', { class: 'gc-art', 'aria-hidden': 'true' },
    h('div', { class: 'gc-fallback' }, h('span', { class: 'gc-initials', text: initials(g.name) }), h('span', { class: 'gc-title', text: g.name })));
  const done = () => { el.classList.remove('is-loading'); el.classList.add('is-loaded'); };
  const iconStage = () => {
    if (!iconUrl) { el.dataset.art = 'none'; done(); return; }
    el.dataset.art = 'icon';
    el.classList.add('is-loading');
    const glow = img(iconUrl, 'gc-icon-glow', null, null);
    const big = img(iconUrl, 'gc-icon-big', done, () => { glow.remove(); big.remove(); el.dataset.art = 'none'; done(); });
    el.append(glow, big);
  };
  if (coverUrl) {
    el.dataset.art = 'cover';
    el.classList.add('is-loading');
    const tall = g.art && g.art.shape === 'tall';
    el.classList.toggle('is-tall', tall);
    const parts = [];
    const fail = () => { for (const p of parts) p.remove(); el.classList.remove('is-tall'); iconStage(); };
    if (tall) parts.push(img(coverUrl, 'gc-cover-blur', null, null));
    parts.push(img(coverUrl, tall ? 'gc-poster' : 'gc-cover', done, fail));
    el.append(...parts);
  } else iconStage();
  el.appendChild(h('div', { class: 'gc-shade' }));
  return el;
}

/** Small icon next to the name: the game icon, or the gradient avatar when there is none. */
function iconSlot(g, iconUrl) {
  const slot = h('div', { class: 'gc-icon' });
  if (!iconUrl) { slot.appendChild(avatar(g.name, 48)); slot.classList.add('is-avatar'); return slot; }
  slot.classList.add('is-loading');
  slot.appendChild(img(iconUrl, 'gc-icon-img', () => slot.classList.remove('is-loading'), (el) => {
    el.remove(); slot.classList.remove('is-loading'); slot.classList.add('is-avatar'); slot.appendChild(avatar(g.name, 48));
  }));
  return slot;
}

export default {
  id: 'games', title: 'Spiele', icon: 'gamepad', desc: 'Jedes Spiel einzeln boosten', keywords: 'games fivem gta booster priorität steam epic xbox',
  mount(el, ctx) {
    const grid = h('div', { class: 'game-grid', 'data-testid': 'game-grid' });
    const detectBtn = button({ label: 'Spiele erkennen', icon: 'search', variant: 'secondary', onClick: () => detect(true), attrs: { 'data-testid': 'game-detect' } });
    const pickBtn = button({ label: 'Spiel hinzufügen', icon: 'plus', variant: 'primary', onClick: () => pick() });
    const pathInput = h('input', { class: 'input mono', type: 'text', placeholder: 'C:\\Spiele\\MeinSpiel\\spiel.exe', 'aria-label': 'Pfad zur .exe-Datei', spellcheck: 'false', 'data-testid': 'game-path' });
    const addBtn = button({ label: 'Hinzufügen', icon: 'plus', variant: 'secondary', onClick: () => addPath(pathInput.value) });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPath(pathInput.value); });
    const tweakList = h('div', { class: 'tw-list' });

    // found-games counter (counts up after every detection)
    const countNum = h('span', { class: 'games-stat-num', text: '–' });
    const countLabel = h('span', { class: 'games-stat-label', text: 'Spiele gefunden' });
    const countSub = h('span', { class: 'games-stat-sub', text: '' });
    const stat = h('div', { class: 'games-stat', 'data-testid': 'games-count', 'aria-live': 'polite' }, countNum, h('div', { class: 'games-stat-text' }, countLabel, countSub));

    // search + launcher chips
    const search = h('input', { class: 'search-input', type: 'search', placeholder: 'Spiel suchen …', 'aria-label': 'Spiele durchsuchen', value: view.q, 'data-testid': 'game-search', spellcheck: 'false' });
    const clearBtn = h('button', { class: 'icon-btn search-clear', type: 'button', 'aria-label': 'Suche leeren', hidden: !view.q }, icon('x', 15));
    let deb = 0;
    search.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { view.q = search.value.trim(); clearBtn.hidden = !view.q; applyFilter(); }, 90); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); clearBtn.click(); } });
    clearBtn.addEventListener('click', () => { search.value = ''; view.q = ''; clearBtn.hidden = true; applyFilter(); search.focus(); });
    const chips = h('div', { class: 'chip-row games-chips', role: 'radiogroup', 'aria-label': 'Nach Launcher filtern', 'data-testid': 'game-filter' });
    radioKeys(chips, (b) => setSource(b.dataset.src));
    const toolbar = h('div', { class: 'games-toolbar', hidden: true }, h('div', { class: 'search games-search' }, icon('search', 17), search, clearBtn), chips);
    const noMatch = h('div', { class: 'card pad-24 games-nomatch', hidden: true });

    append(el,
      h('section', { class: 'card pad-24 games-head' },
        h('div', { class: 'games-head-text' }, h('h2', { class: 'section-title', text: 'Deine Spiele' }),
          h('p', { class: 'section-desc', text: 'VELOX findet Spiele aus Steam, Epic, GOG, Ubisoft, EA, Battle.net, Riot, Xbox/Game Pass, Rockstar, FiveM, Minecraft und Roblox. Jeder Schalter wirkt sofort und nur für dieses Spiel.' })),
        stat,
        h('div', { class: 'games-head-actions' }, detectBtn, pickBtn),
        h('div', { class: 'path-row' }, h('div', { class: 'field-label', text: 'Oder Pfad zur .exe eingeben' }), h('div', { class: 'path-input' }, icon('file', 16), pathInput, addBtn))),
      toolbar,
      grid,
      noMatch,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Spiele-Tweaks' }), h('p', { class: 'section-desc', text: 'Feinschliff für bestimmte Spiele. Wird wie alle Tweaks vorgemerkt und mit „Anwenden“ übernommen.' }))),
      tweakList);

    function sorted(list) {
      const boosted = (g) => BOOSTS.some(b => g.boost && g.boost[b.key]);
      return list.slice().sort((a, b) => (boosted(b) - boosted(a)) || String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' }));
    }

    function setCount(n, animate) {
      const sources = new Set((ctx.cache.games || []).map(g => srcKey(g.source)));
      countLabel.textContent = n === 1 ? 'Spiel gefunden' : 'Spiele gefunden';
      countSub.textContent = n ? 'aus ' + plural(sources.size, 'Quelle', 'Quellen') : 'Noch nichts gefunden';
      if (animate) countUp(countNum, n, { from: Number(countNum.dataset.value || 0), duration: 900 });
      else { countNum.textContent = String(n); countNum.dataset.value = String(n); }
    }

    function buildChips() {
      clear(chips);
      const games = ctx.cache.games || [];
      const counts = new Map();
      for (const g of games) counts.set(srcKey(g.source), (counts.get(srcKey(g.source)) || 0) + 1);
      if (view.src !== 'all' && !counts.has(view.src)) view.src = 'all';
      const keys = Array.from(counts.keys()).sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
      const chip = (key, label, n, dot) => h('button', { class: 'chip games-chip', type: 'button', role: 'radio', 'aria-checked': String(view.src === key), 'data-src': key, onClick: () => setSource(key) },
        dot ? h('span', { class: 'gc-dot', style: { '--dot': dot } }) : null, h('span', { text: label }), h('span', { class: 'games-chip-n', text: String(n) }));
      chips.appendChild(chip('all', 'Alle', games.length, null));
      for (const k of keys) chips.appendChild(chip(k, sourceInfo(k).label, counts.get(k), sourceInfo(k).dot));
      chips.syncRadios();
      toolbar.hidden = games.length < 2;
    }
    function setSource(key) {
      view.src = key;
      for (const c of chips.querySelectorAll('[role="radio"]')) c.setAttribute('aria-checked', String(c.dataset.src === key));
      chips.syncRadios();
      applyFilter();
    }

    function applyFilter() {
      const q = norm(view.q);
      let shown = 0;
      for (const card of grid.querySelectorAll('.game-card[data-game]')) {
        const okSrc = view.src === 'all' || card.dataset.source === view.src;
        const okQ = !q || card.dataset.search.includes(q);
        card.hidden = !(okSrc && okQ);
        if (!card.hidden) shown++;
      }
      const games = ctx.cache.games || [];
      const filtering = games.length > 0 && (q || view.src !== 'all');
      noMatch.hidden = !(filtering && shown === 0);
      if (!noMatch.hidden) {
        clear(noMatch).appendChild(emptyState({ icon: 'search', title: 'Kein Spiel passt', text: q ? 'Nichts gefunden für „' + view.q + '“.' : 'Für diesen Launcher ist nichts da.',
          action: button({ label: 'Suche und Filter zurücksetzen', variant: 'secondary', size: 'sm', onClick: () => { search.value = ''; view.q = ''; clearBtn.hidden = true; setSource('all'); } }) }));
      }
    }

    function fill(animate) {
      clear(grid);
      const games = ctx.cache.games;
      if (!games) {
        toolbar.hidden = true;
        for (let i = 0; i < 3; i++) {
          grid.appendChild(h('div', { class: 'card game-card is-loading', 'aria-hidden': 'true' },
            h('div', { class: 'gc-art is-loading' }),
            h('div', { class: 'gc-body' }, h('div', { class: 'game-top' }, h('div', { class: 'skel gc-skel-icon' }), h('div', { class: 'skel-block grow' }, h('div', { class: 'skel', style: { width: '60%' } }), h('div', { class: 'skel', style: { width: '90%', height: '10px' } }))),
              h('div', { class: 'skel-block' }, h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel', style: { width: '70%' } })))));
        }
        return;
      }
      buildChips();
      setCount(games.length, animate);
      if (!games.length) {
        grid.appendChild(h('div', { class: 'card pad-24 span-all' }, emptyState({ icon: 'gamepad', title: 'Keine Spiele gefunden', text: 'Füge ein Spiel über „Spiel hinzufügen“ hinzu oder gib den Pfad zur .exe-Datei oben ein.' })));
        noMatch.hidden = true;
        return;
      }
      for (const g of sorted(games)) grid.appendChild(gameCard(g));
      applyFilter();
      if (animate) stagger(grid);
    }

    function gameCard(g) {
      const boost = Object.assign({ priority: false, gpu: false, fso: false }, g.boost || {});
      const active = BOOSTS.filter(b => boost[b.key]).length;
      const art = g.art || {};
      const coverUrl = art.cover ? artUrl(g, 'cover') : null;
      const iconUrl = art.icon ? artUrl(g, 'icon') : null;
      const info = sourceInfo(g.source);
      const rows = BOOSTS.map(b => {
        const sw = toggle({ checked: boost[b.key], label: b.label + ' für ' + g.name, onChange: async (next) => {
          const nb = Object.assign({}, boost, { [b.key]: next });
          // busy state on the switch itself: the job has no overlay, so the switch shows it is saving
          sw.setAttribute('aria-busy', 'true'); sw.disabled = true;
          let job;
          try { job = await ctx.runJob('game-boost', { path: g.path, name: g.name, source: g.source, priority: !!nb.priority, gpu: !!nb.gpu, fso: !!nb.fso }, { overlay: false, quiet: true }); }
          finally { sw.removeAttribute('aria-busy'); sw.disabled = false; }
          if (job && job.status === 'done') {
            const ng = (job.result && job.result.game) || Object.assign({}, g, { boost: nb });
            Object.assign(g, ng, { boost: Object.assign({}, nb, ng.boost || {}), art: g.art || ng.art });
            Object.assign(boost, g.boost);
            toast({ type: 'ok', title: g.name + ': ' + b.label + (next ? ' an' : ' aus'), text: next ? 'Gilt ab dem nächsten Start des Spiels.' : 'Zurück auf Windows-Standard.' });
            const n = BOOSTS.filter(x => boost[x.key]).length;
            countEl.textContent = n + ' von 3 Boosts aktiv';
            card.classList.toggle('is-boosted', n > 0);
            boostedPill.hidden = n === 0;
            return true;
          }
          return false;
        } });
        return h('div', { class: 'boost-row' }, h('span', { class: 'boost-icon' }, icon(b.icon, 16)), h('div', { class: 'boost-text' }, h('div', { class: 'boost-label', text: b.label }), h('div', { class: 'boost-desc', text: b.desc })), sw);
      });
      const countEl = h('span', { class: 'game-count', text: active + ' von 3 Boosts aktiv' });
      const boostedPill = h('span', { class: 'gc-boosted', hidden: !active }, icon('bolt', 12), h('span', { text: 'Boost aktiv' }));
      const card = h('article', { class: ['card game-card spot', active && 'is-boosted'], 'data-game': g.id || g.exe || g.path, 'data-source': srcKey(g.source),
        'data-search': norm([g.name, g.exe, info.label].join(' ')), 'aria-label': g.name },
        h('div', { class: 'gc-media' }, banner(g, coverUrl, iconUrl),
          h('span', { class: 'gc-launcher', style: { '--dot': info.dot } }, h('span', { class: 'gc-dot' }), h('span', { text: info.label }),
            g.running ? h('span', { class: 'gc-live', text: 'läuft', title: 'Dieses Spiel lief bei der Suche gerade' }) : null),
          boostedPill),
        h('div', { class: 'gc-body' },
          h('div', { class: 'game-top' }, iconSlot(g, iconUrl),
            h('div', { class: 'game-titles' }, h('div', { class: 'game-name', text: g.name, title: g.name }), h('div', { class: 'game-path mono', text: g.path, title: g.path }))),
          h('div', { class: 'boost-list' }, rows),
          h('div', { class: 'game-foot' }, countEl)));
      return card;
    }

    // one detection at a time: a click while the automatic one runs waits for it (no "busy" hint)
    let inFlight = null;
    let wantToast = false;
    async function detect(manual) {
      if (manual) wantToast = true;
      if (inFlight) { if (manual) busyBtn(true); return inFlight; }
      inFlight = runDetect(manual).finally(() => { inFlight = null; });
      return inFlight;
    }
    function busyBtn(on) {
      detectBtn.disabled = on; detectBtn.classList.toggle('is-busy', on);
      if (on) detectBtn.setAttribute('aria-busy', 'true'); else detectBtn.removeAttribute('aria-busy');
    }
    async function runDetect(manual) {
      const before = (ctx.cache.games || []).length;
      if (manual) busyBtn(true);
      let job;
      try { job = await ctx.runJob('games-detect', {}, { overlay: false, quiet: true, quietBusy: !manual }); }
      finally { busyBtn(false); }
      manual = wantToast;
      wantToast = false;
      if (!el.isConnected) return;
      if (job && job.status === 'done') {
        ctx.cache.games = (job.result && job.result.games) || [];
        countNum.dataset.value = String(manual ? before : 0);
        fill(true);
        if (manual) toast(ctx.cache.games.length ? { type: 'ok', title: plural(ctx.cache.games.length, 'Spiel', 'Spiele') + ' gefunden' } : { type: 'info', title: 'Keine Spiele gefunden', text: 'Füge dein Spiel über „Spiel hinzufügen“ oder den Pfad zur .exe hinzu.' });
      } else if (!job && ctx.busy && !manual) {
        ctx.whenIdle(() => { if (el.isConnected && !ctx.cache.games) detect(false); });
      } else if (!ctx.cache.games) { ctx.cache.games = (ctx.settings.games || []).slice(); fill(true); }
    }
    async function pick() {
      const job = await ctx.runJob('pick-file', {}, { overlay: false, quiet: true });
      if (!job || job.status !== 'done') return;
      const p = job.result && job.result.path;
      if (!p) { toast({ type: 'info', title: 'Keine Datei gewählt', text: ctx.mode.simulate ? 'Im Testmodus gibt es keinen Dateidialog. Gib den Pfad einfach unten ein.' : 'Du kannst den Pfad auch unten eingeben.' }); pathInput.focus(); return; }
      addPath(p);
    }
    async function addPath(p) {
      p = String(p || '').trim().replace(/^"(.*)"$/, '$1');
      if (!p) { toast({ type: 'warn', title: 'Kein Pfad', text: 'Gib den vollständigen Pfad zur .exe-Datei ein.' }); pathInput.focus(); return; }
      if (!/\.exe$/i.test(p)) { toast({ type: 'warn', title: 'Keine .exe-Datei', text: 'Der Pfad muss auf eine .exe-Datei zeigen.' }); return; }
      const job = await ctx.runJob('game-boost', { path: p, priority: true, gpu: true, fso: true }, { overlay: false, quiet: true });
      if (job && job.status === 'done' && job.result && job.result.game) {
        const g = job.result.game;
        const old = (ctx.cache.games || []).find(x => String(x.path).toLowerCase() === String(g.path).toLowerCase());
        if (old && !g.art) g.art = old.art;
        if (old && (!g.source || g.source === 'manual')) { g.source = old.source; g.name = old.name; }
        ctx.cache.games = (ctx.cache.games || []).filter(x => x !== old);
        ctx.cache.games.unshift(g);
        pathInput.value = '';
        // the new game must be visible even when a filter or search hides the rest
        view.q = ''; search.value = ''; clearBtn.hidden = true; view.src = 'all';
        fill(false);
        toast({ type: 'ok', title: g.name + ' hinzugefügt', text: 'Alle drei Boosts sind an. Du kannst sie einzeln ausschalten.' });
      }
    }

    const gameTweaks = ctx.tweaks.filter(t => t.category === 'games');
    let renderer = null;
    if (gameTweaks.length) renderer = renderList(ctx, tweakList, gameTweaks, { groupBy: (t) => t.group || null });
    else tweakList.appendChild(emptyState({ icon: 'target', title: 'Keine Spiele-Tweaks', text: 'Der Katalog enthält noch keine spielspezifischen Tweaks.' }));
    ctx.on('statuses', () => renderer && renderer.update());
    ctx.on('pending', () => renderer && renderer.update());

    // automatic detection: one tick later, so the app's start-up scan (started right after the first
    // page mounts) goes first instead of being refused with "Bitte kurz warten"
    let offScan = null;
    function autoDetect() {
      if (!el.isConnected || ctx.cache.games) return;
      if (ctx.scanning) { if (!offScan) offScan = ctx.on('scanning', (on) => { if (!on) { offScan(); offScan = null; autoDetect(); } }); return; }
      detect(false);
    }
    fill(false);
    const autoTimer = setTimeout(autoDetect, 0);
    return { destroy() { clearTimeout(deb); clearTimeout(autoTimer); if (offScan) offScan(); if (renderer) renderer.cancel(); } };
  }
};
