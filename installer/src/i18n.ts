import { useSyncExternalStore } from "react";

const de = {
  tagline: "Dein Spieleuniversum",
  steps: { welcome: "Willkommen", folder: "Speicherort", options: "Optionen", install: "Installation", done: "Fertig" },
  welcome: {
    title: "Willkommen bei NOVA",
    text: "Alle deine Spiele und Programme an einem Ort – mit Spielzeit-Statistik, Big-Picture-Modus und einem Hauch Sternenstaub.",
    f1: "Findet Spiele automatisch",
    f1d: "Steam, Epic, GOG und Startmenü",
    f2: "Misst deine Spielzeit",
    f2d: "Mit Statistiken und Erfolgen",
    f3: "Big Picture fürs Sofa",
    f3d: "Mit Controller-Steuerung",
    version: "Version {v}",
    size: "Download: {size}",
    manifestError: "Die Download-Infos konnten nicht geladen werden. Du kannst es trotzdem versuchen.",
    start: "Los geht's",
    license: "Mit der Installation stimmst du zu, dass NOVA auf deinem PC Daten über deine Spiele speichert – nur lokal, nichts wird hochgeladen.",
  },
  maintenance: {
    title: "NOVA ist schon installiert",
    text: "Version {v} liegt in {dir}. Was möchtest du tun?",
    update: "Aktualisieren oder reparieren",
    updateDesc: "Lädt die neueste Version. Deine Bibliothek bleibt erhalten.",
    uninstall: "Deinstallieren",
    uninstallDesc: "Entfernt NOVA von diesem PC.",
  },
  folder: {
    title: "Wohin soll NOVA?",
    text: "Der vorgeschlagene Ordner braucht keine Administratorrechte.",
    browse: "Ändern",
    reset: "Vorschlag",
    required: "Benötigt",
    free: "Frei",
    needsAdmin: "Für diesen Ordner braucht das Setup Administratorrechte. Windows fragt gleich nach.",
    lowSpace: "Hier ist nicht genug Platz frei.",
    invalid: "Dieser Ordner kann nicht verwendet werden.",
  },
  options: {
    title: "Fast geschafft",
    text: "Wähle, wie NOVA auf deinem PC erscheinen soll.",
    desktop: "Desktop-Verknüpfung",
    desktopDesc: "Ein Symbol auf dem Desktop.",
    startMenu: "Eintrag im Startmenü",
    startMenuDesc: "NOVA über die Windows-Suche finden.",
    autostart: "Mit Windows starten",
    autostartDesc: "Startet leise im Infobereich und misst Spielzeit.",
    launch: "NOVA danach starten",
    launchDesc: "Direkt nach der Installation öffnen.",
    install: "Installieren",
  },
  install: {
    title: "NOVA wird installiert",
    updateTitle: "Update auf Version {v}",
    phases: {
      connect: "Verbinden",
      download: "Herunterladen",
      verify: "Sicherheit prüfen (SHA-256)",
      install: "Installieren",
      shortcuts: "Verknüpfungen anlegen",
      register: "In Windows eintragen",
    },
    speed: "{speed}/s",
    remaining: "noch {time}",
    calculating: "berechne …",
    cancel: "Abbrechen",
    cancelConfirm: "Installation wirklich abbrechen? Bereits geladene Daten bleiben für einen späteren Versuch erhalten.",
  },
  errors: {
    network: "Keine Verbindung zum Download-Server",
    checksum: "Die Datei ist beschädigt angekommen",
    disk: "Nicht genug Speicherplatz",
    permission: "Keine Berechtigung für diesen Ordner",
    manifest: "Download-Infos nicht gefunden",
    running: "NOVA läuft noch",
    cancelled: "Installation abgebrochen",
    unknown: "Etwas ist schiefgelaufen",
    retry: "Erneut versuchen",
    resumeHint: "Keine Sorge: Der Download wird an der Stelle fortgesetzt, an der er unterbrochen wurde.",
    closeApp: "NOVA schließen und weiter",
    back: "Zurück",
  },
  done: {
    title: "NOVA ist bereit!",
    text: "Viel Spaß in deinem neuen Spieleuniversum.",
    updated: "Update abgeschlossen – NOVA startet gleich neu.",
    launch: "NOVA jetzt starten",
    close: "Schließen",
    unverified: "Hinweis: Für diese Version war keine Prüfsumme hinterlegt.",
  },
  uninstall: {
    title: "NOVA deinstallieren?",
    text: "NOVA wird von diesem PC entfernt. Deine Spiele selbst bleiben natürlich installiert.",
    keepData: "Meine Daten behalten",
    keepDataDesc: "Bibliothek, Spielzeit und Einstellungen bleiben für eine spätere Neuinstallation erhalten.",
    confirm: "Deinstallieren",
    cancel: "Abbrechen",
    running: "NOVA wird entfernt …",
    steps: { stop: "NOVA beenden", shortcuts: "Verknüpfungen entfernen", registry: "Windows-Einträge entfernen", files: "Dateien löschen", data: "Daten aufräumen" },
    doneTitle: "Auf Wiedersehen",
    doneText: "NOVA wurde entfernt. Du bist jederzeit wieder willkommen.",
  },
  common: { next: "Weiter", back: "Zurück", close: "Schließen", mute: "Ton aus", unmute: "Ton an" },
};

