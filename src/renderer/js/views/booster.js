// Spiel-Booster: schließt die Hintergrundprogramme aus deiner Liste mit einem Klick und startet sie danach wieder.

import { statusOf, reportHeadline, reportSections, triggerText, filterProcesses, sinceText, processHint } from '../lib/booster-view.mjs';

let cleanup = [];

export default {
  async mount(root, env) {
    const { h, icon } = env.ui;
    const ui = env.ui;

    let info = null;
    let alive = true;

    const platformBox = h('div');
    const hero = h('section.block.boost-hero');
    const listBox = h('div');
    const optionsBox = h('div');
    const reportBox = h('div');
    root.append(platformBox, hero, listBox, optionsBox, reportBox);

    async function load() {
      info = await env.call('booster.info');
    }

    try {
      await load();
    } catch (e) {
      ui.mount(root, ui.emptyState({ title: 'Der Spiel-Booster konnte nicht starten', text: e.message || String(e) }));
      return;
    }

    const offState = env.on('booster.state', async () => {
      if (!alive) return;
      try { await load(); renderAll(); } catch { /* nächster Versuch */ }
    });
    const timer = setInterval(() => { if (info?.active) renderHero(); }, 30000);
    cleanup.push(offState, () => clearInterval(timer), () => { alive = false; });

    async function refresh() {
      try { await load(); } catch (e) { ui.showError(e); }
      if (alive) renderAll();
    }

    // ---------- Aktionen ----------
    async function boost() {
      if (!info.list.length && !info.options.powerPlan) {
        ui.toast('Deine Liste ist noch leer. Füge zuerst Programme hinzu.', 'warn');
        return;
      }
      try {
        const r = await env.call('booster.boost');
        await refresh();
        const rep = r.report;
        const closed = rep.closed.length;
        if (rep.stillOpen.length) ui.toast(`${closed} geschlossen, ${rep.stillOpen.length} noch offen: ${rep.stillOpen.join(', ')}.`, 'warn', { timeout: 6500 });
        else if (closed) ui.toast(`Boost aktiv: ${closed} ${closed === 1 ? 'Programm' : 'Programme'} geschlossen.`);
        else ui.toast(rep.powerPlan?.changed ? 'Boost aktiv: Energieplan umgestellt. Keines deiner Programme lief gerade.' : 'Keines deiner Programme lief gerade – es gab nichts zu schließen.', 'info');
        env.refreshStatus?.();
      } catch (e) {
        if (e.code === 'NOT_WINDOWS') ui.toast(e.message, 'warn'); else ui.showError(e, 'Boost nicht möglich');
        refresh();
      }
    }

    async function restore() {
      try {
        const r = await env.call('booster.restore');
        await refresh();
        if (r.nothing) { ui.toast('Es war kein Boost aktiv.', 'info'); return; }
        const rep = r.report;
        if (rep.failed.length) ui.toast(`${rep.restarted.length} wieder gestartet. Nicht geklappt: ${rep.failed.map((f) => f.display).join(', ')}.`, 'warn', { timeout: 7000 });
        else ui.toast(rep.restarted.length ? `Wiederhergestellt: ${rep.restarted.join(', ')}.` : 'Wiederhergestellt. Es musste nichts neu gestartet werden.');
      } catch (e) {
        if (e.code === 'NOT_WINDOWS') ui.toast(e.message, 'warn'); else ui.showError(e, 'Wiederherstellen nicht möglich');
        refresh();
      }
    }

    async function forceClose(names) {
      const ok = await ui.confirmDialog({
        title: 'Sofort beenden?',
        text: `Das beendet ${names.join(', ')} sofort – wie „Task beenden“ im Task-Manager. Was darin nicht gespeichert ist, geht dabei verloren. Nach dem Spielen startet „Wiederherstellen“ alles wieder.`,
        confirmLabel: 'Sofort beenden',
        danger: true,
      });
      if (!ok) { ui.toast('Nichts beendet.', 'info'); return; }
      try {
        const r = await env.call('booster.forceClose', { names: info.active.apps.filter((a) => a.status === 'open').map((a) => a.name), confirm: true });
        await refresh();
        if (r.report.stillOpen.length) ui.toast(`Weiter offen: ${r.report.stillOpen.join(', ')}. Vielleicht braucht das Programm Administrator-Rechte.`, 'warn', { timeout: 7000 });
        else ui.toast(r.report.forced.length ? `Sofort beendet: ${r.report.forced.join(', ')}.` : 'Es war nichts mehr offen.');
      } catch (e) { ui.showError(e); }
    }

    async function addProgram(name, display, path) {
      const tryAdd = (confirm) => env.call('booster.add', { name, display, path, confirm });
      try {
        let r;
        try {
          r = await tryAdd(false);
        } catch (e) {
          if (e.code !== 'CONFIRM_NEEDED') throw e;
          const ok = await ui.confirmDialog({
            title: `${display} wirklich in die Liste?`,
            text: `${e.message} Willst du es trotzdem beim Boost schließen?`,
            confirmLabel: 'Trotzdem aufnehmen',
          });
          if (!ok) { ui.toast(`${display} bleibt offen.`, 'info'); return false; }
          r = await tryAdd(true);
        }
        info = r.info;
        if (alive) renderAll();
        ui.toast(r.already ? `${display} steht schon in deiner Liste.` : `${display} steht jetzt in deiner Liste.`, r.already ? 'info' : 'ok');
        return true;
      } catch (e) {
        if (e.code === 'PROTECTED') ui.toast(e.message, 'warn', { timeout: 7000 });
        else ui.showError(e);
        return false;
      }
    }

    async function addManual() {
      const name = await ui.promptDialog({
        title: 'Programm von Hand eintragen',
        label: 'Name der Programmdatei',
        hint: 'So wie im Task-Manager unter „Details“ – zum Beispiel „Discord.exe“ oder „Spotify.exe“. Groß- und Kleinschreibung ist egal.',
        confirmLabel: 'Aufnehmen',
        maxLength: 100,
      });
      if (!name) return;
      await addProgram(name, name.replace(/\.exe$/i, ''), null);
    }

    async function removeProgram(e) {
      try {
        const r = await env.call('booster.remove', { name: e.name });
        info = r.info;
        renderAll();
        ui.toast(`${e.display} ist nicht mehr in deiner Liste.`);
      } catch (err) { ui.showError(err); }
    }

    async function setOption(key, value) {
      try {
        const r = await env.call('booster.setOptions', { [key]: value });
        info.options = r.options;
        renderOptions();
        if (key === 'powerPlan') ui.toast(value ? 'Beim nächsten Boost stellt HELIX den Energieplan auf „Höchstleistung“.' : 'Der Energieplan bleibt beim Boost, wie er ist.');
        else ui.toast(value ? 'Automatik an: Der Boost startet, sobald Fortnite läuft.' : 'Automatik aus: Du startest den Boost selbst.');
      } catch (e) { ui.showError(e); renderOptions(); }
    }

    // ---------- Auswahl aus laufenden Programmen ----------
    async function openPicker() {
      let procs = [];
      const search = h('input.input', { type: 'search', placeholder: 'Suchen, z. B. Discord', 'aria-label': 'Programme durchsuchen' });
      const listEl = h('ul.boost-picker-list');
      const body = h('div.boost-picker', { dataset: { tool: 'booster' } },
        h('p.hint', 'Das sind die Programme, die gerade auf deinem PC laufen. Teile von Windows werden gar nicht angezeigt. Geschützte Programme kannst du nicht auswählen.'),
        search, listEl);

      const renderList = () => {
        const shown = filterProcesses(procs, search.value);
        if (!procs.length) { ui.mount(listEl, h('li.boost-picker-empty', ui.spinner(), h('span.hint', 'Programme werden gelesen …'))); return; }
        if (!shown.length) { ui.mount(listEl, h('li.boost-picker-empty', h('span.hint', 'Kein laufendes Programm passt zu deiner Suche. Du kannst es auch von Hand eintragen.'))); return; }
        ui.mount(listEl, shown.map((p) => {
          const blocked = p.protect?.level === 'block';
          const warn = p.protect?.level === 'warn';
          const btn = p.inList
            ? ui.badge('in deiner Liste', 'ok')
            : blocked
              ? ui.badge('geschützt', '')
              : ui.button('Aufnehmen', {
                small: true, iconName: 'plus',
                onClick: async () => {
                  const ok = await addProgram(p.name, p.description || p.display, p.path);
                  if (ok) { p.inList = true; renderList(); }
                },
              });
          return h(`li${blocked ? '.blocked' : ''}`,
            h('div.grow',
              h('span.boost-pname', p.description || p.display),
              h('span.hint', processHint(p)),
              blocked || warn ? h('span.hint.boost-reason', icon(blocked ? 'lock' : 'warn', 14), ' ', p.protect.reason) : null),
            warn ? ui.badge('Treiber-Helfer', 'warn') : null,
            btn);
        }));
      };
      search.addEventListener('input', renderList);
      renderList();
      const loading = env.call('booster.running').then((r) => {
        if (r.unsupported) { ui.mount(listEl, h('li.boost-picker-empty', h('span.hint', 'Die Programmliste gibt es nur unter Windows.'))); return; }
        procs = r.processes;
        if (!procs.length) { ui.mount(listEl, h('li.boost-picker-empty', h('span.hint', 'Es wurden keine passenden Programme gefunden.'))); return; }
        renderList();
      }).catch((e) => { ui.mount(listEl, h('li.boost-picker-empty', h('span.hint', `Die Programme konnten nicht gelesen werden: ${e.message}`))); });
      await ui.modal({ title: 'Aus laufenden Programmen wählen', subtitle: 'Größte Programme mit offenem Fenster stehen oben.', content: body, wide: true, actions: [{ label: 'Fertig', variant: 'primary' }] });
      await loading.catch(() => {});
      if (alive) refresh();
    }

    // ---------- Darstellung ----------
    function renderPlatform() {
      ui.clear(platformBox);
      if (info.supported) return;
      platformBox.append(h('div.callout.info', icon('info'), h('div',
        h('strong', 'Der Booster arbeitet nur unter Windows'),
        h('p.hint', 'Programme schließen und wieder starten geht nur auf deinem Windows-PC. Deine Liste kannst du hier trotzdem schon vorbereiten.'))));
    }

    function renderHero() {
      const act = info.active;
      const closed = act ? act.apps.filter((a) => a.status !== 'open').length : 0;
      const open = act ? act.apps.filter((a) => a.status === 'open') : [];
      const busyNow = !!info.busy;
      ui.mount(hero,
        h('div.boost-hero-row',
          h(`div.boost-orb${act ? '.on' : ''}`, { 'aria-hidden': 'true' }, icon('power', 28)),
          h('div.grow',
            h('div.boost-state', h('h3', act ? 'Boost aktiv' : 'Boost aus'), ui.badge(act ? 'aktiv' : 'aus', act ? 'accent' : '')),
            h('p.hint', act
              ? `${sinceText(act.startedAt)} · ${triggerText(act.trigger)} · ${closed} ${closed === 1 ? 'Programm' : 'Programme'} geschlossen${act.powerPlan ? ` · Energieplan „${act.powerPlan.setName}“` : ''}`
              : 'Schließt die Programme aus deiner Liste ganz normal – wie mit dem X am Fenster. Nach dem Spielen startet „Wiederherstellen“ sie wieder.')),
          h('div.boost-actions',
            ui.button(act ? 'Erneut boosten' : 'Boost starten', { variant: act ? '' : 'primary', iconName: 'play', disabled: !info.supported || busyNow, onClick: boost }),
            ui.button('Wiederherstellen', { variant: act ? 'primary' : '', iconName: 'refresh', disabled: !info.supported || !act || busyNow, onClick: restore }))),
        open.length ? h('div.callout.warn', icon('warn'), h('div.grow',
          h('strong', `Noch offen: ${open.map((a) => a.display).join(', ')}`),
          h('p.hint', 'Manche Programme verstecken sich beim Schließen nur im Infobereich (unten rechts neben der Uhr). Du kannst sie dort selbst beenden – oder hier sofort beenden.'),
          h('div.row', ui.button('Sofort beenden …', { variant: 'danger', small: true, iconName: 'stop', onClick: () => forceClose(open.map((a) => a.display)) })))) : null);
    }

    function renderList() {
      const head = h('div.toolbar',
        h('div.grow', h('h3', 'Deine Liste'), h('p.hint', 'Diese Programme schließt der Boost. Windows, Virenschutz, Anti-Cheat, Fortnite, der Epic Games Launcher und HELIX selbst sind geschützt und werden nie geschlossen.')),
        ui.button('Aus laufenden Programmen wählen', { iconName: 'plus', variant: info.list.length ? '' : 'primary', disabled: !info.supported, onClick: openPicker }),
        ui.button('Von Hand eintragen', { iconName: 'edit', variant: 'ghost', onClick: addManual }));
      if (!info.list.length) {
        ui.mount(listBox, h('section.block', head, ui.emptyState({
          title: 'Noch keine Programme in deiner Liste',
          text: 'Typisch sind Programme, die nebenbei Leistung oder Internet brauchen: Browser, Discord, Spotify, Steam, OneDrive oder Updater. Wähle sie aus den laufenden Programmen aus.',
          action: info.supported ? ui.button('Aus laufenden Programmen wählen', { variant: 'primary', iconName: 'plus', onClick: openPicker }) : null,
        })));
        return;
      }
      ui.mount(listBox, h('section.block', head,
        h('ul.list.boost-list', info.list.map((e) => {
          const s = statusOf(e);
          return h('li',
            h('span.boost-dot', { dataset: { s: s.type || 'none' }, 'aria-hidden': 'true' }),
            h('div.grow',
              h('span.boost-pname', e.display),
              h('span.hint', e.protect?.level === 'warn' ? `${e.name}.exe · Achtung: ${e.protect.reason}` : `${e.name}.exe`)),
            e.protect?.level === 'warn' ? ui.badge('Treiber-Helfer', 'warn') : null,
            ui.badge(s.label, s.type),
            ui.button('', { iconName: 'trash', small: true, variant: 'ghost', title: `${e.display} aus der Liste nehmen`, onClick: () => removeProgram(e) }));
        }))));
    }

    function renderOptions() {
      const p = info.power;
      const planHint = !info.supported ? 'Gibt es nur unter Windows.'
        : !p ? 'Der aktuelle Energieplan konnte nicht gelesen werden.'
          : p.highAvailable ? `Gerade aktiv: „${p.active}“.`
            : `„Höchstleistung“ gibt es auf diesem PC nicht (bei vielen Laptops ausgeblendet). Dann ändert der Schalter nichts. Gerade aktiv: „${p.active}“.`;
      ui.mount(optionsBox, h('section.block',
        h('div.block-head', h('h3', 'Optionen'), h('p.hint', 'Gelten für jeden Boost – egal ob per Klick oder automatisch.')),
        ui.toggle({
          label: 'Energieplan „Höchstleistung“ während des Boosts',
          hint: `Der Energieplan sagt Windows, ob es Strom sparen oder volle Leistung geben soll. HELIX stellt auf „Höchstleistung“ und danach zurück auf deinen alten Plan. Am Laptop leert sich der Akku schneller. ${planHint}`,
          checked: info.options.powerPlan,
          onChange: (v) => setOption('powerPlan', v),
        }),
        ui.toggle({
          label: 'Automatisch boosten, wenn Fortnite startet',
          hint: 'Sobald Fortnite läuft, schließt HELIX deine Liste von selbst. Wenn du Fortnite beendest, startet HELIX die Programme wieder. HELIX muss dafür geöffnet sein (es darf im Hintergrund laufen). Ab Werk aus.',
          checked: info.options.auto,
          onChange: (v) => setOption('auto', v),
        })));
    }

    function renderReport() {
      const r = info.lastReport;
      if (!r) {
        ui.mount(reportBox, h('section.block', h('div.block-head', h('h3', 'Letzter Boost')), h('p.hint', 'Noch kein Boost. Nach dem ersten Boost siehst du hier, was geschlossen und wieder gestartet wurde.')));
        return;
      }
      const secs = reportSections(r);
      ui.mount(reportBox, h('section.block',
        h('div.block-head', h('h3', r.kind === 'restore' ? 'Letztes Wiederherstellen' : 'Letzter Boost'),
          h('p.hint', `${ui.fmtDate(r.at)} · ${triggerText(r.trigger)}`)),
        h('p.boost-headline', reportHeadline(r)),
        secs.length ? h('dl.kv.boost-report', secs.map((s) => [h('dt', s.title), h('dd', s.type ? ui.badge(String(s.items.length), s.type) : null, ' ', s.items.join(', '))])) : null,
        r.powerPlan?.text ? h('p.hint', icon(r.powerPlan.error ? 'warn' : 'power', 14), ' ', r.powerPlan.text) : null));
    }

    function renderAll() {
      renderPlatform();
      renderHero();
      renderList();
      renderOptions();
      renderReport();
    }

    renderAll();
  },
  unmount() {
    for (const f of cleanup) { try { f(); } catch { /* egal */ } }
    cleanup = [];
  },
};
