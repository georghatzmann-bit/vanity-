// Settings dialog: effect quality, sound + volume, about / log export.
import { h } from '../core/dom.js';
import { icon } from './icons.js';
import { Segmented } from './segmented.js';
import { Toggle } from './toggle.js';
import { Button } from './button.js';
import { Badge } from './badge.js';
import { formatPercent } from '../core/format.js';

const EFFECTS = [
  { value: 'ultra', label: 'Ultra', text: 'Alles an. Für starke Grafikkarten.' },
  { value: 'high', label: 'Hoch', text: 'Weniger Partikel. Für die meisten PCs.' },
  { value: 'low', label: 'Niedrig', text: 'Ohne Unschärfe. Für ältere Laptops.' },
  { value: 'off', label: 'Aus', text: 'Keine Animationen. Am schnellsten.' },
];

function section(iconName, title, sub, ...content) {
  return h(
    'section.settings__section',
    h('div.settings__head', h('div.icon-tile', icon(iconName)), h('div', h('div.settings__title', title), h('div.settings__sub', sub))),
    ...content,
  );
}

/** Opens the settings modal. ctx = { api, store, modal, toast, sound } */
export function openSettings({ api, store, modal, toast, sound }) {
  const s = store.get('settings');
  const info = store.get('appInfo') || {};
  const cleanups = [];

  // --- Effects ---
  const explain = h(
    'ul.settings__explain',
    EFFECTS.map((e) => h('li', { dataset: { value: e.value } }, e.text)),
  );
  const markExplain = (v) => explain.querySelectorAll('li').forEach((li) => li.classList.toggle('is-active', li.dataset.value === v));
  const seg = Segmented({
    ariaLabel: 'Effekt-Qualität',
    value: s.effects,
    options: EFFECTS.map(({ value, label }) => ({ value, label })),
    onChange: (v) => {
      store.patch('settings', { effects: v });
      markExplain(v);
    },
  });
  markExplain(s.effects);
  cleanups.push(() => seg.destroy());

  // --- Sound ---
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
  const volumeRow = h('div.settings__volume', icon('volume'), range, volLabel);

  const soundToggle = Toggle({
    label: 'Soundeffekte',
    description: 'Klicks, Übergänge und Erfolgsmeldungen als kurze Töne.',
    checked: s.sound,
    onChange: (on) => {
      store.patch('settings', { sound: on });
      range.disabled = !on;
    },
  });
  range.disabled = !s.sound;
  const offSound = store.subscribe(
    (st) => st.settings.sound,
    (on) => {
      soundToggle.setChecked(on, { silent: true });
      range.disabled = !on;
    },
  );
  cleanups.push(offSound);

  // --- About ---
  const logBtn = Button({
    label: 'Log exportieren',
    icon: 'file',
    variant: 'secondary',
    size: 'sm',
    autoLoading: true,
    onClick: async () => {
      try {
        const res = await api.log.export();
        toast.success('Log exportiert', res && res.path ? res.path : 'Die Datei liegt auf deinem Desktop.');
      } catch (err) {
        toast.error('Log konnte nicht exportiert werden', err.message);
      }
    },
  });
  const meta = h('div.settings__meta', Badge({ tone: 'accent', label: `Version ${info.version || '–'}` }));
  if (info.mock) meta.append(Badge({ tone: 'warn', dot: true, label: 'Testmodus' }));
  if (info.isPackaged === false) meta.append(Badge({ tone: 'neutral', label: 'Entwicklung' }));

  const content = h(
    'div.settings',
    section('sparkles', 'Effekte', 'Wie aufwendig Hintergrund und Animationen sind.', h('div.settings__panel', seg, explain)),
    section('volume', 'Sound', 'Synthetische Effekte, keine Audiodateien.', h('div.settings__panel', soundToggle, volumeRow)),
    section(
      'info',
      'Über PHOENIX',
      'Version, Modus und Protokoll für den Support.',
      h('div.settings__panel.settings__about', h('div', meta, h('div.hint.mt-2', 'Das Protokoll hilft bei Problemen und landet auf dem Desktop.')), logBtn),
    ),
  );

  const handle = modal.open({
    title: 'Einstellungen',
    subtitle: 'Änderungen gelten sofort.',
    icon: 'settings',
    size: 'lg',
    content,
    actions: [{ label: 'Fertig', variant: 'primary', icon: 'check' }],
    onClose: () => cleanups.forEach((fn) => fn()),
    className: 'modal--settings',
  });
  return handle;
}
