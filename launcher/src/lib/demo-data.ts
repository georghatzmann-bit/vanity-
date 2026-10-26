/*
 * Sample data – only for the browser preview (without Tauri) and for texts that are the same everywhere.
 * In the real launcher builds, profiles, friends, logs and crashes come from Rust.
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
    supportNote: "Tested",
    launchArgs: "-d3d11",
  },
  {
    id: "15.40-15526472",
    version: "15.40",
    changelist: 15526472,
    season: "Chapter 2 · Season 5",
    engine: "Unreal Engine 4.26",
    path: "C:\\Users\\georg\\Downloads\\windows-15.40",
    binaries: "C:\\Users\\georg\\Downloads\\windows-15.40\\FortniteGame\\Binaries\\Win64",
    support: "experimental",
    supportNote: "Untested – we'll try to start it · The Pre-Edits switch is gone from 15.20 on",
    launchArgs: "-d3d11",
  },
];

export const versionSupport = [
  { version: "19.10", label: "Chapter 3 · Season 1", level: "supported", note: "Tested – everything is tuned for this one" },
  { version: "1.7 – 10.40", label: "Chapter 1", level: "experimental", note: "Untested. The parts know these versions; very old builds need more patience to start" },
  { version: "11.00 – 18.40", label: "Chapter 2", level: "experimental", note: "Untested. 15.40 – 16.00 can use Bubble Builds" },
  { version: "19.00 – 22.40", label: "Chapter 3", level: "experimental", note: "Untested (except 19.10)" },
  { version: "23.00 – 27.11", label: "Chapter 4 + OG", level: "experimental", note: "Untested" },
  { version: "28.00 – 30.xx", label: "Chapter 5 (Seasons 1–3)", level: "experimental", note: "Untested; Erbium calls its support \"partial\". The server knows the new network code (Iris)" },
  { version: "31.00 and newer", label: "Chapter 5 Season 4, Remix, Chapter 6 …", level: "unsupported", note: "Not yet: the game server (Erbium/Magnesium) only knows versions up to 30.x. It will be added once those projects catch up" },
] as const;

export const demoFriends: Friend[] = [
  { id: "f1", name: "Max", via: "Tailscale", address: "100.101.12.7" },
  { id: "f2", name: "Lena", via: "Radmin VPN", address: "26.31.4.120" },
];

export const demoProfiles: Profile[] = [
  {
    id: "p-standard",
    name: "Standard",
    description: "A normal match on your own server",
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
    description: "No fall damage, endless ammo, spawn up high",
    buildId: "19.10-18675304",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    playlist: "Playlist_ShowdownAlt_Duos",
    lategame: false,
    tags: ["Team Rumble", "Trickshot"],
  },
  {
    id: "p-arena",
    name: "Arena Lategame",
    description: "Arena with a lategame start and bots",
    buildId: "19.10-18675304",
    playerName: "georg",
    launchArgs: "-d3d11",
    headlessServer: true,
    playlist: "Playlist_ShowdownAlt_Solo",
    lategame: true,
    tags: ["Arena", "Lategame"],
  },
];

/** Playlists the game server knows (short name → label). */
export const playlists = [
  // Names the game server (niobium_server.dll) knows – see docs/02-architecture.md, control pipe
  { id: "Playlist_DefaultSolo", label: "Solo" },
  { id: "Playlist_DefaultDuo", label: "Duos" },
  { id: "Playlist_Trios", label: "Trios" },
  { id: "Playlist_DefaultSquad", label: "Squads" },
  { id: "Playlist_ShowdownAlt_Solo", label: "Arena Solo" },
  { id: "Playlist_ShowdownAlt_Duos", label: "Arena Duos" },
  { id: "Playlist_ShowdownAlt_Trios", label: "Arena Trios" },
  { id: "Playlist_ShowdownAlt_Squads", label: "Arena Squads" },
  { id: "Playlist_Showdown_Solo", label: "Tournament Solo" },
  { id: "Playlist_Showdown_Duos", label: "Tournament Duos" },
  { id: "Playlist_NoBuildBR_Solo", label: "Zero Build Solo" },
  { id: "Playlist_NoBuildBR_Duo", label: "Zero Build Duos" },
  { id: "Playlist_NoBuildBR_Trio", label: "Zero Build Trios" },
  { id: "Playlist_NoBuildBR_Squad", label: "Zero Build Squads" },
  { id: "Playlist_ShowdownAlt_NoBuildBR_Solo", label: "Arena Zero Build Solo" },
  { id: "Playlist_ShowdownAlt_NoBuildBR_Duos", label: "Arena Zero Build Duos" },
  { id: "Playlist_Playground", label: "Playground" },
];

export function playlistLabel(id: string): string {
  return playlists.find((p) => p.id === id)?.label ?? (id || "Solo");
}

export type DemoLogLine = Omit<LogLine, "time">;

