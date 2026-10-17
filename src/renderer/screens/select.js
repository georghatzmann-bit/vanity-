// Auswahl ({ mode: 'restore' | 'catalog' }): profile apps + curated catalog in one selectable grid.
// Sidebar (views + categories with live counts), search, "Alle"/"Keine", preset chips, GPU-aware
// driver suggestion, games with switches, sticky dock with "Installation starten".
// Leaves with store.installJob = { items, links, games } -> install (warp).
//
// Performance: every AppCard is created once and cached; views re-append the cached nodes, toggles
// only flip the card (AppCard.setSelected) and batch the counters into one rAF.
import '../styles/screens/select.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { xicon, CATEGORY_ICONS } from '../components/selectIcons.js';
import { Button } from '../components/button.js';
import { AppCard } from '../components/appCard.js';
import { SearchInput } from '../components/searchInput.js';
import { EmptyState } from '../components/emptyState.js';
import { GameCard } from '../components/selectGameCard.js';
import { buildModel, buildInstallJob, fold, OTHER, LAUNCHER_KEYS, PLATFORM_LABEL } from '../components/selectModel.js';
import { revealText, shake, gsap, motionOK, richMotion } from '../core/motion.js';
import { formatRelativeDate, formatNumber, plural, joinList } from '../core/format.js';

/** Selection survives leaving and re-entering the screen with the same profile / mode. */
const memory = { sig: null, sel: null, gameSel: null, view: null };

const EMPTY_SUMMARY = { installed: 0, already: 0, failed: 0, skipped: 0, cancelled: 0, rebootRequired: false };

