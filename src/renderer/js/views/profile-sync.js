// Nach einer Änderung durch ein Tool (Sicht-Preset, Maus, PC-Check …): anbieten, den neuen Stand auch
// im aktiven Settings-Profil zu speichern. Sonst bringt das nächste Anwenden des Profils die alten Werte zurück.

/**
 * Liefert sofort einen (noch leeren) Kasten und füllt ihn, sobald klar ist, ob ein Profil aktiv ist.
 * Ohne aktives Profil bleibt er leer.
 * memo: Objekt der Ansicht, das sich über neu gezeichnete Kästen merkt, dass schon gespeichert wurde.
 */
export function profileSyncBox(env, memo = {}) {
  const { h, icon } = env.ui;
  const ui = env.ui;
  const box = h('div.profile-sync');

  function render(active, saved) {
    ui.clear(box);
    if (!active) return;
    box.append(saved
      ? h('div.row', ui.badge(`im Profil „${active.name}“ gespeichert`, 'ok'),
        h('span.hint', 'Das Profil bringt diese Werte beim nächsten Anwenden mit.'))
      : h('div',
        h('div.row', ui.button(`Auch im aktiven Profil „${active.name}“ speichern`, {
          small: true, variant: 'primary', iconName: 'download', onClick: () => save(active),
        })),
        h('p.hint', icon('info', 14), ` Sonst holt das Profil „${active.name}“ beim nächsten Anwenden die alten Werte zurück. Gespeichert wird der jetzige Stand deiner Fortnite-Einstellungen.`)));
  }

  async function save(active) {
    try {
      await env.call('profiles.update', { id: active.id });
      ui.toast(`Profil „${active.name}“ wurde mit den neuen Einstellungen gespeichert.`);
      env.refreshStatus?.();
      memo.savedId = active.id;
      render(active, true);
    } catch (e) {
      ui.showError(e, 'Profil nicht gespeichert');
    }
  }

  env.call('core.status')
    .then((st) => render(st?.active || null, !!st?.active && memo.savedId === st.active.id))
    .catch(() => {});
  return box;
}