/** Roughly what a launch looks like – only for the browser preview. */
export const demoLogScript: DemoLogLine[] = [
  { source: "launcher", level: "info", category: "Niobium", message: "Profile \"Standard\" loaded – build 19.10 (CL-18675304)" },
  { source: "backend", level: "info", category: "Backend", message: "Backend listening on 127.0.0.1:3551" },
  { source: "launcher", level: "info", category: "Niobium", message: "Starting the server Fortnite: -nullrhi -nosplash -nosound" },
  { source: "server", level: "info", category: "LogInit", message: "Build: ++Fortnite+Release-19.10-CL-18675304" },
  { source: "launcher", level: "info", category: "Niobium", message: "Redirect loaded" },
  { source: "server", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Login detected" },
  { source: "server", level: "info", category: "Niobium", message: "niobium_server.dll loaded" },
  { source: "server", level: "warning", category: "LogStreaming", message: "Package /Game/Athena/Artemis/Maps/… took 3.2s to load" },
  { source: "server", level: "info", category: "LogNet", message: "GameNetDriver IpNetDriver listening on port 7777", detected: "Server ready" },
  { source: "launcher", level: "info", category: "Niobium", message: "Starting your game: -d3d11" },
  { source: "game", level: "info", category: "LogD3D11RHI", message: "Chosen D3D11 Adapter: 0" },
  { source: "backend", level: "info", category: "Backend", message: "GET /fortnite/api/v2/versioncheck/Windows → 200" },
  { source: "game", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Login detected" },
  { source: "game", level: "info", category: "Niobium", message: "niobium_client.dll loaded – press F9 for the menu" },
  { source: "game", level: "error", category: "LogParty", message: "Failed to connect to XMPP – party features limited" },
  { source: "backend", level: "info", category: "Backend", message: "Matchmaker: player queued → 127.0.0.1:7777" },
  { source: "server", level: "info", category: "LogNet", message: "Join succeeded: georg" },
];

export const demoCrashes: CrashReport[] = [
  {
    id: "UECC-Windows-ABC",
    folder: "C:\\Users\\georg\\AppData\\Local\\FortniteGame\\Saved\\Crashes\\UECC-Windows-ABC",
    time: Math.floor(Date.now() / 1000) - 3600,
    version: "19.40",
    title: "Crash in a third-party DLL",
    severity: "high",
    whatHappened: "Fortnite closed – the error came from an extra DLL that isn't part of Niobium.",
    likelyCause: "The DLL \"console.dll\" doesn't match this Fortnite version or runs at the wrong moment.",
    whatToDo: ["Stop using this DLL together with Niobium.", "Niobium brings every DLL it needs."],
    technical: [["Error", "EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000038"], ["Module", "console.dll"]],
    callstack: ["console.dll!UnknownFunction []", "FortniteClient-Win64-Shipping.exe!UConsole::ConsoleCommand()"],
  },
  {
    id: "UECC-Windows-DEF",
    folder: "C:\\…\\Crashes\\UECC-Windows-DEF",
    time: Math.floor(Date.now() / 1000) - 90000,
    version: "19.10",
    title: "The graphics card gave up",
    severity: "medium",
    whatHappened: "The picture froze and Fortnite closed.",
    likelyCause: "The graphics driver lost its connection to the game.",
    whatToDo: ["Start with -d3d11 (Profile → launch arguments).", "Turn off overlays from other programs."],
    technical: [["Error", "DXGI_ERROR_DEVICE_REMOVED (0x887A0005)"]],
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
    group: "Built on (source code used)",
    items: [
      { name: "Magnesium", author: "Ploosh, ralz, cipher", license: "BSD-3-Clause", url: "https://github.com/Ralzify/Magnesium", use: "Base of the game server (niobium_server.dll)" },
      { name: "Erbium / ErbiumClient", author: "Ploosh", license: "GPL-3.0", url: "https://github.com/plooshi/Erbium", use: "Base of Magnesium; parts of the in-game menu" },
      { name: "Tellurium", author: "Ploosh", license: "BSD-3-Clause", url: "https://github.com/plooshi/Tellurium", use: "Base of the redirect (niobium_redirect.dll)" },
      { name: "LawinServer", author: "Lawin0129", license: "GPL-3.0", url: "https://github.com/Lawin0129/LawinServer", use: "Base of the backend" },
      { name: "ATLAS Console", author: "cipherfps, ralz and contributors", license: "ATLAS Console Attribution License v1.0", url: "https://github.com/Ralzify/ATLAS-Client", use: "Base of the in-game menu (niobium_client.dll) – Niobium's menu is based on ATLAS Console" },
    ],
  },
  {
    group: "Inspired by (read only)",
    items: [
      { name: "Reboot Launcher", author: "Auties00", license: "no license", url: "https://github.com/Auties00/reboot_launcher", use: "Launch flow and log detection" },
    ],
  },
  {
    group: "Libraries",
    items: [
      { name: "Tauri", author: "Tauri Programme", license: "MIT / Apache-2.0", url: "https://tauri.app", use: "Launcher window" },
      { name: "React", author: "Meta", license: "MIT", url: "https://react.dev", use: "User interface" },
      { name: "Tailwind CSS", author: "Tailwind Labs", license: "MIT", url: "https://tailwindcss.com", use: "Styling" },
      { name: "shadcn/ui + Radix UI", author: "shadcn, WorkOS", license: "MIT", url: "https://ui.shadcn.com", use: "Controls" },
      { name: "Motion", author: "Motion Division", license: "MIT", url: "https://motion.dev", use: "Animations" },
      { name: "Inter", author: "Rasmus Andersson", license: "SIL OFL 1.1", url: "https://rsms.me/inter", use: "Logo lettering (shapes only, no font file ships)" },
      { name: "Lucide", author: "Lucide Contributors", license: "ISC", url: "https://lucide.dev", use: "Icons" },
      { name: "MinHook", author: "Tsuda Kageyu", license: "BSD-2-Clause", url: "https://github.com/TsudaKageyu/minhook", use: "Function hooks in the DLLs" },
      { name: "Dear ImGui", author: "Omar Cornut", license: "MIT", url: "https://github.com/ocornut/imgui", use: "In-game menu" },
      { name: "Memcury", author: "Kareem Olim", license: "MIT", url: "https://github.com/kem0x/Memcury", use: "Pattern search in memory" },
      { name: "Node.js", author: "OpenJS Foundation", license: "MIT", url: "https://nodejs.org", use: "Runs the backend" },
    ],
  },
];
