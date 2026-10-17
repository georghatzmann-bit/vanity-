// DEV ONLY – component gallery appended to the home stub with ?demo=1 (used for screenshots).
import { h } from '../core/dom.js';
import { Button } from '../components/button.js';
import { Badge } from '../components/badge.js';
import { AppCard } from '../components/appCard.js';
import { ProgressRing } from '../components/progressRing.js';
import { ProgressBar } from '../components/progressBar.js';
import { Toggle } from '../components/toggle.js';
import { Checkbox } from '../components/checkbox.js';
import { Segmented } from '../components/segmented.js';
import { SearchInput } from '../components/searchInput.js';
import { EmptyState } from '../components/emptyState.js';
import { Card } from '../components/card.js';
import { icon, ICON_NAMES } from '../components/icons.js';
import { countUp } from '../core/motion.js';
import { formatBytes, formatDuration, formatRelativeDate } from '../core/format.js';

const DEMO_APPS = [
  { key: 'winget:Discord.Discord', name: 'Discord', desc: 'Sprach- und Text-Chat für Gamer', homepage: 'https://discord.com' },
  { key: 'winget:Valve.Steam', name: 'Steam', desc: 'Spiele-Plattform von Valve', homepage: 'https://store.steampowered.com' },
  { key: 'winget:Spotify.Spotify', name: 'Spotify', desc: 'Musik und Podcasts streamen', homepage: 'https://www.spotify.com' },
  { key: 'winget:OBSProject.OBSStudio', name: 'OBS Studio', desc: 'Streamen und Aufnehmen', homepage: 'https://obsproject.com' },
  { key: 'winget:EpicGames.EpicGamesLauncher', name: 'Epic Games Launcher', desc: 'Fortnite, Rocket League und Gratis-Spiele', homepage: 'https://store.epicgames.com' },
  { key: 'winget:7zip.7zip', name: '7-Zip', desc: 'Archive entpacken und packen', homepage: 'https://www.7-zip.org' },
  { key: 'winget:Medal.TV', name: 'Medal', desc: 'Clips aufnehmen und teilen', homepage: '' },
  { key: 'winget:Logitech.GHUB', name: 'Logitech G HUB', desc: 'Maus, Tastatur und Headset einstellen', homepage: '' },
  { key: 'winget:Guru3D.Afterburner', name: 'MSI Afterburner', desc: 'Grafikkarte übertakten und überwachen', homepage: '' },
];

const section = (title, sub, ...content) =>
  h('section.demo__section', { dataset: { stagger: '' } }, h('div.demo__head', h('h2.t-h2', title), sub ? h('p.hint', sub) : null), ...content);

