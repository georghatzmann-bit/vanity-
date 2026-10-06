// VELOX icon set: inline SVG, 24x24 grid, stroke 1.75, round caps. No emojis anywhere.
// Paths are static strings defined here only (never data from the API), so parsing them is safe.

const P = {
  // navigation
  home: '<path d="M3.5 10.5 12 3.8l8.5 6.7"/><path d="M5.5 9v10.2c0 .4.3.8.8.8H10v-5.5h4V20h3.7c.5 0 .8-.4.8-.8V9"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  stack: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z"/><path d="m3.5 12 8.5 4.5 8.5-4.5"/><path d="m3.5 16 8.5 4.5 8.5-4.5"/>',
  brain: '<path d="M12 5.5a3 3 0 0 0-5.6-1.3A3 3 0 0 0 4 8.3a3.2 3.2 0 0 0 .3 5.4A3 3 0 0 0 7.5 18a3 3 0 0 0 4.5 1.4"/><path d="M12 5.5a3 3 0 0 1 5.6-1.3A3 3 0 0 1 20 8.3a3.2 3.2 0 0 1-.3 5.4 3 3 0 0 1-3.2 4.3 3 3 0 0 1-4.5 1.4"/><path d="M12 5.5v14"/><path d="M8.5 10.5c1 0 1.8.8 1.8 1.8M15.5 10.5c-1 0-1.8.8-1.8 1.8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  gamepad: '<path d="M7.5 7h9a4.5 4.5 0 0 1 4.4 5.5l-.9 4a2.6 2.6 0 0 1-4.4 1.2L13.8 16h-3.6l-1.8 1.7A2.6 2.6 0 0 1 4 16.5l-.9-4A4.5 4.5 0 0 1 7.5 7Z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11" r=".6" fill="currentColor"/><circle cx="17" cy="13" r=".6" fill="currentColor"/>',
  broom: '<path d="M14.5 3.5 11 9.5"/><path d="M8.2 9.3 13.5 12.3c.6.4.8 1.2.4 1.8l-.4.6"/><path d="M7.5 10.5c-2 1.3-3.2 3.6-3.5 6.5l-.5 3.5h3l1-2 .5 2h3l1-2.5.5 2.5h2.2c.6-2 .9-4.6.8-6.5"/>',
  package: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/><path d="m8 5.3 8 4.5"/>',
  archive: '<rect x="3.5" y="4" width="17" height="4.5" rx="1.2"/><path d="M5 8.5V19c0 .6.4 1 1 1h12c.6 0 1-.4 1-1V8.5"/><path d="M10 12.5h4"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.4h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4-2-1.6Z"/>',
  // categories
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v3.5"/>',
  bolt: '<path d="M13 2.8 4.8 13.2c-.3.4 0 .8.4.8H11l-1 7.2 8.2-10.4c.3-.4 0-.8-.4-.8H12l1-7.2Z"/>',
  gpu: '<rect x="2.5" y="6" width="19" height="11" rx="1.6"/><circle cx="9" cy="11.5" r="2.8"/><path d="M15 9.5h3.5M15 12h3.5M15 14.5h3.5"/><path d="M5 17v2.5M8 17v2.5"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.4a9.5 9.5 0 0 1 13 0"/><path d="M8.7 15.7a5 5 0 0 1 6.6 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
  shield: '<path d="M12 3 5 5.8v5.4c0 4.4 3 8.3 7 9.8 4-1.5 7-5.4 7-9.8V5.8L12 3Z"/>',
  shieldCheck: '<path d="M12 3 5 5.8v5.4c0 4.4 3 8.3 7 9.8 4-1.5 7-5.4 7-9.8V5.8L12 3Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  sparkles: '<path d="M10 3.5 11.6 8a2 2 0 0 0 1.3 1.3l4.6 1.7-4.6 1.6a2 2 0 0 0-1.3 1.3L10 18.5l-1.6-4.6a2 2 0 0 0-1.3-1.3L2.5 11l4.6-1.7A2 2 0 0 0 8.4 8L10 3.5Z"/><path d="M18 3v4M16 5h4M18.5 16.5v3M17 18h3"/>',
  layers: '<path d="m12 4 8.5 4.3L12 12.5 3.5 8.3 12 4Z"/><path d="m3.5 12.3 8.5 4.2 8.5-4.2"/><path d="m3.5 16.2 8.5 4.3 8.5-4.3"/>',
  layout: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9h17M9.5 9v11"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".9" fill="currentColor"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/>',
  alert: '<path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  wrench: '<path d="M14.7 6.3a4.5 4.5 0 0 0 5.3 5.3l-1.6-1.6-.3-2.6 2.2-2.2a5.5 5.5 0 0 0-7.4 7l-8.2 8.2a1.8 1.8 0 0 0 2.6 2.6l8.2-8.2"/>',
  // general
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.3 2.6 2.6 5-5.3"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2"/><circle cx="12" cy="7.9" r=".9" fill="currentColor"/>',
  warn: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.2"/><circle cx="12" cy="16" r=".9" fill="currentColor"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  arrowRight: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/><path d="m15.5 10-2 2 2 2"/>',
  refresh: '<path d="M20 11.5a8 8 0 0 0-14.3-4.8L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 12.5a8 8 0 0 0 14.3 4.8l1.7-1.8"/><path d="M20 20v-4.5h-4.5"/>',
  play: '<path d="M7 4.8v14.4c0 .8.9 1.3 1.5.8l11-7.2a1 1 0 0 0 0-1.6l-11-7.2C7.9 3.5 7 4 7 4.8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8c0-.5.4-.8.8-.8h3.4c.5 0 .8.3.8.8v1.7"/><path d="M6.2 6.5 7 19.2c0 .5.5.8 1 .8h8c.5 0 1-.3 1-.8l.8-12.7"/><path d="M10 10.5v6M14 10.5v6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4.5V9H8"/><path d="M12 8v4.5l3 1.8"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2.5V5M15 2.5V5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5"/><path d="M9 9h6v6H9z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 21h7M12 17v4"/>',
  drive: '<rect x="3" y="12" width="18" height="7" rx="2"/><path d="M5 12 7.5 5.6c.2-.4.6-.6 1-.6h7c.4 0 .8.2 1 .6L19 12"/><circle cx="16.5" cy="15.5" r=".9" fill="currentColor"/><path d="M6.5 15.5h5"/>',
  windows: '<path d="M3.5 5.8 10.5 4.8v6.7h-7V5.8ZM12.5 4.5l8-1.2v8.2h-8v-7ZM3.5 12.5h7v6.7l-7-1V12.5ZM12.5 12.5h8v8.2l-8-1.2v-7Z"/>',
  ram: '<rect x="2.5" y="7" width="19" height="9" rx="1.5"/><path d="M6 10.5h2v2.5H6zM11 10.5h2v2.5h-2zM16 10.5h2v2.5h-2z"/><path d="M5 16v2.5M9 16v2.5M15 16v2.5M19 16v2.5"/>',
  hz: '<path d="M2.5 12h3l2-6 3.5 12 3-9 2 5 1.5-2h4"/>',
  command: '<path d="M9 9V6.5A2.5 2.5 0 1 0 6.5 9H9Zm0 0h6m-6 0v6m6-6V6.5A2.5 2.5 0 1 1 17.5 9H15Zm0 0v6m0 0h-6m6 0v2.5a2.5 2.5 0 1 0 2.5-2.5H15Zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15H9Z"/>',
  folder: '<path d="M3.5 7.5c0-1.1.9-2 2-2h3.8l2 2.2h7.2c1.1 0 2 .9 2 2v7.8c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2V7.5Z"/>',
  file: '<path d="M14 3.5H7.5c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2V8L14 3.5Z"/><path d="M14 3.5V8h4.5"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.8-8.8M17 6l2.5 2.5M14.5 8.5 16.5 10.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  power: '<path d="M12 3v8"/><path d="M7.2 6.3a7.5 7.5 0 1 0 9.6 0"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5"/><path d="M20 3.5v5h-5"/>',
  external: '<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4.5c0 .6-.4 1-1 1H5.5c-.6 0-1-.4-1-1V7c0-.6.4-1 1-1H10"/>',
  dots: '<circle cx="5.5" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor"/>',
  filter: '<path d="M3.5 5.5h17l-6.5 7.8v5.2l-4 1.8v-7L3.5 5.5Z"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8L12 3.5Z"/>',
  rocket: '<path d="M12.5 15.5 8.5 11.5c1.6-4.5 5-7.5 11.5-8-.5 6.5-3.5 9.9-8 11.5Z"/><path d="M8.5 11.5 5 11l2.5-3.5h4"/><path d="m12.5 15.5.5 3.5 3.5-2.5v-4"/><path d="M6.5 15.5c-1.5.5-2.5 2-3 5 3-.5 4.5-1.5 5-3"/><circle cx="15" cy="9" r="1.4"/>',
  flame: '<path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.4-2.3-5.6-3.6-7.8-.6 1.6-1.6 2.7-2.9 3.2.3-3.2-1.2-5.7-3.6-7.2.2 3.2-1.4 5-2.8 6.8A8 8 0 0 0 5.5 15c0 3.5 2.6 6 6.5 6Z"/><path d="M12 21c-1.6 0-2.8-1.2-2.8-2.9 0-1.8 1.6-2.7 2.3-4.1 1.5 1 3.3 2.3 3.3 4.1 0 1.7-1.2 2.9-2.8 2.9Z"/>',
  leaf: '<path d="M5 19c0-8 5-13 15-14-1 10-6 15-13 15"/><path d="M5 19c3-4 6-6.5 9.5-8.5"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M21.5 10.5v3"/><path d="M6 10.5v3M9.5 10.5v3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 5.6A9.7 9.7 0 0 1 12 5.5c5 0 8.5 4.5 9.5 6.5-.5 1-1.6 2.6-3.1 3.9M6.5 7.3C4.6 8.6 3.2 10.5 2.5 12c1 2 4.5 6.5 9.5 6.5 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  eye: '<path d="M2.5 12c1-2 4.5-6.5 9.5-6.5s8.5 4.5 9.5 6.5c-1 2-4.5 6.5-9.5 6.5S3.5 14 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8"/><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  car: '<path d="M5 16.5H3.8c-.4 0-.8-.4-.8-.8v-3.2c0-.6.3-1.1.8-1.4l1.7-.9 1.8-3.6c.3-.6 1-1.1 1.7-1.1h6c.7 0 1.4.4 1.7 1.1l1.8 3.6 1.7.9c.5.3.8.8.8 1.4v3.2c0 .4-.4.8-.8.8H19"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/><path d="M9.5 16.5h5M5.5 10.6h13"/>',
  trophy: '<path d="M8 4.5h8v5a4 4 0 0 1-8 0v-5Z"/><path d="M8 6.5H5.5a2.5 2.5 0 0 0 2.6 3.5M16 6.5h2.5a2.5 2.5 0 0 1-2.6 3.5"/><path d="M12 13.5v3.5M8.5 20h7l-.8-3h-5.4l-.8 3Z"/>',
  scale: '<path d="M12 4v16M7 20h10"/><path d="M5 7h14"/><path d="m5 7-2.5 6a2.5 2.5 0 0 0 5 0L5 7ZM19 7l-2.5 6a2.5 2.5 0 0 0 5 0L19 7Z"/>',
  radar: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 18 6"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r=".9" fill="currentColor"/><circle cx="4" cy="12" r=".9" fill="currentColor"/><circle cx="4" cy="18" r=".9" fill="currentColor"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M4.5 19.5h15"/>',
  pin: '<path d="M12 21s6.5-5.8 6.5-11a6.5 6.5 0 0 0-13 0c0 5.2 6.5 11 6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  gauge: '<path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0"/><path d="m12 13.5 3.5-4.5"/><circle cx="12" cy="13.5" r="1.3"/>',
  zap: '<path d="M13 2.8 4.8 13.2c-.3.4 0 .8.4.8H11l-1 7.2 8.2-10.4c.3-.4 0-.8-.4-.8H12l1-7.2Z"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.5 1.8-1.5h2.1a4 4 0 0 0 4-4.1c0-3.8-3.8-6.9-8.5-6.9Z"/><circle cx="7.8" cy="11" r="1" fill="currentColor"/><circle cx="10.5" cy="7.3" r="1" fill="currentColor"/><circle cx="15" cy="7.8" r="1" fill="currentColor"/>',
  motion: '<path d="M3 12h4M3 7.5h7M3 16.5h6"/><circle cx="16" cy="12" r="4.5"/>',
  volume: '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  flask: '<path d="M9.5 3.5h5M10.5 3.5v5.2L5 18.3A1.5 1.5 0 0 0 6.3 20.5h11.4a1.5 1.5 0 0 0 1.3-2.2l-5.5-9.6V3.5"/><path d="M7.5 14.5h9"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.6A3.8 3.8 0 0 1 17.5 18.5H7Z"/>',
  send: '<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4 17-6.5Z"/>',
  // the brand mark (brand/mark.svg): the wordmark's V, cut once, the upper half one step ahead, the foot in signal
  logo: '<g transform="translate(1.3 2) scale(.2)" stroke="none"><path fill="currentColor" d="M22.84 0L47.84 0L52.56 44L28.63 44ZM63.18 44L81.84 0L106.84 0L87.11 44Z"/><path fill="#FF5A1F" d="M46.41 52L47.7 64L52.79 52L76.52 52L55 100L29 100L22.68 52Z"/></g>'
};

