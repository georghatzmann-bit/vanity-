// First-run "installation cinematic" – the first thing the user sees after Setup.exe.
//
// Cinematic path (live WebGL tier, motion allowed): the FX engine plays the FULL intro (7 s, the
// emblem assembles, climax, logo glides into the titlebar) and a DOM HUD on top decodes REAL data in
// sync with the intro clock (fx.introClock().tau): Windows edition/build, CPU, GPU, RAM, host and the
// live winget check. The tagline "DEIN PC. WIEDERGEBOREN." decodes under the wordmark at the climax.
// Click / Esc / Space / Enter skips to the end of the intro.
//
// Calm path (reduced motion, effects "off", CSS tier, or the engine is not ready in time): the DOM
// emblem + a quiet setup card that fills with the same real data.
//
// Both end in the "Bereit" card once the intro is over AND the winget check finished: primary
// "Los geht's" (auto-continues after 4 s) -> api.app.markInstalled() -> home (FX warp).
import '../styles/screens/boot.css';
import { h } from '../core/dom.js';
import { icon, logoMark } from '../components/icons.js';
import { Button } from '../components/button.js';
import { gsap, motionOK } from '../core/motion.js';
import { decode } from '../fx/text/decode.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const hash = (a, b) => {
  let v = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) >>> 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177) >>> 0;
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};
const AUTO_CONTINUE_MS = 4000;
const TAGLINE = 'DEIN PC. WIEDERGEBOREN.';

// ---- real data -> HUD strings ------------------------------------------------------------------
const up = (s) => String(s || '').toUpperCase();
function cleanCpu(s) {
  return String(s || '')
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\b(CPU|Processor|with Radeon Graphics)\b/gi, '')
    .replace(/@.*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const gpuName = (m) => (m && m.gpus && m.gpus[0] ? m.gpus[0].name : '');
const osLine = (m) => [String(m.os?.caption || '').replace(/^Microsoft\s+/i, ''), m.os?.displayVersion].filter(Boolean).join(' ') + (m.os?.build ? ` · ${m.os.build}` : '');
const shortOs = (m) => [String(m.os?.caption || '').replace(/^Microsoft\s+/i, ''), m.os?.displayVersion].filter(Boolean).join(' ');
const shortGpu = (m) => gpuName(m).replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, '');

