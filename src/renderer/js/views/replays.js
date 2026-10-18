// Replay-Tresor: sichert die besten Fortnite-Replays, bevor Fortnite sie löscht.
// Zeigt Replays aus Fortnite (Demos-Ordner) und aus dem Tresor, mit Dauer, Datum, Größe und Version.

import { fmtLength, displayName, baseName, shortTitle, statusBadges, unsavedCount, countText, copyAllText } from '../lib/replays-format.mjs';
import { fortniteClosedFor, replayError } from '../lib/replays-fortnite.mjs';

let cleanup = [];

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;

    let tab = 'demos';
    let data = null;
    let alive = true;
    let refreshTimer = null;

    const statusLine = h('div.status-line');
    const intro = h('div.callout.info', icon('info'), h('div',
      h('p.replays-intro', 'Fortnite löscht alte Replays von selbst – im Tresor bleiben sie, bis du sie löschst.'),
      ui.more('Warum?', 'Fortnite behält nur deine letzten 100 ungespeicherten Replays (Aufnahmen deiner Matches). Ältere löscht es ohne Nachfrage.')));
    const stats = h('div.stat-row');
    const tabs = h('div.replays-tabs', { role: 'tablist' });
    const body = h('div');
    const notes = h('div.replays-notes', ui.more('Gut zu wissen',
      'Replays laufen nur in der Fortnite-Version, mit der sie aufgenommen wurden. Nach einem Update lassen sie sich nicht mehr abspielen – im Tresor bleiben sie trotzdem.',
      'Replays enthalten die Namen deiner Mitspieler. Teile sie nur mit Leuten, denen du vertraust.'));
    root.append(statusLine, intro, stats, tabs, body, notes);

    // ---------------- Kopfzeile: Tresor-Ordner ----------------
    function renderStatus() {
      ui.clear(statusLine);
      if (!data) return;
      const v = data.vault;
      statusLine.append(h('div.path-line', icon('folder', 16), h('span', 'Tresor:'), h('span.mono', v.dir || 'nicht festgelegt'),
        v.isDefault ? ui.badge('Standardordner', 'ok') : ui.badge('selbst gewählt', 'accent'),
        ui.button('Ordner ändern', { small: true, variant: 'ghost', iconName: 'edit', title: 'Eigenen Ordner wählen – nicht im Fortnite-Ordner', onClick: pickVault }),
        v.isDefault ? null : ui.button('Standard', { small: true, variant: 'ghost', iconName: 'refresh', title: 'Zurück zu Dokumente\\HELIX Replays', onClick: resetVault }),
        ui.button('Öffnen', { small: true, variant: 'ghost', iconName: 'folder', onClick: () => openFolder('vault') })));
      if (v.problem) {
        statusLine.append(h('div.callout.err', icon('warn'), h('div',
          h('strong', 'Dieser Tresor-Ordner passt nicht'),
          h('p.hint', v.problem),
          h('div.row', ui.button('Anderen Ordner wählen', { small: true, variant: 'primary', iconName: 'folder', onClick: pickVault })))));
      }
    }

    function renderStats() {
      ui.clear(stats);
      if (!data) return;
      const open = unsavedCount(data.demos.entries);
      stats.append(
        h('div.stat', h('span.hint', 'In Fortnite'), h('strong', String(data.demos.entries.length)), h('span.hint', !data.demos.entries.length ? 'noch keine Aufnahmen' : open ? `${open} noch nicht gesichert` : 'alle gesichert')),
        h('div.stat', h('span.hint', 'Im Tresor'), h('strong', String(data.vault.entries.length)), h('span.hint', ui.fmtBytes(data.vault.bytes || 0))),
        h('div.stat', h('span.hint', 'Neueste Fortnite-Version'), h('strong', data.newestVersion || '–'), h('span.hint', 'laut deinen Replays')));
    }

    function renderTabs() {
      ui.clear(tabs);
      const TABS = [
        ['demos', 'Neue Replays', 'play', data ? data.demos.entries.length : null],
        ['vault', 'Tresor', 'shield', data ? data.vault.entries.length : null],
      ];
      for (const [id, label, ic, n] of TABS) {
        tabs.appendChild(h(`button.tab${tab === id ? '.active' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': String(tab === id),
          onclick: () => { tab = id; renderTabs(); renderBody(); },
        }, icon(ic, 16), h('span', label), n != null ? h('span.replays-count', String(n)) : null));
      }
    }

    // ---------------- Tabellen ----------------
    function nameCell(e, where) {
      const name = displayName(e, where);
      const when = e.recordedAt ? `${ui.fmtDate(e.recordedAt)} · ${ui.fmtAgo(e.recordedAt)}` : 'Datum unbekannt';
      const sub = where === 'vault' && e.friendlyName && !/^unsaved replay$/i.test(e.friendlyName) && e.friendlyName !== name ? `In Fortnite: ${e.friendlyName}` : null;
      return h('td', h('div.file-cell', icon(e.recording ? 'clock' : 'play', 16), h('div',
        h('span.replays-name', name),
        h('span.hint', when),
        sub ? h('span.hint', sub) : null,
        where === 'vault' && name !== baseName(e.file) ? h('span.hint.mono', e.file) : null)));
    }

    function badgesCell(e, where) {
      const list = statusBadges(e, where, data.newestVersion);
      return h('td', h('div.replays-badges', list.length ? list.map((b) => {
        const el = ui.badge(b.text, b.type);
        if (b.title) el.title = b.title;
        return el;
      }) : where === 'demos' ? ui.badge('noch nicht gesichert', '') : null));
    }

    function demoRow(e) {
      const canCopy = !e.recording && !e.inVault;
      return h(`tr${e.recording ? '.excluded' : ''}`,
        nameCell(e, 'demos'),
        h('td.num', e.ok ? fmtLength(e.lengthMs) : '–'),
        h('td.num', ui.fmtBytes(e.size)),
        h('td.num', e.version || '–'),
        badgesCell(e, 'demos'),
        h('td', h('div.replays-actions',
          ui.button(e.inVault ? 'Gesichert' : 'In den Tresor', {
            small: true, variant: canCopy ? 'primary' : '', iconName: e.inVault ? 'check' : 'download', disabled: !canCopy,
            title: e.recording ? 'Wird gerade aufgenommen – bitte warten, bis das Match vorbei ist.' : e.inVault ? 'Liegt schon im Tresor.' : 'Kopie in den Tresor legen. Das Original bleibt in Fortnite.',
            onClick: () => copyOne(e),
          }),
          ui.button('', { small: true, variant: 'ghost', iconName: 'trash', title: 'In den Papierkorb verschieben', disabled: e.recording, onClick: () => removeOne(e, 'demos') }))));
    }

    function vaultRow(e) {
      return h('tr',
        nameCell(e, 'vault'),
        h('td.num', e.ok ? fmtLength(e.lengthMs) : '–'),
        h('td.num', ui.fmtBytes(e.size)),
        h('td.num', e.version || '–'),
        badgesCell(e, 'vault'),
        h('td', h('div.replays-actions',
          ui.button('Zurück in Fortnite', {
            small: true, iconName: 'upload', disabled: e.inDemos || !data.demos.dir,
            title: e.inDemos ? 'Fortnite hat dieses Replay noch.' : 'Kopie zurück in den Fortnite-Ordner legen, damit du es im Spiel ansehen kannst.',
            onClick: () => restoreOne(e),
          }),
          ui.button('', { small: true, variant: 'ghost', iconName: 'edit', title: 'Umbenennen', onClick: () => renameOne(e) }),
          ui.button('', { small: true, variant: 'ghost', iconName: 'trash', title: 'In den Papierkorb verschieben', onClick: () => removeOne(e, 'vault') }))));
    }

    function table(rows) {
      return h('div.table-wrap', h('table.table.replays-table',
        h('thead', h('tr', h('th', 'Replay'), h('th', 'Dauer'), h('th', 'Größe'), h('th', 'Version'), h('th', 'Status'), h('th', h('span.sr-only', 'Aktionen')))),
        h('tbody', rows)));
    }

    function renderDemos() {
      const d = data.demos;
      const open = unsavedCount(d.entries);
      const head = h('div.toolbar',
        ui.button(open ? `Alle neuen sichern (${open})` : 'Alle neuen sichern', { variant: 'primary', iconName: 'shield', disabled: !open || !!data.vault.problem, onClick: copyAll }),
        ui.button('Aktualisieren', { iconName: 'refresh', onClick: () => load(true) }),
        d.dir && d.found ? ui.button('Fortnite-Ordner öffnen', { iconName: 'folder', variant: 'ghost', onClick: () => openFolder('demos') }) : null,
        h('span.grow'),
        h('p.hint', 'Das Original bleibt in Fortnite.'));
      if (!d.dir) {
        return [ui.emptyState({
          title: 'Fortnite-Ordner nicht gefunden',
          text: 'Starte Fortnite einmal oder wähle den Ordner unter „Settings-Profile“.',
          action: ui.button('Zu den Settings-Profilen', { iconName: 'folder', onClick: () => env.nav.go('profiles') }),
        })];
      }
      if (!d.entries.length) {
        return [head, ui.emptyState({
          title: 'Noch keine Replays',
          text: 'Ist in Fortnite unter Einstellungen → Spiel die Replay-Aufnahme an?',
          action: ui.button('Aktualisieren', { iconName: 'refresh', onClick: () => load(true) }),
        })];
      }
      return [head, table(d.entries.map(demoRow))];
    }

    function renderVault() {
      const v = data.vault;
      const head = h('div.toolbar',
        ui.button('Tresor öffnen', { iconName: 'folder', onClick: () => openFolder('vault') }),
        ui.button('Aktualisieren', { iconName: 'refresh', variant: 'ghost', onClick: () => load(true) }),
        h('span.grow'),
        v.entries.length ? h('p.hint', `${countText(v.entries.length)} · ${ui.fmtBytes(v.bytes || 0)}`) : null);
      if (!v.entries.length) {
        return [head, ui.emptyState({
          title: 'Dein Tresor ist noch leer',
          text: 'Leg gute Spiele unter „Neue Replays“ mit „In den Tresor“ hier ab.',
          action: ui.button('Zu den neuen Replays', { iconName: 'play', variant: 'primary', onClick: () => { tab = 'demos'; renderTabs(); renderBody(); } }),
        })];
      }
      return [head, table(v.entries.map(vaultRow))];
    }

    function renderBody() {
      if (!data) return;
      ui.mount(body, tab === 'vault' ? renderVault() : renderDemos());
    }

    function renderAll() {
      renderStatus(); renderStats(); renderTabs(); renderBody();
    }

    function scheduleRefresh() {
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      if (!alive || !data) return;
      // Läuft gerade eine Aufnahme, in einer Minute noch einmal nachsehen
      if (data.demos.entries.some((e) => e.recording)) refreshTimer = setTimeout(() => { refreshTimer = null; load(false, true); }, 60000);
    }

    async function load(manual = false, quiet = false) {
      if (!data && !quiet) ui.mount(body, h('div.loading', ui.spinner()));
      try {
        const d = await env.call('replays.list');
        if (!alive) return;
        data = d;
        renderAll();
        scheduleRefresh();
        if (manual) ui.toast(`${countText(d.demos.entries.length)} in Fortnite, ${countText(d.vault.entries.length)} im Tresor.`, 'info');
      } catch (e) {
        if (!alive) return;
        if (!data) ui.mount(body, ui.emptyState({ title: 'Replays konnten nicht gelesen werden', text: e.message || String(e), action: ui.button('Nochmal versuchen', { iconName: 'refresh', onClick: () => load(true) }) }));
        ui.showError(e);
      }
    }

    // ---------------- Aktionen ----------------
    async function copyOne(e) {
      try {
        const r = await env.call('replays.copyToVault', { file: e.file });
        ui.toast(r.already ? 'Dieses Replay liegt schon im Tresor.' : `${shortTitle(e, 'demos', ui.fmtDate)} ist jetzt im Tresor.`, r.already ? 'info' : 'ok');
      } catch (err) { ui.showError(err, 'Sichern nicht möglich'); }
      await load();
    }

    async function copyAll() {
      try {
        const r = await env.call('replays.copyAllNew');
        ui.toast(copyAllText(r), r.failed ? 'warn' : r.copied ? 'ok' : 'info', { timeout: 6000 });
      } catch (err) { ui.showError(err, 'Sichern nicht möglich'); }
      await load();
    }

    async function restoreOne(e) {
      if (!(await fortniteClosedFor(env, 'das Replay zurücklegen'))) return;
      try {
        const r = await env.call('replays.restore', { file: e.file });
        ui.toast(r.already ? 'Fortnite hat dieses Replay schon.' : 'Zurück in Fortnite (Karriere → Replays) – benenne es dort um, sonst löscht Fortnite es wieder.', r.already ? 'info' : 'ok', { timeout: 8000 });
      } catch (err) { ui.showError(replayError(err), 'Zurücklegen nicht möglich'); }
      await load();
    }

    async function renameOne(e) {
      const name = await ui.promptDialog({
        title: 'Replay umbenennen',
        label: 'Neuer Name',
        value: /^UnsavedReplay-/i.test(baseName(e.file)) ? '' : baseName(e.file),
        hint: 'Zum Beispiel „Erster Sieg Solo“. Gilt nur im Tresor, nicht in Fortnite.',
        maxLength: 80,
        confirmLabel: 'Umbenennen',
      });
      if (!name) return;
      try {
        const r = await env.call('replays.rename', { file: e.file, name });
        ui.toast(`Umbenannt in „${baseName(r.file)}“.`);
      } catch (err) { ui.showError(err, 'Umbenennen nicht möglich'); }
      await load();
    }

    async function removeOne(e, where) {
      // Aus Fortnite löschen geht nur bei geschlossenem Spiel – vorher anbieten, es zu schließen
      if (where === 'demos' && !(await fortniteClosedFor(env, 'das Replay löschen'))) return;
      const ok = await ui.confirmDialog({
        title: `${shortTitle(e, where, ui.fmtDate)} löschen?`,
        text: where === 'vault'
          ? 'Die Tresor-Kopie kommt in den Windows-Papierkorb. Von dort kannst du sie zurückholen.'
          : `Das Replay kommt aus Fortnite in den Windows-Papierkorb.${e.inVault ? ' Die Kopie im Tresor bleibt.' : ' Es liegt noch nicht im Tresor!'}`,
        confirmLabel: 'In den Papierkorb',
        danger: true,
      });
      if (!ok) return;
      try {
        await env.call('replays.remove', { file: e.file, where });
        ui.toast('In den Papierkorb verschoben.');
      } catch (err) { ui.showError(replayError(err), 'Löschen nicht möglich'); }
      await load();
    }

    async function pickVault() {
      try {
        const r = await env.call('replays.pickVault');
        if (r.canceled) return;
        ui.toast('Tresor geändert – frühere Kopien bleiben im alten Ordner.');
      } catch (err) { ui.showError(err); }
      await load();
    }

    async function resetVault() {
      try {
        await env.call('replays.resetVault');
        ui.toast('Tresor zeigt wieder auf Dokumente\\HELIX Replays.');
      } catch (err) { ui.showError(err); }
      await load();
    }

    async function openFolder(which) {
      try {
        await env.call('replays.openFolder', { which });
        ui.toast('Ordner geöffnet.', 'info');
      } catch (err) { ui.showError(err); }
    }

    const offFortnite = env.on('fortnite.state', () => { if (alive) load(false, true); });
    cleanup = [offFortnite, () => { alive = false; if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = null; }];

    renderTabs();
    await load();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
