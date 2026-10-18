// Das Cockpit: runder Kern in der Mitte, die Tools kreisen als Planeten auf zwei Umlaufbahnen.
// Die Planeten und der Kern sind gerenderte Higgsfield-Bilder/-Clips; hier werden sie nur angeordnet.

import { CORE, TOOLS } from './tools.js';
import { sfx } from './sound.js';
import { applyFlow } from './views/apply-flow.js';

export function renderCockpit(stage, env) {
  const { h, icon } = env.ui;
  const inner = TOOLS.filter((t) => t.ring === 1);
  const outer = TOOLS.filter((t) => t.ring === 2);

  const svgNs = 'http://www.w3.org/2000/svg';
  const orbits = document.createElementNS(svgNs, 'svg');
  orbits.classList.add('orbits');
  orbits.setAttribute('aria-hidden', 'true');
  const ellipses = [0, 1].map(() => {
    const e = document.createElementNS(svgNs, 'ellipse');
    orbits.appendChild(e);
    return e;
  });

  const hud = h('div.hud', h('div.hud-title'), h('div.hud-desc.hint'), h('div.hud-extra'));
  const summaries = {};

  function setHud(t) {
    hud.querySelector('.hud-title').textContent = t ? t.title : 'Wähle ein Ziel';
    hud.querySelector('.hud-desc').textContent = t ? t.desc : 'Klicke auf einen Planeten, um ein Tool zu öffnen – oder auf den Kern für deine Settings-Profile.';
    hud.querySelector('.hud-extra').textContent = t && summaries[t.id] ? summaries[t.id] : '';
    hud.classList.toggle('active', !!t);
  }

  const planets = [...inner, ...outer].map((t) => {
    const img = h('img', { src: `assets/img/planet-${t.id}.png`, alt: '', draggable: 'false', onerror: (e) => e.target.classList.add('missing') });
    const btn = h('button.planet', {
      type: 'button',
      dataset: { id: t.id, ring: t.ring },
      style: { '--hue': t.hue },
      'aria-label': `${t.title}: ${t.desc}`,
      onmouseenter: () => { sfx('hover'); setHud(t); },
      onfocus: () => setHud(t),
      onmouseleave: () => setHud(null),
      onblur: () => setHud(null),
      onclick: () => env.nav.go(t.id),
    }, h('span.planet-glow'), img, h('span.planet-label', t.short));
    return { t, btn };
  });

  const coreVideo = h('video.core-video.loop-media', { src: 'assets/video/core-loop.mp4', autoplay: true, muted: true, loop: true, playsinline: true, poster: 'assets/img/core.png' });
  coreVideo.muted = true;
  const coreBtn = h('button.core', {
    type: 'button',
    'aria-label': `${CORE.title}: ${CORE.desc}`,
    onmouseenter: () => { sfx('hover'); setHud(CORE); },
    onmouseleave: () => setHud(null),
    onfocus: () => setHud(CORE),
    onblur: () => setHud(null),
    onclick: () => env.nav.go(CORE.id),
  }, h('span.core-ring'), coreVideo, h('span.core-label', h('strong', 'HELIX'), h('span', 'Settings-Profile')));

  const dockList = h('div.dock-list');
  const dock = h('div.dock.glass',
    h('div.dock-head', h('span.dock-title', 'Profil anwenden'), h('span.hint', 'Erst im Epic Launcher ins richtige Konto einloggen, dann Profil wählen.')),
    dockList);

  const field = h('div.orbit-field', orbits, coreBtn, planets.map((p) => p.btn));
  const root = h('div.cockpit', field, hud, dock);
  stage.appendChild(root);
  setHud(null);

  function layout() {
    const w = field.clientWidth;
    const hgt = field.clientHeight;
    if (!w || !hgt) return;
    const cx = w / 2;
    const cy = hgt * 0.5;
    const outerRx = Math.min(w * 0.44, 640);
    const outerRy = Math.min(hgt * 0.4, outerRx * 0.52);
    const innerRx = outerRx * 0.6;
    const innerRy = outerRy * 0.6;
    const coreSize = Math.max(170, Math.min(innerRy * 1.25, 280));
    field.style.setProperty('--core', `${coreSize}px`);
    const rings = [[innerRx, innerRy], [outerRx, outerRy]];
    rings.forEach(([rx, ry], i) => {
      const e = ellipses[i];
      e.setAttribute('cx', cx);
      e.setAttribute('cy', cy);
      e.setAttribute('rx', rx);
      e.setAttribute('ry', ry);
    });
    orbits.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    const place = (list, [rx, ry], offset, size) => {
      list.forEach((t, i) => {
        const p = planets.find((x) => x.t.id === t.id);
        const ang = (offset + (i * 360) / list.length) * (Math.PI / 180);
        const x = cx + rx * Math.cos(ang);
        const y = cy + ry * Math.sin(ang);
        const depth = (Math.sin(ang) + 1) / 2; // 0 = hinten (oben), 1 = vorne (unten)
        const s = size * (0.86 + depth * 0.2);
        Object.assign(p.btn.style, {
          left: `${x}px`,
          top: `${y}px`,
          width: `${s}px`,
          height: `${s}px`,
          zIndex: String(10 + Math.round(depth * 10)),
        });
        p.btn.style.setProperty('--depth', depth.toFixed(2));
      });
    };
    const innerSize = Math.max(64, Math.min(96, w / 15));
    place(inner, rings[0], -60, innerSize);
    place(outer, rings[1], 90 + 360 / (outer.length * 2), innerSize * 0.82);
  }

  const ro = new ResizeObserver(layout);
  ro.observe(field);
  layout();

  async function loadDock() {
    let profiles = [];
    try { profiles = await env.call('profiles.list'); } catch { /* ohne Ordner */ }
    env.ui.clear(dockList);
    if (!profiles.length) {
      dockList.appendChild(h('button.dock-empty', { type: 'button', onclick: () => env.nav.go('profiles') },
        icon('plus', 16), h('span', 'Noch kein Profil – jetzt das erste speichern')));
      return;
    }
    for (const p of profiles) {
      dockList.appendChild(h(`button.profile-chip${p.active ? '.active' : ''}`, {
        type: 'button',
        style: { '--hue': p.color ?? 200 },
        title: p.active ? `${p.name} ist gerade aktiv – erneut anwenden` : `${p.name} anwenden`,
        onmouseenter: () => sfx('hover'),
        onclick: () => applyFlow(env, p.id, { onDone: loadDock }),
      }, h('span.chip-dot'), h('span.chip-name', p.name), p.active ? h('span.chip-state', 'aktiv') : null));
    }
    dockList.appendChild(h('button.profile-chip.ghost', { type: 'button', title: 'Profile verwalten', onclick: () => env.nav.go('profiles') }, icon('settings', 16), h('span.chip-name', 'Verwalten')));
  }
  loadDock();

  // kurze Zusammenfassungen der Tools (z. B. "Bester Server: Europa, 18 ms")
  for (const t of TOOLS) {
    env.call(`${t.id}.summary`).then((s) => { if (s && s.text) summaries[t.id] = s.text; }).catch(() => {});
  }

  return {
    unmount() {
      ro.disconnect();
      coreVideo.pause();
    },
  };
}