export default {
  title: 'Willkommen',
  fxState: 'boot',
  mount(container, ctx) {
    const { api, router, fx, sound, store } = ctx;
    const version = (store.get('appInfo') || {}).version || '';
    let alive = true;
    let raf = 0;
    const offs = [];
    const later = (fn, ms) => {
      const t = setTimeout(() => alive && fn(), ms);
      offs.push(() => clearTimeout(t));
    };

    const root = h('div.boot');
    const live = h('p.sr-only', { attrs: { role: 'status', 'aria-live': 'polite' } }, 'Phoenix wird eingerichtet …');
    root.append(live);
    container.append(root);

    // ------------------------------------------------------------------ data (starts right away)
    const data = {
      sys: null,
      sysDone: false,
      wg: { done: false, ok: false, message: 'winget wird gesucht …', version: '', error: '' },
    };
    let onData = () => {};
    api.system
      .info()
      .then((m) => {
        data.sys = m;
        store.set('machine', m);
      })
      .catch(() => {})
      .finally(() => {
        data.sysDone = true;
        alive && onData();
      });
    offs.push(
      api.on('winget:ensure-progress', (p) => {
        if (!alive || !p || !p.message || data.wg.done) return;
        data.wg.message = p.message;
        onData();
      }),
    );
    api.winget
      .ensure()
      .then((res) => {
        data.wg.ok = !!(res && res.ok);
        data.wg.version = (res && res.version) || '';
        data.wg.error = (res && res.error) || '';
      })
      .catch((err) => {
        data.wg.ok = false;
        data.wg.error = (err && err.message) || '';
      })
      .finally(() => {
        data.wg.done = true;
        alive && onData();
      });

    // ------------------------------------------------------------------ "Bereit" card
    let leaving = false;
    let countdown = null; // { kill() } while the auto-continue runs
    const proceed = async () => {
      if (leaving || !alive) return;
      leaving = true;
      countdown?.kill();
      await Promise.race([api.app.markInstalled().catch(() => {}), sleep(600)]);
      if (alive) router.go('home', {}, { transition: 'warp' });
    };

    const startBtn = Button({ label: 'Los geht’s', variant: 'primary', size: 'xl', iconRight: 'arrow-right', onClick: proceed });
    const laterBtn = Button({ label: 'Im Hintergrund weiter', variant: 'ghost', size: 'md', onClick: proceed });
    offs.push(() => startBtn.destroy(), () => laterBtn.destroy());

    const fact = (iconName) => {
      const state = h('span.boot-fact__state');
      const text = h('span.boot-fact__text');
      const el = h('li.boot-fact', h('span.boot-fact__icon', icon(iconName, { size: 16 })), text, state);
      return {
        el,
        set(label, tone) {
          if (text.textContent !== label) text.textContent = label;
          if (el.dataset.tone === tone) return; // keep the spinner running between re-renders
          el.dataset.tone = tone;
          state.replaceChildren(
            tone === 'pending' ? h('span.spinner') : icon(tone === 'ok' ? 'check' : 'alert', { size: 13, strokeWidth: 2.6 }),
          );
        },
      };
    };
    const facts = { os: fact('windows'), gpu: fact('gpu'), wg: fact('terminal') };
    const eyebrow = h('div.boot-ready__eyebrow', h('span.boot-ready__dot'), h('span.boot-ready__eyebrow-text', 'Einrichtung'));
    const title = h('h1.boot-ready__title');
    const lead = h('p.boot-ready__lead');
    const note = h('p.boot-ready__note', { hidden: true });
    const autoFill = h('span.boot-ready__auto-fill');
    const autoText = h('span.boot-ready__auto-text');
    const auto = h('div.boot-ready__auto', { hidden: true }, h('span.boot-ready__auto-track', autoFill), autoText);
    const cta = h('div.boot-ready__cta', startBtn, laterBtn);
    startBtn.hidden = true;
    laterBtn.hidden = true;
    const card = h(
      'section.boot-ready.card',
      { attrs: { 'aria-labelledby': 'boot-ready-title' } },
      eyebrow,
      title,
      lead,
      h('ul.boot-ready__facts', facts.os.el, facts.gpu.el, facts.wg.el),
      note,
      cta,
      auto,
    );
    title.id = 'boot-ready-title';
    const stage = h('div.boot__stage', card);
    let cardShown = false;
    let waitSince = 0;
    let wasReady = false;

    function renderCard() {
      const m = data.sys;
      facts.os.set(m ? shortOs(m) || 'Windows' : data.sysDone ? 'System: nicht alle Infos verfügbar' : 'System wird erkannt …', m ? 'ok' : data.sysDone ? 'warn' : 'pending');
      const g = m ? shortGpu(m) : '';
      facts.gpu.set(g || (data.sysDone ? 'Grafikkarte: unbekannt' : 'Grafikkarte wird erkannt …'), g ? 'ok' : data.sysDone ? 'warn' : 'pending');
      const wg = data.wg;
      if (!wg.done) facts.wg.set(wg.message || 'winget wird geprüft …', 'pending');
      else if (wg.ok) facts.wg.set(`winget ${wg.version} ist bereit`, 'ok');
      else facts.wg.set('winget fehlt noch', 'warn');

      const ready = data.sysDone && wg.done;
      const user = m && m.user ? String(m.user).split(/[\\/]/).pop() : '';
      root.classList.toggle('is-ready', ready);
      if (ready) {
        eyebrow.lastChild.textContent = 'Einrichtung abgeschlossen';
        title.textContent = user ? `Bereit, ${user}.` : 'Bereit.';
        lead.textContent = 'Phoenix ist installiert. Sichere jetzt deine Apps – oder hol sie nach dem Windows-Reset mit einem Klick zurück.';
        note.hidden = wg.ok;
        if (!wg.ok) {
          note.replaceChildren(
            icon('alert', { size: 16 }),
            h(
              'span',
              h('b', 'winget ist noch nicht einsatzbereit. '),
              'Sichern funktioniert trotzdem. Vor der ersten Wiederherstellung versucht Phoenix die Reparatur automatisch noch einmal.',
              wg.error ? h('span.boot-ready__note-detail', `Grund: ${wg.error}`) : null,
            ),
          );
        }
        startBtn.hidden = false;
        laterBtn.hidden = true;
        if (!wasReady) {
          wasReady = true;
          live.textContent = `${title.textContent} Phoenix ist eingerichtet.`;
          if (cardShown) onReady();
        }
      } else {
        eyebrow.lastChild.textContent = 'Einrichtung läuft';
        title.textContent = data.sysDone ? 'Fast fertig …' : 'Wird eingerichtet …';
        lead.textContent = data.sysDone
          ? 'winget wird vorbereitet – damit installiert Phoenix deine Apps später. Das dauert beim ersten Start manchmal etwas.'
          : 'Phoenix schaut sich kurz deinen PC an.';
        startBtn.hidden = true;
        // never trap the user: after a while they may go ahead, winget keeps running in the background
        if (!waitSince) waitSince = performance.now();
        laterBtn.hidden = !(cardShown && performance.now() - waitSince > 6000);
      }
    }

    let announced = false;
    function onReady() {
      if (announced || !alive) return;
      announced = true;
      sound.play('success');
      fx.pulse(0.5);
      if (motionOK()) gsap.fromTo(startBtn, { y: 14, opacity: 0, scale: 0.94 }, { y: 0, opacity: 1, scale: 1, duration: 0.8, ease: 'elastic.out(1, 0.65)', clearProps: 'transform,opacity' });
      startBtn.focus({ preventScroll: true });
      if (data.wg.ok) startCountdown();
    }

    function startCountdown() {
      // wall-clock countdown on rAF: frame deltas are clamped, so it holds while the window is
      // hidden / minimised (nobody is looking) and while the pointer rests on the card
      auto.hidden = false;
      let elapsed = 0;
      let prev = performance.now();
      let paused = false;
      let frame = 0;
      const sync = () => {
        const p = Math.min(1, elapsed / AUTO_CONTINUE_MS);
        autoFill.style.transform = `scaleX(${1 - p})`;
        autoText.textContent = `Geht in ${Math.max(1, Math.ceil((AUTO_CONTINUE_MS - elapsed) / 1000))} s automatisch weiter`;
      };
      const tick = (now) => {
        frame = 0;
        if (!alive || !countdown) return;
        if (!paused) elapsed += Math.min(250, Math.max(0, now - prev));
        prev = now;
        sync();
        if (elapsed >= AUTO_CONTINUE_MS) {
          countdown = null;
          proceed();
          return;
        }
        frame = requestAnimationFrame(tick);
      };
      countdown = {
        kill() {
          cancelAnimationFrame(frame);
          countdown = null;
        },
      };
      sync();
      frame = requestAnimationFrame(tick);
      const pause = () => (paused = true);
      const resume = () => (paused = false);
      const stop = (e) => {
        // any keyboard navigation means the user is in control: no auto-continue
        if (e.key === 'Enter' || e.key === ' ') return;
        countdown?.kill();
        auto.hidden = true;
      };
      card.addEventListener('pointerenter', pause);
      card.addEventListener('pointerleave', resume);
      window.addEventListener('keydown', stop);
      offs.push(() => {
        countdown?.kill();
        card.removeEventListener('pointerenter', pause);
        card.removeEventListener('pointerleave', resume);
        window.removeEventListener('keydown', stop);
      });
    }

    function showCard({ calm }) {
      if (cardShown || !alive) return;
      cardShown = true;
      root.classList.add('is-card');
      if (calm) {
        stage.prepend(
          h('div.boot__brand', h('div.boot__mark', h('span.boot__halo.deco'), logoMark({ size: 104 })), h('div.boot__word', 'PHOENIX')),
        );
      }
      root.append(stage);
      renderCard();
      offs.push(fx.scrimFor([card]));
      if (motionOK()) {
        gsap.fromTo(
          stage.children,
          { opacity: 0, y: 22, filter: 'blur(10px)' },
          { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.9, ease: 'expo.out', stagger: 0.08, clearProps: 'filter,transform,opacity' },
        );
      } else gsap.fromTo(stage, { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'power1.out', clearProps: 'opacity' });
      // re-check the "go ahead anyway" escape hatch while waiting
      const iv = setInterval(() => alive && !wasReady && renderCard(), 1000);
      offs.push(() => clearInterval(iv));
    }

    // ------------------------------------------------------------------ cinematic HUD
    function runCinematic() {
      root.classList.add('is-cinematic');
      const hud = createHud(root, { fx, data, version });
      let introDone = false;
      let lastTau = 0;
      const fired = new Set();
      const once = (key, fn) => {
        if (fired.has(key)) return;
        fired.add(key);
        fn();
      };
      const finishIntro = () => {
        if (introDone) return;
        introDone = true;
        showCard({ calm: false });
      };
      offs.push(fx.onIntroDone(finishIntro));
      offs.push(fx.onTierChange((tier) => tier === 'static' && later(finishIntro, 450)));
      later(finishIntro, 12000); // failsafe: the card always comes

      // skip: click / Esc / Space / Enter jumps to the end of the intro (window controls excluded)
      const skip = (e) => {
        if (introDone) return;
        if (e.type === 'keydown' && !['Escape', ' ', 'Enter'].includes(e.key)) return;
        if (e.type === 'pointerdown' && e.target.closest && e.target.closest('#titlebar, .modal, .modal-backdrop')) return;
        if (e.type === 'keydown') e.preventDefault();
        fx.skipIntro();
      };
      window.addEventListener('keydown', skip);
      window.addEventListener('pointerdown', skip);
      offs.push(() => window.removeEventListener('keydown', skip), () => window.removeEventListener('pointerdown', skip));

      const loop = () => {
        raf = 0;
        if (!alive) return;
        const c = fx.introClock();
        if (!c) {
          // the intro left the screen (tier change, state change): hand over to the card
          finishIntro();
          hud.update(lastTau + 10, null);
          return;
        }
        const tau = c.tau;
        lastTau = tau;
        const M = c.marks;
        hud.update(tau, c);
        if (tau > M.clx - 1.55) once('rise', () => !c.skipped && sound.play('rise'));
        if (tau > M.clx) once('boom', () => !c.skipped && sound.play('boom'));
        if (tau > M.glide) once('whoosh', () => sound.play('whoosh'));
        if (tau >= M.done + 0.05) finishIntro();
        if (tau < M.idle + 0.6) raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      onData = () => {
        if (cardShown) renderCard();
      };
    }

    // ------------------------------------------------------------------ calm path
    function runCalm() {
      root.classList.add('is-calm');
      // engine too slow to start: when it arrives it must not play the cinematic behind the card
      if (!fx.attached) fx.setState('idle');
      onData = renderCard;
      showCard({ calm: true });
    }

    (async () => {
      const attached = await fx.whenReady(3000);
      if (!alive) return;
      const c = fx.introClock();
      if (attached && motionOK() && fx.tier !== 'static' && c && c.live) runCinematic();
      else runCalm();
    })();

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      offs.forEach((off) => off && off());
    };
  },
};

