// "Frischer Start" without a backup: Basic / Premium / Gaming. Builds a profile and hands it to the
// normal flow (select -> install -> games -> done -> Einrichten). Basic has no apps and goes straight
// to "Einrichten".
import '../styles/screens/setup.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';
import { Card } from '../components/card.js';
import { PACKAGES, GAME_OPTIONS, buildPackageProfile } from '../core/packages.js';

export default {
  title: 'Pakete',
  fxState: 'home',
  mount(container, ctx) {
    const { api, store, router, sound, fx, toast } = ctx;
    const cleanups = [];
    const picked = new Set(['fortnite']);
    let catalogP = api.catalog.get().catch(() => ({ items: [] }));

    const gamePicker = h(
      'div.pk-games',
      GAME_OPTIONS.map((g) =>
        h(
          'button.pk-game',
          {
            type: 'button',
            class: picked.has(g.key) ? 'is-on' : '',
            attrs: { 'aria-pressed': String(picked.has(g.key)) },
            onClick: (ev) => {
              const on = !picked.has(g.key);
              if (on) picked.add(g.key);
              else picked.delete(g.key);
              ev.currentTarget.classList.toggle('is-on', on);
              ev.currentTarget.setAttribute('aria-pressed', String(on));
              sound.play(on ? 'click' : 'hover');
            },
          },
          icon(on(g.key) ? 'check' : 'plus', { size: 14 }),
          g.title,
        ),
      ),
    );
    function on(key) {
      return picked.has(key);
    }
    // keep the check/plus glyph in sync with the state
    gamePicker.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.pk-game');
      if (btn) btn.querySelector('svg').replaceWith(icon(btn.classList.contains('is-on') ? 'check' : 'plus', { size: 14 }));
    });

    async function choose(pkg) {
      fx?.pulse?.(0.9);
      const catalog = await catalogP;
      const machine = store.get('machine') || (await api.system.info().catch(() => null));
      const profile = buildPackageProfile(pkg, pkg.games ? picked : new Set(), catalog.items || [], machine);
      store.set('profile', profile);
      store.set('selection', null);
      if (!profile.apps.length && !profile.games.length) router.go('setup', { maximize: true }, { transition: 'warp' });
      else {
        toast.info(`Paket ${pkg.name}`, 'Prüf die Auswahl – danach geht es automatisch weiter. Monitore & Einstellungen kommen am Ende.');
        router.go('select', { mode: 'restore' }, { transition: 'warp' });
      }
    }

    const cards = PACKAGES.map((pkg, i) => {
      const btn = Button({ label: `${pkg.name} wählen`, icon: 'arrow-right', variant: i === 2 ? 'primary' : 'secondary', size: 'lg', block: true, onClick: () => choose(pkg) });
      cleanups.push(() => btn.destroy());
      const card = Card(
        { variant: i === 2 ? 'hero' : 'default', tilt: { max: 3 }, className: `pk-card pk-card--${pkg.id}` },
        h('div.pk-card__top', h('div.icon-tile.icon-tile--lg', icon(pkg.icon)), h('span.pk-card__tier', String(i + 1).padStart(2, '0'))),
        h('h2.pk-card__name', pkg.name),
        h('p.pk-card__tag.c-muted', pkg.tagline),
        h('ul.pk-card__list', pkg.points.map((p) => h('li', icon('check', { size: 14 }), h('span', p)))),
        pkg.games ? h('div.pk-card__games', h('div.t-eyebrow', 'Deine Spiele'), gamePicker) : null,
        h('div.pk-card__foot', btn),
      );
      cleanups.push(() => card.destroy());
      return h('div', { dataset: { stagger: '' } }, card);
    });

    container.append(
      h(
        'div.screen__inner.pk',
        h(
          'header.su-head',
          { dataset: { stagger: '' } },
          h('div.t-eyebrow', 'Frischer Start · ohne Sicherung'),
          h('h1.t-h1', 'Wähl dein ', h('span.t-grad', 'Paket')),
          h('p.t-lead.c-muted', 'Phoenix richtet deinen frisch zurückgesetzten PC ein – du siehst vorher genau, was passiert, und kannst alles abwählen.'),
        ),
        h('div.pk-grid', cards),
      ),
    );

    return () => {
      catalogP = null;
      cleanups.forEach((fn) => fn && fn());
    };
  },
};
