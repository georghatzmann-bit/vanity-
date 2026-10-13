/**
 * Demo-Backend für den Browser (Vorschau, Screenshots, Tests).
 * Bildet die Rust-Befehle mit Beispieldaten nach. In der echten App wird es nie geladen.
 */
import type { Collection, Game, GameImages, ImageKind, LaunchConfig, PlayStats, Session, WishItem, ScannedEntry, Profile, Screenshot } from "./types";
import { DEMO_ART } from "./demo-art";

type Handler = (p: unknown) => void;
const listeners = new Map<string, Set<Handler>>();
const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => h(payload));

/** Erzeugte Beispiel-Screenshots (Landschaften als SVG), damit die Galerie in der Vorschau nicht leer ist */
function demoScreenshots(gameId: string): Screenshot[] {
  const palettes = [
    ["#1b1036", "#f97362", "#ffd29d"],
    ["#06142e", "#2f80ed", "#a8e6ff"],
    ["#140a1f", "#d946ef", "#fbcfe8"],
    ["#0b1d13", "#22c55e", "#d9f99d"],
    ["#1f0f08", "#f59e0b", "#fde68a"],
    ["#0d0d1a", "#8b5cf6", "#c4b5fd"],
  ];
  let seed = [...gameId].reduce((n, c) => n + c.charCodeAt(0), 0);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  return palettes.map(([sky, mid, sun], i) => {
    const hills = [0.62, 0.72, 0.84]
      .map((h, k) => {
        const pts = Array.from({ length: 9 }, (_, j) => `${j * 200},${Math.round(900 * (h + (rnd() - 0.5) * 0.12))}`).join(" ");
        return `<polygon points="0,900 ${pts} 1600,900" fill="${mid}" opacity="${0.35 + k * 0.3}"/>`;
      })
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${mid}"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="${300 + Math.round(rnd() * 1000)}" cy="${220 + Math.round(rnd() * 160)}" r="110" fill="${sun}" opacity="0.9"/>${hills}</svg>`;
    return {
      path: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      takenAt: Date.now() - (i * 3 + 1) * 86_400_000 - Math.round(rnd() * 40_000_000),
      source: i % 3 === 0 ? "gamebar" : "steam",
    };
  });
}

export function mockListen(event: string, handler: Handler): () => void {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}

const DAY = 86400000;
const now = Date.now();
let seed = 1337;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const demo: Array<[string, "game" | "app", Game["source"], string?, string?, string[]?]> = [
  ["Elden Ring", "game", "steam", "1245620", "Action-RPG", ["Souls-like", "Open World"]],
  ["Cyberpunk 2077", "game", "gog", "1423049311", "RPG", ["Open World", "Story"]],
  ["Hades II", "game", "steam", "1145350", "Roguelike", ["Action", "Kurz & knackig"]],
  ["Stardew Valley", "game", "steam", "413150", "Simulation", ["Entspannt", "Mit Freunden"]],
  ["Forza Horizon 5", "game", "steam", "1551360", "Rennspiel", ["Rennspiele", "Mit Freunden"]],
  ["Baldur's Gate 3", "game", "steam", "1086940", "RPG", ["Story", "Mit Freunden"]],
  ["Hollow Knight: Silksong", "game", "steam", "1030300", "Metroidvania", ["Action"]],
  ["Alan Wake 2", "game", "epic", "alan-wake-2", "Horror", ["Story"]],
  ["Rocket League", "game", "epic", "sugar", "Sport", ["Mit Freunden", "Kurz & knackig"]],
  ["The Witcher 3: Wild Hunt", "game", "gog", "1207664643", "RPG", ["Story", "Open World", "Durchgespielt"]],
  ["Portal 2", "game", "steam", "620", "Puzzle", ["Knobeln", "Durchgespielt"]],
  ["Celeste", "game", "steam", "504230", "Plattformer", ["Kurz & knackig"]],
  ["Disco Elysium", "game", "gog", "1771589310", "RPG", ["Story"]],
  ["Counter-Strike 2", "game", "steam", "730", "Shooter", ["Mit Freunden", "Action"]],
  ["Minecraft", "game", "startmenu", undefined, "Sandbox", ["Mit Freunden", "Entspannt"]],
  ["Red Dead Redemption 2", "game", "steam", "1174180", "Action-Adventure", ["Open World", "Story"]],
  ["Outer Wilds", "game", "steam", "753640", "Abenteuer", ["Knobeln", "Story"]],
  ["Factorio", "game", "steam", "427520", "Strategie", ["Knobeln"]],
  ["Sea of Thieves", "game", "steam", "1172620", "Abenteuer", ["Mit Freunden"]],
  ["Balatro", "game", "steam", "2379780", "Kartenspiel", ["Kurz & knackig", "Entspannt"]],
  ["Death Stranding", "game", "epic", "death-stranding", "Action", ["Story"]],
  ["Ori and the Will of the Wisps", "game", "steam", "1057090", "Plattformer", ["Story", "Durchgespielt"]],
  ["It Takes Two", "game", "steam", "1426210", "Koop", ["Mit Freunden", "Durchgespielt"]],
  ["Satisfactory", "game", "epic", "satisfactory", "Simulation", ["Knobeln", "Mit Freunden"]],
  ["OBS Studio", "app", "startmenu", undefined, undefined, []],
  ["Wallpaper Engine", "app", "startmenu", undefined, undefined, []],
  ["Blender", "app", "startmenu", undefined, undefined, []],
  ["Krita", "app", "startmenu", undefined, undefined, []],
  ["Aseprite", "app", "startmenu", undefined, undefined, []],
];

