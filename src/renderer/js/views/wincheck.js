// Windows-Gaming-Check: Checkliste mit Status, Erklärung und sicheren Ein-Klick-Lösungen.

const STATUS = {
  good: ['gut', 'ok'],
  hint: ['Hinweis', 'accent'],
  change: ['ändern empfohlen', 'warn'],
  tip: ['Tipp', ''],
};

let cleanup = [];

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;
    let alive = true;
    let result = null;
    cleanup = [() => { alive = false; }];

    const top = h('div.wc-top');
    const body = h('div.wc-body');
    root.append(top, body);

    // ---------- Aktionen ----------
    async function openSettings(uri) {
      try {
        await env.call('app.openWindowsSettings', { uri });
        ui.toast('Windows-Einstellungen geöffnet.', 'info');
      } catch (e) { ui.showError(e, 'Windows-Einstellungen'); }
    }

    async function fix(it) {
      const f = it.fix;
      const text = f.confirm || f.note;
      if (text) {
        const ok = await ui.confirmDialog({ title: `${it.title}: ${f.label}?`, text, confirmLabel: f.label });
        if (!ok) return;
      }
      try {
        const r = await env.call('wincheck.fix', { id: it.id });
        if (!alive) return;
        ui.toast(r.message, r.changed ? 'ok' : 'info');
        show(r.result);
      } catch (e) { ui.showError(e); }
    }

    async function undo(it) {
      try {
        const r = await env.call('wincheck.undo', { id: it.id });
        if (!alive) return;
        ui.toast(r.message);
        show(r.result);
      } catch (e) { ui.showError(e, 'Rückgängig'); if (alive) load(); }
    }

    async function fixAll() {
      const ids = result?.safeFixes || [];
      const list = result.items.filter((i) => ids.includes(i.id));
      if (!list.length) { ui.toast('Nichts, was HELIX sicher selbst ändern kann.', 'info'); return; }
      const r = await ui.modal({
        title: 'Alles Empfohlene anwenden?',
        subtitle: 'Nur Einstellungen deines Benutzerkontos. Alles lässt sich einzeln rückgängig machen.',
        content: [
          h('ul.list.compact', list.map((i) => h('li', icon('check', 16), h('div.grow', h('strong', `${i.title}: ${i.fix.label}`), i.fix.note ? h('span.hint', i.fix.note) : null)))),
          h('p.hint', 'Wirkt ab dem nächsten Fortnite-Start.'),
        ],
        actions: [{ label: 'Abbrechen', value: null }, { label: 'Anwenden', value: 'go', variant: 'primary', icon: 'check' }],
      });
      if (r !== 'go') return;
      try {
        const res = await env.call('wincheck.fixAll');
        if (!alive) return;
        const n = res.applied.length;
        if (n) ui.toast(`${n === 1 ? '1 Einstellung' : `${n} Einstellungen`} geändert – wirkt ab dem nächsten Fortnite-Start.`);
        else if (!res.failed.length) ui.toast('Alles war schon richtig eingestellt.', 'info');
        if (res.failed.length) ui.toast(`Nicht geklappt: ${res.failed.map((f) => f.message).join(' ')}`, 'warn', { timeout: 7000 });
        show(res.result);
      } catch (e) { ui.showError(e); }
    }

    // ---------- Darstellung ----------
    function summaryBox(r) {
      const open = r.summary.open;
      const safe = r.safeFixes.length;
      return h(`div.callout.wc-summary.${open ? 'warn' : 'ok'}`, icon(open ? 'warn' : 'check'), h('div.grow',
        h('strong', r.summary.text),
        h('p.hint', open
          ? (safe ? `${safe === 1 ? 'Einen Punkt' : `${safe} Punkte`} kann HELIX sicher für dich ändern.` : 'Unten steht, was du in Windows ändern kannst.')
          : 'Windows ist fürs Spielen gut eingestellt.'),
        h('div.row',
          safe ? ui.button('Alles Empfohlene anwenden', { variant: 'primary', iconName: 'sparkle', onClick: fixAll }) : null,
          ui.button('Neu prüfen', { iconName: 'refresh', onClick: async () => { await load(); if (alive && result) ui.toast('Neu geprüft.', 'info'); } }),
          h('span.hint.wc-when', `Geprüft ${ui.fmtAgo(r.at)}`))));
    }

    function itemRow(it) {
      const [label, type] = STATUS[it.status] || [it.status, ''];
      const actions = [];
      if (it.fix && it.status !== 'good') {
        actions.push(ui.button(it.fix.label, { small: true, variant: it.status === 'change' ? 'primary' : '', iconName: 'check', onClick: () => fix(it) }));
      }
      for (const l of it.links || []) {
        actions.push(l.kind === 'tool'
          ? ui.button(l.label, { small: true, variant: 'ghost', iconName: 'chevron', onClick: () => env.nav.go(l.id) })
          : ui.button(l.label, { small: true, variant: 'ghost', iconName: 'settings', onClick: () => openSettings(l.uri) }));
      }
      if (it.undo) actions.push(ui.button('Rückgängig', { small: true, iconName: 'refresh', title: 'Den Zustand von vorher wiederherstellen', onClick: () => undo(it) }));
      return h(`li.wc-item.wc-s-${it.status}`, { dataset: { id: it.id, status: it.status } },
        h('div.wc-status', ui.badge(label, type)),
        h('div.wc-main',
          h('div.wc-title-row', h('strong', it.title), it.value ? h('span.wc-value', it.value) : null),
          h('p.hint', it.text),
          it.note ? h('p.hint.wc-note', icon('info', 14), h('span', it.note)) : null,
          it.undo ? h('p.hint.wc-undo', icon('clock', 14), h('span', `${it.undo.label} · ${ui.fmtAgo(it.undo.at)}`)) : null),
        h('div.wc-actions', actions));
    }

    function show(r) {
      result = r;
      if (!alive) return;
      ui.mount(top, summaryBox(r));
      const groups = (r.groups || []).map((g) => {
        const items = r.items.filter((i) => i.group === g.id);
        if (!items.length) return null;
        return ui.section(g.title, g.hint, h('ul.wc-list', items.map(itemRow)));
      });
      ui.mount(body, groups,
        h('div.wc-foot',
          h('p.hint.wc-foot-line', icon('shield', 14), h('span', 'HELIX ändert nur Benutzer-Einstellungen und den Energieplan.')),
          ui.more('So funktioniert es',
            'Keine Administrator-Rechte nötig. Fortnite und der Anti-Cheat bleiben unberührt.',
            'Was nur mit Administrator-Rechten geht, öffnet HELIX dir in den Windows-Einstellungen. Jede Änderung lässt sich mit „Rückgängig“ zurücknehmen.')));
    }

    async function load() {
      if (!result) {
        ui.clear(top);
        ui.mount(body, h('div.loading', h('div.wc-loading', ui.spinner(), h('span.hint', 'HELIX prüft Windows …'))));
      }
      let r;
      try {
        r = await env.call('wincheck.check');
      } catch (e) {
        if (!alive) return;
        ui.clear(top);
        ui.mount(body, ui.emptyState({
          title: 'Die Prüfung hat nicht geklappt',
          text: e.message || String(e),
          action: ui.button('Noch einmal versuchen', { variant: 'primary', iconName: 'refresh', onClick: () => { result = null; load(); } }),
        }));
        return;
      }
      if (!alive) return;
      if (r.unsupported) {
        result = null;
        ui.clear(top);
        ui.mount(body, ui.emptyState({
          title: 'Nur unter Windows',
          text: 'Öffne HELIX auf deinem Windows-PC, dann prüft der Check deine Einstellungen.',
        }));
        return;
      }
      show(r);
    }

    await load();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
