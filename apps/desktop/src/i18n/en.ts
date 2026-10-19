import type { de } from './de.ts';
import type { Messages } from './types.ts';

/**
 * English texts (second language). Typed against the German source: a missing or extra key
 * fails `pnpm typecheck`; `i18n.test.ts` additionally checks placeholders and empty strings.
 */
export const en: Messages<typeof de> = {
  app: {
    suite: 'AEGIS Suite',
    skipToContent: 'Skip to content',
    pageAnnouncement: 'Page: {page}',
    documentTitle: '{page} · AEGIS',
  },
  boot: {
    skip: 'Skip',
    status: 'AEGIS is starting',
  },
  keys: {
    ctrl: 'Ctrl',
  },
  phase: {
    comingIn: 'Coming in {phase}',
    comingInShort: 'coming in {phase}',
  },
  titlebar: {
    label: 'Title bar',
    search: 'Search commands or pages…',
    windowControls: 'Window',
    minimize: 'Minimize',
    maximize: 'Maximize',
    restore: 'Restore',
    close: 'Quit AEGIS',
    closeToTray: 'Close – AEGIS keeps running in the notification area',
    preview: 'Browser preview',
    previewHint:
      'Running without the desktop app: window buttons, notification area and system values are not available here.',
  },
  nav: {
    label: 'Main navigation',
    collapse: 'Collapse navigation',
    expand: 'Expand navigation',
    groups: {
      overview: 'Overview',
      protection: 'Protection',
      system: 'System',
      privacy: 'Privacy & tools',
      app: 'App',
    },
  },
  statusbar: {
    label: 'Status bar',
    golden: 'Golden rule: nothing without your yes',
    version: 'Version {version}',
    desktop: 'Desktop app',
    preview: 'Browser preview',
    build: {
      debug: 'Development',
      release: 'Release',
    },
  },
  pages: {
    dashboard: {
      nav: 'Dashboard',
      title: 'Dashboard',
      eyebrow: 'Overview',
      description:
        'The state of your protection – honestly: anything not built yet is shown as “Coming in…”.',
    },
    scan: {
      nav: 'Scan',
      title: 'Scan',
      eyebrow: 'Protection',
      tagline: 'Check files and folders for malware',
      summary:
        'Checks files and folders with ClamAV (as a separate process), hash matching, YARA rules and static analysis. Findings are reported and explained – isolated only if you ask for it.',
    },
    realtime: {
      nav: 'Real-time guard',
      title: 'Real-time guard',
      eyebrow: 'Protection',
      tagline: 'Watch new and changed files in the background',
      summary:
        'Watches new and changed files in the background and warns right away. Without a kernel driver AEGIS detects and reports – it does not block programs before they start.',
    },
    lab: {
      nav: 'Lab',
      title: 'Lab',
      eyebrow: 'Sandbox',
      tagline: 'Try unknown programs in isolation',
      summary:
        'Runs unknown programs in isolation (Windows Sandbox or a mini sandbox) and shows in a behavior report what they attempt.',
    },
    network: {
      nav: 'Network',
      title: 'Network',
      eyebrow: 'System',
      tagline: 'Connections, firewall and home network at a glance',
      summary:
        'Shows connections and firewall rules, checks your home network for leaks and warns about dangerous websites (web protection).',
    },
    hardening: {
      nav: 'Hardening',
      title: 'Hardening',
      eyebrow: 'System',
      tagline: 'Check and improve Windows settings',
      summary:
        'Checks Windows settings, autostart entries and drivers and suggests improvements – this is where the security score comes from. Nothing is changed without your yes.',
    },
    vault: {
      nav: 'Vault',
      title: 'Vault',
      eyebrow: 'Privacy',
      tagline: 'Keep passwords safe and local',
      summary:
        'A password vault with its own browser extension. Your data stays encrypted on your device.',
    },
    tools: {
      nav: 'Tools',
      title: 'Tools',
      eyebrow: 'Privacy & tools',
      tagline: 'Helpers for Windows tasks, following your rules',
      summary:
        'Tools for Windows tasks such as cleaning up and sorting. They only act on rules you create and switch on – always with preview, log and undo.',
    },
    quarantine: {
      nav: 'Quarantine',
      title: 'Quarantine',
      eyebrow: 'Protection',
      tagline: 'Review and restore isolated files',
      summary:
        'Suspicious files are moved into encrypted quarantine – only after your yes. They can be restored from there; permanent deletion needs a second confirmation.',
    },
    reports: {
      nav: 'Reports',
      title: 'Reports',
      eyebrow: 'Overview',
      tagline: 'Read up on scans, findings and decisions',
      summary:
        'Summarizes scans, findings and your decisions clearly – based on an audit log that cannot be changed unnoticed.',
    },
    settings: {
      nav: 'Settings',
      title: 'Settings',
      eyebrow: 'App',
      description: 'Changes apply immediately – no restart.',
    },
    about: {
      nav: 'About AEGIS',
      title: 'About AEGIS',
      eyebrow: 'App',
      description: 'Defensive antivirus and security toolkit for Windows 10 and 11.',
    },
  },
  placeholder: {
    note: 'Until then AEGIS deliberately shows nothing here – no sample or estimated values.',
    golden: 'The golden rule applies then too: AEGIS changes nothing without your yes.',
  },
  dashboard: {
    honesty: {
      label: 'Honest notes',
      kernelTitle: 'To be honest',
      kernel:
        'AEGIS has no kernel driver. It detects, warns and isolates on request – it does not block programs before they start.',
      goldenTitle: 'Golden rule',
      golden: 'AEGIS changes nothing without your yes.',
    },
    score: {
      eyebrow: 'Rating',
      title: 'Security score',
      label: 'Security score',
      unavailable: 'No measurement',
      hint: 'Not rated yet – the system checks are coming in P6.',
      outOf: 'out of 100',
      bands: {
        low: 'Critical',
        medium: 'Needs improvement',
        high: 'Good',
      },
    },
    modules: {
      eyebrow: 'Status',
      title: 'Protection modules',
      unavailable: 'Not available',
      signatures: 'Signatures & engine',
      realtime: 'Real-time guard',
      ransomware: 'Ransomware protection',
      network: 'Network protection',
      footer:
        'These modules are not built yet. Once they exist, the rings will show their real state.',
    },
    build: {
      eyebrow: 'Under construction',
      title: 'AEGIS is taking shape',
      summary: 'Phase {current} of {last}: {name}',
      lead: 'The foundation is in place. The protection modules follow step by step – each one only once it really works.',
      progressLabel: 'Build plan',
      current: 'in progress',
      next: 'Up next',
      phases: {
        P0: 'Foundation',
        P1: 'User interface',
        P2: 'Scan engine & quarantine',
        P3: 'Real-time guard & reports',
        P4: 'Lab (sandbox)',
        P5: 'Emergency scan & ransomware protection',
        P6: 'Hardening & score',
        P7: 'Network & web protection',
        P8: 'Defender switch',
        P9: 'Vault',
        P10: 'Tools 1–11',
        P11: 'Tools 12–22',
        P12: 'Privacy browser',
        P13: 'Setup & updates',
      },
    },
    activity: {
      eyebrow: 'This session',
      title: 'Live activity',
      showAll: 'Show all',
      showLess: 'Show less',
      count: { one: '{count} event', other: '{count} events' },
      footer:
        'Interface events only. Protection events such as findings and scans arrive with the service from P2.',
      events: {
        appStarted: 'AEGIS started',
        settingChanged: '{setting}: {value}',
        bootReplayed: 'Start animation played',
        trayNavigate: 'Opened from the notification area: {page}',
        saveFailed: 'Settings not saved – they apply until AEGIS quits',
      },
    },
    quick: {
      eyebrow: 'Actions',
      title: 'Quick access',
      emergency: 'Emergency scan',
      emergencyHint: 'The emergency scan (panic button) is coming in P5.',
      replayBoot: 'Replay start animation',
      palette: 'Command palette',
      settings: 'Settings',
    },
  },
  settings: {
    sections: {
      appearance: 'Language & appearance',
      feedback: 'Sound & motion',
      window: 'Start & window',
      about: 'Version',
    },
    state: {
      on: 'on',
      off: 'off',
    },
    current: 'Currently: {value}',
    language: {
      label: 'Language',
      description: '“System” follows the Windows display language.',
      system: 'System',
      de: 'Deutsch',
      en: 'English',
    },
    theme: {
      label: 'Appearance',
      description: '“System” follows the Windows setting for light or dark apps.',
      system: 'System',
      dark: 'Dark',
      light: 'Light',
    },
    sound: {
      label: 'Sound',
      description:
        'Subtle sounds, for example when you turn sound on or replay the start animation. AEGIS stays silent when it opens.',
    },
    motion: {
      label: 'Motion',
      description:
        '“Reduced” turns off animations across the whole app – including the start animation.',
      system: 'System',
      reduced: 'Reduced',
      systemReduced: 'System: reduced',
      systemNormal: 'System: normal',
    },
    boot: {
      label: 'Show start animation on launch',
      description: 'The logo draws itself when AEGIS opens (about 1.5 seconds).',
    },
    closeToTray: {
      label: 'Close to the notification area',
      description:
        'The close button hides the window and AEGIS keeps running in the notification area. Alt+F4 quits AEGIS completely.',
      unavailable:
        'Not available here: there is no notification area icon to bring AEGIS back. The close button therefore quits AEGIS completely.',
    },
    persistence: {
      memoryOnly: 'Settings cannot be saved right now. They apply until AEGIS quits.',
      newer:
        'These settings come from a newer AEGIS version. So that nothing gets overwritten, changes only apply until AEGIS quits.',
    },
    about: {
      version: 'AEGIS {version}',
      more: 'More about AEGIS',
    },
    saveFailedToast: 'Settings not saved',
    saveFailedToastDetail: 'They apply until AEGIS quits.',
  },
  about: {
    infoTitle: 'Version & platform',
    previewNote: 'Browser preview: these values do not come from the desktop app.',
    loading: 'Loading…',
    error: 'The app information could not be read.',
    unknown: 'unknown',
    fields: {
      version: 'Version',
      build: 'Build',
      platform: 'Platform',
      osVersion: 'Operating system version',
      arch: 'Architecture',
      tauri: 'Tauri',
    },
    build: {
      debug: 'Debug (development)',
      release: 'Release',
    },
    platform: {
      windows: 'Windows',
      linux: 'Linux',
      macos: 'macOS',
      preview: 'Browser preview',
    },
    principlesTitle: 'Principles',
    principles: {
      golden: 'Golden rule: AEGIS changes, moves, terminates or deletes nothing without your yes.',
      defensive: 'Purely defensive: no attack techniques, no reading other people’s passwords.',
      kernel:
        'No kernel driver: AEGIS detects, warns and isolates on request – it does not block programs before they start.',
      privacy: 'No telemetry: AEGIS sends no usage data. Fonts and scripts are local.',
    },
    fonts: 'Fonts: Inter and JetBrains Mono (SIL Open Font License 1.1), bundled locally.',
  },
  palette: {
    groups: {
      pages: 'Pages',
      actions: 'Actions',
    },
    themeToLight: 'Light appearance',
    themeToDark: 'Dark appearance',
    languageSwitch: 'Language: Deutsch',
    soundOn: 'Turn sound on',
    soundOff: 'Turn sound off',
    motionReduce: 'Reduce motion',
    motionSystem: 'Follow system motion setting',
    replayBoot: 'Play start animation',
    emergency: 'Emergency scan',
  },
  toast: {
    region: 'Notifications',
    dismiss: 'Dismiss notification',
  },
};
