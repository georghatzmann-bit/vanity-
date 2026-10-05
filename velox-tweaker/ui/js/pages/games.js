// Spiele: detected games with three boost switches each, add by file dialog or path, plus the
// "games" category tweaks.
import { icon } from '../icons.js';
import { h, clear, button, toggle, avatar, badge, emptyState, stagger, toast } from '../ui.js';
import { renderList } from '../tweakrow.js';

const BOOSTS = [
  { key: 'priority', label: 'Hohe CPU-Priorität', desc: 'Vorrang vor Hintergrund-Programmen', icon: 'cpu' },
  { key: 'gpu', label: 'Grafikkarte: Höchstleistung', desc: 'Immer die schnellste Grafikkarte nutzen', icon: 'gpu' },
  { key: 'fso', label: 'Vollbild-Optimierung aus', desc: 'Echtes Vollbild, weniger Verzögerung', icon: 'monitor' }
];

export default {
  id: 'games', title: 'Spiele', icon: 'gamepad', desc: 'Jedes Spiel einzeln boosten', keywords: 'games fivem gta booster priorität',
  mount(el, ctx) {
    const grid = h('div', { class: 'game-grid', 'data-testid': 'game-grid' });
    const detectBtn = button({ label: 'Spiele erkennen', icon: 'search', variant: 'secondary', onClick: () => detect(true) });
    const pickBtn = button({ label: 'Spiel hinzufügen', icon: 'plus', variant: 'primary', onClick: () => pick() });
    const pathInput = h('input', { class: 'input mono', type: 'text', placeholder: 'C:\\Spiele\\MeinSpiel\\spiel.exe', 'aria-label': 'Pfad zur .exe-Datei', spellcheck: 'false', 'data-testid': 'game-path' });
    const addBtn = button({ label: 'Hinzufügen', icon: 'plus', variant: 'secondary', onClick: () => addPath(pathInput.value) });
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addPath(pathInput.value); });
    const tweakList = h('div', { class: 'tw-list' });

    el.append(
      h('section', { class: 'card pad-24 games-head' },
        h('div', { class: 'games-head-text' }, h('h2', { class: 'section-title', text: 'Deine Spiele' }), h('p', { class: 'section-desc', text: 'VELOX findet Spiele aus Steam, Epic, Rockstar, Riot und FiveM. Jeder Schalter wirkt sofort und nur für dieses Spiel.' })),
        h('div', { class: 'games-head-actions' }, detectBtn, pickBtn),
        h('div', { class: 'path-row' }, h('div', { class: 'field-label', text: 'Oder Pfad zur .exe eingeben' }), h('div', { class: 'path-input' }, icon('file', 16), pathInput, addBtn))),
      grid,
      h('div', { class: 'section-head' }, h('div', {}, h('h2', { class: 'section-title', text: 'Spiele-Tweaks' }), h('p', { class: 'section-desc', text: 'Feinschliff für bestimmte Spiele. Wird wie alle Tweaks vorgemerkt und mit "Anwenden" übernommen.' }))),
      tweakList);

    function fill(animate) {
      clear(grid);
      const games = ctx.cache.games;
      if (!games) {
        for (let i = 0; i < 3; i++) grid.appendChild(h('div', { class: 'card game-card is-loading' }, h('div', { class: 'game-top' }, h('div', { class: 'skel', style: { width: '44px', height: '44px', 'border-radius': '12px' } }), h('div', { class: 'skel-block grow' }, h('div', { class: 'skel', style: { width: '60%' } }), h('div', { class: 'skel', style: { width: '90%', height: '10px' } }))), h('div', { class: 'skel-block' }, h('div', { class: 'skel' }), h('div', { class: 'skel' }), h('div', { class: 'skel', style: { width: '70%' } }))));
        return;
      }
      if (!games.length) {
        grid.appendChild(h('div', { class: 'card pad-24 span-all' }, emptyState({ icon: 'gamepad', title: 'Keine Spiele gefunden', text: 'Füge ein Spiel über "Spiel hinzufügen" hinzu oder gib den Pfad zur .exe-Datei oben ein.' })));
        return;
      }
      for (const g of games) grid.appendChild(gameCard(g));
      if (animate) stagger(grid);
    }

    function gameCard(g) {
      const boost = Object.assign({ priority: false, gpu: false, fso: false }, g.boost || {});
      const active = BOOSTS.filter(b => boost[b.key]).length;
      const rows = BOOSTS.map(b => {
        const sw = toggle({ checked: boost[b.key], label: b.label + ' für ' + g.name, onChange: async (next) => {
          const nb = Object.assign({}, boost, { [b.key]: next });
          const job = await ctx.runJob('game-boost', { path: g.path, priority: !!nb.priority, gpu: !!nb.gpu, fso: !!nb.fso }, { overlay: false, quiet: true });
          if (job && job.status === 'done') {
            const ng = (job.result && job.result.game) || Object.assign({}, g, { boost: nb });
            Object.assign(g, ng, { boost: Object.assign({}, nb, ng.boost || {}) });
            Object.assign(boost, g.boost);
            toast({ type: 'ok', title: g.name + ': ' + b.label + (next ? ' an' : ' aus'), text: next ? 'Gilt ab dem nächsten Start des Spiels.' : 'Zurück auf Windows-Standard.' });
            countEl.textContent = BOOSTS.filter(x => boost[x.key]).length + ' von 3 Boosts aktiv';
            card.classList.toggle('is-boosted', BOOSTS.some(x => boost[x.key]));
            return true;
          }
          return false;
        } });
        return h('div', { class: 'boost-row' }, h('span', { class: 'boost-icon' }, icon(b.icon, 16)), h('div', { class: 'boost-text' }, h('div', { class: 'boost-label', text: b.label }), h('div', { class: 'boost-desc', text: b.desc })), sw);
      });
      const countEl = h('span', { class: 'game-count', text: active + ' von 3 Boosts aktiv' });
      const card = h('article', { class: ['card game-card spot', active && 'is-boosted'], 'data-game': g.id || g.exe || g.path },
        h('div', { class: 'game-top' }, avatar(g.name),
          h('div', { class: 'game-titles' }, h('div', { class: 'game-name', text: g.name }), h('div', { class: 'game-path mono', text: g.path, title: g.path })),
          g.source ? badge(g.source, 'neutral') : null),
        h('div', { class: 'boost-list' }, rows),
        h('div', { class: 'game-foot' }, countEl));
      return card;
    }

    async function detect(manual) {
      const job = await ctx.runJob('games-detect', {}, { overlay: false, quiet: true, quietBusy: !manual });
      if (job && job.status === 'done') {
        ctx.cache.games = (job.result && job.result.games) || [];
        fill(true);
        if (manual) toast({ type: 'ok', title: ctx.cache.games.length + ' Spiele gefunden' });
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
        ctx.cache.games = (ctx.cache.games || []).filter(x => String(x.path).toLowerCase() !== String(g.path).toLowerCase());
        ctx.cache.games.unshift(g);
        pathInput.value = '';
        fill(true);
        toast({ type: 'ok', title: g.name + ' hinzugefügt', text: 'Alle drei Boosts sind an. Du kannst sie einzeln ausschalten.' });
      }
    }

    const gameTweaks = ctx.tweaks.filter(t => t.category === 'games');
    let renderer = null;
    if (gameTweaks.length) renderer = renderList(ctx, tweakList, gameTweaks, { groupBy: (t) => t.group || null });
    else tweakList.appendChild(emptyState({ icon: 'target', title: 'Keine Spiele-Tweaks', text: 'Der Katalog enthält noch keine spielspezifischen Tweaks.' }));
    ctx.on('statuses', () => renderer && renderer.update());
    ctx.on('pending', () => renderer && renderer.update());

    fill(false);
    if (!ctx.cache.games) detect(false);
    return { destroy() { if (renderer) renderer.cancel(); } };
  }
};
