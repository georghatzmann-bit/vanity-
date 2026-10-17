// First-run screen. The cinematic itself is the FX engine's boot intro (fx/timeline.js, 7 s): the
// emblem + wordmark assemble in the background and glide to the titlebar, then this screen reveals
// its setup panel (onIntroDone). Without live FX (static tier / no WebGL) the DOM logo is shown.
// Real data: system.info() + winget.ensure() progress; ends with app.markInstalled() -> home.
// Click, Esc or Space skips the intro.
import '../styles/screens/boot.css';
import { h } from '../core/dom.js';
import { icon, logoMark } from '../components/icons.js';
import { Button } from '../components/button.js';
import { ProgressBar } from '../components/progressBar.js';
import { scrambleText, gsap, motionOK } from '../core/motion.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  title: 'Willkommen',
  fxState: 'boot',
  mount(container, ctx) {
    const { api, router, fx, sound, store } = ctx;
    let alive = true;
    let scramble = null;
    const offs = [];

    const word = h('h1.boot__word', 'PHOENIX');
    const mark = h('div.boot__mark', h('span.boot__halo.deco'), h('span.boot__orbit.deco'), logoMark({ size: 88 }));
    const sub = h('p.boot__sub', 'Wird eingerichtet …');
    const bar = ProgressBar({ value: null, size: 'sm', label: 'Einrichtung' });
    const steps = [
      { key: 'sys', label: 'System wird erkannt …', done: 'System erkannt' },
      { key: 'winget', label: 'winget wird geprüft …', done: 'winget ist bereit', warn: 'winget braucht Hilfe' },
      { key: 'ready', label: 'Letzte Vorbereitungen …', done: 'Alles bereit' },
    ].map((s) => {
      const state = h('span.boot__state', h('span.spinner'));
      const label = h('span.boot__label', s.label);
      const detail = h('span.boot__detail');
      const row = h('li.boot__step', state, label, detail);
      return { ...s, row, state, label, detail };
    });
    const startBtn = Button({
      label: 'Los geht’s',
      variant: 'primary',
      size: 'xl',
      iconRight: 'arrow-right',
      onClick: async () => {
        sound.play('boom');
        fx.burst();
        await api.app.markInstalled().catch(() => {});
        router.go('home', {}, { transition: 'warp' });
      },
    });
    startBtn.hidden = true;

    const inner = h(
      'div.screen__inner.boot',
      mark,
      word,
      sub,
      h('div.boot__panel.card', { dataset: { stagger: '' } }, h('ul.boot__steps', steps.map((s) => s.row)), bar),
      h('div.boot__cta', startBtn),
    );
    container.append(inner);

    // --- FX intro: the DOM logo/word would duplicate the FX emblem, so they stay hidden while a live
    // FX tier plays the cinematic; the setup panel fades in when the logo has reached the titlebar.
    const cinematic = motionOK() && fx.tier !== 'static';
    let revealed = !cinematic;
    const reveal = () => {
      if (revealed || !alive) return;
      revealed = true;
      inner.classList.remove('boot--cinematic');
      if (fx.tier === 'static' || !fx.attached) inner.classList.add('boot--dom-logo');
      const panel = inner.querySelector('.boot__panel');
      if (panel) requestAnimationFrame(() => alive && fx.setScrim?.([panel.getBoundingClientRect()]));
    };
    if (cinematic) {
      inner.classList.add('boot--cinematic');
      offs.push(fx.onIntroDone?.(reveal));
      // engine missing / not attached after a moment -> show the DOM version right away
      const t1 = setTimeout(() => !fx.attached && reveal(), 2500);
      const t2 = setTimeout(reveal, 9000);
      offs.push(() => clearTimeout(t1), () => clearTimeout(t2));
      const skip = (e) => {
        if (revealed) return;
        if (e.type === 'keydown' && e.key !== 'Escape' && e.key !== ' ') return;
        fx.skipIntro?.();
      };
      window.addEventListener('keydown', skip);
      window.addEventListener('pointerdown', skip);
      offs.push(() => window.removeEventListener('keydown', skip), () => window.removeEventListener('pointerdown', skip));
    } else inner.classList.add('boot--dom-logo');

    const markDone = (step, text, ok = true) => {
      step.state.replaceChildren(icon(ok ? 'check' : 'alert', { size: 14, strokeWidth: 2.5 }));
      step.row.classList.add(ok ? 'is-done' : 'is-warn');
      step.label.textContent = ok ? step.done : step.warn || step.done;
      if (text) step.detail.textContent = text;
    };

    (async () => {
      sound.play('rise');
      if (motionOK()) gsap.fromTo(mark, { scale: 0.6, opacity: 0, filter: 'blur(20px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 1.4, ease: 'expo.out' });
      scramble = scrambleText(word, 'PHOENIX', { duration: 1.4, delay: 0.2 });
      await scramble.finished;
      if (!alive) return;

      bar.setValue(0.1);
      try {
        const m = await api.system.info();
        store.set('machine', m);
        const gpu = m.gpus && m.gpus[0] ? m.gpus[0].name : '';
        markDone(steps[0], [m.os.caption, gpu].filter(Boolean).join(' · '));
      } catch {
        markDone(steps[0], 'Nicht alle Infos verfügbar', false);
      }
      if (!alive) return;
      bar.setValue(0.35);

      offs.push(api.on('winget:ensure-progress', (p) => alive && (steps[1].detail.textContent = p.message)));
      try {
        const res = await api.winget.ensure();
        markDone(steps[1], res.ok ? `Version ${res.version}` : res.error || 'Wird später repariert', res.ok);
      } catch (err) {
        markDone(steps[1], err.message, false);
      }
      if (!alive) return;
      bar.setValue(1);
      bar.setTone('ok');
      await sleep(250);
      markDone(steps[2], '');
      sub.textContent = 'Bereit, wenn du es bist.';
      sound.play('success');
      fx.pulse(1);
      startBtn.hidden = false;
      if (motionOK()) gsap.fromTo(startBtn, { y: 20, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.9, ease: 'elastic.out(1, 0.6)' });
      startBtn.focus({ preventScroll: true });
    })();

    return () => {
      alive = false;
      fx.setScrim?.([]);
      scramble?.cancel();
      offs.forEach((off) => off && off());
      startBtn.destroy();
    };
  },
};
