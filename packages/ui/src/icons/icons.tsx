import { createIcon, type IconComponent } from './createIcon.tsx';

/*
 * AEGIS-Icons – eigene Zeichnungen auf dem 24-px-Raster, Strich 1,75, runde Enden,
 * Farbe = currentColor. Formen bewusst schlicht und geometrisch (passend zum facettierten
 * Logo); Schild und Scan greifen Λ und Scan-Balken des Logos auf.
 */

/* ------------------------------------------------------------------- Module */

export const IconDashboard = createIcon(
  'IconDashboard',
  <>
    <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
    <path d="M3.5 9h17M9.5 9v11M13 13h4.5M13 16.5h2.5" />
  </>,
);

export const IconScan = createIcon(
  'IconScan',
  <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M7.5 12h9" />,
);

export const IconShield = createIcon(
  'IconShield',
  <>
    <path d="M12 2.75 19.5 5.5v6.1c0 4.3-3 7.9-7.5 9.65-4.5-1.75-7.5-5.35-7.5-9.65V5.5z" />
    <path d="M9.25 14.25 12 9.25l2.75 5" />
  </>,
);

export const IconLab = createIcon(
  'IconLab',
  <path d="M9.25 3.5h5.5M10.25 3.5v5.4L5.1 17.6a1.9 1.9 0 0 0 1.64 2.9h10.52a1.9 1.9 0 0 0 1.64-2.9L13.75 8.9V3.5M7.1 14.25h9.8" />,
);

export const IconNetwork = createIcon(
  'IconNetwork',
  <>
    <circle cx="12" cy="5.5" r="2.25" />
    <circle cx="5.5" cy="18" r="2.25" />
    <circle cx="18.5" cy="18" r="2.25" />
    <path d="M10.73 7.94 6.77 15.56M13.27 7.94l3.96 7.62M8.25 18h7.5" />
  </>,
);

export const IconLock = createIcon(
  'IconLock',
  <>
    <rect x="4.75" y="10.5" width="14.5" height="10" rx="2" />
    <path d="M8 10.5V7.75a4 4 0 0 1 8 0v2.75M12 14.5v2.25" />
  </>,
);

export const IconKey = createIcon(
  'IconKey',
  <>
    <circle cx="8" cy="15.75" r="4.25" />
    <path d="M11 12.75 19.75 4M17.5 6.25l1.75 1.75M15.25 8.5l1.5 1.5" />
  </>,
);

export const IconTools = createIcon(
  'IconTools',
  <path d="M19.56 6.56 17.27 8.85 15.15 6.73 17.44 4.44A4.5 4.5 0 0 0 11.4 10.34L4.37 17.37A1.6 1.6 0 0 0 6.63 19.63L13.66 12.6A4.5 4.5 0 0 0 19.56 6.56z" />,
);

export const IconQuarantine = createIcon(
  'IconQuarantine',
  <path d="M12 3.25 19.75 7.5v9L12 20.75 4.25 16.5v-9zM4.25 7.5 12 11.75l7.75-4.25M12 11.75v9M8.12 5.38l7.76 4.25" />,
);

export const IconReport = createIcon(
  'IconReport',
  <path d="M13.75 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.75zM13.75 3.5v5.25H19M8.75 13h6.5M8.75 16.5h4.5" />,
);

