// Ablauf "Profil anwenden": Prüfen -> Vorschau -> Anwenden -> Ergebnis.
// Wird vom Cockpit (Profil-Leiste) und von der Profil-Ansicht benutzt.
import { controlsDiffBox } from './controls.js';

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
  ['video', 'Nur Grafik-Datei', 'Auflösung, FPS und Grafik bleiben fest – Änderungen im Spiel gehen verloren.'],
  ['all', 'Alle Config-Dateien', 'Der ganze Config-Ordner bleibt fest. Tasten und Sensi sind ausgenommen.'],
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

/**
 * Führt eine Aktion aus, die Fortnite geschlossen braucht (Wiederherstellen, Rückgängig).
 * Läuft Fortnite, wird angeboten, es zu schließen, und die Aktion danach wiederholt.
 */
export async function withFortniteClosed(env, fn) {
  const ui = env.ui;
  try {
    return await fn();
  } catch (e) {
    if (e.code !== 'FORTNITE_RUNNING') throw e;
    const ok = await ui.confirmDialog({
      title: 'Fortnite läuft noch',
      text: 'Fortnite muss geschlossen sein, sonst überschreibt es die Dateien gleich wieder. Soll HELIX Fortnite jetzt schließen?',
      confirmLabel: 'Fortnite schließen',
    });
    if (!ok) return null;
    let r = await env.call('core.fortniteClose', { force: false });
    if (!r.closed) {
      const force = await ui.confirmDialog({
        title: 'Fortnite reagiert nicht',
        text: 'Fortnite hat sich nicht normal beendet. Sofort beenden? Nicht gespeicherte Dinge im Spiel gehen dabei verloren.',
        confirmLabel: 'Sofort beenden', danger: true,
      });
      if (!force) return null;
      r = await env.call('core.fortniteClose', { force: true });
      if (!r.closed) throw new Error('Fortnite konnte nicht geschlossen werden.');
    }
    return fn();
  }
}

export async function applyFlow(env, profileId, { onDone } = {}) {
  const ui = env.ui;
  const { h, icon } = ui;
  let preview;
  // Tasten & Sensi VOR dem Anwenden lesen: danach ist die Kopie auf dem PC schon die des Profils
  const controlsBefore = env.call('profiles.controls', { id: profileId }).catch(() => null);
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
      fnBox.append(icon('check'), h('div', h('strong', 'Fortnite ist geschlossen')));
    } else {
      const names = (fortnite.processes || []).map((x) => x.name).join(', ');
      fnBox.append(icon('warn'), h('div',
        h('strong', { title: names || null }, 'Fortnite läuft noch'),
        h('p.hint', 'Schließ es zuerst, sonst überschreibt es deine Dateien gleich wieder.'),
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

  const previewBox = h('div.preview-box');
  function stat(n, label) { return h('div.stat', h('strong', String(n)), h('span.hint', label)); }
  function renderPreview(pv) {
    const counts = pv.counts;
    const listItems = pv.items.filter((i) => i.action !== 'same' || pv.items.length < 12);
    ui.mount(previewBox,
      h('div.stat-row', stat(counts.change, 'werden ersetzt'), stat(counts.new, 'kommen neu'), stat(counts.remove, 'werden entfernt'), stat(counts.same, 'schon gleich')),
      h('ul.list.files', listItems.map((i) => {
        const [txt, cls] = ACTION_TEXT[i.action] || [i.action, ''];
        return h('li', icon(i.action === 'remove' ? 'trash' : 'file', 16), h('div.grow', h('span', i.label || i.rel), h('span.hint.mono', ui.displayPath(i.rel))), ui.badge(txt, cls));
      })));
  }
  renderPreview(preview);

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
    h('div.callout.info', icon('info'), h('div',
      h('strong', 'Richtiges Konto?'),
      h('p.hint', 'Logg dich vorher im Epic Games Launcher in das Konto dieses Profils ein.'),
      preview.items.some((i) => i.kind === 'controls')
        ? ui.more('Was ist mit Tasten und Sensi?', 'Tastenbelegung und Sensi speichert Fortnite pro Konto in der Epic-Cloud und holt sie beim Einloggen. Nach dem Anwenden zeigt HELIX dir genau, welche Tasten und Werte du im Spiel noch umstellen musst.')
        : null)),
    fnBox,
    h('h4', 'Was passiert'),
    previewBox,
    h('h4', 'Schreibschutz nach dem Anwenden'),
    roGroup,
    roHint,
    ui.toggle({
      label: 'Dateien entfernen, die nicht im Profil sind',
      hint: 'Empfohlen – so passt der Ordner genau zum Profil.',
      checked: removeExtra,
      onChange: async (v) => {
        removeExtra = v;
        try { renderPreview(await env.call('profiles.preview', { id: profileId, removeExtra: v })); } catch (e) { ui.showError(e); }
      },
    }),
    h('p.hint', 'Vorher legt HELIX automatisch eine Sicherung an.'),
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
  await showResult(env, p, result, await controlsBefore);
  env.refreshStatus?.();
  onDone?.(result);
}

function bindApplyButton(holder) {
  const btn = [...document.querySelectorAll('.modal .btn.primary')].pop();
  holder.el = btn || null;
}

export async function showResult(env, p, result, controls = null) {
  const { h, icon } = env.ui;
  const ui = env.ui;
  if (!result.ok) {
    await ui.modal({
      title: 'Das Anwenden hat nicht geklappt',
      content: [
        h('p', 'Einige Dateien ließen sich nicht schreiben. Schließ Programme, die Fortnite-Dateien offen haben könnten, und versuch es nochmal.'),
        h('ul.list.compact', result.failed.map((f) => h('li', icon('x', 16), h('span', ui.displayPath(f.rel)), h('span.hint', f.message)))),
        h('p.hint', result.rollback?.ok ? 'Der vorherige Zustand ist wiederhergestellt.' : 'Zurückholen hat nicht geklappt – bitte in der Zeitmaschine prüfen.'),
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
      controlsDiffBox(env, controls),
      h('ul.list.files', rows),
      h('div.callout.info', icon('shield'), h('div', h('strong', 'Sicherung angelegt'), h('p.hint', 'Der alte Stand liegt in der Zeitmaschine.'))),
      h('p.hint', ro),
      h('div.callout.ok', icon('eye'), h('div', h('strong', 'Jetzt Fortnite starten'), h('p.hint', 'HELIX warnt dich, falls Fortnite Einstellungen aus der Cloud zurückholt.'))),
    ],
    actions: [
      { label: 'Rückgängig machen', value: 'undo', icon: 'refresh' },
      { label: 'Fertig', value: 'ok', variant: 'primary' },
    ],
  });
  if (r === 'undo') {
    try {
      const u = await withFortniteClosed(env, () => env.call('backups.restore', { id: result.backupId }));
      if (u?.ok) ui.toast('Vorheriger Zustand wiederhergestellt.');
      else if (u) ui.toast('Wiederherstellen nicht vollständig – bitte Zeitmaschine prüfen.', 'warn');
    } catch (e) { ui.showError(e); }
    env.refreshStatus?.();
  }
}

export { bindApplyButton };
