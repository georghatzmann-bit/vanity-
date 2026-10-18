// Hardware-Überblick: Temperaturen, Auslastung und Arbeitsspeicher live – nur lesend, kein Overlay.

import { buildTiles, sessionRow, sourceText, HISTORY_SECONDS } from '../lib/hardware-status.mjs';

const HISTORY_MAX = 60; // 2 Minuten bei einer Messung alle 2 Sekunden
let cleanup = [];

function accentColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v || '#4fd8ff';
}

/** Kleiner Verlauf (letzte 2 Minuten) als Linie mit Fläche darunter. */
function drawSpark(canvas, spark) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(40, canvas.clientWidth || 200);
  const ht = Math.max(20, canvas.clientHeight || 40);
  const W = Math.round(w * dpr);
  const H = Math.round(ht * dpr);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, ht);
  // Grundlinie
  c.strokeStyle = 'rgba(255,255,255,0.08)';
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(0, ht - 0.5);
  c.lineTo(w, ht - 0.5);
  c.stroke();
  if (!spark || !spark.values) return;
  const vals = spark.values.slice(-HISTORY_MAX);
  const lo = spark.min ?? 0;
  const hi = spark.max > lo ? spark.max : lo + 1;
  const step = w / (HISTORY_MAX - 1);
  const off = HISTORY_MAX - vals.length;
  const pts = vals.map((v, i) => (typeof v === 'number' && Number.isFinite(v)
    ? [(off + i) * step, ht - 2 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * (ht - 6)]
    : null));
  const color = accentColor();
  // zusammenhängende Stücke zeichnen, Lücken bleiben frei
  const runs = [];
  let cur = [];
  for (const p of pts) {
    if (p) cur.push(p);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  for (const run of runs) {
    if (run.length === 1) {
      c.fillStyle = color;
      c.beginPath();
      c.arc(run[0][0], run[0][1], 1.6, 0, Math.PI * 2);
      c.fill();
      continue;
    }
    const grad = c.createLinearGradient(0, 0, 0, ht);
    grad.addColorStop(0, 'rgba(79,216,255,0.22)');
    grad.addColorStop(1, 'rgba(79,216,255,0)');
    c.beginPath();
    c.moveTo(run[0][0], ht);
    for (const [x, y] of run) c.lineTo(x, y);
    c.lineTo(run[run.length - 1][0], ht);
    c.closePath();
    c.fillStyle = grad;
    c.fill();
    c.beginPath();
    run.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.strokeStyle = color;
    c.lineWidth = 1.6;
    c.lineJoin = 'round';
    c.stroke();
  }
}

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;
    let alive = true;
    let status = null;
    let history = [];
    let last = null;
    let caps = {};
    let tileRefs = new Map();
    let signature = '';
    const timers = [];
    // Sofort eintragen: Wird die Ansicht verlassen, bevor die Messung antwortet, wird sie trotzdem gestoppt.
    cleanup = [() => { alive = false; }, () => { env.call('hardware.stop').catch(() => {}); }];

    const liveLine = h('div.hw-live');
    const toggleSlot = h('div.hw-toggle');
    const callouts = h('div.hw-callouts');
    const grid = h('div.hw-grid', { role: 'list', 'aria-label': 'Messwerte' });
    const sessionsBody = h('div');
    const sessionsTools = h('div.toolbar');

    root.append(
      h('div.hw-top', liveLine, toggleSlot),
      callouts,
      grid,
      ui.section('Aufgezeichnete Runden', 'Pro Fortnite-Runde: Durchschnitt (Ø) und Höchstwert (max). Wird nur gespeichert, wenn „Auch im Hintergrund aufzeichnen“ an ist.', sessionsTools, sessionsBody),
      ui.section('So misst HELIX', 'Alles nur lesend – HELIX ändert nichts an deinem PC oder am Spiel.',
        h('ul.list.compact',
          h('li', icon('info', 16), h('span', 'Prozessor und Grafikkarte: Leistungsdaten von Windows – dieselben wie im Task-Manager.')),
          h('li', icon('info', 16), h('span', 'NVIDIA: Temperatur, Strom und Takt kommen von „nvidia-smi“, einem kleinen Programm des Grafiktreibers.')),
          h('li', icon('info', 16), h('span', 'Mainboard-Sensor: Wärmezonen (ACPI) des Mainboards – oft nicht die echte Prozessor-Temperatur.')),
          h('li', icon('shield', 16), h('span', 'Fortnite: nur Arbeitsspeicher und Prozessor-Anteil, wie im Task-Manager. Kein Overlay, nichts wird aus dem Spiel gelesen oder daran verändert.')))));

    // ---------- Kopfzeile ----------
    function renderLive() {
      const st = { ...(status || {}), stream: last?.stream || status?.stream };
      const ok = st.windows !== false && st.stream === 'ok';
      ui.mount(liveLine,
        ok ? ui.badge('live', 'ok') : st.stream === 'starting' ? ui.badge('startet …', '') : st.windows === false ? ui.badge('Grundwerte', '') : st.stream === 'failed' ? ui.badge('eingeschränkt', 'warn') : ui.badge('live', 'ok'),
        h('span.hint', sourceText(st)),
        h('span.hint', `Verlauf: letzte ${HISTORY_SECONDS / 60} Minuten`));
    }

    function renderToggle() {
      const on = !!status?.settings?.background;
      const disabled = status?.windows === false;
      const t = ui.toggle({
        label: 'Auch im Hintergrund aufzeichnen, solange Fortnite läuft',
        hint: disabled
          ? 'Geht nur unter Windows.'
          : 'HELIX merkt sich pro Runde nur Durchschnitt und Höchstwerte. Kein Overlay, das Spiel wird nicht berührt.',
        checked: on,
        disabled,
        onChange: async (val) => {
          try {
            const r = await env.call('hardware.setBackground', { on: val });
            if (!alive) return;
            status = { ...status, settings: r.settings, recording: r.recording };
            ui.toast(val
              ? 'Aufzeichnung an: Nach jeder Fortnite-Runde steht unten, wie warm und ausgelastet dein PC war.'
              : 'Aufzeichnung aus: HELIX misst nur noch, solange diese Seite offen ist.');
            renderCallouts();
            loadSessions();
          } catch (e) {
            const input = t.querySelector('input');
            if (input) input.checked = !val;
            ui.showError(e, 'Nicht gespeichert');
          }
        },
      });
      ui.mount(toggleSlot, t);
    }

    function renderCallouts() {
      const list = [];
      if (status?.windows === false) {
        list.push(h('div.callout.info', icon('info'), h('div',
          h('strong', 'Hier gibt es nur Grundwerte'),
          h('p.hint', 'Temperaturen, Grafikkarte und Fortnite liest HELIX über Windows. Auf diesem System siehst du nur Prozessor und Arbeitsspeicher.'))));
      } else if ((last?.stream || status?.stream) === 'failed') {
        list.push(h('div.callout.warn', icon('warn'), h('div',
          h('strong', 'Windows liefert gerade keine Messwerte'),
          h('p.hint', 'Zu sehen sind nur Prozessor und Arbeitsspeicher. Öffne die Seite später noch einmal – oder starte den PC neu, falls das so bleibt.'),
          h('div.row', ui.button('Erneut versuchen', { small: true, iconName: 'refresh', onClick: restart })))));
      }
      if (status?.recording) {
        list.push(h('div.callout.ok', icon('clock'), h('div',
          h('strong', 'Aufzeichnung läuft'),
          h('p.hint', 'Fortnite ist offen. HELIX merkt sich Durchschnitt und Höchstwerte dieser Runde.'))));
      }
      ui.mount(callouts, list);
    }

    async function restart() {
      try {
        await env.call('hardware.stop');
        status = await env.call('hardware.start');
        if (!alive) return;
        caps = status.caps || caps;
        ui.toast('Messung wird neu gestartet.', 'info');
        renderAll();
      } catch (e) { ui.showError(e); }
    }

    // ---------- Kacheln ----------
    function makeTile(t) {
      const value = h('strong.hw-value-num');
      const unit = h('span.hw-unit');
      const badgeSlot = h('span.hw-badge');
      const text = h('p.hint.hw-text');
      const extra = h('p.hint.mono.hw-extra');
      const canvas = h('canvas.hw-spark', { 'aria-hidden': 'true', height: 40 });
      const empty = h('div.hw-spark-empty', { 'aria-hidden': 'true' });
      const label = h('span.hw-label');
      const el = h('article.hw-tile', { role: 'listitem', dataset: { id: t.id } },
        h('div.hw-tile-top', label),
        h('div.hw-value', value, unit, badgeSlot),
        canvas, empty, text, extra);
      const ref = { el, label, value, unit, badgeSlot, text, extra, canvas, empty, spark: null };
      tileRefs.set(t.id, ref);
      return el;
    }

    function updateTile(t) {
      const r = tileRefs.get(t.id);
      if (!r) return;
      r.label.textContent = t.label;
      r.value.textContent = t.value;
      r.unit.textContent = t.unit || '';
      ui.mount(r.badgeSlot, t.badge ? ui.badge(t.badge.text, t.badge.type) : null);
      r.text.textContent = t.text || '';
      r.extra.textContent = t.extra || '';
      r.extra.hidden = !t.extra;
      r.el.classList.toggle('off', !t.available);
      r.el.setAttribute('aria-label', `${t.label}: ${t.value} ${t.unit || ''}${t.badge ? ` – ${t.badge.text}` : ''}`);
      r.spark = t.spark;
      r.canvas.hidden = !t.spark;
      r.empty.hidden = !!t.spark;
      if (t.spark) drawSpark(r.canvas, t.spark);
    }

    function renderTiles() {
      const tiles = buildTiles(last, history, { ...(status || {}), caps });
      const sig = tiles.map((t) => `${t.id}:${t.available ? 1 : 0}`).join('|');
      if (sig !== signature) {
        signature = sig;
        tileRefs = new Map();
        ui.mount(grid, tiles.map(makeTile));
      }
      for (const t of tiles) updateTile(t);
    }

    function redrawAll() {
      for (const r of tileRefs.values()) if (r.spark) drawSpark(r.canvas, r.spark);
    }

    function renderAll() {
      renderLive();
      renderToggle();
      renderCallouts();
      renderTiles();
    }

    // ---------- Aufgezeichnete Runden ----------
    async function loadSessions() {
      let r;
      try { r = await env.call('hardware.sessions'); } catch (e) {
        if (alive) ui.mount(sessionsBody, ui.emptyState({ title: 'Runden konnten nicht geladen werden', text: e.message }));
        return;
      }
      if (!alive) return;
      const list = r.sessions || [];
      ui.mount(sessionsTools,
        h('span.hint.grow', list.length ? `${list.length} ${list.length === 1 ? 'Runde' : 'Runden'} gespeichert (höchstens 100).` : ''),
        list.length ? ui.button('Liste leeren', {
          small: true, variant: 'ghost', iconName: 'trash',
          onClick: async () => {
            const ok = await ui.confirmDialog({ title: 'Alle Runden löschen?', text: 'Die gespeicherten Durchschnitts- und Höchstwerte werden gelöscht. Die Live-Anzeige bleibt.', confirmLabel: 'Löschen', danger: true });
            if (!ok) return;
            try {
              const c = await env.call('hardware.clearSessions');
              ui.toast(`${c.cleared} ${c.cleared === 1 ? 'Runde' : 'Runden'} gelöscht.`);
              loadSessions();
            } catch (e) { ui.showError(e); }
          },
        }) : null);
      if (!list.length) {
        ui.mount(sessionsBody, ui.emptyState({
          title: 'Noch keine Runde aufgezeichnet',
          text: r.settings?.background
            ? 'Die Aufzeichnung ist an. Nach deiner nächsten Fortnite-Runde (ab 1 Minute) steht hier, wie warm und ausgelastet dein PC war.'
            : 'Schalte oben „Auch im Hintergrund aufzeichnen“ ein. Nach deiner nächsten Fortnite-Runde steht hier, wie warm und ausgelastet dein PC war.',
        }));
        return;
      }
      const rows = list.map((s) => {
        const row = sessionRow(s);
        return h('tr',
          h('td', ui.fmtDate(s.startedAt), s.recovered ? h('span.hint', ' (unvollständig)') : null),
          h('td.num', ui.fmtDuration(s.durationSec)),
          h('td.num', row.cpu),
          h('td.num', row.gpu),
          h('td.num', row.gpuTemp),
          h('td.num', row.boardTemp),
          h('td.num', row.fnRam),
          h('td', row.hot ? ui.badge('sehr heiß', 'err') : ui.badge('in Ordnung', 'ok')));
      });
      ui.mount(sessionsBody, h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Start'), h('th', 'Dauer'), h('th', 'Prozessor'), h('th', 'Grafikkarte'), h('th', 'GPU-Temperatur'), h('th', 'Mainboard-Sensor'), h('th', 'Fortnite-RAM'), h('th', 'Bewertung'))),
        h('tbody', rows))));
    }

    // ---------- Start ----------
    ui.mount(grid, h('div.loading', ui.spinner()));
    try {
      status = await env.call('hardware.start');
    } catch (e) {
      ui.mount(grid, ui.emptyState({ title: 'Die Messung konnte nicht starten', text: e.message || String(e) }));
      ui.showError(e, 'Hardware-Überblick');
      loadSessions();
      return;
    }
    if (!alive) return;
    history = (status.history || []).slice(-HISTORY_MAX);
    last = history[history.length - 1] || null;
    caps = status.caps || {};

    const offSample = env.on('hardware.sample', (s) => {
      if (!alive || !s) return;
      if (s.caps) caps = s.caps;
      const { caps: _c, ...plain } = s;
      history.push(plain);
      while (history.length > HISTORY_MAX) history.shift();
      const streamChanged = (last?.stream) !== plain.stream;
      last = plain;
      if (streamChanged) { renderLive(); renderCallouts(); }
      renderTiles();
    });
    const offFn = env.on('fortnite.state', () => {
      timers.push(setTimeout(async () => {
        if (!alive) return;
        try {
          const st = await env.call('hardware.status');
          if (!alive) return;
          status = { ...status, recording: st.recording, settings: st.settings };
          renderCallouts();
        } catch { /* egal */ }
        loadSessions();
      }, 2500));
    });
    let ping = null;
    const startPing = () => { if (!ping) ping = setInterval(() => { env.call('hardware.ping').catch(() => {}); }, 30000); };
    const stopPing = () => { if (ping) clearInterval(ping); ping = null; };
    startPing();

    // Fenster im Infobereich oder minimiert: Messung anhalten, sonst läuft sie beim Spielen stundenlang mit.
    // Die Hintergrund-Aufzeichnung (falls eingeschaltet) läuft im Hauptprozess davon unabhängig weiter.
    let paused = false;
    async function onVisibility() {
      if (!alive) return;
      if (document.hidden) {
        if (paused) return;
        paused = true;
        stopPing();
        env.call('hardware.stop').catch(() => {});
        return;
      }
      if (!paused) return;
      paused = false;
      try {
        const st = await env.call('hardware.start');
        if (!alive || paused) return;
        status = st;
        history = (st.history || []).slice(-HISTORY_MAX);
        last = history[history.length - 1] || null;
        caps = st.caps || caps;
        startPing();
        renderAll();
      } catch (e) { if (alive) ui.showError(e, 'Hardware-Überblick'); }
    }
    document.addEventListener('visibilitychange', onVisibility);
    let ro = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => redrawAll());
      ro.observe(grid);
    }

    cleanup.push(
      offSample,
      offFn,
      () => clearInterval(ping),
      () => { for (const t of timers) clearTimeout(t); },
      () => ro && ro.disconnect(),
    );

    renderAll();
    loadSessions();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
