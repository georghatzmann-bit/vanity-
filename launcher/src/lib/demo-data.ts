/*
 * Sample data – only for the browser preview (without Tauri) and for texts that are the same everywhere.
 * In the real launcher builds, profiles, friends, logs and crashes come from Rust.
 */
import type { BuildInfo, Catalog, CatalogBuild, CatalogSeason, CrashReport, Friend, LogLine, Profile, SeasonStatus } from "./api";

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

/** Match rules of a new profile: "Classic match" (like back then), no AI bots, Bosses & NPCs off. */
export const classicMatch = {
  lategame: false,
  infiniteAmmo: false,
  infiniteMats: false,
  bots: false,
  botCount: 30,
  botSkill: "easy",
  livingWorld: false,
  livingWorldMaxAI: 40,
} as const satisfies Partial<Profile>;

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
    tags: ["Solo"],
    ...classicMatch,
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
    tags: ["Team Rumble", "Trickshot"],
    ...classicMatch,
    infiniteAmmo: true,
    infiniteMats: true,
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
    tags: ["Arena", "Lategame"],
    ...classicMatch,
    lategame: true,
    bots: true,
    botCount: 24,
    botSkill: "normal",
  },
];

/** Playlists the game server knows (short name → label). */
export const playlists = [
  // Names the game server (rift_server.dll) knows – see docs/02-architecture.md, control pipe
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
  { source: "launcher", level: "info", category: "Rift", message: "Profile \"Standard\" loaded – build 19.10 (CL-18675304)" },
  { source: "backend", level: "info", category: "Backend", message: "Backend listening on 127.0.0.1:3551" },
  { source: "launcher", level: "info", category: "Rift", message: "Starting the server Fortnite: -nullrhi -nosplash -nosound" },
  { source: "server", level: "info", category: "LogInit", message: "Build: ++Fortnite+Release-19.10-CL-18675304" },
  { source: "launcher", level: "info", category: "Rift", message: "Redirect loaded" },
  { source: "server", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Login detected" },
  { source: "server", level: "info", category: "Rift", message: "rift_server.dll loaded" },
  { source: "server", level: "warning", category: "LogStreaming", message: "Package /Game/Athena/Artemis/Maps/… took 3.2s to load" },
  { source: "server", level: "info", category: "LogNet", message: "GameNetDriver IpNetDriver listening on port 7777", detected: "Server ready" },
  { source: "launcher", level: "info", category: "Rift", message: "Starting your game: -d3d11" },
  { source: "game", level: "info", category: "LogD3D11RHI", message: "Chosen D3D11 Adapter: 0" },
  { source: "backend", level: "info", category: "Backend", message: "GET /fortnite/api/v2/versioncheck/Windows → 200" },
  { source: "game", level: "info", category: "LogOnlineAccount", message: "[UOnlineAccountCommon::ContinueLoggingIn] (Completed)", detected: "Login detected" },
  { source: "game", level: "info", category: "Rift", message: "rift_client.dll loaded – press F9 for the menu" },
  { source: "game", level: "error", category: "LogParty", message: "Failed to connect to XMPP – party features limited" },
  { source: "backend", level: "info", category: "Backend", message: "Matchmaker: player queued → 127.0.0.1:7777" },
  { source: "server", level: "info", category: "LogNet", message: "Join succeeded: georg" },
  { source: "server", level: "info", category: "loot", message: "items: 312" },
  // What the server says today with Bosses & NPCs on (spawning is still being built)
  { source: "server", level: "warning", category: "livingWorld", message: "unavailable: not built yet for this version (Fortnite 19.10, max AI 40)" },
  { source: "launcher", level: "warning", category: "livingWorld", message: "Bosses & NPCs aren't available: not built yet for this version" },
];

export const demoCrashes: CrashReport[] = [
  {
    id: "UECC-Windows-ABC",
    folder: "C:\\Users\\georg\\AppData\\Local\\FortniteGame\\Saved\\Crashes\\UECC-Windows-ABC",
    time: Math.floor(Date.now() / 1000) - 3600,
    version: "19.40",
    title: "Crash in a third-party DLL",
    severity: "high",
    whatHappened: "Fortnite closed – the error came from an extra DLL that isn't part of Rift.",
    likelyCause: "The DLL \"console.dll\" doesn't match this Fortnite version or runs at the wrong moment.",
    whatToDo: ["Stop using this DLL together with Rift.", "Rift brings every DLL it needs."],
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
      { name: "Magnesium", author: "Ploosh, ralz, cipher", license: "BSD-3-Clause", url: "https://github.com/Ralzify/Magnesium", use: "Base of the game server (rift_server.dll)" },
      { name: "Erbium / ErbiumClient", author: "Ploosh", license: "GPL-3.0", url: "https://github.com/plooshi/Erbium", use: "Base of Magnesium; parts of the in-game menu" },
      { name: "Tellurium", author: "Ploosh", license: "BSD-3-Clause", url: "https://github.com/plooshi/Tellurium", use: "Base of the redirect (rift_redirect.dll)" },
      { name: "LawinServer", author: "Lawin0129", license: "GPL-3.0", url: "https://github.com/Lawin0129/LawinServer", use: "Base of the backend" },
      { name: "ATLAS Console", author: "cipherfps, ralz and contributors", license: "ATLAS Console Attribution License v1.0", url: "https://github.com/Ralzify/ATLAS-Client", use: "Base of the in-game menu (rift_client.dll) – Rift's menu is based on ATLAS Console" },
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

// ---- Build downloader: the catalog the browser preview shows (same shape and texts as Rust) ----

/** Card texts – the same as NOTE_NOT_FROM_EPIC / NOTE_NOT_OFFERED_YET in core/src/epic/catalog.rs. */
export const seasonNotes = {
  notFromEpic:
    "Epic has deleted part of the files for this season, so no download can get it complete. If you already have this version on your PC, it keeps working. Add it with 'Add a build'.",
  notOfferedYet: "Rift's game server isn't ready for this season yet, so it isn't offered.",
} as const;

const GB = 1e9;
const big = "Very big: about 100 GB on disk (Epic made builds smaller from 14.40 on).";
function demoBuild(version: string, cl: number, downloadGb: number, installedGb: number, note = ""): CatalogBuild {
  return {
    key: `${version}-CL-${cl}`,
    version,
    cl,
    downloadBytes: Math.round(downloadGb * GB),
    installedBytes: Math.round(installedGb * GB),
    badge: "experimental",
    note,
  };
}

/** [chapter, season, label, major, status when no build is offered, builds, one line about the season] */
type DemoSeason = [number, number, string, number, SeasonStatus, CatalogBuild[], string?];

/** Same builds, sizes and texts as launcher/core/data/build-catalog.json. */
const demoSeasons: DemoSeason[] = [
  ...Array.from({ length: 10 }, (_, i): DemoSeason => [1, i + 1, i === 9 ? "Season X" : `Season ${i + 1}`, i + 1, "notFromEpic", []]),
  [2, 1, "Season 1", 11, "notFromEpic", []],
  [2, 2, "Season 2", 12, "notFromEpic", []],
  [2, 3, "Season 3", 13, "available", [
    demoBuild("13.30", 13884634, 45.09, 97.16, "Very big: about 97 GB on disk (Epic made builds smaller from 14.40 on)."),
    demoBuild("13.40", 14008768, 46.09, 99.52, big),
    demoBuild("13.40", 14036559, 46.09, 99.52, big),
    demoBuild("13.40", 14113327, 46.09, 99.52, big),
  ]],
  [2, 4, "Season 4", 14, "notFromEpic", []],
  [2, 5, "Season 5", 15, "available", [demoBuild("15.00", 14826719, 32.72, 36.2), demoBuild("15.00", 14835335, 32.72, 36.2)]],
  [2, 6, "Season 6", 16, "available", [demoBuild("16.00", 15685441, 35.14, 38.85, "Has the Chapter 2 'bubble wrap' build look (Bubble Builds).")]],
  [2, 7, "Season 7", 17, "available", [demoBuild("17.21", 16949556, 38.38, 42.55), demoBuild("17.21", 16967001, 38.38, 42.55), demoBuild("17.50", 17388565, 40.3, 44.46)]],
  [2, 8, "Season 8", 18, "available", [
    demoBuild("18.00", 17468642, 40.06, 44.24),
    demoBuild("18.10", 17619277, 40.1, 44.28),
    demoBuild("18.10", 17661844, 40.1, 44.29),
    demoBuild("18.20", 17745267, 40.57, 44.81),
    demoBuild("18.20", 17792290, 40.57, 44.81),
    demoBuild("18.21", 17811397, 40.71, 44.96),
    demoBuild("18.30", 17882303, 41.1, 45.38),
  ]],
  [3, 1, "Season 1", 19, "notFromEpic", []],
  [3, 2, "Season 2", 20, "notFromEpic", []],
  [3, 3, "Season 3", 21, "available", [
    demoBuild("21.10", 20696680, 35.02, 38.54, "Darth Vader arrives as a boss with his Lightsaber."),
    demoBuild("21.20", 21035704, 35.56, 39.03, "Indiana Jones and Darth Vader in the Battle Pass; Charge SMG; Shuffled Shrines."),
    demoBuild("21.50", 21657658, 36.56, 40.12, "Last Chapter 3 Season 3 update: Dragon Ball Kamehameha and Nimbus Cloud still in the loot pool."),
  ], "Vibin': Reality Tree, Ballers, Darth Vader and Indiana Jones. Dragon Ball from 21.40."],
  [3, 4, "Season 4", 22, "available", [
    demoBuild("22.20", 22600409, 35.93, 39.51, "Fortnitemares 2022: Howler Claws (werewolf), Cube Monsters."),
    demoBuild("22.40", 23070899, 36.93, 40.64, "Last Chapter 3 update: Chrome, Spider-Gwen, Rocket League Octane, Grapple Glider."),
  ], "Paradise: Chrome, The Herald, Spider-Gwen. Fortnitemares 2022 in 22.20."],
  [4, 1, "Season 1", 23, "available", [
    demoBuild("23.40", 24087481, 46.32, 50.56, "Most Wanted: vault heists with exotic weapons; Doom Slayer and Geralt in the Battle Pass."),
    demoBuild("23.50", 24441668, 46.9, 51.16, "Last Chapter 4 Season 1 update: Cipher Quests, Six Shooter and Infantry Rifle."),
  ], "New Chapter 4 island, Reality Augments, Doom Slayer and Geralt. Most Wanted in 23.40."],
  [4, 2, "Season 2", 24, "available", [
    demoBuild("24.20", 25156858, 47.31, 51.79, "Attack on Titan: ODM Gear and Thunder Spears, Eren Jaeger in the Battle Pass."),
    demoBuild("24.30", 25347382, 38.45, 42.62, "Star Wars 'Find the Force': lightsabers and Force abilities."),
    demoBuild("24.40", 25595478, 62.54, 67.69, "Ranked arrives; last MEGA update."),
  ], "MEGA: Mega City, Kinetic Blade. Attack on Titan (24.20), Star Wars (24.30), Ranked (24.40)."],
  [4, 3, "Season 3", 25, "available", [
    demoBuild("25.11", 26171015, 64.13, 69.28, "WILDS jungle, raptors and Optimus Prime; Explosive Repeater Rifle."),
    demoBuild("25.20", 26629111, 64.4, 69.65, "Futurama: Bender's Shiny Metal Raygun."),
    demoBuild("25.30", 26867995, 64.36, 69.6, "Jujutsu Kaisen 'Break the Curse!': Hollow Purple and cursed techniques."),
  ], "WILDS: jungle, raptors, Optimus Prime. Futurama (25.20), Jujutsu Kaisen (25.30)."],
  [4, 4, "Season 4", 26, "available", [
    demoBuild("26.20", 28096793, 67.12, 72.53, "Fortnite's 6th birthday; Ahsoka Tano and the Jedi Training Lightsaber."),
    demoBuild("26.30", 28688692, 73.86, 79.26, "Fortnitemares 2023: Wood Stake Shotgun, Thorne's Vampiric Blade."),
  ], "Last Resort: heists, Kado Thorne, Ahsoka Tano. 6th birthday (26.20), Fortnitemares 2023 (26.30)."],
  [4, 5, "Season OG", 27, "available", [
    demoBuild("27.00", 29072304, 74.23, 79.61, "Fortnite OG: the Chapter 1 map as in Season 5."),
    demoBuild("27.10", 29552510, 77.87, 83.56, "Fortnite OG: Chapter 1 Seasons 7 and 8 (X-4 Stormwing, Pirate Cannon)."),
    demoBuild("27.11", 29739262, 81.54, 87.34, "Fortnite OG, last update: Chapter 1 Seasons 9 and X."),
  ], "The Chapter 1 map comes back: Season 5 (27.00), Seasons 7–8 (27.10), Seasons 9–X (27.11)."],
  [5, 1, "Season 1", 28, "available", [
    demoBuild("28.01", 30313795, 95.8, 102.92, "Very big: about 103 GB on disk. Winterfest 2023 on the Chapter 5 island; Peter Griffin in the Battle Pass."),
    demoBuild("28.20", 31286935, 96.79, 104.02, "Very big: about 104 GB on disk. Mid-season update from February 2024."),
    demoBuild("28.30", 31511038, 98.63, 106.09, "Very big: about 106 GB on disk. Last Chapter 5 Season 1 update: Society bosses, weapon mods, Solid Snake."),
  ], "Underground: new island, Society bosses, weapon mods, Peter Griffin. Winterfest 2023 in 28.01."],
  [5, 2, "Season 2", 29, "available", [
    demoBuild("29.00", 32116959, 101.33, 108.93, "Very big: about 109 GB on disk. Myths & Mortals: Zeus and Hades bosses, Thunderbolt of Zeus, Wings of Icarus."),
    demoBuild("29.20", 32716692, 105, 112.94, "Very big: about 113 GB on disk. Mid-season update from April 2024."),
    demoBuild("29.40", 33629566, 107.75, 116.2, "Very big: about 116 GB on disk. Last Chapter 5 Season 2 update: Star Wars crossover (Wookiee Bowcaster)."),
  ], "Myths & Mortals: Mount Olympus, Zeus and Hades bosses, Korra. Star Wars in 29.40."],
  [5, 3, "Season 3", 30, "available", [
    demoBuild("30.00", 33962396, 110.51, 118.78, "Very big: about 119 GB on disk. Wrecked: wasteland, Nitro, War Bus, Megalo Don; Fallout (Nuka-Cola, Power Armor)."),
    demoBuild("30.10", 34399867, 111.62, 119.77, "Very big: about 120 GB on disk. Metallica: M72 stage POI and Ride the Lightning."),
    demoBuild("30.40", 35235494, 107.81, 115.96, "Very big: about 116 GB on disk. Last Chapter 5 Season 3 update: Fall Guys event (Where We Fallin')."),
  ], "Wrecked: wasteland, Nitro cars, Megalo Don, Fallout and Magneto. Metallica (30.10), Fall Guys (30.40)."],
];

export const demoCatalog: Catalog = {
  checkedOn: "2026-10-26",
  chapters: [1, 2, 3, 4, 5].map((chapter) => ({
    chapter,
    label: `Chapter ${chapter}`,
    seasons: demoSeasons
      .filter(([c]) => c === chapter)
      .map(([, season, label, major, status, builds, about]): CatalogSeason => {
        const st: SeasonStatus = builds.length > 0 ? "available" : status === "available" ? "notOfferedYet" : status;
        return {
          season,
          label,
          versions: `${major}.x`,
          status: st,
          note: st === "available" ? "" : seasonNotes[st],
          about: about ?? "",
          builds,
        };
      }),
  })),
};
