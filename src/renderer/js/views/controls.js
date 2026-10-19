// Tasten & Sensi eines Profils: was im Spiel noch anders ist und die ganze Belegung.
// HELIX liest dafür nur die ClientSettings-Kopie auf dem PC – im Spiel einstellen musst du selbst,
// weil Fortnite diese Werte beim Einloggen aus der Epic-Cloud holt.

function keys(h, list) {
  return h('span.keys', list.length ? list.map((k) => h('kbd', k)) : h('span.hint', 'nicht belegt'));
}

function changeRow(h, icon, r, isKeys) {
  return h('li.ctl-row',
    h('span.ctl-name', r.label),
    h('span.ctl-change',
      isKeys ? keys(h, r.from) : h('span.ctl-old', r.from),
      icon('chevron', 14),
      isKeys ? keys(h, r.to) : h('strong', r.to)));
}

/** Liste "im Spiel einstellen" – für das Ergebnis nach dem Anwenden und die Detailansicht. */
export function controlsDiffBox(env, ctl) {
  const { h, icon } = env.ui;
  const ui = env.ui;
  if (!ctl?.available) return null;
  if (!ctl.profile?.ok) {
    return h('div.callout', icon('info'), h('div',
      h('strong', 'Tasten & Sensi: nicht lesbar'),
      h('p.hint', 'HELIX konnte die Tastenbelegung in diesem Profil nicht auslesen. Speicher das Profil nach dem nächsten Spielen neu (Profil → Aktualisieren).')));
  }
  if (!ctl.diff) {
    return h('div.callout', icon('info'), h('div',
      h('strong', 'Tasten & Sensi'),
      h('p.hint', 'Keine aktuelle Kopie auf dem PC zum Vergleichen. Die ganze Belegung siehst du unter „Tasten & Sensi“ beim Profil.')));
  }
  const d = ctl.diff;
  if (!d.count) {
    return h('div.callout.ok', icon('check'), h('div',
      h('strong', 'Tasten & Sensi passen schon'),
      h('p.hint', 'Kein Unterschied zu deinem letzten Stand im Spiel.')));
  }
  return h('div.ctl-diff',
    h('div.callout.warn', icon('mouse'), h('div',
      h('strong', `Im Spiel noch einstellen (${d.count})`),
      h('p.hint', 'Fortnite holt Tasten und Sensi aus der Epic-Cloud. Stell nur diese Punkte im Spiel um – dann passt alles.'),
      ui.more('Warum geht das nicht automatisch?',
        'Tasten und Sensi gehören zu deinem Epic-Konto und liegen in der Cloud. Beim Einloggen ersetzt Fortnite die Kopie auf dem PC. Ändern geht nur im Spiel selbst – HELIX zeigt dir dafür genau, was anders ist.',
        'Verglichen wird mit deinem letzten Stand im Spiel (der Kopie auf dem PC).'))),
    d.binds.length ? h('h4', 'Tasten  ·  Einstellungen → Tastatursteuerung') : null,
    d.binds.length ? h('ul.list.ctl-list', d.binds.map((r) => changeRow(h, icon, r, true))) : null,
    d.sens.length ? h('h4', 'Sensi  ·  Einstellungen → Maus & Tastatur') : null,
    d.sens.length ? h('ul.list.ctl-list', d.sens.map((r) => changeRow(h, icon, r, false))) : null,
    d.other.length ? ui.more(`Weitere Werte (${d.other.length})`, h('ul.list.ctl-list', d.other.map((r) => changeRow(h, icon, r, false)))) : null);
}

/** Fenster "Tasten & Sensi" für ein Profil. */
export async function showControls(env, p) {
  const ui = env.ui;
  const { h, icon } = ui;
  let ctl;
  try { ctl = await env.call('profiles.controls', { id: p.id }); } catch (e) { ui.showError(e); return; }
  let content;
  if (!ctl.available) {
    content = [h('div.callout', icon('info'), h('div',
      h('strong', 'Keine Tastenbelegung im Profil'),
      h('p.hint', 'Dieses Profil enthält keine ClientSettings-Datei. Spiel einmal mit dem Konto, schließ Fortnite und speicher das Profil neu.')))];
  } else {
    const v = ctl.profile;
    content = [
      controlsDiffBox(env, ctl),
      v.ok && v.sens.length ? h('h4', 'Sensi im Profil') : null,
      v.ok && v.sens.length ? h('ul.list.ctl-list', v.sens.map((s) => h('li.ctl-row', h('span.ctl-name', s.label), h('strong', s.value)))) : null,
      v.ok && v.binds.length ? h('h4', `Tastenbelegung im Profil (${v.binds.length})`) : null,
      v.ok && v.binds.length ? h('ul.list.ctl-list.ctl-all', v.binds.map((b) => h('li.ctl-row', h('span.ctl-name', { title: b.action }, b.label), keys(h, b.keys)))) : null,
      v.ok && v.other.length ? ui.more(`Weitere Werte (${v.other.length})`, h('ul.list.ctl-list', v.other.map((s) => h('li.ctl-row', h('span.ctl-name', s.label), h('span', s.value))))) : null,
    ];
  }
  await ui.modal({
    title: `Tasten & Sensi – „${p.name}“`,
    subtitle: 'Aus der gesicherten Kopie gelesen',
    wide: true,
    content,
    actions: [{ label: 'Schließen', variant: 'primary' }],
  });
}
