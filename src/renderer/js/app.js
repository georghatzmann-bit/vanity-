// Startet die Oberfläche: Seitenleiste, Wechsel zwischen den Bereichen, Begrüßung beim ersten Start.
(function () {
  'use strict';
  const { el, icon, clear, toast, confirmDialog } = window.UI;

  const ORDER = ['recovery', 'pdf', 'data', 'support', 'discord'];
  let current = null;

  function views() {
    return ORDER.map((id) => window.Views[id]).filter(Boolean);
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    clear(nav);
    for (const v of views()) {
      const badge = v.badge ? v.badge() : null;
      nav.appendChild(el('button', {
        class: 'nav-item' + (current === v.id ? ' active' : ''),
        type: 'button',
        'aria-current': current === v.id ? 'page' : null,
        title: v.label,
        onclick: () => go(v.id),
      }, [
        icon(v.icon),
        el('span', { class: 'nav-text' }, [el('span', { class: 'nav-label', text: v.label }), el('span', { class: 'nav-hint', text: v.hint })]),
        badge ? el('span', { class: 'nav-badge' + (badge.done ? ' done' : ''), text: badge.text }) : null,
      ]));
    }
  }

  function renderFoot(info) {
    const foot = document.getElementById('sidebar-foot');
    clear(foot);
    foot.appendChild(el('div', { class: 'row' }, [icon('lock', 'icon-sm'), el('span', {
      text: info && info.encrypted ? 'Deine Daten bleiben verschlüsselt auf diesem PC.' : 'Deine Daten bleiben auf diesem PC.',
    })]));
    foot.appendChild(el('div', { text: 'Kein offizielles Programm von Epic Games oder Discord.' }));
    if (info) foot.appendChild(el('div', { text: 'Version ' + info.version }));
  }

  function go(id) {
    const view = window.Views[id];
    if (!view) return;
    if (current && window.Views[current] && window.Views[current].unmount) window.Views[current].unmount();
    current = id;
    window.Store.update((s) => { s.ui.view = id; }, 'nav');
    const main = document.getElementById('main');
    clear(main);
    main.scrollTop = 0;
    view.mount(main);
    renderNav();
    main.focus({ preventScroll: true });
  }

  async function welcome() {
    const body = el('div', { class: 'stack' }, [
      el('p', { class: 'muted', text: 'Der Konto-Retter führt dich Schritt für Schritt durch die Rettung deines gehackten Epic-Kontos.' }),
      el('ol', { class: 'todo-list' }, [
        el('li', { text: 'Zieh unter "PDF auslesen" deine Epic-Konto-PDF oder Kaufbelege hinein. Die Daten werden automatisch erkannt.' }),
        el('li', { text: 'Geh unter "Konto retten" die Schritte durch. Jede Epic-Seite öffnet sich automatisch, die nötigen Daten kopierst du mit einem Klick.' }),
        el('li', { text: 'Brauchst du den Support? Unter "Support-Text" liegt ein fertiger Text auf Deutsch und Englisch.' }),
      ]),
      window.UI.callout('info', 'Deine Daten bleiben bei dir', 'Alles wird nur auf diesem PC gespeichert. Der Konto-Retter schickt nichts ins Internet und ist kein offizielles Programm von Epic Games.'),
    ]);
    await confirmDialog({ title: 'Willkommen beim Konto-Retter', body, confirmText: 'Los geht\'s', cancelText: null });
    window.Store.update((s) => { s.ui.welcomeSeen = true; }, 'welcome');
  }

  // Gespeicherte Daten ließen sich nicht öffnen: klar sagen, was passiert ist und dass nichts gelöscht wurde
  function storeProblemNotice(problem) {
    if (problem.kind === 'restored-backup') {
      toast('Der letzte Speicherstand war beschädigt. Die vorherige Sicherung wurde geladen.', 'warning');
      return Promise.resolve();
    }
    const kept = problem.kept && problem.kept.length ? problem.kept : [];
    return confirmDialog({
      title: 'Gespeicherte Daten ließen sich nicht öffnen',
      body: el('div', { class: 'stack-sm' }, [
        el('p', { class: 'muted', text: 'Das passiert zum Beispiel, wenn das Windows-Passwort zurückgesetzt wurde oder die Daten von einem anderen PC stammen. Deshalb startet der Konto-Retter leer.' }),
        el('p', { class: 'muted', text: kept.length ? 'Nichts wurde gelöscht. Die alte Datei wurde aufbewahrt:' : 'Die alte Datei wurde nicht verändert.' }),
        ...kept.map((k) => el('div', { class: 'url mono hint', text: k })),
      ]),
      confirmText: 'Verstanden',
      cancelText: null,
    });
  }

  async function boot() {
    let info = null;
    try {
      await window.Store.load();
      const res = await window.kr.appInfo();
      if (res && res.ok) info = res.value;
    } catch (err) {
      document.getElementById('main').appendChild(el('div', { class: 'page' }, window.UI.callout('danger', 'Start fehlgeschlagen', err.message)));
      return;
    }
    renderFoot(info);
    // Seitenleiste aktuell halten (z. B. Zähler), egal wo etwas geändert wurde
    window.Store.subscribe(() => renderNav());
    const s = window.Store.get();
    go(ORDER.includes(s.ui.view) ? s.ui.view : 'recovery');
    if (info && info.storeProblem) await storeProblemNotice(info.storeProblem);
    if (!s.ui.welcomeSeen) welcome();
  }

  window.App = { go, toast };
  document.addEventListener('DOMContentLoaded', boot);
})();
