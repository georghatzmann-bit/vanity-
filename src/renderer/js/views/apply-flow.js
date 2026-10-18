// Ablauf "Profil anwenden": Prüfen -> Vorschau -> Anwenden -> Ergebnis.
// Wird vom Cockpit (Profil-Leiste) und von der Profil-Ansicht benutzt.

const ACTION_TEXT = {
  change: ['wird ersetzt', 'accent'],
  new: ['kommt neu dazu', 'ok'],
  same: ['ist schon gleich', ''],
  remove: ['wird entfernt (nicht im Profil)', 'warn'],
  skip: ['übersprungen (Schutzfilter)', ''],
  locked: ['gesperrt', 'err'],
};

export const RO_OPTIONS = [
  ['none', 'Aus', 'Fortnite darf die Dateien wie gewohnt ändern. Empfohlen.'],
  ['video', 'Nur Grafik-Datei', 'Schützt GameUserSettings.ini (Auflösung, FPS, Grafik). Änderungen im Spiel an der Grafik werden dann nicht gespeichert.'],
  ['all', 'Alle Config-Dateien', 'Nichts im Config-Ordner kann sich ändern. Die Tasten-/Sensi-Datei aus der Cloud bleibt ausgenommen.'],
];

export function roKey(ro) {
  if (ro === 'all') return 'all';
  if (Array.isArray(ro) && ro.includes('video')) return 'video';
  return 'none';
}

export function roValue(key) {
  if (key === 'all') return 'all';
  if (key === 'video') return ['video'];
  return 'none';
}

