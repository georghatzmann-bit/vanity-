// Spiele: after the apps are back, reinstall the games through their launchers.
// PHOENIX cannot download games itself – it opens the right page in Epic Games / Steam
// (ctx.api.games.install(game, mode)), the user only has to be logged in there.
import '../styles/screens/games.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { EmptyState } from '../components/emptyState.js';
import { gsap, revealText, countUp, motionOK, richMotion, shake, pop } from '../core/motion.js';
import { PLATFORMS, PLATFORM_ORDER, platformOf, isFortnite, hasMsStore, totalBytes, formatGameSize } from '../components/gamesArt.js';
import { ActionBlock, GameTile, GameHero, LauncherSection } from '../components/gamesCards.js';
import { sparkBurst, shockwave, centerIn } from '../components/gamesFx.js';

// Which games were already opened in their launcher – survives re-mounts within one session.
const opened = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isGameList = (v) => Array.isArray(v) && v.every((g) => g && typeof g === 'object');

/** Games for this screen from the store (installJob → profile → games slot). null = nothing known yet. */
function gamesFromStore(store) {
  const job = store.get('installJob');
  const profile = store.get('profile');
  const slot = store.get('games');
  for (const list of [job && job.games, profile && profile.games, slot]) if (isGameList(list) && list.length) return list;
  if (isGameList(job && job.games) || isGameList(profile && profile.games)) return [];
  return null;
}

