// Wiederherstellen: radar search for saved profiles (api.profile.find), hero cards for the results,
// alternatives (file, code, catalog). Leaves with store.profile -> select {mode:'restore'}.
//
// States: searching -> results | empty | error. results -> loading (card) -> select.
// empty polls quietly every 8 s (max. 2 min) so a freshly plugged-in stick shows up by itself.
import '../styles/screens/restore.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { xicon } from '../components/selectIcons.js';
import { Button } from '../components/button.js';
import { Card } from '../components/card.js';
import { Badge } from '../components/badge.js';
import { RestoreRadar, PlaceList } from '../components/restoreRadar.js';
import { openCodeDialog } from '../components/restoreCodeDialog.js';
import { revealText, scrambleText, countUp, shake, gsap, motionOK, richMotion } from '../core/motion.js';
import { formatRelativeDate, plural, joinList } from '../core/format.js';

const PLACES = [
  { id: 'usb', label: 'USB-Sticks', icon: 'usb', hint: 'Alle eingesteckten Sticks' },
  { id: 'drive', label: 'Laufwerke', icon: 'harddrive', hint: 'Weitere Festplatten und SSDs' },
  { id: 'desktop', label: 'Desktop', icon: 'monitor', hint: 'Dein Schreibtisch' },
  { id: 'downloads', label: 'Downloads', icon: 'download', hint: 'Heruntergeladene Dateien' },
  { id: 'documents', label: 'Dokumente', icon: 'folder', hint: 'Auch der Ordner „Phoenix“' },
  { id: 'onedrive', label: 'OneDrive', icon: 'cloud', hint: 'Falls eingerichtet' },
];

/** ProfileRef.location ("USB-Stick E:\", "Laufwerk D:\", "Desktop", …) -> PLACES index. */
function placeIndex(location = '') {
  const l = String(location).toLowerCase();
  if (l.startsWith('usb')) return 0;
  if (l.includes('onedrive')) return 5;
  if (l.includes('desktop')) return 2;
  if (l.includes('download')) return 3;
  if (l.includes('dokument') || l.includes('document')) return 4;
  return 1;
}

/** "USB-Stick E:\" -> "USB-Stick E:" (the trailing backslash reads like a typo in running text). */
const prettyLocation = (location) => String(location || '').replace(/([A-Za-z]:)[\\/]+$/, '$1').trim();

const POLL_MS = 8000;
const POLL_MAX = 15;

