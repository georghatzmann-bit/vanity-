// Hält den Programmstand im Speicher und sichert ihn automatisch (kurz verzögert) auf die Festplatte.
(function () {
  'use strict';

  let state = null;
  let saveTimer = null;
  let saving = Promise.resolve();
  const listeners = new Set();

  async function load() {
    const res = await window.kr.state.load();
    if (!res || !res.ok) throw new Error((res && res.message) || 'Speicherstand konnte nicht geladen werden.');
    state = res.value;
    if (!state.data) state.data = window.KR_FIELDS.emptyData();
    return state;
  }

  function get() {
    return state;
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const snapshot = JSON.parse(JSON.stringify(state));
    saving = saving.then(() => window.kr.state.save(snapshot)).then((res) => {
      if (!res || !res.ok) window.UI.toast('Speichern hat nicht geklappt: ' + ((res && res.message) || 'unbekannter Fehler'), 'error');
    }).catch((err) => window.UI.toast('Speichern hat nicht geklappt: ' + err.message, 'error'));
    return saving;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 350);
  }

  // Ändert den Stand. "source" sagt, wer geändert hat – so kann eine Ansicht
  // ihre eigenen Änderungen ignorieren und muss sich nicht neu zeichnen.
  function update(mutator, source) {
    mutator(state);
    scheduleSave();
    for (const fn of listeners) {
      try { fn(state, source); } catch (err) { console.error(err); }
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function reset() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    await saving;
    const res = await window.kr.state.reset();
    if (res && res.ok) state = res.value;
    for (const fn of listeners) fn(state, 'reset');
    return state;
  }

  window.addEventListener('beforeunload', () => {
    if (saveTimer) flush();
  });

  window.Store = { load, get, update, subscribe, flush, reset };
})();
