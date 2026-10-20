/** Texte der Browser-Leiste (Deutsch, Englisch als zweite Sprache). */
const de = {
  tabs: 'Tabs',
  newTab: 'Neuer Tab',
  closeTab: 'Tab schließen',
  back: 'Zurück',
  forward: 'Vor',
  reload: 'Neu laden',
  address: 'Adresse oder Suche',
  menu: 'Menü',
  closeMenu: 'Menü schließen',
  bookmark: 'Lesezeichen setzen',
  newPage: 'Neue Seite',
  secure: 'Verschlüsselt (HTTPS)',
  insecure: 'Nicht verschlüsselt',
  upgraded: 'Auf HTTPS umgestellt.',
  allowHttp: 'Unsicher über HTTP öffnen',
  ghost: 'Ghost',
  ghostTor: 'Ghost · Tor',
  blocking: '{count} Regeln aktiv',
  notBlocking: 'Blocker ohne Listen',
  settings: 'Einstellungen',
  httpsOnly: 'Nur HTTPS',
  blockTrackers: 'Werbung und Tracker blockieren',
  javascript: 'JavaScript erlauben',
  doh: 'DNS-over-HTTPS',
  dohOff: 'Aus',
  search: 'Suchmaschine',
  lists: 'Filterlisten',
  listsNone: 'Noch keine Listen geladen – der Blocker blockiert nichts.',
  listsLoaded: '{count} Regeln, Stand {date}',
  listsUpdate: 'EasyList + EasyPrivacy laden',
  listsHint:
    'Lädt die Listen einmal über HTTPS von easylist.to (Lizenzen der Listen: GPL-3.0 / CC BY-SA 3.0). Sonst baut der Browser keine Verbindungen für sich auf.',
  restartHint: 'DNS-over-HTTPS und JavaScript gelten für neue Tabs bzw. nach einem Neustart.',
  bookmarks: 'Lesezeichen',
  noBookmarks: 'Noch keine Lesezeichen.',
  remove: 'Entfernen',
  ghostTitle: 'Ghost-Modus',
  ghostOpen: 'Ghost-Fenster öffnen',
  ghostTorOpen: 'Ghost-Fenster über Tor',
  ghostHint:
    'Ghost-Fenster speichern nichts (InPrivate). Mit Tor laufen sie über einen bereits laufenden Tor- bzw. Arti-Dienst (SOCKS 9150/9050).',
  honest:
    'Ehrlich: Dieser Browser reduziert Tracking, er anonymisiert nicht. Für Anonymität ist der offizielle Tor Browser deutlich stärker (Fingerabdruck-Schutz, geprüfte Einstellungen).',
  windowsOnly: 'Der Blocker wirkt nur unter Windows (WebView2).',
} as const;

export type TextKey = keyof typeof de;

const en: Record<TextKey, string> = {
  tabs: 'Tabs',
  newTab: 'New tab',
  closeTab: 'Close tab',
  back: 'Back',
  forward: 'Forward',
  reload: 'Reload',
  address: 'Address or search',
  menu: 'Menu',
  closeMenu: 'Close menu',
  bookmark: 'Add bookmark',
  newPage: 'New page',
  secure: 'Encrypted (HTTPS)',
  insecure: 'Not encrypted',
  upgraded: 'Switched to HTTPS.',
  allowHttp: 'Open over plain HTTP (unsafe)',
  ghost: 'Ghost',
  ghostTor: 'Ghost · Tor',
  blocking: '{count} rules active',
  notBlocking: 'Blocker without lists',
  settings: 'Settings',
  httpsOnly: 'HTTPS only',
  blockTrackers: 'Block ads and trackers',
  javascript: 'Allow JavaScript',
  doh: 'DNS over HTTPS',
  dohOff: 'Off',
  search: 'Search engine',
  lists: 'Filter lists',
  listsNone: 'No lists loaded yet – the blocker blocks nothing.',
  listsLoaded: '{count} rules, as of {date}',
  listsUpdate: 'Load EasyList + EasyPrivacy',
  listsHint:
    'Downloads the lists once over HTTPS from easylist.to (list licences: GPL-3.0 / CC BY-SA 3.0). Otherwise the browser makes no connections of its own.',
  restartHint: 'DNS over HTTPS and JavaScript apply to new tabs or after a restart.',
  bookmarks: 'Bookmarks',
  noBookmarks: 'No bookmarks yet.',
  remove: 'Remove',
  ghostTitle: 'Ghost mode',
  ghostOpen: 'Open ghost window',
  ghostTorOpen: 'Ghost window via Tor',
  ghostHint:
    'Ghost windows keep nothing (InPrivate). With Tor they run through an already running Tor or Arti service (SOCKS 9150/9050).',
  honest:
    'Honestly: this browser reduces tracking, it does not make you anonymous. For anonymity the official Tor Browser is much stronger (fingerprint protection, vetted settings).',
  windowsOnly: 'The blocker only works on Windows (WebView2).',
};

export type Lang = 'de' | 'en';

export function lang(languages: readonly string[]): Lang {
  return languages.some((l) => l.toLowerCase().startsWith('de')) || languages.length === 0
    ? 'de'
    : 'en';
}

export function text(l: Lang, key: TextKey, vars: Record<string, string> = {}): string {
  const raw = l === 'de' ? de[key] : en[key];
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}
