// Tweaks: category rail, search, filter chips, staged toggles, incremental rendering for 500+ rows.
import { icon } from '../icons.js';
import { h, clear, button, emptyState, toast, plural, fmtNumber, append, edgeFade } from '../ui.js';
import { renderList } from '../tweakrow.js';
import { tweakScore } from '../search.js';

export const OWN_PAGES = new Set(['cleanup', 'repair', 'apps']);

const FILTERS = [
  { key: 'risk', label: 'Risiko', options: [['safe', 'Sicher'], ['moderate', 'Mittel'], ['risky', 'Riskant']] },
  { key: 'status', label: 'Status', options: [['on', 'Aktiv'], ['off', 'Aus'], ['foreign', 'Fremd geändert'], ['na', 'Passt nicht']] },
  { key: 'impact', label: 'Wirkung', options: [['3', 'Stark'], ['2', 'Spürbar'], ['1', 'Kaum']] }
];

export default {
  id: 'tweaks', title: 'Tweaks', icon: 'sliders', desc: 'Jede Einstellung einzeln – vormerken, prüfen, anwenden', keywords: 'einstellungen optionen alle',
  mount(el, ctx, opts) {
    const cats = ctx.categories.filter(c => !OWN_PAGES.has(c.id) && ctx.tweaks.some(t => t.category === c.id));
    let cat = (opts && opts.category) || ctx.cache.tweaksCat || 'all';
    if (cat !== 'all' && !cats.some(c => c.id === cat)) cat = 'all';
    let query = (opts && opts.query) || '';
    const active = { risk: new Set(), status: new Set(), impact: new Set() };
    let renderer = null;
    const openIds = new Set(); // rows whose details the user opened (survive a re-render)

    const inScope = (t) => !OWN_PAGES.has(t.category) && ctx.catById.has(t.category);

    // ---------- rail
    const rail = h('nav', { class: 'tw-rail', 'aria-label': 'Kategorien' });
    const railItems = new Map();
    const mkRailItem = (id, name, ic) => {
      const b = h('button', { class: 'rail-item', type: 'button', 'data-cat': id, 'aria-pressed': String(id === cat), title: name },
        h('span', { class: 'rail-icon' }, icon(ic, 17)), h('span', { class: 'rail-name', text: name }), h('span', { class: 'rail-count' }));
      b.addEventListener('click', () => { if (query) { query = ''; search.value = ''; } selectCat(id); });
      railItems.set(id, b);
      rail.appendChild(b);
    };
    mkRailItem('all', 'Alle Tweaks', 'layers');
    for (const c of cats) mkRailItem(c.id, c.name, c.icon);
    // Same definition everywhere: active / applicable toggles (what fits this PC).
    function railCounts() {
      for (const [id, b] of railItems) {
        const list = ctx.countable(t => inScope(t) && (id === 'all' || t.category === id));
        const on = list.filter(t => ctx.isApplied(t.id)).length;
        const pend = ctx.toggles().filter(t => inScope(t) && (id === 'all' || t.category === id) && ctx.pending.has(t.id)).length;
        const cnt = b.querySelector('.rail-count');
        cnt.textContent = on + '/' + list.length;
        cnt.title = on + ' von ' + list.length + ' passenden Tweaks aktiv';
        b.classList.toggle('has-pending', pend > 0);
      }
    }

    // ---------- toolbar
    const search = h('input', { class: 'search-input', type: 'search', placeholder: 'Tweaks durchsuchen …', 'aria-label': 'Tweaks durchsuchen', value: query, 'data-testid': 'tweak-search' });
    const clearBtn = h('button', { class: 'icon-btn search-clear', type: 'button', 'aria-label': 'Suche leeren', hidden: !query }, icon('x', 15));
    clearBtn.addEventListener('click', () => { search.value = ''; query = ''; clearBtn.hidden = true; refresh(); search.focus(); });
    let deb = 0;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { query = search.value.trim(); clearBtn.hidden = !query; refresh(); }, 120);
    });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); clearBtn.click(); } });
    const searchBox = h('div', { class: 'search' }, icon('search', 17), search, clearBtn);

    const chipRow = h('div', { class: 'chip-row tw-chips', role: 'group', 'aria-label': 'Filter' });
    const resetChip = h('button', { class: 'chip chip-reset', type: 'button', hidden: true }, icon('x', 13), h('span', { text: 'Filter zurücksetzen' }));
    resetChip.addEventListener('click', () => { for (const s of Object.values(active)) s.clear(); for (const c of chipRow.querySelectorAll('.chip[aria-pressed]')) c.setAttribute('aria-pressed', 'false'); refresh(); });
    // one group per filter (label + its chips): a group wraps as a whole, so no line ever starts
    // with a lone chip or a stray divider
    for (const g of FILTERS) {
      const grp = h('span', { class: 'chip-group', role: 'group', 'aria-label': g.label }, h('span', { class: 'chip-label', 'aria-hidden': 'true', text: g.label }));
      for (const [val, label] of g.options) {
        const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', 'data-filter': g.key + ':' + val }, h('span', { class: 'chip-dot' }), h('span', { text: label }));
        c.addEventListener('click', () => {
          const on = c.getAttribute('aria-pressed') !== 'true';
          c.setAttribute('aria-pressed', String(on));
          if (on) active[g.key].add(val); else active[g.key].delete(val);
          refresh();
        });
        grp.appendChild(c);
      }
      chipRow.appendChild(grp);
    }
    chipRow.appendChild(resetChip);

    // ---------- head + list
    const head = h('div', { class: 'card tw-head' });
    const resultInfo = h('div', { class: 'tw-result', 'aria-live': 'polite' });
    const list = h('div', { class: 'tw-list', 'data-testid': 'tweak-list' });

    const scoreOf = new Map();
    let lastHits = []; // what the list shows right now (the head counts search hits from it)
    function matches(t) {
      if (active.risk.size && !active.risk.has(t.risk)) return false;
      if (active.impact.size && !active.impact.has(String(t.impact || 1))) return false;
      if (active.status.size) {
        const st = ctx.status(t.id);
        const key = !ctx.applicable(t) ? 'na' : st === 'applied' ? 'on' : (st === 'custom' || st === 'partial') ? 'foreign' : 'off';
        if (!active.status.has(key)) return false;
      }
      if (query) { const sc = tweakScore(query, t, ctx.catName(t.category)); if (!sc) return false; scoreOf.set(t.id, sc); }
      return true;
    }

    function recommended() {
      return ctx.toggles().filter(t => inScope(t) && (cat === 'all' || t.category === cat) && t.risk === 'safe' && ctx.applicable(t) && !ctx.isApplied(t.id) && ctx.pending.get(t.id) !== true);
    }

    function fillHead() {
      clear(head);
      const c = cat === 'all' ? { name: 'Alle Tweaks', desc: 'Alles, was VELOX an deinem PC einstellen kann – nach Bereichen sortiert.', icon: 'layers' } : ctx.catById.get(cat);
      const scope = ctx.toggles().filter(t => inScope(t) && (cat === 'all' || t.category === cat));
      const appl = ctx.countable(t => inScope(t) && (cat === 'all' || t.category === cat));
      const on = appl.filter(t => ctx.isApplied(t.id)).length;
      const hits = lastHits;
      const hitsOn = query ? hits.filter(t => (t.kind || 'toggle') === 'toggle' && ctx.applicable(t) && ctx.isApplied(t.id)).length : 0;
      const rec = recommended();
      // nothing left to recommend: either all of them are already on, or they wait in the pending bar
      const recStaged = !rec.length && ctx.toggles().some(t => inScope(t) && (cat === 'all' || t.category === cat) && t.risk === 'safe' && ctx.pending.get(t.id) === true);
      const recBtn = button({ label: rec.length ? 'Empfohlene aktivieren (' + rec.length + ')' : recStaged ? 'Empfohlene sind vorgemerkt' : 'Empfohlene sind aktiv', icon: rec.length ? 'sparkles' : 'check', variant: rec.length ? 'primary' : 'secondary', size: 'sm', disabled: !rec.length || !!query, attrs: { 'data-testid': 'recommend-btn', title: 'Merkt alle sicheren Tweaks dieser Kategorie vor, die zu deinem PC passen und noch nicht aktiv sind.' },
        onClick: async () => { const n = await ctx.stageMany(rec.map(t => t.id), true); if (n) toast({ type: 'ok', title: plural(n, 'Tweak', 'Tweaks') + ' vorgemerkt', text: 'Nur sichere Tweaks. Klick unten auf „Anwenden“, um sie zu übernehmen.' }); } });
      append(head, 
        h('div', { class: 'tw-head-icon' }, icon(query ? 'search' : (c.icon || 'layers'), 22)),
        h('div', { class: 'tw-head-text' },
          h('h2', { class: 'tw-head-title', text: query ? 'Suche: „' + query + '“' : c.name }),
          h('p', { class: 'tw-head-desc', text: query ? (hits.length ? 'Ergebnisse aus allen Bereichen, die besten zuerst.' : 'Kein Tweak passt zu deiner Suche.') : c.desc || '' }),
          // searching: the numbers describe the hits, not the category that happens to be selected
          query ? h('div', { class: 'tw-head-stats' },
            h('span', { class: 'mini-stat' }, h('strong', { text: fmtNumber(hits.length) }), ' Treffer'),
            hitsOn ? h('span', { class: 'mini-stat muted', text: fmtNumber(hitsOn) + ' davon aktiv' }) : null)
          : h('div', { class: 'tw-head-stats' },
            h('span', { class: 'mini-stat' }, h('strong', { text: fmtNumber(on) }), ' von ' + fmtNumber(appl.length) + ' aktiv'),
            appl.length < scope.length ? h('span', { class: 'mini-stat muted', text: (scope.length - appl.length) + ' passen nicht zu deinem PC' }) : null)),
        query ? null : h('div', { class: 'tw-head-actions' }, recBtn));
    }

    function refresh(animate = true) {
      if (renderer) renderer.cancel();
      ctx.cache.tweaksCat = cat;
      scoreOf.clear();
      const all = ctx.tweaks.filter(t => inScope(t) && (query || cat === 'all' || t.category === cat));
      const filtered = all.filter(matches);
      lastHits = filtered;
      const anyFilter = Object.values(active).some(s => s.size);
      resetChip.hidden = !anyFilter;
      // Counted like the head and the rail: toggles that fit this PC; one-off actions separately.
      const nToggles = filtered.filter(t => (t.kind || 'toggle') === 'toggle' && ctx.applicable(t)).length;
      const nActions = filtered.filter(t => t.kind === 'action' && ctx.applicable(t)).length;
      resultInfo.textContent = (query || anyFilter) ? plural(filtered.length, 'Treffer', 'Treffer')
        : [plural(nToggles, 'Tweak', 'Tweaks'), nActions ? plural(nActions, 'Aktion', 'Aktionen') : null].filter(Boolean).join(' · ');
      fillHead();
      const order = new Map(ctx.categories.map((c, i) => [c.id, i]));
      // search: best match first (no grouping, the category is shown on each row)
      const sorted = query
        ? filtered.slice().sort((a, b) => (scoreOf.get(b.id) - scoreOf.get(a.id)) || (Number(ctx.applicable(b)) - Number(ctx.applicable(a))) || ((Number(b.impact) || 1) - (Number(a.impact) || 1)))
        : filtered.slice().sort((a, b) => cat === 'all' ? (order.get(a.category) - order.get(b.category)) || 0 : 0);
      if (!sorted.length) {
        clear(list).appendChild(emptyState({
          icon: 'search', title: 'Nichts gefunden',
          text: query ? 'Kein Tweak passt zu „' + query + '“. Probier ein anderes Wort, z. B. „Maus“, „Ping“ oder „Werbung“.' : 'Mit diesen Filtern bleibt nichts übrig. Nimm einen Filter heraus oder setz alle zurück.',
          action: button({ label: 'Suche und Filter zurücksetzen', variant: 'secondary', size: 'sm', onClick: () => { search.value = ''; query = ''; clearBtn.hidden = true; resetChip.click(); } })
        }));
        renderer = null;
        return;
      }
      renderer = renderList(ctx, list, sorted, {
        showCategory: !!query, openIds, animate,
        groupBy: query ? null : cat === 'all' ? (t) => ctx.catName(t.category) : (t) => t.group || null
      });
    }

    function selectCat(id) {
      cat = id;
      for (const [k, b] of railItems) b.setAttribute('aria-pressed', String(k === id));
      const cur = railItems.get(id);
      if (cur && cur.scrollIntoView && rail.scrollWidth > rail.clientWidth) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: document.documentElement.dataset.motion === 'reduced' ? 'auto' : 'smooth' });
      refresh();
    }

    append(el, h('div', { class: 'tw-layout' },
      rail,
      h('div', { class: 'tw-main' },
        h('div', { class: 'tw-toolbar' }, searchBox, resultInfo),
        chipRow, head, list)));

    edgeFade(rail);
    railCounts();
    refresh();
    if (opts && opts.focusSearch) requestAnimationFrame(() => search.focus());

    const onChange = () => { if (renderer) renderer.update(); railCounts(); fillHead(); };
    ctx.on('statuses', onChange);
    ctx.on('pending', onChange);
    // the catalog is re-read after every scan: same filters, same open rows, no entrance animation
    ctx.on('catalog', () => { railCounts(); refresh(false); });
    return { destroy() { if (renderer) renderer.cancel(); } };
  }
};
