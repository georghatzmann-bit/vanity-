/* Jarvis – Gedächtnis: Zusammenfassung in der rechten Spalte, alles in einer Schublade,
   und Vorschläge aus den Gewohnheiten als Karte mit Ja, Nein, Nie wieder. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SOURCE = { georg: 'von Ihnen', gelernt: 'gelernt', jarvis: 'gemerkt im Gespräch' };

  function create(opts) {
    const call = opts.call;
    const toast = opts.toast || (() => {});
    const el = {
      sum: $('memSum'),
      next: $('memNext'),
      open: $('memOpen'),
      drawer: $('memDrawer'),
      shade: $('memShade'),
      close: $('memClose'),
      add: $('memAdd'),
      input: $('memInput'),
      routines: $('memRoutines'),
      routinesEmpty: $('memRoutinesEmpty'),
      contacts: $('memContacts'),
      contactsEmpty: $('memContactsEmpty'),
      facts: $('memFacts'),
      factsEmpty: $('memFactsEmpty'),
      offer: $('offer'),
      offerText: $('offerText'),
    };
    if (!el.sum) return null;
    let data = { facts: [], contacts: [], routines: [] };

    function plural(n, one, many) {
      return n + ' ' + (n === 1 ? one : many);
    }

    function render() {
      const facts = data.facts || [];
      const routines = data.routines || [];
      const contacts = data.contacts || [];
      if (facts.length || routines.length || contacts.length) {
        el.sum.textContent = plural(facts.length, 'Sache', 'Sachen') + ' über Sie · ' + plural(routines.length, 'Gewohnheit', 'Gewohnheiten')
          + ' · ' + plural(contacts.length, 'Kontakt', 'Kontakte');
      }
      const first = routines[0];
      el.next.hidden = !first;
      if (first) el.next.textContent = first.tage + ' gegen ' + first.uhrzeit + ' Uhr: ' + first.label;

      el.routines.replaceChildren(...routines.map((r) => {
        const li = document.createElement('li');
        const time = document.createElement('span');
        time.className = 'mem-time';
        time.textContent = r.uhrzeit;
        const text = document.createElement('span');
        text.className = 'mem-text';
        text.textContent = r.label;
        const small = document.createElement('small');
        small.textContent = r.tage + ', an ' + r.anzahl + ' Tagen gesehen';
        text.appendChild(small);
        li.append(time, text);
        return li;
      }));
      el.routinesEmpty.hidden = routines.length > 0;

      el.contacts.replaceChildren(...contacts.map((c) => {
        const chip = document.createElement('span');
        chip.className = 'mem-chip';
        chip.textContent = c.name + ' ';
        const small = document.createElement('small');
        small.textContent = c.app || '';
        chip.appendChild(small);
        return chip;
      }));
      el.contactsEmpty.hidden = contacts.length > 0;

      el.facts.replaceChildren(...facts.map((f) => {
        const li = document.createElement('li');
        const text = document.createElement('span');
        text.className = 'mem-text';
        text.textContent = f.text;
        const small = document.createElement('small');
        small.textContent = SOURCE[f.source] || '';
        text.appendChild(small);
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mem-del';
        del.textContent = '×';
        del.title = 'Vergessen';
        del.setAttribute('aria-label', 'Vergessen: ' + f.text);
        del.addEventListener('click', async () => {
          try {
            await call('forget', f.text);
            toast('Vergessen.', 'ok');
            refresh();
          } catch {
            toast('Das ging gerade nicht.', 'error');
          }
        });
        li.append(text, del);
        return li;
      }));
      el.factsEmpty.hidden = facts.length > 0;
    }

    async function refresh() {
      try {
        data = (await call('memory_state')) || data;
      } catch {
        return;
      }
      render();
    }

    function openDrawer(open) {
      el.drawer.classList.toggle('open', open);
      el.drawer.setAttribute('aria-hidden', String(!open));
      el.shade.hidden = !open;
      if (open) {
        refresh();
        el.input.focus({ preventScroll: true });
      }
    }

    function offer(o) {
      if (!o || !o.frage) {
        el.offer.hidden = true;
        return;
      }
      el.offerText.textContent = o.frage;
      el.offer.hidden = false;
    }

    el.open.addEventListener('click', () => openDrawer(true));
    el.close.addEventListener('click', () => openDrawer(false));
    el.shade.addEventListener('click', () => openDrawer(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.drawer.classList.contains('open')) {
        e.preventDefault();
        openDrawer(false);
      }
    });
    el.add.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = el.input.value.trim();
      if (!text) return;
      try {
        await call('remember', text);
        el.input.value = '';
        toast('Gemerkt.', 'ok');
        refresh();
      } catch {
        toast('Das ging gerade nicht.', 'error');
      }
    });
    el.offer.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-answer]');
      if (!b) return;
      el.offer.hidden = true;
      try {
        await call('answer_suggestion', b.dataset.answer);
      } catch {
        toast('Das ging gerade nicht.', 'error');
      }
    });
    refresh();
    setInterval(refresh, 60000);
    return { refresh, offer };
  }

  window.JarvisGedaechtnis = { create };
})();