export async function applyFlow(env, profileId, { onDone } = {}) {
  const ui = env.ui;
  const { h, icon } = ui;
  let preview;
  try {
    preview = await env.call('profiles.preview', { id: profileId });
  } catch (e) {
    ui.showError(e);
    return;
  }
  const p = preview.profile;
  let roSel = roKey(p.options?.readOnly);
  let removeExtra = p.options?.removeExtra !== false;
  let fortnite = preview.fortnite || {};

  const fnBox = h('div.callout');
  const applyBtnHolder = { el: null };

  function renderFortnite() {
    ui.clear(fnBox);
    fnBox.className = `callout ${fortnite.running ? 'warn' : 'ok'}`;
    if (!fortnite.running) {
      fnBox.append(icon('check'), h('div', h('strong', 'Fortnite ist geschlossen'), h('p.hint', 'Die Dateien können sicher ersetzt werden.')));
    } else {
      const names = (fortnite.processes || []).map((x) => x.name).join(', ');
      fnBox.append(icon('warn'), h('div',
        h('strong', 'Fortnite läuft noch'),
        h('p.hint', `Solange Fortnite offen ist, würde es deine Dateien gleich wieder überschreiben. (${names})`),
        h('div.row',
          ui.button('Fortnite schließen', {
            variant: 'primary', iconName: 'power', small: true,
            onClick: async () => {
              const r = await env.call('core.fortniteClose', { force: false }).catch((e) => { ui.showError(e); return null; });
              if (r && !r.closed) {
                const ok = await ui.confirmDialog({
                  title: 'Fortnite reagiert nicht',
                  text: 'Fortnite hat sich nicht normal beendet. Sofort beenden? Nicht gespeicherte Dinge im Spiel gehen dabei verloren.',
                  confirmLabel: 'Sofort beenden', danger: true,
                });
                if (ok) await env.call('core.fortniteClose', { force: true }).catch((e) => ui.showError(e));
              }
              fortnite = await env.call('core.fortniteStatus').catch(() => fortnite);
              renderFortnite();
            },
          }),
          ui.button('Erneut prüfen', {
            small: true, iconName: 'refresh',
            onClick: async () => { fortnite = await env.call('core.fortniteStatus').catch(() => fortnite); renderFortnite(); },
          }))));
    }
    if (applyBtnHolder.el) applyBtnHolder.el.disabled = !!fortnite.running;
  }

  const counts = preview.counts;
  const listItems = preview.items.filter((i) => i.action !== 'same' || preview.items.length < 12);
  const fileList = h('ul.list.files', listItems.map((i) => {
    const [txt, cls] = ACTION_TEXT[i.action] || [i.action, ''];
    return h('li', icon(i.action === 'remove' ? 'trash' : 'file', 16), h('div.grow', h('span', i.label || i.rel), h('span.hint.mono', ui.displayPath(i.rel))), ui.badge(txt, cls));
  }));
  const summary = h('div.stat-row',
    stat(counts.change, 'werden ersetzt'), stat(counts.new, 'kommen neu'), stat(counts.remove, 'werden entfernt'), stat(counts.same, 'schon gleich'));
  function stat(n, label) { return h('div.stat', h('strong', String(n)), h('span.hint', label)); }

  const roGroup = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Schreibschutz' }, RO_OPTIONS.map(([key, label, hint]) => {
    const b = h(`button.seg${roSel === key ? '.active' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(roSel === key), title: hint }, label);
    b.addEventListener('click', () => {
      roSel = key;
      roGroup.querySelectorAll('.seg').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); });
      roHint.textContent = hint;
    });
    return b;
  }));
  const roHint = h('p.hint', RO_OPTIONS.find((o) => o[0] === roSel)[2]);

  const content = [
    h('div.callout.info', icon('info'), h('div', h('strong', 'Richtiges Konto?'), h('p.hint', 'Logge dich vorher im Epic Games Launcher selbst in das Konto ein, zu dem dieses Profil gehört. HELIX fasst keine Login-Daten an.'))),
    preview.items.some((i) => i.kind === 'controls')
      ? h('p.hint', 'Hinweis: Tastenbelegung und Sensi speichert Fortnite pro Konto in der Epic-Cloud. HELIX legt die gesicherte Kopie zurück – unterscheidet sie sich von der Cloud, holt Fortnite beim Einloggen die Cloud-Version. HELIX sagt dir dann Bescheid.')
      : null,
    fnBox,
    h('h4', 'Was passiert'),
    summary,
    fileList,
    h('h4', 'Schreibschutz nach dem Anwenden'),
    roGroup,
    roHint,
    ui.toggle({
      label: 'Dateien entfernen, die nicht im Profil sind',
      hint: 'Empfohlen: So entspricht der Ordner genau dem Profil. Entfernte Dateien liegen in der Sicherung.',
      checked: removeExtra,
      onChange: (v) => { removeExtra = v; },
    }),
    h('p.hint', 'Vorher wird automatisch eine Sicherung des jetzigen Zustands angelegt.'),
  ];
  renderFortnite();

  let result = null;
  const pending = ui.modal({
    title: `Profil „${p.name}“ anwenden`,
    subtitle: `Ziel: ${preview.target.configDir}`,
    wide: true,
    content,
    actions: [
      { label: 'Abbrechen', value: null },
      {
        label: 'Jetzt anwenden',
        variant: 'primary',
        icon: 'check',
        value: 'applied',
        onClick: async () => {
          try {
            const wantRo = roValue(roSel);
            if (JSON.stringify(wantRo) !== JSON.stringify(p.options?.readOnly ?? 'none') || removeExtra !== (p.options?.removeExtra !== false)) {
              await env.call('profiles.options', { id: p.id, options: { readOnly: wantRo, removeExtra } });
            }
            result = await env.call('profiles.apply', { id: p.id, readOnly: wantRo, removeExtra });
            return true;
          } catch (e) {
            if (e.code === 'FORTNITE_RUNNING') {
              fortnite = await env.call('core.fortniteStatus').catch(() => ({ running: true }));
              renderFortnite();
            }
            ui.showError(e);
            return false;
          }
        },
      },
    ],
  });
  // "Jetzt anwenden" bleibt gesperrt, solange Fortnite läuft
  requestAnimationFrame(() => { bindApplyButton(applyBtnHolder); renderFortnite(); });
  const r = await pending;
  if (r !== 'applied' || !result) return;
  await showResult(env, p, result);
  env.refreshStatus?.();
  onDone?.(result);
}

function bindApplyButton(holder) {
  const btn = [...document.querySelectorAll('.modal .btn.primary')].pop();
  holder.el = btn || null;
}

export async function showResult(env, p, result) {
  const { h, icon } = env.ui;
  const ui = env.ui;
  if (!result.ok) {
    await ui.modal({
      title: 'Das Anwenden hat nicht geklappt',
      content: [
        h('p', 'Einige Dateien konnten nicht geschrieben werden. HELIX hat den vorherigen Zustand automatisch wiederhergestellt.'),
        h('ul.list.compact', result.failed.map((f) => h('li', icon('x', 16), h('span', ui.displayPath(f.rel)), h('span.hint', f.message)))),
        h('p.hint', result.rollback?.ok ? 'Wiederherstellung: erfolgreich.' : 'Wiederherstellung: bitte in den Sicherungen prüfen.'),
      ],
      actions: [{ label: 'OK', variant: 'primary' }],
    });
    return;
  }
  ui.toast(`„${p.name}“ ist jetzt aktiv.`);
  const rows = [
    ...result.written.map((f) => h('li', icon('check', 16), h('div.grow', h('span', f.label || f.rel), h('span.hint.mono', ui.displayPath(f.rel))), ui.badge(f.action === 'new' ? 'neu kopiert' : 'kopiert', 'ok'))),
    ...result.removed.map((f) => h('li', icon('trash', 16), h('div.grow', h('span', f.label || f.rel), h('span.hint.mono', ui.displayPath(f.rel))), ui.badge('entfernt', 'warn'))),
    ...result.same.map((f) => h('li', icon('check', 16), h('div.grow', h('span', f.label || f.rel), h('span.hint.mono', ui.displayPath(f.rel))), ui.badge('war schon gleich', ''))),
  ];
  const ro = result.readOnlySet.length
    ? `Schreibschutz ist an für: ${result.readOnlySet.join(', ')}`
    : result.readOnlyMode === 'none' ? 'Schreibschutz ist aus.' : 'Schreibschutz war schon gesetzt.';
  const r = await ui.modal({
    title: `„${p.name}“ wurde angewendet`,
    subtitle: `${result.written.length} kopiert · ${result.removed.length} entfernt · ${result.same.length} unverändert`,
    wide: true,
    content: [
      h('ul.list.files', rows),
      h('div.callout.info', icon('shield'), h('div', h('strong', 'Sicherung angelegt'), h('p.hint', 'Der vorherige Zustand liegt in der Zeitmaschine. Du kannst alles mit einem Klick zurückholen.'))),
      h('p.hint', ro),
      h('div.callout.ok', icon('eye'), h('div', h('strong', 'Jetzt Fortnite starten'), h('p.hint', 'HELIX passt auf: Holt Fortnite nach dem Start Einstellungen aus der Cloud zurück, bekommst du sofort eine Warnung.'))),
    ],
    actions: [
      { label: 'Rückgängig machen', value: 'undo', icon: 'refresh' },
      { label: 'Fertig', value: 'ok', variant: 'primary' },
    ],
  });
  if (r === 'undo') {
    try {
      const u = await env.call('backups.restore', { id: result.backupId });
      if (u.ok) ui.toast('Vorheriger Zustand wiederhergestellt.');
      else ui.toast('Wiederherstellen nicht vollständig – bitte Zeitmaschine prüfen.', 'warn');
    } catch (e) { ui.showError(e); }
    env.refreshStatus?.();
  }
}

export { bindApplyButton };
