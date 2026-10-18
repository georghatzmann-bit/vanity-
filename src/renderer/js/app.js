// HELIX – Oberfläche: Intro, Cockpit, Navigation mit kurzen Übergängen, Statusleiste.

import { call, on, isMock } from './api.js';
import * as ui from './ui.js';
import { configureSound } from './sound.js';
import { CORE, TOOLS, findTarget } from './tools.js';
import { renderCockpit } from './cockpit.js';
import { playTransition, playIntro } from './fx.js';

const { h, icon } = ui;

const state = {
  current: null,
  view: null,
  status: null,
  settings: null,
  navigating: false,
};

const stage = document.getElementById('stage');
const statusBar = document.getElementById('status');

const MOUNT_WAIT_MS = 450;

const VIEW_LOADERS = {
  profiles: () => import('./views/profiles.js'),
  settings: () => import('./views/settings.js'),
};
for (const t of TOOLS) VIEW_LOADERS[t.id] ||= () => import(`./views/${t.id}.js`);

// ---------- Navigation ----------

const env = {
  call,
  on,
  ui,
  state,
  nav: { go: (id) => go(id), home: () => go('cockpit') },
  refreshStatus: () => refreshStatus(),
};

async function go(id, { instant = false } = {}) {
  // Ziel ist das laufende Navigationsziel, nicht die zuletzt fertige Ansicht – sonst ginge ein Klick
  // auf „Cockpit“ verloren, solange ein Tool noch lädt.
  if (id === (state.navigating ? state.target : state.current)) { state.pending = null; return; }
  if (state.navigating) { state.pending = id; return; } // nach dem laufenden Übergang dorthin
  state.navigating = true;
  state.target = id;
  document.body.classList.add('navigating');
  try {
    const swap = async () => {
      if (state.view?.unmount) { try { state.view.unmount(); } catch { /* weiter */ } }
      state.view = null;
      ui.clear(stage);
      if (id === 'cockpit') {
        stage.className = 'stage cockpit-stage';
        state.view = renderCockpit(stage, env);
        applyLightMode(); // das neue Kern-Video gleich anhalten, wenn „Leichtlauf“ greift
      } else {
        stage.className = 'stage tool-stage';
        await mountTool(id);
      }
      state.current = id;
      document.body.dataset.view = id;
    };
    if (instant || !state.current) {
      await swap();
    } else {
      await playTransition(swap);
    }
  } finally {
    state.navigating = false;
    document.body.classList.remove('navigating');
  }
  if (state.pending) {
    const next = state.pending;
    state.pending = null;
    go(next);
  }
}

async function mountTool(id) {
  const target = findTarget(id);
  const body = h('div.tool-body');
  const header = h('header.tool-head',
    h('button.back', { type: 'button', onclick: () => go('cockpit'), title: 'Zurück zum Cockpit (Esc)' }, icon('back'), h('span', 'Cockpit')),
    h('div.tool-title',
      h('div.tool-planet.glyph', icon(target?.icon || 'sparkle', 20)),
      h('div', h('h1', target?.title || id), h('p.hint', target?.desc || ''))),
    orbitStrip(id));
  // Jedes Tool bekommt seine eigene Farbe (Knöpfe, Reiter, Schalter …)
  const panel = h('div.tool-panel.glass', { dataset: { tool: id }, style: { '--hue': target?.hue ?? 262 } }, header, body);
  stage.appendChild(panel);
  // eigenes Stylesheet des Tools (css/tools/<id>.css), falls vorhanden
  if (TOOLS.some((t) => t.id === id) && !document.querySelector(`link[data-tool-css="${id}"]`)) {
    document.head.appendChild(h('link', { rel: 'stylesheet', href: `css/tools/${id}.css`, dataset: { toolCss: id } }));
  }
  const loader = VIEW_LOADERS[id];
  if (!loader) {
    ui.mount(body, ui.emptyState({ title: 'Noch nicht verfügbar', text: 'Dieses Tool gibt es in dieser Version noch nicht.' }));
    return;
  }
  const failed = (e) => {
    console.error(e);
    if (panel.isConnected) ui.mount(body, ui.emptyState({ title: 'Das Tool konnte nicht geladen werden', text: e.message || String(e) }));
  };
  try {
    const mod = await loader();
    const view = mod.default;
    state.view = view;
    // Lädt ein Tool länger (z. B. Windows-Abfragen), ist der Wechsel trotzdem nach kurzer Zeit fertig:
    // „Cockpit“ und Esc reagieren sofort, das Tool füllt sich im Hintergrund weiter.
    panel.classList.add('loading');
    const mounting = Promise.resolve().then(() => view.mount(body, env))
      .catch(failed)
      .finally(() => panel.classList.remove('loading'));
    await Promise.race([mounting, new Promise((r) => setTimeout(r, MOUNT_WAIT_MS))]);
  } catch (e) {
    failed(e);
  }
}

/** Kleine Planetenreihe oben rechts zum direkten Wechseln (statt einer Seitenleiste). */
function orbitStrip(activeId) {
  const items = [CORE, ...TOOLS];
  return h('nav.orbit-strip', { 'aria-label': 'Tools' }, items.map((t) => h(`button.orbit-dot${t.id === activeId ? '.active' : ''}`, {
    type: 'button',
    title: t.title,
    'aria-label': t.title,
    style: { '--hue': t.hue ?? 262 },
    onclick: () => go(t.id),
  }, icon(t.icon, 14))));
}

// ---------- Statusleiste ----------

function chip(text, type, title, onClick) {
  return h(`button.chip${type ? '.' + type : ''}`, { type: 'button', title, onclick: onClick, disabled: !onClick }, h('span.led'), h('span', text));
}

