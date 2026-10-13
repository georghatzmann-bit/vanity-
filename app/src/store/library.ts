import { create } from "zustand";
import { api, errorText, listen } from "@/lib/api";
import { emptyCounters, evaluate, type Counters } from "@/lib/achievements";
import { normalizeGame, uid } from "@/lib/defaults";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/i18n";
import type {
  Collection,
  Game,
  GameStartedEvent,
  GameStoppedEvent,
  ImageKind,
  PlayStats,
  RunningGame,
  ScannedEntry,
  Session,
  UnlockedAchievement,
  WishItem,
} from "@/lib/types";
import { useSettings } from "./settings";
import { toast, useUI } from "./ui";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

const YEAR = 400 * 86400000;

interface LibraryState {
  games: Game[];
  collections: Collection[];
  wishlist: WishItem[];
  stats: Map<string, PlayStats>;
  /** Sitzungen der letzten ~13 Monate (für Statistik und Erfolge) */
  sessions: Session[];
  running: Map<string, RunningGame>;
  launching: Set<string>;
  counters: Counters;
  unlocked: UnlockedAchievement[];
  loaded: boolean;
  imageQueue: Set<string>;

  load: () => Promise<void>;
  reload: () => Promise<void>;
  refreshStats: () => Promise<void>;

  addEntries: (entries: ScannedEntry[]) => Promise<Game[]>;
  updateGame: (id: string, patch: Partial<Game>) => void;
  removeGame: (id: string) => Promise<void>;
  removeGames: (ids: string[]) => Promise<void>;
  /** Doppelte zusammenführen: Spielzeit, Sammlungen, Tags usw. gehen auf den behaltenen Eintrag über */
  mergeGames: (keepId: string, removeIds: string[]) => Promise<void>;

  launch: (game: Game) => Promise<void>;
  stop: (gameId: string) => Promise<void>;

  fetchImages: (games: Game[], opts?: { force?: boolean; kinds?: ImageKind[]; quiet?: boolean }) => Promise<number>;

  saveCollection: (c: Partial<Collection> & { name: string }) => Promise<Collection>;
  deleteCollection: (id: string) => Promise<void>;
  toggleInCollection: (gameId: string, collectionId: string) => void;

  saveWish: (w: Partial<WishItem> & { name: string }) => Promise<WishItem>;
  deleteWish: (id: string) => Promise<void>;

  bump: (key: keyof Counters, by?: number) => void;
  checkAchievements: () => void;
}

let unlisteners: Array<() => void> = [];
let trackTimer: number | undefined;

/** Dem Backend mitteilen, welche Spiele überwacht werden sollen (Spielzeit-Erkennung) */
function syncTracking(games: Game[]) {
  window.clearTimeout(trackTimer);
  trackTimer = window.setTimeout(() => {
    const tracked = games
      .filter((g) => g.kind === "game")
      .map((g) => ({ gameId: g.id, name: g.name, installDir: g.installDir, exePath: g.exePath, processNames: g.processNames }));
    void api.setTrackedGames(tracked).catch((e) => console.warn("Tracking:", e));
  }, 400);
}

function syncTray(games: Game[], stats: Map<string, PlayStats>) {
  const recent = games
    .filter((g) => stats.get(g.id)?.lastPlayedAt)
    .sort((a, b) => (stats.get(b.id)?.lastPlayedAt ?? 0) - (stats.get(a.id)?.lastPlayedAt ?? 0))
    .slice(0, 6)
    .map((g) => ({ id: g.id, name: g.name }));
  void api.traySetRecent(recent).catch(() => undefined);
}

function persistGame(g: Game) {
  void api.dbPut("games", g.id, g).catch((e) => toast({ kind: "error", title: t("toast.error"), text: errorText(e) }));
}

