// Replay-Tresor: Aktionen im Fortnite-Replay-Ordner brauchen ein geschlossenes Fortnite.
// Läuft es, bietet HELIX an, es normal zu schließen (wie im Cache-Cleaner). Ohne DOM, damit testbar.

/**
 * Prüft, ob Fortnite zu ist. Läuft es, fragt HELIX nach und schließt es auf Wunsch.
 * env: { call, ui: { confirmDialog, toast, showError } }; action: z. B. „das Replay löschen“.
 * Rückgabe: true = Fortnite ist zu, die Aktion kann weitergehen.
 */
export async function fortniteClosedFor(env, action) {
  const ui = env.ui;
  // Kann der Status nicht gelesen werden, prüft das Backend vor der Aktion selbst noch einmal.
  const st = await env.call('core.fortniteStatus').catch(() => ({ running: false }));
  if (!st || !st.running) return true;
  const ok = await ui.confirmDialog({
    title: 'Fortnite läuft noch',
    text: `Solange Fortnite offen ist, benutzt es seine Replay-Dateien. Soll HELIX Fortnite jetzt schließen? Danach kannst du ${action}.`,
    confirmLabel: 'Fortnite schließen',
  });
  if (!ok) return false;
  const r = await env.call('core.fortniteClose', { force: false }).catch((e) => { ui.showError(e, 'Fortnite schließen nicht möglich'); return null; });
  if (!r) return false;
  if (!r.closed) {
    ui.toast('Fortnite hat sich nicht beendet. Bitte schließe es im Spiel selbst und versuche es dann nochmal.', 'warn', { timeout: 6000 });
    return false;
  }
  ui.toast('Fortnite ist geschlossen.');
  return true;
}

/** Fehlertext ohne Versprechen, das die Replay-Ansicht nicht einlösen kann. */
export function replayError(err) {
  if (err && err.code === 'FORTNITE_RUNNING') {
    return { code: err.code, message: 'Fortnite läuft noch. Schließe Fortnite und versuche es dann nochmal.' };
  }
  return err;
}
