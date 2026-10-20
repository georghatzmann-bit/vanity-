/** Texte des Setups (Deutsch, Englisch als zweite Sprache). */
const de = {
  title: 'AEGIS Suite installieren',
  steps: 'Schritte',
  stepWelcome: 'Willkommen',
  stepPrivacy: 'Datenschutz',
  stepOptions: 'Ordner & Pakete',
  stepInstall: 'Installation',
  stepDone: 'Fertig',
  welcome: 'Willkommen bei AEGIS',
  welcomeText:
    'Dieses Setup lädt die neueste AEGIS Suite, prüft jede Datei und installiert sie erst, wenn du „Installieren“ wählst.',
  sound: 'Klang',
  start: 'Los geht’s',
  next: 'Weiter',
  back: 'Zurück',
  privacyTitle: 'Was das Setup tut – und was nicht',
  privacy1: 'Keine Telemetrie, kein Konto, keine Werbung.',
  privacy2:
    'Verbindungen nur zu GitHub (Releases von AEGIS); auf Wunsch zu Microsoft für WebView2.',
  privacy3:
    'Jedes Paket ist über signierte Angaben (Ed25519) und seine SHA-256-Prüfsumme abgesichert – geprüft wird vor und direkt vor dem Start.',
  privacy4:
    'AEGIS schützt ohne Kernel-Treiber: Es erkennt, warnt und isoliert auf Wunsch, blockiert Programme aber nicht vor dem Start.',
  smartscreen:
    'Ehrlich: Solange AEGIS kein Code-Signing-Zertifikat hat, warnt Windows SmartScreen beim Start der Installationsprogramme. Das ist bei neuer Software normal.',
  optionsTitle: 'Ordner und Pakete',
  dir: 'Installationsordner',
  change: 'Ändern …',
  check: 'Neueste Version suchen',
  checking: 'Suche …',
  offer: 'Version {version}',
  app: 'AEGIS Suite (Schutz, Werkzeuge, Dienst)',
  browser: 'AEGIS Browser (Privacy-Browser, für dieses Konto)',
  required: 'erforderlich',
  disabled:
    'Dieses Setup wurde ohne Signaturschlüssel gebaut und lädt deshalb nichts. Lade das Installationsprogramm direkt von der Release-Seite.',
  notWindows: 'Installiert wird nur unter Windows 10/11 (64 Bit).',
  downloadInstall: 'Laden und prüfen',
  downloading: 'Lade {name} …',
  verifying: 'Prüfe {name} …',
  verified: '{name} geprüft ✓',
  ready: 'Alles geladen und geprüft.',
  install: 'Installieren',
  installHint: 'Windows fragt gleich nach Administratorrechten (Dienst und Programmordner).',
  installing: 'Installiere … das kann einen Moment dauern.',
  doneTitle: 'AEGIS ist installiert',
  doneText:
    'Der Schutzdienst läuft. AEGIS verändert nichts ohne dein ausdrückliches „Ja“ – es scannt, meldet und erklärt.',
  launch: 'AEGIS starten',
  close: 'Schließen',
  error: 'Etwas hat nicht geklappt',
  retry: 'Erneut versuchen',
  progress: 'Fortschritt',
} as const;

export type TextKey = keyof typeof de;

const en: Record<TextKey, string> = {
  title: 'Install AEGIS Suite',
  steps: 'Steps',
  stepWelcome: 'Welcome',
  stepPrivacy: 'Privacy',
  stepOptions: 'Folder & packages',
  stepInstall: 'Installation',
  stepDone: 'Done',
  welcome: 'Welcome to AEGIS',
  welcomeText:
    'This setup downloads the latest AEGIS Suite, checks every file and only installs it once you choose “Install”.',
  sound: 'Sound',
  start: 'Let’s go',
  next: 'Next',
  back: 'Back',
  privacyTitle: 'What the setup does – and what it does not',
  privacy1: 'No telemetry, no account, no ads.',
  privacy2: 'Connections only to GitHub (AEGIS releases); on request to Microsoft for WebView2.',
  privacy3:
    'Every package is secured by signed metadata (Ed25519) and its SHA-256 checksum – checked after download and again right before it starts.',
  privacy4:
    'AEGIS protects without a kernel driver: it detects, warns and isolates on request, but does not block programs before they start.',
  smartscreen:
    'Honestly: as long as AEGIS has no code-signing certificate, Windows SmartScreen warns when the installers start. That is normal for new software.',
  optionsTitle: 'Folder and packages',
  dir: 'Install folder',
  change: 'Change…',
  check: 'Look for the latest version',
  checking: 'Looking…',
  offer: 'Version {version}',
  app: 'AEGIS Suite (protection, tools, service)',
  browser: 'AEGIS Browser (privacy browser, for this account)',
  required: 'required',
  disabled:
    'This setup was built without a signing key and therefore downloads nothing. Get the installer directly from the release page.',
  notWindows: 'Installation only works on Windows 10/11 (64-bit).',
  downloadInstall: 'Download and check',
  downloading: 'Downloading {name}…',
  verifying: 'Checking {name}…',
  verified: '{name} checked ✓',
  ready: 'Everything downloaded and checked.',
  install: 'Install',
  installHint: 'Windows will ask for administrator rights (service and program folder).',
  installing: 'Installing… this can take a moment.',
  doneTitle: 'AEGIS is installed',
  doneText:
    'The protection service is running. AEGIS changes nothing without your explicit “Yes” – it scans, reports and explains.',
  launch: 'Start AEGIS',
  close: 'Close',
  error: 'Something went wrong',
  retry: 'Try again',
  progress: 'Progress',
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
