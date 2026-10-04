// Ansicht "Support-Text": fertiger Text für den Epic-Support auf Deutsch oder Englisch.
(function () {
  'use strict';
  const { el, icon, clear, copyButton, openUrl, segmented, pageHead, callout, toast } = window.UI;
  const F = window.KR_FIELDS;
  const S = window.KR_SUPPORT;
  const { URLS } = window.KR_STEPS;

  let root = null;

  // Selbst geänderte Texte werden pro Sprache und Textart gespeichert (überleben auch einen Neustart)
  function editKey() {
    const s = settings();
    return s.lang + ':' + s.variant;
  }

  function editedText() {
    const e = settings().edited || {};
    return Object.prototype.hasOwnProperty.call(e, editKey()) ? e[editKey()] : null;
  }

  function setEdited(text) {
    const key = editKey();
    window.Store.update((st) => {
      if (!st.support.edited) st.support.edited = {};
      if (text === null) delete st.support.edited[key];
      else st.support.edited[key] = text;
    }, 'support-edit');
  }

  function settings() {
    return window.Store.get().support;
  }

  // Aussagen wie "Postfach abgesichert" kommen nur in den Text, wenn sie stimmen
  function facts() {
    const st = window.Store.get();
    const f = st.support.facts || {};
    return {
      emailSecured: f.emailSecured != null ? f.emailSecured : Boolean(st.recovery && st.recovery.done && st.recovery.done.email),
      notShared: Boolean(f.notShared),
    };
  }

  function generated() {
    const s = settings();
    return S.build(window.Store.get().data, { lang: s.lang, variant: s.variant, facts: facts() });
  }

  function factsPicker() {
    const f = facts();
    const wrap = el('div', { class: 'stack-sm' });
    const items = [
      { key: 'emailSecured', label: 'Ich habe mein E-Mail-Postfach abgesichert' },
      { key: 'notShared', label: 'Ich habe mein Passwort nie weitergegeben' },
    ];
    for (const it of items) {
      const input = el('input', { type: 'checkbox', checked: f[it.key], fk: 'fact-' + it.key });
      input.addEventListener('change', () => {
        window.Store.update((st) => {
          if (!st.support.facts) st.support.facts = {};
          st.support.facts[it.key] = input.checked;
        }, 'support');
        render();
      });
      wrap.appendChild(el('label', { class: 'check' }, [input, el('span', { text: it.label })]));
    }
    return wrap;
  }

  function setSetting(key, value) {
    window.Store.update((st) => { st.support[key] = value; }, 'support');
    render();
  }

  function variantPicker() {
    const s = settings();
    const wrap = el('div', { class: 'stack-sm', role: 'radiogroup', 'aria-label': 'Art des Textes' });
    for (const v of S.VARIANTS) {
      const input = el('input', { type: 'radio', name: 'variant', checked: s.variant === v.key, fk: 'variant-' + v.key });
      input.addEventListener('change', () => { if (input.checked) setSetting('variant', v.key); });
      wrap.appendChild(el('label', { class: 'check' }, [
        input,
        el('span', { class: 'stack-sm' }, [el('strong', { text: v.label }), el('span', { class: 'hint', text: v.hint })]),
      ]));
    }
    return wrap;
  }

  function changesPicker() {
    const d = window.Store.get().data;
    const wrap = el('div', { class: 'stack-sm' });
    for (const c of F.HACK_CHANGES) {
      const input = el('input', { type: 'checkbox', checked: (d.hack_changes || []).includes(c.key), fk: 'change-' + c.key });
      input.addEventListener('change', () => {
        window.Store.update((st) => {
          const set = new Set(st.data.hack_changes || []);
          if (input.checked) set.add(c.key); else set.delete(c.key);
          st.data.hack_changes = F.HACK_CHANGES.map((x) => x.key).filter((k) => set.has(k));
        }, 'support');
        render();
      });
      wrap.appendChild(el('label', { class: 'check' }, [input, el('span', { text: c.label })]));
    }
    return wrap;
  }

  function missingBlock(missing) {
    if (!missing.length) {
      return callout('success', 'Alle wichtigen Angaben sind drin', 'Du kannst den Text so abschicken. Lies ihn trotzdem einmal durch.');
    }
    const list = el('div', { class: 'missing-list' });
    for (const key of missing) {
      const f = F.byKey(key);
      list.appendChild(el('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          const changed = await window.Views.data.editFieldDialog(key);
          if (changed) render();
        },
      }, [icon('plus', 'icon-sm'), f ? f.label : key]));
    }
    return el('div', { class: 'callout callout-warning' }, [
      icon('warning'),
      el('div', { class: 'stack-sm' }, [
        el('div', { class: 'callout-title', text: 'Diese Angaben fehlen noch' }),
        el('p', { text: 'Ohne sie kann Epic dein Konto schwerer zuordnen. Klick auf eine Angabe, um sie einzutragen.' }),
        list,
      ]),
    ]);
  }

  function render() {
    if (!root) return;
    window.UI.keepFocus(root, draw);
  }

  function draw() {
    const s = settings();
    const out = generated();
    const own = editedText();
    const body = own !== null ? own : out.body;

    const head = pageHead('Support-Text', 'Fertiger Text für den Epic-Support. Er füllt sich automatisch mit deinen Daten.');
    const important = callout('warning', 'Wichtig: Dein Konto bekommst du nur über das Wiederherstellungsformular zurück',
      'Das beantragst du unter "Konto retten" im Schritt "Wiederherstellung bei Epic beantragen". Der Support kann das nicht abkürzen. Diesen Text brauchst du für alles andere: fremde Käufe, ein fremdes verknüpftes Konto oder Probleme nach der Rettung.');

    const settingsCard = el('section', { class: 'card stack' }, [
      el('div', { class: 'stack-sm' }, [
        el('h2', { class: 'card-title', text: 'Sprache' }),
        segmented([{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'Englisch' }], s.lang, (v) => setSetting('lang', v)),
        el('p', { class: 'hint', text: 'Englisch wird beim Epic-Support oft schneller bearbeitet.' }),
      ]),
      el('div', { class: 'stack-sm' }, [el('h2', { class: 'card-title', text: 'Art des Textes' }), variantPicker()]),
      el('div', { class: 'stack-sm' }, [el('h2', { class: 'card-title', text: 'Was ist passiert?' }), changesPicker()]),
      el('div', { class: 'stack-sm' }, [
        el('h2', { class: 'card-title', text: 'Stimmt das?' }),
        el('p', { class: 'hint', text: 'Nur was du anhakst, steht im Text. Schreib nichts, was nicht stimmt.' }),
        factsPicker(),
      ]),
    ]);

    const subjectInput = el('input', { class: 'input', type: 'text', value: out.subject, readonly: true, 'aria-label': 'Betreff' });
    const textarea = el('textarea', { class: 'textarea support-text', spellcheck: 'false', 'aria-label': 'Support-Text' });
    textarea.value = body;
    const editNote = el('div', { class: 'row row-between' });
    function updateEditNote() {
      clear(editNote);
      if (editedText() !== null) {
        editNote.appendChild(el('span', { class: 'hint', text: 'Du hast den Text selbst geändert. Neue Daten aus "Meine Daten" kommen erst rein, wenn du ihn neu erstellst.' }));
        editNote.appendChild(el('button', {
          class: 'btn btn-sm btn-ghost',
          type: 'button',
          onclick: async () => {
            const yes = await window.UI.confirmDialog({
              title: 'Text neu erstellen?',
              text: 'Deine eigenen Änderungen an diesem Text gehen dabei verloren.',
              confirmText: 'Neu erstellen',
              danger: true,
            });
            if (!yes) return;
            setEdited(null);
            render();
          },
        }, [icon('refresh', 'icon-sm'), 'Text neu erstellen']));
      }
    }
    textarea.addEventListener('input', () => {
      const first = editedText() === null;
      setEdited(textarea.value);
      if (first) updateEditNote();
    });
    updateEditNote();

    const textCard = el('section', { class: 'card stack' }, [
      missingBlock(out.missing),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Betreff' }),
        el('div', { class: 'input-row' }, [subjectInput, copyButton(() => subjectInput.value, 'Betreff')]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'field-label', text: 'Text' }),
        textarea,
        editNote,
      ]),
      el('div', { class: 'row' }, [
        copyButton(() => textarea.value, 'Support-Text', { primary: true, text: 'Text kopieren' }),
        el('button', { class: 'btn', type: 'button', onclick: () => openUrl(URLS.contactUs) }, [icon('external'), 'Epic-Support öffnen']),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: async () => {
            const name = 'Epic Support-Text ' + (s.lang === 'en' ? 'EN' : 'DE') + '.txt';
            const res = await window.kr.exportText(name, out.subject + '\n\n' + textarea.value);
            if (res && res.ok && res.value) toast('Gespeichert: ' + res.value, 'success');
            else if (res && !res.ok) toast(res.message, 'error');
          },
        }, [icon('save'), 'Als Datei speichern']),
      ]),
      callout('danger', 'Niemals Passwort oder Codes mitschicken', 'Der Text enthält absichtlich kein Passwort. Epic fragt nie danach. Wer danach fragt, ist ein Betrüger.'),
    ]);

    clear(root).appendChild(el('div', { class: 'page' }, [head, important, el('div', { class: 'support-layout' }, [settingsCard, textCard])]));
  }

  window.Views = window.Views || {};
  window.Views.support = {
    id: 'support',
    label: 'Support-Text',
    hint: 'Deutsch und Englisch',
    icon: 'message',
    mount(container) {
      root = container;
      render();
    },
    unmount() { root = null; },
    refresh: render,
  };
})();
