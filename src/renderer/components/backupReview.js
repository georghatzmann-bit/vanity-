// Backup review phase: "37 Apps & 4 Spiele erfasst." headline, warnings, tabs with the app grid
// (grouped by category), game cards and the "manuell" list, sticky "Sicherung speichern" bar.
//
//   const review = BackupReview({ onSave })
//   review.render({ scan, catalog: Map<'source:id', CatalogItem>, durationMs })
//   review.enter()  – choreographed entrance (call after the section is visible)
//   review.focus() · review.destroy()
import { h, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { Button } from './button.js';
import { AppCard, monogram, monogramGradient } from './appCard.js';
import { Segmented } from './segmented.js';
import { Badge } from './badge.js';
import { EmptyState } from './emptyState.js';
import { gsap, motionOK, richMotion, countUp, tilt } from '../core/motion.js';
import { formatBytes, formatDuration, plural } from '../core/format.js';

const OTHER = 'Weitere Apps';
const PLATFORM = {
  epic: { label: 'Epic Games', hint: 'Nach dem Reset im Epic Games Launcher installieren.' },
  steam: { label: 'Steam', hint: 'Nach dem Reset in Steam installieren.' },
  other: { label: 'Spiel', hint: 'Nach dem Reset im passenden Launcher installieren.' },
};

export const appKey = (a) => `${a.source || 'winget'}:${String(a.id || a.name || '').toLowerCase()}`;

/** One-line description for a scanned app: catalog text, else publisher / version, else the id. */
function describe(app, hit) {
  if (hit && hit.desc) return hit.desc;
  const parts = [app.publisher, app.version && app.version !== 'Unknown' ? `Version ${app.version}` : null].filter(Boolean);
  if (app.source === 'msstore') parts.push('Microsoft Store');
  return parts.join(' · ') || app.id || '';
}

function groupApps(apps, catalog, order) {
  const groups = new Map();
  for (const a of apps) {
    const hit = catalog.get(appKey(a));
    const cat = a.category || (hit && hit.category) || OTHER;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ a, hit });
  }
  const rank = (c) => (c === OTHER ? 1e6 : order.indexOf(c) >= 0 ? order.indexOf(c) : 1e3);
  return [...groups.entries()]
    .sort(([x], [y]) => rank(x) - rank(y) || x.localeCompare(y, 'de'))
    .map(([name, list]) => ({ name, list: list.sort((p, q) => String(p.a.name).localeCompare(String(q.a.name), 'de')) }));
}

function GameCard(game) {
  const p = PLATFORM[game.platform] || PLATFORM.other;
  const title = String(game.title || 'Unbenanntes Spiel');
  const art = h(
    'div.bk-game__art',
    { style: { '--g-bg': monogramGradient(title) } },
    h('span.bk-game__mono', { attrs: { 'aria-hidden': 'true' } }, monogram(title)),
    h('span.bk-game__glyph', { attrs: { 'aria-hidden': 'true' } }, icon('gamepad', { size: 120, strokeWidth: 0.9 })),
    h('div.bk-game__badges', Badge({ tone: 'neutral', label: p.label, icon: 'gamepad' })),
  );
  const size = Number(game.sizeBytes) > 0 ? formatBytes(game.sizeBytes) : null;
  const el = h(
    'article.bk-game',
    { attrs: { 'aria-label': `${title}, ${p.label}${size ? `, ${size}` : ''}` } },
    art,
    h(
      'div.bk-game__body',
      h('div.bk-game__title', { title }, title),
      h('div.bk-game__meta', h('span', p.label), size ? h('span.bk-dot') : null, size ? h('span.t-num', size) : null),
      h('p.bk-game__hint', p.hint),
    ),
  );
  return el;
}

function ManualRow(u) {
  const name = String(u.name || 'Unbekanntes Programm');
  const meta = [u.publisher, u.version ? `Version ${u.version}` : null].filter(Boolean).join(' · ');
  return h(
    'li.bk-manual__row',
    h('span.bk-manual__mono', { style: { '--mono-bg': monogramGradient(name) }, attrs: { 'aria-hidden': 'true' } }, monogram(name)),
    h('div.bk-manual__body', h('div.bk-manual__name', { title: name }, name), h('div.bk-manual__meta', meta || 'Kein Hersteller angegeben')),
    h('span.bk-manual__tag', icon('download', { size: 14, strokeWidth: 2 }), 'Beim Hersteller laden'),
  );
}

