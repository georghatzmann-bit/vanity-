// Shared placeholder layout for screens that feature agents will replace.
import '../styles/screens/stub.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';
import { revealText } from '../core/motion.js';

/**
 * Renders a placeholder screen.
 * stubScreen(container, ctx, { name, eyebrow, title, lead, icon, upcoming: string[], actions?: Node[] })
 * Returns a cleanup function.
 */
export function stubScreen(container, ctx, { name, eyebrow, title, lead, icon: iconName = 'sparkles', upcoming = [], actions = [] }) {
  const titleEl = h('h1.page-head__title', title);
  const homeBtn = Button({
    label: 'Zur Startseite',
    icon: 'arrow-left',
    variant: name === 'home' ? 'secondary' : 'primary',
    size: 'lg',
    onClick: () => ctx.router.go('home', {}, { transition: 'slide', direction: 'back' }),
  });

  const inner = h(
    'div.screen__inner.stub',
    h('div.stub__glyph.deco', { attrs: { 'aria-hidden': 'true' } }, icon(iconName, { size: 360, strokeWidth: 0.6 })),
    h(
      'header.page-head',
      h('button.back-link', { type: 'button', dataset: { stagger: '' }, onClick: () => ctx.router.back() }, icon('arrow-left'), 'Zurück'),
      h('div.t-eyebrow', { dataset: { stagger: '' } }, h('span.stub__pulse'), eyebrow),
      titleEl,
      h('p.page-head__lead', { dataset: { stagger: '' } }, lead),
    ),
    h(
      'section.card.stub__card',
      { dataset: { stagger: '' } },
      h('div.stub__card-head', h('div.icon-tile', icon(iconName)), h('div', h('div.card__title', 'Was hier entsteht'), h('p.card__text', 'Dieser Bereich ist ein Platzhalter. Die fertige Version kommt als Nächstes.'))),
      h(
        'ul.stub__list',
        upcoming.map((t) => h('li', h('span.stub__check', icon('check', { size: 14, strokeWidth: 2.25 })), h('span', t))),
      ),
    ),
    h('div.stub__actions', { dataset: { stagger: '' } }, ...actions, homeBtn),
  );
  container.append(inner);
  const tl = revealText(titleEl, { delay: 0.3 });
  return () => {
    tl?.kill();
    homeBtn.destroy();
  };
}