/** Echte Bilder für die Vorschau – Programme zeigen (wie in der echten App) ihr Icon */
function demoImages(name: string, kind: "game" | "app", kinds: ImageKind[] = ["cover", "hero", "logo", "icon"]): GameImages {
  const art = DEMO_ART[name] ?? {};
  const allowed = kind === "app" ? kinds.filter((k) => k === "icon") : kinds;
  return Object.fromEntries(allowed.filter((k) => art[k]).map((k) => [k, art[k]]));
}

function makeGames(): Game[] {
  return demo.map(([name, kind, source, sourceId, genre, tags], i) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const launch: LaunchConfig =
      source === "steam" && sourceId
        ? { type: "url", target: `steam://rungameid/${sourceId}` }
        : { type: "exe", target: `C:\\Games\\${name}\\${slug}.exe` };
    const status = (["playing", "want", "done", "none", "paused"] as const)[i % 5];
    return {
      id: `demo-${slug}`,
      name,
      kind,
      source,
      sourceId,
      launch,
      installDir: `C:\\Games\\${name}`,
      exePath: launch.type === "exe" ? launch.target : undefined,
      images: demoImages(name, kind),
      imagesCheckedAt: now,
      favorite: [0, 2, 3, 5, 10, 24].includes(i),
      hidden: false,
      status: kind === "app" ? "none" : tags?.includes("Durchgespielt") ? "done" : status,
      rating: kind === "app" ? 0 : [5, 4.5, 5, 4, 4.5, 5, 0, 4, 3.5, 5, 5, 4.5, 4, 3, 4, 5, 4.5, 4, 3.5, 4.5, 3, 4, 5, 4][i] ?? 0,
      notes: i === 0 ? "Malenia endlich geschafft! Als Nächstes: Schattenreich." : "",
      genre,
      tags: tags ?? [],
      collectionIds: i < 6 ? ["demo-col-fav"] : tags?.includes("Mit Freunden") ? ["demo-col-friends"] : [],
      links: { tools: [] },
      inDock: kind === "app" || [0, 3].includes(i),
      addedAt: now - (40 - i) * DAY * 2.2,
      updatedAt: now - i * DAY,
    } satisfies Game;
  });
}

function makeSessions(games: Game[]): Session[] {
  const out: Session[] = [];
  let id = 1;
  const playable = games.filter((g) => g.kind === "game");
  const weights = playable.map((_, i) => 1 / (1 + i * 0.35));
  const total = weights.reduce((a, b) => a + b, 0);
  for (let d = 200; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY);
    dayStart.setHours(0, 0, 0, 0);
    const weekend = [0, 6].includes(dayStart.getDay());
    if (rand() < (weekend ? 0.18 : 0.38) && d > 1) continue;
    const count = 1 + Math.floor(rand() * (weekend ? 3 : 2));
    for (let k = 0; k < count; k++) {
      let r = rand() * total;
      let gi = 0;
      while (r > weights[gi] && gi < weights.length - 1) r -= weights[gi++];
      const hour = weekend ? 11 + Math.floor(rand() * 13) : 17 + Math.floor(rand() * 7);
      const start = dayStart.getTime() + hour * 3600000 + Math.floor(rand() * 3600000);
      const seconds = Math.floor((weekend ? 3600 : 1800) * (0.4 + rand() * 2.4));
      if (start + seconds * 1000 > now) continue;
      out.push({ id: id++, gameId: playable[gi].id, start, end: start + seconds * 1000, seconds });
    }
  }
  return out;
}

