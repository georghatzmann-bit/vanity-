// Tweaks: category rail, search, filter chips, staged toggles, incremental rendering for 500+ rows.
import { icon } from '../icons.js';
import { h, clear, button, emptyState, toast, plural, fmtNumber, append } from '../ui.js';
import { renderList } from '../tweakrow.js';

export const OWN_PAGES = new Set(['cleanup', 'repair', 'apps']);

const FILTERS = [
  { key: 'risk', label: 'Risiko', options: [['safe', 'Sicher'], ['moderate', 'Mittel'], ['risky', 'Riskant']] },
  { key: 'status', label: 'Status', options: [['on', 'Aktiv'], ['off', 'Aus'], ['foreign', 'Fremd geändert'], ['na', 'Nicht verfügbar']] },
  { key: 'impact', label: 'Wirkung', options: [['3', 'Stark'], ['2', 'Spürbar'], ['1', 'Kaum']] }
];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export default {
  id: 'tweaks', title: 'Tweaks', icon: 'sliders', desc: 'Jede Einstellung einzeln – vormerken, prüfen, anwenden', keywords: 'einstellungen optionen alle',
  mount(el, ctx, opts) {
    const cats = ctx.categories.filter(c => !OWN_PAGES.has(c.id) && ctx.tweaks.some(t => t.category === c.id));
    let cat = (opts && opts.category) || ctx.cache.tweaksCat || 'all';
    if (cat !== 'all' && !cats.some(c => c.id === cat)) cat = 'all';
    let query = (opts && opts.query) || '';
    const active = { risk: new Set(), status: new Set(), impact: new Set() };
    let renderer = null;

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
    function railCounts() {
      for (const [id, b] of railItems) {
        const list = ctx.toggles().filter(t => inScope(t) && (id === 'all' || t.category === id));
        const on = list.filter(t => ctx.isApplied(t.id)).length;
        const pend = list.filter(t => ctx.pending.has(t.id)).length;
        const cnt = b.querySelector('.rail-count');
        cnt.textContent = on + '/' + list.length;
        cnt.title = on + ' von ' + list.length + ' aktiv';
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

    const chipRow = h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Filter' });
    const resetChip = h('button', { class: 'chip chip-reset', type: 'button', hidden: true }, icon('x', 13), h('span', { text: 'Filter zurücksetzen' }));
    resetChip.addEventListener('click', () => { for (const s of Object.values(active)) s.clear(); for (const c of chipRow.querySelectorAll('.chip[aria-pressed]')) c.setAttribute('aria-pressed', 'false'); refresh(); });
    for (const g of FILTERS) {
      chipRow.appendChild(h('span', { class: 'chip-label', text: g.label }));
      for (const [val, label] of g.options) {
        const c = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', 'data-filter': g.key + ':' + val }, h('span', { class: 'chip-dot' }), h('span', { text: label }));
        c.addEventListener('click', () => {
          const on = c.getAttribute('aria-pressed') !== 'true';
          c.setAttribute('aria-pressed', String(on));
          if (on) active[g.key].add(val); else active[g.key].delete(val);
          refresh();
        });
        chipRow.appendChild(c);
      }
      chipRow.appendChild(h('span', { class: 'chip-sep', 'aria-hidden': 'true' }));
    }
    chipRow.lastChild.remove();
    chipRow.appendChild(resetChip);

    // ---------- head + list
    const head = h('div', { class: 'card tw-head' });
    const resultInfo = h('div', { class: 'tw-result', 'aria-live': 'polite' });
    const list = h('div', { class: 'tw-list', 'data-testid': 'tweak-list' });

    function matches(t) {
      if (active.risk.size && !active.risk.has(t.risk)) return false;
      if (active.impact.size && !active.impact.has(String(t.impact || 1))) return false;
      if (active.status.size) {
        const st = ctx.status(t.id);
        const key = !ctx.applicable(t) ? 'na' : st === 'applied' ? 'on' : (st === 'custom' || st === 'partial') ? 'foreign' : 'off';
        if (!active.status.has(key)) return false;
      }
      if (query) {
        const q = norm(query);
        const hay = norm(t.name + ' ' + t.desc + ' ' + (t.group || '') + ' ' + t.id + ' ' + (t.tags || []).join(' ') + ' ' + ctx.catName(t.category));
        if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
      }
      return true;
    }

    function recommended() {
      return ctx.toggles().filter(t => inScope(t) && (cat === 'all' || t.category === cat) && t.risk === 'safe' && ctx.applicable(t) && !ctx.isApplied(t.id) && ctx.pending.get(t.id) !== true);
    }

    function fillHead() {
      clear(head);
      const c = cat === 'all' ? { name: 'Alle Tweaks', desc: 'Alles, was VELOX an deinem PC einstellen kann – nach Bereichen sortiert.', icon: 'layers' } : ctx.catById.get(cat);
      const scope = ctx.toggles().filter(t => inScope(t) && (cat === 'all' || t.category === cat));
      const appl = scope.filter(t => ctx.applicable(t));
      const on = appl.filter(t => ctx.isApplied(t.id)).length;
      const rec = recommended();
      const recBtn = button({ label: rec.length ? 'Empfohlene aktivieren (' + rec.length + ')' : 'Empfohlene sind aktiv', icon: rec.length ? 'sparkles' : 'check', variant: rec.length ? 'primary' : 'secondary', size: 'sm', disabled: !rec.length || !!query, attrs: { 'data-testid': 'recommend-btn', title: 'Merkt alle sicheren Tweaks dieser Kategorie vor, die zu deinem PC passen und noch nicht aktiv sind.' },
        onClick: async () => { const n = await ctx.stageMany(rec.map(t => t.id), true); if (n) toast({ type: 'ok', title: plural(n, 'Tweak', 'Tweaks') + ' vorgemerkt', text: 'Nur sichere Tweaks. Klick unten auf "Anwenden", um sie zu übernehmen.' }); } });
      append(head, 
        h('div', { class: 'tw-head-icon' }, icon(c.icon || 'layers', 22)),
        h('div', { class: 'tw-head-text' },
          h('h2', { class: 'tw-head-title', text: query ? 'Suche: „' + query + '“' : c.name }),
          h('p', { class: 'tw-head-desc', text: query ? 'Ergebnisse aus allen Bereichen.' : c.desc || '' }),
          h('div', { class: 'tw-head-stats' },
            h('span', { class: 'mini-stat' }, h('strong', { text: fmtNumber(on) }), ' von ' + fmtNumber(appl.length) + ' aktiv'),
            appl.length < scope.length ? h('span', { class: 'mini-stat muted', text: (scope.length - appl.length) + ' passen nicht zu deinem PC' }) : null)),
        h('div', { class: 'tw-head-actions' }, recBtn));
    }

    function refresh() {
      if (renderer) renderer.cancel();
      ctx.cache.tweaksCat = cat;
      const all = ctx.tweaks.filter(t => inScope(t) && (query || cat === 'all' || t.category === cat));
      const filtered = all.filter(matches);
      const anyFilter = Object.values(active).some(s => s.size);
      resetChip.hidden = !anyFilter;
      resultInfo.textContent = (query || anyFilter) ? plural(filtered.length, 'Treffer', 'Treffer') : plural(filtered.length, 'Tweak', 'Tweaks');
      fillHead();
      const order = new Map(ctx.categories.map((c, i) => [c.id, i]));
      const grouped = query || cat === 'all';
      const sorted = filtered.slice().sort((a, b) => grouped ? (order.get(a.category) - order.get(b.category)) || 0 : 0);
      if (!sorted.length) {
        clear(list).appendChild(emptyState({
          icon: 'search', title: 'Nichts gefunden',
          text: query ? 'Kein Tweak passt zu „' + query + '“. Probier ein anderes Wort, z. B. „Maus“, „Ping“ oder „Werbung“.' : 'Mit diesen Filtern bleibt nichts übrig.',
          action: button({ label: 'Suche und Filter zurücksetzen', variant: 'secondary', size: 'sm', onClick: () => { search.value = ''; query = ''; clearBtn.hidden = true; resetChip.click(); } })
        }));
        renderer = null;
        return;
      }
      renderer = renderList(ctx, list, sorted, {
        groupBy: grouped ? (t) => ctx.catName(t.category) : (t) => t.group || null
      });
    }

    function selectCat(id) {
      cat = id;
      for (const [k, b] of railItems) b.setAttribute('aria-pressed', String(k === id));
      const cur = railItems.get(id);
      if (cur && cur.scrollIntoView && rail.scrollWidth > rail.clientWidth) cur.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      refresh();
    }

    append(el, h('div', { class: 'tw-layout' },
      rail,
      h('div', { class: 'tw-main' },
        h('div', { class: 'tw-toolbar' }, searchBox, resultInfo),
        chipRow, head, list)));

    railCounts();
    refresh();
    if (opts && opts.focusSearch) requestAnimationFrame(() => search.focus());

    const onChange = () => { if (renderer) renderer.update(); railCounts(); fillHead(); };
    ctx.on('statuses', onChange);
    ctx.on('pending', onChange);
    ctx.on('catalog', () => { railCounts(); refresh(); });
    return { destroy() { if (renderer) renderer.cancel(); } };
  }
};
