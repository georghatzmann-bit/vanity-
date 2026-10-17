// Radar visual for the restore search: rotating sweep, sonar waves, one orbiting node per search
// place (USB-Sticks, Laufwerke, …) and the PHOENIX mark in the core. Styles live in restore.css.
import { h, svg, nextId } from '../core/dom.js';
import { logoMark } from './icons.js';
import { xicon } from './selectIcons.js';
import { gsap, motionOK, richMotion } from '../core/motion.js';

const DISC = (id) => `<svg class="rr__svg" viewBox="0 0 200 200" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="${id}" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="rgba(139,92,246,0.20)"/>
      <stop offset=".55" stop-color="rgba(76,40,160,0.08)"/>
      <stop offset="1" stop-color="rgba(10,8,24,0)"/>
    </radialGradient>
  </defs>
  <circle cx="100" cy="100" r="99" fill="url(#${id})"/>
  <circle class="rr__line rr__line--outer" cx="100" cy="100" r="98.5"/>
  <circle class="rr__ticks" cx="100" cy="100" r="94"/>
  <circle class="rr__line" cx="100" cy="100" r="70"/>
  <circle class="rr__line rr__line--dash" cx="100" cy="100" r="45"/>
  <circle class="rr__line" cx="100" cy="100" r="22"/>
  <path class="rr__line rr__line--cross" d="M100 8V192M8 100H192"/>
</svg>`;

/**
 * RestoreRadar({ places: [{ id, label, icon }] })
 * Returns the element with:
 *   setNode(i, 'idle'|'active'|'done'|'found'), ping(i), startSweep(periodSec), stopSweep(),
 *   setMode('search'|'idle'|'found'|'error'), destroy()
 */
export function RestoreRadar({ places = [] } = {}) {
  const sweep = h('span.rr__sweep');
  const waves = h('span.rr__waves.deco', h('span.rr__wave'), h('span.rr__wave'), h('span.rr__wave'));
  const core = h('span.rr__core', logoMark({ size: 30 }));
  const disc = h('div.rr__disc', svg(DISC(nextId('rr'))), waves, sweep, core);
  const step = 360 / Math.max(1, places.length);
  const nodes = places.map((p, i) => {
    // Positioned with left/top (not transforms) so GSAP can scale nodes freely.
    const rad = ((-90 + i * step) * Math.PI) / 180;
    return h(
      'span.rr__node',
      { style: { left: `${(50 + 50 * Math.cos(rad)).toFixed(3)}%`, top: `${(50 + 50 * Math.sin(rad)).toFixed(3)}%` }, dataset: { state: 'idle' }, title: p.label },
      h('span.rr__node-ping'),
      h('span.rr__node-icon', xicon(p.icon, { size: 18, strokeWidth: 2 })),
      h('span.rr__node-check', xicon('check', { size: 11, strokeWidth: 3 })),
    );
  });
  const el = h('div.rr', { attrs: { role: 'img', 'aria-label': 'Radar: Phoenix durchsucht deine Laufwerke und Ordner' } }, disc, ...nodes);
  let sweepTween = null;

  const api = {
    setNode(i, state) {
      const n = nodes[i];
      if (!n || n.dataset.state === state) return el;
      n.dataset.state = state;
      if (state === 'found' && richMotion()) {
        gsap.fromTo(n, { scale: 1.45 }, { scale: 1, duration: 0.9, ease: 'elastic.out(1.1, 0.4)', clearProps: 'scale' });
      }
      return el;
    },
    ping(i) {
      const n = nodes[i];
      if (!n || !motionOK()) return el;
      const ring = n.querySelector('.rr__node-ping');
      gsap.fromTo(ring, { scale: 0.6, opacity: 0.9 }, { scale: 2.4, opacity: 0, duration: 0.9, ease: 'power2.out', overwrite: true });
      return el;
    },
    startSweep(period = 1.8) {
      sweepTween?.kill();
      el.classList.add('is-sweeping');
      if (!motionOK()) return el;
      gsap.set(sweep, { rotation: 0 });
      sweepTween = gsap.to(sweep, { rotation: 360, duration: period, ease: 'none', repeat: -1 });
      return el;
    },
    stopSweep() {
      el.classList.remove('is-sweeping');
      if (sweepTween) {
        const t = sweepTween;
        sweepTween = null;
        t.kill();
        if (motionOK()) gsap.to(sweep, { opacity: 0, duration: 0.5, ease: 'power2.out' });
        else gsap.set(sweep, { opacity: 0 });
      }
      return el;
    },
    setMode(mode) {
      el.dataset.mode = mode;
      if (mode === 'search') gsap.set(sweep, { opacity: 1 });
      return el;
    },
    destroy() {
      sweepTween?.kill();
      gsap.killTweensOf([sweep, ...nodes, ...el.querySelectorAll('.rr__node-ping')]);
    },
  };
  api.setMode('idle');
  return Object.assign(el, api);
}

/**
 * Place list next to the radar: icon, label, grey hint, live status (text + icon, never color only).
 * PlaceList({ places: [{ label, icon, hint }] }) -> el with setState(i, 'wait'|'run'|'done'|'found', text?)
 */
export function PlaceList({ places = [] } = {}) {
  const rows = places.map((p) => {
    const status = h('span.rr-list__status', h('span.rr-list__status-icon'), h('span.rr-list__status-text', 'Wartet'));
    const row = h(
      'li.rr-list__row',
      { dataset: { state: 'wait' } },
      h('span.rr-list__icon', xicon(p.icon, { size: 18, strokeWidth: 2 })),
      h('span.rr-list__text', h('span.rr-list__label', p.label), h('span.rr-list__hint', p.hint)),
      status,
    );
    row._status = status;
    return row;
  });
  const el = h('ul.rr-list', { attrs: { 'aria-label': 'Durchsuchte Orte' } }, rows);
  const ICONS = { run: null, done: 'check', found: 'check-circle' };
  const TEXT = { wait: 'Wartet', run: 'Sucht …', done: 'Nichts', found: 'Gefunden' };

  return Object.assign(el, {
    setState(i, state, text) {
      const row = rows[i];
      if (!row) return el;
      const changed = row.dataset.state !== state;
      row.dataset.state = state;
      const iconSlot = row._status.firstChild;
      iconSlot.textContent = '';
      if (state === 'run') iconSlot.append(h('span.rr-list__spin'));
      else if (ICONS[state]) iconSlot.append(xicon(ICONS[state], { size: 14, strokeWidth: 2.4 }));
      row._status.lastChild.textContent = text || TEXT[state];
      if (changed && state !== 'wait' && motionOK()) {
        gsap.fromTo(row._status, { opacity: 0, x: 6 }, { opacity: 1, x: 0, duration: 0.3, ease: 'power2.out', clearProps: 'transform,opacity' });
      }
      return el;
    },
  });
}