export const IconSettings = createIcon(
  'IconSettings',
  <>
    <path d="M10.45 5.28 10.75 3.09A9 9 0 0 1 13.25 3.09L13.55 5.28A6.9 6.9 0 0 1 15.66 6.15L17.42 4.81A9 9 0 0 1 19.19 6.58L17.85 8.34A6.9 6.9 0 0 1 18.72 10.45L20.91 10.75A9 9 0 0 1 20.91 13.25L18.72 13.55A6.9 6.9 0 0 1 17.85 15.66L19.19 17.42A9 9 0 0 1 17.42 19.19L15.66 17.85A6.9 6.9 0 0 1 13.55 18.72L13.25 20.91A9 9 0 0 1 10.75 20.91L10.45 18.72A6.9 6.9 0 0 1 8.34 17.85L6.58 19.19A9 9 0 0 1 4.81 17.42L6.15 15.66A6.9 6.9 0 0 1 5.28 13.55L3.09 13.25A9 9 0 0 1 3.09 10.75L5.28 10.45A6.9 6.9 0 0 1 6.15 8.34L4.81 6.58A9 9 0 0 1 6.58 4.81L8.34 6.15A6.9 6.9 0 0 1 10.45 5.28z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

/* ------------------------------------------------------------------ Status */

export const IconInfo = createIcon(
  'IconInfo',
  <>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M12 11v5.25M12 7.75h.01" />
  </>,
);

export const IconWarning = createIcon(
  'IconWarning',
  <path d="M10.27 4.32 2.95 17.06A2 2 0 0 0 4.68 20h14.64a2 2 0 0 0 1.73-2.94L13.73 4.32a2 2 0 0 0-3.46 0zM12 9.25v4.5M12 16.75h.01" />,
);

export const IconDanger = createIcon(
  'IconDanger',
  <path d="M8.56 3.69h6.88l4.87 4.87v6.88l-4.87 4.87H8.56l-4.87-4.87V8.56zM12 8v4.75M12 16h.01" />,
);

export const IconCheck = createIcon('IconCheck', <path d="M4.75 12.75 9.25 17.25 19.25 7" />);

export const IconClose = createIcon('IconClose', <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />);

export const IconMinus = createIcon('IconMinus', <path d="M7.5 12h9" />);

export const IconPower = createIcon(
  'IconPower',
  <path d="M12 3.5V11M7.4 6.4a7.25 7.25 0 1 0 9.2 0" />,
);

export const IconClock = createIcon(
  'IconClock',
  <>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M12 7.25V12l3.25 2" />
  </>,
);

export const IconPanic = createIcon(
  'IconPanic',
  <>
    <path d="M7 17.5V12a5 5 0 0 1 10 0v5.5M10 12a2 2 0 0 1 2-2" />
    <rect x="4.75" y="17.5" width="14.5" height="3" rx="1" />
    <path d="M12 2.75v1.75M4.6 5.6l1.2 1.2M19.4 5.6l-1.2 1.2M2.75 12h1.5M19.75 12h1.5" />
  </>,
);

/* ---------------------------------------------------------------- Fenster */

export const IconMinimize = createIcon('IconMinimize', <path d="M5.5 12h13" />);

export const IconMaximize = createIcon(
  'IconMaximize',
  <rect x="5" y="5" width="14" height="14" rx="1.75" />,
);

export const IconRestore = createIcon(
  'IconRestore',
  <>
    <rect x="4.25" y="8.25" width="11.5" height="11.5" rx="1.75" />
    <path d="M8.25 8.25v-2a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-2" />
  </>,
);

/* ------------------------------------------------------------- Bedienung */

export const IconSearch = createIcon(
  'IconSearch',
  <>
    <circle cx="10.75" cy="10.75" r="6.5" />
    <path d="M15.5 15.5 20 20" />
  </>,
);

export const IconChevronDown = createIcon('IconChevronDown', <path d="M6.5 9.5 12 15l5.5-5.5" />);
export const IconChevronUp = createIcon('IconChevronUp', <path d="M6.5 14.5 12 9l5.5 5.5" />);
export const IconChevronRight = createIcon(
  'IconChevronRight',
  <path d="M9.5 6.5 15 12l-5.5 5.5" />,
);
export const IconChevronLeft = createIcon('IconChevronLeft', <path d="M14.5 6.5 9 12l5.5 5.5" />);

export const IconArrowRight = createIcon(
  'IconArrowRight',
  <path d="M4.75 12h14.5M13.5 6.5 19 12l-5.5 5.5" />,
);

export const IconExternal = createIcon(
  'IconExternal',
  <path d="M13.5 4.25h6.25v6.25M19.75 4.25 11 13M17.25 13.75v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4" />,
);

export const IconRefresh = createIcon(
  'IconRefresh',
  <path d="M19.5 12A7.5 7.5 0 1 1 17.3 6.7M13.8 6.7h3.5V3.2" />,
);

export const IconUndo = createIcon(
  'IconUndo',
  <path d="M8.75 7.25 4.75 11.25l4 4M4.75 11.25h9.75a4.75 4.75 0 0 1 0 9.5H12" />,
);

export const IconTrash = createIcon(
  'IconTrash',
  <path d="M4.25 6.75h15.5M9.25 6.75V5a1.25 1.25 0 0 1 1.25-1.25h3A1.25 1.25 0 0 1 14.75 5v1.75M6.25 6.75l.85 12a1.75 1.75 0 0 0 1.75 1.5h6.3a1.75 1.75 0 0 0 1.75-1.5l.85-12M10 10.75v5.75M14 10.75v5.75" />,
);

export const IconPlay = createIcon('IconPlay', <path d="M8 5.5 18.5 12 8 18.5z" />);

export const IconPause = createIcon('IconPause', <path d="M8.5 5.5v13M15.5 5.5v13" />);

export const IconSoundOn = createIcon(
  'IconSoundOn',
  <path d="M3.75 9.75v4.5a.75.75 0 0 0 .75.75h3l4.25 3.75V5.25L7.5 9h-3a.75.75 0 0 0-.75.75zM15.25 9.25a4 4 0 0 1 0 5.5M17.9 6.6a7.75 7.75 0 0 1 0 10.8" />,
);

export const IconSoundOff = createIcon(
  'IconSoundOff',
  <path d="M3.75 9.75v4.5a.75.75 0 0 0 .75.75h3l4.25 3.75V5.25L7.5 9h-3a.75.75 0 0 0-.75.75zM16 9.5l5 5M21 9.5l-5 5" />,
);

export const IconSun = createIcon(
  'IconSun',
  <>
    <circle cx="12" cy="12" r="3.75" />
    <path d="M12 2.75v1.75M12 19.5v1.75M4.4 4.4l1.25 1.25M18.35 18.35l1.25 1.25M2.75 12h1.75M19.5 12h1.75M4.4 19.6l1.25-1.25M18.35 5.65l1.25-1.25" />
  </>,
);

export const IconMoon = createIcon(
  'IconMoon',
  <path d="M19.25 14.6A7.75 7.75 0 1 1 9.4 4.75a7.2 7.2 0 0 0 9.85 9.85z" />,
);

export const IconGlobe = createIcon(
  'IconGlobe',
  <>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M3.25 12h17.5M12 3.25c2.4 2.4 3.6 5.3 3.6 8.75S14.4 18.35 12 20.75c-2.4-2.4-3.6-5.3-3.6-8.75S9.6 5.65 12 3.25z" />
  </>,
);

/* ------------------------------------------------------- Ziele & Einstufung */

export const IconFile = createIcon(
  'IconFile',
  <path d="M13.75 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.75zM13.75 3.5v5.25H19" />,
);

export const IconProcess = createIcon(
  'IconProcess',
  <>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.75" />
    <rect x="9.75" y="9.75" width="4.5" height="4.5" rx="0.5" />
    <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
  </>,
);

export const IconSliders = createIcon(
  'IconSliders',
  <>
    <path d="M4.5 7.5h8M16.5 7.5h3M4.5 16.5h3M11.5 16.5h8" />
    <circle cx="14.5" cy="7.5" r="2" />
    <circle cx="9.5" cy="16.5" r="2" />
  </>,
);

export const IconTree = createIcon(
  'IconTree',
  <>
    <rect x="3.75" y="3.75" width="6" height="4.5" rx="1" />
    <rect x="14.25" y="9.75" width="6" height="4.5" rx="1" />
    <rect x="14.25" y="15.75" width="6" height="4.5" rx="1" />
    <path d="M6.75 8.25V18h7.5M6.75 12h7.5" />
  </>,
);

export const IconEye = createIcon(
  'IconEye',
  <>
    <path d="M2.75 12C4.9 8 8.1 5.75 12 5.75S19.1 8 21.25 12C19.1 16 15.9 18.25 12 18.25S4.9 16 2.75 12z" />
    <circle cx="12" cy="12" r="2.75" />
  </>,
);

export const IconGamepad = createIcon(
  'IconGamepad',
  <path d="M7.25 8.25h9.5a4 4 0 0 1 3.92 3.2l.8 4a2.4 2.4 0 0 1-4.07 2.13L15.25 15.5h-6.5l-2.15 2.08a2.4 2.4 0 0 1-4.07-2.13l.8-4a4 4 0 0 1 3.92-3.2zM7.75 10.75v3M6.25 12.25h3M15.5 11.25h.01M17.25 13h.01" />,
);

/** Alle Icons nach Name (z. B. für Übersichten oder dynamische Menüs). */
export const icons = {
  dashboard: IconDashboard,
  scan: IconScan,
  shield: IconShield,
  lab: IconLab,
  network: IconNetwork,
  lock: IconLock,
  key: IconKey,
  tools: IconTools,
  quarantine: IconQuarantine,
  report: IconReport,
  settings: IconSettings,
  info: IconInfo,
  warning: IconWarning,
  danger: IconDanger,
  check: IconCheck,
  close: IconClose,
  minus: IconMinus,
  power: IconPower,
  clock: IconClock,
  panic: IconPanic,
  minimize: IconMinimize,
  maximize: IconMaximize,
  restore: IconRestore,
  search: IconSearch,
  chevronDown: IconChevronDown,
  chevronUp: IconChevronUp,
  chevronRight: IconChevronRight,
  chevronLeft: IconChevronLeft,
  arrowRight: IconArrowRight,
  external: IconExternal,
  refresh: IconRefresh,
  undo: IconUndo,
  trash: IconTrash,
  play: IconPlay,
  pause: IconPause,
  soundOn: IconSoundOn,
  soundOff: IconSoundOff,
  sun: IconSun,
  moon: IconMoon,
  globe: IconGlobe,
  file: IconFile,
  process: IconProcess,
  sliders: IconSliders,
  tree: IconTree,
  eye: IconEye,
  gamepad: IconGamepad,
} as const satisfies Record<string, IconComponent>;

export type IconName = keyof typeof icons;
