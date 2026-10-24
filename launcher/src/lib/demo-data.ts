/*
 * Beispieldaten – nur für die Browser-Vorschau (ohne Tauri) und für Texte, die überall gleich sind.
 * Im echten Launcher kommen Builds, Profile, Freunde, Logs und Abstürze aus Rust.
 */
import type { BuildInfo, CrashReport, Friend, LogLine, Profile } from "./api";

export const demoBuilds: BuildInfo[] = [
  {
    id: "19.10-18675304",
    version: "19.10",
    changelist: 18675304,
    season: "Chapter 3 · Season 1",
    engine: "Unreal Engine 5.0",
    path: "C:\\Users\\georg\\Downloads\\windows-19.10",
    binaries: "C:\\Users\\georg\\Downloads\\windows-19.10\\FortniteGame\\Binaries\\Win64",
    support: "supported",
    launchArgs: "-d3d11",
  },
];

export const versionSupport = [
  { version: "19.10", label: "Chapter 3 · Season 1", level: "supported", note: "Erste Version, auf die alles abgestimmt wird" },
  { version: "19.40", label: "Chapter 3 · Season 1", level: "planned", note: "Als Nächstes" },
  { version: "3.4 – 18.40", label: "Chapter 1 + 2", level: "later", note: "Später, Schritt für Schritt" },
] as const;

export const demoFriends: Friend[] = [
  { id: "f1", name: "Max", via: "Tailscale", address: "100.101.12.7" },
  { id: "f2", name: "Lena", via: "Radmin VPN", address: "26.31.4.120" },
];

export const demoProfiles: Profile[] = [
  {
    id: "p-standard",
    name: "Standard",
    description: "Normales Match auf deinem eigenen Server",
    buildId: "19.10-18675304",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    playlist: "Playlist_DefaultSolo",
    lategame: false,
    tags: ["Solo"],
  },
  {
    id: "p-trickshot",
    name: "Trickshot",
    description: "Kein Fallschaden, unendlich Munition, Spawn in der Höhe",
    buildId: "19.10-18675304",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    playlist: "Playlist_Respawn_24",
    lategame: false,
    tags: ["Team Rumble", "Trickshot"],
  },
  {
    id: "p-arena",
    name: "Arena-Lategame",
    description: "Arena mit Lategame-Start und Bots",
    buildId: "19.10-18675304",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    playlist: "Playlist_ShowdownAlt_Solo",
    lategame: true,
    tags: ["Arena", "Lategame"],
  },
];

/** Playlists, die der Game Server kennt (Kurzname → Anzeige). */
export const playlists = [
  { id: "Playlist_DefaultSolo", label: "Solo" },
  { id: "Playlist_DefaultDuo", label: "Duos" },
  { id: "Playlist_Trios", label: "Trios" },
  { id: "Playlist_DefaultSquad", label: "Squads" },
  { id: "Playlist_Respawn_24", label: "Team Rumble" },
  { id: "Playlist_ShowdownAlt_Solo", label: "Arena Solo" },
  { id: "Playlist_ShowdownAlt_Duos", label: "Arena Duos" },
];

export function playlistLabel(id: string): string {
  return playlists.find((p) => p.id === id)?.label ?? (id || "Solo");
}

export type DemoLogLine = Omit<LogLine, "time">;