export function renderDemo(root, ctx) {
  const { toast, modal } = ctx;
  const cleanups = [];

  // Buttons
  const loadingBtn = Button({ label: 'Speichern', variant: 'secondary', icon: 'download', loading: true });
  const buttons = h(
    'div.demo__row',
    Button({ label: 'Primär', variant: 'primary', icon: 'rocket' }),
    Button({ label: 'Sekundär', variant: 'secondary', icon: 'folder' }),
    Button({ label: 'Ghost', variant: 'ghost', icon: 'external' }),
    Button({ label: 'Löschen', variant: 'danger', icon: 'trash' }),
    loadingBtn,
    Button({ label: 'Klein', variant: 'secondary', size: 'sm' }),
    Button({ icon: 'settings', title: 'Einstellungen', variant: 'secondary' }),
    Button({ label: 'Groß & XL', variant: 'primary', size: 'xl', iconRight: 'arrow-right' }),
  );

  // Badges
  const badges = h(
    'div.demo__row',
    Badge({ tone: 'neutral', label: 'Warteschlange' }),
    Badge({ tone: 'accent', label: 'Empfohlen', icon: 'sparkles' }),
    Badge({ tone: 'ok', label: 'Installiert', icon: 'check' }),
    Badge({ tone: 'warn', label: 'Neustart nötig', icon: 'alert' }),
    Badge({ tone: 'err', label: 'Fehlgeschlagen', icon: 'x' }),
    Badge({ tone: 'accent', label: 'Läuft', dot: true, live: true }),
  );

  // App cards
  const grid = h('div.grid-auto.demo__apps');
  DEMO_APPS.forEach((app, i) => {
    const card = AppCard({ app, selected: i % 3 !== 2, onToggle: (on) => console.log('toggle', app.name, on) });
    if (i === 0) card.setBadge({ tone: 'ok', label: 'Installiert', icon: 'check' });
    if (i === 1) card.setProgress(0.62);
    if (i === 3) {
      card.setBadge({ tone: 'accent', label: 'Lädt', dot: true, live: true });
      card.setProgress(null);
    }
    if (i === 7) card.setBadge({ tone: 'err', label: 'Fehler', icon: 'x' });
    grid.append(card);
  });

  // Progress
  const ring = ProgressRing({ size: 220, value: 0, label: 'installiert' });
  setTimeout(() => ring.setValue(0.68), 600);
  const counter = h('span.stat__value', '0');
  countUp(counter, 25, { duration: 1.6, delay: 0.5 });
  const progress = h(
    'div.demo__progress',
    ring,
    h(
      'div.col.gap-5.grow',
      h('div.col.gap-2', h('div.row.justify-between', h('span.fw-600', 'Download'), h('span.hint.t-num', `${formatBytes(84e6)} von ${formatBytes(132e6)}`)), ProgressBar({ value: 0.64, active: true })),
      h('div.col.gap-2', h('div.row.justify-between', h('span.fw-600', 'winget wird vorbereitet'), h('span.hint', 'unbestimmt')), ProgressBar({ value: null })),
      h('div.col.gap-2', h('div.row.justify-between', h('span.fw-600', 'Fertig'), h('span.hint', formatDuration(80000))), ProgressBar({ value: 1, tone: 'ok' })),
      h('div.col.gap-2', h('div.row.justify-between', h('span.fw-600', 'Abgebrochen'), h('span.hint', formatRelativeDate(new Date()))), ProgressBar({ value: 0.35, tone: 'err' })),
      h('div.row.gap-6', h('div.stat', counter, h('span.stat__label', 'Apps gefunden')), h('div.stat', h('span.stat__value', '4'), h('span.stat__label', 'Spiele'))),
    ),
  );

  // Inputs
  const seg = Segmented({
    ariaLabel: 'Ansicht',
    value: 'grid',
    options: [
      { value: 'grid', label: 'Kacheln', icon: 'grid' },
      { value: 'list', label: 'Liste', icon: 'list' },
      { value: 'cat', label: 'Kategorien', icon: 'layers' },
    ],
  });
  cleanups.push(() => seg.destroy());
  const search = SearchInput({ placeholder: 'Apps durchsuchen …', onInput: (q) => console.log('search', q) });
  cleanups.push(() => search.destroy());
  const inputs = h(
    'div.grid-2',
    Card(
      {},
      h('div.col.gap-4', search, seg),
      h(
        'div.col.mt-4',
        Checkbox({ label: 'Neustart automatisch', description: 'Startet Windows neu, wenn ein Installer das verlangt.', checked: true }),
        Checkbox({ label: 'Desktop-Verknüpfungen', description: 'Legt für jede App ein Symbol auf dem Desktop an.' }),
      ),
    ),
    Card(
      {},
      Toggle({ label: 'Soundeffekte', description: 'Kurze Töne für Klicks und Erfolge.', checked: true }),
      Toggle({ label: 'Mit Windows starten', description: 'PHOENIX öffnet sich nach dem Reset automatisch.' }),
      Toggle({ label: 'Deaktiviert', description: 'So sieht ein gesperrter Schalter aus.', disabled: true }),
    ),
  );

  // Empty state + icons
  const empty = Card(
    { padding: 'flush' },
    EmptyState({
      icon: 'usb',
      title: 'Noch kein Profil gefunden',
      text: 'Steck den USB-Stick mit deiner Sicherung ein oder öffne die Profil-Datei manuell.',
      actions: [
        { label: 'Datei öffnen', icon: 'folder', variant: 'primary' },
        { label: 'Code einfügen', icon: 'key', variant: 'secondary' },
      ],
    }),
  );
  const icons = h('div.demo__icons', ICON_NAMES.map((n) => h('div.demo__icon', { title: n }, icon(n), h('span', n))));

  // Feedback
  const feedback = h(
    'div.demo__row',
    Button({ label: 'Erfolg', variant: 'secondary', icon: 'check-circle', onClick: () => toast.success('Profil gespeichert', 'E:\\Phoenix\\Phoenix-Profil-GAMING-PC-2026-10-17.phoenix.json') }),
    Button({ label: 'Info', variant: 'secondary', icon: 'info', onClick: () => toast.info('Code kopiert', 'Schick ihn dir per WhatsApp oder Mail.') }),
    Button({ label: 'Warnung', variant: 'secondary', icon: 'alert', onClick: () => toast.warn('Zweite Festplatte', 'Bleibt nur erhalten, wenn der Reset nur Laufwerk C: löscht.') }),
    Button({ label: 'Fehler', variant: 'secondary', icon: 'x-circle', onClick: () => toast.error('Installation fehlgeschlagen', 'Logitech G HUB: Der Installer-Hash stimmt nicht überein.') }),
    Button({
      label: 'Dialog',
      variant: 'secondary',
      icon: 'layers',
      onClick: () =>
        modal.confirm({ title: 'Installation abbrechen?', message: 'Bereits installierte Apps bleiben erhalten. Die restlichen werden übersprungen.', confirmLabel: 'Abbrechen', cancelLabel: 'Weiter installieren', danger: true }),
    }),
  );

  const demo = h(
    'div.demo',
    h('div.divider'),
    section('Buttons', 'Primär mit Lichtkante, Glow und Magnet-Effekt. Sekundär als Glas.', buttons),
    section('Status', 'Statusfarben immer mit Text.', badges),
    section('App-Kacheln', 'Favicon mit Monogramm-Fallback, Auswahl, Status und Fortschritt.', grid),
    section('Fortschritt', null, Card({}, progress)),
    section('Eingaben', 'Jede Option mit grauer Erklärung.', inputs),
    section('Leerer Zustand', null, empty),
    section('Rückmeldung', 'Toasts unten rechts, Dialog mit Fokusfalle.', feedback),
    section('Icons', `${ICON_NAMES.length} handgezeichnete 24-px-Icons.`, Card({}, icons)),
  );
  root.append(demo);
  return () => cleanups.forEach((fn) => fn());
}
