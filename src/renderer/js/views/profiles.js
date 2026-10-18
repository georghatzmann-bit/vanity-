// Hauptfunktion: Settings-Profile verwalten, gefundene Dateien, Zeitmaschine (Backups).

import { applyFlow, RO_OPTIONS, roKey, roValue } from './apply-flow.js';

let cleanup = [];

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;
    let tab = 'profiles';

    const tabs = h('div.tabs', { role: 'tablist' });
    const body = h('div.tab-body');
    const statusLine = h('div.status-line');
    root.append(statusLine, tabs, body);

    const TABS = [
      ['profiles', 'Profile', 'sparkle'],
      ['files', 'Gefundene Dateien', 'folder'],
      ['backups', 'Zeitmaschine', 'clock'],
    ];
    function renderTabs() {
      ui.clear(tabs);
      for (const [id, label, ic] of TABS) {
        tabs.appendChild(h(`button.tab${tab === id ? '.active' : ''}`, {
          type: 'button', role: 'tab', 'aria-selected': String(tab === id),
          onclick: () => { tab = id; renderTabs(); renderBody(); },
        }, icon(ic, 16), h('span', label)));
      }
    }

    async function renderStatusLine() {
      const st = await env.call('core.status').catch(() => null);
      ui.clear(statusLine);
      if (!st) return;
      if (!st.location.found) {
        statusLine.append(h('div.callout.err', icon('warn'), h('div',
          h('strong', 'Fortnite-Einstellungen nicht gefunden'),
          h('p.hint', 'HELIX hat in deinem Benutzerordner (AppData\\Local) gesucht. Starte Fortnite einmal, damit der Ordner angelegt wird – oder wähle ihn selbst aus.'),
          h('div.row',
            ui.button('Ordner auswählen', { variant: 'primary', iconName: 'folder', small: true, onClick: pickFolder }),
            ui.button('Erneut suchen', { iconName: 'refresh', small: true, onClick: async () => { await env.call('core.locate'); env.refreshStatus(); renderAll(); } })))));
        return;
      }
      statusLine.append(h('div.path-line', icon('folder', 16), h('span.mono', st.location.configDir),
        st.location.source === 'manual' ? ui.badge('selbst gewählt', 'accent') : ui.badge('automatisch gefunden', 'ok'),
        ui.button('Öffnen', { small: true, variant: 'ghost', onClick: () => env.call('core.openFolder', { which: 'config' }).catch(ui.showError) })));
    }

    async function pickFolder() {
      try {
        const r = await env.call('core.pickFolder');
        if (!r.canceled) { ui.toast('Ordner übernommen.'); env.refreshStatus(); renderAll(); }
      } catch (e) { ui.showError(e); }
    }

    // ---------------- Profile ----------------
    async function renderProfiles() {
      const list = await env.call('profiles.list').catch((e) => { ui.showError(e); return []; });
      const head = h('div.toolbar',
        ui.button('Aktuelle Einstellungen als Profil speichern', { variant: 'primary', iconName: 'plus', onClick: createProfile }),
        ui.button('Importieren', { iconName: 'upload', onClick: importProfile }),
        h('span.grow'),
        h('p.hint', 'Tipp: Stelle in Fortnite alles ein, schließe das Spiel und speichere dann hier.'));
      if (!list.length) {
        return [head, ui.emptyState({
          title: 'Noch kein Profil gespeichert',
          text: 'So geht’s: In Fortnite mit deinem Konto einloggen, alles einstellen, Fortnite schließen – dann oben „Aktuelle Einstellungen als Profil speichern“ klicken.',
        })];
      }
      const grid = h('div.profile-grid', list.map((p) => profileCard(p)));
      return [head, grid];
    }

    function summaryRows(p) {
      const s = p.summary || {};
      const rows = [
        ['Auflösung', s.resolution], ['FPS-Limit', s.fps], ['Grafik', s.renderMode], ['Qualität', s.quality], ['Anzeige', s.windowMode],
      ].filter(([, v]) => v);
      if (!rows.length) return h('p.hint', 'Keine Grafikdatei im Profil.');
      return h('dl.kv', rows.map(([k, v]) => [h('dt', k), h('dd', v)]));
    }

    function roText(p) {
      const k = roKey(p.options?.readOnly);
      return k === 'all' ? 'Schreibschutz: alle Config-Dateien' : k === 'video' ? 'Schreibschutz: Grafik-Datei' : 'Schreibschutz: aus';
    }

    function profileCard(p) {
      const menu = h('div.card-menu',
        ui.button('', { iconName: 'edit', small: true, variant: 'ghost', title: 'Umbenennen', onClick: () => rename(p) }),
        ui.button('', { iconName: 'copy', small: true, variant: 'ghost', title: 'Duplizieren', onClick: () => duplicate(p) }),
        ui.button('', { iconName: 'refresh', small: true, variant: 'ghost', title: 'Mit aktuellen Einstellungen überschreiben', onClick: () => update(p) }),
        ui.button('', { iconName: 'download', small: true, variant: 'ghost', title: 'Exportieren', onClick: () => exportProfile(p) }),
        ui.button('', { iconName: 'lock', small: true, variant: 'ghost', title: 'Schreibschutz einstellen', onClick: () => readOnlyOptions(p) }),
        ui.button('', { iconName: 'trash', small: true, variant: 'ghost', title: 'Löschen', onClick: () => remove(p) }));
      return h(`article.profile-card.glass${p.active ? '.active' : ''}`, { style: { '--hue': p.color ?? 200 } },
        h('div.card-top',
          h('span.card-orb'),
          h('div.grow', h('h3', p.name), h('p.hint', `${p.fileCount} Dateien · gespeichert ${ui.fmtAgo(p.updatedAt)}`)),
          p.active ? ui.badge('aktiv', 'accent') : null),
        summaryRows(p),
        h('div.card-meta',
          h('span.hint', icon('lock', 14), ' ', roText(p)),
          h('span.hint', icon('clock', 14), ' ', p.stats?.lastAppliedAt ? `zuletzt angewendet ${ui.fmtAgo(p.stats.lastAppliedAt)}` : 'noch nie angewendet')),
        h('div.card-actions',
          ui.button(p.active ? 'Erneut anwenden' : 'Anwenden', { variant: 'primary', iconName: 'play', onClick: () => applyFlow(env, p.id, { onDone: renderAll }) }),
          ui.button('Vergleichen', { iconName: 'eye', onClick: () => showDiff('profile', p.id, p.name) }),
          menu));
    }

    async function createProfile() {
      const name = await ui.promptDialog({
        title: 'Neues Profil speichern',
        label: 'Name des Profils',
        value: '',
        hint: 'Zum Beispiel „Main“, „Zweitaccount“ oder „Turnier“. Gespeichert werden alle Dateien aus dem Fortnite-Config-Ordner – keine Login-Daten.',
      });
      if (!name) return;
      try {
        const st = await env.call('core.fortniteStatus');
        if (st.running) {
          const ok = await ui.confirmDialog({
            title: 'Fortnite läuft noch',
            text: 'Fortnite speichert manche Einstellungen erst beim Beenden. Trotzdem jetzt speichern? Besser: Fortnite zuerst schließen.',
            confirmLabel: 'Trotzdem speichern',
          });
          if (!ok) return;
        }
        const p = await env.call('profiles.create', { name });
        ui.toast(`Profil „${p.name}“ gespeichert (${p.fileCount} Dateien).`);
        renderAll();
      } catch (e) { ui.showError(e); }
    }

    async function rename(p) {
      const name = await ui.promptDialog({ title: 'Profil umbenennen', label: 'Neuer Name', value: p.name });
      if (!name || name === p.name) return;
      try { await env.call('profiles.rename', { id: p.id, name }); ui.toast('Umbenannt.'); renderAll(); } catch (e) { ui.showError(e); }
    }

    async function duplicate(p) {
      try { const c = await env.call('profiles.duplicate', { id: p.id }); ui.toast(`Kopie „${c.name}“ angelegt.`); renderAll(); } catch (e) { ui.showError(e); }
    }

    async function update(p) {
      const ok = await ui.confirmDialog({
        title: `„${p.name}“ überschreiben?`,
        text: 'Das Profil wird mit den aktuellen Fortnite-Einstellungen auf diesem PC überschrieben. Name und Schreibschutz-Einstellung bleiben.',
        confirmLabel: 'Überschreiben',
      });
      if (!ok) return;
      try { await env.call('profiles.update', { id: p.id }); ui.toast('Profil aktualisiert.'); renderAll(); } catch (e) { ui.showError(e); }
    }

    async function remove(p) {
      const ok = await ui.confirmDialog({
        title: `„${p.name}“ löschen?`,
        text: 'Das Profil wird gelöscht. Es bleibt 30 Tage im HELIX-Papierkorb, falls du es doch noch brauchst. Deine Fortnite-Dateien bleiben unverändert.',
        confirmLabel: 'Löschen',
        danger: true,
      });
      if (!ok) return;
      try { await env.call('profiles.remove', { id: p.id }); ui.toast('Profil gelöscht.'); renderAll(); } catch (e) { ui.showError(e); }
    }

    async function exportProfile(p) {
      try {
        const r = await env.call('profiles.export', { id: p.id });
        if (!r.canceled) ui.toast(`Exportiert: ${r.file}`);
      } catch (e) { ui.showError(e); }
    }

    async function importProfile() {
      try {
        const r = await env.call('profiles.import');
        if (r.canceled) return;
        ui.toast(`Profil „${r.profile.name}“ importiert.`);
        if (r.rejected?.length) ui.toast(`${r.rejected.length} Einträge wurden aus Sicherheitsgründen nicht übernommen.`, 'warn');
        renderAll();
      } catch (e) { ui.showError(e); }
    }

    async function readOnlyOptions(p) {
      let sel = roKey(p.options?.readOnly);
      const group = h('div.radio-list', RO_OPTIONS.map(([k, label, hint]) => h('label.radio',
        h('input', { type: 'radio', name: 'ro', value: k, checked: sel === k, onchange: () => { sel = k; } }),
        h('span', h('strong', label), h('span.hint', hint)))));
      const r = await ui.modal({
        title: `Schreibschutz für „${p.name}“`,
        subtitle: 'Wird nach jedem Anwenden dieses Profils gesetzt.',
        content: [group, h('p.hint', 'Den Schreibschutz kannst du jederzeit unter „Gefundene Dateien“ wieder aufheben. Tastenbelegung und Sensi kommen immer aus der Epic-Cloud deines Kontos – dort hilft Schreibschutz nicht.')],
        actions: [{ label: 'Abbrechen', value: null }, { label: 'Speichern', value: 'save', variant: 'primary' }],
      });
      if (r !== 'save') return;
      const readOnly = roValue(sel);
      try { await env.call('profiles.options', { id: p.id, options: { readOnly } }); ui.toast('Gespeichert.'); renderAll(); } catch (e) { ui.showError(e); }
    }

    async function showDiff(kind, id, name) {
      let d;
      try { d = await env.call(kind === 'backup' ? 'backups.diff' : 'profiles.diff', { id }); } catch (e) { ui.showError(e); return; }
      const STATUS = { same: ['gleich', 'ok'], 'same-values': ['gleiche Werte', 'ok'], different: ['anders', 'warn'], missing: ['fehlt gerade', 'err'] };
      const blocks = d.files.map((f) => {
        const [t, c] = STATUS[f.status] || [f.status, ''];
        return h('div.diff-file', h('div.diff-head', icon('file', 16), h('div.grow', h('strong', f.label || f.rel), h('span.hint.mono', ui.displayPath(f.rel))), ui.badge(t, c)),
          f.changes?.length ? h('table.diff-table', h('thead', h('tr', h('th', 'Einstellung'), h('th', 'Jetzt'), h('th', kind === 'backup' ? 'In der Sicherung' : 'Im Profil'))),
            h('tbody', f.changes.map((c) => h('tr', h('td.mono', `${c.key}`, h('span.hint', ` [${c.section}]`)), h('td.mono', c.current ?? '–'), h('td.mono.accent-text', c.saved ?? '–'))))) : null);
      });
      await ui.modal({ title: `Vergleich: ${name}`, subtitle: 'Aktueller Stand auf diesem PC gegenüber dem gespeicherten Stand', wide: true, content: blocks, actions: [{ label: 'Schließen', variant: 'primary' }] });
    }

    // ---------------- Gefundene Dateien ----------------
    async function renderFiles() {
      let sc;
      try { sc = await env.call('core.scan'); } catch (e) {
        return [ui.emptyState({ title: 'Keine Dateien gefunden', text: e.message })];
      }
      const head = h('div.toolbar',
        ui.button('Neu einlesen', { iconName: 'refresh', onClick: renderAll }),
        ui.button('Schreibschutz überall aufheben', {
          iconName: 'unlock',
          onClick: async () => {
            try { const r = await env.call('core.readOnlyClearAll'); ui.toast(r.cleared.length ? `Schreibschutz bei ${r.cleared.length} Dateien aufgehoben.` : 'Keine Datei war schreibgeschützt.'); renderAll(); } catch (e) { ui.showError(e); }
          },
        }),
        ui.button('Ordner öffnen', { iconName: 'folder', onClick: () => env.call('core.openFolder', { which: 'config' }).catch(ui.showError) }),
        h('span.grow'),
        h('p.hint', `${sc.totals.included} von ${sc.totals.found} Dateien kommen ins Profil · ${ui.fmtBytes(sc.totals.bytes)}`));
      const rows = sc.files.map((f) => h(`tr${f.included ? '' : '.excluded'}`,
        h('td', h('div.file-cell', icon('file', 16), h('div', h('span', f.label), h('span.hint.mono', ui.displayPath((f.root === 'saved' ? 'Saved/' : 'Config/') + f.rel))))),
        h('td.num', ui.fmtBytes(f.size)),
        h('td', ui.fmtDate(f.mtimeMs)),
        h('td', f.included ? ui.badge('wird gesichert', 'ok') : ui.badge(f.reason || 'ausgeschlossen', '')),
        h('td', f.protectedParts ? ui.badge(`${f.protectedParts} geschützte Einträge`, 'accent') : null),
        h('td', h('button.lock-btn', {
          type: 'button',
          title: f.readOnly ? 'Schreibschutz aufheben' : 'Schreibschutz setzen',
          'aria-label': f.readOnly ? 'Schreibschutz aufheben' : 'Schreibschutz setzen',
          onclick: async () => {
            try { await env.call('core.readOnlySet', { root: f.root, rel: f.rel, on: !f.readOnly }); renderAll(); } catch (e) { ui.showError(e); }
          },
        }, icon(f.readOnly ? 'lock' : 'unlock', 16), h('span', f.readOnly ? 'geschützt' : 'offen')))));
      const table = h('table.table', h('thead', h('tr', h('th', 'Datei'), h('th', 'Größe'), h('th', 'Geändert'), h('th', 'Profil'), h('th', 'Login-Schutz'), h('th', 'Schreibschutz'))), h('tbody', rows));
      return [head,
        h('p.hint', 'HELIX liest den kompletten Ordner „FortniteGame\\Saved\\Config“ mit allen Unterordnern. Login-Daten, Browser-Daten und Protokolle werden nie gesichert. Geschützte Einträge (z. B. Anmeldedaten) werden beim Speichern entfernt und beim Anwenden vom gerade eingeloggten Konto übernommen.'),
        h('div.table-wrap', table)];
    }

    // ---------------- Zeitmaschine ----------------
    async function renderBackups() {
      const list = await env.call('backups.list').catch((e) => { ui.showError(e); return []; });
      const head = h('div.toolbar',
        ui.button('Jetzt sichern', {
          iconName: 'shield', variant: 'primary',
          onClick: async () => {
            const label = await ui.promptDialog({ title: 'Sicherung anlegen', label: 'Bezeichnung', value: 'Manuelle Sicherung', maxLength: 80, confirmLabel: 'Sichern' });
            if (!label) return;
            try { await env.call('backups.create', { label }); ui.toast('Sicherung angelegt.'); renderAll(); } catch (e) { ui.showError(e); }
          },
        }),
        ui.button('Ordner öffnen', { iconName: 'folder', onClick: () => env.call('core.openFolder', { which: 'backups' }).catch(ui.showError) }),
        h('span.grow'),
        h('p.hint', 'Vor jedem Anwenden sichert HELIX automatisch. Die letzten 40 Sicherungen bleiben, angeheftete und der Originalzustand immer.'));
      if (!list.length) return [head, ui.emptyState({ title: 'Noch keine Sicherung', text: 'Sobald du ein Profil anwendest, entsteht hier automatisch eine Sicherung.' })];
      const REASON = { original: 'Originalzustand', 'vor-anwenden': 'Vor dem Anwenden', 'vor-wiederherstellen': 'Vor dem Wiederherstellen', manuell: 'Manuell', tool: 'Vor Tool-Änderung' };
      const items = list.map((b) => h('li.backup-item.glass',
        h('div.grow', h('strong', b.label || REASON[b.reason] || b.reason), h('p.hint', `${ui.fmtDate(b.createdAt)} · ${b.fileCount} Dateien · ${ui.fmtBytes(b.bytes)}`)),
        b.reason === 'original' ? ui.badge('Original', 'accent') : b.pinned ? ui.badge('angeheftet', 'accent') : ui.badge(REASON[b.reason] || b.reason, ''),
        ui.button('Vergleichen', { small: true, iconName: 'eye', onClick: () => showDiff('backup', b.id, b.label) }),
        ui.button('Wiederherstellen', {
          small: true, iconName: 'refresh', variant: 'primary',
          onClick: async () => {
            const ok = await ui.confirmDialog({ title: 'Sicherung wiederherstellen?', text: `Der Fortnite-Ordner wird auf den Stand „${b.label}“ vom ${ui.fmtDate(b.createdAt)} zurückgesetzt. Der jetzige Stand wird vorher gesichert.`, confirmLabel: 'Wiederherstellen' });
            if (!ok) return;
            try {
              const r = await env.call('backups.restore', { id: b.id });
              if (r.ok) ui.toast(`Wiederhergestellt: ${r.written.length} Dateien zurückgeholt.`);
              else ui.toast('Wiederherstellen nicht vollständig.', 'warn');
              env.refreshStatus(); renderAll();
            } catch (e) { ui.showError(e); }
          },
        }),
        b.reason === 'original' ? null : ui.button('', { small: true, variant: 'ghost', iconName: 'pin', title: b.pinned ? 'Nicht mehr anheften' : 'Anheften (wird nie automatisch gelöscht)', onClick: async () => { await env.call('backups.pin', { id: b.id, pinned: !b.pinned }).catch(ui.showError); renderAll(); } }),
        b.reason === 'original' ? null : ui.button('', {
          small: true, variant: 'ghost', iconName: 'trash', title: 'Löschen',
          onClick: async () => {
            if (!(await ui.confirmDialog({ title: 'Sicherung löschen?', text: b.label, confirmLabel: 'Löschen', danger: true }))) return;
            await env.call('backups.remove', { id: b.id }).catch(ui.showError); renderAll();
          },
        })));
      return [head, h('ul.backup-list', items)];
    }

    async function renderBody() {
      const loading = h('div.loading', ui.spinner());
      ui.mount(body, loading);
      const nodes = tab === 'files' ? await renderFiles() : tab === 'backups' ? await renderBackups() : await renderProfiles();
      ui.mount(body, nodes);
    }

    async function renderAll() {
      await Promise.all([renderStatusLine(), renderBody()]);
    }

    const onApplyReq = (e) => applyFlow(env, e.detail.id, { onDone: renderAll });
    window.addEventListener('helix:apply', onApplyReq);
    const offApplied = env.on('profiles.applied', () => renderAll());
    cleanup = [() => window.removeEventListener('helix:apply', onApplyReq), offApplied];

    renderTabs();
    await renderAll();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