interface MockDb {
  games: Game[];
  collections: Collection[];
  wishlist: WishItem[];
  sessions: Session[];
  kv: Record<string, unknown>;
  profiles: Profile[];
  activeProfile: string;
}

const STORE_KEY = "nova-mock-db-v2";

function freshDb(): MockDb {
  const games = makeGames();
  return {
    games,
    collections: [
      { id: "demo-col-fav", name: "Allzeit-Lieblinge", icon: "Heart", color: "#ff4f8b", createdAt: now - 30 * DAY, order: 0 },
      { id: "demo-col-friends", name: "Mit Freunden", icon: "Users", color: "#8b5cf6", createdAt: now - 20 * DAY, order: 1 },
      { id: "demo-col-race", name: "Rennspiele", icon: "Flag", color: "#ff8a4c", createdAt: now - 10 * DAY, order: 2 },
    ],
    wishlist: [
      { id: "w1", name: "Grand Theft Auto VI", price: "79,99 €", targetPrice: "49,99 €", store: "Steam", priority: 1, addedAt: now - 9 * DAY },
      { id: "w2", name: "Clair Obscur: Expedition 33", price: "49,99 €", targetPrice: "34,99 €", store: "Steam", priority: 2, addedAt: now - 3 * DAY },
      { id: "w3", name: "Hollow Knight: Silksong DLC", price: "14,99 €", priority: 3, addedAt: now - DAY, note: "Mit Lisa zusammen?" },
    ],
    sessions: makeSessions(games),
    kv: {},
    profiles: [
      { id: "default", name: "Georg", color: "#ff4f8b", avatar: "G", createdAt: now - 100 * DAY },
      { id: "p2", name: "Gast", color: "#8b5cf6", avatar: "🎮", createdAt: now - 10 * DAY },
    ],
    activeProfile: "default",
  };
}

function loadDb(): MockDb {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as MockDb;
  } catch {
    /* Demo: neu erzeugen */
  }
  return freshDb();
}

const db: MockDb = typeof window !== "undefined" ? loadDb() : freshDb();
let saveTimer: number | undefined;
const persist = () => {
  if (typeof window === "undefined") return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch {
      /* Speicher voll - egal in der Demo */
    }
  }, 300);
};

const running = new Map<string, { startedAt: number }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stats(): PlayStats[] {
  const map = new Map<string, PlayStats>();
  const sorted = [...db.sessions].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    const st = map.get(s.gameId) ?? { gameId: s.gameId, totalSeconds: 0, sessions: 0 };
    st.totalSeconds += s.seconds;
    st.sessions += 1;
    st.lastPlayedAt = s.end;
    st.lastSessionSeconds = s.seconds;
    st.firstPlayedAt ??= s.start;
    map.set(s.gameId, st);
  }
  return [...map.values()];
}

function table(name: string): { id: string }[] {
  if (name === "games") return db.games;
  if (name === "collections") return db.collections;
  if (name === "wishlist") return db.wishlist;
  throw new Error(`Unbekannte Tabelle: ${name}`);
}