export const useLibrary = create<LibraryState>((set, get) => ({
  games: [],
  collections: [],
  wishlist: [],
  stats: new Map(),
  sessions: [],
  running: new Map(),
  launching: new Set(),
  counters: emptyCounters(),
  unlocked: [],
  loaded: false,
  imageQueue: new Set(),

  load: async () => {
    await get().reload();
    // Backend-Events nur einmal abonnieren
    unlisteners.forEach((u) => u());
    unlisteners = [];
    unlisteners.push(
      await listen<GameStartedEvent>("game://started", ({ gameId, startedAt }) => {
        const running = new Map(get().running);
        running.set(gameId, { gameId, startedAt, pids: [] });
        const launching = new Set(get().launching);
        launching.delete(gameId);
        set({ running, launching });
        const g = get().games.find((x) => x.id === gameId);
        if (g) toast({ kind: "game", title: t("toast.gameStarted", { name: g.name }) });
      }),
      await listen<GameStoppedEvent>("game://stopped", ({ gameId, session }) => {
        const running = new Map(get().running);
        running.delete(gameId);
        const stats = new Map(get().stats);
        const prev = stats.get(gameId) ?? { gameId, totalSeconds: 0, sessions: 0 };
        if (session && session.seconds > 0) {
          stats.set(gameId, {
            ...prev,
            totalSeconds: prev.totalSeconds + session.seconds,
            sessions: prev.sessions + 1,
            lastPlayedAt: session.end,
            lastSessionSeconds: session.seconds,
            firstPlayedAt: prev.firstPlayedAt ?? session.start,
          });
        }
        set({ running, stats, sessions: session && session.seconds > 0 ? [...get().sessions, session] : get().sessions });
        const g = get().games.find((x) => x.id === gameId);
        if (g && session) toast({ kind: "info", title: t("game.stopped", { name: g.name, time: formatDuration(session.seconds) }) });
        syncTray(get().games, stats);
        get().checkAchievements();
      }),
      await listen<{ gameId: string }>("tray://launch", ({ gameId }) => {
        const g = get().games.find((x) => x.id === gameId);
        if (g) void get().launch(g);
      }),
    );
    // Läuft schon etwas (z. B. nach Neustart von NOVA)?
    try {
      const running = await api.runningGames();
      set({ running: new Map(running.map((r) => [r.gameId, r])) });
    } catch {
      /* egal */
    }
  },

  reload: async () => {
    try {
      const [rawGames, collections, wishlist, statsList, sessions, counters, unlocked] = await Promise.all([
        api.games(),
        api.collections(),
        api.wishlist(),
        api.playtimeStats(),
        api.sessionsRange(Date.now() - YEAR, Date.now() + 86400000),
        api.kvGet<Counters>("counters"),
        api.kvGet<UnlockedAchievement[]>("achievements"),
      ]);
      const games = (rawGames ?? []).filter((g) => g && typeof g.id === "string").map(normalizeGame);
      const stats = new Map((statsList ?? []).map((s) => [s.gameId, s]));
      set({
        games,
        collections: (collections ?? []).sort((a, b) => a.order - b.order),
        wishlist: wishlist ?? [],
        stats,
        sessions: sessions ?? [],
        counters: { ...emptyCounters(), ...(counters ?? {}) },
        unlocked: Array.isArray(unlocked) ? unlocked : [],
        loaded: true,
      });
      syncTracking(games);
      syncTray(games, stats);
      // Erfolge leise nachziehen (ohne Pop-up-Flut beim ersten Start)
      const done = evaluate({ games, stats, sessions: sessions ?? [], collections: collections ?? [], wishlist: wishlist ?? [], counters: get().counters });
      const known = new Set(get().unlocked.map((u) => u.id));
      const fresh = [...done].filter((id) => !known.has(id));
      if (fresh.length) {
        const all = [...get().unlocked, ...fresh.map((id) => ({ id, unlockedAt: Date.now() }))];
        set({ unlocked: all });
        void api.kvSet("achievements", all).catch(() => undefined);
        if (known.size > 0) useUI.getState().pushAchievements(fresh.slice(0, 3));
      }
    } catch (e) {
      set({ loaded: true });
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  },

  refreshStats: async () => {
    try {
      const [statsList, sessions] = await Promise.all([api.playtimeStats(), api.sessionsRange(Date.now() - YEAR, Date.now() + 86400000)]);
      set({ stats: new Map(statsList.map((s) => [s.gameId, s])), sessions });
    } catch (e) {
      console.warn("Statistik:", e);
    }
  },

  addEntries: async (entries) => {
    const now = Date.now();
    const created: Game[] = entries.map((e, i) =>
      normalizeGame({
        id: uid(e.kind === "app" ? "app" : "game"),
        name: e.name,
        kind: e.kind,
        source: e.source,
        sourceId: e.sourceId,
        launch: e.launch,
        installDir: e.installDir,
        exePath: e.exePath,
        addedAt: now + i,
        updatedAt: now,
        inDock: false,
      }),
    );
    if (!created.length) return [];
    await api.dbPutMany(
      "games",
      created.map((g) => ({ id: g.id, value: g })),
    );
    const games = [...get().games, ...created];
    set({ games });
    syncTracking(games);
    get().checkAchievements();
    // Bilder im Hintergrund laden
    void get().fetchImages(created, { quiet: true });
    return created;
  },

  updateGame: (id, patch) => {
    let updated: Game | undefined;
    const games = get().games.map((g) => {
      if (g.id !== id) return g;
      updated = { ...g, ...patch, updatedAt: Date.now() };
      return updated;
    });
    if (!updated) return;
    set({ games });
    persistGame(updated);
    if ("installDir" in patch || "exePath" in patch || "processNames" in patch || "kind" in patch) syncTracking(games);
    if ("status" in patch || "rating" in patch || "collectionIds" in patch) get().checkAchievements();
  },

  removeGame: async (id) => get().removeGames([id]),

  removeGames: async (ids) => {
    const set_ = new Set(ids);
    const games = get().games.filter((g) => !set_.has(g.id));
    set({ games });
    const stats = new Map(get().stats);
    ids.forEach((i) => stats.delete(i));
    set({ stats, sessions: get().sessions.filter((s) => !set_.has(s.gameId)) });
    syncTracking(games);
    for (const id of ids) {
      try {
        await api.dbDelete("games", id);
      } catch (e) {
        toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
      }
    }
  },

  mergeGames: async (keepId, removeIds) => {
    const keep = get().games.find((g) => g.id === keepId);
    const others = get().games.filter((g) => removeIds.includes(g.id) && g.id !== keepId);
    if (!keep || others.length === 0) return;
    const all = [keep, ...others];
    get().updateGame(keepId, {
      favorite: all.some((g) => g.favorite),
      inDock: all.some((g) => g.inDock) || undefined,
      rating: Math.max(...all.map((g) => g.rating)),
      status: keep.status !== "none" ? keep.status : (others.find((g) => g.status !== "none")?.status ?? "none"),
      notes: [...new Set(all.map((g) => g.notes.trim()).filter(Boolean))].join("\n\n"),
      tags: [...new Set(all.flatMap((g) => g.tags))],
      collectionIds: [...new Set(all.flatMap((g) => g.collectionIds))],
      addedAt: Math.min(...all.map((g) => g.addedAt)),
    });
    try {
      await api.gamesMerge(keepId, others.map((g) => g.id));
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
      return;
    }
    const gone = new Set(others.map((g) => g.id));
    const games = get().games.filter((g) => !gone.has(g.id));
    set({ games });
    syncTracking(games);
    await get().refreshStats();
  },

  launch: async (game) => {
    if (get().launching.has(game.id)) return;
    const settings = useSettings.getState().settings;
    const launching = new Set(get().launching);
    launching.add(game.id);
    set({ launching });
    if (settings.launchRitual && game.kind === "game" && document.documentElement.dataset.motion !== "off") {
      useUI.getState().setRitual(game);
    } else {
      sound.play("launch", { gain: 0.6 });
    }
    try {
      await api.launchGame(game.id, game.launch);
      get().bump("launches");
      if (game.kind === "app") {
        const l = new Set(get().launching);
        l.delete(game.id);
        set({ launching: l });
      } else {
        // Spätestens nach 90 s ist "startet" vorbei, auch wenn der Prozess nicht erkannt wurde
        window.setTimeout(() => {
          const l = new Set(get().launching);
          if (l.delete(game.id)) set({ launching: l });
        }, 90000);
      }
      if (settings.minimizeOnLaunch && game.kind === "game" && isTauri()) {
        window.setTimeout(async () => {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow()
            .minimize()
            .catch(() => undefined);
        }, settings.launchRitual ? 2300 : 600);
      }
    } catch (e) {
      const l = new Set(get().launching);
      l.delete(game.id);
      set({ launching: l });
      useUI.getState().setRitual(null);
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  },

  stop: async (gameId) => {
    try {
      await api.stopGame(gameId);
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  },

  fetchImages: async (games, opts = {}) => {
    const key = useSettings.getState().settings.steamGridDbKey.trim();
    const queue = games.filter((g) => !get().imageQueue.has(g.id));
    if (!queue.length) return 0;
    const q = new Set(get().imageQueue);
    queue.forEach((g) => q.add(g.id));
    set({ imageQueue: q });
    let loaded = 0;
    const kinds: ImageKind[] = opts.kinds ?? ["cover", "hero", "logo", "icon"];
    const worker = async () => {
      while (queue.length) {
        const g = queue.shift()!;
        try {
          const steamAppId = g.source === "steam" ? g.sourceId : g.launch.target.match(/steam:\/\/rungameid\/(\d+)/)?.[1];
          const needed = opts.force ? kinds : kinds.filter((k) => !g.images[k]);
          let images = { ...g.images };
          let palette = g.palette;
          if (needed.length && (steamAppId || key)) {
            const res = await api.imagesFetch({ gameId: g.id, name: g.name, steamAppId, kinds: needed, apiKey: key || undefined, force: opts.force });
            images = { ...images, ...Object.fromEntries(Object.entries(res.images).filter(([, v]) => !!v)) };
            if (res.palette) palette = res.palette;
            if (!opts.quiet && res.messages.length && res.source === "none") toast({ kind: "warning", title: g.name, text: res.messages[0] });
          }
          // Programme: echtes Icon aus der .exe
          if (!images.icon && g.exePath && (g.kind === "app" || !images.cover)) {
            const icon = await api.exeIcon(g.exePath, g.id).catch(() => null);
            if (icon) images.icon = icon;
          }
          if (JSON.stringify(images) !== JSON.stringify(g.images) || palette !== g.palette) {
            loaded++;
            get().updateGame(g.id, { images, palette });
          }
        } catch (e) {
          if (!opts.quiet) toast({ kind: "error", title: g.name, text: errorText(e) });
        } finally {
          const q2 = new Set(get().imageQueue);
          q2.delete(g.id);
          set({ imageQueue: q2 });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return loaded;
  },

  saveCollection: async (c) => {
    const existing = c.id ? get().collections.find((x) => x.id === c.id) : undefined;
    const col: Collection = {
      id: existing?.id ?? uid("col"),
      name: c.name,
      icon: c.icon ?? existing?.icon ?? "Folder",
      color: c.color ?? existing?.color ?? "#ff4f8b",
      description: c.description ?? existing?.description,
      createdAt: existing?.createdAt ?? Date.now(),
      order: existing?.order ?? get().collections.length,
    };
    await api.dbPut("collections", col.id, col);
    set({ collections: existing ? get().collections.map((x) => (x.id === col.id ? col : x)) : [...get().collections, col] });
    get().checkAchievements();
    return col;
  },

  deleteCollection: async (id) => {
    await api.dbDelete("collections", id);
    set({ collections: get().collections.filter((c) => c.id !== id) });
    for (const g of get().games.filter((x) => x.collectionIds.includes(id))) {
      get().updateGame(g.id, { collectionIds: g.collectionIds.filter((c) => c !== id) });
    }
  },

  toggleInCollection: (gameId, collectionId) => {
    const g = get().games.find((x) => x.id === gameId);
    if (!g) return;
    const has = g.collectionIds.includes(collectionId);
    get().updateGame(gameId, { collectionIds: has ? g.collectionIds.filter((c) => c !== collectionId) : [...g.collectionIds, collectionId] });
  },

  saveWish: async (w) => {
    const existing = w.id ? get().wishlist.find((x) => x.id === w.id) : undefined;
    const item: WishItem = { ...(existing ?? { addedAt: Date.now(), priority: 2 }), ...w, id: existing?.id ?? uid("wish") } as WishItem;
    await api.dbPut("wishlist", item.id, item);
    set({ wishlist: existing ? get().wishlist.map((x) => (x.id === item.id ? item : x)) : [...get().wishlist, item] });
    get().checkAchievements();
    return item;
  },

  deleteWish: async (id) => {
    await api.dbDelete("wishlist", id);
    set({ wishlist: get().wishlist.filter((w) => w.id !== id) });
  },

  bump: (key, by = 1) => {
    const counters = { ...get().counters, [key]: (get().counters[key] ?? 0) + by };
    set({ counters });
    void api.kvSet("counters", counters).catch(() => undefined);
    get().checkAchievements();
  },

  checkAchievements: () => {
    const s = get();
    const done = evaluate({ games: s.games, stats: s.stats, sessions: s.sessions, collections: s.collections, wishlist: s.wishlist, counters: s.counters });
    const known = new Set(s.unlocked.map((u) => u.id));
    const fresh = [...done].filter((id) => !known.has(id));
    if (!fresh.length) return;
    const all = [...s.unlocked, ...fresh.map((id) => ({ id, unlockedAt: Date.now() }))];
    set({ unlocked: all });
    void api.kvSet("achievements", all).catch(() => undefined);
    useUI.getState().pushAchievements(fresh);
  },
}));

/** Spielzeit eines Spiels inklusive laufender Sitzung */
export function liveSeconds(stats: PlayStats | undefined, run: RunningGame | undefined, now = Date.now()): number {
  return (stats?.totalSeconds ?? 0) + (run ? Math.max(0, (now - run.startedAt) / 1000) : 0);
}
