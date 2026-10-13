import { useSyncExternalStore } from "react";

const de = {
  tagline: "Dein Game Booster",
  steps: { welcome: "Willkommen", folder: "Speicherort", options: "Optionen", install: "Installation", done: "Fertig" },
  intro: { connecting: "Signal wird aufgebaut …", ready: "Signal steht." },
  welcome: {
    title: "Willkommen bei PULSAR",
    text: "Pulsar misst deine Verbindung live, macht deinen PC mit einem Klick bereit zum Spielen und zeigt dir ehrlich, wo es hakt – ohne Konto, ohne Adminrechte.",
    f1: "Live-Ping mit Note",
    f1d: "A+ bis F – zu echten Spielservern",
    f2: "Boost per Klick",
    f2d: "Energieplan, Priorität, DNS – mit Rückgängig",
    f3: "Netzwerk-Werkzeuge",
    f3d: "Route, DNS-Vergleich, Speedtest, WLAN",
    version: "Version {v}",
    size: "Download: {size}",
    manifestError: "Die Download-Infos konnten nicht geladen werden. Du kannst es trotzdem versuchen.",
    start: "Los geht's",
    license: "Mit der Installation stimmst du zu, dass Pulsar Messwerte und Spielsitzungen auf deinem PC speichert – nur lokal, nichts wird hochgeladen.",
  },
  maintenance: {
    title: "Pulsar ist schon installiert",
    text: "Version {v} liegt in {dir}. Was möchtest du tun?",
    update: "Aktualisieren oder reparieren",
    updateDesc: "Lädt die neueste Version. Deine Berichte und Einstellungen bleiben erhalten.",
    uninstall: "Deinstallieren",
    uninstallDesc: "Entfernt Pulsar von diesem PC.",
  },
  folder: {
    title: "Wohin soll Pulsar?",
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
    text: "Wähle, wie Pulsar auf deinem PC erscheinen soll.",
    desktop: "Desktop-Verknüpfung",
    desktopDesc: "Ein Symbol auf dem Desktop.",
    startMenu: "Eintrag im Startmenü",
    startMenuDesc: "Pulsar über die Windows-Suche finden.",
    autostart: "Mit Windows starten",
    autostartDesc: "Startet leise im Infobereich und misst, sobald ein Spiel läuft.",
    launch: "Pulsar danach starten",
    launchDesc: "Direkt nach der Installation öffnen.",
    install: "Installieren",
  },
  install: {
    title: "Pulsar wird installiert",
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
    tips: {
      t1: "Pulsar vergibt eine Note von A+ bis F – wie in der Schule, nur für deinen Ping.",
      t2: "Der Boost ändert nur Dinge, die sich mit einem Klick zurücknehmen lassen.",
      t3: "Für CS2, Dota 2, Deadlock und League of Legends misst Pulsar die echten Server.",
      t4: "Alles läuft ohne Adminrechte und ohne Konto.",
      t5: "Strg + B startet den Boost – auch mitten im Spiel.",
    },
  },
  errors: {
    network: "Keine Verbindung zum Download-Server",
    checksum: "Die Datei ist beschädigt angekommen",
    disk: "Nicht genug Speicherplatz",
    permission: "Keine Berechtigung für diesen Ordner",
    manifest: "Download-Infos nicht gefunden",
    running: "Pulsar läuft noch",
    cancelled: "Installation abgebrochen",
    unknown: "Etwas ist schiefgelaufen",
    retry: "Erneut versuchen",
    resumeHint: "Keine Sorge: Der Download wird an der Stelle fortgesetzt, an der er unterbrochen wurde.",
    closeApp: "Pulsar schließen und weiter",
    back: "Zurück",
  },
  done: {
    title: "Pulsar ist bereit!",
    text: "Dein Signal steht. Viel Spaß – und niedrige Pings.",
    updated: "Update abgeschlossen – Pulsar startet gleich neu.",
    launch: "Pulsar jetzt starten",
    close: "Schließen",
    unverified: "Hinweis: Für diese Version war keine Prüfsumme hinterlegt.",
    autoLaunch: "Pulsar startet in {n} Sekunden …",
    dontLaunch: "Nicht starten",
  },
  uninstall: {
    title: "Pulsar deinstallieren?",
    text: "Pulsar wird von diesem PC entfernt. Alle Änderungen des Boosts werden vorher zurückgenommen – dein Windows bleibt so, wie es war.",
    keepData: "Meine Daten behalten",
    keepDataDesc: "Berichte, Spieleliste und Einstellungen bleiben für eine spätere Neuinstallation erhalten.",
    confirm: "Deinstallieren",
    cancel: "Abbrechen",
    running: "Pulsar wird entfernt …",
    steps: { stop: "Pulsar beenden", shortcuts: "Verknüpfungen entfernen", registry: "Windows-Einträge entfernen", files: "Dateien löschen", data: "Daten aufräumen" },
    doneTitle: "Signal beendet",
    doneText: "Pulsar wurde entfernt. Du bist jederzeit wieder willkommen.",
  },
  common: { next: "Weiter", back: "Zurück", close: "Schließen", mute: "Ton aus", unmute: "Ton an" },
};