export default {
  title: 'Auswahl',
  fxState: 'idle',
  mount(container, ctx) {
    const { api, store, router, sound, toast, fx } = ctx;
    const params = ctx.params || {};
    const url = new URLSearchParams(location.search);
    let mode =
      params.mode === 'restore' || params.mode === 'catalog'
        ? params.mode
        : ['restore', 'catalog'].includes(url.get('mode'))
          ? url.get('mode')
          : url.get('screen') === 'select' && store.get('profile')
            ? 'restore'
            : 'catalog';
    container.classList.add('screen--select');

    let alive = true;
    let model = null;
    let profile = null;
    let sel = new Set();
    let gameSel = new Set();
    let view = 'all';
    let query = '';
    let qTerms = [];
    let starting = false;
    let hintOverride = null;
    let raf = 0;
    const cards = new Map();
    const gameCards = new Map();
    const unmatchedCards = new Map();
    const navItems = new Map();
    let rendered = [];
    const cleanups = [];
    const flyers = new Set();

    // ================================================================ layout
    const navThumb = h('span.sel-nav__thumb', { attrs: { 'aria-hidden': 'true' } });
    const nav = h('nav.sel-nav', { attrs: { 'aria-label': 'Bereiche und Kategorien' } }, navThumb, skeletonNav());
    const sideHead = h('div.sel-side__head', h('span.sel-skel__line.sel-skel__line--w60'));
    const sideFoot = h('div.sel-side__foot');
    const side = h('aside.sel-side', { dataset: { stagger: '' } }, sideHead, nav, sideFoot);

    const titleEl = h('h1.sel-title', mode === 'restore' ? 'Was soll zurück?' : 'Was soll drauf?');
    const search = SearchInput({ placeholder: 'App suchen – Name oder ID', label: 'Apps suchen', onInput: (v) => setQuery(v) });
    const btnAll = Button({ label: 'Alle', icon: 'check', variant: 'secondary', size: 'sm', magnetic: false, onClick: () => bulkView(true) });
    const btnNone = Button({ label: 'Keine', icon: 'minus', variant: 'secondary', size: 'sm', magnetic: false, onClick: () => bulkView(false) });
    const chipGamer = chip('flame', 'Empfohlen für Gamer', () => togglePreset('gamer'));
    const chipProfile = chip('user', 'Alles aus dem Profil', () => togglePreset('profile'));
    chipProfile.hidden = mode !== 'restore';
    const hintEl = h('p.sel-hint', { attrs: { 'aria-live': 'polite' } }, 'Apps werden geladen …');
    cleanups.push(() => search.destroy(), () => btnAll.destroy(), () => btnNone.destroy());

    const head = h(
      'header.sel-head',
      h(
        'div.sel-top',
        { dataset: { stagger: '' } },
        h('button.back-link', { type: 'button', onClick: () => router.back() }, icon('arrow-left'), 'Zurück'),
        h('span.t-eyebrow', h('span.sel-live'), 'Schritt 2 von 3 · Auswahl'),
      ),
      titleEl,
      h(
        'div.sel-tools',
        { dataset: { stagger: '' } },
        h('div.sel-tools__search', search),
        h('div.sel-tools__group', { attrs: { role: 'group', 'aria-label': 'Aktuelle Ansicht' } }, btnAll, btnNone),
        h('span.sel-tools__sep'),
        h('div.sel-tools__chips', { attrs: { role: 'group', 'aria-label': 'Voreinstellungen' } }, chipGamer, chipProfile),
      ),
      h('div', { dataset: { stagger: '' } }, hintEl),
    );

    const scroll = h('div.sel-scroll', { attrs: { role: 'region', 'aria-label': 'Apps zur Auswahl' } });

    const nApps = h('b.sel-dock__n', '0');
    const nGames = h('b.sel-dock__n', '0');
    const nLinks = h('b.sel-dock__n', '0');
    const uApps = h('span.sel-dock__u', ' Apps');
    const uGames = h('span.sel-dock__u', ' Spiele');
    const segApps = h('span.sel-dock__seg', nApps, uApps);
    const segGames = h('span.sel-dock__seg', nGames, uGames);
    const segLinks = h('span.sel-dock__seg.sel-dock__seg--link', { tabIndex: 0 }, nLinks, h('span.sel-dock__u', ' manuell'), icon('info', { size: 14, strokeWidth: 2 }));
    const sepGames = h('span.sel-dock__dot');
    const sepLinks = h('span.sel-dock__dot');
    const dockHint = h('p.sel-dock__hint');
    const reviewBtn = Button({ label: 'Auswahl ansehen', icon: 'eye', variant: 'ghost', magnetic: false, onClick: () => setView('selected') });
    const startBtn = Button({
      label: 'Installation starten',
      icon: 'rocket',
      variant: 'primary',
      size: 'xl',
      className: 'sel-start',
      title: 'Installation starten (Strg+Enter)',
      onClick: () => startInstall(),
    });
    startBtn.setDisabled(true);
    cleanups.push(() => reviewBtn.destroy(), () => startBtn.destroy());
    const dock = h(
      'footer.sel-dock',
      { dataset: { stagger: '' } },
      h(
        'div.sel-dock__info',
        h('div.sel-dock__stats', { attrs: { 'aria-live': 'polite' } }, segApps, sepGames, segGames, sepLinks, segLinks),
        dockHint,
      ),
      h('div.sel-dock__actions', reviewBtn, h('div.sel-start-wrap', h('span.sel-start-glow.deco', { attrs: { 'aria-hidden': 'true' } }), startBtn)),
    );

    const root = h('div.sel', { dataset: { mode, view: 'all' } }, side, h('div.sel-main', head, scroll), dock);
    container.append(root);
    skeletonGrid();

    const titleTl = revealText(titleEl, { delay: 0.2 });
    cleanups.push(() => titleTl?.kill());

    // ================================================================ hint line (grey one-line explanations)
    function defaultHint() {
      if (!model) return 'Apps werden geladen …';
      if (qTerms.length) {
        const n = rendered.reduce((a, s) => a + (s.keys ? s.keys.length : s.games ? s.games.length : s.items.length), 0);
        return n ? `${plural(n, 'Treffer', 'Treffer')} für „${query}“ in „${viewLabel(view)}“. Esc leert die Suche.` : `Keine Treffer für „${query}“.`;
      }
      if (view === 'profile') return 'Apps und Spiele aus deinem Profil. Ein Klick auf eine Kachel wählt sie an oder ab.';
      if (view === 'games') return 'Werden nach den Launchern über Epic/Steam installiert.';
      if (view === 'selected') return 'Das wird installiert. Ein Klick auf eine Kachel nimmt sie wieder raus.';
      if (view === 'all') return mode === 'restore' ? 'Alle Apps aus dem Katalog. Der Punkt am Icon heißt: war in deinem Profil.' : 'Alle Apps aus dem Katalog. Mit Haken wird installiert.';
      const cat = view.slice(4);
      return cat === OTHER ? 'Apps aus deinem Profil, die Phoenix keiner Kategorie zuordnen kann.' : `${plural(keysOfView(view).length, 'App', 'Apps')} in „${cat}“. Mit Haken wird installiert.`;
    }
    function paintHint() {
      hintEl.textContent = hintOverride || defaultHint();
      hintEl.classList.toggle('is-explain', !!hintOverride);
    }
    function explain(el, text) {
      const show = () => {
        hintOverride = typeof text === 'function' ? text() : text;
        paintHint();
      };
      const hide = () => {
        hintOverride = null;
        paintHint();
      };
      el.addEventListener('pointerenter', show);
      el.addEventListener('pointerleave', hide);
      el.addEventListener('focus', show);
      el.addEventListener('blur', hide);
    }
    explain(btnAll, () => `Wählt alles in „${viewLabel(view)}“ aus${qTerms.length ? ', was zur Suche passt' : ''}.`);
    explain(btnNone, () => `Nimmt alles in „${viewLabel(view)}“ aus der Auswahl${qTerms.length ? ', was zur Suche passt' : ''}.`);
    explain(chipGamer, () =>
      isPresetActive('gamer')
        ? 'Alle Empfehlungen sind drin. Noch ein Klick nimmt sie wieder raus.'
        : `Wählt ${plural(model ? model.popularKeys.length : 0, 'beliebte App', 'beliebte Apps')} aus – Steam, Discord, OBS und Co.`,
    );
    explain(chipProfile, () =>
      isPresetActive('profile') ? 'Alles aus deinem Profil ist drin. Noch ein Klick nimmt es raus.' : 'Wählt alle Apps und Spiele aus deinem Profil wieder aus.',
    );
    explain(search.querySelector('input'), 'Tipp: / oder Strg+F springt in die Suche, Esc leert sie.');

    function dockExplain(el, text) {
      const show = () => {
        dockHint.textContent = text;
        dockHint.classList.add('is-explain');
      };
      const hide = () => paintDockHint();
      el.addEventListener('pointerenter', show);
      el.addEventListener('pointerleave', hide);
      el.addEventListener('focus', show);
      el.addEventListener('blur', hide);
    }
    dockExplain(segLinks, 'Manuelle Apps gibt es nicht über winget – Phoenix öffnet am Ende ihre Download-Seiten.');
    dockExplain(reviewBtn, 'Zeigt nur, was installiert wird – zum letzten Durchsehen.');

    // ================================================================ small builders
    function chip(iconName, label, onClick) {
      return h(
        'button.sel-chip',
        {
          type: 'button',
          attrs: { 'aria-pressed': 'false' },
          onClick: () => {
            sound.play('click');
            onClick();
          },
          onPointerenter: () => sound.play('hover'),
        },
        h('span.sel-chip__icon', xicon(iconName, { size: 15, strokeWidth: 2 })),
        h('span.sel-chip__check', icon('check', { size: 14, strokeWidth: 2.6 })),
        h('span.sel-chip__label', label),
      );
    }

    function skeletonNav() {
      return h(
        'div.sel-nav__skel',
        Array.from({ length: 8 }, (_, i) => h('span.sel-skel__line', { style: { width: `${[70, 52, 64, 48, 58, 44, 66, 50][i]}%` } })),
      );
    }

    function skeletonGrid() {
      const grid = h(
        'div.sel-grid',
        Array.from({ length: 12 }, () => h('div.sel-skel', h('span.sel-skel__icon'), h('span.sel-skel__lines', h('span.sel-skel__line'), h('span.sel-skel__line.sel-skel__line--w60')))),
      );
      scroll.replaceChildren(h('section.sel-sec.is-skeleton', { attrs: { 'aria-busy': 'true' } }, h('div.sel-sec__head', h('span.sel-skel__line.sel-skel__line--title')), grid));
    }

    function navGroup(label, items) {
      const list = items.filter(Boolean);
      if (!list.length) return null;
      return h('div.sel-nav__group', h('div.sel-nav__heading', label), list);
    }

    function navItem(id, label, iconName) {
      const countEl = h('span.sel-nav__count');
      const el = h(
        'button.sel-nav__item',
        {
          type: 'button',
          dataset: { view: id },
          attrs: { 'aria-current': 'false' },
          onClick: () => {
            sound.play('click');
            setView(id);
          },
          onPointerenter: () => sound.play('hover'),
        },
        h('span.sel-nav__icon', xicon(iconName, { size: 18 })),
        h('span.sel-nav__label', label),
        countEl,
      );
      navItems.set(id, { el, countEl, label });
      return el;
    }

    const viewLabel = (id) => (navItems.get(id) ? navItems.get(id).label : 'Alle Apps');

    // ================================================================ data
    async function ensureProfile() {
      const p = store.get('profile');
      if (p) return p;
      // Standalone (?screen=select&mode=restore): seed from the first profile the API finds.
      try {
        const refs = await api.profile.find();
        if (refs && refs[0]) {
          const loaded = await api.profile.load(refs[0].path);
          if (loaded) store.set('profile', loaded);
          return loaded || null;
        }
      } catch {
        /* fall back to catalog mode */
      }
      return null;
    }

    async function getMachine() {
      const m = store.get('machine');
      if (m) return m;
      try {
        const info = await api.system.info();
        if (info && alive) store.set('machine', info);
        return info || null;
      } catch {
        return null;
      }
    }

    function applyMode() {
      root.dataset.mode = mode;
      chipProfile.hidden = mode !== 'restore';
      const text = mode === 'restore' ? 'Was soll zurück?' : 'Was soll drauf?';
      if ((titleEl.dataset.splitText ?? titleEl.textContent) !== text) {
        titleTl?.kill();
        delete titleEl.dataset.splitText;
        titleEl.classList.remove('is-split');
        titleEl.removeAttribute('aria-label');
        titleEl.textContent = text;
      }
    }

    async function load() {
      skeletonGrid();
      const catalogP = Promise.resolve()
        .then(() => api.catalog.get())
        .then(
          (c) => ({ ok: true, c }),
          (err) => ({ ok: false, err }),
        );
      const [machine, cat, prof] = await Promise.all([getMachine(), catalogP, mode === 'restore' ? ensureProfile() : Promise.resolve(null)]);
      if (!alive) return;
      if (mode === 'restore' && !prof) {
        mode = 'catalog';
        applyMode();
        toast.info('Kein Profil geladen', 'Du siehst den Katalog – beliebte Apps sind schon ausgewählt.');
      }
      profile = prof;
      if (!cat.ok && (mode === 'catalog' || !(prof.apps || []).length)) return showLoadError(cat.err);
      if (!cat.ok) toast.warn('Katalog nicht verfügbar', 'Du siehst nur die Apps aus deinem Profil.');

      model = buildModel({ mode, profile, catalog: cat.ok ? cat.c : null, machine });
      initSelection();
      buildSide(machine);
      startBtn.setDisabled(false);
      setView(view, { first: true });
    }

    function showLoadError(err) {
      sideHead.replaceChildren();
      nav.replaceChildren(navThumb);
      const retry = [{ label: 'Erneut versuchen', icon: 'refresh', onClick: () => load() }];
      scroll.replaceChildren(
        h(
          'div.sel-empty',
          EmptyState({ icon: 'alert', title: 'Die App-Liste konnte nicht geladen werden', text: (err && err.message) || 'Unbekannter Fehler beim Laden des Katalogs.', actions: retry }),
        ),
      );
      hintEl.textContent = 'Ohne Katalog gibt es nichts zum Auswählen.';
      paintDockHint();
    }

    function initSelection() {
      const sig = `${mode}|${profile ? `${profile.createdAt}|${profile.machine && profile.machine.hostname}|${(profile.apps || []).length}|${(profile.games || []).length}` : 'catalog'}`;
      if (memory.sig === sig && memory.sel) {
        sel = new Set([...memory.sel].filter((k) => model.entries.has(k)));
        gameSel = new Set([...memory.gameSel].filter((k) => model.games.some((g) => g.key === k)));
        view = memory.view || view;
      } else {
        sel = new Set(mode === 'restore' ? model.profileKeys : model.popularKeys);
        gameSel = new Set(model.games.map((g) => g.key));
        view = mode === 'restore' && (model.profileKeys.length || model.games.length) ? 'profile' : 'all';
      }
      memory.sig = sig;
    }

    function buildSide(machine) {
      if (mode === 'restore' && profile) {
        const host = (profile.machine && profile.machine.hostname) || 'Dein Profil';
        const when = formatRelativeDate(profile.createdAt);
        sideHead.replaceChildren(
          h('span.sel-side__tile', icon('user', { size: 20 })),
          h(
            'div.sel-side__who',
            h('div.sel-side__eyebrow', 'Profil'),
            h('div.sel-side__name', { title: host }, host),
            h('div.sel-side__meta', when ? `Gesichert ${when}` : `${plural(model.profileKeys.length, 'App', 'Apps')}`),
          ),
        );
      } else {
        sideHead.replaceChildren(
          h('span.sel-side__tile', icon('sparkles', { size: 20 })),
          h('div.sel-side__who', h('div.sel-side__eyebrow', 'Ohne Profil'), h('div.sel-side__name', 'Schnell-Setup'), h('div.sel-side__meta', `Katalog · ${plural(model.entries.size, 'App', 'Apps')}`)),
        );
      }
      navItems.clear();
      const groups = [];
      if (mode === 'restore') {
        groups.push(navGroup('Aus deinem Profil', [navItem('profile', 'Alles aus dem Profil', 'user'), model.games.length ? navItem('games', 'Spiele', 'gamepad') : null]));
      }
      groups.push(navGroup('Übersicht', [navItem('all', 'Alle Apps', 'layers'), navItem('selected', 'Ausgewählt', 'check-circle')]));
      groups.push(navGroup('Kategorien', model.categories.map((c) => navItem(`cat:${c.name}`, c.name, CATEGORY_ICONS[c.name] || 'grid'))));
      nav.replaceChildren(navThumb, ...groups.filter(Boolean));

      const gpus = (machine && machine.gpus) || [];
      const g = model.gpu || (gpus[0] ? { name: gpus[0].name } : null);
      sideFoot.replaceChildren(
        g
          ? h(
              'div.sel-gpuchip',
              { title: g.name },
              h('span.sel-gpuchip__icon', xicon('gpu', { size: 16 })),
              h('span.sel-gpuchip__text', h('span.sel-gpuchip__l', 'Deine Grafikkarte'), h('span.sel-gpuchip__n', g.short || g.name)),
            )
          : null,
      );
      if (motionOK() && navItems.size) {
        gsap.fromTo(nav.querySelectorAll('.sel-nav__item, .sel-nav__heading'), { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.5, stagger: 0.022, ease: 'expo.out', delay: 0.2, clearProps: 'transform,opacity' });
      }
    }

    // ================================================================ views
    const allKeys = () => model.categories.flatMap((c) => c.keys);
    function keysOfView(id) {
      if (!model) return [];
      if (id === 'profile') return model.profileKeys;
      if (id === 'all') return allKeys();
      if (id === 'selected') return allKeys().filter((k) => sel.has(k));
      if (id.startsWith('cat:')) {
        const c = model.categories.find((x) => x.name === id.slice(4));
        return c ? c.keys : [];
      }
      return [];
    }
    const matches = (key) => !qTerms.length || qTerms.every((t) => model.entries.get(key).search.includes(t));
    const gameMatches = (g) => !qTerms.length || qTerms.every((t) => fold(`${g.title} ${PLATFORM_LABEL[g.platform] || ''} spiele games`).includes(t));
    const unmatchedMatches = (u) => !qTerms.length || qTerms.every((t) => fold(`${u.name} ${u.publisher || ''}`).includes(t));

    function sectionsFor(id) {
      const out = [];
      const gpuKey = model.gpu && model.gpu.key;
      const byCategory = (keys) => {
        const set = new Set(keys);
        for (const c of model.categories) {
          let ks = c.keys.filter((k) => set.has(k) && matches(k));
          if (!ks.length) continue;
          if (gpuKey && ks.includes(gpuKey)) ks = [gpuKey, ...ks.filter((k) => k !== gpuKey)];
          out.push({
            id: `sec:${c.name}`,
            kind: 'apps',
            title: c.name,
            icon: CATEGORY_ICONS[c.name] || 'grid',
            hint: c.name === OTHER ? 'Aus deinem Profil, ohne Kategorie' : '',
            keys: ks,
          });
        }
      };
      const gamesSection = (list) => {
        const games = list.filter(gameMatches);
        if (games.length) out.push({ id: 'sec:games', kind: 'games', title: 'Spiele', icon: 'gamepad', hint: 'Werden nach den Launchern über Epic/Steam installiert.', games });
      };
      const unmatchedSection = () => {
        const items = model.unmatched.filter(unmatchedMatches);
        if (items.length) out.push({ id: 'sec:unmatched', kind: 'unmatched', title: 'Nicht automatisch installierbar', icon: 'alert', hint: 'winget kennt sie nicht – lade sie später selbst', items });
      };
      if (id === 'profile') {
        byCategory(model.profileKeys);
        gamesSection(model.games);
        unmatchedSection();
      } else if (id === 'games') gamesSection(model.games);
      else if (id === 'selected') {
        byCategory(allKeys().filter((k) => sel.has(k)));
        gamesSection(model.games.filter((g) => gameSel.has(g.key)));
      } else byCategory(keysOfView(id));
      return out;
    }

    function setView(id, { first = false } = {}) {
      if (!model) return;
      if (!navItems.has(id)) id = navItems.has('all') ? 'all' : [...navItems.keys()][0];
      view = id;
      memory.view = id;
      for (const [vid, it] of navItems) {
        it.el.classList.toggle('is-active', vid === id);
        it.el.setAttribute('aria-current', vid === id ? 'true' : 'false');
      }
      root.dataset.view = id.startsWith('cat:') ? 'cat' : id;
      moveThumb(first);
      render({ first });
    }

    function moveThumb(instant) {
      const it = navItems.get(view);
      if (!it) return gsap.set(navThumb, { opacity: 0 });
      const vars = { y: it.el.offsetTop, height: it.el.offsetHeight, opacity: 1 };
      if (instant || !motionOK()) gsap.set(navThumb, vars);
      else gsap.to(navThumb, { ...vars, duration: 0.5, ease: 'expo.out', overwrite: true });
    }

    function setQuery(v) {
      query = String(v || '').trim();
      qTerms = fold(query).split(/\s+/).filter(Boolean);
      if (model) render({ quiet: true });
    }

    // ================================================================ rendering
    function render({ first = false, quiet = false } = {}) {
      rendered = [];
      const secs = sectionsFor(view);
      const nodes = [];
      const banner = gpuBannerFor(view);
      if (banner) nodes.push(banner);
      for (const s of secs) nodes.push(renderSection(s));
      if (!secs.length) nodes.push(emptyFor(view));
      scroll.replaceChildren(...nodes);
      scroll.scrollTop = 0;
      refresh();
      if (!quiet) animateIn(first);
    }

    function renderSection(s) {
      const countEl = h('span.sel-sec__count');
      const acts =
        s.kind === 'unmatched'
          ? null
          : h(
              'div.sel-sec__acts',
              mini('Alle', `Alles in „${s.title}“ auswählen.`, () => bulkSection(s, true)),
              mini('Keine', `Alles in „${s.title}“ abwählen.`, () => bulkSection(s, false)),
            );
      const headEl = h(
        'header.sel-sec__head',
        h(
          'div.sel-sec__bar',
          h('span.sel-sec__icon', xicon(s.icon, { size: 16, strokeWidth: 2 })),
          h('h2.sel-sec__title', s.title),
          countEl,
          s.hint ? h('span.sel-sec__hint', s.hint) : null,
          h('span.sel-sec__spacer'),
          acts,
        ),
      );
      let body;
      if (s.kind === 'apps') body = h('div.sel-grid', s.keys.map(cardFor));
      else if (s.kind === 'games') body = h('div.sel-games', launcherNote, h('div.sel-grid.sel-grid--games', s.games.map(gameCardFor)));
      else body = h('div.sel-grid', s.items.map(unmatchedCard));
      const el = h('section.sel-sec', { dataset: { sec: s.id, kind: s.kind } }, headEl, body);
      rendered.push({ ...s, countEl, el });
      return el;
    }

    function mini(label, text, onClick) {
      const b = h(
        'button.sel-mini',
        {
          type: 'button',
          title: text,
          onClick: () => {
            sound.play('click');
            onClick();
          },
        },
        label,
      );
      explain(b, text);
      return b;
    }

    function cardFor(key) {
      let c = cards.get(key);
      if (c) {
        if (c.selected !== sel.has(key)) c.setSelected(sel.has(key), { animate: false });
        return c;
      }
      const e = model.entries.get(key);
      c = AppCard({
        app: { key, name: e.name, desc: e.link ? 'Download-Seite öffnet sich am Ende' : e.desc, homepage: e.homepage, icon: e.icon },
        selected: sel.has(key),
        onToggle: (on) => {
          on ? sel.add(key) : sel.delete(key);
          scheduleRefresh();
        },
      });
      c.classList.add('sel-card');
      if (e.link) {
        c.classList.add('sel-card--link');
        c.append(h('span.sel-tag', { title: 'Nicht über winget verfügbar – Phoenix öffnet am Ende die Download-Seite.' }, icon('external', { size: 11, strokeWidth: 2.4 }), 'Manuell'));
        c.querySelector('.app-card__desc')?.setAttribute('title', e.desc || '');
      }
      if (mode === 'restore' && e.inProfile) c.querySelector('.app-card__icon')?.append(h('span.sel-pdot', { title: 'War in deinem Profil' }));
      if (model.gpu && key === model.gpu.key) {
        c.classList.add('sel-card--gpu', 'beam', 'deco');
        c.setBadge({ tone: 'accent', icon: 'sparkles', label: `Passend zu deiner ${model.gpu.short}` });
      }
      cards.set(key, c);
      return c;
    }

    function gameCardFor(g) {
      let c = gameCards.get(g.key);
      if (c) {
        if (c.checked !== gameSel.has(g.key)) c.setChecked(gameSel.has(g.key), { silent: true });
        return c;
      }
      c = GameCard({
        entry: g,
        selected: gameSel.has(g.key),
        onChange: (on) => {
          on ? gameSel.add(g.key) : gameSel.delete(g.key);
          scheduleRefresh();
        },
      });
      gameCards.set(g.key, c);
      return c;
    }

    function unmatchedCard(u) {
      const id = `${u.name}|${u.publisher || ''}`;
      if (unmatchedCards.has(id)) return unmatchedCards.get(id);
      const desc = [u.publisher, u.version ? `Version ${u.version}` : null].filter(Boolean).join(' · ') || 'Nicht über winget verfügbar';
      const c = AppCard({ app: { key: `unmatched:${id}`, name: u.name, desc }, selectable: false });
      c.classList.add('sel-card--unmatched');
      c.querySelector('.app-card__aside')?.append(
        h(
          'button.sel-web',
          {
            type: 'button',
            title: `„${u.name}“ im Browser suchen`,
            attrs: { 'aria-label': `${u.name} im Browser suchen` },
            onClick: () => {
              sound.play('click');
              Promise.resolve()
                .then(() => api.shell.open(`https://www.google.com/search?q=${encodeURIComponent(`${u.name} download`)}`))
                .catch(() => toast.error('Browser konnte nicht geöffnet werden'));
            },
          },
          icon('external', { size: 15, strokeWidth: 2 }),
          h('span', 'Suchen'),
        ),
      );
      unmatchedCards.set(id, c);
      return c;
    }

    // Launcher hint inside the games section ("Fortnite braucht den Epic Games Launcher").
    const launcherText = h('span.sel-note__text');
    const launcherBtn = h('button.sel-mini.sel-mini--accent', { type: 'button', onClick: () => addMissingLaunchers() }, 'Hinzufügen');
    const launcherNote = h('div.sel-note', { hidden: true, attrs: { role: 'status' } }, icon('alert', { size: 16, strokeWidth: 2 }), launcherText, launcherBtn);

    function missingLaunchers() {
      if (!model) return [];
      const platforms = new Set(model.games.filter((g) => gameSel.has(g.key)).map((g) => g.platform));
      return [...platforms].map((p) => LAUNCHER_KEYS[p]).filter((k) => k && model.entries.has(k) && !sel.has(k));
    }
    function addMissingLaunchers() {
      const keys = missingLaunchers();
      if (!keys.length) return;
      sound.play('click');
      setKeys(keys, true);
      scheduleRefresh();
    }

    // GPU spotlight (shown while the matching driver app is not selected).
    let gpuBanner = null;
    function gpuBannerFor(id) {
      const g = model.gpu;
      if (!g || qTerms.length || sel.has(g.key)) return null;
      const e = model.entries.get(g.key);
      if (!e || !(id === 'profile' || id === 'all' || id === `cat:${e.category}`)) return null;
      if (!gpuBanner) {
        const add = Button({
          label: 'Hinzufügen',
          icon: 'plus',
          variant: 'secondary',
          magnetic: false,
          onClick: () => {
            setKeys([g.key], true);
            const c = cards.get(g.key);
            if (c && richMotion()) gsap.fromTo(c, { scale: 0.94 }, { scale: 1, duration: 0.8, ease: 'elastic.out(1.1, 0.4)', clearProps: 'transform' });
            scheduleRefresh();
            collapseGpuBanner();
          },
        });
        cleanups.push(() => add.destroy());
        const text =
          g.vendor === 'nvidia'
            ? `Die NVIDIA App holt dir nach dem Reset den passenden Treiber für deine ${g.short}.`
            : 'Den Radeon-Treiber gibt es nicht über winget – Phoenix öffnet am Ende die AMD-Download-Seite.';
        gpuBanner = h(
          'div.sel-gpu',
          h('span.sel-gpu__glow.deco', { attrs: { 'aria-hidden': 'true' } }),
          h('span.sel-gpu__tile', xicon('gpu', { size: 24 })),
          h('div.sel-gpu__text', h('div.sel-gpu__eyebrow', 'Grafikkarte erkannt'), h('div.sel-gpu__name', `${e.name} für ${g.short}`), h('p.sel-gpu__desc', text)),
          add,
        );
        gpuBanner._add = add;
      }
      gpuBanner.classList.remove('is-done');
      gpuBanner._add.setLabel('Hinzufügen');
      gsap.set(gpuBanner, { clearProps: 'height,opacity,marginBottom,paddingTop,paddingBottom' });
      return gpuBanner;
    }
    function collapseGpuBanner() {
      const el = gpuBanner;
      if (!el || !el.isConnected) return;
      el.classList.add('is-done');
      el._add.setLabel('Hinzugefügt');
      sound.play('success');
      if (!motionOK()) return el.remove();
      gsap.to(el, { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginBottom: 0, duration: 0.5, delay: 0.9, ease: 'power3.inOut', onComplete: () => el.remove() });
    }

    function emptyFor(id) {
      let el;
      if (qTerms.length) {
        const elsewhere = id === 'all' ? 0 : allKeys().filter(matches).length;
        const actions = [];
        if (elsewhere) actions.push({ label: `In allen Apps suchen (${elsewhere})`, icon: 'search', onClick: () => setView('all') });
        actions.push({ label: 'Suche leeren', variant: elsewhere ? 'secondary' : 'primary', icon: 'x', onClick: () => search.clear() });
        el = EmptyState({
          icon: 'search',
          title: `Keine Treffer für „${query}“`,
          text: elsewhere ? `Hier nicht – aber in „Alle Apps“ gibt es ${plural(elsewhere, 'Treffer', 'Treffer')}.` : 'Probier einen anderen Namen oder die winget-ID, zum Beispiel „Discord.Discord“.',
          actions,
        });
      } else if (id === 'selected') {
        el = EmptyState({
          icon: 'check-circle',
          title: 'Noch nichts ausgewählt',
          text: 'Klick Apps an, die Phoenix installieren soll – oder nimm die Empfehlung für Gamer.',
          actions: [{ label: 'Empfohlene auswählen', icon: 'flame', onClick: () => togglePreset('gamer', { force: true }) }],
        });
      } else if (id === 'profile') {
        el = EmptyState({
          icon: 'user',
          title: 'Keine Apps im Profil',
          text: 'Dein Profil enthält nichts, was Phoenix automatisch installieren kann. Such dir was aus dem Katalog aus.',
          actions: [{ label: 'Alle Apps ansehen', icon: 'layers', onClick: () => setView('all') }],
        });
      } else {
        el = EmptyState({ icon: 'grid', title: 'Hier ist nichts', text: 'In diesem Bereich gibt es gerade keine Apps.' });
      }
      return h('div.sel-empty', el);
    }

    function animateIn(first) {
      if (!motionOK()) return;
      const els = [...scroll.querySelectorAll('.sel-gpu, .sel-sec__head, .sel-note:not([hidden]), .sel-grid > *, .sel-empty')].slice(0, 44);
      if (!els.length) return;
      const rich = richMotion();
      gsap.killTweensOf(els, 'opacity,y,scale');
      gsap.fromTo(
        els,
        rich ? { opacity: 0, y: 16, scale: 0.97 } : { opacity: 0 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: rich ? 0.6 : 0.25,
          ease: 'expo.out',
          stagger: rich ? 0.014 : 0.004,
          delay: first ? 0.3 : 0,
          clearProps: 'opacity,transform',
        },
      );
    }

    // ================================================================ selection changes
    function setKeys(keys, on) {
      let n = 0;
      for (const k of keys) {
        if (sel.has(k) === on) continue;
        on ? sel.add(k) : sel.delete(k);
        n++;
        const c = cards.get(k);
        if (c) c.setSelected(on, { animate: false });
      }
      return n;
    }
    function setGames(keys, on) {
      let n = 0;
      for (const k of keys) {
        if (gameSel.has(k) === on) continue;
        on ? gameSel.add(k) : gameSel.delete(k);
        n++;
        const c = gameCards.get(k);
        if (c) c.setChecked(on, { silent: true });
      }
      return n;
    }
    /** Light ripple across the visible cards that just changed. */
    function wave(keys) {
      if (!richMotion()) return;
      const box = scroll.getBoundingClientRect();
      const els = keys
        .map((k) => cards.get(k) || gameCards.get(k))
        .filter((c) => {
          if (!c || !c.isConnected) return false;
          const r = c.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom;
        })
        .slice(0, 48);
      if (els.length) gsap.fromTo(els, { scale: 0.955 }, { scale: 1, duration: 0.6, ease: 'back.out(2.2)', stagger: { each: 0.012, from: 'start' }, clearProps: 'transform' });
    }
    const snapshot = () => ({ sel: new Set(sel), gameSel: new Set(gameSel) });
    function restoreSnapshot(s) {
      for (const [k, c] of cards) if (c.selected !== s.sel.has(k)) c.setSelected(s.sel.has(k), { animate: false });
      for (const [k, c] of gameCards) if (c.checked !== s.gameSel.has(k)) c.setChecked(s.gameSel.has(k), { silent: true });
      sel = new Set(s.sel);
      gameSel = new Set(s.gameSel);
      scheduleRefresh();
      if (view === 'selected') render({ quiet: true });
    }
    function undoToast(title, message, snap) {
      toast.show({ type: 'info', title, message, duration: 5200, action: { label: 'Rückgängig', onClick: () => restoreSnapshot(snap) } });
    }

    function bulkSection(s, on) {
      const appKeys = s.keys || [];
      const games = s.games ? s.games.map((g) => g.key) : [];
      const n = setKeys(appKeys, on) + setGames(games, on);
      if (!n) return;
      wave([...appKeys, ...games]);
      scheduleRefresh();
    }

    function bulkView(on) {
      if (!model) return;
      const appKeys = rendered.flatMap((s) => s.keys || []);
      const games = rendered.flatMap((s) => (s.games ? s.games.map((g) => g.key) : []));
      const snap = snapshot();
      const n = setKeys(appKeys, on) + setGames(games, on);
      if (!n) {
        hintOverride = on ? 'Hier ist schon alles ausgewählt.' : 'Hier ist schon nichts ausgewählt.';
        paintHint();
        return;
      }
      wave([...appKeys, ...games]);
      scheduleRefresh();
      if (!on && n >= 5) undoToast(`${plural(n, 'Eintrag', 'Einträge')} abgewählt`, `In „${viewLabel(view)}“.`, snap);
    }

    function presetKeys(kind) {
      if (!model) return { keys: [], games: [] };
      return kind === 'gamer' ? { keys: model.popularKeys, games: [] } : { keys: model.profileKeys, games: model.games.map((g) => g.key) };
    }
    function isPresetActive(kind) {
      const { keys, games } = presetKeys(kind);
      return keys.length + games.length > 0 && keys.every((k) => sel.has(k)) && games.every((k) => gameSel.has(k));
    }
    function togglePreset(kind, { force = false } = {}) {
      if (!model) return;
      const { keys, games } = presetKeys(kind);
      const on = force || !isPresetActive(kind);
      const snap = snapshot();
      const n = setKeys(keys, on) + setGames(games, on);
      wave([...keys, ...games]);
      scheduleRefresh();
      if (view === 'selected') render({ quiet: true });
      const name = kind === 'gamer' ? 'Empfehlung für Gamer' : 'Alles aus dem Profil';
      if (n) undoToast(on ? `${plural(n, 'Eintrag', 'Einträge')} hinzugefügt` : `${plural(n, 'Eintrag', 'Einträge')} entfernt`, name, snap);
      hintOverride = null;
      paintHint();
    }

    // ================================================================ counters (one rAF per burst of changes)
    function scheduleRefresh() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (alive) refresh();
      });
    }

    function setNum(el, n) {
      const text = formatNumber(n);
      if (el.textContent === text) return;
      const up = n > Number(el.dataset.n || 0);
      el.dataset.n = String(n);
      el.textContent = text;
      if (motionOK()) gsap.fromTo(el, { y: up ? 9 : -9, opacity: 0.2 }, { y: 0, opacity: 1, duration: 0.32, ease: 'power3.out', clearProps: 'transform,opacity' });
    }

    function refresh() {
      if (!model) return;
      // sidebar
      for (const [id, it] of navItems) {
        let total = 0;
        let chosen = 0;
        if (id === 'games') {
          const gs = model.games.filter(gameMatches);
          total = gs.length;
          chosen = gs.filter((g) => gameSel.has(g.key)).length;
        } else if (id === 'selected') {
          total = allKeys().filter((k) => sel.has(k) && matches(k)).length + model.games.filter((g) => gameSel.has(g.key) && gameMatches(g)).length;
          chosen = -1;
        } else {
          const ks = keysOfView(id).filter(matches);
          total = ks.length;
          chosen = ks.filter((k) => sel.has(k)).length;
          if (id === 'profile') {
            const gs = model.games.filter(gameMatches);
            total += gs.length;
            chosen += gs.filter((g) => gameSel.has(g.key)).length;
          }
        }
        const label = chosen > 0 ? `${chosen} von ${total} ausgewählt` : chosen === -1 ? `${total} ausgewählt` : `${total}, nichts ausgewählt`;
        it.countEl.replaceChildren(...(chosen > 0 ? [h('b', formatNumber(chosen)), h('i', '/')] : []), h('span', formatNumber(total)));
        it.countEl.setAttribute('aria-label', label);
        it.el.classList.toggle('is-empty', total === 0);
        it.el.classList.toggle('has-sel', chosen > 0 || (chosen === -1 && total > 0));
      }
      // section heads
      for (const s of rendered) {
        if (s.kind === 'apps' || s.kind === 'games') {
          const keys = s.kind === 'apps' ? s.keys : s.games.map((g) => g.key);
          const set = s.kind === 'apps' ? sel : gameSel;
          const c = keys.filter((k) => set.has(k)).length;
          s.countEl.textContent = `${formatNumber(c)} von ${formatNumber(keys.length)}`;
          s.el.classList.toggle('is-full', c === keys.length);
        } else s.countEl.textContent = formatNumber(s.items.length);
      }
      // launcher hint
      const missing = missingLaunchers();
      launcherNote.hidden = !missing.length;
      if (missing.length) {
        const names = missing.map((k) => model.entries.get(k).name);
        launcherText.textContent = `Für deine Spiele fehlt ${joinList(names)}. Ohne Launcher kann Phoenix sie nicht installieren.`;
      }
      // chips
      chipGamer.setAttribute('aria-pressed', String(isPresetActive('gamer')));
      chipProfile.setAttribute('aria-pressed', String(isPresetActive('profile')));
      // dock
      let apps = 0;
      let links = 0;
      for (const k of sel) {
        const e = model.entries.get(k);
        if (!e) continue;
        if (e.link) links++;
        else apps++;
      }
      const games = model.games.filter((g) => gameSel.has(g.key)).length;
      setNum(nApps, apps);
      uApps.textContent = apps === 1 ? ' App' : ' Apps';
      setNum(nGames, games);
      uGames.textContent = games === 1 ? ' Spiel' : ' Spiele';
      setNum(nLinks, links);
      segGames.hidden = sepGames.hidden = !model.games.length;
      segLinks.hidden = sepLinks.hidden = !links;
      const total = apps + games + links;
      startBtn.setDisabled(total === 0 || starting);
      dock.classList.toggle('is-empty', total === 0);
      dock.dataset.total = String(total);
      paintDockHint();
      if (!hintOverride) paintHint();
      store.set('selection', new Set(sel));
      memory.sel = new Set(sel);
      memory.gameSel = new Set(gameSel);
    }

    function paintDockHint() {
      dockHint.classList.remove('is-explain');
      const total = Number(dock.dataset.total || 0);
      const apps = Number(nApps.dataset.n || 0);
      if (!model) dockHint.textContent = 'Einen Moment …';
      else if (!total) dockHint.textContent = 'Wähl mindestens eine App oder ein Spiel aus, um zu starten.';
      else if (!apps) dockHint.textContent = 'Nichts für winget dabei – Phoenix zeigt dir direkt Spiele und Download-Seiten.';
      else dockHint.textContent = 'Läuft nacheinander – du bestätigst nur einmal die Windows-Abfrage.';
      startBtn.title = total ? 'Installation starten (Strg+Enter)' : 'Erst etwas auswählen';
    }

    // ================================================================ start
    async function startInstall() {
      if (!model || starting) return;
      const job = buildInstallJob(model, sel, gameSel);
      const total = job.items.length + job.links.length + job.games.length;
      if (!total) {
        shake(startBtn);
        sound.play('error');
        return;
      }
      starting = true;
      startBtn.setDisabled(true);
      root.classList.add('is-launching');
      store.set('selection', new Set(sel));
      // Nothing for winget: skip the install run, "done" shows the links and the games button.
      store.set('installJob', job.items.length ? job : { ...job, result: { summary: { ...EMPTY_SUMMARY }, byKey: {}, durationMs: 0, elevation: null } });
      sound.play('rise');
      fx.burst?.();
      if (richMotion()) await flyIcons();
      if (!alive) return;
      const ok = await router.go(job.items.length ? 'install' : 'done', {}, { transition: 'warp' });
      if (!ok && alive) {
        starting = false;
        root.classList.remove('is-launching');
        scheduleRefresh();
      }
    }

    /** Selected icons in view fly into the start button. */
    function flyIcons() {
      const target = startBtn.getBoundingClientRect();
      const tx = target.left + target.width / 2;
      const ty = target.top + target.height / 2;
      const box = scroll.getBoundingClientRect();
      const sources = [...scroll.querySelectorAll('.app-card.is-selected .app-card__icon, .sel-game.is-on .sel-game__tile')]
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return r.bottom > box.top + 8 && r.top < box.bottom - 8;
        })
        .slice(0, 16);
      gsap.fromTo(startBtn, { scale: 1 }, { scale: 1.06, duration: 0.18, yoyo: true, repeat: 3, ease: 'power2.inOut' });
      if (!sources.length) return new Promise((r) => setTimeout(r, 280));
      const tl = gsap.timeline();
      sources.forEach((src, i) => {
        const r = src.getBoundingClientRect();
        const ghost = src.cloneNode(true);
        ghost.classList.add('sel-flyer');
        Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        document.body.append(ghost);
        flyers.add(ghost);
        const dx = tx - (r.left + r.width / 2);
        const dy = ty - (r.top + r.height / 2);
        const at = i * 0.035;
        tl.to(ghost, { x: dx, duration: 0.62, ease: 'power2.in' }, at)
          .to(ghost, { y: dy, duration: 0.62, ease: 'back.in(1.4)' }, at)
          .to(ghost, { scale: 0.3, rotate: (i % 2 ? 1 : -1) * 24, duration: 0.62, ease: 'power2.in' }, at)
          .to(ghost, { opacity: 0, duration: 0.14, onComplete: () => (ghost.remove(), flyers.delete(ghost)) }, at + 0.5);
      });
      return new Promise((resolve) => tl.eventCallback('onComplete', resolve));
    }

    // ================================================================ keyboard
    scroll.addEventListener('keydown', (e) => {
      const arrows = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 };
      if (!(e.key in arrows)) return;
      const cur = e.target.closest && e.target.closest('.sel-grid > .app-card[role="checkbox"]');
      if (!cur) return;
      const list = [...scroll.querySelectorAll('.sel-grid > .app-card[role="checkbox"]')];
      const i = list.indexOf(cur);
      let next = null;
      if (Math.abs(arrows[e.key]) === 1) next = list[i + arrows[e.key]];
      else {
        const r = cur.getBoundingClientRect();
        const down = arrows[e.key] > 0;
        let bestRow = Infinity;
        let bestX = Infinity;
        for (const c of list) {
          const cr = c.getBoundingClientRect();
          const dy = down ? cr.top - r.top : r.top - cr.top;
          if (dy < 8) continue;
          const dx = Math.abs(cr.left - r.left);
          if (dy < bestRow - 4 || (Math.abs(dy - bestRow) <= 4 && dx < bestX)) {
            bestRow = dy;
            bestX = dx;
            next = c;
          }
        }
      }
      if (next) {
        e.preventDefault();
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest', behavior: motionOK() ? 'smooth' : 'auto' });
      }
    });

    nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...nav.querySelectorAll('.sel-nav__item')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });

    const onKey = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !container.inert && !container.closest('[inert]')) {
        e.preventDefault();
        startInstall();
      }
    };
    window.addEventListener('keydown', onKey);
    cleanups.push(() => window.removeEventListener('keydown', onKey));

    const onResize = () => moveThumb(true);
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));

    load().catch((err) => {
      console.error('[select] load failed', err);
      if (alive) showLoadError(err);
    });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (model) {
        memory.sel = new Set(sel);
        memory.gameSel = new Set(gameSel);
        memory.view = view;
      }
      flyers.forEach((f) => f.remove());
      flyers.clear();
      gsap.killTweensOf(navThumb);
      cleanups.forEach((fn) => fn && fn());
    };
  },
};
