/*
 * Beispieldaten für die Design-Vorschau (Phase 1).
 * Nichts hiervon ist echt – ab Phase 2 kommen die Daten aus der Rust-Seite.
 */

export interface Build {
  id: string;
  version: string;
  changelist: string;
  season: string;
  engine: string;
  path: string;
  launchArgs: string;
}

export const demoBuilds: Build[] = [
  {
    id: "19.10",
    version: "19.10",
    changelist: "18675304",
    season: "Chapter 3 · Season 1",
    engine: "Unreal Engine 5.0",
    path: "C:\\Users\\georg\\Downloads\\windows-19.10",
    launchArgs: "-d3d11",
  },
];

export type SupportLevel = "supported" | "planned" | "later";

export const versionSupport: { version: string; label: string; level: SupportLevel; note: string }[] = [
  { version: "19.10", label: "Chapter 3 · Season 1", level: "supported", note: "Erste Version, auf die alles abgestimmt wird" },
  { version: "19.40", label: "Chapter 3 · Season 1", level: "planned", note: "Als Nächstes – Erbium unterstützt sie schon voll" },
  { version: "3.4 – 18.40", label: "Chapter 1 + 2", level: "later", note: "Später, Schritt für Schritt" },
];

export interface ServerEntry {
  id: string;
  name: string;
  address: string;
  via: "Lokal" | "Tailscale" | "Radmin VPN";
  playlist: string;
  players: number;
  maxPlayers: number;
  pingMs: number | null;
  version: string;
}

export const demoServers: ServerEntry[] = [
  { id: "s1", name: "Mein Server", address: "127.0.0.1:7777", via: "Lokal", playlist: "Solo", players: 1, maxPlayers: 100, pingMs: 1, version: "19.10" },
  { id: "s2", name: "Max’ Lategame", address: "100.101.12.7:7777", via: "Tailscale", playlist: "Lategame Solo", players: 3, maxPlayers: 100, pingMs: 28, version: "19.10" },
  { id: "s3", name: "Trickshot-Lobby", address: "26.14.88.3:7777", via: "Radmin VPN", playlist: "Team Rumble", players: 6, maxPlayers: 16, pingMs: 61, version: "19.10" },
  { id: "s4", name: "Lenas Server", address: "26.31.4.120:7777", via: "Radmin VPN", playlist: "Duos", players: 0, maxPlayers: 100, pingMs: null, version: "19.10" },
];

export interface Friend {
  id: string;
  name: string;
  via: "Tailscale" | "Radmin VPN";
  address: string;
  online: boolean;
}

export const demoFriends: Friend[] = [
  { id: "f1", name: "Max", via: "Tailscale", address: "100.101.12.7", online: true },
  { id: "f2", name: "Lena", via: "Radmin VPN", address: "26.31.4.120", online: false },
];

export interface Profile {
  id: string;
  name: string;
  description: string;
  buildId: string;
  playerName: string;
  launchArgs: string;
  headlessServer: boolean;
  tags: string[];
}

export const demoProfiles: Profile[] = [
  {
    id: "p-standard",
    name: "Standard",
    description: "Normales Match auf deinem eigenen Server",
    buildId: "19.10",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    tags: ["Solo", "Sturm an"],
  },
  {
    id: "p-trickshot",
    name: "Trickshot",
    description: "Kein Fallschaden, unendlich Munition, Spawn in der Höhe",
    buildId: "19.10",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    tags: ["Team Rumble", "Respawn", "Trickshot-Modus"],
  },
  {
    id: "p-arena",
    name: "Arena-Training",
    description: "Lategame mit 20 Bots als Gegner",
    buildId: "19.10",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    tags: ["Lategame", "20 Bots"],
  },
];

export const playlists = [
  { id: "Playlist_DefaultSolo", label: "Solo" },
  { id: "Playlist_DefaultDuo", label: "Duos" },
  { id: "Playlist_Trios", label: "Trios" },
  { id: "Playlist_DefaultSquad", label: "Squads" },
  { id: "Playlist_Respawn_24", label: "Team Rumble" },
  { id: "Playlist_ShowdownAlt_Solo", label: "Arena Solo" },
];

export const giveableItems = [
  "Pump-Shotgun",
  "Sturmgewehr (MK-Seven)",
  "Scharfschützengewehr",
  "Maschinenpistole",
  "Schildtrank",
  "Medikit",
  "Holz (999)",
  "Stein (999)",
  "Metall (999)",
];

export type LogSource = "game" | "server" | "backend" | "launcher";
export type LogLevel = "info" | "warning" | "error";

export interface LogLine {
  source: LogSource;
  level: LogLevel;
  category: string;
  message: string;
  /** Wenn Vanity an dieser Zeile etwas erkennt, steht hier was. */
  detected?: string;
}