const ALIAS = {
  video: 'broadcast',
  overview: 'home', tweaks: 'sliders', presets: 'stack', advisor: 'brain', detweak: 'undo', games: 'gamepad', cleanup: 'broom', apps: 'package', backups: 'archive', settings: 'cog',
  shieldcheck: 'shieldCheck', 'shield-check': 'shieldCheck', gauge2: 'gauge', crown: 'trophy', competitive: 'target', esport: 'target', fivem: 'car', privacy: 'eye-off', streaming: 'broadcast',
  laptop: 'battery', clean: 'broom', safe: 'shieldCheck', ultimate: 'rocket', balanced: 'scale', trash2: 'trash', wifi2: 'wifi', bolt2: 'bolt', cpu2: 'cpu', 'alert-triangle': 'alert', warning: 'alert'
};

const cache = new Map();
const NS = 'http://www.w3.org/2000/svg';

/** Returns a fresh <svg> element for a known icon name (falls back to "sparkles"). */
export function icon(name, size = 18, cls = '') {
  // Own-property lookups only: a catalog icon such as "constructor" must not reach Object.prototype.
  const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
  const n = String(name || '');
  let key = own(P, n) ? n : own(ALIAS, n) ? ALIAS[n] : own(ALIAS, n.toLowerCase()) ? ALIAS[n.toLowerCase()] : 'sparkles';
  if (!own(P, key)) key = 'sparkles';
  let tpl = cache.get(key);
  if (!tpl) {
    tpl = document.createElementNS(NS, 'svg');
    tpl.setAttribute('viewBox', '0 0 24 24');
    tpl.setAttribute('fill', 'none');
    tpl.setAttribute('stroke', 'currentColor');
    tpl.setAttribute('stroke-width', '1.75');
    tpl.setAttribute('stroke-linecap', 'round');
    tpl.setAttribute('stroke-linejoin', 'round');
    tpl.setAttribute('aria-hidden', 'true');
    tpl.setAttribute('focusable', 'false');
    // Static markup from the table above only.
    const doc = new DOMParser().parseFromString('<svg xmlns="' + NS + '">' + P[key] + '</svg>', 'image/svg+xml');
    for (const child of Array.from(doc.documentElement.childNodes)) tpl.appendChild(document.importNode(child, true));
    cache.set(key, tpl);
  }
  const el = tpl.cloneNode(true);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('class', ('icon ' + cls).trim());
  el.dataset.icon = key;
  return el;
}

export const iconNames = Object.keys(P);
