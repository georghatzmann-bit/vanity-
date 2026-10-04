// Ansicht "Discord": starten, beenden, Benachrichtigungen stumm schalten – alles per Klick.
(function () {
  'use strict';
  const { el, icon, clear, toast, confirmDialog, pageHead, callout, switchControl, formatDate } = window.UI;

  let root = null;
  let status = null;
  let pending = null; // gerade laufende Aktion
  let timer = null;
  let platform = 'win32';
  let mountId = 0;
  let refreshing = false;

  function options() {
    const s = window.Store.get();
    if (!s.discord) s.discord = { toasts: true, sound: true };
    return s.discord;
  }

  async function refresh() {
    if (refreshing) return; // keine überlappenden Abfragen
    refreshing = true;
    try {
      const res = await window.kr.discord.status();
      if (res && res.ok) status = res.value;
    } finally {
      refreshing = false;
    }
    render();
  }

  async function act(name, fn) {
    if (pending) return;
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
    }
  }

  function bigAction({ id, title, hint, iconName, kind, disabled, onClick }) {
    const busy = pending === id;
    return el('button', {
      class: 'big-action' + (kind ? ' ' + kind : ''),
      type: 'button',
      fk: 'action-' + id,
      disabled: disabled || Boolean(pending),
      onclick: onClick,
    }, [
      icon(busy ? 'refresh' : iconName),
      el('span', { class: 'big-action-title', text: busy ? 'Einen Moment …' : title }),
      el('span', { class: 'big-action-hint', text: hint }),
    ]);
  }

  function statusCard() {
    if (!status) {
      return el('section', { class: 'card' }, el('div', { class: 'status-line' }, [el('span', { class: 'dot' }), 'Status wird geprüft …']));
    }
    if (!status.supported) {
      return el('section', { class: 'card stack-sm' }, [
        el('div', { class: 'status-line' }, [el('span', { class: 'dot warn' }), 'Nur unter Windows verfügbar']),
        el('p', { class: 'muted', text: 'Die Discord-Steuerung benutzt Windows-Funktionen und geht deshalb nur unter Windows.' }),
      ]);
    }
    if (!status.installed.length) {
      return el('section', { class: 'card stack-sm' }, [
        el('div', { class: 'status-line' }, [el('span', { class: 'dot warn' }), 'Discord wurde nicht gefunden']),
        el('p', { class: 'muted', text: 'Auf diesem PC ist kein Discord-Programm installiert (gesucht wurde im normalen Installationsordner).' }),
      ]);
    }
    const muted = status.muted.toasts || status.muted.sound;
    const lines = [
      el('div', { class: 'status-line' }, [
        el('span', { class: 'dot ' + (status.running ? 'on' : 'off') }),
        status.running ? 'Discord läuft' : 'Discord ist geschlossen',
      ]),
      el('div', { class: 'row' }, [
        el('span', { class: 'badge ' + (muted ? 'badge-warning' : 'badge-success') }, [icon(muted ? 'bellOff' : 'bell', 'icon-sm'), muted ? 'Stumm geschaltet' : 'Benachrichtigungen an']),
        status.muted.toasts ? el('span', { class: 'hint', text: 'Windows-Benachrichtigungen aus' }) : null,
        status.muted.sound ? el('span', { class: 'hint', text: 'Töne aus' + (status.muted.since ? ' seit ' + formatDate(status.muted.since) : '') }) : null,
      ]),
      status.muted.restorePending ? callout('info', 'Ton wird gleich wieder eingeschaltet', 'Sobald Discord läuft, schaltet der Konto-Retter den Ton automatisch wieder an. Lass den Konto-Retter dafür kurz geöffnet.') : null,
      el('p', { class: 'hint', text: 'Gefunden: ' + status.installed.join(', ') + '. Der Status wird alle paar Sekunden aktualisiert.' }),
    ];
    return el('section', { class: 'card stack-sm' }, lines);
  }

  function actionsCard() {
    const supported = status && status.supported && status.installed.length;
    const muted = status && (status.muted.toasts || status.muted.sound);
    const opts = options();
    const card = el('section', { class: 'card stack' }, [
      el('div', { class: 'big-actions' }, [
        bigAction({
          id: 'start', title: 'Discord starten', hint: 'Öffnet Discord. Läuft es schon, kommt das Fenster nach vorne.',
          iconName: 'play', kind: 'success', disabled: !supported,
          onClick: () => act('start', () => window.kr.discord.start()),
        }),
        bigAction({
          id: 'stop', title: 'Discord beenden', hint: 'Schließt Discord komplett, auch im Infobereich unten rechts.',
          iconName: 'stop', kind: 'danger', disabled: !supported || !(status && status.running),
          onClick: async () => {
            const yes = await confirmDialog({
              title: 'Discord beenden?',
              text: 'Discord wird komplett geschlossen. Läuft gerade ein Sprachchat, wirst du getrennt.',
              confirmText: 'Beenden',
              danger: true,
            });
            if (yes) act('stop', () => window.kr.discord.stop());
          },
        }),
        muted
          ? bigAction({
            id: 'mute', title: 'Benachrichtigungen wieder an', hint: 'Stellt alles so zurück, wie es vorher war.',
            iconName: 'bell', disabled: !supported,
            onClick: () => act('mute', () => window.kr.discord.mute(false, {})),
          })
          : bigAction({
            id: 'mute', title: 'Benachrichtigungen stumm', hint: 'Keine Discord-Popups und keine Discord-Töne mehr.',
            iconName: 'bellOff', kind: 'warning', disabled: !supported || (!opts.toasts && !opts.sound),
            onClick: () => act('mute', () => window.kr.discord.mute(true, { toasts: opts.toasts, sound: opts.sound })),
          }),
      ]),
      el('div', { class: 'stack-sm' }, [
        el('h3', { class: 'card-title', text: 'Was soll "stumm" bedeuten?' }),
        switchControl('Windows-Benachrichtigungen von Discord ausblenden', opts.toasts, (v) => {
          window.Store.update((s) => { options().toasts = v; }, 'discord');
          render();
        }, 'Keine Popups mehr unten rechts. Bleibt aus, bis du sie hier wieder einschaltest.', 'opt-toasts'),
        switchControl('Discord-Töne stumm schalten', opts.sound, (v) => {
          window.Store.update((s) => { options().sound = v; }, 'discord');
          render();
        }, 'Achtung: Dann ist auch der Sprachchat stumm (du hörst niemanden). Beim Schließen des Konto-Retters geht der Ton automatisch wieder an.', 'opt-sound'),
      ]),
    ]);
    return card;
  }

  function tipsCard() {
    return el('section', { class: 'card stack' }, [
      el('h2', { class: 'card-title', text: 'Gut zu wissen' }),
      callout('danger', 'Niemand vom Epic-Support schreibt dir auf Discord', 'Wer sich dort als Epic-Mitarbeiter ausgibt oder "Konto-Rettung" anbietet, ist ein Betrüger. Gib dort nie Passwörter, Codes oder deine Konto-ID weiter.'),
      callout('info', 'Sprachchat behalten, nur Pings stumm?', 'Dann stell in Discord deinen Status auf "Bitte nicht stören": unten links auf dein Profilbild klicken und "Bitte nicht stören" wählen. Das kann aus Sicherheitsgründen nur Discord selbst.'),
      platform === 'win32' ? el('div', { class: 'row' }, [
        el('button', {
          class: 'btn',
          type: 'button',
          onclick: async () => {
            const res = await window.kr.discord.openWindowsSettings();
            if (!res || !res.ok) toast((res && res.message) || 'Einstellungen konnten nicht geöffnet werden.', 'error');
          },
        }, [icon('external'), 'Windows "Nicht stören" öffnen']),
        el('span', { class: 'hint', text: 'Schaltet alle Popups von Windows auf einmal aus.' }),
      ]) : null,
    ]);
  }

  function render() {
    if (!root) return;
    window.UI.keepFocus(root, draw);
  }

  function draw() {
    const head = pageHead('Discord', 'Discord starten, beenden und stumm schalten – mit einem Klick. Dein Discord-Konto wird dabei nicht angefasst.');
    clear(root).appendChild(el('div', { class: 'page' }, [head, statusCard(), actionsCard(), tipsCard()]));
  }

  window.Views = window.Views || {};
  window.Views.discord = {
    id: 'discord',
    label: 'Discord',
    hint: 'Starten, beenden, stumm',
    icon: 'headset',
    async mount(container) {
      root = container;
      const myId = ++mountId;
      if (timer) clearInterval(timer);
      timer = null;
      render();
      try {
        const info = await window.kr.appInfo();
        if (info && info.ok) platform = info.value.platform;
      } catch (_) { /* egal */ }
      // Wurde die Ansicht inzwischen verlassen? Dann keinen Takt mehr starten.
      if (myId !== mountId || root !== container) return;
      render();
      refresh();
      timer = setInterval(() => { if (!pending) refresh(); }, 4000);
    },
    unmount() {
      mountId += 1;
      root = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
    refresh: render,
  };
})();
