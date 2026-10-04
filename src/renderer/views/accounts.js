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

  // Führt eine Aktion aus und gibt ihr Ergebnis zurück (null, wenn schon etwas läuft oder es abstürzt)
  async function act(name, fn) {
    if (pending) return null;
    const focusKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    pending = name;
    render();
    let res = null;
    try {
      res = await fn();
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
    return res;
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

  // Erklärt, was zu tun ist, wenn im Launcher niemand mit "Angemeldet bleiben" angemeldet ist.
  async function notRememberedDialog() {
    const body = el('div', { class: 'stack' }, [
      el('p', { class: 'muted', text: 'In der Einstellungsdatei des Launchers steht gerade keine Anmeldung.' }),
      el('ol', { class: 'todo-list' }, [
        el('li', { text: 'Im Launcher anmelden und den Haken bei "Angemeldet bleiben" setzen.' }),
        el('li', { text: 'Dann hier erneut auf "Aktuelles Konto speichern" klicken.' }),
      ]),
      el('p', { class: 'hint', text: 'Zwei-Faktor-Schutz (2FA) muss dafür NICHT aus. Klappt es trotzdem nicht: unter "Was der Konto-Retter sieht" die Diagnose kopieren und melden.' }),
    ]);
    return confirmDialog({ title: 'Noch keine Anmeldung gefunden', body, confirmText: 'Verstanden', cancelText: null });
  }

  // Speichern-Dialog. Erkennt der Konto-Retter das angemeldete Konto nicht von selbst, kann man hier
  // einen vorhandenen Eintrag wählen, der damit ersetzt wird (z. B. einen alten Eintrag, der nicht mehr geht).
  // Ergebnis: { name, targetId } oder null (abgebrochen).
  async function askSave() {
    const accounts = status.accounts || [];
    const matched = accounts.find((a) => a.id === status.currentMatchId);
    let name = matched ? matched.label : (status.currentEmail || (status.currentAccountIdShort ? 'Epic-Konto ' + status.currentAccountIdShort : ''));
    let target = null;
    const input = el('input', { class: 'input', type: 'text', value: name, placeholder: 'z. B. Hauptkonto', 'aria-label': 'Name für dieses Konto', spellcheck: 'false' });
    input.addEventListener('input', () => { name = input.value; });
    const parts = [
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Name für dieses Konto' }),
        input,
        el('div', { class: 'field-hint', text: 'Nur für dich, damit du die Konten auseinanderhältst.' }),
      ]),
    ];
    if (matched) {
      parts.push(el('p', { class: 'hint', text: 'Das angemeldete Konto ist schon als "' + matched.label + '" gespeichert. Der Eintrag wird aufgefrischt.' }));
    } else if (accounts.length) {
      const list = el('div', { class: 'stack-sm' });
      const option = (label, hint, value, checked) => {
        const radio = el('input', { type: 'radio', name: 'save-target', checked });
        radio.addEventListener('change', () => {
          if (!radio.checked) return;
          target = value;
          input.disabled = value !== null;
        });
        return el('label', { class: 'check' }, [radio, el('span', { class: 'stack-sm' }, [el('span', { text: label }), hint ? el('span', { class: 'hint', text: hint }) : null])]);
      };
      list.appendChild(option('Als neues Konto speichern', null, null, true));
      for (const a of accounts) {
        list.appendChild(option('Eintrag "' + a.label + '" ersetzen', a.legacy ? 'Alter Eintrag ohne Konto-ID – wenn "Wechseln" zu ihm nur die Anmeldeseite zeigt, hier ersetzen.' : (a.email || ''), a.id, false));
      }
      parts.push(el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: 'Wohin speichern?' }),
        el('div', { class: 'field-hint', text: 'Ist das angemeldete Konto schon in der Liste, aber der Eintrag funktioniert nicht mehr? Dann wähle ihn hier aus.' }),
        list,
      ]));
    }
    const dialog = confirmDialog({ title: matched ? 'Konto auffrischen' : 'Aktuelles Konto speichern', body: el('div', { class: 'stack' }, parts), confirmText: 'Speichern' });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    const yes = await dialog;
    return yes ? { name: target ? '' : name.trim(), targetId: target } : null;
  }

  async function saveCurrent() {
    if (!status || !status.supported) return;
    if (!status.remembered) {
      await notRememberedDialog();
      return;
    }
    const choice = await askSave();
    if (!choice) return;
    act('save', () => window.kr.epicAccounts.save(choice.name, choice.targetId));
  }

  // Weiteres Konto: Launcher zur Anmeldung öffnen, OHNE abzumelden (Abmelden macht den gespeicherten Zugang ungültig)
  async function addNew() {
    if (!status || !status.supported) return;
    const body = el('div', { class: 'stack' }, [
      el('p', { class: 'muted', text: 'Der Konto-Retter schließt den Launcher, sichert das gerade angemeldete Konto und öffnet den Launcher dann mit der Anmeldeseite.' }),
      el('ol', { class: 'todo-list' }, [
        el('li', { text: 'Im Launcher mit dem nächsten Konto anmelden und den Haken bei "Angemeldet bleiben" setzen.' }),
        el('li', { text: 'Hier auf "Aktuelles Konto speichern" klicken.' }),
      ]),
      callout('warning', 'Im Launcher nie auf "Abmelden" klicken', 'Abmelden meldet den Zugang auch bei Epic ab. Dann führt "Wechseln" zu diesem Konto nur noch zur Anmeldeseite.'),
    ]);
    const yes = await confirmDialog({ title: 'Weiteres Konto hinzufügen', body, confirmText: 'Launcher zur Anmeldung öffnen' });
    if (yes) act('add-new', () => window.kr.epicAccounts.addNew());
  }

  function diagText() {
    const d = status && status.diag;
    if (!d) return '';
    const lines = [
      'Konto-Retter Diagnose Konten-Wechsel',
      'Launcher gefunden (EXE): ' + (d.launcherExe || 'nein'),
      'Launcher-Version (Log): ' + (d.launcherVersion || 'unbekannt'),
      'Launcher läuft: ' + (status.running ? 'ja' : 'nein'),
      'LOCALAPPDATA: ' + (d.localAppData || '?'),
      'Einstellungsdatei: ' + (d.file || '?') + ' – ' + (d.fileFound ? 'gefunden' : 'FEHLT'),
      '[RememberMe]-Abschnitt: ' + (d.sectionFound ? 'vorhanden' : 'FEHLT'),
      'Enable: ' + (d.enable || '(leer)') + ' · Data: ' + (d.dataLength ? d.dataLength + ' Zeichen' : 'LEER') + ' · Email: ' + (d.email || '(leer)'),
      'Konto-ID (Registry): ' + (d.accountId || '(keine)') + (d.accountIdHint && d.accountIdHint !== d.accountId ? ' · Hinweis aus Saved\\Data: ' + d.accountIdHint : ''),
      'Verschlüsselung: ' + (status.encrypted ? 'an' : 'aus'),
      'Gespeicherte Konten: ' + ((status.accounts || []).length),
      'Einstellungsdateien des Launchers:',
      ...(d.configFiles && d.configFiles.length
        ? d.configFiles.map((c) => '  - ' + c.file + (c.used ? '  (benutzt)' : '') + (c.hasSection ? '  [RememberMe: ' + (c.dataLength ? c.dataLength + ' Zeichen' : 'leer') + ']' : '  [kein RememberMe]') + (c.modified ? '  geändert ' + c.modified : ''))
        : ['  (keine gefunden)']),
    ];
    return lines.join('\n');
  }

  function diagBlock() {
    if (!status || !status.diag) return null;
    const d = status.diag;
    const row = (label, value, bad) => el('div', { class: 'row' }, [
      el('span', { class: 'hint', text: label }),
      el('span', { class: 'mono' + (bad ? ' diag-bad' : ''), text: value }),
    ]);
    return el('details', { class: 'diag' }, [
      el('summary', { text: 'Was der Konto-Retter sieht (Diagnose)' }),
      el('div', { class: 'stack-sm' }, [
        row('Launcher-Programm:', d.launcherExe || 'nicht gefunden', !d.launcherExe),
        row('Launcher-Version:', d.launcherVersion || 'unbekannt'),
        row('Einstellungsdatei:', (d.file || '?') + (d.fileFound ? '' : ' (fehlt)'), !d.fileFound),
        row('[RememberMe]:', d.sectionFound ? 'vorhanden' : 'fehlt', !d.sectionFound),
        row('Enable / Data / Email:', (d.enable || '–') + ' / ' + (d.dataLength ? d.dataLength + ' Zeichen' : 'leer') + ' / ' + (d.email || '–'), !d.dataLength),
        row('Konto-ID (Registry):', d.accountId || 'keine', !d.accountId),
        el('div', { class: 'hint', text: 'Der Zugang selbst wird nie angezeigt oder kopiert – nur, ob er da ist.' }),
        el('div', null, window.UI.copyButton(diagText, 'Diagnose', { small: true, text: 'Diagnose kopieren' })),
      ]),
    ]);
  }

  async function switchTo(acc) {
    const yes = await confirmDialog({
      title: 'Zu "' + acc.label + '" wechseln?',
      text: 'Der Epic Games Launcher wird geschlossen und mit diesem Konto neu gestartet. Läuft gerade ein Spiel über den Launcher, speichere es vorher.',
      confirmText: 'Wechseln',
    });
    if (!yes) return;
    const res = await act('switch-' + acc.id, () => window.kr.epicAccounts.switchTo(acc.id));
    if (res && res.ok) toast('Zeigt der Launcher nur die Anmeldeseite? Dann ist der gespeicherte Zugang ungültig (z. B. nach "Abmelden" im Launcher). Einmal mit diesem Konto anmelden ("Angemeldet bleiben"), dann hier "Aktuelles Konto speichern" und den Eintrag "' + acc.label + '" ersetzen.', 'info');
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
        diagBlock(),
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
      !status.remembered ? callout('warning', 'Noch keine Anmeldung gefunden', 'Melde dich im Launcher an und setz den Haken bei "Angemeldet bleiben". Dann hier "Aktuelles Konto speichern". 2FA muss dafür nicht aus.') : null,
      el('p', { class: 'hint', text: status.encrypted
        ? 'Gespeicherte Zugänge liegen verschlüsselt auf diesem PC und funktionieren nur hier.'
        : 'Hinweis: Die Windows-Verschlüsselung ist auf diesem PC nicht verfügbar. Die Zugänge sind trotzdem an deinen Windows-Benutzer gebunden.' }),
      diagBlock(),
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
          acc.legacy ? el('span', {
            class: 'badge badge-warning',
            title: 'Mit einer älteren Version ohne Konto-ID gespeichert. Führt "Wechseln" nur zur Anmeldeseite: mit diesem Konto anmelden, "Aktuelles Konto speichern" und diesen Eintrag ersetzen.',
            text: 'Alter Eintrag',
          }) : null,
        ]),
        el('div', { class: 'account-meta', text: [
          acc.email && acc.email !== acc.label ? acc.email : '',
          acc.accountIdShort ? 'ID ' + acc.accountIdShort + '…' : '',
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
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            fk: 'add-new',
            disabled: !supported || Boolean(pending),
            title: 'Launcher zur Anmeldung öffnen, ohne dich abzumelden',
            onclick: addNew,
          }, [icon(pending === 'add-new' ? 'refresh' : 'users'), 'Weiteres Konto hinzufügen']),
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            fk: 'save-current',
            disabled: !supported || Boolean(pending),
            onclick: saveCurrent,
          }, [icon(pending === 'save' ? 'refresh' : 'plus'), 'Aktuelles Konto speichern']),
        ]),
      ]),
    ]);
    if (!accounts.length) {
      card.appendChild(el('div', { class: 'empty' }, [
        icon('users'),
        el('div', { class: 'empty-title', text: 'Noch kein Konto gespeichert' }),
        el('div', { text: 'Melde dich im Epic Games Launcher mit dem Haken "Angemeldet bleiben" an und klick dann auf "Aktuelles Konto speichern". Für das nächste Konto: "Weiteres Konto hinzufügen".' }),
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
        el('li', { text: 'Für das nächste Konto hier auf "Weiteres Konto hinzufügen" klicken. Der Launcher öffnet die Anmeldung – mit dem nächsten Konto anmelden ("Angemeldet bleiben") und wieder speichern.' }),
        el('li', { text: 'Ab jetzt: "Wechseln" klicken. Der Launcher wird geschlossen und startet mit dem gewählten Konto neu.' }),
      ]),
      callout('danger', 'Im Launcher nie auf "Abmelden" klicken', 'Abmelden meldet den gespeicherten Zugang auch bei Epic ab. Danach führt "Wechseln" zu diesem Konto nur noch zur Anmeldeseite. Für ein anderes Konto immer "Weiteres Konto hinzufügen" benutzen.'),
      callout('warning', 'Wechsel zeigt nur die Anmeldeseite?', 'Dann ist der gespeicherte Zugang ungültig – zum Beispiel nach "Abmelden" im Launcher, einer Passwortänderung oder langer Zeit. Einmal mit diesem Konto anmelden ("Angemeldet bleiben"), dann "Aktuelles Konto speichern". Erkennt der Konto-Retter das Konto nicht von selbst, wählst du dort den alten Eintrag zum Ersetzen aus.'),
      callout('info', 'Nur für deine eigenen Konten', 'Der Konto-Retter sichert nur die "Angemeldet bleiben"-Anmeldung, die der Launcher selbst auf diesem PC speichert. Sie funktioniert auf keinem anderen PC. Passwörter werden nie gelesen.'),
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