type Dict = { [K in keyof typeof de]: (typeof de)[K] extends string ? string : { [P in keyof (typeof de)[K]]: (typeof de)[K][P] extends string ? string : Record<string, string> } };

const en: Dict = {
  tagline: "Your gaming universe",
  steps: { welcome: "Welcome", folder: "Location", options: "Options", install: "Install", done: "Done" },
  welcome: {
    title: "Welcome to NOVA",
    text: "All your games and apps in one place – with playtime statistics, Big Picture mode and a touch of stardust.",
    f1: "Finds games automatically",
    f1d: "Steam, Epic, GOG and Start menu",
    f2: "Tracks your playtime",
    f2d: "With statistics and achievements",
    f3: "Big Picture for the couch",
    f3d: "With controller support",
    version: "Version {v}",
    size: "Download: {size}",
    manifestError: "Download information could not be loaded. You can still try.",
    start: "Let's go",
    license: "By installing you agree that NOVA stores data about your games on this PC – locally only, nothing is uploaded.",
  },
  maintenance: {
    title: "NOVA is already installed",
    text: "Version {v} is in {dir}. What would you like to do?",
    update: "Update or repair",
    updateDesc: "Downloads the latest version. Your library is kept.",
    uninstall: "Uninstall",
    uninstallDesc: "Removes NOVA from this PC.",
  },
  folder: {
    title: "Where should NOVA live?",
    text: "The suggested folder does not need administrator rights.",
    browse: "Change",
    reset: "Suggestion",
    required: "Required",
    free: "Free",
    needsAdmin: "This folder needs administrator rights. Windows will ask in a moment.",
    lowSpace: "There is not enough free space here.",
    invalid: "This folder cannot be used.",
  },
  options: {
    title: "Almost there",
    text: "Choose how NOVA appears on your PC.",
    desktop: "Desktop shortcut",
    desktopDesc: "An icon on your desktop.",
    startMenu: "Start menu entry",
    startMenuDesc: "Find NOVA through Windows search.",
    autostart: "Start with Windows",
    autostartDesc: "Starts quietly in the tray and tracks playtime.",
    launch: "Launch NOVA afterwards",
    launchDesc: "Open right after installing.",
    install: "Install",
  },
  install: {
    title: "Installing NOVA",
    updateTitle: "Updating to version {v}",
    phases: {
      connect: "Connecting",
      download: "Downloading",
      verify: "Security check (SHA-256)",
      install: "Installing",
      shortcuts: "Creating shortcuts",
      register: "Registering with Windows",
    },
    speed: "{speed}/s",
    remaining: "{time} left",
    calculating: "calculating …",
    cancel: "Cancel",
    cancelConfirm: "Really cancel? Downloaded data is kept for a later attempt.",
  },
  errors: {
    network: "No connection to the download server",
    checksum: "The file arrived damaged",
    disk: "Not enough disk space",
    permission: "No permission for this folder",
    manifest: "Download information not found",
    running: "NOVA is still running",
    cancelled: "Installation cancelled",
    unknown: "Something went wrong",
    retry: "Try again",
    resumeHint: "Don't worry: the download continues where it stopped.",
    closeApp: "Close NOVA and continue",
    back: "Back",
  },
  done: {
    title: "NOVA is ready!",
    text: "Have fun in your new gaming universe.",
    updated: "Update complete – NOVA restarts in a moment.",
    launch: "Launch NOVA now",
    close: "Close",
    unverified: "Note: no checksum was provided for this version.",
  },
  uninstall: {
    title: "Uninstall NOVA?",
    text: "NOVA will be removed from this PC. Your games themselves stay installed, of course.",
    keepData: "Keep my data",
    keepDataDesc: "Library, playtime and settings are kept for a later reinstall.",
    confirm: "Uninstall",
    cancel: "Cancel",
    running: "Removing NOVA …",
    steps: { stop: "Closing NOVA", shortcuts: "Removing shortcuts", registry: "Removing Windows entries", files: "Deleting files", data: "Cleaning up data" },
    doneTitle: "Goodbye",
    doneText: "NOVA has been removed. You are always welcome back.",
  },
  common: { next: "Next", back: "Back", close: "Close", mute: "Mute", unmute: "Unmute" },
};

export type Lang = "de" | "en";
let lang: Lang = navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
const subs = new Set<() => void>();

export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l;
  subs.forEach((s) => s());
}
export function getLang() {
  return lang;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict: unknown = lang === "de" ? de : en;
  let cur: unknown = dict;
  for (const p of key.split(".")) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
  let s = typeof cur === "string" ? cur : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
  return s;
}

export function useT() {
  useSyncExternalStore(
    (cb) => (subs.add(cb), () => subs.delete(cb)),
    () => lang,
  );
  return t;
}

export function formatBytes(b: number): string {
  if (!b || b < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / Math.pow(1024, i)).toLocaleString(lang === "de" ? "de-DE" : "en-US", { maximumFractionDigits: i >= 2 ? 1 : 0 })} ${u[i]}`;
}

export function formatEta(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "";
  if (s < 60) return lang === "de" ? `${Math.ceil(s)} Sek.` : `${Math.ceil(s)} s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return lang === "de" ? `${m} Min. ${sec} Sek.` : `${m} min ${sec} s`;
}