// ================================================================================================
// HUD: typed + scrambled readout over the intro (layout + decode() from the PLASMA prototype).
// Pure function of the intro time tau, so it follows skips and stays in sync with the FX.
// ================================================================================================
function createHud(host, { fx, data, version }) {
  const el = h('div.bh', { attrs: { 'aria-hidden': 'true' } });
  const corners = ['tl', 'tr', 'bl', 'br'].map((c) => h(`i.bh__corner.bh__corner--${c}`));
  const title = h('span');
  const linesEl = h('div.bh__lines');
  const tl = h('div.bh__blk.bh__blk--tl', h('div.bh__hdr', h('span.bh__dot'), title), linesEl);
  const tr1 = h('div');
  const tr2 = h('div.bh__dim');
  const sig = h('div.bh__sig');
  const bars = Array.from({ length: 12 }, () => h('i'));
  sig.append(...bars);
  const tr = h('div.bh__blk.bh__blk--tr', tr1, tr2, sig);
  const phase = h('span');
  const pct = h('span.bh__pct');
  const barFill = h('i');
  const sub = h('div.bh__dim.bh__sub');
  const bl = h('div.bh__blk.bh__blk--bl', h('div.bh__phase', phase, pct), h('div.bh__bar', barFill), sub);
  const tc = h('div');
  const q = h('div.bh__dim');
  const skipHint = h('div.bh__skip', 'KLICK · ESC = ÜBERSPRINGEN');
  const br = h('div.bh__blk.bh__blk--br', tc, q, skipHint);
  const tag = h('div.bh__tag');
  el.append(...corners, tl, tr, bl, br, tag);
  host.append(el);
  const blocks = [tl, tr, bl, br];

  const sys = () => data.sys;
  const pend = () => (data.sysDone ? 'NICHT VERFÜGBAR' : null);
  const LINES = [
    { k: 'SYS', at: 0.5, v: () => (sys() ? up(osLine(sys())) : pend()), tone: () => (sys() ? 'ok' : 'warn') },
    { k: 'CPU', at: 0.78, v: () => (sys() ? up(cleanCpu(sys().cpu)) || '—' : pend()), tone: () => (sys() ? 'ok' : 'warn') },
    { k: 'GPU', at: 1.06, v: () => (sys() ? up(gpuName(sys()) + (sys().gpus.length > 1 ? ` · +${sys().gpus.length - 1}` : '')) || '—' : pend()), tone: () => (sys() ? 'ok' : 'warn') },
    { k: 'RAM', at: 1.34, v: () => (sys() ? (sys().ramGB ? `${sys().ramGB} GB ARBEITSSPEICHER` : '—') : pend()), tone: () => (sys() ? 'ok' : 'warn') },
    { k: 'HOST', at: 1.62, v: () => (sys() ? up([sys().hostname, sys().user].filter(Boolean).join(' · ')) : pend()), tone: () => (sys() ? 'ok' : 'warn') },
    { k: 'APP', at: 1.9, v: () => `PHOENIX${version ? ` V${version}` : ''} · INSTALLIERT`, tone: () => 'acc' },
    {
      k: 'PKG',
      at: 2.22,
      v: () => (data.wg.done ? (data.wg.ok ? `WINGET ENGINE · ONLINE V${data.wg.version}` : 'WINGET ENGINE · OFFLINE') : `WINGET · ${up(data.wg.message)}`),
      tone: () => (data.wg.done ? (data.wg.ok ? 'acc' : 'warn') : 'pending'),
    },
    {
      k: '',
      at: 2.5,
      v: () => (data.wg.done && !data.wg.ok ? '→ NEUER VERSUCH VOR DER 1. WIEDERHERSTELLUNG' : null),
      tone: () => 'warn',
      optional: true,
    },
  ].map((L, i) => {
    const k = h('span.bh__k');
    const v = h('span.bh__v');
    const ok = h('span.bh__ok');
    const row = h('div.bh__ln', k, v, ok);
    linesEl.append(row);
    return { ...L, i, row, kEl: k, vEl: v, okEl: ok, text: undefined, t0: 0 };
  });

  // write-through caches: the HUD updates every frame, the DOM only when something changed
  const texts = new WeakMap();
  const styles = new WeakMap();
  const setText = (node, s) => {
    if (texts.get(node) !== s) {
      texts.set(node, s);
      node.textContent = s;
    }
  };
  const setStyle = (node, prop, value) => {
    let map = styles.get(node);
    if (!map) styles.set(node, (map = {}));
    if (map[prop] !== value) {
      map[prop] = value;
      node.style.setProperty(prop, value);
    }
  };

  // keep the readout left of the emblem ring and the tagline under the wordmark
  let layoutAt = -1;
  const layout = () => {
    const L = fx.bootLayout();
    if (!L) return;
    const box = host.getBoundingClientRect();
    // the wing tips break out of the ring by ~16 % of its diameter
    el.style.setProperty('--bh-tl-max', `${Math.max(240, Math.round(L.emb.left - L.emb.width * 0.16 - box.left - 38 - 16))}px`);
    el.style.setProperty('--bh-tag-y', `${Math.round(L.word.top + L.word.height - box.top + 26)}px`);
  };
  const clock = () => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} · ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };

  return {
    update(tau, c) {
      const M = c ? c.marks : { asm0: 1, clx: 3.56, burn: 5, glide: 5, done: 6.35, idle: 7 };
      const k = M.clx / 3.56; // slot scale (1 for the full intro)
      const now = performance.now();
      if (now - layoutAt > 500) {
        layoutAt = now;
        layout();
      }
      // corners draw in, then stay as a faint frame
      const cIn = sstep(0.25 * k, 0.9 * k, tau);
      const cA = 0.9 - 0.6 * sstep(M.burn + 0.8, M.idle + 0.2, tau);
      for (const cEl of corners) {
        setStyle(cEl, '--len', `${(cIn * 46).toFixed(1)}px`);
        setStyle(cEl, 'opacity', (cIn * cA).toFixed(3));
      }
      // blocks: fade in, glitch at the climax, fade out while the logo glides away
      const fade = (1 - sstep(M.burn + 0.7, M.idle, tau)) * sstep(0.3 * k, 0.5 * k, tau);
      const climax = tau < M.clx - 0.06 ? 0 : Math.exp(-(tau - M.clx) * 3.2);
      const f60 = Math.floor(tau * 60);
      const gx = (hash(7, f60) - 0.5) * 14 * climax;
      const gy = (hash(9, f60) - 0.5) * 4 * climax;
      // the logo glides into the titlebar across the top-left corner: that block leaves first
      const tlFade = fade * (1 - sstep(M.glide - 0.1, M.glide + 0.45, tau));
      for (const b of blocks) {
        setStyle(b, 'opacity', (b === tl ? tlFade : fade).toFixed(3));
        setStyle(b, 'transform', climax > 0.01 ? `translate(${gx.toFixed(1)}px, ${gy.toFixed(1)}px)` : '');
        // colour split at the climax ('' = back to the CSS dark halo)
        setStyle(
          b,
          'text-shadow',
          climax > 0.01
            ? `${(3 * climax).toFixed(1)}px 0 rgba(217,70,239,${(0.7 * climax).toFixed(2)}), ${(-3 * climax).toFixed(1)}px 0 rgba(103,232,249,${(0.6 * climax).toFixed(2)}), 0 1px 3px rgba(5,6,10,0.8)`
            : '',
        );
      }
      el.classList.toggle('is-gone', fade <= 0.001 && tau > M.done);

      setText(title, decode('PHOENIX // SETUP CORE', tau, 0.32 * k, 70, 6, 1).s);

      // data lines: a line starts decoding at its slot, or when its (real) value arrives / changes
      for (const L of LINES) {
        const at = L.at * k;
        const val = L.v();
        if (val !== L.text) {
          L.text = val;
          // frozen test frames (fx test hooks) show the data as if it had arrived on time
          L.t0 = c && c.frozen ? at + 0.05 * k : Math.max(at + 0.05 * k, tau);
        }
        const show = tau >= at && !(L.optional && val == null);
        L.row.hidden = !show;
        if (!show) continue;
        setText(L.kEl, decode(L.k, tau, at, 70, 3, 10 + L.i).s);
        const tone = val == null ? 'pending' : L.tone();
        L.row.dataset.tone = tone;
        if (val == null) {
          setText(L.vEl, '');
          L.row.classList.add('is-typing');
          setText(L.okEl, '');
          continue;
        }
        const d = decode(val, tau, L.t0, 64, 7, 30 + L.i);
        setText(L.vEl, d.s);
        L.row.classList.toggle('is-typing', d.typing || tone === 'pending');
        setText(L.okEl, d.done ? (tone === 'warn' ? '!!' : tone === 'pending' ? '..' : 'OK') : '');
      }

      // top right: real version + local clock + signal
      setText(tr1, decode(`PHOENIX${version ? ` V${version}` : ''} · ERSTSTART`, tau, 0.6 * k, 80, 5, 3).s);
      setText(tr2, decode(clock(), tau, 0.9 * k, 80, 5, 4).s);
      bars.forEach((b, i) => {
        const lvl = clamp01((tau - 0.8 * k - i * 0.12 * k) * 3) * (0.35 + 0.65 * Math.abs(Math.sin(tau * 2.3 + i * 1.7)) * (1 - 0.6 * sstep(M.burn - 0.5, M.burn + 1, tau)));
        setStyle(b, 'height', `${(2 + lvl * 14).toFixed(1)}px`);
        setStyle(b, 'opacity', (0.25 + 0.75 * lvl).toFixed(2));
      });

      // bottom left: phase + progress – the timeline drives it, the real setup steps cap it
      const wgDone = data.wg.done;
      const cap = 0.22 + (data.sysDone ? 0.38 : 0) + (wgDone ? 0.4 : 0);
      const tlp = clamp01((tau - 0.3 * k) / (M.burn - 0.7 * k - 0.3 * k));
      const p = Math.min(1 - Math.pow(1 - tlp, 2.2), cap);
      const ph = tau < M.asm0 ? ['ZÜNDUNG', 0.35 * k] : tau < M.clx - 0.06 ? ['REKONSTRUKTION', M.asm0] : tau < M.burn - 0.4 ? ['WIEDERGEBURT', M.clx - 0.06] : wgDone ? ['BEREIT', M.burn - 0.4] : ['WINGET-SETUP', M.burn - 0.4];
      setText(phase, decode(ph[0], tau, ph[1], 40, 5, 5).s);
      setText(pct, `${String(Math.floor(p * 100)).padStart(3, '0')}%`);
      setStyle(barFill, 'width', `${(p * 100).toFixed(2)}%`);
      setText(sub, up(wgDone ? (data.wg.ok ? `winget ${data.wg.version} · bereit` : 'winget · wird später repariert') : data.wg.message));

      // bottom right: intro timecode + the real FX tier
      const mm = String(Math.floor(Math.max(0, tau) / 60)).padStart(2, '0');
      const ss = (Math.max(0, tau) % 60).toFixed(3).padStart(6, '0');
      setText(tc, `T+${mm}:${ss}`);
      const info = fx.info;
      setText(q, `FX ${up(fx.tier || '—')}${info && info.fpsCap ? ` · ${info.fpsCap} FPS` : ''} · F ${String(Math.floor(tau * 60)).padStart(4, '0')}`);
      setStyle(skipHint, 'opacity', c && !c.skipped && tau < M.burn ? '1' : '0');

      // tagline under the wordmark at the climax
      const tg = decode(TAGLINE, tau, M.clx + 0.3, 34, 6, 77);
      setText(tag, tg.s);
      setStyle(tag, 'opacity', (1 - sstep(M.burn + 0.55, M.done, tau)).toFixed(3));
      setStyle(tag, 'letter-spacing', `${(0.62 + 0.25 * Math.exp(-Math.max(0, tau - M.clx - 0.34) * 2.0)).toFixed(3)}em`);
    },
  };
}
