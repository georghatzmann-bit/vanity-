// Ansicht "Konto retten": Schritt für Schritt durch die Kontowiederherstellung.
(function () {
  'use strict';
  const { el, icon, clear, callout, copyButton, openUrl, switchControl, formatDate, pageHead } = window.UI;
  const { STEPS, PHASES, EMAIL_PROVIDERS, providerForEmail, stepById, indexOf } = window.KR_STEPS;
  const F = window.KR_FIELDS;

  let root = null;
  // Für Animationen: welcher Schritt und welcher Fortschritt zuletzt zu sehen war
  let lastShown = null;
  let lastPct = 0;

  function rec() {
    return window.Store.get().recovery;
  }

  function data() {
    return window.Store.get().data;
  }

  function skippedMap() {
    const r = rec();
    if (!r.skipped) r.skipped = {};
    return r.skipped;
  }

  // Erledigt oder bewusst übersprungen
  function handled(id) {
    return Boolean(rec().done[id] || skippedMap()[id]);
  }

  function currentStep() {
    const r = rec();
    const byId = r.current && stepById(r.current);
    if (byId) return byId;
    return STEPS.find((s) => !handled(s.id)) || STEPS[0];
  }

  function doneCount() {
    return STEPS.filter((s) => handled(s.id)).length;
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
    // Für Tastatur und Bildschirmleser: zum neuen Schritt springen
    const title = document.getElementById('step-title');
    if (title) title.focus({ preventScroll: true });
  }

  function markDone(id, done) {
    window.Store.update((s) => {
      if (!s.recovery.skipped) s.recovery.skipped = {};
      if (done) s.recovery.done[id] = new Date().toISOString();
      else delete s.recovery.done[id];
      delete s.recovery.skipped[id];
    }, 'recovery');
  }

  function markSkipped(ids) {
    window.Store.update((s) => {
      if (!s.recovery.skipped) s.recovery.skipped = {};
      for (const id of ids) if (!s.recovery.done[id]) s.recovery.skipped[id] = new Date().toISOString();
    }, 'recovery');
  }

  // Nächster offener Schritt: erst vorwärts, dann nur noch Pflichtschritte weiter vorne.
  // Gibt es keinen mehr, ist die Rettung fertig.
  function nextOpenAfter(id) {
    const start = indexOf(id);
    for (let i = start + 1; i < STEPS.length; i++) if (!handled(STEPS[i].id)) return STEPS[i];
    return STEPS.find((s) => !handled(s.id) && !s.optional) || null;
  }

  // Wo soll der Funkenregen starten? Bei Mausklick an der Maus, sonst in der Mitte des Knopfes.
  function pointFrom(e) {
    if (!e) return null;
    if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
    const t = e.currentTarget;
    if (t && t.getBoundingClientRect) {
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }

  function cheer(e) {
    const fx = window.FX;
    if (!fx || !fx.enabled()) return;
    const p = pointFrom(e);
    if (p) fx.burst(p.x, p.y);
    fx.pulse('success');
  }

  function completeAndContinue(step, e) {
    if (!rec().done[step.id]) cheer(e);
    markDone(step.id, true);
    const next = nextOpenAfter(step.id);
    if (next) goTo(next.id);
    else finish();
  }

  function skip(step) {
    markSkipped([step.id]);
    const next = nextOpenAfter(step.id);
    if (next) goTo(next.id);
    else finish();
  }

  // "Hat geklappt, ich bin wieder drin": die übrigen Schritte zum Zurückholen sind nicht mehr nötig
  function jumpAfterSuccess(step, e) {
    cheer(e);
    markDone(step.id, true);
    const from = indexOf(step.id);
    const to = indexOf(step.success.jumpTo);
    markSkipped(STEPS.slice(from + 1, to).map((s) => s.id));
    window.Store.update((s) => { s.recovery.recovered = true; }, 'recovery');
    const target = handled(step.success.jumpTo) ? nextOpenAfter(step.success.jumpTo) : stepById(step.success.jumpTo);
    if (target) goTo(target.id);
    else finish();
  }

  function finish() {
    window.Store.update((s) => { s.recovery.finished = true; }, 'recovery');
    render();
    if (window.FX && window.FX.enabled()) window.FX.celebrate();
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
      fk: 'edit-' + key,
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

  // ---------- Sonderknöpfe in einzelnen Schritten ----------

  async function runAction(action) {
    if (action === 'windows-security') {
      const res = await window.kr.openWindowsSecurity();
      if (!res || !res.ok) window.UI.toast((res && res.message) || 'Windows-Sicherheit konnte nicht geöffnet werden.', 'error');
      return;
    }
    if (action === 'find-account-id') findAccountIds();
  }

  async function findAccountIds() {
    const res = await window.kr.findEpicAccountIds();
    if (!res || !res.ok) {
      window.UI.toast((res && res.message) || 'Suche hat nicht geklappt.', 'error');
      return;
    }
    const { found, launcherFound } = res.value;
    if (!found.length) {
      await window.UI.confirmDialog({
        title: 'Keine Konto-ID gefunden',
        text: launcherFound
          ? 'Der Epic Games Launcher ist installiert, hat aber noch keine Konto-ID gespeichert.'
          : 'Auf diesem PC wurde der Epic Games Launcher nicht gefunden. Die Konto-ID steht dann in der Konto-PDF oder in Epic-Mails.',
        confirmText: 'OK',
        cancelText: null,
      });
      return;
    }
    const current = F.valueAsText(data(), 'account_id');
    let chosen = null;
    const list = el('div', { class: 'stack-sm' });
    const body = el('div', { class: 'stack' }, [
      el('p', { class: 'muted', text: found.length === 1
        ? 'Auf diesem PC hat sich dieses Epic-Konto angemeldet:'
        : 'Auf diesem PC haben sich mehrere Epic-Konten angemeldet. Das oberste wurde zuletzt benutzt. Wähle deins:' }),
      list,
      el('p', { class: 'hint', text: 'Nicht sicher, welches deins ist? Die Konto-ID steht auch in deiner Konto-PDF oder auf epicgames.com unter Kontoinformationen.' }),
    ]);
    found.forEach((f, i) => {
      const input = el('input', { type: 'radio', name: 'acc', checked: i === 0 });
      if (i === 0) chosen = f.id;
      input.addEventListener('change', () => { if (input.checked) chosen = f.id; });
      list.appendChild(el('label', { class: 'check' }, [
        input,
        el('span', { class: 'stack-sm' }, [
          el('span', { class: 'mono', text: f.id }),
          el('span', { class: 'hint', text: (f.modified ? 'Zuletzt benutzt: ' + window.UI.formatDate(f.modified) : '') + (f.id === current ? ' · schon eingetragen' : '') }),
        ]),
      ]));
    });
    const yes = await window.UI.confirmDialog({ title: 'Konto-ID gefunden', body, confirmText: 'Als meine Konto-ID übernehmen' });
    if (!yes || !chosen) return;
    window.Store.update((s) => { s.data.account_id = chosen; }, 'recovery');
    window.UI.toast('Konto-ID übernommen.', 'success');
    render();
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
        const skipped = !done && Boolean(skippedMap()[step.id]);
        const isActive = !r.finished && step.id === active.id;
        const btn = el('button', {
          class: 'step-item' + (isActive ? ' active' : '') + (done ? ' done' : '') + (skipped ? ' skipped' : ''),
          type: 'button',
          fk: 'step-' + step.id,
          'aria-current': isActive ? 'step' : null,
          // Nur den Schritt anzeigen, NICHT automatisch die Seite im Browser öffnen.
          onclick: () => goTo(step.id, { open: false }),
        }, [
          el('span', { class: 'step-num' }, done ? icon('check', 'icon-sm') : skipped ? '–' : String(number)),
          el('span', { class: 'step-name' }, [step.title, step.optional && !/nur wenn nötig/i.test(step.title) ? el('span', { class: 'hint', text: ' (nur wenn nötig)' }) : null, skipped ? el('span', { class: 'hint', text: ' (übersprungen)' }) : null]),
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
        !doneAt && skippedMap()[step.id] ? el('span', { class: 'badge', text: 'Übersprungen' }) : null,
      ]),
      el('h2', { class: 'step-title', id: 'step-title', tabindex: '-1', text: step.title }),
      el('p', { class: 'step-why', text: step.why }),
    ]));

    card.appendChild(targetBlock(step));

    card.appendChild(el('div', { class: 'stack-sm' }, [
      el('h3', { class: 'card-title', text: 'So geht\'s' }),
      el('ol', { class: 'todo-list' }, step.todo.map((t) => el('li', { text: t }))),
    ]));

    if (step.actions && step.actions.length) {
      card.appendChild(el('div', { class: 'row' }, step.actions.map((a) => el('button', { class: 'btn btn-primary', type: 'button', onclick: () => runAction(a.action) }, [icon(a.icon || 'arrowRight'), a.label]))));
    }

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
      el('button', { class: 'btn btn-ghost', type: 'button', fk: 'back', disabled: i === 0, onclick: () => goTo(STEPS[i - 1].id, { open: false }) }, [icon('arrowLeft'), 'Zurück']),
    ]);
    const right = el('div', { class: 'row' });
    if (step.success) {
      right.appendChild(el('button', {
        class: 'btn btn-success',
        type: 'button',
        fk: 'success',
        onclick: (e) => jumpAfterSuccess(step, e),
      }, [icon('checkCircle'), step.success.label]));
    }
    const isSkipped = !doneAt && Boolean(skippedMap()[step.id]);
    if (step.optional && !doneAt && !isSkipped) {
      right.appendChild(el('button', { class: 'btn btn-ghost', type: 'button', fk: 'skip', onclick: () => skip(step) }, 'Überspringen'));
    }
    if (doneAt || isSkipped) {
      right.appendChild(el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        fk: 'reopen',
        onclick: () => {
          markDone(step.id, false);
          render();
          const next = root && root.querySelector('[data-fk="next"]');
          if (next) next.focus();
        },
      }, 'Wieder als offen markieren'));
    }
    if (doneAt) {
      right.appendChild(el('button', { class: 'btn btn-primary btn-lg', type: 'button', fk: 'next', onclick: (e) => completeAndContinue(step, e) }, ['Weiter', icon('arrowRight')]));
    } else {
      right.appendChild(el('button', { class: 'btn btn-primary btn-lg', type: 'button', fk: 'next', onclick: (e) => completeAndContinue(step, e) }, [icon('check'), 'Erledigt, weiter']));
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
            window.Store.update((s) => { s.recovery.done = {}; s.recovery.skipped = {}; s.recovery.current = STEPS[0].id; s.recovery.finished = false; s.recovery.recovered = false; }, 'recovery');
            render();
          },
        }, 'Fortschritt zurücksetzen'),
      ]),
    ]);
  }

  function render() {
    if (!root) return;
    window.UI.keepFocus(root, draw);
  }

  function draw() {
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
        }, 'Beim Wechsel zu einem Schritt öffnet sich die passende Seite im Browser.', 'auto-open'),
      ]),
      el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Fortschritt' }, [
        // Startet beim alten Stand und wächst danach sichtbar zum neuen
        (() => { const b = el('div', { class: 'progress-bar' + (pct === 100 ? ' complete' : '') }); b.style.width = lastPct + '%'; return b; })(),
      ]),
    ]);

    const shown = r.finished ? 'finish' : step.id;
    const main = r.finished ? finishCard() : stepCard(step);
    const wizard = el('div', { class: 'wizard' }, [stepsList(step), main]);
    clear(root).appendChild(el('div', { class: 'page' }, [head, progress, wizard]));

    const bar = progress.querySelector('.progress-bar');
    if (bar && lastPct !== pct) {
      void bar.offsetWidth;
      bar.style.width = pct + '%';
    }
    lastPct = pct;
    // Neuer Schritt: Karte schwingt in 3D herein (beim Öffnen der Seite übernimmt das der Seitenwechsel)
    if (lastShown !== null && lastShown !== shown) window.UI.animateIn(main, 'step-swap');
    lastShown = shown;
  }

  window.Views = window.Views || {};
  window.Views.recovery = {
    id: 'recovery',
    label: 'Konto retten',
    hint: 'Schritt für Schritt',
    icon: 'shield',
    mount(container) {
      root = container;
      lastShown = null;
      lastPct = 0;
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