/** So ungefähr sieht ein Start aus – nur für die Browser-Vorschau. */
export const demoLogScript: DemoLogLine[] = [
  { source: "launcher", level: "info", category: "Vanity", message: "Profil „Standard“ geladen – Build 19.10 (CL-18675304)" },
  { source: "backend", level: "info", category: "Backend", message: "Backend hört auf 127.0.0.1:3551" },
  { source: "launcher", level: "info", category: "Vanity", message: "Starte Server-Fortnite: -nullrhi -nosplash -nosound" },
  { source: "server", level: "info", category: "LogInit", message: "Build: ++Fortnite+Release-19.10-CL-18675304" },
  { source: "launcher", level: "info", category: "Vanity", message: "Umleitung geladen" },
  { source: "server", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Anmeldung erkannt" },
  { source: "server", level: "info", category: "Vanity", message: "vanity_server.dll geladen" },
  { source: "server", level: "warning", category: "LogStreaming", message: "Package /Game/Athena/Artemis/Maps/… took 3.2s to load" },
  { source: "server", level: "info", category: "LogNet", message: "GameNetDriver IpNetDriver listening on port 7777", detected: "Server bereit" },
  { source: "launcher", level: "info", category: "Vanity", message: "Starte dein Spiel: -d3d11" },
  { source: "game", level: "info", category: "LogD3D11RHI", message: "Chosen D3D11 Adapter: 0" },
  { source: "backend", level: "info", category: "Backend", message: "GET /fortnite/api/v2/versioncheck/Windows → 200" },
  { source: "game", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Anmeldung erkannt" },
  { source: "game", level: "info", category: "Vanity", message: "vanity_client.dll geladen – F9 öffnet das Menü" },
  { source: "game", level: "error", category: "LogParty", message: "Failed to connect to XMPP – party features limited" },
  { source: "backend", level: "info", category: "Backend", message: "Matchmaker: Spieler eingereiht → 127.0.0.1:7777" },
  { source: "server", level: "info", category: "LogNet", message: "Join succeeded: georg" },
];

export const demoCrashes: CrashReport[] = [
  {
    id: "UECC-Windows-ABC",
    folder: "C:\\Users\\georg\\AppData\\Local\\FortniteGame\\Saved\\Crashes\\UECC-Windows-ABC",
    time: Math.floor(Date.now() / 1000) - 3600,
    version: "19.40",
    title: "Absturz in einer fremden DLL",
    severity: "high",
    whatHappened: "Fortnite wurde beendet – der Fehler kam aus einer Zusatz-DLL, die nicht von Vanity ist.",
    likelyCause: "Die DLL „console.dll“ passt nicht zu dieser Fortnite-Version oder greift im falschen Moment zu.",
    whatToDo: ["Diese DLL nicht mehr zusammen mit Vanity verwenden.", "Vanity bringt alle nötigen DLLs selbst mit."],
    technical: [["Fehler", "EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000038"], ["Modul", "console.dll"]],
    callstack: ["console.dll!UnknownFunction []", "FortniteClient-Win64-Shipping.exe!UConsole::ConsoleCommand()"],
  },
  {
    id: "UECC-Windows-DEF",
    folder: "C:\\…\\Crashes\\UECC-Windows-DEF",
    time: Math.floor(Date.now() / 1000) - 90000,
    version: "19.10",
    title: "Grafikkarte hat aufgegeben",
    severity: "medium",
    whatHappened: "Das Bild ist eingefroren und Fortnite wurde beendet.",
    likelyCause: "Der Grafiktreiber hat die Verbindung zum Spiel verloren.",
    whatToDo: ["Mit -d3d11 starten (Profil → Startargumente).", "Overlays anderer Programme ausschalten."],
    technical: [["Fehler", "DXGI_ERROR_DEVICE_REMOVED (0x887A0005)"]],
    callstack: ["FortniteClient-Win64-Shipping.exe!FD3D11DynamicRHI::RHIEndFrame()"],
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
    group: "Grundlagen (Quellcode übernommen)",
    items: [
      { name: "Magnesium", author: "Ploosh, ralz, cipher", license: "BSD-3-Clause", url: "https://github.com/Ralzify/Magnesium", use: "Grundlage für den Game Server (vanity_server.dll)" },
      { name: "Erbium / ErbiumClient", author: "Ploosh", license: "GPL-3.0", url: "https://github.com/plooshi/Erbium", use: "Basis von Magnesium; Teile im Ingame-Menü" },
      { name: "Tellurium", author: "Ploosh", license: "BSD-3-Clause", url: "https://github.com/plooshi/Tellurium", use: "Grundlage für die Umleitung (vanity_redirect.dll)" },
      { name: "LawinServer", author: "Lawin0129", license: "GPL-3.0", url: "https://github.com/Lawin0129/LawinServer", use: "Grundlage für das Backend" },
      { name: "ATLAS Console", author: "cipherfps, ralz und Mitwirkende", license: "ATLAS Console Attribution License v1.0", url: "https://github.com/Ralzify/ATLAS-Client", use: "Grundlage für das Ingame-Menü (vanity_client.dll) – Vanity basiert hier auf ATLAS Console" },
    ],
  },
  {
    group: "Vorbilder (nur gelesen)",
    items: [
      { name: "Reboot Launcher", author: "Auties00", license: "keine Lizenz", url: "https://github.com/Auties00/reboot_launcher", use: "Startablauf und Log-Erkennung" },
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
      { name: "MinHook", author: "Tsuda Kageyu", license: "BSD-2-Clause", url: "https://github.com/TsudaKageyu/minhook", use: "Funktions-Hooks in den DLLs" },
      { name: "Dear ImGui", author: "Omar Cornut", license: "MIT", url: "https://github.com/ocornut/imgui", use: "Ingame-Menü" },
      { name: "Memcury", author: "Kareem Olim", license: "MIT", url: "https://github.com/kem0x/Memcury", use: "Muster-Suche im Speicher" },
      { name: "Node.js", author: "OpenJS Foundation", license: "MIT", url: "https://nodejs.org", use: "läuft das Backend" },
    ],
  },
];
