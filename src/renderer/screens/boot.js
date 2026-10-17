// PLACEHOLDER first-run cinematic – the FX/feature agents replace this with the full intro.
// Real data: system.info() + winget.ensure() progress; ends with app.markInstalled() -> home.
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
    const offs = [];

    const word = h('h1.boot__word', 'PHOENIX');
    const mark = h('div.boot__mark', h('span.boot__halo.deco'), h('span.boot__orbit.deco'), logoMark({ size: 88 }));
    const sub = h('p.boot__sub', 'Wird eingerichtet …');
    const bar = ProgressBar({ value: null, size: 'sm', label: 'Einrichtung' });
    const steps = [
      { key: 'sys', label: 'System wird erkannt' },
      { key: 'winget', label: 'Paketmanager winget wird geprüft' },
      { key: 'ready', label: 'Alles bereit' },
    ].map((s) => {
      const state = h('span.boot__state', h('span.spinner'));
      const detail = h('span.boot__detail');
      const row = h('li.boot__step', state, h('span.boot__label', s.label), detail);
      return { ...s, row, state, detail };
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

    const markDone = (step, text, ok = true) => {
      step.state.replaceChildren(icon(ok ? 'check' : 'alert', { size: 14, strokeWidth: 2.5 }));
      step.row.classList.add(ok ? 'is-done' : 'is-warn');
      if (text) step.detail.textContent = text;
    };

    (async () => {
      sound.play('rise');
      if (motionOK()) gsap.fromTo(mark, { scale: 0.6, opacity: 0, filter: 'blur(20px)' }, { scale: 1, opacity: 1, filter: 'blur(0px)', duration: 1.4, ease: 'expo.out' });
      await scrambleText(word, 'PHOENIX', { duration: 1.4, delay: 0.2 }).finished;
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
      offs.forEach((off) => off && off());
      startBtn.destroy();
    };
  },
};