type Dict = { [K in keyof typeof de]: (typeof de)[K] extends string ? string : { [P in keyof (typeof de)[K]]: (typeof de)[K][P] extends string ? string : Record<string, string> } };

const en: Dict = {
  tagline: "Your game booster",
  steps: { welcome: "Welcome", folder: "Location", options: "Options", install: "Install", done: "Done" },
  intro: { connecting: "Establishing signal …", ready: "Signal locked." },
  welcome: {
    title: "Welcome to PULSAR",
    text: "Pulsar measures your connection live, gets your PC ready to play with one click and tells you honestly where the lag comes from – no account, no admin rights.",
    f1: "Live ping with a grade",
    f1d: "A+ to F – against real game servers",
    f2: "Boost with one click",
    f2d: "Power plan, priority, DNS – fully reversible",
    f3: "Network tools",
    f3d: "Route, DNS comparison, speed test, Wi-Fi",
    version: "Version {v}",
    size: "Download: {size}",
    manifestError: "Download information could not be loaded. You can still try.",
    start: "Let's go",
    license: "By installing you agree that Pulsar stores measurements and game sessions on this PC – locally only, nothing is uploaded.",
  },
  maintenance: {
    title: "Pulsar is already installed",
    text: "Version {v} is in {dir}. What would you like to do?",
    update: "Update or repair",
    updateDesc: "Downloads the latest version. Your reports and settings are kept.",
    uninstall: "Uninstall",
    uninstallDesc: "Removes Pulsar from this PC.",
  },
  folder: {
    title: "Where should Pulsar live?",
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
    text: "Choose how Pulsar appears on your PC.",
    desktop: "Desktop shortcut",
    desktopDesc: "An icon on your desktop.",
    startMenu: "Start menu entry",
    startMenuDesc: "Find Pulsar through Windows search.",
    autostart: "Start with Windows",
    autostartDesc: "Starts quietly in the tray and measures as soon as a game runs.",
    launch: "Launch Pulsar afterwards",
    launchDesc: "Open right after installing.",
    install: "Install",
  },
  install: {
    title: "Installing Pulsar",
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
    tips: {
      t1: "Pulsar grades your connection from A+ to F – like school, but for your ping.",
      t2: "Boost only changes things that can be undone with one click.",
      t3: "For CS2, Dota 2, Deadlock and League of Legends, Pulsar measures the real servers.",
      t4: "Everything runs without admin rights and without an account.",
      t5: "Ctrl + B starts the boost – even while you're in a game.",
    },
  },
  errors: {
    network: "No connection to the download server",
    checksum: "The file arrived damaged",
    disk: "Not enough disk space",
    permission: "No permission for this folder",
    manifest: "Download information not found",
    running: "Pulsar is still running",
    cancelled: "Installation cancelled",
    unknown: "Something went wrong",
    retry: "Try again",
    resumeHint: "Don't worry: the download continues where it stopped.",
    closeApp: "Close Pulsar and continue",
    back: "Back",
  },
  done: {
    title: "Pulsar is ready!",
    text: "Signal locked. Have fun – and low pings.",
    updated: "Update complete – Pulsar restarts in a moment.",
    launch: "Launch Pulsar now",
    close: "Close",
    unverified: "Note: no checksum was provided for this version.",
    autoLaunch: "Pulsar starts in {n} seconds …",
    dontLaunch: "Don't launch",
  },
  uninstall: {
    title: "Uninstall Pulsar?",
    text: "Pulsar will be removed from this PC. All boost changes are reverted first – your Windows stays as it was.",
    keepData: "Keep my data",
    keepDataDesc: "Reports, game list and settings are kept for a later reinstall.",
    confirm: "Uninstall",
    cancel: "Cancel",
    running: "Removing Pulsar …",
    steps: { stop: "Closing Pulsar", shortcuts: "Removing shortcuts", registry: "Removing Windows entries", files: "Deleting files", data: "Cleaning up data" },
    doneTitle: "Signal ended",
    doneText: "Pulsar has been removed. You are always welcome back.",
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