const fakeScan: ScannedEntry[] = [
  { name: "Cities: Skylines II", kind: "game", source: "steam", sourceId: "949230", launch: { type: "url", target: "steam://rungameid/949230" } },
  { name: "Lethal Company", kind: "game", source: "steam", sourceId: "1966720", launch: { type: "url", target: "steam://rungameid/1966720" } },
  { name: "Fortnite", kind: "game", source: "epic", sourceId: "Fortnite", launch: { type: "url", target: "com.epicgames.launcher://apps/Fortnite?action=launch" } },
  { name: "Elden Ring", kind: "game", source: "steam", sourceId: "1245620", launch: { type: "url", target: "steam://rungameid/1245620" } },
  { name: "GIMP", kind: "app", source: "startmenu", launch: { type: "shell", target: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\GIMP.lnk" } },
  { name: "Notepad++", kind: "app", source: "startmenu", launch: { type: "shell", target: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Notepad++.lnk" } },
];

export async function mockInvoke<T>(cmd: string, a: Record<string, unknown>): Promise<T> {
  await sleep(cmd === "scan_library" ? 1400 : 25);
  const r = (v: unknown) => v as T;
  switch (cmd) {
    case "app_info":
      return r({ version: "1.0.0", dataDir: "C:\\Users\\Demo\\AppData\\Roaming\\com.nova.launcher", cacheDir: "", profileId: db.activeProfile, platform: "browser", startedMinimized: false });
    case "quit_app":
      return r(undefined);
    case "profiles_list":
      return r({ profiles: db.profiles, activeId: db.activeProfile });
    case "profile_create": {
      const p: Profile = { id: `p${Date.now()}`, name: String(a.name), color: String(a.color), avatar: a.avatar as string | undefined, createdAt: Date.now() };
      db.profiles.push(p);
      persist();
      return r(p);
    }
    case "profile_update": {
      const p = a.profile as Profile;
      db.profiles = db.profiles.map((x) => (x.id === p.id ? p : x));
      persist();
      return r(undefined);
    }
    case "profile_delete":
      db.profiles = db.profiles.filter((x) => x.id !== a.id);
      persist();
      return r(undefined);
    case "profile_switch":
      db.activeProfile = String(a.id);
      persist();
      return r(undefined);
    case "db_list":
      return r(structuredClone(table(String(a.table))));
    case "db_put": {
      const tb = table(String(a.table));
      const i = tb.findIndex((x) => x.id === a.id);
      if (i >= 0) tb[i] = a.value as { id: string };
      else tb.push(a.value as { id: string });
      persist();
      return r(undefined);
    }
    case "db_put_many": {
      const tb = table(String(a.table));
      for (const it of a.items as { id: string; value: { id: string } }[]) {
        const i = tb.findIndex((x) => x.id === it.id);
        if (i >= 0) tb[i] = it.value;
        else tb.push(it.value);
      }
      persist();
      return r(undefined);
    }
    case "db_delete": {
      const name = String(a.table);
      if (name === "games") {
        db.games = db.games.filter((x) => x.id !== a.id);
        db.sessions = db.sessions.filter((s) => s.gameId !== a.id);
      } else if (name === "collections") db.collections = db.collections.filter((x) => x.id !== a.id);
      else if (name === "wishlist") db.wishlist = db.wishlist.filter((x) => x.id !== a.id);
      persist();
      return r(undefined);
    }
    case "games_merge": {
      const keep = String(a.keepId);
      const remove = new Set((a.removeIds as string[]).filter((id) => id !== keep));
      let moved = 0;
      db.sessions.forEach((s) => {
        if (remove.has(s.gameId)) {
          s.gameId = keep;
          moved++;
        }
      });
      db.games = db.games.filter((x) => !remove.has(x.id));
      persist();
      return r(moved);
    }
    case "kv_get":
      return r(db.kv[String(a.key)] ?? null);
    case "kv_set":
      db.kv[String(a.key)] = a.value;
      persist();
      return r(undefined);
    case "playtime_stats":
      return r(stats());
    case "sessions_range":
      return r(db.sessions.filter((s) => s.start >= Number(a.from) && s.start < Number(a.to)));
    case "sessions_for_game":
      return r(
        db.sessions
          .filter((s) => s.gameId === a.gameId)
          .sort((x, y) => y.start - x.start)
          .slice(0, Number(a.limit ?? 50)),
      );
    case "session_delete":
      db.sessions = db.sessions.filter((s) => s.id !== a.id);
      persist();
      return r(undefined);
    case "playtime_add": {
      const at = Number(a.at);
      const s: Session = { id: Date.now(), gameId: String(a.gameId), start: at, end: at + Number(a.seconds) * 1000, seconds: Number(a.seconds) };
      db.sessions.push(s);
      persist();
      return r(s);
    }
    case "scan_library":
      return r({ entries: fakeScan, messages: ["Demo-Modus: Es werden Beispiel-Funde angezeigt."] });
    case "inspect_paths":
      return r(
        (a.paths as string[]).map((p) => ({
          name: p.split(/[\\/]/).pop()?.replace(/\.(exe|lnk|url)$/i, "") ?? p,
          kind: "app",
          source: "manual",
          launch: { type: "exe", target: p },
          exePath: p,
        })),
      );
    case "paths_exist":
      return r((a.paths as string[]).map((p) => !p.includes("Satisfactory")));
    case "set_tracked_games":
      return r(undefined);
    case "launch_game": {
      const id = String(a.gameId);
      setTimeout(() => {
        const startedAt = Date.now();
        running.set(id, { startedAt });
        emit("game://started", { gameId: id, startedAt });
      }, 1200);
      return r(undefined);
    }
    case "stop_game": {
      const id = String(a.gameId);
      const run = running.get(id);
      if (run) {
        running.delete(id);
        const end = Date.now();
        const seconds = Math.max(1, Math.round((end - run.startedAt) / 1000));
        const s: Session = { id: Date.now(), gameId: id, start: run.startedAt, end, seconds };
        db.sessions.push(s);
        persist();
        setTimeout(() => emit("game://stopped", { gameId: id, session: s }), 300);
      }
      return r(run ? 1 : 0);
    }
    case "running_games":
      return r([...running.entries()].map(([gameId, v]) => ({ gameId, startedAt: v.startedAt, pids: [4242] })));
    case "launch_tool":
    case "open_path":
    case "reveal_path":
    case "open_url":
      return r(undefined);
    case "images_fetch": {
      const req = a.request as { name: string; kinds: ImageKind[] };
      const images = demoImages(req.name, "game", req.kinds);
      return Object.keys(images).length
        ? r({ images, source: "steam", messages: [] })
        : r({ images: {}, source: "none", messages: ["Demo-Modus: für dieses Spiel gibt es keine Beispielbilder."] });
    }
    case "sgdb_search":
      return r([]);
    case "sgdb_images":
      return r([]);
    case "image_download":
    case "image_set_custom":
      return r({ path: "" });
    case "image_palette":
      return r({ primary: "#ff4f8b", secondary: "#8b5cf6", dark: "#140a14" });
    case "exe_icon":
      return r(null);
    case "cache_size":
      return r(48_300_000);
    case "cache_clear":
      return r(48_300_000);
    case "system_stats": {
      const t = Date.now() / 1000;
      return r({
        cpu: 18 + 14 * Math.sin(t / 3) + rand() * 6,
        ramUsed: 11.2e9 + Math.sin(t / 7) * 0.6e9,
        ramTotal: 32e9,
        gpu: 32 + 20 * Math.sin(t / 4) + rand() * 5,
        cpuName: "AMD Ryzen 7 7800X3D",
        gpuName: "NVIDIA GeForce RTX 4070",
        uptimeSeconds: 3 * 3600 + 1200,
      });
    }
    case "weather":
      return r({ temperature: 14.2, apparent: 12.8, code: 2, isDay: true, wind: 11, high: 17, low: 8, place: String(a.place || "Wien") });
    case "geocode":
      return r([
        { name: "Wien", country: "Österreich", admin: "Wien", lat: 48.2085, lon: 16.3721 },
        { name: "Berlin", country: "Deutschland", admin: "Berlin", lat: 52.52, lon: 13.405 },
      ]);
    case "screenshots_list":
      return r(demoScreenshots(String(a.gameId ?? "")));
    case "thumbnail":
      return r(String(a.path));
    case "save_backup_create":
      return r({ id: `${Date.now()}.zip`, gameId: a.gameId, path: "", createdAt: Date.now(), size: 4_200_000 });
    case "save_backup_list":
      return r([]);
    case "save_backup_restore":
    case "save_backup_delete":
    case "library_export":
    case "backup_restore":
      return r(undefined);
    case "library_import":
      return r({ games: 0, collections: 0, wishlist: 0, sessions: 0 });
    case "backups_list":
      return r([
        { file: "nova-20261011-090000.db", path: "", createdAt: now - DAY, size: 1_240_000 },
        { file: "nova-20261010-090000.db", path: "", createdAt: now - 2 * DAY, size: 1_190_000 },
      ]);
    case "backup_now":
      return r({ file: "nova-now.db", path: "", createdAt: Date.now(), size: 1_250_000 });
    case "apply_native_settings":
    case "tray_set_recent":
      return r(undefined);
    case "overlay_toggle":
      return r(false);
    case "update_check":
      return r({ available: false, current: "1.0.0", latest: "1.0.0" });
    case "update_install":
      return r(undefined);
    default:
      throw new Error(`Demo: Befehl „${cmd}“ ist nicht verfügbar.`);
  }
}

/** Für Tests: Demo-Daten zurücksetzen */
export function resetMock() {
  Object.assign(db, freshDb());
  persist();
}
