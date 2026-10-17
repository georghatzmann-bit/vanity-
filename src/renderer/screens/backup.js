// Sichern – one screen, three phases with cinematic transitions:
//   A) SCAN    automatic scan with radar scanner, live count-up, phase checklist (error → retry)
//   B) REVIEW  what was found (apps by category, games, "manuell"), profile built + stored
//   C) SAVE    targets (USB first, drives, OneDrive, dialog, restore code) + silent documents copy,
//              success checklist once the backup lives somewhere that survives the reset.
// Writes store.scan (ScanResult) and store.profile (Profile, ARCHITECTURE §5) → leaves to `home`.
import '../styles/screens/backup.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';
import { ProgressBar } from '../components/progressBar.js';
import { AppIcon } from '../components/appCard.js';
import { BackupScanner } from '../components/backupScanner.js';
import { BackupReview, appKey } from '../components/backupReview.js';
import { BackupSave } from '../components/backupSave.js';
import { gsap, motionOK, richMotion, revealText, scrambleText } from '../core/motion.js';
import { formatPercent } from '../core/format.js';

const PHASES = [
  { key: 'winget', title: 'winget-Export', hint: 'Alle Apps, die winget wieder installieren kann' },
  { key: 'registry', title: 'Installierte Programme', hint: 'Namen und Versionen aus der Registry' },
  { key: 'games', title: 'Spielebibliotheken', hint: 'Epic Games und Steam' },
  { key: 'icons', title: 'Icons', hint: 'Damit du deine Apps später wiedererkennst' },
];
const PHASE_INDEX = { start: 0, winget: 0, registry: 1, games: 2, icons: 3, done: 4 };
const STEPS = [
  { key: 'scan', label: 'Scannen' },
  { key: 'review', label: 'Prüfen' },
  { key: 'save', label: 'Speichern' },
];

const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return out;
};

/** Profile per ARCHITECTURE §5 – built from the scan, everything included. */
export function buildProfile(scan, { appVersion = '', machine = null } = {}) {
  return {
    format: 'phoenix-profile',
    version: 1,
    createdAt: new Date().toISOString(),
    appVersion: String(appVersion || ''),
    machine: scan.machine || machine || null,
    apps: (scan.apps || []).map((a) => pick(a, ['id', 'source', 'name', 'version', 'publisher', 'category', 'icon', 'elevation'])),
    games: (scan.games || []).map((g) => ({ ...g })),
    unmatched: (scan.unmatched || []).map((u) => pick(u, ['name', 'publisher', 'version'])),
  };
}