export function BackupReview({ onSave } = {}) {
  const titleId = nextId('bk-rev');
  const el = h('section.bk-phase.bk-review', { hidden: true, attrs: { 'aria-labelledby': titleId } });
  const cleanups = [];
  const tweens = [];
  let tabs = null;
  let panels = {};
  let titleEl = null;
  let nums = [];
  let current = 'apps';
  let saveBtn = null;

  const track = (t) => (t && tweens.push(t), t);

  function destroyContent() {
    cleanups.splice(0).forEach((fn) => fn());
    tweens.splice(0).forEach((t) => t.kill());
    tabs?.destroy();
    saveBtn?.destroy();
    tabs = null;
    saveBtn = null;
    el.replaceChildren();
  }

  function renderApps(apps, catalog, order) {
    if (!apps.length) {
      return EmptyState({
        icon: 'grid',
        title: 'Keine Apps erkannt',
        text: 'winget hat nichts gemeldet. Du kannst trotzdem speichern – Spiele und Hardware-Infos sind dabei.',
        compact: true,
      });
    }
    const wrap = h('div.bk-groups');
    for (const g of groupApps(apps, catalog, order)) {
      const grid = h('div.bk-grid');
      for (const { a, hit } of g.list) {
        grid.append(
          AppCard({
            app: { key: appKey(a), name: a.name || a.id, desc: describe(a, hit), icon: a.icon, homepage: hit && hit.homepage },
            selectable: false,
          }),
        );
      }
      wrap.append(
        h(
          'section.bk-group',
          h('header.bk-group__head', h('h3.bk-group__title', g.name), h('span.bk-group__count.t-num', String(g.list.length)), h('span.bk-group__line')),
          grid,
        ),
      );
    }
    return wrap;
  }

  function renderGames(games) {
    if (!games.length) {
      return EmptyState({
        icon: 'gamepad',
        title: 'Keine Spiele gefunden',
        text: 'Epic- und Steam-Bibliotheken waren leer oder die Launcher sind nicht installiert.',
        compact: true,
      });
    }
    const grid = h('div.bk-games');
    for (const g of games) {
      const card = GameCard(g);
      cleanups.push(tilt(card, { max: 6, scale: 1.02 }));
      grid.append(card);
    }
    const total = games.reduce((s, g) => s + (Number(g.sizeBytes) || 0), 0);
    return h(
      'div',
      h(
        'p.bk-panel-note',
        icon('info', { size: 16, strokeWidth: 2 }),
        h(
          'span',
          'Spiele lädt nach dem Reset der Launcher – Phoenix öffnet dir direkt die Installationsseite.',
          total ? ` Zusammen ${formatBytes(total)}.` : '',
        ),
      ),
      grid,
    );
  }

  function renderManual(unmatched) {
    if (!unmatched.length) {
      return EmptyState({
        icon: 'check-circle',
        title: 'Alles abgedeckt',
        text: 'winget kennt jedes deiner Programme – nach dem Reset musst du nichts von Hand laden.',
        compact: true,
      });
    }
    return h(
      'div',
      h(
        'p.bk-panel-note.bk-panel-note--warn',
        icon('alert', { size: 16, strokeWidth: 2 }),
        h('span', h('b', 'Manuell: '), 'Diese Programme kennt winget nicht – lade sie nach dem Reset beim Hersteller. Die Liste steht trotzdem in deiner Sicherung.'),
      ),
      h('ul.bk-manual', unmatched.map(ManualRow)),
    );
  }

  function machineLine(m) {
    if (!m) return null;
    const gpu = m.gpus && m.gpus[0] ? String(m.gpus[0].name).replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, '') : '';
    const os = m.os ? `${m.os.caption || ''}${m.os.displayVersion ? ` ${m.os.displayVersion}` : ''}`.trim() : '';
    const parts = [m.hostname, os, gpu, m.ramGB ? `${m.ramGB} GB RAM` : ''].filter(Boolean);
    if (!parts.length) return null;
    return h(
      'div.bk-rev__machine',
      icon('cpu', { size: 16, strokeWidth: 2 }),
      h('span.bk-rev__machine-parts', parts.map((p, i) => [i ? h('span.bk-dot') : null, h('span', p)])),
      h('span.bk-rev__machine-hint', '· Hardware-Infos für Treiber-Tipps sind dabei'),
    );
  }

  function headline(appCount, gameCount) {
    nums = [];
    const n = (v) => {
      const s = h('span.bk-rev__num.t-num', '0');
      s.dataset.to = String(v);
      nums.push(s);
      return s;
    };
    const t = h('h1.bk-rev__title', { id: titleId, tabIndex: -1 });
    if (!appCount && !gameCount) {
      t.append('Nichts gefunden – ', h('span.t-grad', 'trotzdem sichern?'));
      return t;
    }
    if (appCount) t.append(n(appCount), ` ${plural(appCount, 'App', 'Apps', { withNumber: false })}`);
    if (appCount && gameCount) t.append(h('span.bk-rev__amp', ' & '));
    if (gameCount) t.append(n(gameCount), ` ${plural(gameCount, 'Spiel', 'Spiele', { withNumber: false })}`);
    t.append(h('span.bk-rev__tail', ' erfasst.'));
    return t;
  }

  function showPanel(name, animate = true) {
    current = name;
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
    const panel = panels[name];
    if (!animate || !motionOK() || !panel) return;
    const kids = panel.querySelectorAll('.app-card, .bk-game, .bk-manual__row, .bk-group__head, .bk-panel-note, .empty');
    const visible = [...kids].slice(0, 48);
    track(
      gsap.fromTo(
        visible,
        { opacity: 0, y: 14, filter: richMotion() ? 'blur(6px)' : 'none' },
        { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.5, ease: 'expo.out', stagger: { each: 0.012, from: 'start' }, clearProps: 'opacity,transform,filter' },
      ),
    );
  }

  const api = {
    el,
    render({ scan, catalog = new Map(), catalogOrder = [], durationMs = 0 }) {
      destroyContent();
      const apps = scan.apps || [];
      const games = scan.games || [];
      const unmatched = scan.unmatched || [];
      const warnings = (scan.warnings || []).filter(Boolean);

      const vault = h(
        'div.bk-vault',
        { attrs: { 'aria-hidden': 'true' } },
        h('span.bk-vault__ring.deco'),
        h('span.bk-vault__core', icon('shield-check', { size: 26, strokeWidth: 1.9 })),
        h('span.bk-vault__shock'),
      );
      titleEl = headline(apps.length, games.length);

      const eyebrow = h(
        'div.t-eyebrow.bk-rev__eyebrow',
        h('span.bk-live-dot.bk-live-dot--ok'),
        'Scan abgeschlossen',
        durationMs > 0 ? h('span.bk-rev__took', `· ${formatDuration(durationMs)}`) : null,
      );
      const lead = h('p.bk-rev__lead', 'Gespeichert wird alles – aussuchen kannst du nach dem Reset.');
      const head = h('header.bk-rev__head', vault, h('div.bk-rev__titles', eyebrow, titleEl, lead, machineLine(scan.machine)));

      let warnEl = null;
      if (warnings.length) {
        warnEl = h(
          'div.bk-warn',
          { attrs: { role: 'status' } },
          h('span.bk-warn__icon', icon('alert', { size: 18, strokeWidth: 2 })),
          h(
            'div.bk-warn__body',
            h('div.bk-warn__title', warnings.length === 1 ? 'Hinweis zum Scan' : `${warnings.length} Hinweise zum Scan`),
            h('ul.bk-warn__list', warnings.slice(0, 6).map((w) => h('li', String(w)))),
            h('p.bk-warn__foot', 'Die Sicherung funktioniert trotzdem – sie enthält alles, was gefunden wurde.'),
          ),
        );
      }

      tabs = Segmented({
        ariaLabel: 'Ansicht',
        value: 'apps',
        options: [
          { value: 'apps', label: 'Apps', icon: 'grid' },
          { value: 'games', label: 'Spiele', icon: 'gamepad' },
          { value: 'manual', label: 'Manuell', icon: 'list' },
        ],
        onChange: (v) => showPanel(v),
      });
      tabs.classList.add('bk-tabs');
      const counts = { apps: apps.length, games: games.length, manual: unmatched.length };
      for (const btn of tabs.querySelectorAll('.segmented__opt')) {
        btn.append(h('span.bk-tabs__count.t-num', String(counts[btn.dataset.value] ?? 0)));
        btn.setAttribute('aria-controls', `${titleId}-${btn.dataset.value}`);
      }

      panels = {
        apps: h('div.bk-panel', { id: `${titleId}-apps`, attrs: { role: 'region', 'aria-label': 'Apps' } }, renderApps(apps, catalog, catalogOrder)),
        games: h('div.bk-panel', { id: `${titleId}-games`, attrs: { role: 'region', 'aria-label': 'Spiele' }, hidden: true }, renderGames(games)),
        manual: h('div.bk-panel', { id: `${titleId}-manual`, attrs: { role: 'region', 'aria-label': 'Manuell' }, hidden: true }, renderManual(unmatched)),
      };

      saveBtn = Button({ label: 'Sicherung speichern', variant: 'primary', size: 'xl', iconRight: 'arrow-right', onClick: () => onSave?.() });
      const cta = h(
        'div.bk-cta',
        h(
          'div.bk-cta__inner',
          h(
            'div.bk-cta__text',
            h('div.bk-cta__title', icon('check-circle', { size: 18, strokeWidth: 2 }), 'Alles erfasst – nichts auszuwählen.'),
            h('div.bk-cta__hint', 'Als Nächstes wählst du den Speicherort. Am sichersten: ein USB-Stick.'),
          ),
          saveBtn,
        ),
      );

      el.append(
        ...[
          head,
          warnEl,
        ].filter(Boolean),
        h('div.bk-rev__bar', tabs, h('p.bk-rev__bar-hint', 'Nur zur Übersicht – du musst hier nichts anklicken.')),
        h('div.bk-panels', panels.apps, panels.games, panels.manual),
        cta,
      );
      current = 'apps';
    },

    /** Entrance after the section became visible. */
    enter() {
      const vault = el.querySelector('.bk-vault');
      const head = el.querySelector('.bk-rev__head');
      if (!motionOK()) {
        nums.forEach((n) => (n.textContent = new Intl.NumberFormat('de-DE').format(Number(n.dataset.to))));
        return;
      }
      const rich = richMotion();
      const tl = track(gsap.timeline());
      tl.fromTo(
        vault,
        { scale: rich ? 0.2 : 0.8, opacity: 0, rotate: rich ? -60 : 0 },
        { scale: 1, opacity: 1, rotate: 0, duration: 0.9, ease: 'back.out(2.2)', clearProps: 'transform,opacity' },
        0,
      );
      if (rich) {
        tl.fromTo(el.querySelector('.bk-vault__shock'), { scale: 0.6, opacity: 0.9 }, { scale: 2.6, opacity: 0, duration: 1.1, ease: 'expo.out' }, 0.15);
      }
      const parts = [...head.querySelectorAll('.bk-rev__eyebrow, .bk-rev__title, .bk-rev__lead, .bk-rev__machine')];
      const rest = [...el.querySelectorAll(':scope > .bk-warn, :scope > .bk-rev__bar, :scope > .bk-cta')];
      tl.fromTo(
        parts,
        { opacity: 0, y: 18, filter: rich ? 'blur(8px)' : 'none' },
        { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.8, ease: 'expo.out', stagger: 0.07, clearProps: 'opacity,transform,filter' },
        0.1,
      );
      nums.forEach((n, i) => {
        const tw = countUp(n, Number(n.dataset.to), { duration: 1.5, delay: 0.25 + i * 0.15, ease: 'power3.out' });
        track(tw);
      });
      tl.fromTo(
        rest,
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.7, ease: 'expo.out', stagger: 0.08, clearProps: 'opacity,transform' },
        0.35,
      );
      tl.call(() => showPanel(current, true), null, 0.45);
      // Panel cards are hidden until their cascade starts.
      const first = panels[current]?.querySelectorAll('.app-card, .bk-game, .bk-manual__row, .bk-group__head, .bk-panel-note, .empty');
      if (first?.length) gsap.set([...first].slice(0, 48), { opacity: 0 });
    },

    focus() {
      titleEl?.focus({ preventScroll: true });
    },

    destroy() {
      destroyContent();
    },
  };
  return api;
}
