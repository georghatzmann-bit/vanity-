// Dev page for brand/intro.js. Not shipped.
//   preview.html                      interactive
//   preview.html?capture=1&variant=full&place=hero   manual clock for frame/WAV capture (window.__vx)
import { VeloxIntro } from './intro.js';
import { VeloxTicks } from './ticks.js';
import * as Sound from './sound.js';

const qs = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const log = document.getElementById('pv-log');
const state = { variant: qs.get('variant') || 'long', size: qs.get('size') || '880x560', place: qs.get('place') || 'hero' };
let intro = null;

function say(s) { if (log) log.textContent = s; }

// installer mock: the welcome (kit readouts, one orange button) and, after "Installieren",
// the tick-row progress from ticks.js in the same slot - the word above never moves
function welcome(slot) {
  const w = document.createElement('div'); w.className = 'pv-welcome';
  const h = document.createElement('h1'); h.textContent = 'Schneller. Leiser. Privater.';
  const p = document.createElement('p'); p.textContent = 'VELOX stellt Windows für Spiele ein. Jede Änderung wird vorher gesichert und lässt sich mit einem Klick zurücknehmen.';
  const r = document.createElement('dl'); r.className = 'vx-readout pv-read';
  for (const [k, v] of [['Ziel', 'C:\\Program Files\\VELOX'], ['Größe', '14 MB'], ['Version', '1.1.0']]) {
    const a = document.createElement('dt'); a.textContent = k; const b = document.createElement('dd'); b.textContent = v; r.append(a, b);
  }
  const act = document.createElement('div'); act.className = 'pv-act';
  const i = document.createElement('button'); i.type = 'button'; i.className = 'pv-primary'; i.textContent = 'Installieren';
  const o = document.createElement('button'); o.type = 'button'; o.className = 'pv-ghost'; o.textContent = 'Optionen';
  act.append(i, o);
  w.append(h, p, r, act);
  slot.appendChild(w);
  i.addEventListener('click', () => installing(slot, false));
  return w;
}
const STEPS = ['Dateien werden kopiert', 'Dienst wird eingerichtet', 'Sicherung wird angelegt', 'Verknüpfungen werden angelegt', 'Aufräumen'];
function installing(slot, capture) {
  slot.replaceChildren();
  const w = document.createElement('div'); w.className = 'pv-welcome pv-install';
  const h = document.createElement('h1'); h.textContent = 'VELOX wird installiert';
  const r = document.createElement('dl'); r.className = 'vx-readout pv-read';
  for (const [k, v] of [['Ziel', 'C:\\Program Files\\VELOX'], ['Version', '1.1.0']]) {
    const a = document.createElement('dt'); a.textContent = k; const b = document.createElement('dd'); b.textContent = v; r.append(a, b);
  }
  w.append(h, r); slot.appendChild(w);
  const bar = VeloxTicks.mount(w, { status: STEPS[0], step: '1 / ' + STEPS.length });
  window.__ticks = bar;
  if (capture) return bar;
  let p = 0;
  const tick = () => {
    p = Math.min(1, p + 0.06 + Math.random() * 0.05);
    const i = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
    bar.set(p); bar.status(STEPS[i]); bar.step((i + 1) + ' / ' + STEPS.length);
    if (p < 1) setTimeout(tick, 380); else setTimeout(() => { bar.done('Fertig. VELOX ist installiert.'); intro.celebrate(); }, 400);
  };
  setTimeout(tick, 300);
  return bar;
}

