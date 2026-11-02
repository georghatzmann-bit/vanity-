// Fresh-start packages (no backup): Basic / Premium / Gaming.
// Apps are catalog ids (filtered against the catalog at runtime), prefs use the ids of
// src/main/settings/prefs.js, games use the GameEntry format of the profile.

const BASIC_PREFS = { theme: 'dark', fileExt: true, taskbarSearch: 'icon', taskView: false, widgets: false, gameMode: true };
const PREMIUM_PREFS = { ...BASIC_PREFS, hiddenFiles: true, openThisPc: true, mouseAccel: false, stickyKeys: false, gameDvr: false, power: 'high' };
const GAMING_PREFS = { ...PREMIUM_PREFS, power: 'ultimate' };

const RUNTIMES = ['Microsoft.VCRedist.2015+.x64', 'Microsoft.VCRedist.2015+.x86', 'Microsoft.DirectX', 'Microsoft.DotNet.DesktopRuntime.8'];
const ESSENTIALS = ['Google.Chrome', '7zip.7zip', 'VideoLAN.VLC', 'Discord.Discord', 'Spotify.Spotify', 'Microsoft.PowerToys'];
const GAMING_APPS = ['Valve.Steam', 'EpicGames.EpicGamesLauncher', 'OBSProject.OBSStudio', 'Guru3D.Afterburner', 'REALiX.HWiNFO'];

export const PACKAGES = [
  {
    id: 'basic',
    name: 'Basic',
    icon: 'monitor',
    tagline: 'Windows sauber eingerichtet',
    points: ['Monitore: Hauptmonitor, beste Hz, Auflösung, Drehung', 'Dunkelmodus, aufgeräumte Taskleiste', 'Dateiendungen sichtbar, Spielmodus an'],
    prefs: BASIC_PREFS,
    apps: [],
    extras: [],
  },
  {
    id: 'premium',
    name: 'Premium',
    icon: 'sparkles',
    tagline: 'Alles, was ein PC braucht',
    points: ['Alles aus Basic', 'Chrome, Discord, Spotify, 7-Zip, VLC, PowerToys + Laufzeiten', 'Profi-Einstellungen: Höchstleistung, Maus ohne Beschleunigung, keine Hintergrundaufnahme', 'Erkennt deine Grafikkarte und zeigt den passenden Treiber', 'VELOX Tweaker'],
    prefs: PREMIUM_PREFS,
    apps: [...RUNTIMES, ...ESSENTIALS],
    extras: ['velox'],
  },
  {
    id: 'gaming',
    name: 'Gaming',
    icon: 'gamepad',
    tagline: 'Fertig zum Zocken',
    points: ['Alles aus Premium', 'Steam, Epic Games, OBS, Afterburner, HWiNFO', 'Ultimative Leistung', 'Du wählst deine Spiele – sie werden gleich mit installiert', 'VELOX Tweaker'],
    prefs: GAMING_PREFS,
    apps: [...RUNTIMES, ...ESSENTIALS, ...GAMING_APPS],
    extras: ['velox'],
    games: true,
  },
];

// winget games are apps; launcher games are GameEntries (the launcher gets added automatically)
export const GAME_OPTIONS = [
  { key: 'fortnite', title: 'Fortnite', game: { platform: 'epic', title: 'Fortnite', appName: 'Fortnite' } },
  { key: 'valorant', title: 'Valorant', app: 'RiotGames.Valorant.EU' },
  { key: 'cs2', title: 'Counter-Strike 2', game: { platform: 'steam', title: 'Counter-Strike 2', appId: 730 } },
  { key: 'rl', title: 'Rocket League', game: { platform: 'epic', title: 'Rocket League', appName: 'Sugar' } },
  { key: 'apex', title: 'Apex Legends', game: { platform: 'steam', title: 'Apex Legends', appId: 1172470 } },
  { key: 'lol', title: 'League of Legends', app: 'RiotGames.LeagueOfLegends.EUW' },
  { key: 'rivals', title: 'Marvel Rivals', game: { platform: 'steam', title: 'Marvel Rivals', appId: 2767030 } },
  { key: 'cod', title: 'Call of Duty (Warzone)', game: { platform: 'steam', title: 'Call of Duty', appId: 1938090 } },
  { key: 'ow2', title: 'Overwatch 2', game: { platform: 'steam', title: 'Overwatch 2', appId: 2357570 } },
  { key: 'finals', title: 'The Finals', game: { platform: 'steam', title: 'The Finals', appId: 2073850 } },
  { key: 'pubg', title: 'PUBG', game: { platform: 'steam', title: 'PUBG: BATTLEGROUNDS', appId: 578080 } },
  { key: 'dota', title: 'Dota 2', game: { platform: 'steam', title: 'Dota 2', appId: 570 } },
  { key: 'minecraft', title: 'Minecraft', app: 'Mojang.MinecraftLauncher' },
];

export const GPU_DRIVERS = {
  nvidia: { name: 'NVIDIA App', url: 'https://www.nvidia.com/de-de/software/nvidia-app/' },
  amd: { name: 'AMD Software: Adrenalin', url: 'https://www.amd.com/de/support/download/drivers.html' },
  intel: { name: 'Intel Treiber-Assistent', url: 'https://www.intel.de/content/www/de/de/support/detect.html' },
};

/** Package + chosen games -> a profile the normal select/install flow understands. */
export function buildPackageProfile(pkg, gameKeys, catalogItems, machine) {
  const byId = new Map((catalogItems || []).map((i) => [i.id, i]));
  const ids = new Set(pkg.apps);
  const games = [];
  for (const opt of GAME_OPTIONS) {
    if (!gameKeys.has(opt.key)) continue;
    if (opt.app) ids.add(opt.app);
    if (opt.game) {
      games.push(opt.game);
      ids.add(opt.game.platform === 'epic' ? 'EpicGames.EpicGamesLauncher' : 'Valve.Steam');
    }
  }
  const apps = [...ids]
    .map((id) => byId.get(id))
    .filter((c) => c && (c.source === 'winget' || c.source === 'msstore'))
    .map((c) => ({ id: c.id, source: c.source, name: c.name, category: c.category, elevation: c.elevation }));
  return {
    format: 'phoenix-profile',
    version: 1,
    createdAt: new Date().toISOString(),
    package: pkg.id,
    machine: { ...(machine || {}), hostname: `Paket ${pkg.name}` },
    apps,
    games,
    unmatched: [],
    settings: { displays: [], prefs: { ...pkg.prefs }, dpi: [] },
    extras: [...pkg.extras],
  };
}
