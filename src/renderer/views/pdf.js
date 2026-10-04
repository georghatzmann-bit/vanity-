// Ansicht "PDF auslesen": PDF hineinziehen, Daten werden erkannt und unter "Meine Daten" eingetragen.
(function () {
  'use strict';
  const { el, icon, clear, toast, confirmDialog, pageHead, callout, formatDate, copyButton } = window.UI;
  const F = window.KR_FIELDS;

  let root = null;
  let busy = false;
  const results = []; // nur für diese Sitzung, der Text der PDFs wird nicht gespeichert
  let resultCounter = 0;
  let generation = 0; // steigt bei "Alle Daten löschen": noch laufende Lesevorgänge werden dann verworfen

  function data() {
    return window.Store.get().data;
  }

  function same(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  // Wie passt ein gefundener Wert zu dem, was schon eingetragen ist?
  function statusOf(item) {
    if (!item.target) return 'info';
    const field = F.byKey(item.target);
    if (!field) return 'info';
    if (field.type === 'list') {
      if (F.listValue(data(), item.target).some((v) => same(v, item.value))) return 'present';
      return item.auto ? 'apply' : 'suggest';
    }
    const current = F.valueAsText(data(), item.target);
    if (same(current, item.value)) return 'present';
    if (!current) return item.auto ? 'apply' : 'suggest';
    return 'conflict';
  }

  // Trägt einen Wert ein und merkt sich genau diese Änderung, damit "Rückgängig" nur sie zurücknimmt.
  function applyValue(result, target, value) {
    const field = F.byKey(target);
    if (!field) return;
    let change = null;
    window.Store.update((s) => {
      if (field.type === 'list') {
        const list = F.listValue(s.data, target);
        if (!list.some((v) => same(v, value))) {
          list.push(value);
          change = { target, value, list: true };
        }
        s.data[target] = list;
      } else {
        change = { target, value, before: F.valueAsText(s.data, target) };
        s.data[target] = value;
      }
    }, 'pdf');
    if (change) result.applied.push(change);
  }

  function undo(result) {
    let kept = 0;
    window.Store.update((s) => {
      // In umgekehrter Reihenfolge zurücknehmen
      for (const c of result.applied.slice().reverse()) {
        if (c.list) {
          s.data[c.target] = F.listValue(s.data, c.target).filter((v) => !same(v, c.value));
        } else if (same(F.valueAsText(s.data, c.target), c.value)) {
          s.data[c.target] = c.before;
        } else {
          kept += 1; // inzwischen von Hand geändert: so lassen
        }
      }
    }, 'pdf');
    result.applied = [];
    result.undone = true;
    toast('Übernahme aus "' + result.fileName + '" rückgängig gemacht.' + (kept ? ' Von dir geänderte Werte wurden behalten.' : ''), 'info');
    render();
  }

  function addResult(res) {
    const result = { id: ++resultCounter, ...res, applied: [], undone: false };
    // Sichere Werte sofort in leere Felder eintragen
    let count = 0;
    for (const item of res.found.items) {
      if (statusOf(item) === 'apply') {
        applyValue(result, item.target, item.value);
        count += 1;
      }
    }
    result.autoCount = count;
    results.unshift(result);
    window.Store.update((s) => {
      s.pdf.imports.unshift({ fileName: res.fileName, at: new Date().toISOString(), kind: res.found.kindLabel, found: res.found.items.length, applied: count });
      s.pdf.imports = s.pdf.imports.slice(0, 20);
    }, 'pdf');
    const n = res.found.items.filter((i) => i.target).length;
    if (count) toast(count + (count === 1 ? ' Angabe' : ' Angaben') + ' erkannt und unter "Meine Daten" eingetragen.', 'success');
    else if (n) toast(n + (n === 1 ? ' Angabe' : ' Angaben') + ' erkannt. Bitte prüfen und übernehmen.', 'info');
    else toast('In "' + res.fileName + '" wurden keine Kontodaten erkannt.', 'warning');
  }

  async function askPassword(fileName, wrong) {
    const input = el('input', { class: 'input mono', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Passwort der PDF' });
    let value = '';
    input.addEventListener('input', () => { value = input.value; });
    const body = el('div', { class: 'stack-sm' }, [
      wrong ? callout('danger', 'Das Passwort passt nicht', 'Kopiere es nochmal genau aus der Mail. Achte auf Leerzeichen am Anfang oder Ende.') : null,
      el('p', { class: 'muted', text: 'Epic schützt die Konto-PDF mit einem Passwort. Es steht in einer eigenen Mail von Epic (meist 32 Zeichen lang). Kopiere es dort und füge es hier ein.' }),
      input,
      el('p', { class: 'hint', text: 'Das Passwort wird nur zum Öffnen benutzt und nirgends gespeichert.' }),
    ]);
    const pending = confirmDialog({ title: '"' + fileName + '" ist geschützt', body, confirmText: 'PDF öffnen' });
    setTimeout(() => input.focus(), 30);
    const yes = await pending;
    return yes && value.trim() ? value.trim() : null;
  }

  // Liest eine Datei – entweder als Bytes (Drag and Drop) oder über die Dateiauswahl.
  const MAX_PASSWORD_TRIES = 5;

  async function readOne(source) {
    let password;
    let wrongTries = 0;
    for (;;) {
      const res = source.bytes
        ? await window.kr.pdf.parseBytes(source.fileName, source.bytes, password)
        : await window.kr.pdf.parsePicked(source.token, password);
      if (res && res.ok) return res.value;
      if (res && (res.code === 'NEED_PASSWORD' || res.code === 'WRONG_PASSWORD')) {
        const wrong = res.code === 'WRONG_PASSWORD';
        if (wrong) wrongTries += 1;
        if (wrongTries >= MAX_PASSWORD_TRIES) {
          toast('Das Passwort für "' + source.fileName + '" hat ' + MAX_PASSWORD_TRIES + '-mal nicht gepasst. Zieh die PDF nochmal hinein und kopiere das Passwort genau aus der Epic-Mail.', 'error');
          return null;
        }
        password = await askPassword(source.fileName, wrong);
        if (!password) {
          toast('"' + source.fileName + '" wurde nicht geöffnet (kein Passwort).', 'warning');
          return null;
        }
        continue;
      }
      toast('"' + source.fileName + '": ' + ((res && res.message) || 'Datei konnte nicht gelesen werden.'), 'error');
      return null;
    }
  }

  // Dateien, die während des Lesens dazukommen, werden hinten angestellt statt verworfen
  const queue = [];

  async function handleSources(sources) {
    if (!sources.length) return;
    queue.push(...sources);
    if (busy) {
      toast(sources.length === 1 ? '"' + sources[0].fileName + '" wird gleich gelesen.' : sources.length + ' Dateien werden gleich gelesen.', 'info');
      return;
    }
    busy = true;
    render();
    try {
      while (queue.length) {
        const source = queue.shift();
        const gen = generation;
        const value = await readOne(source);
        if (value && gen === generation) addResult(value);
        render();
      }
    } finally {
      busy = false;
      render();
    }
  }

  async function onDrop(fileList) {
    const sources = [];
    for (const file of fileList) {
      if (!/\.(pdf|txt|eml)$/i.test(file.name)) {
        toast('"' + file.name + '" ist keine PDF und wurde übersprungen.', 'warning');
        continue;
      }
      if (file.size > 50 * 1024 * 1024) {
        toast('"' + file.name + '" ist größer als 50 MB und wurde übersprungen.', 'warning');
        continue;
      }
      sources.push({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    await handleSources(sources);
  }

  async function onPick() {
    const res = await window.kr.pdf.pick();
    if (!res || !res.ok) {
      toast((res && res.message) || 'Dateiauswahl hat nicht geklappt.', 'error');
      return;
    }
    await handleSources(res.value);
  }

  // ---------- Darstellung ----------

  function dropZone() {
    const zone = el('div', {
      class: 'drop' + (busy ? ' busy' : ''),
      tabindex: '0',
      role: 'button',
      'aria-label': 'PDF auswählen oder hier hineinziehen',
    }, [
      icon('upload'),
      el('div', { class: 'drop-title', text: busy ? 'PDF wird gelesen …' : 'PDF hier hineinziehen' }),
      el('div', { class: 'muted', text: busy ? 'Einen Moment bitte.' : 'oder klicken, um eine Datei auszuwählen' }),
      el('div', { class: 'hint', text: 'Geht mit: Epic-Kontodaten (PDF), Epic-Kaufbelegen, gespeicherten Epic-Kontoseiten, Epic-Mails und Konsolen-Kaufbelegen.' }),
    ]);
    zone.addEventListener('click', onPick);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); }
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('over');
      onDrop(Array.from(e.dataTransfer.files || []));
    });
    return zone;
  }

  function itemRow(result, item) {
    const status = statusOf(item);
    const field = item.target ? F.byKey(item.target) : null;
    const actions = el('div', { class: 'row' });
    let statusIcon;
    if (status === 'present') {
      statusIcon = icon('checkCircle');
      statusIcon.classList.add('ok-icon');
      actions.appendChild(el('span', { class: 'badge badge-success', text: 'Eingetragen' }));
    } else if (status === 'info') {
      statusIcon = icon('info');
      actions.appendChild(copyButton(item.value, item.label, { small: true }));
    } else {
      statusIcon = icon(status === 'conflict' ? 'warning' : 'plus');
      const label = status === 'conflict' ? 'Ersetzen' : 'Übernehmen';
      actions.appendChild(el('button', {
        class: 'btn btn-sm ' + (status === 'conflict' ? '' : 'btn-primary'),
        type: 'button',
        onclick: () => {
          applyValue(result, item.target, item.value);
          toast((field ? field.label : item.label) + ' übernommen.', 'success');
          render();
        },
      }, label));
      if (status === 'conflict' && item.target === 'email_original') {
        actions.appendChild(el('button', {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => {
            applyValue(result, 'emails_old', item.value);
            toast('Als weitere E-Mail-Adresse gespeichert.', 'success');
            render();
          },
        }, 'Als weitere Adresse'));
      }
    }
    const current = field && status === 'conflict' ? F.valueAsText(data(), item.target) : '';
    const valueBox = el('div', { class: 'stack-sm' }, [
      el('div', { class: 'found-value', text: item.value }),
      current ? el('div', { class: 'found-old', text: 'Bisher eingetragen: ' + current }) : null,
      item.note ? el('div', { class: 'found-old', text: item.note }) : null,
    ]);
    return el('div', { class: 'found-item' }, [
      statusIcon,
      el('div', { class: 'found-label' }, [item.label, item.confidence === 'medium' && status !== 'info' ? el('div', { class: 'hint', text: 'bitte prüfen' }) : null]),
      valueBox,
      actions,
    ]);
  }

  function resultCard(result) {
    const items = result.found.items;
    const dataItems = items.filter((i) => i.target);
    const infoItems = items.filter((i) => !i.target);
    const open = dataItems.filter((i) => ['suggest', 'conflict'].includes(statusOf(i)));
    const done = dataItems.filter((i) => statusOf(i) === 'present');

    const head = el('div', { class: 'row row-between' }, [
      el('div', { class: 'stack-sm' }, [
        el('div', { class: 'row' }, [icon('file'), el('strong', { text: result.fileName })]),
        el('div', { class: 'row' }, [
          el('span', { class: 'badge badge-accent', text: result.found.kindLabel }),
          result.pages ? el('span', { class: 'hint', text: result.pages + (result.pages === 1 ? ' Seite' : ' Seiten') }) : null,
        ]),
      ]),
      result.applied.length ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => undo(result) }, [icon('refresh', 'icon-sm'), 'Übernahme rückgängig']) : null,
    ]);

    const card = el('section', { class: 'card stack' }, [head]);

    if (result.scanned) {
      card.appendChild(callout('warning', 'In dieser PDF ist kein Text', 'Das ist vermutlich ein eingescanntes Bild oder ein Foto. Dann kann nichts automatisch erkannt werden. Trag die Werte bitte unter "Meine Daten" selbst ein.'));
    } else if (!items.length) {
      card.appendChild(callout('warning', 'Keine Kontodaten erkannt', 'Schau dir unten den erkannten Text an und trag wichtige Werte unter "Meine Daten" selbst ein.'));
    } else if (result.undone) {
      card.appendChild(callout('info', 'Übernahme rückgängig gemacht', 'Du kannst einzelne Werte unten trotzdem übernehmen.'));
    } else if (result.autoCount) {
      card.appendChild(callout('success', result.autoCount + (result.autoCount === 1 ? ' Angabe wurde' : ' Angaben wurden') + ' automatisch eingetragen',
        open.length ? 'Bei ' + open.length + (open.length === 1 ? ' weiterer Angabe' : ' weiteren Angaben') + ' entscheidest du selbst, ob sie stimmen.' : 'Alles erkannt und eingetragen.'));
    } else if (open.length) {
      card.appendChild(callout('info', 'Bitte prüfen', 'Schau dir die Werte an und übernimm, was stimmt.'));
    }

    if (open.length) {
      card.appendChild(el('h3', { class: 'card-title', text: 'Bitte prüfen' }));
      card.appendChild(el('div', { class: 'found-list' }, open.map((i) => itemRow(result, i))));
    }
    if (done.length) {
      card.appendChild(el('h3', { class: 'card-title', text: 'Unter "Meine Daten" eingetragen' }));
      card.appendChild(el('div', { class: 'found-list' }, done.map((i) => itemRow(result, i))));
    }
    if (infoItems.length) {
      card.appendChild(el('h3', { class: 'card-title', text: 'Zur Info' }));
      card.appendChild(el('p', { class: 'hint', text: result.found.kind === 'account-export' ? 'Aus dem Kontoverlauf: Hier siehst du, wann was geändert wurde. Das hilft, den Zeitpunkt des Hacks zu belegen.' : 'Diese Angaben werden nicht gespeichert, können aber für den Support nützlich sein.' }));
      card.appendChild(el('div', { class: 'found-list' }, infoItems.map((i) => itemRow(result, i))));
    }

    if (result.text) {
      card.appendChild(el('details', null, [
        el('summary', { text: 'Erkannten Text anzeigen' }),
        el('pre', { class: 'raw-text', text: result.text.slice(0, 20000) + (result.text.length > 20000 ? '\n…' : '') }),
      ]));
    }
    return card;
  }

  function historyCard() {
    const imports = window.Store.get().pdf.imports || [];
    if (!imports.length) return null;
    return el('section', { class: 'card stack-sm' }, [
      el('h2', { class: 'card-title', text: 'Zuletzt ausgelesen' }),
      el('p', { class: 'hint', text: 'Nur die Liste wird gespeichert, nicht der Inhalt der Dateien.' }),
      ...imports.slice(0, 6).map((imp) => el('div', { class: 'row row-between' }, [
        el('span', { text: imp.fileName }),
        el('span', { class: 'hint', text: (imp.kind ? imp.kind + ' · ' : '') + formatDate(imp.at) + ' · ' + imp.applied + ' eingetragen' }),
      ])),
    ]);
  }

  function render() {
    if (!root) return;
    const head = pageHead('PDF auslesen', 'Zieh deine Epic-Konto-PDF oder Kaufbelege hier hinein. Die wichtigen Daten werden automatisch erkannt und unter "Meine Daten" eingetragen.');
    const page = el('div', { class: 'page' }, [head, dropZone()]);
    if (!results.length) {
      page.appendChild(el('section', { class: 'card stack' }, [
        el('h2', { class: 'card-title', text: 'Woher bekomme ich die Konto-PDF?' }),
        el('ol', { class: 'todo-list' }, [
          el('li', { text: 'Auf epicgames.com anmelden (geht nur, solange du noch reinkommst oder nachdem du das Konto zurückhast).' }),
          el('li', { text: 'Kontoeinstellungen öffnen und nach unten zu "Kontoinformationen herunterladen" scrollen.' }),
          el('li', { text: 'Auf "Download anfordern" klicken. Epic schickt dir eine Mail mit dem Link und eine zweite Mail mit dem Passwort der PDF.' }),
        ]),
        callout('info', 'Kommst du nicht mehr ins Konto?', 'Dann such in deinem Postfach nach "Your Epic Games Receipt" und speichere die Mails als PDF (Drucken > Als PDF speichern). Die Rechnungsnummern darin sind der beste Beweis.'),
      ]));
    }
    for (const r of results) page.appendChild(resultCard(r));
    const hist = historyCard();
    if (hist) page.appendChild(hist);
    clear(root).appendChild(page);
  }

  // "Alle Daten löschen": auch die erkannten Werte und den PDF-Text dieser Sitzung vergessen
  window.Store.subscribe((_state, source) => {
    if (source !== 'reset') return;
    generation += 1;
    results.length = 0;
    queue.length = 0;
    render();
  });

  // Dateien, die irgendwo im Fenster fallen gelassen werden, nicht im Programm öffnen
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length && window.App) {
      const files = Array.from(e.dataTransfer.files);
      window.App.go('pdf');
      onDrop(files);
    }
  });

  window.Views = window.Views || {};
  window.Views.pdf = {
    id: 'pdf',
    label: 'PDF auslesen',
    hint: 'Daten automatisch erkennen',
    icon: 'file',
    mount(container) {
      root = container;
      render();
    },
    unmount() { root = null; },
    refresh: render,
  };
})();
