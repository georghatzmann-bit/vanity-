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
  allowHttp: '{host} unverschlüsselt (HTTP) öffnen',
  ghost: 'Ghost',
  ghostTor: 'Ghost · Tor-Proxy',
  ghostTorTitle:
    'Alle Seiten laufen über den SOCKS-Proxy 127.0.0.1:{port}. AEGIS kann nicht prüfen, ob dort wirklich Tor läuft.',
  blocking: '{count} Regeln aktiv',
  notBlocking: 'Blocker ohne Listen',
  blockingOff: 'Blocker aus',
  settings: 'Einstellungen',
  httpsOnly: 'Nur HTTPS',
  blockTrackers: 'Werbung und Tracker blockieren',
  javascript: 'JavaScript erlauben',
  dns: 'DNS',
  dnsHint:
    'Der Browser fragt Namen über das DNS von Windows ab. DNS-over-HTTPS schaltest du unter Windows 11 in den Netzwerkeinstellungen ein (DNS-Serverzuweisung → Verschlüsselt). Im Tor-Modus löst der Proxy die Namen auf.',
  search: 'Suchmaschine',
  lists: 'Filterlisten',
  listsNone: 'Noch keine Listen geladen – der Blocker blockiert nichts.',
  listsLoaded: '{count} Regeln, Stand {date}',
  listsUpdate: 'EasyList + EasyPrivacy laden',
  listsHint:
    'Lädt die Listen einmal über HTTPS von easylist.to (Lizenzen der Listen: GPL-3.0 / CC BY-SA 3.0). Sonst baut der Browser keine Verbindungen für sich auf.',
  restartHint: 'JavaScript gilt für neue Tabs.',
  bookmarks: 'Lesezeichen',
  noBookmarks: 'Noch keine Lesezeichen.',
  remove: 'Entfernen',
  ghostTitle: 'Ghost-Modus',
  ghostOpen: 'Ghost-Fenster öffnen',
  ghostTorOpen: 'Ghost-Fenster über Tor',
  ghostHint:
    'Ghost-Fenster behalten keinen Verlauf, keine Cookies und keinen Cache (InPrivate) und fragen SmartScreen nicht. Downloads und Lesezeichen, die du anlegst, bleiben. Mit Tor laufen sie über einen bereits laufenden SOCKS5-Proxy auf 9150/9050 (Tor Browser, Tor- oder Arti-Dienst) – AEGIS prüft nicht, ob das wirklich Tor ist.',
  honest:
    'Ehrlich: Dieser Browser reduziert Tracking, er anonymisiert nicht. Seiten können erkennen, dass sie in einem WebView2-Fenster einer App laufen. Für Anonymität ist der offizielle Tor Browser deutlich stärker (Fingerabdruck-Schutz, geprüfte Einstellungen).',
  windowsOnly:
    'Der Blocker wirkt nur unter Windows (WebView2). In normalen Fenstern bleibt SmartScreen an (Schutz vor Phishing; fragt bei Microsoft nach).',
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
  allowHttp: 'Open {host} unencrypted (HTTP)',
  ghost: 'Ghost',
  ghostTor: 'Ghost · Tor proxy',
  ghostTorTitle:
    'All pages go through the SOCKS proxy 127.0.0.1:{port}. AEGIS cannot check whether that really is Tor.',
  blocking: '{count} rules active',
  notBlocking: 'Blocker without lists',
  blockingOff: 'Blocker off',
  settings: 'Settings',
  httpsOnly: 'HTTPS only',
  blockTrackers: 'Block ads and trackers',
  javascript: 'Allow JavaScript',
  dns: 'DNS',
  dnsHint:
    'The browser resolves names through Windows DNS. Turn on DNS over HTTPS in the Windows 11 network settings (DNS server assignment → Encrypted). In Tor mode the proxy resolves names.',
  search: 'Search engine',
  lists: 'Filter lists',
  listsNone: 'No lists loaded yet – the blocker blocks nothing.',
  listsLoaded: '{count} rules, as of {date}',
  listsUpdate: 'Load EasyList + EasyPrivacy',
  listsHint:
    'Downloads the lists once over HTTPS from easylist.to (list licences: GPL-3.0 / CC BY-SA 3.0). Otherwise the browser makes no connections of its own.',
  restartHint: 'JavaScript applies to new tabs.',
  bookmarks: 'Bookmarks',
  noBookmarks: 'No bookmarks yet.',
  remove: 'Remove',
  ghostTitle: 'Ghost mode',
  ghostOpen: 'Open ghost window',
  ghostTorOpen: 'Ghost window via Tor',
  ghostHint:
    'Ghost windows keep no history, cookies or cache (InPrivate) and do not ask SmartScreen. Downloads and bookmarks you create stay. With Tor they run through an already running SOCKS5 proxy on 9150/9050 (Tor Browser, Tor or Arti service) – AEGIS does not check that it really is Tor.',
  honest:
    'Honestly: this browser reduces tracking, it does not make you anonymous. Pages can tell that they run in an app’s WebView2 window. For anonymity the official Tor Browser is much stronger (fingerprint protection, vetted settings).',
  windowsOnly:
    'The blocker only works on Windows (WebView2). Normal windows keep SmartScreen on (phishing protection; asks Microsoft).',
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