/** Standalone start (?screen=games): seed from the API – profile, found profiles, or a mock scan. */
async function seedGames(api, store) {
  let anyOk = false;
  let lastErr = null;
  const attempts = [
    () => api.profile.load(''),
    async () => {
      const refs = await api.profile.find();
      return refs && refs.length ? api.profile.load(refs[0].path) : null;
    },
    async () => {
      const info = store.get('appInfo') || (await api.app.info());
      return info && info.mock ? api.scan.run() : null;
    },
  ];
  for (const attempt of attempts) {
    try {
      const res = await attempt();
      anyOk = true;
      if (res && isGameList(res.games) && res.games.length) return res.games;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!anyOk && lastErr) throw lastErr;
  return [];
}

function okText(mode, plat) {
  if (mode === 'msstore') return 'Microsoft Store geöffnet – starte dort die Installation.';
  if (mode === 'store') return `Store-Seite ${plat.inLauncher} geöffnet.`;
  return `${plat.launcher} geöffnet – bestätige dort „Installieren“.`;
}

const GUIDE = [
  { title: 'Launcher öffnen & anmelden', text: 'Mit deinem Epic- bzw. Steam-Konto.' },
  { title: '„Installieren“ klicken', text: 'PHOENIX öffnet das Spiel im Launcher.' },
  { title: 'Speicherort wählen – fertig', text: 'Der Download läuft dort weiter.' },
];

export default {
  title: 'Spiele',
  fxState: 'idle',
  mount(container, ctx) {
    const { api, store, router, fx, sound, toast } = ctx;
    container.classList.add('screen--games');

    let alive = true;
    let leaving = false;
    const timelines = new Set();
    const track = (tl) => {
      if (tl) timelines.add(tl);
      return tl;
    };
    const busy = new Set();
    let content = null; // { uis, sections, hero, guide, footer, ... } of the current render
    const launcher = {}; // pid -> 'checking' | 'installed' | 'missing' | 'unknown'
    let checking = false;
    let lastCheck = 0;

    // ---- head --------------------------------------------------------------------------------
    const back = h('button.back-link', { type: 'button', onClick: () => router.back('home') }, icon('arrow-left'), 'Zurück');
    const title = h('h1.games__title', 'Deine Spiele');
    const countNum = h('span.t-num', '0');
    const countWord = h('span', 'Spiele');
    const sizeText = h('span.t-num');
    const sizePart = h('span.games__stat', sizeText);
    const stats = h('div.games__stats', { hidden: true, attrs: { 'aria-live': 'polite' } }, icon('gamepad', { size: 16, strokeWidth: 2 }), h('span.games__stat', countNum, ' ', countWord), h('span.games__sep'), sizePart);
    const leadFrom = h('span');
    const lead = h(
      'p.games__lead',
      { dataset: { stagger: '' } },
      'PHOENIX kann Spiele nicht selbst herunterladen – sie kommen direkt von ',
      leadFrom,
      '. Ein Klick öffnet die Installation im Launcher, du musst dort nur angemeldet sein.',
    );
    /** Names only the launchers this backup actually needs. */
    function setLead(pids = ['epic', 'steam']) {
      const names = pids.filter((p) => p !== 'other').map((p) => h('b', PLATFORMS[p].name));
      const list = names.length ? names : [h('b', 'Epic Games'), h('b', 'Steam')];
      leadFrom.replaceChildren(...list.flatMap((n, i) => (i ? [' und ', n] : [n])));
    }
    setLead();
    const head = h(
      'header.games__head',
      h('div.games__topline', { dataset: { stagger: '' } }, back, h('span.games__crumb-sep'), h('span.t-eyebrow', h('span.games__eyebrow-dot.deco'), 'Letzter Schritt')),
      h('div.games__title-row', title, stats),
      lead,
    );
    const body = h('div.games__body');
    const inner = h('div.screen__inner.games', head, body);
    container.append(inner);
    track(revealText(title, { delay: 0.3 }));

    // ---- states --------------------------------------------------------------------------------
    function disposeContent() {
      if (!content) return;
      content.uis.forEach((u) => u.destroy());
      content.sections.forEach((s) => s.destroy());
      content.done?.destroy();
      content.footer?.remove();
      content = null;
    }

    function setStats(games) {
      const n = games.length;
      const bytes = totalBytes(games);
      countWord.textContent = n === 1 ? 'Spiel' : 'Spiele';
      stats.hidden = false;
      track(countUp(countNum, n, { duration: 0.9, delay: 0.45 }));
      sizePart.hidden = !bytes;
      stats.querySelector('.games__sep').hidden = !bytes;
      if (bytes >= 1e9) {
        sizeText.textContent = '';
        const num = h('span', '0');
        sizeText.append('ca. ', num, ' GB');
        track(countUp(num, Math.round(bytes / 1e9), { duration: 1.4, delay: 0.5 }));
      } else if (bytes) {
        sizeText.textContent = `ca. ${formatGameSize(bytes)}`;
      }
      if (motionOK()) track(gsap.fromTo(stats, { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.8, delay: 0.4, ease: 'expo.out', clearProps: 'transform,opacity' }));
    }

    function renderSkeleton() {
      disposeContent();
      stats.hidden = true;
      body.setAttribute('aria-busy', 'true');
      body.replaceChildren(
        h('p.sr-only', 'Spiele werden geladen …'),
        h('div.gskel', { attrs: { 'aria-hidden': 'true' } }, h('div.gskel__guide.deco'), h('div.gskel__hero.deco'), h('div.gskel__row', [0, 1, 2].map(() => h('div.gskel__tile.deco')))),
      );
    }

    function goHome() {
      if (leaving) return;
      leaving = true;
      router.resetHistory();
      router.go('home', {}, { transition: 'warp' });
    }

    function renderState(node) {
      disposeContent();
      body.removeAttribute('aria-busy');
      const box = h('div.games__state', node);
      body.replaceChildren(box);
      if (motionOK()) track(gsap.fromTo(box, { opacity: 0, y: 24, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.8, delay: 0.25, ease: 'expo.out', clearProps: 'transform,opacity' }));
    }

    function renderEmpty() {
      stats.hidden = true;
      renderState(
        EmptyState({
          icon: 'gamepad',
          title: 'Keine Spiele gefunden',
          text: 'In deiner Sicherung sind keine Epic- oder Steam-Spiele. Neue Spiele installierst du einfach direkt im Launcher.',
          actions: [{ label: 'Zur Startseite', iconRight: 'arrow-right', onClick: goHome }],
        }),
      );
    }

    function renderError(err) {
      stats.hidden = true;
      const msg = (err && err.message) || 'Unbekannter Fehler.';
      renderState(
        EmptyState({
          icon: 'alert',
          title: 'Spiele konnten nicht geladen werden',
          text: `${msg.replace(/\.?$/, '.')} Versuch es nochmal oder geh zurück zur Startseite.`,
          actions: [
            { label: 'Erneut versuchen', icon: 'refresh', onClick: () => load() },
            { label: 'Zur Startseite', onClick: goHome },
          ],
        }),
      );
      body.querySelector('.games__state')?.classList.add('is-error');
    }

    async function load() {
      renderSkeleton();
      try {
        const games = await seedGames(api, store);
        if (!alive) return;
        if (games.length) store.set('games', games);
        show(games, false);
      } catch (err) {
        if (!alive) return;
        console.warn('[games] seeding failed', err);
        renderError(err);
      }
    }

    // ---- content -------------------------------------------------------------------------------
    function buildGuide(pids) {
      const account = pids.includes('epic') && pids.includes('steam') ? 'Mit deinem Epic- bzw. Steam-Konto.' : pids.includes('steam') ? 'Mit deinem Steam-Konto.' : 'Mit deinem Epic-Games-Konto.';
      const steps = GUIDE.map((s, i) => (i === 0 ? { ...s, text: account } : s));
      return h(
        'ol.gguide',
        { attrs: { 'aria-label': 'So holst du deine Spiele zurück' } },
        steps.map((s, i) =>
          h(
            'li.gguide__step',
            h('div.gguide__top', h('span.gguide__node', h('span', String(i + 1))), h('strong.gguide__title', s.title), i < steps.length - 1 ? h('span.gguide__seg', h('span.gguide__fill')) : null),
            h('p.gguide__text', s.text),
          ),
        ),
      );
    }

    function buildFooter(total) {
      const segs = total <= 16 ? Array.from({ length: total }, () => h('span.gfoot__seg')) : [];
      const fill = total > 16 ? h('span.gfoot__fill') : null;
      const count = h('strong.gfoot__count');
      const hint = h('span.gfoot__hint');
      const done = ActionBlock({ label: 'Fertig', variant: 'primary', size: 'lg', iconRight: 'check', inline: true, hint: 'Zurück zur Startseite', onClick: finish, className: 'gfoot__done' });
      const el = h(
        'footer.gfoot',
        h('div.gfoot__progress', h('div.gfoot__line', count, hint), h('div.gfoot__bar', { attrs: { 'aria-hidden': 'true' } }, segs, fill)),
        done,
      );
      return { el, segs, fill, count, hint, done, total };
    }

    function updateProgress(animate) {
      if (!content || !content.foot) return;
      const f = content.foot;
      const linkable = content.uis.filter((u) => u.platform !== 'other');
      const n = linkable.filter((u) => opened.has(u.key)).length;
      const all = f.total > 0 && n >= f.total;
      f.count.textContent = all ? (f.total === 1 ? 'Spiel geöffnet' : 'Alle Spiele geöffnet') : `${n} von ${f.total} ${f.total === 1 ? 'Spiel' : 'Spielen'} geöffnet`;
      f.hint.textContent = all ? 'Lehn dich zurück – die Launcher laden im Hintergrund weiter.' : 'Die Downloads laufen in den Launchern – PHOENIX kannst du danach schließen.';
      f.segs.forEach((s, i) => {
        const on = i < n;
        if (on && !s.classList.contains('is-on') && animate) pop(s, { from: 0.4 });
        s.classList.toggle('is-on', on);
      });
      if (f.fill) f.fill.style.transform = `scaleX(${f.total ? n / f.total : 0})`;
      const wasComplete = f.el.classList.contains('is-complete');
      f.el.classList.toggle('is-complete', all);
      if (all && !wasComplete && animate) {
        fx.burst?.();
        const { x, y } = centerIn(f.el, f.done.btn);
        shockwave(f.el, { x, y, size: 340, color: 'rgba(52, 211, 153, 0.75)' });
        sparkBurst(f.el, { x, y, count: 22, spread: 150, colors: ['#ecfdf5', '#a7f3d0', '#34d399', '#c4b5fd'] });
      }
    }

    function applyLauncher(pid, state, opts) {
      launcher[pid] = state;
      if (!content) return;
      content.sections.find((s) => s.pid === pid)?.setState(state, opts);
      content.uis.filter((u) => u.platform === pid).forEach((u) => u.setLauncher(state));
    }

    async function checkLaunchers({ manual = false, silent = false } = {}) {
      if (checking || !content) return;
      const pids = content.sections.map((s) => s.pid).filter((p) => p !== 'other');
      if (!pids.length) return;
      checking = true;
      const prev = { ...launcher };
      if (!silent) pids.forEach((pid) => content.sections.find((s) => s.pid === pid)?.setState('checking'));
      if (manual) content.sections.forEach((s) => s.recheck?.setLoading(true));
      const t0 = performance.now();
      let res = null;
      let failed = false;
      try {
        res = await api.games.launchers();
      } catch (err) {
        failed = true;
        console.warn('[games] launcher check failed', err);
      }
      if (manual) {
        const rest = 650 - (performance.now() - t0);
        if (rest > 0) await sleep(rest);
      }
      checking = false;
      lastCheck = Date.now();
      if (!alive || !content) return;
      if (manual) content.sections.forEach((s) => s.recheck?.setLoading(false));
      const found = [];
      for (const pid of pids) {
        const info = res && res[pid];
        const state = failed || !info ? 'unknown' : info.installed ? 'installed' : 'missing';
        applyLauncher(pid, state, { retried: manual && prev[pid] === 'missing' && state === 'missing' });
        if ((prev[pid] === 'missing' || prev[pid] === 'unknown') && state === 'installed') found.push(pid);
        if (manual && state === 'missing') shake(content.sections.find((s) => s.pid === pid)?.notice);
      }
      for (const pid of found) {
        const section = content.sections.find((s) => s.pid === pid);
        toast.success(`${PLATFORMS[pid].launcher} gefunden`, 'Die Buttons sind jetzt aktiv – los geht’s.');
        sound.success();
        if (section && richMotion()) {
          const tiles = content.uis.filter((u) => u.platform === pid).map((u) => u.root);
          track(gsap.fromTo(tiles, { scale: 0.96 }, { scale: 1, duration: 0.8, ease: 'elastic.out(1.1, 0.45)', stagger: 0.06, clearProps: 'scale' }));
          const { x, y } = centerIn(section, section.chip);
          shockwave(section, { x, y, size: 260, color: 'rgba(52, 211, 153, 0.7)' });
        }
      }
    }

    // Back from installing a launcher → re-check quietly when the window gets focus again.
    const onFocus = () => {
      if (!content || leaving) return;
      const pending = Object.values(launcher).some((s) => s === 'missing' || s === 'unknown');
      if (pending && Date.now() - lastCheck > 2500) checkLaunchers({ silent: true });
    };
    window.addEventListener('focus', onFocus);

    async function runAction(ui, mode) {
      const token = `${ui.key}|${mode}`;
      if (!ui || busy.has(token) || leaving) return;
      busy.add(token);
      ui.setBusy(mode, true);
      const t0 = performance.now();
      let res;
      try {
        res = await api.games.install(ui.game, mode);
      } catch (err) {
        res = { ok: false, error: err && err.message };
      }
      const rest = 380 - (performance.now() - t0);
      if (rest > 0) await sleep(rest);
      busy.delete(token);
      if (!alive) return;
      ui.setBusy(mode, false);
      const plat = PLATFORMS[ui.platform];
      if (res && res.ok) {
        const text = okText(mode, plat);
        opened.set(ui.key, { mode, text });
        ui.showResult('ok', text);
        ui.markOpened({ animate: true });
        const btn = ui.anchor(mode);
        const { x, y } = centerIn(ui.root, btn);
        sparkBurst(ui.root, { x, y, colors: ['#ede9fe', '#c4b5fd', `rgb(${plat.rgb})`, '#34d399'] });
        shockwave(ui.root, { x, y, size: 240, color: 'rgba(52, 211, 153, 0.7)' });
        fx.pulse?.(0.5);
        sound.success();
        updateProgress(true);
      } else {
        ui.showResult('err', (res && res.error) || 'Der Launcher konnte nicht geöffnet werden. Versuch es nochmal.');
        shake(ui.root);
        sound.error();
      }
    }

    async function openLibrary(pid, section) {
      const plat = PLATFORMS[pid];
      section.library.setLoading(true);
      const t0 = performance.now();
      let res;
      try {
        res = await api.games.install({ platform: pid, title: plat.name }, 'library');
      } catch (err) {
        res = { ok: false, error: err && err.message };
      }
      const rest = 300 - (performance.now() - t0);
      if (rest > 0) await sleep(rest);
      if (!alive) return;
      section.library.setLoading(false);
      if (res && res.ok) toast.success('Bibliothek geöffnet', `Schau ${plat.inLauncher} – dort findest du alle Spiele deines Kontos.`);
      else toast.error('Bibliothek nicht geöffnet', (res && res.error) || 'Der Launcher konnte nicht geöffnet werden.');
    }

    async function getLauncher(pid, section) {
      const plat = PLATFORMS[pid];
      if (!section.get || !plat.download) return;
      section.get.setLoading(true);
      try {
        await api.shell.open(plat.download);
        if (alive) toast.info(`Download-Seite für ${plat.launcher} geöffnet`, 'Nach der Installation einfach zurück zu PHOENIX wechseln – die Buttons werden dann automatisch aktiv.');
      } catch (err) {
        if (alive) toast.error('Seite lässt sich nicht öffnen', err.message);
      }
      if (alive) section.get.setLoading(false);
    }

    function renderContent(games, fromMount) {
      disposeContent();
      body.removeAttribute('aria-busy');
      setStats(games);

      const heroGame = games.find(isFortnite) || null;
      const hero = heroGame ? GameHero({ game: heroGame, onAction: runAction }) : null;
      const uis = hero ? [hero] : [];
      const sections = [];
      for (const pid of PLATFORM_ORDER) {
        const list = games.filter((g) => platformOf(g) === pid);
        if (!list.length) continue;
        const tiles = list.filter((g) => g !== heroGame).map((g) => GameTile({ game: g, onAction: runAction }));
        uis.push(...tiles);
        const note = pid === 'epic' && heroGame && !tiles.length ? { title: 'Fortnite steht oben im Rampenlicht.', text: 'Weitere Epic-Spiele waren nicht in deiner Sicherung.' } : null;
        const section = LauncherSection({
          pid,
          games: list,
          tiles,
          note,
          fortniteHere: pid === 'epic' && !!heroGame && hasMsStore(heroGame),
          onLibrary: () => openLibrary(pid, section),
          onRecheck: () => checkLaunchers({ manual: true }),
          onGetLauncher: () => getLauncher(pid, section),
        });
        section.pid = pid;
        sections.push(section);
      }
      const pids = sections.map((sec) => sec.pid);
      setLead(pids);
      const guide = buildGuide(pids);
      const linkableCount = uis.filter((u) => u.platform !== 'other').length;
      const foot = buildFooter(linkableCount);
      content = { uis, sections, hero, guide, foot, footer: foot.el, done: foot.done };

      body.replaceChildren(guide, hero ? hero.el : null, ...sections);
      inner.append(foot.el);

      // Restore what was already opened in this session.
      for (const u of uis) {
        const prev = opened.get(u.key);
        if (prev) {
          u.markOpened({ animate: false });
          u.showResult('ok', prev.text);
        }
      }
      for (const s of sections) if (s.pid !== 'other') applyLauncher(s.pid, launcher[s.pid] || 'checking');
      updateProgress(false);
      intro(fromMount);
      checkLaunchers();
    }

    function show(games, fromMount) {
      if (!games.length) renderEmpty();
      else renderContent(games, fromMount);
    }

    // ---- choreography --------------------------------------------------------------------------
    function intro(fromMount) {
      if (!content) return;
      const { guide, hero, sections, foot } = content;
      const nodes = Array.from(guide.querySelectorAll('.gguide__node'));
      const fills = Array.from(guide.querySelectorAll('.gguide__fill'));
      if (!motionOK()) {
        nodes.forEach((n) => n.classList.add('is-lit'));
        fills.forEach((f) => (f.style.transform = 'scaleX(1)'));
        return;
      }
      const rich = richMotion();
      const tl = gsap.timeline({ delay: fromMount ? 0.3 : 0.05 });
      tl.fromTo(guide, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.8, ease: 'expo.out', clearProps: 'transform,opacity' }, 0);
      nodes.forEach((n, i) => {
        tl.call(() => {
          n.classList.add('is-lit');
          pop(n, { from: 0.6 });
        }, null, 0.25 + i * 0.5);
        if (fills[i]) tl.fromTo(fills[i], { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'power2.inOut' }, 0.3 + i * 0.5);
      });
      if (hero) {
        const heroTl = hero.intro();
        if (heroTl) tl.add(heroTl, 0.12);
      }
      sections.forEach((s, i) => {
        const at = (hero ? 0.75 : 0.3) + i * 0.24;
        if (!s.notice.hidden) tl.fromTo(s.notice, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out', clearProps: 'transform,opacity' }, at);
        const cells = Array.from(s.grid.children);
        tl.fromTo(
          cells,
          rich
            ? { opacity: 0, y: 70, rotationX: -38, rotationY: (j) => (j % 2 ? 16 : -16), scale: 0.88, filter: 'blur(10px)', transformPerspective: 900, transformOrigin: '50% 100%' }
            : { opacity: 0, y: 24 },
          {
            opacity: 1,
            y: 0,
            rotationX: 0,
            rotationY: 0,
            scale: 1,
            filter: 'blur(0px)',
            duration: rich ? 1.1 : 0.6,
            ease: 'expo.out',
            clearProps: 'transform,filter,opacity',
            stagger: {
              each: 0.08,
              onComplete() {
                const t = this.targets()[0];
                if (t && t.sweep) t.sweep();
              },
            },
          },
          at + 0.04,
        );
      });
      tl.fromTo(foot.el, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.9, ease: 'expo.out', clearProps: 'transform,opacity' }, 0.55);
      track(tl);
    }

    /** "Fertig": every game flies into the button, flash, then warp home. */
    async function finish() {
      if (leaving || !content) return;
      leaving = true;
      const { foot, uis, guide } = content;
      const btn = foot.done.btn;
      sound.success();
      fx.burst?.();
      fx.pulse?.(1);
      if (motionOK()) {
        const b = btn.getBoundingClientRect();
        const bx = b.left + b.width / 2;
        const by = b.top + b.height / 2;
        const rich = richMotion();
        const flyers = [...uis.map((u) => u.root), ...content.sections.flatMap((s) => Array.from(s.grid.querySelectorAll('.gpanel, .gnote')))];
        const tl = gsap.timeline();
        tl.to(
          flyers,
          {
            x: (i, el) => {
              const r = el.getBoundingClientRect();
              return bx - (r.left + r.width / 2);
            },
            y: (i, el) => {
              const r = el.getBoundingClientRect();
              return by - (r.top + r.height / 2);
            },
            scale: 0.08,
            opacity: 0,
            rotation: rich ? (i) => (i % 2 ? 8 : -8) : 0,
            filter: rich ? 'blur(6px)' : 'blur(0px)',
            duration: 0.62,
            ease: 'power3.in',
            stagger: 0.045,
          },
          0,
        )
          .to([head, guide, ...content.sections.map((s) => s.notice)], { opacity: 0, y: -18, duration: 0.35, ease: 'power2.in' }, 0)
          .call(() => {
            const { x, y } = centerIn(foot.el, btn);
            shockwave(foot.el, { x, y, size: 420, color: 'rgba(221, 214, 254, 0.9)' });
            sparkBurst(foot.el, { x, y, count: 26, spread: 170 });
          }, null, 0.55);
        track(tl);
        await new Promise((r) => {
          tl.eventCallback('onComplete', r);
          setTimeout(r, 1400);
        });
      }
      if (!alive) return;
      router.resetHistory();
      router.go('home', {}, { transition: 'warp' });
    }

    // ---- start ---------------------------------------------------------------------------------
    const initial = gamesFromStore(store);
    if (initial) show(initial, true);
    else load();

    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
      timelines.forEach((tl) => tl && tl.kill && tl.kill());
      timelines.clear();
      disposeContent();
    };
  },
};