function renderStatus() {
  const st = state.status;
  ui.clear(statusBar);
  if (!st) return;
  const fn = st.fortnite || {};
  statusBar.appendChild(fn.unsupported
    ? chip('Fortnite-Erkennung nur unter Windows', 'muted', '')
    : fn.running
      ? chip('Fortnite läuft', 'warn', 'Zum Anwenden von Profilen muss Fortnite geschlossen sein', () => go('profiles'))
      : chip('Fortnite geschlossen', 'ok', 'Profile können angewendet werden'));
  statusBar.appendChild(st.location.found
    ? chip(st.active ? `Aktiv: ${st.active.name}` : 'Kein Profil aktiv', st.active ? 'accent' : 'muted', st.location.configDir || '', () => go('profiles'))
    : chip('Fortnite-Ordner nicht gefunden', 'err', 'Klicken, um den Ordner zu wählen', () => go('profiles')));
  if (st.drift?.status === 'drift' && !st.drift.acknowledged) {
    statusBar.appendChild(chip('Einstellungen verändert', 'err', 'Fortnite hat nach dem Anwenden Dateien geändert', () => showDrift(st.drift)));
  }
}

async function refreshStatus() {
  try {
    state.status = await call('core.status');
    renderStatus();
    applyLightMode();
  } catch (e) {
    console.error(e);
  }
  return state.status;
}

function applyLightMode() {
  // Es laufen keine Hintergrund-Videos mehr; die Klasse bleibt als Hinweis für Tools, dass Fortnite läuft.
  document.body.classList.toggle('light-mode', !!state.status?.fortnite?.running);
}

// ---------- Cloud-Warnung ----------

let driftOpen = false;
async function showDrift(d) {
  if (driftOpen || !d || d.status !== 'drift') return;
  driftOpen = true;
  const list = h('ul.list.compact', d.changed.map((c) => h('li', icon(c.missing ? 'x' : 'file', 16),
    h('div.grow', h('span', c.label || c.rel), h('span.hint', ui.displayPath(c.rel)),
      c.missing ? h('span.hint', 'Datei fehlt jetzt') : null,
      (c.settings || []).slice(0, 6).map((x) => h('span.hint.mono', `${x.key}: ${x.from ?? '–'} → ${x.to ?? '–'}`))))));
  const onlyCloud = d.changed.every((c) => c.kind === 'controls');
  const text = onlyCloud
    ? `Fortnite hat Tastenbelegung und Sensi aus der Epic-Cloud deines Kontos geholt und die Kopie von „${d.profileName}“ ersetzt. Das ist normal: Diese Einstellungen gehören zum Konto. Willst du sie ändern, stelle sie einmal im Spiel ein – Fortnite speichert sie dann in der Cloud.`
    : d.likelyCloud
      ? `Fortnite hat kurz nach dem Start Einstellungen von „${d.profileName}“ überschrieben – wahrscheinlich aus der Epic-Cloud zurückgeholt.`
      : `Seit dem Anwenden von „${d.profileName}“ wurden diese Dateien verändert – im Spiel oder durch die Cloud.`;
  const r = await ui.modal({
    title: 'Achtung: Einstellungen wurden verändert',
    subtitle: 'HELIX hat nach dem Anwenden eine Abweichung bemerkt.',
    content: [h('p', text), list, onlyCloud ? null : h('p.hint', 'Tipp: Mit Schreibschutz für die Grafik-Datei kann Fortnite sie nicht mehr überschreiben. Änderungen im Spiel werden dann aber auch nicht gespeichert.')],
    actions: [
      { label: 'Ignorieren', value: 'ack' },
      { label: 'Änderungen ins Profil übernehmen', value: 'adopt' },
      { label: 'Profil erneut anwenden', value: 'reapply', variant: 'primary' },
    ],
  });
  driftOpen = false;
  try {
    if (r === 'ack' || r === null) {
      await call('core.driftAck');
    } else if (r === 'adopt') {
      await call('profiles.update', { id: d.profileId });
      ui.toast(`Profil „${d.profileName}“ wurde mit den aktuellen Einstellungen aktualisiert.`);
    } else if (r === 'reapply') {
      await go('profiles');
      window.dispatchEvent(new CustomEvent('helix:apply', { detail: { id: d.profileId } }));
    }
  } catch (e) {
    ui.showError(e);
  }
  refreshStatus();
}

// ---------- Start ----------

async function boot() {
  document.body.classList.toggle('mock', isMock);
  try {
    state.settings = await call('app.settings');
  } catch { state.settings = { sound: true, volume: 0.4, intro: true }; }
  configureSound({ enabled: state.settings.sound, volume: state.settings.volume });
  document.body.classList.toggle('reduce-motion', !!state.settings.reduceMotion);

  on('fortnite.state', () => refreshStatus());
  on('drift', (d) => { refreshStatus(); showDrift(d); });
  on('profiles.applied', () => refreshStatus());
  on('app.settings', (s) => {
    state.settings = s;
    configureSound({ enabled: s.sound, volume: s.volume });
    document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
    applyLightMode();
  });
  document.addEventListener('visibilitychange', applyLightMode);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.current && state.current !== 'cockpit' && !document.querySelector('.overlay')) go('cockpit');
  });
  document.getElementById('btn-settings').addEventListener('click', () => go('settings'));

  const introWanted = state.settings.intro !== false && !new URLSearchParams(location.search).has('nointro');
  const introPromise = introWanted ? playIntro() : Promise.resolve();
  await refreshStatus();
  await go(new URLSearchParams(location.search).get('view') || 'cockpit', { instant: true });
  await introPromise;
  document.body.classList.add('ready');
  setInterval(refreshStatus, 20000);
  call('app.ready').catch(() => {});
}

boot();
