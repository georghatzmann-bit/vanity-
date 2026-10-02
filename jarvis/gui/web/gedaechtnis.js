/* Jarvis – Gedächtnis: Zusammenfassung in der rechten Spalte und alles in einer Schublade.
   Vorschläge aus den Gewohnheiten sagt Jarvis als Ergänzung zu einer Antwort, ohne Karte. */
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
      schedules: $('memSchedules'),
      schedulesEmpty: $('memSchedulesEmpty'),
      skills: $('memSkills'),
      skillsEmpty: $('memSkillsEmpty'),
      notebook: $('memNotebook'),
      commands: $('memCommands'),
      commandsEmpty: $('memCommandsEmpty'),
      birthdays: $('memBirthdays'),
      birthdaysEmpty: $('memBirthdaysEmpty'),
      facts: $('memFacts'),
      factsEmpty: $('memFactsEmpty'),
    };
    if (!el.sum) return null;
    let data = { facts: [], contacts: [], routines: [], birthdays: [], commands: [], skills: [], notebook: false };
    const MONTHS = ['Jän.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];

    function when(days) {
      if (days === 0) return 'heute';
      if (days === 1) return 'morgen';
      return 'in ' + days + ' Tagen';
    }

    function birthdayLine(b) {
      return b.own ? 'Ihr Geburtstag ist ' + when(b.days) : b.shown + ' hat ' + when(b.days) + ' Geburtstag';
    }

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
      const birthdays = data.birthdays || [];
      const first = routines[0];
      const soon = birthdays.find((b) => b.days <= 7);
      el.next.hidden = !first && !soon;
      if (soon) el.next.textContent = birthdayLine(soon);
      else if (first) el.next.textContent = first.tage + ' gegen ' + first.uhrzeit + ' Uhr: ' + first.label;

      const commands = data.commands || [];
      if (el.commands) {
        el.commands.replaceChildren(...commands.map((c) => {
          const li = document.createElement('li');
          const name = document.createElement('b');
          name.className = 'mem-cmd';
          name.textContent = c.name;
          const text = document.createElement('span');
          text.className = 'mem-text';
          text.textContent = c.action;
          const small = document.createElement('small');
          small.textContent = c.count ? (c.count === 1 ? 'einmal benutzt' : c.count + '-mal benutzt') : 'noch nicht benutzt';
          text.appendChild(small);
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'mem-del';
          del.textContent = '×';
          del.title = 'Befehl löschen';
          del.setAttribute('aria-label', 'Befehl löschen: ' + c.name);
          del.addEventListener('click', async () => {
            try {
              await call('command_forget', c.key);
              toast('Befehl gelöscht.', 'ok');
              refresh();
            } catch {
              toast('Das ging gerade nicht.', 'error');
            }
          });
          li.append(name, text, del);
          return li;
        }));
        el.commandsEmpty.hidden = commands.length > 0;
      }

      const schedules = data.schedules || [];
      if (el.schedules) {
        el.schedules.replaceChildren(...schedules.map((z) => {
          const li = document.createElement('li');
          const time = document.createElement('span');
          time.className = 'mem-time';
          time.textContent = z.time;
          const text = document.createElement('span');
          text.className = 'mem-text';
          text.textContent = z.command;
          const small = document.createElement('small');
          small.textContent = z.days;
          text.appendChild(small);
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'mem-del';
          del.textContent = '×';
          del.title = 'Zeitplan löschen';
          del.setAttribute('aria-label', 'Zeitplan löschen: ' + z.command);
          del.addEventListener('click', async () => {
            try {
              await call('schedule_forget', z.id);
              toast('Zeitplan gelöscht.', 'ok');
              refresh();
            } catch {
              toast('Das ging gerade nicht.', 'error');
            }
          });
          li.append(time, text, del);
          return li;
        }));
        el.schedulesEmpty.hidden = schedules.length > 0;
      }

      const skills = data.skills || [];
      if (el.skills) {
        el.skills.replaceChildren(...skills.map((k) => {
          const li = document.createElement('li');
          const name = document.createElement('b');
          name.className = 'mem-cmd';
          name.textContent = k.name + (k.learned ? ' ★' : '');
          const text = document.createElement('span');
          text.className = 'mem-text';
          text.textContent = k.description;
          if (k.learned) {
            const small = document.createElement('small');
            small.textContent = 'selbst gelernt';
            text.appendChild(small);
          }
          li.append(name, text);
          if (k.learned) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'mem-del';
            del.textContent = '×';
            del.title = 'Fähigkeit löschen';
            del.setAttribute('aria-label', 'Fähigkeit löschen: ' + k.name);
            del.addEventListener('click', async () => {
              try {
                await call('skill_forget', k.name);
                toast('Fähigkeit gelöscht.', 'ok');
                refresh();
              } catch {
                toast('Das ging gerade nicht.', 'error');
              }
            });
            li.appendChild(del);
          }
          return li;
        }));
        el.skillsEmpty.hidden = skills.length > 0;
      }
      if (el.notebook) el.notebook.disabled = !data.notebook;

      if (el.birthdays) {
        el.birthdays.replaceChildren(...birthdays.map((b) => {
          const li = document.createElement('li');
          const date = document.createElement('span');
          date.className = 'mem-time';
          const d = new Date(b.date + 'T12:00:00');
          date.textContent = isNaN(d) ? '' : d.getDate() + '. ' + MONTHS[d.getMonth()];
          const text = document.createElement('span');
          text.className = 'mem-text';
          text.textContent = b.own ? 'Ihr Geburtstag' : b.shown;
          const small = document.createElement('small');
          small.textContent = when(b.days);
          text.appendChild(small);
          li.append(date, text);
          return li;
        }));
        el.birthdaysEmpty.hidden = birthdays.length > 0;
      }

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

    // Vorschläge stehen in Jarvis' Antwort ("Übrigens, Sir: ..."), es gibt keine Karte mehr.
    function offer() {}

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
    if (el.notebook) {
      el.notebook.addEventListener('click', async () => {
        try {
          const res = await call('notebook_open');
          if (res && res.ok) toast('Notizbuch geöffnet: ' + res.folder, 'ok');
          else toast((res && res.error) || 'Das ging gerade nicht.', 'error');
        } catch {
          toast('Das ging gerade nicht.', 'error');
        }
      });
    }
    refresh();
    setInterval(refresh, 60000);
    return { refresh, offer };
  }

  window.JarvisGedaechtnis = { create };
})();
