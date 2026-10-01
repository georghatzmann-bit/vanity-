/* Jarvis – Werkstatt-Projekte
   Alle Projekte auf einen Blick: Stand, Auftrag, Ergebnis. Pro Projekt: Ordner öffnen,
   Starten (start.bat) und Weiterbauen. Oben ein neuer Auftrag. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATE = { done: 'Fertig', running: 'Arbeitet', error: 'Fehler', cancelled: 'Abgebrochen' };
  const MARK = {
    done: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 16.5v.5"/></svg>',
    cancelled: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12h10"/></svg>',
  };

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
      head.append(h, chip);
      art.appendChild(head);

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
      const grow = button('Weiterbauen', 'Einen Wunsch zu diesem Projekt an die Werkstatt geben', () => {
        more.hidden = !more.hidden;
        if (!more.hidden) moreInput.focus();
      }, 'primary');
      if (p.state === 'running') grow.disabled = true;
      actions.appendChild(grow);
      art.append(actions, more);
      return art;
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

    return { open, close, refresh, isOpen: () => isOpen };
  }

  window.JarvisProjekte = { create };
})();