const two = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`;
};

export default {
  title: 'Sichern',
  fxState: 'scan',
  mount(container, ctx) {
    const { api, store, router, fx, sound, modal } = ctx;
    container.classList.add('screen--backup');

    let disposed = false;
    let phase = 'scan';
    let scanRun = 0;
    let scanning = false;
    let profileRev = 0;
    let lastPhaseIdx = -1;
    let elapsedTimer = 0;
    let startedAt = 0;
    let skip = null; // resolves pending cinematic waits early
    let switchId = 0;
    const timers = new Set();
    const tweens = [];
    const offs = [];
    const track = (t) => (t && tweens.push(t), t);

    const wait = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(() => {
          timers.delete(t);
          resolve();
        }, ms);
        timers.add(t);
        const prev = skip;
        skip = () => {
          clearTimeout(t);
          timers.delete(t);
          resolve();
          prev?.();
        };
      });

    // Catalog (names/descriptions/favicons) and app version load in parallel with the scan.
    const catalogP = api.catalog
      .get()
      .then((c) => {
        const map = new Map();
        for (const it of (c && c.items) || []) map.set(`${it.source}:${String(it.id).toLowerCase()}`, it);
        return { map, order: (c && c.categories) || [] };
      })
      .catch(() => ({ map: new Map(), order: [] }));
    const appInfoP = store.get('appInfo') ? Promise.resolve(store.get('appInfo')) : api.app.info().catch(() => null);

    // ------------------------------------------------------------------ top bar
    const backLabel = h('span', 'Abbrechen');
    const backBtn = h('button.back-link.bk-back', { type: 'button', onClick: () => onBack() }, icon('arrow-left'), backLabel);
    const stepEls = STEPS.map((s, i) =>
      h(
        'li.bk-step',
        { dataset: { step: s.key } },
        h('span.bk-step__dot', h('span.bk-step__num', String(i + 1)), h('span.bk-step__check', icon('check', { size: 12, strokeWidth: 2.6 }))),
        h('span.bk-step__label', s.label),
      ),
    );
    const steps = h('ol.bk-steps', { attrs: { 'aria-label': 'Fortschritt' } }, stepEls.flatMap((s, i) => (i ? [h('li.bk-steps__sep', { attrs: { 'aria-hidden': 'true' } }), s] : [s])));
    const top = h('div.bk-top', { dataset: { stagger: '' } }, backBtn, steps);

    function syncTop() {
      const idx = STEPS.findIndex((s) => s.key === phase);
      stepEls.forEach((el, i) => {
        el.dataset.state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
        if (i === idx) el.setAttribute('aria-current', 'step');
        else el.removeAttribute('aria-current');
      });
      steps.querySelectorAll('.bk-steps__sep').forEach((sep, i) => sep.classList.toggle('is-done', i < idx));
      backLabel.textContent = phase === 'scan' ? (scanning ? 'Abbrechen' : 'Startseite') : phase === 'review' ? 'Startseite' : 'Zurück zur Übersicht';
    }

    // ------------------------------------------------------------------ phase A: scan
    const scanner = BackupScanner();
    const liveText = h('span.bk-scan__live', 'Scan läuft');
    const elapsedEl = h('span.bk-scan__time.t-num', '00:00');
    const titleL1 = h('span.bk-scan__line', 'Wir erfassen');
    const titleL2 = h('span.bk-scan__line.t-grad.t-shine.deco', 'deinen PC.');
    const scanTitle = h('h1.bk-scan__title', { tabIndex: -1, attrs: { 'aria-label': 'Wir erfassen deinen PC.' } }, titleL1, titleL2);
    const feedMsg = h('span.bk-feed__msg', 'Scan wird gestartet …');
    const pctEl = h('span.bk-scan__pct.t-num', '0 %');
    const bar = ProgressBar({ value: 0, size: 'lg', active: true, label: 'Scan-Fortschritt' });
    const phaseRows = PHASES.map((p) =>
      h(
        'li.bk-prow',
        { dataset: { s: 'todo' } },
        h('span.bk-prow__mark', h('span.bk-prow__dot'), h('span.spinner.bk-prow__spin'), h('span.bk-prow__check', icon('check', { size: 14, strokeWidth: 2.6 }))),
        h('div.bk-prow__text', h('div.bk-prow__title', p.title), h('div.bk-prow__hint', p.hint)),
        h('span.bk-prow__state', 'Wartet'),
      ),
    );
    const info = h(
      'div.bk-scan__info',
      h('div.t-eyebrow.bk-scan__eyebrow', { dataset: { stagger: '' } }, h('span.bk-live-dot'), liveText, h('span.bk-scan__sep'), elapsedEl),
      scanTitle,
      h('p.bk-scan__lead', { dataset: { stagger: '' } }, 'Apps, Spiele und Hardware-Infos – alles kommt in die Sicherung. Du musst nichts auswählen.'),
      h('div.bk-feed.t-mono', { dataset: { stagger: '' }, attrs: { 'aria-live': 'polite' } }, h('span.bk-feed__caret', '›'), feedMsg),
      h('ol.bk-plist', { dataset: { stagger: '' } }, phaseRows),
      h('div.bk-scan__progress', { dataset: { stagger: '' } }, bar, pctEl),
    );
    const errorBox = h('div.bk-error', { hidden: true, attrs: { role: 'alert' } });
    const scanSec = h(
      'section.bk-phase.bk-scan',
      { attrs: { 'aria-label': 'Scan' } },
      h('div.bk-scan__visual', { dataset: { stagger: '' } }, scanner, h('p.bk-scan__skip', { hidden: true }, 'Klick zum Überspringen')),
      info,
      errorBox,
    );

    let feedScr = null;
    function setFeed(text) {
      if (!text || feedMsg.dataset.text === text) return;
      feedMsg.dataset.text = text;
      feedScr?.cancel();
      feedScr = scrambleText(feedMsg, text, { duration: 0.45 });
    }

    function setPhaseRows(idx) {
      phaseRows.forEach((row, i) => {
        const s = i < idx ? 'done' : i === idx ? 'run' : 'todo';
        if (row.dataset.s === s) return;
        row.dataset.s = s;
        row.querySelector('.bk-prow__state').textContent = s === 'done' ? 'Fertig' : s === 'run' ? 'Läuft' : 'Wartet';
        if (s === 'done' && motionOK()) {
          track(gsap.fromTo(row.querySelector('.bk-prow__check'), { scale: 0, rotate: -30 }, { scale: 1, rotate: 0, duration: 0.55, ease: 'back.out(3)' }));
          track(gsap.fromTo(row, { backgroundColor: 'rgba(139, 92, 246, 0.16)' }, { backgroundColor: 'rgba(139, 92, 246, 0)', duration: 0.9, ease: 'power2.out', clearProps: 'backgroundColor' }));
        }
      });
    }

    function setPct(pct) {
      const v = Math.min(100, Math.max(0, Number(pct) || 0));
      bar.setValue(v / 100);
      pctEl.textContent = formatPercent(v / 100);
      scanner.setProgress(v / 100);
      fx.setProgress(v / 100);
    }

    function onProgress(p) {
      if (!scanning || !p) return;
      if (Number.isFinite(Number(p.pct))) setPct(p.pct);
      if (Number.isFinite(Number(p.found)) && p.found !== null) scanner.setFound(p.found);
      if (p.message) setFeed(p.message);
      const idx = PHASE_INDEX[p.phase];
      if (idx !== undefined && idx !== lastPhaseIdx) {
        if (idx > lastPhaseIdx && idx < 4) sound.play('scan');
        lastPhaseIdx = idx;
        setPhaseRows(idx);
      }
    }
    offs.push(api.on('scan:progress', onProgress));

    function startClock() {
      clearInterval(elapsedTimer);
      startedAt = performance.now();
      elapsedEl.textContent = '00:00';
      elapsedTimer = setInterval(() => (elapsedEl.textContent = clock(performance.now() - startedAt)), 1000);
    }

    async function runScan() {
      const my = ++scanRun;
      scanning = true;
      lastPhaseIdx = -1;
      scanSec.classList.remove('is-error', 'is-done');
      errorBox.hidden = true;
      errorBox.replaceChildren();
      info.hidden = false;
      scanner.reset();
      scanner.setState('scanning');
      scanner.setLabel('Apps erkannt');
      liveText.textContent = 'Scan läuft';
      bar.setTone(null);
      bar.setActive(true);
      setPct(0);
      setPhaseRows(0);
      setFeed('Scan wird gestartet …');
      fx.setState('scan');
      syncTop();
      startClock();

      let result;
      try {
        result = await api.scan.run();
      } catch (err) {
        if (disposed || my !== scanRun) return;
        showScanError(err);
        return;
      }
      if (disposed || my !== scanRun) return;
      await finishScan(result || {}, my);
    }

    function showScanError(err) {
      scanning = false;
      clearInterval(elapsedTimer);
      scanSec.classList.add('is-error');
      scanner.setState('error');
      scanner.setLabel('Fehler');
      bar.setTone('err');
      bar.setActive(false);
      liveText.textContent = 'Gestoppt';
      fx.setState('error');
      sound.play('error');
      syncTop();
      const msg = (err && err.message) || 'Der Scan ist unerwartet abgebrochen.';
      const retry = Button({ label: 'Erneut versuchen', icon: 'refresh', variant: 'primary', size: 'lg', onClick: () => runScan() });
      const home = Button({ label: 'Zur Startseite', variant: 'ghost', size: 'lg', onClick: () => leave() });
      errorBox.replaceChildren(
        h('div.t-eyebrow.bk-error__eyebrow', icon('x-circle', { size: 14, strokeWidth: 2.2 }), 'Scan fehlgeschlagen'),
        h('h1.bk-error__title', { tabIndex: -1 }, 'Das hat nicht geklappt.'),
        h('div.bk-error__msg', icon('alert', { size: 18, strokeWidth: 2 }), h('span', msg)),
        h('p.bk-error__hint', 'Meist hilft ein zweiter Versuch. Bleibt der Fehler, starte Phoenix neu.'),
        h('div.bk-error__actions', retry, home),
      );
      offs.push(() => {
        retry.destroy();
        home.destroy();
      });
      info.hidden = true;
      errorBox.hidden = false;
      if (motionOK()) {
        track(gsap.fromTo(errorBox.children, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out', stagger: 0.06, clearProps: 'opacity,transform' }));
        track(gsap.fromTo(scanner, { x: 0 }, { duration: 0.5, ease: 'none', keyframes: { x: [0, -10, 9, -6, 4, 0] }, clearProps: 'transform' }));
      }
      errorBox.querySelector('.bk-error__title').focus({ preventScroll: true });
    }

    function iconNodes(result, catalog) {
      const apps = [...(result.apps || [])].sort((a, b) => (b.icon ? 1 : 0) - (a.icon ? 1 : 0)).slice(0, 26);
      const nodes = apps.map((a) => {
        const hit = catalog.get(appKey(a));
        return AppIcon({ name: a.name || a.id, icon: a.icon, homepage: hit && hit.homepage, size: 44 });
      });
      for (const g of (result.games || []).slice(0, 4)) nodes.push(AppIcon({ name: g.title, size: 44 }));
      return nodes;
    }

    async function finishScan(raw, my) {
      const result = {
        apps: Array.isArray(raw.apps) ? raw.apps : [],
        games: Array.isArray(raw.games) ? raw.games : [],
        unmatched: Array.isArray(raw.unmatched) ? raw.unmatched : [],
        machine: raw.machine || store.get('machine') || null,
        winget: raw.winget || { ok: false, version: null },
        warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      };
      const durationMs = performance.now() - startedAt;
      scanning = false;
      clearInterval(elapsedTimer);
      lastPhaseIdx = 4;
      setPhaseRows(4);
      setPct(100);
      bar.setActive(false);
      bar.setTone('ok');
      scanner.setFound(result.apps.length);
      scanner.setState('done');
      scanner.setLabel(result.apps.length === 1 ? 'App erfasst' : 'Apps erfasst');
      liveText.textContent = 'Fertig';
      setFeed(`Fertig – ${result.apps.length} Apps und ${result.games.length} Spiele erfasst.`);
      scanSec.classList.add('is-done');

      const [{ map, order }, appInfo] = await Promise.all([catalogP, appInfoP]);
      if (disposed || my !== scanRun) return;
      if (appInfo && !store.get('appInfo')) store.set('appInfo', appInfo);
      if (!result.machine) result.machine = await api.system.info().catch(() => null);
      if (disposed || my !== scanRun) return;

      const profile = buildProfile(result, { appVersion: appInfo && appInfo.version, machine: result.machine });
      profileRev++;
      store.patch({ scan: result, profile, ...(result.machine ? { machine: result.machine } : {}) });
      review.render({ scan: result, catalog: map, catalogOrder: order, durationMs });

      // Cinematic: icons spiral into the core, the vault locks, then the review takes over.
      const skipHint = scanSec.querySelector('.bk-scan__skip');
      const onSkip = (e) => {
        if (e.type === 'keydown' && !['Enter', ' ', 'Escape'].includes(e.key)) return;
        tl?.progress(1);
        skip?.();
      };
      let tl = null;
      if (richMotion()) {
        container.addEventListener('pointerdown', onSkip);
        container.addEventListener('keydown', onSkip);
        skipHint.hidden = false;
        await wait(380);
        if (disposed || my !== scanRun) return;
        sound.play('rise');
        tl = scanner.absorb(iconNodes(result, map));
        if (tl) {
          track(tl);
          await Promise.race([tl.then(() => {}), new Promise((r) => (skip = r))]);
        }
        if (disposed || my !== scanRun) return;
        scanner.lock();
        fx.pulse(1.3);
        sound.play('boom');
        await wait(720);
        container.removeEventListener('pointerdown', onSkip);
        container.removeEventListener('keydown', onSkip);
        skipHint.hidden = true;
      } else if (motionOK()) {
        scanner.lock();
        await wait(600);
      } else {
        scanner.lock();
        await wait(450); // no motion: still give the finished checklist a beat
      }
      if (disposed || my !== scanRun) return;
      fx.setState('idle');
      fx.setProgress(0);
      await switchPhase('review');
    }

    // ------------------------------------------------------------------ phase B + C
    const review = BackupReview({ onSave: () => goSave() });
    const save = BackupSave({
      ctx,
      onDone: () => {
        router.resetHistory();
        router.go('home', {}, { transition: 'warp' });
      },
    });

    function goSave() {
      const profile = store.get('profile');
      if (!profile) return;
      save.prepare(profile, profileRev);
      fx.pulse(0.8);
      switchPhase('save');
    }

    const sections = { scan: scanSec, review: review.el, save: save.el };

    async function switchPhase(next) {
      if (disposed || next === phase) return;
      const id = ++switchId;
      const from = sections[phase];
      const to = sections[next];
      const forward = STEPS.findIndex((s) => s.key === next) > STEPS.findIndex((s) => s.key === phase);
      phase = next;
      root.dataset.phase = next;
      syncTop();
      save.setActive(next === 'save');
      if (next !== 'save') fx.setState(next === 'scan' ? 'scan' : 'idle');

      if (motionOK()) {
        const rich = richMotion();
        const out =
          from === scanSec && rich
            ? { opacity: 0, scale: 0.9, y: -30, filter: 'blur(14px)', duration: 0.5, ease: 'power3.in' }
            : { opacity: 0, x: rich ? (forward ? -40 : 40) : 0, filter: rich ? 'blur(8px)' : 'none', duration: 0.32, ease: 'power2.in' };
        await track(gsap.to(from, out));
        if (disposed || id !== switchId) return;
      }
      from.hidden = true;
      gsap.set(from, { clearProps: 'opacity,transform,filter' });
      to.hidden = false;
      container.scrollTop = 0;
      const slideBack = () =>
        motionOK() && track(gsap.fromTo(to, { opacity: 0, x: -36 }, { opacity: 1, x: 0, duration: 0.55, ease: 'expo.out', clearProps: 'opacity,transform' }));
      if (next === 'review') {
        if (forward) review.enter();
        else slideBack();
        review.focus();
      } else if (next === 'save') {
        if (forward) save.enter();
        else slideBack();
        save.focus();
      } else if (next === 'scan') {
        if (motionOK()) track(gsap.fromTo(to, { opacity: 0 }, { opacity: 1, duration: 0.4, clearProps: 'opacity' }));
        scanTitle.focus({ preventScroll: true });
      }
    }

    // ------------------------------------------------------------------ navigation
    function leave() {
      router.go('home', {}, { transition: 'slide', direction: 'back' });
    }

    async function onBack() {
      if (phase === 'scan') return leave();
      if (phase === 'save') return switchPhase('review');
      // review: nothing saved yet (or only on this PC) – make sure that is intended.
      if (save.hasOffPc()) return leave();
      const ok = await modal.confirm({
        title: 'Sicherung verwerfen?',
        message: 'Du hast noch nichts gespeichert, das den Reset übersteht. Ohne Sicherung weiß Phoenix danach nicht mehr, was installiert war.',
        confirmLabel: 'Verwerfen',
        cancelLabel: 'Weiter sichern',
        danger: true,
      });
      if (ok && !disposed) leave();
    }

    // ------------------------------------------------------------------ mount
    const stage = h('div.bk-stage', scanSec, review.el, save.el);
    const root = h('div.screen__inner.bk', { dataset: { phase: 'scan' } }, top, stage);
    container.append(root);
    syncTop();

    track(revealText(titleL1, { delay: 0.3 }));
    track(revealText(titleL2, { delay: 0.48 }));
    if (motionOK()) {
      const rich = richMotion();
      const ring = scanner.querySelector('.bks__core');
      track(gsap.fromTo(ring, { scale: rich ? 0.4 : 0.9, opacity: 0 }, { scale: 1, opacity: 1, duration: 1.2, ease: 'expo.out', delay: 0.25, clearProps: 'transform,opacity' }));
      if (rich) {
        track(gsap.fromTo(scanner.querySelectorAll('.bks__svg, .bks__ticks, .bks__dashes'), { scale: 1.25, opacity: 0, rotate: -25 }, { scale: 1, opacity: 1, rotate: 0, duration: 1.4, ease: 'expo.out', stagger: 0.08, delay: 0.2, clearProps: 'transform,opacity' }));
      }
    }

    // Kick off the scan after the entrance has started (mount must return fast).
    const kick = setTimeout(() => !disposed && runScan(), 120);
    timers.add(kick);

    return () => {
      disposed = true;
      scanning = false;
      skip?.();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      clearInterval(elapsedTimer);
      feedScr?.cancel();
      offs.forEach((fn) => fn && fn());
      tweens.forEach((t) => (typeof t.kill === 'function' ? t.kill() : t.cancel?.()));
      scanner.destroy();
      review.destroy();
      save.destroy();
    };
  },
};
