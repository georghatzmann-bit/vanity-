// Ansicht "Meine Daten": alle Angaben zum Konto an einer Stelle, mit Kopieren-Knopf.
(function () {
  'use strict';
  const { el, icon, clear, copyButton, confirmDialog, toast, pageHead, callout } = window.UI;
  const F = window.KR_FIELDS;

  let root = null;

  function data() {
    return window.Store.get().data;
  }

  // Liste als Text ins Eingabefeld, Text aus dem Eingabefeld zurück in eine Liste.
  function toInputValue(field, value) {
    if (field.type === 'list') return Array.isArray(value) ? value.join('\n') : String(value || '');
    return String(value || '');
  }

  function fromInputValue(field, text) {
    if (field.type === 'list') return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return text;
  }

  function fieldControl(field, value, onInput) {
    const multi = field.type === 'list' || field.type === 'multiline';
    const control = el(multi ? 'textarea' : 'input', {
      class: (multi ? 'textarea' : 'input') + (field.mono ? ' mono' : ''),
      id: 'f-' + field.key,
      placeholder: field.placeholder || '',
      spellcheck: 'false',
      type: multi ? null : 'text',
      rows: multi ? '3' : null,
    });
    control.value = toInputValue(field, value);
    control.addEventListener('input', () => onInput(control.value));
    return control;
  }

  function fieldBlock(field) {
    // Für Listen: Stand beim Hineinklicken. Was währenddessen von anderswo dazukommt
    // (z. B. aus einer PDF), wird beim Speichern dazugemischt statt überschrieben.
    let base = null;
    let atFocus = null;
    const mergedList = (text) => {
      const user = text.split(/\r?\n/);
      const userClean = user.map((x) => x.trim()).filter(Boolean);
      const extra = F.listValue(data(), field.key).filter((v) => !(base || []).includes(v) && !userClean.includes(v));
      return { raw: user.concat(extra), clean: userClean.concat(extra), extra };
    };
    const control = fieldControl(field, data()[field.key], (text) => {
      // Listen erst beim Verlassen säubern, damit Leerzeilen beim Tippen nicht verschwinden.
      if (field.type === 'list') {
        const m = mergedList(text);
        window.Store.update((s) => { s.data[field.key] = m.raw; }, 'data');
      } else {
        window.Store.update((s) => { s.data[field.key] = text; }, 'data');
      }
    });
    control.dataset.field = field.key;
    if (field.type === 'list') {
      control.addEventListener('focus', () => {
        atFocus = control.value;
        base = F.listValue(data(), field.key);
      });
      control.addEventListener('blur', () => {
        const m = mergedList(control.value);
        // Nur speichern, wenn der Nutzer etwas geändert hat oder etwas dazugekommen ist
        if ((atFocus !== null && control.value !== atFocus) || m.extra.length) {
          window.Store.update((s) => { s.data[field.key] = m.clean; }, 'data');
          control.value = m.clean.join('\n');
        }
        atFocus = null;
        base = null;
      });
    }
    return el('div', { class: 'field' }, [
      el('div', { class: 'row row-between' }, [
        el('label', { class: 'field-label', for: 'f-' + field.key, text: field.label }),
        copyButton(() => F.valueAsText(data(), field.key), field.label, { small: true }),
      ]),
      control,
      el('div', { class: 'field-hint', text: field.hint }),
    ]);
  }

  function hackChangesBlock() {
    const d = data();
    const wrap = el('div', { class: 'field' }, [
      el('div', { class: 'field-label', text: 'Was hat der Hacker verändert?' }),
      el('div', { class: 'field-hint', text: 'Hak alles an, was passiert ist. Das kommt automatisch in den Support-Text.' }),
    ]);
    const grid = el('div', { class: 'form-grid' });
    for (const c of F.HACK_CHANGES) {
      const input = el('input', { type: 'checkbox', checked: (d.hack_changes || []).includes(c.key) });
      input.addEventListener('change', () => {
        window.Store.update((s) => {
          const set = new Set(s.data.hack_changes || []);
          if (input.checked) set.add(c.key); else set.delete(c.key);
          s.data.hack_changes = F.HACK_CHANGES.map((x) => x.key).filter((k) => set.has(k));
        }, 'data');
      });
      grid.appendChild(el('label', { class: 'check' }, [input, el('span', { text: c.label })]));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function summaryText() {
    const d = data();
    const lines = ['Konto-Retter – meine Daten', 'Stand: ' + new Date().toLocaleString('de-DE'), ''];
    for (const g of F.GROUPS) {
      const fields = F.FIELDS.filter((f) => f.group === g.key && F.hasValue(d, f.key));
      if (!fields.length) continue;
      lines.push('== ' + g.title + ' ==');
      for (const f of fields) {
        const value = F.valueAsText(d, f.key);
        if (f.type === 'text') lines.push(f.label + ': ' + value);
        else lines.push(f.label + ':', ...value.split('\n').map((v) => '  - ' + v));
      }
      lines.push('');
    }
    const changes = F.HACK_CHANGES.filter((c) => (d.hack_changes || []).includes(c.key));
    if (changes.length) {
      lines.push('== Was der Hacker verändert hat ==');
      for (const c of changes) lines.push('  - ' + c.label);
    }
    return lines.join('\n').trim() + '\n';
  }

  function filledCount() {
    const d = data();
    return F.FIELDS.filter((f) => f.key !== 'notes' && F.hasValue(d, f.key)).length;
  }

  function render() {
    if (!root) return;
    const head = pageHead('Meine Daten', 'Alles, was Epic als Beweis braucht. Was die PDF-Auslese findet, landet automatisch hier. Gespeichert wird nur auf diesem PC.', [
      el('button', {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          const res = await window.kr.exportText('Konto-Retter Daten.txt', summaryText());
          if (res && res.ok && res.value) toast('Gespeichert: ' + res.value, 'success');
          else if (res && !res.ok) toast(res.message, 'error');
        },
      }, [icon('save'), 'Als Textdatei speichern']),
      copyButton(summaryText, 'Alle Daten', { text: 'Alles kopieren' }),
    ]);

    const page = el('div', { class: 'page' }, [head]);
    page.appendChild(callout('info', filledCount() + ' von ' + (F.FIELDS.length - 1) + ' Angaben ausgefüllt',
      'Du musst nicht alles wissen. Am wichtigsten sind Konto-ID, Rechnungsnummern, frühere E-Mail-Adressen und verknüpfte Konsolen. Gib hier niemals Passwörter ein.'));

    for (const g of F.GROUPS) {
      const card = el('section', { class: 'card form-group' }, [
        el('div', null, [el('h2', { class: 'card-title', text: g.title }), el('p', { class: 'card-sub', text: g.hint })]),
        el('div', { class: 'form-grid' }, F.FIELDS.filter((f) => f.group === g.key).map(fieldBlock)),
      ]);
      if (g.key === 'hack') card.appendChild(hackChangesBlock());
      page.appendChild(card);
    }

    page.appendChild(el('section', { class: 'card stack' }, [
      el('div', null, [
        el('h2', { class: 'card-title', text: 'Alles löschen' }),
        el('p', { class: 'card-sub', text: 'Löscht alle eingetragenen Daten und den Fortschritt auf diesem PC. Das lässt sich nicht rückgängig machen.' }),
      ]),
      el('div', null, el('button', {
        class: 'btn btn-danger',
        type: 'button',
        onclick: async () => {
          const yes = await confirmDialog({
            title: 'Wirklich alles löschen?',
            text: 'Alle Daten, Notizen und der Fortschritt werden von diesem PC gelöscht.',
            confirmText: 'Ja, alles löschen',
            danger: true,
          });
          if (!yes) return;
          await window.Store.reset();
          toast('Alle Daten wurden gelöscht.', 'success');
          render();
        },
      }, [icon('trash'), 'Alle Daten löschen'])),
    ]));

    clear(root).appendChild(page);
  }

  // Dialog zum schnellen Eintragen eines einzelnen Wertes (z. B. aus einem Rettungsschritt).
  async function editFieldDialog(key) {
    const field = F.byKey(key);
    if (!field) return false;
    let text = toInputValue(field, data()[key]);
    const control = fieldControl(field, data()[key], (v) => { text = v; });
    const body = el('div', { class: 'field' }, [
      el('label', { class: 'field-label', for: 'f-' + field.key, text: field.label }),
      control,
      el('div', { class: 'field-hint', text: field.hint }),
    ]);
    const pending = confirmDialog({ title: field.label + ' eintragen', body, confirmText: 'Speichern' });
    setTimeout(() => control.focus(), 30);
    const yes = await pending;
    if (!yes) return false;
    window.Store.update((s) => { s.data[key] = fromInputValue(field, text); }, 'data-dialog');
    toast(field.label + ' gespeichert.', 'success');
    return true;
  }

  // Wurde etwas anderswo geändert (z. B. eine PDF fertig gelesen), die Felder auffrischen –
  // aber nie das Feld, in dem gerade getippt wird.
  function syncFromStore() {
    if (!root) return;
    const d = data();
    for (const control of root.querySelectorAll('[data-field]')) {
      if (control === document.activeElement) continue;
      const field = F.byKey(control.dataset.field);
      const value = toInputValue(field, d[field.key]);
      if (field.type === 'list' ? F.listValue({ v: control.value }, 'v').join('\n') !== F.listValue(d, field.key).join('\n') : control.value !== value) {
        control.value = field.type === 'list' ? F.listValue(d, field.key).join('\n') : value;
      }
    }
  }

  let unsubscribe = null;

  window.Views = window.Views || {};
  window.Views.data = {
    id: 'data',
    label: 'Meine Daten',
    hint: 'Beweise für Epic',
    icon: 'user',
    mount(container) {
      root = container;
      render();
      unsubscribe = window.Store.subscribe((_s, source) => {
        if (source === 'reset') render();
        else if (source !== 'data' && source !== 'nav') syncFromStore();
      });
    },
    unmount() {
      root = null;
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
    },
    refresh: render,
    editFieldDialog,
    summaryText,
    badge() {
      return { text: String(filledCount()), done: false };
    },
  };
})();
