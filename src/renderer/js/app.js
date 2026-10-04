// Startet die Oberfläche: Tabs oben, Wechsel zwischen den Bereichen, Effekte, Begrüßung beim ersten Start.
(function () {
  'use strict';
  const { el, icon, clear, toast, confirmDialog } = window.UI;

  const ORDER = ['recovery', 'pdf', 'data', 'support', 'discord'];
  // Diese Flächen neigen sich in 3D zur Maus hin
  const TILT = '.big-action, .data-tile, .drop, .finish';
  let current = null;
  let appInfo = null;
  const navButtons = {};

  function views() {
    return ORDER.map((id) => window.Views[id]).filter(Boolean);
  }

  function fx() {
    return window.FX || null;
  }

  // ---------- Tabs ----------

  // Baut die Tabs einmal und aktualisiert danach nur noch Markierung und Zähler.
  // So bleibt der gleitende Balken unter dem aktiven Tab erhalten.
  function renderNav() {
    const nav = document.getElementById('nav');
    for (const v of views()) {
      let btn = navButtons[v.id];
      if (!btn) {
        btn = el('button', { class: 'nav-item', type: 'button', title: v.label + ' – ' + v.hint, onclick: () => go(v.id) }, [
          icon(v.icon),
          el('span', { class: 'nav-text' }, [el('span', { class: 'nav-label', text: v.label }), el('span', { class: 'nav-hint', text: v.hint })]),
        ]);
        navButtons[v.id] = btn;
        nav.appendChild(btn);
      }
      const active = current === v.id;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');

      const badge = v.badge ? v.badge() : null;
      let badgeEl = btn.querySelector('.nav-badge');
      if (badge) {
        if (!badgeEl) {
          badgeEl = el('span', { class: 'nav-badge' });
          btn.appendChild(badgeEl);
        }
        if (badgeEl.textContent !== badge.text) badgeEl.textContent = badge.text;
        badgeEl.classList.toggle('done', Boolean(badge.done));
      } else if (badgeEl) {
        badgeEl.remove();
      }
    }
    placeIndicator(false);
  }

  // Schiebt den leuchtenden Balken unter den aktiven Tab
  function placeIndicator(instant) {
    const bar = document.getElementById('nav-indicator');
    const btn = current && navButtons[current];
    if (!bar || !btn) return;
    const x = btn.offsetLeft;
    const w = btn.offsetWidth;
    const first = !bar.classList.contains('ready');
    if (instant || first) bar.classList.add('instant');
    bar.style.setProperty('--ni-x', x + 'px');
    bar.style.setProperty('--ni-w', w + 'px');
    if (instant || first) {
      // Erst nach dem Zeichnen wieder weich gleiten lassen
      void bar.offsetWidth;
      bar.classList.remove('instant');
    }
    bar.classList.add('ready');
  }

  // ---------- Leiste rechts oben ----------

  function effectsOn() {
    const f = fx();
    return Boolean(f && f.enabled());
  }

  function renderTopbarRight() {
    const right = document.getElementById('topbar-right');
    clear(right);
    const encrypted = Boolean(appInfo && appInfo.encrypted);
    right.appendChild(el('span', {
      class: 'chip',
      title: encrypted ? 'Deine Daten bleiben verschlüsselt auf diesem PC.' : 'Deine Daten bleiben auf diesem PC.',
    }, [
      icon('lock', 'icon-sm'),
      el('span', { class: 'chip-text', text: encrypted ? 'Verschlüsselt' : 'Nur auf diesem PC' }),
    ]));
    if (fx()) {
      const on = effectsOn();
      right.appendChild(el('button', {
        class: 'icon-btn',
        type: 'button',
        id: 'fx-toggle',
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': 'Effekte und Animationen',
        title: on ? 'Effekte ausschalten (ruhigere Darstellung)' : 'Effekte einschalten',
        onclick: toggleEffects,
      }, icon('sparkles')));
    }
  }

  function toggleEffects() {
    const f = fx();
    if (!f) return;
    const next = !f.enabled();
    f.setEnabled(next, { force: true });
    window.Store.update((s) => { s.ui.effects = next; }, 'effects');
    renderTopbarRight();
    const btn = document.getElementById('fx-toggle');
    if (btn) btn.focus({ preventScroll: true });
    toast(next ? 'Effekte sind an.' : 'Effekte sind aus. Die Darstellung ist jetzt ruhiger.', 'info');
  }

  // ---------- Seitenwechsel ----------

  function footer() {
    const encrypted = Boolean(appInfo && appInfo.encrypted);
    return el('footer', { class: 'app-foot' }, [
      el('span', { text: encrypted ? 'Deine Daten bleiben verschlüsselt auf diesem PC.' : 'Deine Daten bleiben auf diesem PC.' }),
      el('span', { text: 'Kein offizielles Programm von Epic Games oder Discord.' }),
      appInfo ? el('span', { text: 'Version ' + appInfo.version }) : null,
    ]);
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
    const host = el('div', { class: 'view' });
    main.appendChild(host);
    main.appendChild(footer());
    view.mount(host);
    renderNav();
    markTilt(main);
    const f = fx();
    if (f) {
      f.pageEnter(host);
      // Die 3D-Kugel im Hintergrund schaut kurz zum gewählten Tab
      const r = navButtons[id] && navButtons[id].getBoundingClientRect();
      if (r && r.width) f.focusPoint(r.left + r.width / 2, r.top + r.height / 2);
    }
    main.focus({ preventScroll: true });
  }

  function markTilt(root) {
    for (const node of root.querySelectorAll(TILT)) node.classList.add('fx-tilt');
  }

  // Ansichten zeichnen sich bei Änderungen neu: neue Flächen bekommen dann wieder den 3D-Effekt
  function watchTilt() {
    const main = document.getElementById('main');
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        markTilt(main);
      });
    }).observe(main, { childList: true, subtree: true });
  }

  // ---------- Start ----------

  async function welcome() {
    const body = el('div', { class: 'stack' }, [
      el('p', { class: 'muted', text: 'Der Konto-Retter führt dich Schritt für Schritt durch die Rettung deines gehackten Epic-Kontos.' }),
      el('ol', { class: 'todo-list' }, [
        el('li', { text: 'Zieh unter "PDF auslesen" deine Epic-Konto-PDF oder Kaufbelege hinein. Die Daten werden automatisch erkannt.' }),
        el('li', { text: 'Geh unter "Konto retten" die Schritte durch. Jede Epic-Seite öffnet sich automatisch, die nötigen Daten kopierst du mit einem Klick.' }),
        el('li', { text: 'Fremde Käufe oder andere Probleme? Unter "Support-Text" liegt ein fertiger Text für den Epic-Support auf Deutsch und Englisch.' }),
      ]),
      window.UI.callout('info', 'Deine Daten bleiben bei dir', 'Alles wird nur auf diesem PC gespeichert. Der Konto-Retter schickt nichts ins Internet und ist kein offizielles Programm von Epic Games.'),
      el('p', { class: 'hint', text: 'Zu viel Bewegung? Oben rechts schaltest du die Effekte mit einem Klick aus.' }),
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

  // Effekte starten. Ein Fehler hier darf das Programm nie aufhalten.
  function startEffects(enabled) {
    const f = fx();
    if (!f) return;
    try {
      f.init({ canvas: document.getElementById('fx-bg') });
      f.setEnabled(enabled);
    } catch (err) {
      console.warn('[fx] Effekte konnten nicht gestartet werden:', err && err.message);
    }
  }

  async function boot() {
    try {
      await window.Store.load();
      const res = await window.kr.appInfo();
      if (res && res.ok) appInfo = res.value;
    } catch (err) {
      document.getElementById('main').appendChild(el('div', { class: 'page' }, window.UI.callout('danger', 'Start fehlgeschlagen', err.message)));
      return;
    }
    const s = window.Store.get();
    startEffects(s.ui.effects !== false);
    renderTopbarRight();
    watchTilt();
    // Tabs aktuell halten (z. B. Zähler), egal wo etwas geändert wurde
    window.Store.subscribe((state, source) => {
      renderNav();
      if (source === 'reset' && fx()) {
        fx().setEnabled(state.ui.effects !== false);
        renderTopbarRight();
      }
    });
    // Fenstergröße oder Schrift ändert die Breite der Tabs: Balken sofort mitziehen
    const nav = document.getElementById('nav');
    if (window.ResizeObserver) new ResizeObserver(() => placeIndicator(true)).observe(nav);
    window.addEventListener('resize', () => placeIndicator(true));
    go(ORDER.includes(s.ui.view) ? s.ui.view : 'recovery');
    if (appInfo && appInfo.storeProblem) await storeProblemNotice(appInfo.storeProblem);
    if (!s.ui.welcomeSeen) welcome();
  }

  window.App = { go, toast };
  document.addEventListener('DOMContentLoaded', boot);
})();