function start(extra = {}) {
  if (intro) intro.destroy();
  const capture = qs.get('capture') === '1';
  stage.classList.toggle('pv-fill', state.size === 'fill' || capture);
  if (!capture && state.size !== 'fill') {
    const [w, h] = state.size.split('x').map(Number);
    stage.style.width = w + 'px'; stage.style.height = h + 'px';
  } else { stage.style.width = ''; stage.style.height = ''; }
  const installer = state.place === 'header';
  intro = VeloxIntro.mount(stage, {
    variant: state.variant,
    reducedMotion: state.variant === 'reduced' ? true : 'auto',
    place: state.place,
    loader: !installer,
    labels: installer ? null : 'Version 1.1.0',
    clock: capture ? 'manual' : 'auto',
    onMuteChange: (m) => { say(m ? 'Ton aus' : 'Ton an'); const b = document.getElementById('pv-mute'); if (b) { b.setAttribute('aria-pressed', String(m)); } },
    ...extra,
  });
  if (installer) {                      // intro.css brings it in when the intro settles
    if (qs.get('install') !== null) {
      const bar = installing(intro.slot, true), p = +qs.get('install'), i = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
      bar.seek(p); bar.status(STEPS[i]); bar.step((i + 1) + ' / ' + STEPS.length);
    }
    else welcome(intro.slot);
  }
  intro.settled.then(() => say('settled ' + intro.variant));
  window.__intro = intro;
  return intro;
}

function press(group, attr, val) {
  document.querySelectorAll(`[data-group="${group}"] button`).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === val)));
}

if (qs.get('capture') === '1') {
  document.body.classList.add('pv-capture');
  const it = start();
  const b64 = (ab) => { const u = new Uint8Array(ab); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  window.__vx = {
    ready: it.ready,
    seek: (ms, live) => {
      it.seek(ms, live);
      // capture runs without CSS transitions: draw the slot's arrival from t instead
      const T = it.timeline(), k = Math.min(1, Math.max(0, (ms - T.settled - 40) / 420)), e = 1 - Math.pow(1 - k, 4);
      it.slot.style.opacity = String(Math.min(1, k * 1.4)); it.slot.style.transform = `translateY(${((1 - e) * 8).toFixed(2)}px)`;
      return true;
    },
    timeline: () => it.timeline(),
    // installer capture: replace the welcome with the install screen at progress p (0..1),
    // finish it (done + celebrate at ms), as setup.js does
    install(p) {
      if (!window.__ticks) installing(it.slot, true);
      const b = window.__ticks, i = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length));
      b.seek(p); b.status(STEPS[i]); b.step((i + 1) + ' / ' + STEPS.length);
    },
    finish() { window.__ticks.done('Fertig. VELOX ist installiert.'); },
    celebratePlan: () => it.celebratePlan(),
    layout: () => it.layout(),
    plan: () => it.plan(),
    async wav(secs = 2, which = 'cue') {
      const plan = which === 'handover' ? VeloxIntro.handoverPlan(0) : it.plan();
      const buf = await Sound.renderOffline(plan, secs);
      return b64(Sound.toWav(buf));
    },
    async wavPlan(plan, secs = 2) { return b64(Sound.toWav(await Sound.renderOffline(plan, secs))); },
    setLevel: (x) => Sound.setMasterLevel(x),
  };
} else {
  press('variant', 'data-variant', state.variant);
  start();
  document.querySelectorAll('[data-variant]').forEach((b) => b.addEventListener('click', () => { state.variant = b.dataset.variant; press('variant', 'data-variant', state.variant); start(); }));
  document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => { state.size = b.dataset.size; press('size', 'data-size', state.size); start(); }));
  document.querySelectorAll('[data-place]').forEach((b) => b.addEventListener('click', () => { state.place = b.dataset.place; press('place', 'data-place', state.place); start(); }));
  document.getElementById('pv-replay').addEventListener('click', () => start());
  document.getElementById('pv-skip').addEventListener('click', () => intro.skip());
  document.getElementById('pv-mute').addEventListener('click', () => intro.setMuted(!intro.muted));
  document.getElementById('pv-celebrate').addEventListener('click', () => { say('celebrate() …'); intro.celebrate().then(() => say('celebrate() fertig')); });
  document.getElementById('pv-done').addEventListener('click', () => { say('done() …'); intro.done().then(() => say('done() erfüllt – Übergabe')); });
  document.getElementById('pv-status-set').addEventListener('click', () => intro.status(document.getElementById('pv-status').value));
  document.querySelectorAll('[data-progress]').forEach((b) => b.addEventListener('click', () => intro.progress(b.dataset.progress === 'null' ? null : Number(b.dataset.progress))));
}