export default {
  title: 'Wiederherstellen',
  fxState: 'idle',
  mount(container, ctx) {
    const { api, store, router, sound, toast, modal, fx } = ctx;
    container.classList.add('screen--restore');
    const cleanups = [];
    const timers = new Set();
    let alive = true;
    let busy = false;
    let searchId = 0;
    let pollTimer = 0;
    let polls = 0;
    let state = 'searching';

    const wait = (ms) =>
      new Promise((resolve) => {
        if (!ms) return resolve();
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, ms);
        timers.add(t);
      });

    // ---------------------------------------------------------------- header
    const title = h('h1.page-head__title.rs-title', 'Wiederherstellen');
    const head = h(
      'header.page-head.rs-head',
      h(
        'div.rs-head__top',
        { dataset: { stagger: '' } },
        h('button.back-link', { type: 'button', onClick: () => router.back() }, icon('arrow-left'), 'Zurück'),
        h('span.t-eyebrow', h('span.rs-live'), 'Nach dem Reset · Schritt 1 von 3'),
      ),
      title,
      h(
        'p.page-head__lead.rs-lead',
        { dataset: { stagger: '' } },
        'Phoenix sucht deine Sicherung auf allen Laufwerken und in deinen Ordnern – du klickst dann nur noch drauf.',
      ),
    );

    // ---------------------------------------------------------------- stage
    const stage = h('section.rs-stage', { attrs: { 'aria-live': 'polite', 'aria-busy': 'true' } });

    // ---------------------------------------------------------------- alternatives
    function optionTile({ icon: ic, title: t, text, onClick }) {
      const el = h(
        'button.rs-opt',
        { type: 'button', onPointerenter: () => sound.play('hover') },
        h('span.icon-tile.rs-opt__tile', xicon(ic)),
        h('span.rs-opt__text', h('span.rs-opt__title', t), h('span.rs-opt__desc', text)),
        h('span.rs-opt__go', icon('arrow-right')),
        h('span.rs-opt__spin', { attrs: { 'aria-hidden': 'true' } }),
      );
      el.addEventListener('click', () => {
        if (busy || el.classList.contains('is-busy')) return;
        sound.play('click');
        onClick(el);
      });
      el.setBusy = (on) => {
        el.classList.toggle('is-busy', !!on);
        el.setAttribute('aria-busy', on ? 'true' : 'false');
      };
      return el;
    }

    const optFile = optionTile({
      icon: 'file',
      title: 'Datei öffnen',
      text: 'Profil-Datei (.phoenix.json) oder winget-Export auswählen.',
      onClick: openFile,
    });
    const optCode = optionTile({
      icon: 'key',
      title: 'Code einfügen',
      text: 'Den PHX1-Code aus WhatsApp oder Mail einfügen.',
      onClick: openCode,
    });
    const optCatalog = optionTile({
      icon: 'sparkles',
      title: 'Ohne Sicherung starten',
      text: 'Aus dem Katalog wählen – beliebte Apps für Gamer sind schon angehakt.',
      onClick: () => {
        busy = true;
        stopPolling();
        router.go('select', { mode: 'catalog' }, { transition: 'warp' }).then((ok) => {
          if (!ok) busy = false;
        });
      },
    });
    const options = h(
      'section.rs-alt',
      { dataset: { stagger: '' }, attrs: { 'aria-label': 'Andere Wege' } },
      h('div.rs-alt__head', h('span.t-eyebrow.rs-alt__eyebrow', 'Andere Wege'), h('span.rs-alt__line')),
      h('div.rs-alt__grid', optFile, optCode, optCatalog),
    );

    const inner = h('div.screen__inner.rs', head, h('div', { dataset: { stagger: '' } }, stage), options);
    container.append(inner);

    const tl = revealText(title, { delay: 0.25 });
    cleanups.push(() => tl?.kill());

    // Keyboard users get focus moved to the main action; mouse users keep a calm screen (no ring).
    let keyboardUser = false;
    const onKeyMod = (e) => {
      if (e.key === 'Tab' || e.key.startsWith('Arrow')) keyboardUser = true;
    };
    const onPointerMod = () => (keyboardUser = false);
    window.addEventListener('keydown', onKeyMod, true);
    window.addEventListener('pointerdown', onPointerMod, true);
    cleanups.push(() => {
      window.removeEventListener('keydown', onKeyMod, true);
      window.removeEventListener('pointerdown', onPointerMod, true);
    });
    function focusIfKeyboard(el) {
      const active = document.activeElement;
      if (keyboardUser && (active === container || active === document.body || !container.contains(active))) el.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- stage swapping
    let swapToken = 0;
    function swap(next, { focus } = {}) {
      const token = ++swapToken;
      const prev = stage.firstElementChild;
      const enter = () => {
        if (token !== swapToken || !alive) return;
        stage.replaceChildren(next);
        if (motionOK()) {
          gsap.fromTo(
            next,
            { opacity: 0, y: 14, filter: richMotion() ? 'blur(8px)' : 'none' },
            { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.6, ease: 'expo.out', clearProps: 'filter,transform,opacity' },
          );
        }
        if (focus) focusIfKeyboard(focus);
      };
      if (!prev || prev === next) return enter();
      if (!motionOK()) return enter();
      gsap.to(prev, { opacity: 0, y: -10, scale: 0.985, filter: richMotion() ? 'blur(6px)' : 'none', duration: 0.26, ease: 'power2.in', onComplete: enter });
    }

    // ---------------------------------------------------------------- searching
    let radar = null;
    let consoleEl = null;
    let consoleSide = null;
    let consoleHead = null;

    function buildConsole() {
      radar?.destroy();
      radar = RestoreRadar({ places: PLACES });
      consoleSide = h('div.rs-console__side');
      consoleHead = h('div.rs-console__status', h('span.rs-console__dot'), h('span.rs-console__label', 'Suche läuft'));
      consoleEl = h('div.rs-console', h('div.rs-console__radar', radar), h('div.rs-console__panel', consoleHead, consoleSide));
      return consoleEl;
    }

    function setConsoleStatus(text, tone = 'run') {
      if (!consoleHead) return;
      consoleHead.dataset.tone = tone;
      consoleHead.lastChild.textContent = text;
    }

    async function search() {
      const id = ++searchId;
      stopPolling();
      state = 'searching';
      stage.setAttribute('aria-busy', 'true');
      const list = PlaceList({ places: PLACES });
      const reuse = consoleEl && stage.contains(consoleEl);
      if (!reuse) swap(buildConsole());
      consoleEl.dataset.mode = 'search';
      consoleSide.replaceChildren(h('div.rs-console__title', 'Wir durchsuchen'), list);
      if (reuse && motionOK()) gsap.fromTo(list.children, { opacity: 0, x: 10 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.04, ease: 'power2.out', clearProps: 'transform,opacity' });
      setConsoleStatus('Suche läuft', 'run');
      PLACES.forEach((_, i) => radar.setNode(i, 'idle'));
      radar.setMode('search');

      const rich = richMotion();
      const stepMs = rich ? 300 : motionOK() ? 120 : 0;
      radar.startSweep(Math.max(0.6, (stepMs * PLACES.length) / 1000));
      if (rich) sound.play('scan');

      let settled = null;
      const findP = Promise.resolve()
        .then(() => api.profile.find())
        .then(
          (refs) => (settled = { ok: true, refs: Array.isArray(refs) ? refs : [] }),
          (err) => (settled = { ok: false, err }),
        );

      if (stepMs) {
        await wait(rich ? 380 : 60);
        for (let i = 0; i < PLACES.length; i++) {
          if (!alive || id !== searchId) return;
          list.setState(i, 'run');
          radar.setNode(i, 'active');
          radar.ping(i);
          await wait(stepMs);
          if (!alive || id !== searchId) return;
          if (i < PLACES.length - 1 || settled) {
            list.setState(i, 'done', 'Geprüft');
            radar.setNode(i, 'done');
          }
        }
        if (!settled) setConsoleStatus('Sucht noch …', 'run');
      }
      const res = await findP;
      if (!alive || id !== searchId) return;
      radar.stopSweep();

      if (!res.ok) {
        PLACES.forEach((_, i) => list.setState(i, 'done', '–'));
        return showError(res.err);
      }
      const refs = [...res.refs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const counts = PLACES.map(() => 0);
      for (const r of refs) counts[placeIndex(r.location)]++;
      PLACES.forEach((_, i) => {
        if (counts[i]) {
          list.setState(i, 'found', plural(counts[i], 'Sicherung', 'Sicherungen'));
          radar.setNode(i, 'found');
          radar.ping(i);
        } else {
          list.setState(i, 'done', 'Nichts');
          radar.setNode(i, 'done');
        }
      });
      if (refs.length) {
        setConsoleStatus(refs.length === 1 ? 'Sicherung gefunden' : `${refs.length} Sicherungen gefunden`, 'ok');
        sound.play('success');
        fx.pulse?.(0.8);
        await wait(rich ? 650 : stepMs ? 250 : 0);
        if (!alive || id !== searchId) return;
        showResults(refs, counts);
      } else {
        setConsoleStatus('Nichts gefunden', 'idle');
        await wait(stepMs ? 200 : 0);
        if (!alive || id !== searchId) return;
        showEmpty();
      }
    }

    // ---------------------------------------------------------------- results
    function locationChip(ref) {
      return h('span.rs-loc', xicon(PLACES[placeIndex(ref.location)].icon, { size: 15, strokeWidth: 2 }), h('span', prettyLocation(ref.location) || 'Unbekannter Ort'));
    }

    function heroCard(ref) {
      const appsEl = h('span.rs-stat__n', '0');
      const gamesEl = h('span.rs-stat__n', '0');
      const errEl = h('p.rs-card-err', { hidden: true, attrs: { role: 'alert' } });
      const btn = Button({
        label: 'Wiederherstellen',
        iconRight: 'arrow-right',
        variant: 'primary',
        size: 'lg',
        className: 'rs-hero__cta',
        onClick: (e) => {
          e.stopPropagation();
          load(ref, card, btn, errEl);
        },
      });
      const card = Card(
        { variant: 'hero', tilt: { max: 2.2, scale: 1.006 }, className: 'rs-hero' },
        h('span.rs-hero__aura.deco', { attrs: { 'aria-hidden': 'true' } }),
        h(
          'div.rs-hero__top',
          Badge({ tone: 'accent', icon: 'star', label: 'Empfohlen' }),
          h('span.rs-hero__new', 'Neueste Sicherung'),
          h('span.rs-hero__spacer'),
          locationChip(ref),
        ),
        h(
          'div.rs-hero__main',
          h(
            'div.rs-hero__id',
            h('div.rs-hero__host', { title: ref.hostname || '' }, ref.hostname || 'Unbekannter PC'),
            h('div.rs-hero__date', icon('clock', { size: 16 }), h('span', formatRelativeDate(ref.createdAt) || 'Datum unbekannt')),
          ),
          h(
            'div.rs-hero__stats',
            h('div.rs-stat', appsEl, h('span.rs-stat__l', Number(ref.appCount) === 1 ? 'App' : 'Apps')),
            h('span.rs-hero__vsep'),
            h('div.rs-stat', gamesEl, h('span.rs-stat__l', Number(ref.gameCount) === 1 ? 'Spiel' : 'Spiele')),
          ),
        ),
        h(
          'div.rs-hero__foot',
          h('div.rs-hero__path', icon('file', { size: 15 }), h('span.t-mono', { title: ref.path }, ref.path || '')),
          btn,
        ),
        errEl,
      );
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        load(ref, card, btn, errEl);
      });
      card._counts = () => {
        countUp(appsEl, Number(ref.appCount) || 0, { duration: 1.3, delay: 0.25 });
        countUp(gamesEl, Number(ref.gameCount) || 0, { duration: 1.1, delay: 0.4 });
      };
      cleanups.push(() => {
        card.destroy();
        btn.destroy();
      });
      return { card, btn };
    }

    function smallCard(ref) {
      const errEl = h('p.rs-card-err', { hidden: true, attrs: { role: 'alert' } });
      const card = Card(
        { as: 'button', variant: 'interactive', tilt: { max: 4 }, className: 'rs-card', onClick: () => load(ref, card, null, errEl) },
        h('div.rs-card__top', locationChip(ref)),
        h('div.rs-card__host', { title: ref.hostname || '' }, ref.hostname || 'Unbekannter PC'),
        h('div.rs-card__date', formatRelativeDate(ref.createdAt) || 'Datum unbekannt'),
        h(
          'div.rs-card__foot',
          h('span.rs-card__meta', `${plural(Number(ref.appCount) || 0, 'App', 'Apps')} · ${plural(Number(ref.gameCount) || 0, 'Spiel', 'Spiele')}`),
          h('span.rs-card__go', 'Laden', icon('arrow-right', { size: 16 }), h('span.rs-card__spin', { attrs: { 'aria-hidden': 'true' } })),
        ),
        errEl,
      );
      card.setAttribute('aria-label', `Sicherung von ${ref.hostname || 'unbekanntem PC'}, ${formatRelativeDate(ref.createdAt) || 'Datum unbekannt'}, laden`);
      cleanups.push(() => card.destroy());
      return card;
    }

    function showResults(refs, counts) {
      state = 'results';
      stage.setAttribute('aria-busy', 'false');
      const places = PLACES.filter((_, i) => counts[i]).map((p) => p.label);
      const heading = h('h2.rs-sum__title', refs.length === 1 ? 'Sicherung gefunden' : `${refs.length} Sicherungen gefunden`);
      const again = Button({ label: 'Erneut suchen', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => search() });
      cleanups.push(() => again.destroy());
      const { card: hero, btn } = heroCard(refs[0]);
      const others = refs.slice(1).map(smallCard);
      // Entrance tweens run on wrappers: the cards themselves carry the tilt transform.
      const heroWrap = h('div.rs-hero-wrap', hero);
      const otherWraps = others.map((c) => h('div.rs-older__cell', c));
      const wrap = h(
        'div.rs-results',
        h(
          'div.rs-sum',
          h('span.rs-sum__icon', xicon('radar', { size: 18, strokeWidth: 2 })),
          h(
            'div.rs-sum__text',
            heading,
            h(
              'p.rs-sum__hint',
              refs.length === 1
                ? `Gefunden: ${prettyLocation(refs[0].location) || joinList(places)}. Klick auf „Wiederherstellen“, um weiterzumachen.`
                : `Gefunden: ${joinList(places)}. Die neueste Sicherung ist markiert – ältere stehen darunter.`,
            ),
          ),
          again,
        ),
        heroWrap,
        others.length ? h('div.rs-older', h('div.t-eyebrow.rs-older__eyebrow', 'Ältere Sicherungen'), h('div.rs-older__grid', otherWraps)) : null,
      );
      swap(wrap, { focus: btn });
      const sc = scrambleText(heading, heading.textContent, { duration: 0.7, delay: 0.15 });
      cleanups.push(() => sc.cancel());
      hero._counts();
      if (richMotion()) {
        gsap.fromTo(heroWrap, { y: 30, scale: 0.965, rotateX: 10, transformPerspective: 900 }, { y: 0, scale: 1, rotateX: 0, duration: 1.1, delay: 0.08, ease: 'expo.out', clearProps: 'transform' });
        if (otherWraps.length) gsap.fromTo(otherWraps, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, delay: 0.3, stagger: 0.07, ease: 'expo.out', clearProps: 'transform,opacity' });
      }
    }

    // ---------------------------------------------------------------- empty + error
    function sideMessage({ tone, iconName, heading, text, hint, actionLabel }) {
      const retry = Button({ label: actionLabel, icon: 'refresh', variant: tone === 'err' ? 'secondary' : 'primary', magnetic: tone !== 'err', onClick: () => search() });
      cleanups.push(() => retry.destroy());
      const live = h('p.rs-empty__live', { hidden: tone === 'err' }, h('span.rs-live'), 'Phoenix sucht automatisch weiter, sobald du einen Stick einsteckst.');
      const el = h(
        'div.rs-empty',
        { dataset: { tone } },
        h(`div.icon-tile${tone === 'err' ? '.icon-tile--danger' : ''}.rs-empty__icon`, xicon(iconName)),
        h('h2.rs-empty__title', heading),
        h('p.rs-empty__text', text),
        hint ? h('p.rs-empty__hint', hint) : null,
        h('div.rs-empty__actions', retry),
        live,
      );
      return { el, retry };
    }

    function ensureConsoleForMessage() {
      if (!consoleEl || !stage.contains(consoleEl)) {
        swap(buildConsole());
        PLACES.forEach((_, i) => radar.setNode(i, 'done'));
      }
    }

    function showEmpty() {
      state = 'empty';
      stage.setAttribute('aria-busy', 'false');
      ensureConsoleForMessage();
      consoleEl.dataset.mode = 'empty';
      radar.setMode('idle');
      radar.setNode(0, 'hint');
      setConsoleStatus('Nichts gefunden', 'idle');
      const { el, retry } = sideMessage({
        tone: 'idle',
        iconName: 'usb',
        heading: 'Keine Sicherung gefunden',
        text: 'Steck den USB-Stick ein und such erneut.',
        hint: `Durchsucht: ${joinList(PLACES.map((p) => p.label))}.`,
        actionLabel: 'Erneut suchen',
      });
      setSide(el, retry);
      startPolling();
    }

    function showError(err) {
      state = 'error';
      stage.setAttribute('aria-busy', 'false');
      ensureConsoleForMessage();
      consoleEl.dataset.mode = 'error';
      radar.setMode('error');
      setConsoleStatus('Suche fehlgeschlagen', 'err');
      sound.play('error');
      const { el, retry } = sideMessage({
        tone: 'err',
        iconName: 'alert',
        heading: 'Die Suche hat nicht geklappt',
        text: (err && err.message) || 'Beim Durchsuchen der Laufwerke ist ein Fehler passiert.',
        hint: 'Du kannst es noch mal versuchen oder unten eine Datei öffnen.',
        actionLabel: 'Erneut versuchen',
      });
      setSide(el, retry);
    }

    function setSide(el, focusEl) {
      consoleSide.replaceChildren(el);
      if (motionOK()) {
        gsap.fromTo(el.children, { opacity: 0, y: 10, filter: richMotion() ? 'blur(6px)' : 'none' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.55, stagger: 0.05, ease: 'expo.out', clearProps: 'filter,transform,opacity' });
      }
      if (focusEl) focusIfKeyboard(focusEl);
    }

    // Quiet re-check while nothing was found (stick plugged in later).
    function startPolling() {
      stopPolling();
      polls = 0;
      const tick = async () => {
        pollTimer = 0;
        if (!alive || state !== 'empty' || busy) return;
        if (document.hidden) return schedule();
        polls++;
        let refs = [];
        try {
          refs = (await api.profile.find()) || [];
        } catch {
          refs = [];
        }
        if (!alive || state !== 'empty') return;
        if (refs.length) {
          toast.success('Sicherung gefunden', refs.length === 1 ? `Auf ${prettyLocation(refs[0].location) || 'einem Laufwerk'}.` : `${refs.length} Sicherungen entdeckt.`);
          search();
          return;
        }
        schedule();
      };
      const schedule = () => {
        if (polls >= POLL_MAX) {
          const live = stage.querySelector('.rs-empty__live');
          if (live) live.hidden = true;
          return;
        }
        pollTimer = setTimeout(tick, POLL_MS);
      };
      schedule();
    }
    function stopPolling() {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }

    // ---------------------------------------------------------------- leaving with a profile
    function proceed(profile, originEl) {
      busy = true;
      stopPolling();
      store.set('profile', profile);
      sound.play('success');
      fx.burst?.();
      if (originEl && richMotion()) gsap.to(originEl, { scale: 1.015, duration: 0.25, ease: 'power2.out' });
      router.go('select', { mode: 'restore' }, { transition: 'warp' }).then((ok) => {
        if (!ok) busy = false;
      });
    }

    async function load(ref, card, btn, errEl) {
      if (busy) return;
      busy = true;
      stage.classList.add('is-busy');
      card.classList.add('is-loading');
      btn?.setLoading(true);
      if (errEl) errEl.hidden = true;
      try {
        const profile = await api.profile.load(ref.path);
        if (!alive) return;
        proceed(profile, card);
      } catch (err) {
        if (!alive) return;
        busy = false;
        stage.classList.remove('is-busy');
        card.classList.remove('is-loading');
        btn?.setLoading(false);
        sound.play('error');
        shake(card);
        if (errEl) {
          errEl.replaceChildren(icon('x-circle', { size: 16, strokeWidth: 2 }), h('span', `Konnte nicht geladen werden: ${(err && err.message) || 'unbekannter Fehler'}`));
          errEl.hidden = false;
        }
      }
    }

    async function openFile(tile) {
      tile.setBusy(true);
      try {
        const profile = await api.profile.open();
        if (!alive) return;
        tile.setBusy(false);
        if (profile) proceed(profile, tile);
      } catch (err) {
        if (!alive) return;
        tile.setBusy(false);
        shake(tile);
        toast.error('Datei konnte nicht geöffnet werden', (err && err.message) || 'Die Datei ist keine gültige Phoenix-Profil-Datei.');
      }
    }

    async function openCode(tile) {
      tile.setBusy(true);
      stopPolling();
      try {
        const profile = await openCodeDialog({ api, modal, sound });
        if (!alive) return;
        tile.setBusy(false);
        if (profile) proceed(profile, tile);
        else if (state === 'empty') startPolling();
      } catch (err) {
        if (!alive) return;
        tile.setBusy(false);
        toast.error('Code konnte nicht geladen werden', (err && err.message) || '');
      }
    }

    search();

    return () => {
      alive = false;
      searchId++;
      stopPolling();
      timers.forEach(clearTimeout);
      timers.clear();
      radar?.destroy();
      cleanups.forEach((fn) => fn && fn());
    };
  },
};
