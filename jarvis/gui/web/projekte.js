/* Jarvis – Werkstatt-Projekte
   Alle Projekte auf einen Blick: Stand, Auftrag, Ergebnis. Pro Projekt: Ansehen (in der Werkstatt mit
   Plan, Ablauf, Dateien und Hologramm), Starten (start.bat), Vorschau (index.html), Ordner öffnen,
   Weiterbauen und Löschen (zweimal klicken, unter Windows in den Papierkorb). Oben ein neuer Auftrag. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATE = { done: 'Fertig', running: 'Arbeitet', error: 'Fehler', cancelled: 'Abgebrochen' };
  const MARK = {
    done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 16.5v.5"/></svg>',
    cancelled: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12h10"/></svg>',
  };
  // Das Logo des Projekts (logo.svg), nur als Bild von Jarvis selbst: data:image/svg+xml
  const LOGO = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;

  function when(iso) {
    const d = new Date(String(iso || ''));
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((day - that) / 86400000);
    const clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (diff === 0) return 'heute ' + clock;
    if (diff === 1) return 'gestern ' + clock;
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '. ' + clock;
  }

  function button(label, title, onClick, extra) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ws-btn' + (extra ? ' ' + extra : '');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const el = {
      body: document.body,
      hub: $('hub'),
      back: $('hubBack'),
      count: $('hubCount'),
      job: $('hubJob'),
      jobText: $('hubJobText'),
      form: $('hubNew'),
      input: $('hubNewInput'),
      btn: $('hubNewBtn'),
      grid: $('hubGrid'),
      empty: $('hubEmpty'),
      laborGrid: $('laborGrid'),
      laborEmpty: $('laborEmpty'),
      laborRuns: $('laborRuns'),
      laborRunsBox: $('laborRunsBox'),
      laborOpen: $('laborOpen'),
    };
    if (!el.hub) return null;
    let isOpen = false;
    let items = [];
    let closeTimer = 0;
    let loading = 0;

    async function refresh() {
      const mine = ++loading;
      let found = [];
      try {
        found = (await call('workshop_projects')) || [];
      } catch {
        found = [];
      }
      if (mine !== loading) return;
      items = Array.isArray(found) ? found : [];
      render();
    }

    function running() {
      return !!(opts.werkstatt && opts.werkstatt.running && opts.werkstatt.running());
    }

    function render() {
      el.grid.textContent = '';
      el.count.textContent = items.length ? items.length + (items.length === 1 ? ' Projekt' : ' Projekte') : '';
      el.empty.hidden = items.length > 0;
      el.job.hidden = !running();
      items.forEach((p, i) => el.grid.appendChild(card(p, i)));
    }

    function card(p, index) {
      const art = document.createElement('article');
      art.className = 'hub-card';
      art.dataset.state = String(p.state || '');
      art.setAttribute('role', 'listitem');
      art.style.setProperty('--i', String(Math.min(index, 12)));

      const head = document.createElement('div');
      head.className = 'hub-card-head';
      const h = document.createElement('h3');
      h.textContent = String(p.name || 'Projekt');
      h.title = String(p.folder || '');
      const chip = document.createElement('span');
      chip.className = 'ws-chip';
      chip.dataset.state = String(p.state || 'cancelled');
      const mark = document.createElement('span');
      mark.className = 'ws-chip-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = MARK[p.state] || '';
      chip.append(mark, document.createTextNode(STATE[p.state] || 'Offen'));
      const logo = String(p.logo || '');
      if (logo.length < 200000 && LOGO.test(logo)) {
        const img = document.createElement('img');
        img.className = 'hub-logo';
        img.alt = '';
        img.src = logo;
        img.addEventListener('error', () => img.remove());
        head.append(img);
      }
      head.append(h, chip);
      art.appendChild(head);
      h.tabIndex = 0;
      h.setAttribute('role', 'button');
      h.title = 'Ansehen: ' + String(p.name || 'Projekt');
      h.addEventListener('click', () => show(p.folder));
      h.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          show(p.folder);
        }
      });

      if (p.task) {
        const task = document.createElement('p');
        task.className = 'hub-task';
        task.textContent = '„' + String(p.task) + '“';
        art.appendChild(task);
      }
      if (p.summary) {
        const sum = document.createElement('p');
        sum.className = 'hub-sum';
        sum.textContent = String(p.summary);
        art.appendChild(sum);
      }

      const meta = document.createElement('div');
      meta.className = 'hub-meta';
      const parts = [];
      if (p.updated) parts.push(['zuletzt ' + when(p.updated), '']);
      if (p.model) parts.push([p.model === 'opus' ? 'Opus' : 'Sonnet', p.model === 'opus' ? 'opus' : '']);
      const rounds = Array.isArray(p.history) ? p.history.length : 0;
      if (rounds > 1) parts.push([rounds + ' Aufträge', '']);
      for (const [text, cls] of parts) {
        const span = document.createElement('span');
        span.textContent = text;
        if (cls) span.className = cls;
        meta.appendChild(span);
      }
      art.appendChild(meta);

      const more = document.createElement('form');
      more.className = 'hub-more';
      more.hidden = true;
      const moreInput = document.createElement('input');
      moreInput.type = 'text';
      moreInput.maxLength = 1500;
      moreInput.placeholder = 'Was soll dazu? Zum Beispiel: einen !würfel-Befehl';
      moreInput.setAttribute('aria-label', 'Wunsch zum Projekt ' + String(p.name || ''));
      const moreBtn = document.createElement('button');
      moreBtn.type = 'submit';
      moreBtn.className = 'ws-btn primary';
      moreBtn.textContent = 'Los';
      more.append(moreInput, moreBtn);
      more.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = moreInput.value.trim();
        if (!text) return;
        moreBtn.disabled = true;
        try {
          const ok = await call('workshop_continue', p.folder, text);
          if (ok === false) {
            toast('Das Projekt gibt es nicht mehr, oder die Werkstatt arbeitet gerade.', 'error');
          } else {
            toast('Jarvis baut an ' + (p.name || 'dem Projekt') + ' weiter.', 'ok');
            close();
          }
        } catch {
          toast('Jarvis ist gerade nicht verbunden.', 'error');
        } finally {
          moreBtn.disabled = false;
        }
      });

      const actions = document.createElement('div');
      actions.className = 'hub-actions';
      actions.appendChild(button('Ansehen', 'Das Projekt in der Werkstatt ansehen: Plan, Ablauf, Dateien, Hologramm', () => show(p.folder)));
      actions.appendChild(button('Ordner', 'Den Projektordner im Explorer öffnen', async () => {
        try {
          const ok = await call('open_folder', p.folder);
          toast(ok === false ? 'Den Ordner gibt es nicht mehr.' : 'Der Ordner öffnet sich.', ok === false ? 'error' : 'ok');
        } catch {
          toast('Im Demo-Modus öffnet sich kein Ordner.', 'info');
        }
      }));
      if (p.start) {
        actions.appendChild(button('Starten', 'start.bat ausführen: das Programm starten', async () => {
          try {
            const ok = await call('workshop_run', p.folder);
            toast(ok === false ? 'Starten ging nicht.' : (p.name || 'Das Projekt') + ' startet.', ok === false ? 'error' : 'ok');
          } catch {
            toast('Im Demo-Modus startet nichts.', 'info');
          }
        }));
      }
      if (p.preview) {
        actions.appendChild(button('Vorschau', 'Die Webseite des Projekts im Browser ansehen', async () => {
          try {
            const ok = await call('workshop_preview', p.folder);
            toast(ok === false ? 'Die Vorschau ging nicht auf.' : 'Die Vorschau öffnet sich im Browser.', ok === false ? 'error' : 'ok');
          } catch {
            toast('Im Demo-Modus gibt es keine Vorschau.', 'info');
          }
        }));
      }
      const grow = button('Weiterbauen', 'Einen Wunsch zu diesem Projekt an die Werkstatt geben', () => {
        more.hidden = !more.hidden;
        if (!more.hidden) moreInput.focus();
      }, 'primary');
      if (p.state === 'running') grow.disabled = true;
      actions.appendChild(grow);

      // Löschen: erst fragen, dann löschen
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mem-del hub-del';
      del.textContent = '×';
      del.title = 'Projekt löschen (zweimal klicken, kommt in den Papierkorb)';
      del.setAttribute('aria-label', 'Projekt ' + String(p.name || '') + ' löschen');
      if (p.state === 'running') del.hidden = true;
      let armed = 0;
      del.addEventListener('click', async () => {
        if (Date.now() - armed > 4000) {
          armed = Date.now();
          art.classList.add('armed');
          setTimeout(() => { if (Date.now() - armed >= 4000) art.classList.remove('armed'); }, 4100);
          toast('Nochmal klicken, um „' + String(p.name || 'das Projekt') + '“ zu löschen.', 'info');
          return;
        }
        armed = 0;
        art.classList.remove('armed');
        del.disabled = true;
        try {
          const r = await call('workshop_delete', p.folder);
          if (r && r.ok) {
            toast(String(p.name || 'Das Projekt') + (r.trash ? ' liegt jetzt im Papierkorb.' : ' ist gelöscht.'), 'ok');
            items = items.filter((x) => x.folder !== p.folder);
            render();
          } else {
            toast((r && r.error) || 'Das Löschen ging nicht.', 'error');
          }
        } catch {
          toast('Im Demo-Modus wird nichts gelöscht.', 'info');
        } finally {
          del.disabled = false;
        }
      });
      actions.appendChild(del);
      art.append(actions, more);
      return art;
    }

    // Ein Projekt in der Werkstatt ansehen
    async function show(folder) {
      if (!opts.werkstatt || !opts.werkstatt.view) return;
      let data = null;
      try {
        data = await call('workshop_project', folder);
      } catch {
        data = null;
      }
      if (!data) {
        toast('Das Projekt gibt es nicht mehr.', 'error');
        refresh();
        return;
      }
      close();
      opts.werkstatt.view(data);
    }

    // ---------- Labor: Jarvis' eigene Werkzeuge (gebaut und getestet in seiner Sandbox)

    const RUN_MARK = { ok: MARK.done, fail: MARK.error, stop: MARK.cancelled };

    function toolCard(t) {
      const art = document.createElement('article');
      art.className = 'tool-card';
      art.setAttribute('role', 'listitem');
      const h = document.createElement('h3');
      const name = document.createElement('span');
      name.textContent = String(t.titel || t.name || 'Werkzeug');
      const chip = document.createElement('span');
      chip.className = 'ws-chip';
      const ready = !!t.freigegeben && !t.geaendert;
      chip.dataset.state = ready ? 'done' : t.test_ok === false ? 'error' : 'cancelled';
      const mark = document.createElement('span');
      mark.className = 'ws-chip-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = ready ? MARK.done : t.test_ok === false ? MARK.error : MARK.cancelled;
      chip.append(mark, document.createTextNode(ready ? 'Freigegeben' : t.geaendert ? 'Geändert' : t.test_ok === false ? 'Tests rot' : 'In Arbeit'));
      h.append(name, chip);
      const desc = document.createElement('p');
      desc.textContent = String(t.beschreibung || '');
      const code = document.createElement('code');
      code.textContent = String(t.aufruf || '');
      code.title = code.textContent;
      const meta = document.createElement('small');
      const parts = [];
      if (t.test_ergebnis) parts.push(String(t.test_ergebnis));
      if (typeof t.laeufe === 'number') parts.push(t.laeufe === 1 ? '1 Lauf' : t.laeufe + ' Läufe');
      if (t.zuletzt_benutzt) parts.push('zuletzt ' + when(t.zuletzt_benutzt));
      meta.textContent = parts.join(' · ');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mem-del';
      del.textContent = '×';
      del.title = 'Werkzeug löschen (zweimal klicken)';
      del.setAttribute('aria-label', 'Werkzeug ' + name.textContent + ' löschen');
      let armed = 0;
      del.addEventListener('click', async () => {
        if (Date.now() - armed > 3000) {
          armed = Date.now();
          toast('Nochmal klicken, um „' + name.textContent + '“ zu löschen.', 'info');
          return;
        }
        try {
          const ok = await call('werkzeug_loeschen', t.name);
          toast(ok ? 'Werkzeug gelöscht.' : 'Das ging nicht.', ok ? 'ok' : 'error');
          refreshLabor();
        } catch {
          toast('Das ging gerade nicht.', 'error');
        }
      });
      art.append(h, desc);
      if (code.textContent) art.append(code);
      art.append(meta, del);
      return art;
    }

    function renderLabor(info) {
      if (!el.laborGrid) return;
      const tools = (info && info.werkzeuge) || [];
      const runs = ((info && info.letzte_laeufe) || []).slice(0, 6);
      el.laborGrid.replaceChildren(...tools.map(toolCard));
      el.laborEmpty.hidden = tools.length > 0;
      el.laborRunsBox.hidden = runs.length === 0;
      el.laborRuns.replaceChildren(...runs.map((r) => {
        const li = document.createElement('li');
        const m = document.createElement('span');
        m.className = 'ws-chip-mark';
        m.setAttribute('role', 'img');
        const kind = r.abgebrochen ? 'stop' : r.ok ? 'ok' : 'fail';
        m.setAttribute('aria-label', { ok: 'ok', fail: 'Fehler', stop: 'abgebrochen' }[kind]);
        m.innerHTML = RUN_MARK[kind];
        m.style.color = kind === 'ok' ? 'var(--ok)' : kind === 'fail' ? 'var(--err)' : 'var(--text-3)';
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = String(r.was || '');
        what.title = what.textContent;
        const took = document.createElement('span');
        took.className = 'took';
        took.textContent = typeof r.dauer === 'number' ? r.dauer.toFixed(1).replace('.', ',') + ' s' : '';
        const t = document.createElement('time');
        t.textContent = when(r.wann);
        li.append(m, what, took, t);
        return li;
      }));
    }

    async function refreshLabor() {
      const box = document.getElementById('labor');
      try {
        renderLabor(await call('labor_info'));
        if (box) box.hidden = false;
      } catch {
        if (box) box.hidden = true; // Jarvis-Version ohne Labor
      }
    }

    if (el.laborOpen) {
      el.laborOpen.addEventListener('click', async () => {
        try {
          const r = await call('labor_open');
          toast(r && r.ok ? 'Das Labor öffnet sich im Explorer.' : (r && r.error) || 'Das ging nicht.', r && r.ok ? 'ok' : 'error');
        } catch {
          toast('Im Demo-Modus öffnet sich kein Ordner.', 'info');
        }
      });
    }

    function open() {
      clearTimeout(closeTimer);
      if (opts.werkstatt && opts.werkstatt.isOpen && opts.werkstatt.isOpen()) opts.werkstatt.close();
      isOpen = true;
      el.hub.hidden = false;
      el.hub.classList.remove('closing');
      el.hub.classList.add('opening');
      setTimeout(() => el.hub.classList.remove('opening'), 260);
      el.body.dataset.view = 'hub';
      render();
      refresh();
      refreshLabor();
      if (opts.onView) opts.onView('hub');
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      el.body.dataset.view = 'hud';
      el.hub.classList.add('closing');
      closeTimer = setTimeout(() => {
        if (isOpen) return;
        el.hub.hidden = true;
        el.hub.classList.remove('closing');
      }, 170);
      if (opts.onView) opts.onView('hud');
    }

    el.back.addEventListener('click', close);
    el.job.addEventListener('click', () => {
      close();
      if (opts.werkstatt) opts.werkstatt.open();
    });
    el.input.addEventListener('input', () => {
      el.btn.disabled = !el.input.value.trim();
    });
    el.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = el.input.value.trim();
      if (!text) return;
      el.btn.disabled = true;
      try {
        const ok = await call('workshop_new', text);
        if (ok === false) {
          toast('Die Werkstatt arbeitet noch am vorigen Auftrag.', 'info');
        } else {
          el.input.value = '';
          toast('Ab in die Werkstatt.', 'ok');
          close();
        }
      } catch {
        toast('Jarvis ist gerade nicht verbunden.', 'error');
      } finally {
        el.btn.disabled = !el.input.value.trim();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    });

    return { open, close, refresh, show, isOpen: () => isOpen };
  }

  window.JarvisProjekte = { create };
})();
