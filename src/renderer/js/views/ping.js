// Ping-Tester: misst die Antwortzeit zu allen Fortnite-Regionen und zeigt, welcher Server für dich am schnellsten ist.

import { fmtMs, fmtPct, quality, liveStats, scaleMax, barPct, groupResults, recommendation, historyRows, trend, methodLabel } from '../lib/ping-view.mjs';

let cleanup = [];

const METHODS = [
  ['auto', 'Automatisch', 'Nimmt den normalen Ping (ICMP, die klassische Ping-Anfrage) und weicht auf TCP aus, wenn ein Server nicht antwortet. Empfohlen.'],
  ['icmp', 'Nur Ping', 'Der klassische Ping, so wie ihn auch Epic empfiehlt. Gibt es nur unter Windows.'],
  ['tcp', 'TCP-Verbindung', 'Misst, wie lange ein Verbindungsaufbau (wie beim Öffnen einer Webseite) zu einem Rechenzentrum in derselben Stadt dauert. Für Iowa und Texas gibt es so ein Ziel nicht.'],
];
const SAMPLES = [
  [5, 'Schnell'],
  [8, 'Normal'],
  [15, 'Genau'],
];

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;

    let info = null;
    let settings = { method: 'auto', samples: 8 };
    let running = false;
    let ownCall = false;
    let live = new Map(); // id -> Werte während der Messung
    const livePhase = new Map(); // id -> 'icmp' | 'tcp'
    let alive = true;
    let progress = null; // { phase, done, total, name, ms }
    let report = null;
    let raf = 0;

    const platformBox = h('div');
    const controls = h('section.block.ping-controls');
    const bestBox = h('div');
    const resultsBox = h('div');
    const historyBox = h('div');
    root.append(platformBox, controls, bestBox, resultsBox, historyBox);

    // ---------- Laden ----------
    try {
      info = await env.call('ping.info');
    } catch (e) {
      ui.mount(root, ui.emptyState({ title: 'Der Ping-Tester konnte nicht starten', text: e.message || String(e) }));
      return;
    }
    settings = { ...settings, ...(info.settings || {}) };
    if (!info.platform?.icmp && settings.method === 'icmp') settings.method = 'auto';
    report = info.last || null;
    running = !!info.running;

    // ---------- Ereignisse ----------
    const offProgress = env.on('ping.progress', (p) => {
      if (!p || !p.id) return;
      if (!running) { running = true; live = new Map(); livePhase.clear(); renderAll(); }
      progress = p;
      // Bei "Automatisch" startet die TCP-Messung eines Servers neu – dann zählen nur noch die TCP-Werte
      if (!live.has(p.id) || livePhase.get(p.id) !== p.phase) { live.set(p.id, []); livePhase.set(p.id, p.phase); }
      const arr = live.get(p.id);
      if (p.skipped) arr.push(null); else arr.push(p.ms);
      scheduleLive();
    });
    const offDone = env.on('ping.done', (rep) => {
      if (ownCall || !rep) return; // eigenes Ergebnis kommt über den Aufruf
      finish(rep, false);
    });
    cleanup.push(offProgress, offDone, () => { alive = false; cancelAnimationFrame(raf); });

    function scheduleLive() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderProgress();
        renderResults();
      });
    }

    // ---------- Messen ----------
    async function start() {
      if (running) return;
      running = true;
      ownCall = true;
      live = new Map();
      livePhase.clear();
      progress = null;
      renderAll();
      try {
        const rep = await env.call('ping.measure', { method: settings.method, samples: settings.samples });
        finish(rep, true);
      } catch (e) {
        running = false;
        if (alive) renderAll();
        if (e.code === 'NOT_WINDOWS') ui.toast(e.message, 'warn', { timeout: 6000 });
        else ui.showError(e, 'Messung fehlgeschlagen');
      } finally {
        ownCall = false;
      }
    }

    async function finish(rep, mine) {
      running = false;
      progress = null;
      live = new Map();
      if (!alive) {
        if (mine && rep.best && !rep.cancelled) ui.toast(`Ping-Messung fertig. Bester Server: ${rep.best.name}, ${fmtMs(rep.best.ms)}.`);
        return;
      }
      if (rep.cancelled) {
        renderAll();
        if (mine) ui.toast('Messung abgebrochen. Der Verlauf bleibt unverändert.', 'info');
        return;
      }
      report = rep;
      try { info = await env.call('ping.info'); } catch { /* Verlauf bleibt wie er war */ }
      renderAll();
      if (!mine) return;
      if (!rep.best) ui.toast('Kein Server hat geantwortet. Prüfe deine Internetverbindung.', 'err', { timeout: 7000 });
      else if (rep.proxy?.suspect) ui.toast(`Messung fertig – aber: ${rep.proxy.message}.`, 'warn', { timeout: 7000 });
      else ui.toast(`Messung fertig. Bester Server: ${rep.best.name}, ${fmtMs(rep.best.ms)}.`);
      env.refreshStatus?.();
    }

    async function cancel() {
      try {
        const r = await env.call('ping.cancel');
        if (!r.cancelled) ui.toast('Es läuft gerade keine Messung.', 'info');
      } catch (e) { ui.showError(e); }
    }

    // ---------- Darstellung ----------
    function renderPlatform() {
      ui.clear(platformBox);
      if (info.platform?.icmp) return;
      platformBox.append(h('div.callout.info', icon('info'), h('div',
        h('strong', 'Hier misst HELIX über TCP'),
        h('p.hint', 'Den klassischen Ping (ICMP) nutzt HELIX nur unter Windows. Auf diesem System wird stattdessen gemessen, wie lange ein Verbindungsaufbau zu einem Rechenzentrum in derselben Stadt dauert. Die Werte sind ähnlich, Iowa und Texas fehlen dabei.'))));
    }

    function segmented(options, value, onPick, { disabledIds = [] } = {}) {
      return h('div.segmented', { role: 'radiogroup' }, options.map(([id, label]) => h(`button.seg${value === id ? '.active' : ''}`, {
        type: 'button',
        role: 'radio',
        'aria-checked': String(value === id),
        disabled: running || disabledIds.includes(id),
        onclick: () => onPick(id),
      }, label)));
    }

    function renderControls() {
      const m = METHODS.find((x) => x[0] === settings.method) || METHODS[0];
      const startBtn = ui.button(running ? 'Misst …' : (report ? 'Neu messen' : 'Messung starten'), {
        variant: 'primary', iconName: running ? 'clock' : 'play', disabled: running, onClick: start,
      });
      const cancelBtn = running ? ui.button('Abbrechen', { iconName: 'stop', variant: 'ghost', onClick: cancel }) : null;
      const pick = (key) => (v) => {
        settings = { ...settings, [key]: v };
        renderControls();
        const label = key === 'method' ? (METHODS.find((x) => x[0] === v) || [])[1] : `${(SAMPLES.find((x) => x[0] === v) || [])[1]} (${v} Messungen je Server)`;
        ui.toast(`${key === 'method' ? 'Messart' : 'Genauigkeit'}: ${label}. Gilt ab der nächsten Messung.`, 'info', { timeout: 2600 });
      };
      ui.mount(controls,
        h('div.ping-hero',
          h('div.grow',
            h('h3', 'Welcher Fortnite-Server ist für dich am schnellsten?'),
            h('p.hint', 'HELIX misst die Antwortzeit (Ping, in Millisekunden – tausendstel Sekunden) zu allen 16 Fortnite-Standorten. Kleiner ist besser. Dauert etwa 10 bis 20 Sekunden.')),
          h('div.ping-actions', startBtn, cancelBtn)),
        h('div.ping-options',
          h('div.field',
            h('label', 'Messart'),
            segmented(METHODS, settings.method, pick('method'), { disabledIds: info.platform?.icmp ? [] : ['icmp'] }),
            h('p.hint', m[2])),
          h('div.field',
            h('label', 'Genauigkeit'),
            segmented(SAMPLES, settings.samples, pick('samples')),
            h('p.hint', 'Wie oft jeder Server gemessen wird. Mehr Messungen sind verlässlicher, dauern aber länger.'))),
        h('div.ping-progress-wrap', { hidden: !running }));
      renderProgress();
    }

    function renderProgress() {
      const wrap = controls.querySelector('.ping-progress-wrap');
      if (!wrap) return;
      wrap.hidden = !running;
      if (!running) { ui.clear(wrap); return; }
      const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
      const phase = progress?.phase === 'tcp' ? 'TCP-Verbindung' : progress?.phase === 'icmp' ? 'Ping' : 'Start';
      const last = progress ? `${progress.name}: ${progress.skipped ? 'antwortet nicht' : progress.ms == null ? 'keine Antwort' : fmtMs(progress.ms)}` : 'Verbindung wird vorbereitet …';
      ui.mount(wrap,
        h('div.ping-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Fortschritt der Messung' },
          h('span', { style: { width: `${pct}%` } })),
        h('p.hint', `${phase}: ${progress ? `${progress.done} von ${progress.total} Messungen` : '…'} · ${last}`));
    }

    function renderBest() {
      ui.clear(bestBox);
      if (running || !report) return;
      if (!report.best) {
        bestBox.append(h('div.callout.err', icon('warn'), h('div',
          h('strong', 'Kein Server hat geantwortet'),
          h('p.hint', 'Prüfe, ob du mit dem Internet verbunden bist. Manche Router oder Firewalls (Schutzprogramme für das Netzwerk) blockieren Pings – wähle dann oben „TCP-Verbindung“.'))));
        return;
      }
      const rec = recommendation(info.regions, report.results, report.best);
      const q = quality(report.best.ms);
      const tr = trend(info.history);
      bestBox.append(h('section.block.ping-best',
        h('div.ping-best-head',
          h('div.ping-best-ms', h('strong', fmtMs(report.best.ms)), h('span.hint', 'Median')),
          h('div.grow',
            h('h3', `Bester Server: ${report.best.name}`),
            h('p.hint', `${report.best.region} · gemessen ${ui.fmtAgo(report.at)} · ${methodLabel(report.method)}`)),
          ui.badge(q.label, q.type),
          report.proxy?.suspect ? ui.badge('unsicher', 'warn') : null),
        report.proxy?.suspect ? h('div.callout.warn', icon('warn'), h('div',
          h('strong', `${report.proxy.message}.`),
          h('p.hint', 'Einige Werte sind schneller, als es physikalisch möglich ist. Meist läuft dein Internet über einen Proxy oder ein VPN (ein Umweg über einen fremden Server). Schalte es ab und miss noch einmal.'))) : null,
        rec ? h('div.callout.info', icon('sparkle'), h('div',
          h('strong', 'So stellst du es ein'),
          h('p', rec.text),
          rec.alt ? h('p.hint', rec.alt) : null,
          rec.competitive ? h('p.hint', rec.competitive) : null,
          h('p.hint', rec.auto))) : null,
        tr ? h('p.hint.ping-trend', icon(tr.type === 'ok' ? 'check' : 'info', 14), ' ', tr.text) : null));
    }

    function resultRow(r, max, bestId, proxyIds) {
      const measured = typeof r.medianMs === 'number';
      const q = quality(r.medianMs);
      const isBest = !running && r.id === bestId;
      const badges = [];
      if (isBest) badges.push(ui.badge('Bester', 'accent'));
      if (measured) badges.push(ui.badge(q.label, q.type));
      else if (running && !r.sent) badges.push(ui.badge('wartet', ''));
      else if (r.noFallback) badges.push(ui.badge('nur mit Ping messbar', ''));
      else badges.push(ui.badge('keine Antwort', 'err'));
      if (r.method === 'tcp' && !running) badges.push(ui.badge('TCP', ''));
      if (r.estimate) badges.push(ui.badge('Schätzung', 'warn'));
      if (proxyIds.has(r.id)) badges.push(ui.badge('unmöglich schnell', 'warn'));
      if (measured && r.lossPct > 5) badges.push(ui.badge(`${fmtPct(r.lossPct)} Verlust`, r.lossPct > 20 ? 'err' : 'warn'));
      const nb = (label, value) => `${label}\u00a0${value}`;
      const stats = [nb('bester Wert', fmtMs(r.minMs)), nb('Schwankung', fmtMs(r.jitterMs)), nb('Verlust', fmtPct(r.lossPct))].join(' · ');
      const detail = measured
        ? (running ? `${r.sent} von ${settings.samples} · ${stats}` : stats)
        : running ? (r.sent ? `${r.sent} gesendet, noch keine Antwort` : 'noch nicht gemessen')
          : r.noFallback ? 'Für diesen Standort gibt es kein TCP-Ziel – er lässt sich nur mit Ping messen.'
            : 'Der Server hat auf keine Anfrage geantwortet.';
      return h(`li.ping-row${isBest ? '.best' : ''}`,
        h('div.ping-name', h('strong', r.name), h('span.hint', detail)),
        h('div.ping-bar', { 'aria-hidden': 'true' }, h(`span.q-${isBest ? 'best' : q.type}`, { style: { width: `${barPct(r.medianMs, max)}%` } })),
        h('div.ping-val', h('strong', fmtMs(r.medianMs))),
        h('div.ping-badges', badges));
    }

    function currentResults() {
      if (running) {
        const all = info.regions.flatMap((g) => g.subs);
        return all.map((s) => {
          const vals = live.get(s.id) || [];
          const st = liveStats(vals);
          return { id: s.id, name: s.name, ...st };
        });
      }
      return report ? report.results : null;
    }

    function renderResults() {
      const results = currentResults();
      if (!results) {
        ui.mount(resultsBox, ui.emptyState({
          title: 'Noch keine Messung',
          text: 'Starte die Messung oben. HELIX zeigt dir danach alle Regionen mit ihrer Antwortzeit und sagt dir, welche du in Fortnite einstellen solltest.',
          action: ui.button('Messung starten', { variant: 'primary', iconName: 'play', onClick: start }),
        }));
        return;
      }
      const max = scaleMax(results);
      const bestId = report?.best?.id;
      const proxyIds = new Set(!running && report?.proxy?.ids ? report.proxy.ids : []);
      const groups = groupResults(info.regions, results);
      ui.mount(resultsBox,
        h('div.ping-groups', groups.map((g) => h('section.block.ping-group',
          h('div.block-head.ping-group-head',
            h('h3', g.label),
            h('span.hint', g.items.length > 1 ? `${g.items.length} Unterregionen` : '1 Standort'),
            h('span.grow'),
            typeof g.bestMs === 'number' ? h('span.hint', `bestes Ergebnis ${fmtMs(g.bestMs)}`) : null),
          h('ul.ping-list', g.items.map((r) => resultRow(r, max, bestId, proxyIds)))))),
        h('p.hint.ping-legend', 'Gezeigt wird der Median (der mittlere Wert aller Messungen). Schwankung (Jitter) heißt: so stark springt der Wert von Messung zu Messung. Verlust heißt: so viele Anfragen kamen nicht zurück. „Schätzung“: gemessen bei einem Rechenzentrum in der Nähe, nicht bei Epic selbst. Bis 30 ms ist sehr gut, bis 60 ms gut, bis 100 ms spielbar.'));
    }

    function renderHistory() {
      const rows = historyRows(info.history, 10);
      const head = h('div.toolbar',
        h('div.grow', h('h3', 'Verlauf'), h('p.hint', 'Die letzten 10 Messungen. So siehst du, ob dein Internet zu bestimmten Zeiten langsamer ist.')),
        rows.length ? ui.button('Verlauf löschen', {
          small: true, variant: 'ghost', iconName: 'trash',
          onClick: async () => {
            const ok = await ui.confirmDialog({ title: 'Verlauf löschen?', text: 'Alle gespeicherten Messungen werden gelöscht. Das kann nicht rückgängig gemacht werden.', confirmLabel: 'Löschen', danger: true });
            if (!ok) return;
            try {
              await env.call('ping.clearHistory');
              info = await env.call('ping.info');
              report = null;
              renderAll();
              ui.toast('Verlauf gelöscht.');
            } catch (e) { ui.showError(e); }
          },
        }) : null);
      if (!rows.length) {
        ui.mount(historyBox, h('section.block', head, h('p.hint', 'Noch kein Verlauf. Nach jeder Messung erscheint hier eine Zeile.')));
        return;
      }
      const max = Math.max(60, ...rows.map((r) => (r.best && typeof r.best.ms === 'number' ? r.best.ms : 0)));
      ui.mount(historyBox, h('section.block', head,
        h('ul.list.ping-history', rows.map((r) => {
          const q = quality(r.best?.ms);
          return h('li',
            h('div.grow', h('span', r.best ? `${r.best.name} · ${r.best.region}` : 'Kein Server erreichbar'), h('span.hint', `${ui.fmtDate(r.at)} · ${methodLabel(r.method)}`)),
            h('div.ping-bar.small', { 'aria-hidden': 'true' }, h(`span.q-${q.type}`, { style: { width: `${barPct(r.best?.ms, max)}%` } })),
            h('strong.ping-hval', fmtMs(r.best?.ms)),
            ui.badge(q.label, q.type));
        }))));
    }

    function renderAll() {
      renderPlatform();
      renderControls();
      renderBest();
      renderResults();
      renderHistory();
    }

    renderAll();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
