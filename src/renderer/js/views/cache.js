// Cache-Cleaner: zeigt, wie viel Platz Shader-, DirectX- und Fortnite-Zwischenspeicher belegen,
// und löscht die gewählten Bereiche nach einer Bestätigung.

import { defaultSelection, mergeSelection, selectedTotals, grouped, filesText, resultText, rowHint } from '../lib/cache-select.mjs';

let cleanup = [];

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;

    let scan = null;
    let selected = new Set();
    let knownIds = null;
    let fortniteRunning = false;
    let lastResult = null;
    let cleaning = false;
    let alive = true;

    const fortniteBox = h('div');
    const toolbarHint = h('p.hint');
    const listBox = h('div.cache-groups');
    const resultBox = h('div.cache-result');
    const barStats = h('div.cache-bar-stats');
    const btnClean = ui.button('Aufräumen', { variant: 'primary', iconName: 'trash', onClick: () => cleanFlow() });
    const bar = h('div.cache-bar.glass', barStats,
      h('div.cache-bar-actions',
        ui.button('Alle', { small: true, variant: 'ghost', onClick: () => { selected = defaultSelection(scan?.categories); renderList(); renderBar(); } }),
        ui.button('Keine', { small: true, variant: 'ghost', onClick: () => { selected = new Set(); renderList(); renderBar(); } }),
        btnClean));
    const progressLine = h('p.hint.cache-progress', { 'aria-live': 'polite' });

    const intro = h('div.callout.info', icon('info'), h('div',
      h('strong', 'Löschen ist sicher'),
      h('p.hint', 'Windows, Grafiktreiber und Fortnite legen alles von selbst neu an.'),
      ui.more('Wann lohnt es sich?',
        'Zwischenspeicher (Cache) sind Dateien, die Windows, der Grafiktreiber und Fortnite anlegen, damit später alles schneller lädt.',
        'Aufräumen lohnt sich, wenn Fortnite nach einem Treiber- oder Spiel-Update ruckelt oder der Speicherplatz knapp wird. Dauerhaft schneller wird der PC dadurch nicht.')));

    const toolbar = h('div.toolbar',
      ui.button('Neu messen', { iconName: 'refresh', onClick: () => load(true) }),
      h('span.grow'),
      toolbarHint);

    root.append(intro, fortniteBox, resultBox, toolbar, listBox);

    function renderFortnite() {
      ui.clear(fortniteBox);
      if (!fortniteRunning) return;
      fortniteBox.append(h('div.callout.warn', icon('warn'), h('div.grow',
        h('strong', 'Fortnite läuft gerade'),
        h('p.hint', 'Schließe Fortnite, dann kannst du aufräumen.'),
        h('div.row',
          ui.button('Fortnite schließen', {
            small: true, iconName: 'power',
            onClick: async () => {
              const r = await env.call('core.fortniteClose', { force: false }).catch((e) => { ui.showError(e); return null; });
              const st = await env.call('core.fortniteStatus').catch(() => ({ running: true }));
              fortniteRunning = !!st.running;
              if (r && !fortniteRunning) ui.toast('Fortnite ist geschlossen.');
              else if (r) ui.toast('Fortnite hat sich nicht beendet – bitte schließe es selbst.', 'warn');
              renderFortnite(); renderBar();
            },
          }),
          ui.button('Erneut prüfen', {
            small: true, variant: 'ghost', iconName: 'refresh',
            onClick: async () => {
              const st = await env.call('core.fortniteStatus').catch(() => ({ running: true }));
              fortniteRunning = !!st.running;
              ui.toast(fortniteRunning ? 'Fortnite läuft noch.' : 'Fortnite ist geschlossen.', fortniteRunning ? 'warn' : 'ok');
              renderFortnite(); renderBar();
            },
          })))));
    }

    function categoryRow(c) {
      const empty = !(c.bytes > 0 || c.count > 0);
      const checked = selected.has(c.id);
      const input = h('input', {
        type: 'checkbox', checked, disabled: empty || cleaning,
        'aria-label': `${c.label} auswählen`,
        onchange: () => {
          if (input.checked) selected.add(c.id); else selected.delete(c.id);
          row.classList.toggle('checked', input.checked);
          renderBar();
        },
      });
      const openBtn = h('button.icon-btn.cache-open', {
        type: 'button', title: 'Ordner im Explorer öffnen', 'aria-label': `Ordner von ${c.label} öffnen`,
        onclick: async (e) => {
          e.preventDefault(); e.stopPropagation();
          try { await env.call('cache.openFolder', { id: c.id }); ui.toast('Ordner geöffnet.', 'info'); } catch (err) { ui.showError(err); }
        },
      }, icon('folder', 16));
      const row = h(`label.cache-row${checked ? '.checked' : ''}${empty ? '.is-empty' : ''}`,
        input,
        h('div.grow.cache-text',
          h('div.cache-row-head', h('strong', c.label),
            empty ? ui.badge('leer', '') : null,
            c.privacy ? ui.badge('Datenschutz-Plus', 'accent') : null,
            c.truncated ? ui.badge('sehr viele Dateien', 'warn') : null),
          h('p.hint', rowHint(c)),
          c.privacy ? h('p.hint.cache-privacy', icon('shield', 14), h('span', rowHint(c, 'privacy'))) : null),
        h('div.cache-size',
          h('strong', ui.fmtBytes(c.bytes)),
          h('span.hint', c.folders > 1 ? `${filesText(c.count)} · ${c.folders} Ordner` : filesText(c.count))),
        openBtn);
      return row;
    }

    function renderList() {
      ui.clear(listBox);
      if (!scan) return;
      if (scan.unsupported) {
        listBox.append(h('div.callout.info', icon('info'), h('div',
          h('strong', 'Nur unter Windows'),
          h('p.hint', 'Diese Ordner gibt es nur auf einem Windows-PC.'))));
        return;
      }
      if (!scan.categories.length) {
        listBox.append(ui.emptyState({
          title: 'Keine Zwischenspeicher gefunden',
          text: 'Alles sauber – es gibt nichts aufzuräumen.',
          action: ui.button('Neu messen', { iconName: 'refresh', onClick: () => load(true) }),
        }));
        return;
      }
      for (const g of grouped(scan.categories)) {
        listBox.append(ui.section(g.title, g.hint, h('div.cache-list', g.items.map(categoryRow))));
      }
    }

    function renderBar() {
      ui.clear(barStats);
      if (!scan || scan.unsupported || !scan.categories.length) { bar.remove(); return; }
      if (!bar.isConnected) root.append(bar);
      const t = selectedTotals(scan.categories, selected);
      const all = scan.categories.filter((c) => c.bytes > 0 || c.count > 0).length;
      barStats.append(
        h('div.cache-gain', h('span.hint', 'Platzgewinn'), h('strong', ui.fmtBytes(t.bytes))),
        h('div.cache-bar-text',
          h('span', `${t.n} von ${all} Bereichen gewählt · ${filesText(t.count)}`),
          cleaning ? progressLine : h('span.hint', fortniteRunning ? 'Erst Fortnite schließen, dann aufräumen.' : 'Vor dem Löschen fragt HELIX noch einmal nach.')));
      btnClean.disabled = cleaning || !t.n || fortniteRunning;
    }

    function renderResult() {
      ui.clear(resultBox);
      if (!lastResult) return;
      const r = lastResult;
      const type = r.skipped ? 'warn' : 'ok';
      resultBox.append(ui.section('Ergebnis', null,
        h('div.stat-row',
          h('div.stat', h('span.hint', 'Frei geworden'), h('strong', ui.fmtBytes(r.freedBytes))),
          h('div.stat', h('span.hint', 'Gelöscht'), h('strong', r.deleted.toLocaleString('de-DE')), h('span.hint', r.deleted === 1 ? 'Datei' : 'Dateien')),
          h('div.stat', h('span.hint', 'Übersprungen'), h('strong', r.skipped.toLocaleString('de-DE')), h('span.hint', 'gerade in Benutzung'))),
        h(`div.callout.${type}`, icon(type === 'ok' ? 'check' : 'warn'), h('p',
          r.skipped ? 'Übersprungenes lässt sich nach einem PC-Neustart meist löschen.'
            : r.deleted ? 'Fertig. Das erste Match danach kann kurz ruckeln.'
              : resultText(r, ui.fmtBytes)))));
    }

    async function load(manual = false) {
      if (!manual) ui.mount(listBox, h('div.loading', h('div.cache-loading', ui.spinner(), h('span.hint', 'Größe wird gemessen …'))));
      try {
        const s = await env.call('cache.scan');
        if (!alive) return;
        scan = s;
        fortniteRunning = !!s.fortniteRunning;
        selected = knownIds ? mergeSelection(selected, s.categories, knownIds) : defaultSelection(s.categories);
        knownIds = new Set((s.categories || []).map((c) => c.id));
        toolbarHint.textContent = s.unsupported ? '' : `Gemessen ${ui.fmtAgo(s.at)} · zusammen ${ui.fmtBytes(s.bytes)}`;
        if (manual) ui.toast(s.unsupported ? 'Nur unter Windows verfügbar.' : `Gemessen: ${ui.fmtBytes(s.bytes)} in Zwischenspeichern.`, s.unsupported ? 'info' : 'ok');
      } catch (e) {
        if (!alive) return;
        scan = null;
        ui.mount(listBox, ui.emptyState({ title: 'Messen hat nicht geklappt', text: e.message || String(e), action: ui.button('Nochmal versuchen', { iconName: 'refresh', onClick: () => load() }) }));
        ui.showError(e);
        renderBar();
        return;
      }
      renderFortnite();
      renderList();
      renderBar();
    }

    async function cleanFlow() {
      if (!scan) return;
      const chosen = scan.categories.filter((c) => selected.has(c.id));
      if (!chosen.length) { ui.toast('Bitte wähle mindestens einen Bereich aus.', 'warn'); return; }
      const t = selectedTotals(scan.categories, selected);
      const ok = await ui.modal({
        title: `${ui.fmtBytes(t.bytes)} aufräumen?`,
        subtitle: 'Diese Zwischenspeicher werden gelöscht:',
        content: [
          h('ul.list.compact', chosen.map((c) => h('li', icon('trash', 16), h('div.grow', h('span', c.label)), h('span.hint', ui.fmtBytes(c.bytes))))),
          h('p.hint', 'Nicht rückgängig zu machen – sie werden aber von selbst neu angelegt.'),
        ],
        actions: [
          { label: 'Abbrechen', value: false },
          { label: 'Jetzt aufräumen', value: true, variant: 'primary', icon: 'trash' },
        ],
      });
      if (ok !== true) return;
      cleaning = true;
      progressLine.textContent = 'Wird aufgeräumt …';
      renderList(); renderBar();
      try {
        const r = await env.call('cache.clean', { ids: chosen.map((c) => c.id) });
        if (!alive) return;
        lastResult = r;
        if (r.scan) {
          scan = { ...scan, ...r.scan };
          selected = mergeSelection(selected, scan.categories, knownIds);
          toolbarHint.textContent = `Gemessen ${ui.fmtAgo(scan.at)} · zusammen ${ui.fmtBytes(scan.bytes)}`;
        }
        ui.toast(resultText(r, ui.fmtBytes), r.skipped ? 'warn' : 'ok', { timeout: 6000 });
      } catch (e) {
        if (e.code === 'FORTNITE_RUNNING') { fortniteRunning = true; renderFortnite(); }
        ui.showError(e, 'Aufräumen nicht möglich');
      } finally {
        cleaning = false;
      }
      if (!alive) return;
      renderList(); renderBar(); renderResult();
      if (lastResult) resultBox.scrollIntoView({ block: 'start' });
    }

    const offProgress = env.on('cache.progress', (p) => {
      if (!cleaning || !p) return;
      progressLine.textContent = p.done ? 'Fast fertig …' : `Räume auf: ${p.label} (${p.index + 1} von ${p.total})`;
    });
    const offFortnite = env.on('fortnite.state', (st) => {
      fortniteRunning = !!st?.running;
      renderFortnite(); renderBar();
    });
    cleanup = [offProgress, offFortnite, () => { alive = false; }];

    await load();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
