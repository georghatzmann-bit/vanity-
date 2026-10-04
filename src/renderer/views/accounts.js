// Ansicht "Konten": mit einem Klick zwischen deinen eigenen Epic-Konten im Launcher wechseln.
// Die Zugänge bleiben verschlüsselt auf diesem PC; diese Ansicht sieht nur Namen und E-Mail-Adressen.
(function () {
  'use strict';
  const { el, icon, clear, toast, confirmDialog, pageHead, callout, formatDate } = window.UI;

  let root = null;
  let status = null;
  let pending = null; // gerade laufende Aktion
  let timer = null;
  let mountId = 0;
  let refreshing = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const res = await window.kr.epicAccounts.status();
      if (res && res.ok) status = res.value;
    } finally {
      refreshing = false;
    }
    render();
  }

  async function act(name, fn) {
    if (pending) return;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    pending = name;
    render();
    try {
      const res = await fn();
      if (res && res.ok) toast(res.message || 'Erledigt.', 'success');
      else toast((res && res.message) || 'Das hat nicht geklappt.', 'error');
    } catch (err) {
      toast('Das hat nicht geklappt: ' + err.message, 'error');
    } finally {
      pending = null;
      await refresh();
      const again = root && focusKey ? root.querySelector('[data-fk="' + CSS.escape(focusKey) + '"]') : null;
      if (again) again.focus();
    }
  }

  // Fragt nach einem Namen für ein Konto. null = abgebrochen.
  async function askName(title, preset) {
    let text = preset || '';
    const input = el('input', { class: 'input', type: 'text', value: text, placeholder: 'z. B. Hauptkonto', 'aria-label': 'Name für dieses Konto', spellcheck: 'false' });
    input.addEventListener('input', () => { text = input.value; });
    const body = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: 'Name für dieses Konto' }),
      input,
      el('div', { class: 'field-hint', text: 'Nur für dich, damit du die Konten auseinanderhältst.' }),
    ]);
    const dialog = confirmDialog({ title, body, confirmText: 'Speichern' });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const yes = await dialog;
    return yes ? text.trim() : null;
  }

  async function saveCurrent() {
    if (!status || !status.supported) return;
    if (!status.remembered) {
      toast('Im Launcher ist gerade niemand mit "Angemeldet bleiben" angemeldet. Melde dich im Launcher an und setz den Haken bei "Angemeldet bleiben".', 'warning');
      return;
    }
    const name = await askName('Aktuelles Konto speichern', status.currentEmail);
    if (name === null) return;
    act('save', () => window.kr.epicAccounts.save(name));
  }

  async function switchTo(acc) {
    const yes = await confirmDialog({
      title: 'Zu "' + acc.label + '" wechseln?',
      text: 'Der Epic Games Launcher wird geschlossen und mit diesem Konto neu gestartet. Läuft gerade ein Spiel über den Launcher, speichere es vorher.',
      confirmText: 'Wechseln',
    });
    if (yes) act('switch-' + acc.id, () => window.kr.epicAccounts.switchTo(acc.id));
  }

  async function renameAccount(acc) {
    const name = await askName('Konto umbenennen', acc.label);
    if (name === null || !name || name === acc.label) return;
    act('rename-' + acc.id, () => window.kr.epicAccounts.rename(acc.id, name));
  }

  async function removeAccount(acc) {
    const yes = await confirmDialog({
      title: '"' + acc.label + '" entfernen?',
      text: 'Der gespeicherte Zugang wird von diesem PC gelöscht. Im Launcher ändert sich dadurch nichts – du kannst dich dort jederzeit wieder anmelden.',
      confirmText: 'Entfernen',
      danger: true,
    });
    if (yes) act('remove-' + acc.id, () => window.kr.epicAccounts.remove(acc.id));
  }

  // ---------- Darstellung ----------

  function statusCard() {
    if (!status) {
      return el('section', { class: 'card' }, el('div', { class: 'status-line' }, [el('span', { class: 'dot' }), 'Status wird geprüft …']));
    }
    if (!status.supported) {
      return el('section', { class: 'card stack-sm' }, [
        el('div', { class: 'status-line' }, [el('span', { class: 'dot warn' }), 'Nur unter Windows verfügbar']),
        el('p', { class: 'muted', text: 'Der Konten-Wechsel steuert den Epic Games Launcher über Windows und geht deshalb nur unter Windows.' }),
      ]);
    }
    if (!status.launcherInstalled) {
      return el('section', { class: 'card stack-sm' }, [
        el('div', { class: 'status-line' }, [el('span', { class: 'dot warn' }), 'Epic Games Launcher nicht gefunden']),
        el('p', { class: 'muted', text: 'Auf diesem PC wurde der Epic Games Launcher nicht gefunden. Installiere ihn und starte ihn einmal, dann klappt der Konten-Wechsel.' }),
      ]);
    }
    const lines = [
      el('div', { class: 'status-line' }, [
        el('span', { class: 'dot ' + (status.running ? 'on' : 'off') }),
        status.running ? 'Launcher läuft' : 'Launcher ist geschlossen',
      ]),
      el('div', { class: 'row' }, [
        status.remembered
          ? el('span', { class: 'badge badge-success' }, [icon('check', 'icon-sm'), 'Angemeldet bleiben: ' + (status.currentEmail || 'ein Konto')])
          : el('span', { class: 'badge badge-warning' }, [icon('warning', 'icon-sm'), 'Niemand mit "Angemeldet bleiben" angemeldet']),
      ]),
      status.problem ? callout('danger', 'Gespeicherte Konten nicht lesbar', status.problem) : null,
      el('p', { class: 'hint', text: status.encrypted
        ? 'Gespeicherte Zugänge liegen verschlüsselt auf diesem PC und funktionieren nur hier.'
        : 'Hinweis: Die Windows-Verschlüsselung ist auf diesem PC nicht verfügbar. Die Zugänge sind trotzdem an deinen Windows-Benutzer gebunden.' }),
    ];
    return el('section', { class: 'card stack-sm' }, lines);
  }

  function accountRow(acc) {
    const busy = Boolean(pending);
    return el('div', { class: 'account-item' + (acc.isCurrent ? ' current' : '') }, [
      icon(acc.isCurrent ? 'checkCircle' : 'user'),
      el('div', { class: 'stack-sm' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'account-name', text: acc.label }),
          acc.isCurrent ? el('span', { class: 'badge badge-success', text: 'Gerade angemeldet' }) : null,
        ]),
        el('div', { class: 'account-meta', text: [
          acc.email && acc.email !== acc.label ? acc.email : '',
          acc.lastUsed ? 'zuletzt benutzt ' + formatDate(acc.lastUsed) : (acc.savedAt ? 'gespeichert ' + formatDate(acc.savedAt) : ''),
        ].filter(Boolean).join(' · ') }),
      ]),
      el('div', { class: 'account-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          fk: 'switch-' + acc.id,
          disabled: busy || acc.isCurrent,
          title: acc.isCurrent ? 'Dieses Konto ist gerade angemeldet' : 'Launcher mit diesem Konto neu starten',
          onclick: () => switchTo(acc),
        }, [icon(pending === 'switch-' + acc.id ? 'refresh' : 'swap'), pending === 'switch-' + acc.id ? 'Wechsle …' : 'Wechseln']),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', fk: 'rename-' + acc.id, disabled: busy, onclick: () => renameAccount(acc) }, [icon('pencil', 'icon-sm'), 'Umbenennen']),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', fk: 'remove-' + acc.id, disabled: busy, onclick: () => removeAccount(acc) }, [icon('trash', 'icon-sm'), 'Entfernen']),
      ]),
    ]);
  }

  function accountsCard() {
    const supported = Boolean(status && status.supported && status.launcherInstalled);
    const accounts = (status && status.accounts) || [];
    const card = el('section', { class: 'card stack' }, [
      el('div', { class: 'row row-between' }, [
        el('div', null, [
          el('h2', { class: 'card-title', text: 'Gespeicherte Konten' }),
          el('p', { class: 'card-sub', text: 'Jedes Konto, das du hier speicherst, startest du später mit einem Klick.' }),
        ]),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          fk: 'save-current',
          disabled: !supported || Boolean(pending),
          onclick: saveCurrent,
        }, [icon(pending === 'save' ? 'refresh' : 'plus'), 'Aktuelles Konto speichern']),
      ]),
    ]);
    if (!accounts.length) {
      card.appendChild(el('div', { class: 'empty' }, [
        icon('users'),
        el('div', { class: 'empty-title', text: 'Noch kein Konto gespeichert' }),
        el('div', { text: 'Melde dich im Epic Games Launcher mit dem Haken "Angemeldet bleiben" an und klick dann auf "Aktuelles Konto speichern". Dann das nächste Konto genauso.' }),
      ]));
    } else {
      card.appendChild(el('div', { class: 'account-list' }, accounts.map(accountRow)));
    }
    return card;
  }

  function howCard() {
    return el('section', { class: 'card stack' }, [
      el('h2', { class: 'card-title', text: 'So funktioniert es' }),
      el('ol', { class: 'todo-list' }, [
        el('li', { text: 'Im Epic Games Launcher anmelden und den Haken bei "Angemeldet bleiben" setzen.' }),
        el('li', { text: 'Hier auf "Aktuelles Konto speichern" klicken und einen Namen vergeben.' }),
        el('li', { text: 'Im Launcher abmelden, mit dem nächsten Konto anmelden, wieder speichern.' }),
        el('li', { text: 'Ab jetzt: "Wechseln" klicken. Der Launcher wird geschlossen und startet mit dem gewählten Konto neu.' }),
      ]),
      callout('info', 'Nur für deine eigenen Konten', 'Der Konto-Retter sichert nur die "Angemeldet bleiben"-Anmeldung, die der Launcher selbst auf diesem PC speichert. Sie ist an deinen Windows-Benutzer gebunden und funktioniert auf keinem anderen PC. Passwörter werden nie gelesen.'),
      callout('warning', 'Zugang abgelaufen?', 'Meldet dich der Launcher nach dem Wechsel nicht automatisch an, ist der gespeicherte Zugang abgelaufen (das passiert nach längerer Zeit oder nach einer Passwortänderung). Dann einmal von Hand anmelden und das Konto hier neu speichern.'),
    ]);
  }

  function render() {
    if (!root) return;
    window.UI.keepFocus(root, draw);
  }

  function draw() {
    const head = pageHead('Konten', 'Mehrere Epic-Konten? Hier wechselst du im Epic Games Launcher mit einem Klick zwischen deinen Konten.');
    clear(root).appendChild(el('div', { class: 'page' }, [head, statusCard(), accountsCard(), howCard()]));
  }

  window.Views = window.Views || {};
  window.Views.accounts = {
    id: 'accounts',
    label: 'Konten',
    hint: 'Schnell wechseln',
    icon: 'swap',
    async mount(container) {
      root = container;
      const myId = ++mountId;
      if (timer) clearInterval(timer);
      timer = null;
      render();
      await refresh();
      // Wurde die Ansicht inzwischen verlassen? Dann keinen Takt mehr starten.
      if (myId !== mountId || root !== container) return;
      timer = setInterval(() => { if (!pending) refresh(); }, 4000);
    },
    unmount() {
      mountId += 1;
      root = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh: render,
    badge() {
      const n = status && status.accounts ? status.accounts.length : 0;
      return n ? { text: String(n), done: false } : null;
    },
  };
})();
