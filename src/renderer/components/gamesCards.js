// Games screen building blocks: action buttons with a grey hint, per-card feedback line,
// premium game tiles, the Fortnite hero card and launcher sections.
import { h, nextId } from '../core/dom.js';
import { icon } from './icons.js';
import { Button } from './button.js';
import { Badge } from './badge.js';
import { gsap, tilt, pop, motionOK, richMotion } from '../core/motion.js';
import { sound } from '../core/sound.js';
import { PLATFORMS, platformOf, cleanTitle, formatGameSize, gameKey, coverArt, hasMsStore, totalBytes } from './gamesArt.js';
import { plural } from '../core/format.js';
import { shockwave } from './gamesFx.js';

// ---------------------------------------------------------------------------------------------
// Action = button + one-line grey explanation (aria-describedby).
// ---------------------------------------------------------------------------------------------

export function ActionBlock({ label, variant = 'secondary', size = 'md', icon: iconName, iconRight, hint = '', block = false, inline = false, onClick, className = '' } = {}) {
  const hintId = nextId('gact');
  const btn = Button({ label, variant, size, icon: iconName, iconRight, block, magnetic: false, onClick });
  btn.setAttribute('aria-describedby', hintId);
  const hintEl = h('span.gact__hint', { id: hintId }, hint);
  const el = h(`div.gact${inline ? '.gact--inline' : ''}${block ? '.gact--block' : ''}`, { class: className }, btn, hintEl);
  return Object.assign(el, {
    btn,
    setHint(text) {
      hintEl.textContent = text;
      return el;
    },
    setDisabled(on) {
      btn.setDisabled(on);
      el.classList.toggle('is-disabled', !!on);
      return el;
    },
    setLoading(on) {
      btn.setLoading(on);
      return el;
    },
    destroy() {
      btn.destroy();
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Feedback line under a card's actions (opens with a height transition).
// ---------------------------------------------------------------------------------------------

const TONE_ICON = { ok: 'check-circle', err: 'x-circle', warn: 'alert', info: 'info' };

export function Feedback() {
  const iconSlot = h('span.gfeed__icon');
  const text = h('span.gfeed__text');
  const el = h('div.gfeed', { attrs: { role: 'status', 'aria-live': 'polite' } }, h('div.gfeed__clip', h('div.gfeed__inner', iconSlot, text)));
  return Object.assign(el, {
    show(tone, message) {
      el.dataset.tone = tone;
      iconSlot.replaceChildren(icon(TONE_ICON[tone] || 'info', { size: 16, strokeWidth: 2 }));
      text.textContent = message;
      el.classList.add('is-open');
      if (richMotion()) gsap.fromTo(el.querySelector('.gfeed__inner'), { x: -8, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: 'expo.out', clearProps: 'transform,opacity' });
      return el;
    },
    clear() {
      el.classList.remove('is-open');
      return el;
    },
  });
}

function platformPill(pid) {
  return h('span.gplat', { dataset: { platform: pid } }, h('span.gplat__dot'), PLATFORMS[pid].short);
}

function openedStamp() {
  return Badge({ tone: 'ok', label: 'Geöffnet', icon: 'check' });
}

// Hint texts per launcher state.
function installHint(pid, state, hero) {
  const p = PLATFORMS[pid];
  if (state === 'missing') return hero ? `Erst ${p.launcher} installieren` : 'Launcher fehlt noch';
  if (hero) return `Öffnet den Download ${p.inLauncher}`;
  return 'Download im Launcher';
}

function storeHint(pid, state, game, hero) {
  const p = PLATFORMS[pid];
  if (state === 'missing') return hero ? `Braucht ${p.acc}` : 'Braucht den Launcher';
  if (hero) return `${cleanTitle(game.title)}-Seite im ${p.store}`;
  return 'Falls nichts aufgeht';
}

// ---------------------------------------------------------------------------------------------
// Game tile
// ---------------------------------------------------------------------------------------------

/**
 * GameTile({ game, onAction(tile, mode, event) })
 * Returns the wrapper element (deal-in target) with: root, game, key, setLauncher(state),
 * setBusy(mode, on), showResult(tone, text), markOpened({ animate }), anchor(mode), sweep(), destroy().
 */
export function GameTile({ game, onAction }) {
  const pid = platformOf(game);
  const plat = PLATFORMS[pid];
  const title = cleanTitle(game.title);
  const size = formatGameSize(game.sizeBytes);
  const linkable = pid !== 'other';

  const stamp = h('span.gtile__stamp');
  const cover = h(
    'div.gtile__cover',
    h('div.gtile__art', coverArt(game)),
    platformPill(pid),
    stamp,
    h('div.gtile__caption', h('h3.gtile__title', { title }, title), h('span.gtile__meta', [size, plat.name].filter(Boolean).join(' · '))),
  );

  const feed = Feedback();
  const body = h('div.gtile__body');
  const actions = {};
  let self = null; // the returned element; click handlers only run after it exists
  if (linkable) {
    actions.install = ActionBlock({ label: 'Installieren', variant: 'primary', icon: 'download', block: true, hint: installHint(pid, 'installed'), onClick: (e) => onAction(self, 'install', e) });
    actions.store = ActionBlock({ label: 'Store-Seite', variant: 'secondary', iconRight: 'external', hint: storeHint(pid, 'installed', game), onClick: (e) => onAction(self, 'store', e) });
    body.append(h('div.gtile__actions', actions.install, actions.store), feed);
  } else {
    body.append(h('p.gtile__manual', icon('info', { size: 16 }), h('span', 'Kein Direkt-Link – installiere es über seinen eigenen Launcher.')));
  }

  const root = h('article.gtile', { dataset: { platform: pid }, attrs: { 'aria-label': size ? `${title}, ${size}` : title } }, cover, body);
  const wrap = h('div.gtile-wrap', root);
  const cleanups = [tilt(root, { max: 5, scale: 1.012 })];
  const onEnter = () => sound.play('hover');
  root.addEventListener('pointerenter', onEnter);
  cleanups.push(() => root.removeEventListener('pointerenter', onEnter));

  self = Object.assign(wrap, {
    root,
    game,
    key: gameKey(game),
    title,
    platform: pid,
    setLauncher(state) {
      if (!linkable) return;
      const off = state === 'missing';
      actions.install.setDisabled(off).setHint(installHint(pid, state));
      actions.store.setDisabled(off).setHint(storeHint(pid, state, game));
      root.classList.toggle('is-locked', off);
    },
    setBusy(mode, on) {
      actions[mode]?.setLoading(on);
      root.classList.toggle('is-busy', !!on);
    },
    showResult(tone, text) {
      feed.show(tone, text);
    },
    markOpened({ animate = true } = {}) {
      root.classList.add('is-opened');
      if (!stamp.firstChild) {
        const b = openedStamp();
        stamp.append(b);
        if (animate && richMotion()) gsap.fromTo(b, { scale: 0.4, opacity: 0, rotate: -12 }, { scale: 1, opacity: 1, rotate: 0, duration: 0.8, ease: 'elastic.out(1.1, 0.45)' });
      }
      if (animate) wrap.sweep();
    },
    anchor(mode) {
      return actions[mode]?.btn || root;
    },
    sweep() {
      if (!motionOK()) return;
      cover.classList.remove('is-sweep');
      void cover.offsetWidth;
      cover.classList.add('is-sweep');
    },
    destroy() {
      cleanups.forEach((fn) => fn());
      Object.values(actions).forEach((a) => a.destroy());
    },
  });
  return self;
}

// ---------------------------------------------------------------------------------------------
// Hero card (Fortnite): handcrafted "storm" key art with parallax + cinematic intro.
// ---------------------------------------------------------------------------------------------

function layer(cls, depth, ...children) {
  return h(`div.ghero__layer.${cls}`, { dataset: { depth: String(depth) } }, ...children);
}

export function GameHero({ game, onAction }) {
  const pid = 'epic';
  const plat = PLATFORMS[pid];
  const title = cleanTitle(game.title);
  const size = formatGameSize(game.sizeBytes);
  const self = {};

  const sparks = h(
    'div.ghero__sparks',
    Array.from({ length: 22 }, (_, i) => {
      const k = (i * 37) % 100;
      return h('span.deco', {
        style: {
          '--x': `${34 + ((k * 0.66) % 66)}%`,
          '--d': `${(i * 0.41) % 6}s`,
          '--t': `${4.2 + ((i * 13) % 30) / 10}s`,
          '--s': `${2 + (i % 4)}px`,
          '--dx': `${((i % 5) - 2) * 14}px`,
        },
      });
    }),
  );
  // Poster type: long titles stack in two lines ("FORT" / "NITE").
  const upper = title.toUpperCase();
  const half = upper.length >= 7 && !upper.includes(' ') ? Math.ceil(upper.length / 2) : 0;
  const word = h('div.ghero__word', half ? [h('span', upper.slice(0, half)), h('span', upper.slice(half))] : h('span', upper));
  const impact = h('div.ghero__impact');
  const art = h(
    'div.ghero__art',
    { attrs: { 'aria-hidden': 'true' } },
    h('div.ghero__sky'),
    layer('ghero__l-storm', 22, h('div.ghero__storm.deco'), h('div.ghero__storm.ghero__storm--inner.deco'), h('div.ghero__eye.deco')),
    layer('ghero__l-grid', 8, h('div.ghero__grid.deco')),
    layer('ghero__l-word', 34, word),
    layer('ghero__l-sparks', 14, sparks),
    h('div.ghero__flash.deco'),
    h('div.ghero__scrim'),
    impact,
  );

  const stamp = h('span.ghero__stamp');
  const install = ActionBlock({ label: 'Installieren', variant: 'primary', size: 'lg', icon: 'download', hint: installHint(pid, 'installed', true), onClick: (e) => onAction(self, 'install', e) });
  const store = ActionBlock({ label: 'Store-Seite', variant: 'secondary', size: 'lg', iconRight: 'external', hint: storeHint(pid, 'installed', game, true), onClick: (e) => onAction(self, 'store', e) });
  const actions = { install, store };
  let altRow = null;
  if (hasMsStore(game)) {
    actions.msstore = ActionBlock({
      label: 'Über Xbox / Microsoft Store',
      variant: 'ghost',
      size: 'sm',
      icon: 'windows',
      inline: true,
      hint: 'Alternative ohne Epic Launcher',
      onClick: (e) => onAction(self, 'msstore', e),
    });
    altRow = h('div.ghero__alt', h('span.ghero__or', 'oder'), actions.msstore);
  }
  const feed = Feedback();
  const titleEl = h('h2.ghero__title', title);
  const content = h(
    'div.ghero__content',
    h(
      'div.ghero__tags',
      platformPill(pid),
      size ? h('span.ghero__size', icon('harddrive', { size: 14, strokeWidth: 2 }), size) : null,
      h('span.t-eyebrow.ghero__eyebrow', h('span.ghero__pulse.deco'), 'Battle Royale · Kostenlos'),
      stamp,
    ),
    titleEl,
    h('p.ghero__text', 'Zurück auf die Insel: Ein Klick öffnet die Installation direkt im Epic Games Launcher.'),
    h('div.ghero__actions', install, store),
    altRow,
    feed,
  );
  const root = h('article.ghero.beam.deco', { dataset: { platform: pid }, attrs: { 'aria-label': `${title} – Highlight` } }, art, content);

  // Pointer parallax on the art layers.
  const layers = Array.from(art.querySelectorAll('.ghero__layer'));
  const movers = layers.map((el) => ({ depth: Number(el.dataset.depth) || 10, x: gsap.quickTo(el, 'x', { duration: 0.9, ease: 'power3.out' }), y: gsap.quickTo(el, 'y', { duration: 0.9, ease: 'power3.out' }) }));
  const move = (e) => {
    if (!richMotion()) return;
    const r = root.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    for (const m of movers) {
      m.x(-px * m.depth);
      m.y(-py * m.depth * 0.6);
    }
    root.style.setProperty('--hx', `${((px + 0.5) * 100).toFixed(1)}%`);
    root.style.setProperty('--hy', `${((py + 0.5) * 100).toFixed(1)}%`);
  };
  const leave = () => {
    for (const m of movers) {
      m.x(0);
      m.y(0);
    }
  };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', leave);

  return Object.assign(self, {
    el: root,
    root,
    game,
    key: gameKey(game),
    title,
    platform: pid,
    setLauncher(state) {
      const off = state === 'missing';
      install.setDisabled(off).setHint(installHint(pid, state, true));
      store.setDisabled(off).setHint(storeHint(pid, state, game, true));
      if (actions.msstore) {
        actions.msstore.classList.toggle('is-recommended', off);
        actions.msstore.setHint(off ? 'Geht auch ohne Epic Launcher' : 'Alternative ohne Epic Launcher');
      }
      root.classList.toggle('is-locked', off);
    },
    setBusy(mode, on) {
      actions[mode]?.setLoading(on);
    },
    showResult(tone, text) {
      feed.show(tone, text);
    },
    markOpened({ animate = true } = {}) {
      root.classList.add('is-opened');
      if (!stamp.firstChild) {
        const b = openedStamp();
        stamp.append(b);
        if (animate) pop(b, { from: 0.5 });
      }
    },
    anchor(mode) {
      return actions[mode]?.btn || root;
    },
    sweep() {},
    /** The drop: storm closes in, the title slams down with a flash and a shockwave. */
    intro({ delay = 0 } = {}) {
      if (!motionOK()) return null;
      const rich = richMotion();
      const kids = Array.from(content.children);
      const tl = gsap.timeline({ delay });
      tl.fromTo(root, { opacity: 0, y: 34, scale: 0.975 }, { opacity: 1, y: 0, scale: 1, duration: 0.95, ease: 'expo.out', clearProps: 'transform,opacity' }, 0);
      if (rich) {
        const storm = art.querySelector('.ghero__l-storm');
        const grid = art.querySelector('.ghero__l-grid');
        const spacing = getComputedStyle(word).letterSpacing;
        tl.fromTo(storm, { scale: 2.2, opacity: 0, rotate: -40 }, { scale: 1, opacity: 1, rotate: 0, duration: 2, ease: 'expo.out', clearProps: 'scale,rotate,opacity' }, 0)
          .fromTo(grid, { opacity: 0, yPercent: 40 }, { opacity: 1, yPercent: 0, duration: 1.4, ease: 'expo.out', clearProps: 'opacity' }, 0.1)
          .fromTo(
            word,
            { opacity: 0, scale: 1.6, letterSpacing: '0.35em', filter: 'blur(22px)' },
            { opacity: 1, scale: 1, letterSpacing: spacing === 'normal' ? '0px' : spacing, filter: 'blur(0px)', duration: 0.75, ease: 'expo.in', clearProps: 'filter,letterSpacing,scale,opacity' },
            0.05,
          )
          .fromTo(impact, { opacity: 0 }, { opacity: 1, duration: 0.06, ease: 'none' }, 0.78)
          .to(impact, { opacity: 0, duration: 0.9, ease: 'power2.out' }, 0.86)
          .call(
            () => {
              const r = root.getBoundingClientRect();
              const w = word.getBoundingClientRect();
              shockwave(root, { x: w.left - r.left + w.width * 0.5, y: w.top - r.top + w.height * 0.55, size: Math.max(r.width, 700), color: 'rgba(221, 214, 254, 0.75)', duration: 1.1 });
            },
            null,
            0.78,
          )
          .fromTo(art, { x: 0, y: 0 }, { duration: 0.42, ease: 'none', keyframes: { x: [0, -7, 6, -4, 2, 0], y: [0, 4, -3, 1, 0, 0] }, clearProps: 'transform' }, 0.78);
      }
      tl.fromTo(kids, { opacity: 0, y: 18, filter: rich ? 'blur(6px)' : 'blur(0px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', stagger: 0.07, duration: 0.85, ease: 'expo.out', clearProps: 'filter,transform,opacity' }, rich ? 0.55 : 0.15);
      return tl;
    },
    destroy() {
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', leave);
      layers.forEach((el) => gsap.killTweensOf(el));
      Object.values(actions).forEach((a) => a.destroy());
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Launcher shelf: a launcher panel (glyph, name, status chip, counts, library) as the first cell
// of the tile grid, a full-width notice above it when the launcher is missing.
// ---------------------------------------------------------------------------------------------

const STATE_CHIP = {
  checking: { tone: 'neutral', label: 'Wird geprüft …', dot: true, live: true },
  installed: { tone: 'ok', label: 'Installiert', icon: 'check' },
  missing: { tone: 'warn', label: 'Nicht installiert', icon: 'alert' },
  unknown: { tone: 'neutral', label: 'Nicht geprüft', icon: 'info' },
};

const STATE_TEXT = {
  checking: 'Launcher wird gesucht …',
  installed: 'Bereit – melde dich dort mit deinem Konto an.',
  missing: 'Launcher fehlt noch – installiere ihn zuerst.',
  unknown: 'Konnte nicht prüfen, ob er installiert ist.',
};

/**
 * LauncherSection({ pid, games, tiles, note, onLibrary, onRecheck, fortniteHere })
 * Returns the <section> with: panel, notice, grid, chip, library, recheck, setState(state, { retried }), destroy().
 */
export function LauncherSection({ pid, games, tiles, note, onLibrary, onRecheck, fortniteHere = false }) {
  const plat = PLATFORMS[pid];
  const titleId = nextId('gsec');
  const bytes = totalBytes(games);
  const countText = [plural(games.length, 'Spiel', 'Spiele'), bytes ? `ca. ${formatGameSize(bytes)}` : ''].filter(Boolean).join(' · ');
  const linkable = pid !== 'other';

  const chip = linkable ? Badge(STATE_CHIP.checking) : null;
  const status = h('p.gpanel__status', linkable ? STATE_TEXT.checking : 'Ohne Direkt-Link – über den eigenen Launcher.');

  const library = linkable ? ActionBlock({ label: 'Bibliothek öffnen', variant: 'secondary', size: 'sm', icon: 'grid', hint: 'Alle Spiele deines Kontos', onClick: onLibrary }) : null;
  const recheck = linkable ? ActionBlock({ label: 'Erneut prüfen', variant: 'primary', size: 'sm', icon: 'refresh', hint: 'Nach der Installation', onClick: onRecheck }) : null;
  if (recheck) recheck.hidden = true;

  const noticeIcon = h('span.gnotice__icon');
  const noticeText = h('p.gnotice__text');
  const notice = h('div.gnotice', { hidden: true }, noticeIcon, noticeText);
  if (!linkable) {
    notice.hidden = false;
    notice.dataset.tone = 'info';
    noticeIcon.append(icon('info', { size: 18, strokeWidth: 2 }));
    noticeText.textContent = 'Für diese Spiele gibt es keinen Direkt-Link. Installiere sie über ihren eigenen Launcher.';
  }

  const panel = h(
    'div.gpanel',
    { dataset: { platform: pid } },
    h('span.gpanel__mark', { attrs: { 'aria-hidden': 'true' } }, plat.letter),
    h('div.gpanel__top', h('div.gsec__glyph', { attrs: { 'aria-hidden': 'true' } }, plat.letter), chip),
    h('h2.gpanel__title', { id: titleId }, plat.name),
    h('p.gpanel__count', countText),
    status,
    linkable ? h('div.gpanel__actions', recheck, library) : null,
  );

  const cells = [panel, ...tiles];
  if (note) {
    cells.push(h('div.gnote', h('span.gnote__icon', icon('arrow-right', { size: 18, strokeWidth: 2 })), h('p.gnote__title', note.title), h('p.gnote__text', note.text)));
  }
  const grid = h('div.gsec__grid', cells);
  const el = h('section.gsec', { dataset: { platform: pid }, attrs: { 'aria-labelledby': titleId } }, notice, grid);

  function setNotice(tone, iconName, text) {
    notice.dataset.tone = tone;
    noticeIcon.replaceChildren(icon(iconName, { size: 18, strokeWidth: 2 }));
    noticeText.textContent = text;
    notice.hidden = false;
  }

  return Object.assign(el, {
    panel,
    notice,
    grid,
    chip,
    library,
    recheck,
    setState(state, { retried = false } = {}) {
      if (!linkable) return;
      chip.set({ dot: false, live: false, icon: null, ...STATE_CHIP[state] });
      el.dataset.state = state;
      status.textContent = STATE_TEXT[state] || '';
      const off = state === 'missing';
      library.setDisabled(off).setHint(off ? `Braucht ${pid === 'steam' ? 'Steam' : 'den Launcher'}` : 'Alle Spiele deines Kontos');
      recheck.hidden = !(state === 'missing' || state === 'unknown');
      if (state === 'installed') {
        notice.hidden = true;
      } else if (state === 'missing') {
        const extra = fortniteHere ? ' Fortnite geht auch ohne – über den Microsoft Store oben.' : '';
        setNotice(
          'warn',
          'alert',
          retried
            ? `${plat.nom} ist noch nicht da. Installiere ${plat.acc} und klick dann nochmal auf „Erneut prüfen“.${extra}`
            : `Installiere zuerst ${plat.acc} – danach auf „Erneut prüfen“ klicken, dann werden die Buttons aktiv.${extra}`,
        );
      } else if (state === 'unknown') {
        setNotice('info', 'info', `Konnte nicht prüfen, ob ${plat.launcher} installiert ist. Probier es trotzdem – oder prüf erneut.`);
      }
    },
    destroy() {
      library?.destroy();
      recheck?.destroy();
    },
  });
}
