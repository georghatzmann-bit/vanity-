// Ansicht "Konto retten": Schritt für Schritt durch die Kontowiederherstellung.
(function () {
  'use strict';
  const { el, icon, clear, callout, copyButton, openUrl, switchControl, formatDate, pageHead } = window.UI;
  const { STEPS, PHASES, EMAIL_PROVIDERS, providerForEmail, stepById, indexOf } = window.KR_STEPS;
  const F = window.KR_FIELDS;

  let root = null;

  function rec() {
    return window.Store.get().recovery;
  }

  function data() {
    return window.Store.get().data;
  }

  function currentStep() {
    const r = rec();
    const byId = r.current && stepById(r.current);
    if (byId) return byId;
    return STEPS.find((s) => !r.done[s.id]) || STEPS[0];
  }

  function doneCount() {
    const r = rec();
    return STEPS.filter((s) => r.done[s.id]).length;
  }

  // Welche Seite gehört zu diesem Schritt? Beim E-Mail-Schritt die Sicherheitsseite des eigenen Anbieters.
  function targetFor(step) {
    if (step.urlFromEmail) {
      const provider = providerForEmail(F.valueAsText(data(), step.urlFromEmail));
      if (provider) return { url: provider.url, label: 'Sicherheitsseite von ' + provider.name };
    }
    return { url: step.url, label: step.urlLabel };
  }

  // Wechselt zu einem Schritt und öffnet (wenn eingeschaltet) die passende Seite.
  function goTo(id, { open = true } = {}) {
    const prev = currentStep();
    const next = stepById(id);
    if (!next) return;
    window.Store.update((s) => {
      s.recovery.current = id;
      s.recovery.finished = false;
      if (!s.recovery.startedAt) s.recovery.startedAt = new Date().toISOString();
    }, 'recovery');
    render();
    if (open && rec().autoOpen) {
      const target = targetFor(next);
      // Gleiche Seite wie im Schritt davor? Dann ist sie schon offen.
      if (target.url && (prev.id === next.id || target.url !== targetFor(prev).url)) openUrl(target.url);
    }
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0;
  }

  function markDone(id, done) {
    window.Store.update((s) => {
      if (done) s.recovery.done[id] = new Date().toISOString();
      else delete s.recovery.done[id];
    }, 'recovery');
  }

  function nextOpenAfter(id) {
    const r = rec();
    const start = indexOf(id);
    for (let i = start + 1; i < STEPS.length; i++) if (!r.done[STEPS[i].id]) return STEPS[i];
    return STEPS.find((s) => !r.done[s.id]) || null;
  }

  function completeAndContinue(step) {
    markDone(step.id, true);
    const next = nextOpenAfter(step.id);
    if (next) goTo(next.id);
    else finish();
  }

  function skip(step) {
    const i = indexOf(step.id);
    const next = STEPS[i + 1];
    if (next) goTo(next.id);
    else finish();
  }

  function finish() {
    window.Store.update((s) => { s.recovery.finished = true; }, 'recovery');
    render();
  }

  // ---------- Daten groß anzeigen ----------

  function dataTile(key) {
    const field = F.byKey(key);
    if (!field) return null;
    const d = data();
    const label = field.label;
    const head = el('div', { class: 'data-tile-head' }, [el('span', { class: 'data-tile-label', text: label })]);
    const tile = el('div', { class: 'data-tile' }, head);

    if (field.type === 'list') {
      const items = F.listValue(d, key);
      if (!items.length) {
        tile.appendChild(el('div', { class: 'data-missing', text: 'Noch nicht eingetragen' }));
        head.appendChild(editButton(key, 'Eintragen'));
        return tile;
      }
      if (items.length > 1) head.appendChild(copyButton(() => items.join('\n'), label, { small: true, text: 'Alle kopieren' }));
      const lines = el('div', { class: 'data-lines' });
      for (const item of items) {
        lines.appendChild(el('div', { class: 'data-line' }, [
          el('span', { class: 'data-value' + (field.mono ? ' mono' : ''), text: item }),
          copyButton(item, label, { small: true }),
        ]));
      }
      tile.appendChild(lines);
      tile.appendChild(el('div', null, editButton(key, 'Bearbeiten', true)));
      return tile;
    }

    const value = F.valueAsText(d, key);
    if (!value) {
      tile.appendChild(el('div', { class: 'data-missing', text: 'Noch nicht eingetragen' }));
      head.appendChild(editButton(key, 'Eintragen'));
      return tile;
    }
    head.appendChild(editButton(key, 'Bearbeiten', true));
    tile.appendChild(el('div', { class: 'data-value' + (field.mono ? ' mono' : ''), text: value }));
    tile.appendChild(el('div', null, copyButton(value, label, { primary: true })));
    return tile;
  }

  function editButton(key, text, ghost) {
    return el('button', {
      class: 'btn btn-sm ' + (ghost ? 'btn-ghost' : ''),
      type: 'button',
      onclick: async () => {
        const changed = await window.Views.data.editFieldDialog(key);
        if (changed) render();
      },
    }, [icon(ghost ? 'pencil' : 'plus', 'icon-sm'), text]);
  }

  // Eingabefeld direkt im Schritt (z. B. Recovery ID). Speichert beim Tippen.
  function inlineInput(key) {
    const field = F.byKey(key);
    if (!field) return null;
    const input = el('input', {
      class: 'input' + (field.mono ? ' mono' : ''),
      type: 'text',
      value: F.valueAsText(data(), key),
      placeholder: field.placeholder || '',
      'aria-label': field.label,
      spellcheck: 'false',
    });
    input.addEventListener('input', () => {
      window.Store.update((s) => { s.data[key] = input.value; }, 'recovery-input');
      const step = currentStep();
      if (step.urlFromEmail === key) {
        const old = document.getElementById('target-block');
        if (old) old.replaceWith(targetBlock(step));
      }
    });
    const copy = copyButton(() => input.value, field.label);
    return el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: field.label }),
      el('div', { class: 'input-row' }, [input, copy]),
      field.hint ? el('div', { class: 'field-hint', text: field.hint }) : null,
    ]);
  }

  // ---------- Aufbau ----------

  function stepsList(active) {
    const r = rec();
    const list = el('nav', { class: 'card steps-list', 'aria-label': 'Alle Schritte' });
    let number = 0;
    for (const phase of PHASES) {
      list.appendChild(el('div', { class: 'step-phase', text: phase.title }));
      for (const step of STEPS.filter((s) => s.phase === phase.key)) {
        number += 1;
        const done = Boolean(r.done[step.id]);
        const isActive = !r.finished && step.id === active.id;
        const btn = el('button', {
          class: 'step-item' + (isActive ? ' active' : '') + (done ? ' done' : ''),
          type: 'button',
          'aria-current': isActive ? 'step' : null,
          onclick: () => goTo(step.id),
        }, [
          el('span', { class: 'step-num' }, done ? icon('check', 'icon-sm') : String(number)),
          el('span', { class: 'step-name' }, [step.title, step.optional ? el('span', { class: 'hint', text: ' (nur wenn nötig)' }) : null]),
        ]);
        if (done) btn.appendChild(el('span', { class: 'sr-only', text: ' erledigt' }));
        list.appendChild(btn);
      }
    }
    return list;
  }

  function providerButtons() {
    const wrap = el('div', { class: 'stack-sm' }, [
      el('div', { class: 'hint', text: 'Oder wähle deinen E-Mail-Anbieter:' }),
    ]);
    const row = el('div', { class: 'row' });
    for (const p of EMAIL_PROVIDERS) {
      row.appendChild(el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openUrl(p.url) }, p.name));
    }
    wrap.appendChild(row);
    return wrap;
  }

  // Kasten mit der passenden Seite. Wird beim Tippen der E-Mail-Adresse neu gebaut,
  // damit sofort die Seite des richtigen Anbieters angeboten wird.
  function targetBlock(step) {
    const target = targetFor(step);
    const wrap = el('div', { class: 'stack', id: 'target-block' });
    if (target.url) {
      wrap.appendChild(el('div', { class: 'open-box' }, [
        el('div', { class: 'stack-sm grow' }, [
          el('div', { class: 'row' }, [icon('globe'), el('strong', { text: target.label })]),
          el('div', { class: 'url', text: target.url }),
        ]),
        el('div', { class: 'row' }, [
          copyButton(target.url, 'Link', { small: true, text: 'Link kopieren' }),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => openUrl(target.url) }, [icon('external'), 'Seite öffnen']),
        ]),
      ]));
    }
    if (step.urlFromEmail && !providerForEmail(F.valueAsText(data(), step.urlFromEmail))) {
      wrap.appendChild(providerButtons());
    }
    return wrap;
  }

  function stepCard(step) {
    const r = rec();
    const i = indexOf(step.id);
    const phase = PHASES.find((p) => p.key === step.phase);
    const doneAt = r.done[step.id];

    const card = el('section', { class: 'card step-card', 'aria-labelledby': 'step-title' });

    card.appendChild(el('div', { class: 'step-head' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'step-kicker', text: 'Schritt ' + (i + 1) + ' von ' + STEPS.length + ' · ' + phase.title }),
        step.optional ? el('span', { class: 'badge badge-warning', text: 'Nur wenn nötig' }) : null,
        doneAt ? el('span', { class: 'badge badge-success' }, [icon('check', 'icon-sm'), 'Erledigt am ' + formatDate(doneAt)]) : null,
      ]),
      el('h2', { class: 'step-title', id: 'step-title', text: step.title }),
      el('p', { class: 'step-why', text: step.why }),
    ]));

    card.appendChild(targetBlock(step));

    card.appendChild(el('div', { class: 'stack-sm' }, [
      el('h3', { class: 'card-title', text: 'So geht\'s' }),
      el('ol', { class: 'todo-list' }, step.todo.map((t) => el('li', { text: t }))),
    ]));

    for (const w of step.warnings || []) card.appendChild(callout(w.kind, w.title, w.text));

    if (step.inputs && step.inputs.length) {
      card.appendChild(el('div', { class: 'stack' }, step.inputs.map(inlineInput)));
    }

    const shown = (step.data || []).filter((k) => !(step.inputs || []).includes(k));
    if (shown.length) {
      card.appendChild(el('div', { class: 'stack-sm' }, [
        el('h3', { class: 'card-title', text: 'Diese Daten brauchst du jetzt' }),
        el('p', { class: 'hint', text: 'Klick auf "Kopieren" und füge den Wert auf der Epic-Seite mit Strg + V ein.' }),
      ]));
      card.appendChild(el('div', { class: 'data-grid' }, shown.map(dataTile)));
    }

    const extras = [];
    for (const it of step.internal || []) {
      extras.push(el('button', { class: 'btn', type: 'button', onclick: () => window.App.go(it.view) }, [icon(it.icon || 'arrowRight'), it.label]));
    }
    for (const l of step.links || []) {
      extras.push(el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openUrl(l.url) }, [icon('external', 'icon-sm'), l.label]));
    }
    if (extras.length) card.appendChild(el('div', { class: 'row' }, extras));

    const left = el('div', { class: 'row' }, [
      el('button', { class: 'btn btn-ghost', type: 'button', disabled: i === 0, onclick: () => goTo(STEPS[i - 1].id, { open: false }) }, [icon('arrowLeft'), 'Zurück']),
    ]);
    const right = el('div', { class: 'row' });
    if (step.success) {
      right.appendChild(el('button', {
        class: 'btn btn-success',
        type: 'button',
        onclick: () => {
          markDone(step.id, true);
          window.Store.update((s) => { s.recovery.recovered = true; }, 'recovery');
          goTo(step.success.jumpTo);
        },
      }, [icon('checkCircle'), step.success.label]));
    }
    if (step.optional && !doneAt) {
      right.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => skip(step) }, 'Überspringen'));
    }
    if (doneAt) {
      right.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { markDone(step.id, false); render(); } }, 'Wieder als offen markieren'));
      right.appendChild(el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => completeAndContinue(step) }, ['Weiter', icon('arrowRight')]));
    } else {
      right.appendChild(el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => completeAndContinue(step) }, [icon('check'), 'Erledigt, weiter']));
    }
    card.appendChild(el('div', { class: 'step-foot' }, [left, right]));
    return card;
  }

  function finishCard() {
    return el('section', { class: 'card finish' }, [
      icon('checkCircle'),
      el('h2', { text: 'Geschafft!' }),
      el('p', { text: 'Du hast alle Schritte erledigt. Dein Konto ist jetzt deutlich besser geschützt. Merk dir diese drei Regeln:' }),
      el('ul', { class: 'stack-sm' }, window.KR_STEPS.TIPS.map((t) => el('li', { text: t }))),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', type: 'button', onclick: () => goTo(STEPS[0].id, { open: false }) }, 'Schritte nochmal ansehen'),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: async () => {
            const yes = await window.UI.confirmDialog({
              title: 'Fortschritt zurücksetzen?',
              text: 'Alle Haken werden entfernt. Deine eingetragenen Daten bleiben erhalten.',
              confirmText: 'Zurücksetzen',
              danger: true,
            });
            if (!yes) return;
            window.Store.update((s) => { s.recovery.done = {}; s.recovery.current = STEPS[0].id; s.recovery.finished = false; s.recovery.recovered = false; }, 'recovery');
            render();
          },
        }, 'Fortschritt zurücksetzen'),
      ]),
    ]);
  }

  function render() {
    if (!root) return;
    const r = rec();
    const step = currentStep();
    const count = doneCount();
    const pct = Math.round((count / STEPS.length) * 100);

    const head = pageHead('Konto retten', 'Geh die Schritte der Reihe nach durch. Dein Fortschritt wird automatisch gespeichert, du kannst jederzeit aufhören und später weitermachen.');
    const progress = el('div', { class: 'card stack-sm' }, [
      el('div', { class: 'row row-between' }, [
        el('strong', { text: count + ' von ' + STEPS.length + ' Schritten erledigt' }),
        switchControl('Seiten automatisch öffnen', r.autoOpen, (v) => {
          window.Store.update((s) => { s.recovery.autoOpen = v; }, 'recovery');
        }, 'Beim Wechsel zu einem Schritt öffnet sich die passende Seite im Browser.'),
      ]),
      el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Fortschritt' }, [
        (() => { const b = el('div', { class: 'progress-bar' + (pct === 100 ? ' complete' : '') }); b.style.width = pct + '%'; return b; })(),
      ]),
    ]);

    const wizard = el('div', { class: 'wizard' }, [stepsList(step), r.finished ? finishCard() : stepCard(step)]);
    clear(root).appendChild(el('div', { class: 'page' }, [head, progress, wizard]));
  }

  window.Views = window.Views || {};
  window.Views.recovery = {
    id: 'recovery',
    label: 'Konto retten',
    hint: 'Schritt für Schritt',
    icon: 'shield',
    mount(container) {
      root = container;
      render();
    },
    unmount() { root = null; },
    refresh: render,
    badge() {
      const count = doneCount();
      return { text: count + '/' + STEPS.length, done: count === STEPS.length };
    },
  };
})();
