// "Virus-Reset": guided clean reinstall after malware. Phoenix does the steps before the reset with
// the user (backup, download links, guide file on the second stick); the rest is a checklist that
// is also saved as an offline HTML page. Ticks are remembered (localStorage) for the session after.
import '../styles/screens/setup.css';
import { h } from '../core/dom.js';
import { icon } from '../components/icons.js';
import { Button } from '../components/button.js';

const KEY = 'phoenix.reset.done.v1';
const loadDone = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return new Set();
  }
};
const saveDone = (set) => {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* session only */
  }
};

export default {
  title: 'Virus-Reset',
  fxState: 'idle',
  mount(container, ctx) {
    const { api, router, toast, sound, fx } = ctx;
    const cleanups = [];
    let alive = true;
    const done = loadDone();
    const list = h('div.rs-list');

    container.append(
      h(
        'div.screen__inner.su',
        h(
          'header.su-head',
          { dataset: { stagger: '' } },
          h('div.t-eyebrow', 'Virus-Reset · saubere Neuinstallation'),
          h('h1.t-h1', 'PC hatte einen ', h('span.t-grad', 'Virus?')),
          h('p.t-lead.c-muted', 'Ein normales „PC zurücksetzen“ reicht dann nicht sicher. Phoenix führt dich durch eine komplett saubere Installation – die ersten Schritte machst du direkt hier, den Rest liest du auf dem Stick oder Handy nach.'),
        ),
        h('div.rs-warn', { dataset: { stagger: '' } }, icon('alert'), h('span', h('b', 'Du brauchst zwei USB-Sticks: '), 'einen für Windows (wird von Rufus gelöscht) und einen für Phoenix-Sicherung + diese Anleitung. Alternativ den Wiederherstellungs-Code aufs Handy schicken.')),
        list,
      ),
    );

    async function saveToStick(btn) {
      const drives = ((await api.drives.list().catch(() => [])) || []).filter((d) => d.kind === 'removable' || d.kind === 'fixed');
      if (!drives.length) return toast.warn('Kein Stick gefunden', 'Steck den zweiten USB-Stick ein und versuch es nochmal.');
      const target = drives.find((d) => d.kind === 'removable') || drives[0];
      const res = await api.reset.saveGuide(target.root).catch((err) => ({ error: err.message }));
      if (!alive) return;
      if (res.error) return toast.error('Nicht gespeichert', res.error);
      toast.success('Anleitung gespeichert', res.path);
      btn.setLabel?.(`Gespeichert auf ${target.root}`);
      mark('save', true);
    }

    function actionFor(step, links) {
      if (!step.action) return null;
      let btn;
      if (step.action === 'backup') btn = Button({ label: 'Sicherung starten', icon: 'shield', variant: 'primary', size: 'sm', onClick: () => (mark('backup', true), router.go('backup', {}, { transition: 'warp' })) });
      else if (step.action === 'save') btn = Button({ label: 'Auf USB-Stick speichern', icon: 'usb', variant: 'primary', size: 'sm', autoLoading: true, onClick: () => saveToStick(btn) });
      else if (step.action.startsWith('link:')) {
        const url = links[step.action.slice(5)];
        btn = Button({ label: step.action === 'link:rufus' ? 'Rufus öffnen' : 'Microsoft-Seite öffnen', icon: 'external', variant: 'secondary', size: 'sm', onClick: () => (api.shell.open(url), mark(step.id, true)) });
      }
      if (btn) cleanups.push(() => btn.destroy?.());
      return btn;
    }

    const rows = new Map();
    function mark(id, on) {
      if (on) done.add(id);
      else done.delete(id);
      saveDone(done);
      const row = rows.get(id);
      if (row) {
        row.el.classList.toggle('is-done', on);
        row.box.checked = on;
      }
    }

    api.reset
      .guide()
      .then(({ steps, phases, links }) => {
        if (!alive) return;
        let n = 0;
        list.replaceChildren(
          ...Object.entries(phases).map(([phase, title]) =>
            h(
              'section.su-card',
              { dataset: { stagger: '' } },
              h('div.t-eyebrow', title),
              steps
                .filter((s) => s.phase === phase)
                .map((s) => {
                  n += 1;
                  const box = h('input.su-check', { type: 'checkbox', checked: done.has(s.id), attrs: { 'aria-label': `${s.title} erledigt` }, onChange: (ev) => (mark(s.id, ev.target.checked), sound.play('click'), ev.target.checked && fx?.pulse?.(0.2)) });
                  const el = h('div.rs-step', { class: done.has(s.id) ? 'is-done' : '' }, h('span.rs-step__n', String(n)), h('div.rs-step__body', h('h3', s.title), h('p.c-muted', s.text)), h('div.rs-step__act', actionFor(s, links), box));
                  rows.set(s.id, { el, box });
                  return el;
                }),
            ),
          ),
        );
      })
      .catch((err) => toast.error('Anleitung nicht geladen', err.message));

    return () => {
      alive = false;
      cleanups.forEach((fn) => fn && fn());
    };
  },
};