/** So ungefähr sieht ein Start aus – nur als Anschauung für die Log-Anzeige. */
export const demoLogScript: LogLine[] = [
  { source: "launcher", level: "info", category: "Vanity", message: "Profil „Standard“ geladen – Build 19.10 (CL-18675304)" },
  { source: "backend", level: "info", category: "Backend", message: "Backend hört auf 127.0.0.1:3551" },
  { source: "launcher", level: "info", category: "Vanity", message: "Starte Server-Fortnite: -nullrhi -nosplash -nosound" },
  { source: "server", level: "info", category: "LogInit", message: "Build: ++Fortnite+Release-19.10-CL-18675304" },
  { source: "server", level: "info", category: "LogInit", message: "Engine Version: 5.0.0-18675304+++Fortnite+Release-19.10" },
  { source: "launcher", level: "info", category: "Vanity", message: "Umleitungs-DLL geladen (Server)" },
  { source: "backend", level: "info", category: "Backend", message: "POST /account/api/oauth/token → 200" },
  { source: "server", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Anmeldung erkannt" },
  { source: "launcher", level: "info", category: "Vanity", message: "Game-Server-DLL geladen – lade Karte Artemis_Terrain" },
  { source: "server", level: "warning", category: "LogStreaming", message: "Package /Game/Athena/Artemis/Maps/… took 3.2s to load" },
  { source: "server", level: "info", category: "LogNet", message: "GameNetDriver IpNetDriver listening on port 7777", detected: "Server bereit" },
  { source: "launcher", level: "info", category: "Vanity", message: "Starte dein Spiel: -d3d11" },
  { source: "game", level: "info", category: "LogInit", message: "Build: ++Fortnite+Release-19.10-CL-18675304" },
  { source: "game", level: "info", category: "LogD3D11RHI", message: "Chosen D3D11 Adapter: 0" },
  { source: "game", level: "info", category: "LogInit", message: "Command Line: -epicapp=Fortnite -epicenv=Prod -skippatchcheck -d3d11" },
  { source: "backend", level: "info", category: "Backend", message: "GET /fortnite/api/v2/versioncheck/Windows → 200" },
  { source: "game", level: "warning", category: "LogHttp", message: "Retry 1 on https://…/content/api/pages/fortnite-game" },
  { source: "backend", level: "info", category: "Backend", message: "GET /content/api/pages/fortnite-game → 200" },
  { source: "game", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Anmeldung erkannt" },
  { source: "launcher", level: "info", category: "Vanity", message: "Ingame-Menü-DLL geladen – F9 öffnet das Menü" },
  { source: "backend", level: "info", category: "Backend", message: "POST /fortnite/api/game/v2/profile/…/client/QueryProfile → 200" },
  { source: "game", level: "info", category: "LogFort", message: "Frontend ready", detected: "Lobby erreicht" },
  { source: "game", level: "error", category: "LogParty", message: "Failed to connect to XMPP – party features limited" },
  { source: "backend", level: "info", category: "Backend", message: "Matchmaker: Spieler eingereiht → 127.0.0.1:7777" },
  { source: "server", level: "info", category: "LogNet", message: "Join succeeded: georg" },
];

export interface CrashReport {
  id: string;
  when: string;
  version: string;
  title: string;
  severity: "high" | "medium";
  whatHappened: string;
  likelyCause: string;
  whatToDo: string[];
  technical: { label: string; value: string }[];
  callstack: string[];
}

export const demoCrashes: CrashReport[] = [
  {
    id: "c1",
    when: "Heute, 18:42",
    version: "19.40",
    title: "Konsole im falschen Moment",
    severity: "high",
    whatHappened:
      "Fortnite wurde sofort beendet, als die Konsole geöffnet wurde. Ein Zusatzprogramm hat auf Spieldaten zugegriffen, die es gerade nicht anfassen durfte.",
    likelyCause:
      "Die Konsolen-DLL (console.dll) läuft in einem eigenen Ablauf neben dem Spiel. Bei 19.40 passt das zeitlich nicht mehr – das Spiel räumt gerade auf, während die Konsole noch zugreift.",
    whatToDo: [
      "Die Konsole in dieser Version vorerst ausschalten.",
      "Mit Vanity ab Phase 5: Unsere Konsole läuft im Takt des Spiels und hat dieses Problem nicht.",
    ],
    technical: [
      { label: "Fehler", value: "EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000038" },
      { label: "Modul", value: "console.dll" },
      { label: "Thread", value: "nicht der Spiel-Thread" },
    ],
    callstack: [
      "console.dll!UnknownFunction []",
      "FortniteClient-Win64-Shipping.exe!UConsole::ConsoleCommand()",
      "kernel32.dll!BaseThreadInitThunk()",
      "ntdll.dll!RtlUserThreadStart()",
    ],
  },
  {
    id: "c2",
    when: "Gestern, 21:10",
    version: "19.10",
    title: "Grafikkarte hat aufgegeben",
    severity: "medium",
    whatHappened: "Das Bild ist eingefroren und Fortnite hat sich nach ein paar Sekunden geschlossen.",
    likelyCause:
      "Der Grafiktreiber hat die Verbindung zum Spiel verloren. Das passiert bei alten Builds oft mit DirectX 12 oder mit Overlays von anderen Programmen.",
    whatToDo: [
      "Mit -d3d11 starten (ist in deinem Profil schon drin).",
      "Overlays von Discord, Steam oder GeForce Experience ausschalten.",
      "Grafiktreiber aktualisieren.",
    ],
    technical: [
      { label: "Fehler", value: "DXGI_ERROR_DEVICE_REMOVED (0x887A0005)" },
      { label: "Modul", value: "D3D11RHI" },
    ],
    callstack: ["FortniteClient-Win64-Shipping.exe!FD3D11DynamicRHI::RHIEndFrame()"],
  },
  {
    id: "c3",
    when: "20.10.2026, 17:03",
    version: "19.10",
    title: "Build-Dateien beschädigt",
    severity: "high",
    whatHappened: "Fortnite hat sich direkt beim Laden geschlossen, noch bevor ein Bild kam.",
    likelyCause:
      "Eine der großen Spieldateien (.pak) ist kaputt oder unvollständig – meistens beim Entpacken oder durch ein Virenprogramm.",
    whatToDo: [
      "Den Build-Ordner neu entpacken.",
      "Den Ordner im Virenprogramm als Ausnahme eintragen.",
    ],
    technical: [{ label: "Fehler", value: "Pak chunk signature verification failed!" }],
    callstack: ["FortniteClient-Win64-Shipping.exe!FPakFile::Initialize()"],
  },
];

export interface Credit {
  name: string;
  author: string;
  license: string;
  url: string;
  use: string;
}

export const credits: { group: string; items: Credit[] }[] = [
  {
    group: "Vorbilder und Grundlagen",
    items: [
      { name: "Reboot Launcher", author: "Auties00", license: "keine Lizenz – nur gelesen", url: "https://github.com/Auties00/reboot_launcher", use: "Vorbild für Startablauf und Log-Erkennung" },
      { name: "Erbium", author: "Ploosh", license: "GPL-3.0", url: "https://github.com/plooshi/Erbium", use: "Grundlage für den Game Server" },
      { name: "Magnesium", author: "Ploosh, ralz, cipher", license: "BSD-3-Clause", url: "https://github.com/Ralzify/Magnesium", use: "Ideen für Bots, Trickshot, Lategame" },
      { name: "Tellurium", author: "Ploosh", license: "BSD-3-Clause", url: "https://github.com/plooshi/Tellurium", use: "Grundlage für die Umleitungs-DLL" },
      { name: "ATLAS-Client", author: "ralz, cipherfps", license: "eigene Lizenz – nur gelesen", url: "https://github.com/Ralzify/ATLAS-Client", use: "Idee: Befehle im Spiel-Takt ausführen" },
      { name: "LawinServer", author: "Lawin0129", license: "GPL-3.0", url: "https://github.com/Lawin0129/LawinServer", use: "Vorbild für das Backend" },
    ],
  },
  {
    group: "Bibliotheken",
    items: [
      { name: "Tauri", author: "Tauri Programme", license: "MIT / Apache-2.0", url: "https://tauri.app", use: "Launcher-Fenster" },
      { name: "React", author: "Meta", license: "MIT", url: "https://react.dev", use: "Oberfläche" },
      { name: "Tailwind CSS", author: "Tailwind Labs", license: "MIT", url: "https://tailwindcss.com", use: "Gestaltung" },
      { name: "shadcn/ui + Radix UI", author: "shadcn, WorkOS", license: "MIT", url: "https://ui.shadcn.com", use: "Bedienelemente" },
      { name: "Motion", author: "Motion Division", license: "MIT", url: "https://motion.dev", use: "Animationen" },
      { name: "Lucide", author: "Lucide Contributors", license: "ISC", url: "https://lucide.dev", use: "Symbole" },
      { name: "MinHook", author: "Tsuda Kageyu", license: "BSD-2-Clause", url: "https://github.com/TsudaKageyu/minhook", use: "ab Phase 2" },
      { name: "Dear ImGui", author: "Omar Cornut", license: "MIT", url: "https://github.com/ocornut/imgui", use: "ab Phase 5" },
      { name: "Memcury", author: "Kareem Olim", license: "MIT", url: "https://github.com/kem0x/Memcury", use: "ab Phase 2" },
    ],
  },
];
