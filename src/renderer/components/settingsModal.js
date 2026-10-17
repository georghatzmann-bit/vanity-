// Settings dialog: effect quality, sound + volume, about / log export.
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { Segmented } from './segmented.js';
import { Toggle } from './toggle.js';
import { Button } from './button.js';
import { Badge } from './badge.js';
import { formatPercent } from '../core/format.js';
import { gsap, motionOK } from '../core/motion.js';

const EFFECTS = [
  { value: 'ultra', label: 'Ultra', text: 'Alles an. Für starke Grafikkarten.' },
  { value: 'high', label: 'Hoch', text: 'Weniger Partikel. Passt für die meisten PCs.' },
  { value: 'low', label: 'Niedrig', text: 'Ohne Unschärfe-Effekte. Für ältere Laptops.' },
  { value: 'off', label: 'Aus', text: 'Keine Animationen. Am schnellsten.' },
];

const group = (label, ...content) => h('section.settings__group', h('h3.settings__label', label), ...content);

/** Opens the settings modal. ctx = { api, store, modal, toast, sound } */
export function openSettings({ api, store, modal, toast, sound }) {
  const s = store.get('settings');
  const info = store.get('appInfo') || {};
  const cleanups = [];

  // --- Effects: segmented control + one line that explains the active level ---
  const explain = h('p.settings__explain', { attrs: { 'aria-live': 'polite' } });
  const showExplain = (v, animate) => {
    const e = EFFECTS.find((x) => x.value === v) || EFFECTS[0];
    explain.replaceChildren(h('b', `${e.label}:`), h('span', e.text));
    if (animate && motionOK()) gsap.fromTo(explain, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out', clearProps: 'transform,opacity' });
  };
  const seg = Segmented({
    ariaLabel: 'Effekt-Qualität',
    value: s.effects,
    options: EFFECTS.map(({ value, label }) => ({ value, label })),
    onChange: (v) => {
      store.patch('settings', { effects: v });
      showExplain(v, true);
    },
  });
  showExplain(s.effects, false);
  cleanups.push(() => seg.destroy());

  // --- Sound: switch + volume row ---
  const volLabel = h('span.t-num.fs-sm.text-right', formatPercent(s.volume));
  const range = h('input.range', {
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: String(Math.round(s.volume * 100)),
    attrs: { 'aria-label': 'Lautstärke' },
  });
  const syncRange = () => {
    range.style.setProperty('--val', `${range.value}%`);
    volLabel.textContent = formatPercent(range.value / 100);
  };
  range.addEventListener('input', () => {
    syncRange();
    store.patch('settings', { volume: range.value / 100 });
  });
  range.addEventListener('change', () => sound.play('click'));
  syncRange();
  const volume = h('div.settings__volume', icon('volume'), range, volLabel);
  const volumeRow = h('div.settings__row', h('span.settings__row-label', 'Lautstärke'), volume);

  const setSoundEnabled = (on) => {
    range.disabled = !on;
    volume.classList.toggle('is-disabled', !on);
  };
  const soundToggle = Toggle({
    label: 'Soundeffekte',
    description: 'Kurze Töne bei Klicks, Übergängen und Erfolgen.',
    checked: s.sound,
    onChange: (on) => {
      store.patch('settings', { sound: on });
      setSoundEnabled(on);
    },
  });
  setSoundEnabled(s.sound);
  // The titlebar speaker button changes the same setting while the dialog is open.
  cleanups.push(
    store.subscribe(
      (st) => st.settings.sound,
      (on) => {
        soundToggle.setChecked(on, { silent: true });
        setSoundEnabled(on);
      },
    ),
  );

  // --- Footer: version + log export (secondary, left) ---
  const logBtn = Button({
    label: 'Log exportieren',
    icon: 'file',
    variant: 'ghost',
    size: 'sm',
    autoLoading: true,
    title: 'Speichert das Protokoll auf dem Desktop – hilfreich, wenn etwas nicht klappt.',
    onClick: async () => {
      try {
        const res = await api.log.export();
        toast.success('Log gespeichert', res && res.path ? res.path : 'Die Datei liegt auf deinem Desktop.');
      } catch (err) {
        toast.error('Log konnte nicht gespeichert werden', err.message);
      }
    },
  });
  cleanups.push(() => logBtn.destroy());
  const meta = h('div.settings__meta', h('span', h('b', 'PHOENIX'), info.version ? ` ${info.version}` : ''));
  if (info.mock) meta.append(Badge({ tone: 'warn', dot: true, label: 'Testmodus' }));
  else if (info.isPackaged === false) meta.append(Badge({ tone: 'neutral', label: 'Entwicklung' }));

  const content = h(
    'div.settings',
    group('Effekte', h('div.settings__panel', seg, explain)),
    group('Sound', h('div.settings__panel', soundToggle, volumeRow)),
  );

  return modal.open({
    title: 'Einstellungen',
    subtitle: 'Änderungen gelten sofort.',
    icon: 'settings',
    size: 'md',
    content,
    footStart: h('div.row.gap-3', meta, logBtn),
    actions: [{ label: 'Fertig', variant: 'primary' }],
    onClose: () => cleanups.forEach((fn) => fn()),
    className: 'modal--settings',
  });
}
