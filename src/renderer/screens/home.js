// PLACEHOLDER home hub – feature agents may extend/replace it (keep the contract).
// With ?demo=1 a component gallery is appended (dev only).
import '../styles/screens/home.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';
import { Card } from '../components/card.js';
import { revealText, scrambleText } from '../core/motion.js';

export default {
  title: 'Startseite',
  fxState: 'home',
  async mount(container, ctx) {
    const { router, api, store } = ctx;
    const cleanups = [];
    const go = (name, transition = 'warp') => router.go(name, {}, { transition });

    const line1 = h('span.home__line', 'Dein PC.');
    const line2 = h('span.home__line.t-grad.t-shine.deco', 'Neu geboren.');
    const title = h('h1.t-hero.home__title', line1, line2);
    const status = h('span.home__status-text', 'Bereit');

    const backupBtn = Button({ label: 'Jetzt sichern', icon: 'shield', variant: 'primary', size: 'lg', onClick: () => go('backup') });
    const restoreBtn = Button({ label: 'Wiederherstellen', icon: 'download', variant: 'secondary', size: 'lg', onClick: () => go('restore') });
    cleanups.push(() => backupBtn.destroy(), () => restoreBtn.destroy());

    const backupCard = Card(
      { variant: 'hero', tilt: { max: 3 }, className: 'home__action' },
      h('div.home__action-top', h('div.icon-tile.icon-tile--lg', icon('shield')), h('span.home__step', '01')),
      h('div.t-eyebrow', 'Vor dem Reset'),
      h('h2.home__action-title', 'Sichern'),
      h('p.home__action-text', 'Findet alle Apps und Spiele auf diesem PC und speichert die Liste auf USB-Stick, Festplatte oder als Code.'),
      h('div.home__action-foot', backupBtn, h('span.hint', 'Dauert etwa eine Minute')),
    );
    const restoreCard = Card(
      { tilt: { max: 3 }, className: 'home__action' },
      h('div.home__action-top', h('div.icon-tile.icon-tile--lg', icon('download')), h('span.home__step', '02')),
      h('div.t-eyebrow', 'Nach dem Reset'),
      h('h2.home__action-title', 'Wiederherstellen'),
      h('p.home__action-text', 'Findet deine Sicherung automatisch und installiert alles wieder – leise im Hintergrund, mit Live-Fortschritt.'),
      h('div.home__action-foot', restoreBtn, h('span.hint', 'Per Stick, Datei oder Code')),
    );
    cleanups.push(() => backupCard.destroy(), () => restoreCard.destroy());

    const machineChip = h('div.home__machine', { hidden: true });
    const quick = h(
      'button.home__quick',
      { type: 'button', onClick: () => go('select', 'slide'), onPointerenter: () => ctx.sound.play('hover') },
      icon('zap'),
      h('span', h('b', 'Keine Sicherung?'), ' Starte mit beliebten Apps'),
      icon('arrow-right'),
    );

    const inner = h(
      'div.screen__inner.home',
      h(
        'section.home__hero',
        h('div.home__badge', { dataset: { stagger: '' } }, h('span.home__dot'), status, h('span.home__sep'), h('span.c-muted', 'Deine Apps überleben den Windows-Reset')),
        title,
        h(
          'p.home__lead',
          { dataset: { stagger: '' } },
          'Sichere vor dem Reset alle Apps und Spiele – und hol sie danach mit einem Klick zurück. Ohne Suchen, ohne Setup-Dateien.',
        ),
      ),
      h('section.home__actions', h('div', { dataset: { stagger: '' } }, backupCard), h('div', { dataset: { stagger: '' } }, restoreCard)),
      h('footer.home__foot', { dataset: { stagger: '' } }, quick, machineChip),
    );
    container.append(inner);

    const tl = revealText(line1, { delay: 0.25 });
    const tl2 = revealText(line2, { delay: 0.45 });
    cleanups.push(() => tl?.kill(), () => tl2?.kill());
    const sc = scrambleText(status, 'Bereit', { duration: 0.8, delay: 0.3 });
    cleanups.push(() => sc.cancel());

    api.system
      .info()
      .then((m) => {
        if (!m || !container.isConnected) return;
        store.set('machine', m);
        const gpu = m.gpus && m.gpus[0] ? m.gpus[0].name.replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, '') : '';
        machineChip.replaceChildren(
          icon('cpu', { size: 16 }),
          h('span', m.hostname),
          h('span.home__sep'),
          h('span.c-muted', `${m.os.caption}${m.os.displayVersion ? ` ${m.os.displayVersion}` : ''}`),
          gpu ? h('span.home__sep') : null,
          gpu ? h('span.c-muted', gpu) : null,
        );
        machineChip.hidden = false;
      })
      .catch(() => {});

    if (new URLSearchParams(location.search).get('demo') === '1') {
      const { renderDemo } = await import('./_demo.js');
      cleanups.push(renderDemo(inner, ctx));
    }

    return () => cleanups.forEach((fn) => fn && fn());
  },
};
