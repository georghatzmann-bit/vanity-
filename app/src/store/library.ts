import { create } from "zustand";
import { api, errorText, listen } from "@/lib/api";
import { guessServerGame, normalizeGame, uid } from "@/lib/defaults";
import { formatDuration } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { Game, GameStartedEvent, GameStoppedEvent, ImageKind, PlayStats, RunningGame, ScannedEntry, Session } from "@/lib/types";
import { useSettings } from "./settings";
import { toast, useUI } from "./ui";
import { sound } from "@shared/sound/engine";

const YEAR = 400 * 86400000;

interface LibraryState {
  games: Game[];
  stats: Map<string, PlayStats>;
  /** Sitzungen der letzten ~13 Monate */
  sessions: Session[];
  running: Map<string, RunningGame>;
  launching: Set<string>;
  loaded: boolean;
  imageQueue: Set<string>;

  load: () => Promise<void>;
  reload: () => Promise<void>;
  refreshStats: () => Promise<void>;

  addEntries: (entries: ScannedEntry[]) => Promise<Game[]>;
  updateGame: (id: string, patch: Partial<Game>) => void;
  removeGame: (id: string) => Promise<void>;

  /** Spiel starten – mit Boost, wenn eingestellt */
  launch: (game: Game, opts?: { boost?: boolean }) => Promise<void>;
  stop: (gameId: string) => Promise<void>;

  fetchImages: (games: Game[], opts?: { force?: boolean; kinds?: ImageKind[]; quiet?: boolean }) => Promise<number>;
}

let unlisteners: Array<() => void> = [];
let trackTimer: number | undefined;

/** Dem Backend mitteilen, welche Spiele überwacht werden sollen (Spielzeit und Ping-Berichte) */
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
    .map((g) => ({ gameId: g.id, name: g.name }));
  void api.traySetRecent(recent).catch(() => undefined);
}

function persistGame(g: Game) {
  void api.dbPut("games", g.id, g).catch((e) => toast({ kind: "error", title: t("toast.error"), text: errorText(e) }));
}

/** Wird vom Boost-/Berichte-Store gesetzt, um Kreisimporte zu vermeiden */
export const gameHooks: { onStarted: (game: Game, startedAt: number) => void; onStopped: (game: Game, session: Session) => void } = {
  onStarted: () => undefined,
  onStopped: () => undefined,
};

export const useLibrary = create<LibraryState>((set, get) => ({
  games: [],
  stats: new Map(),
  sessions: [],
  running: new Map(),
  launching: new Set(),
  loaded: false,
  imageQueue: new Set(),

  load: async () => {
    await get().reload();
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
        if (g) {
          toast({ kind: "game", title: t("toast.gameStarted", { name: g.name }) });
          gameHooks.onStarted(g, startedAt);
        }
      }),
      await listen<GameStoppedEvent>("game://stopped", ({ gameId, session }) => {
        const running = new Map(get().running);
        running.delete(gameId);
        const stats = new Map(get().stats);
        const prev = stats.get(gameId) ?? { gameId, totalSeconds: 0, sessions: 0, lastPlayedAt: null, lastSessionSeconds: null, firstPlayedAt: null };
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
        if (g && session) {
          toast({ kind: "info", title: t("game.stopped", { name: g.name, time: formatDuration(session.seconds) }) });
          gameHooks.onStopped(g, session);
        }
        syncTray(get().games, stats);
      }),
      await listen<{ gameId: string }>("tray://launch", ({ gameId }) => {
        const g = get().games.find((x) => x.id === gameId);
        if (g) void get().launch(g);
      }),
    );
    try {
      const running = await api.runningGames();
      set({ running: new Map(running.map((r) => [r.gameId, r])) });
    } catch {
      /* egal */
    }
  },

  reload: async () => {
    try {
      const [rawGames, statsList, sessions] = await Promise.all([api.dbList<Game>("games"), api.playtimeStats(), api.sessionsRange(Date.now() - YEAR, Date.now() + 86400000)]);
      const games = (rawGames ?? []).filter((g) => g && typeof g.id === "string").map(normalizeGame);
      const stats = new Map((statsList ?? []).map((s) => [s.gameId, s]));
      set({ games, stats, sessions: sessions ?? [], loaded: true });
      syncTracking(games);
      syncTray(games, stats);
      // Fehlende Cover/Icons im Hintergrund nachladen – höchstens alle 3 Tage pro Eintrag
      const stale = games.filter(
        (g) => !g.hidden && ((g.kind === "game" && !g.images.cover) || !g.images.icon) && (!g.imagesCheckedAt || Date.now() - g.imagesCheckedAt > 3 * 86_400_000),
      );
      if (stale.length) window.setTimeout(() => void get().fetchImages(stale, { quiet: true }), 2500);
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
        serverGame: guessServerGame(e),
        addedAt: now + i,
        updatedAt: now,
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
  },

  removeGame: async (id) => {
    const games = get().games.filter((g) => g.id !== id);
    const stats = new Map(get().stats);
    stats.delete(id);
    set({ games, stats, sessions: get().sessions.filter((s) => s.gameId !== id) });
    syncTracking(games);
    try {
      await api.dbDelete("games", id);
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  },

  launch: async (game, opts = {}) => {
    if (get().launching.has(game.id)) return;
    const settings = useSettings.getState().settings;
    const launching = new Set(get().launching);
    launching.add(game.id);
    set({ launching });
    const boost = opts.boost ?? game.autoBoost ?? settings.autoBoost;
    if (game.kind === "game" && document.documentElement.dataset.motion !== "off") {
      useUI.getState().setRitual(game);
    } else {
      sound.play("launch", { gain: 0.6 });
    }
    try {
      await api.launchGame(game.id, game.launch);
      if (boost && game.kind === "game") {
        // Boost sofort nach dem Start – die Priorität folgt, sobald der Prozess erkannt ist
        const { useBoost } = await import("./boost");
        void useBoost.getState().start(game.id, { quiet: true });
      }
      if (game.kind === "app") {
        const l = new Set(get().launching);
        l.delete(game.id);
        set({ launching: l });
      } else {
        window.setTimeout(() => {
          const l = new Set(get().launching);
          if (l.delete(game.id)) set({ launching: l });
        }, 90000);
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
          const isGame = g.kind === "game";
          const steamAppId = g.source === "steam" ? g.sourceId : g.launch.target.match(/steam:\/\/rungameid\/(\d+)/)?.[1];
          const needed = opts.force ? kinds : kinds.filter((k) => !g.images[k]);
          const wanted = isGame ? needed : needed.filter((k) => k === "icon" || !!key);
          let images = { ...g.images };
          let palette = g.palette;
          if (wanted.length) {
            const exePath = g.exePath ?? (g.launch.type === "exe" ? g.launch.target : undefined);
            const res = await api.imagesFetch({
              gameId: g.id,
              name: g.name,
              steamAppId,
              kinds: wanted,
              apiKey: key || undefined,
              force: opts.force,
              exePath,
              installDir: g.installDir,
              lookupByName: isGame && !steamAppId,
            });
            images = { ...images, ...Object.fromEntries(Object.entries(res.images).filter(([, v]) => !!v)) };
            if (res.palette) palette = res.palette;
            if (!opts.quiet && res.messages.length && res.source === "none") toast({ kind: "warning", title: g.name, text: res.messages[0] });
          }
          const changed = JSON.stringify(images) !== JSON.stringify(g.images) || palette !== g.palette;
          if (changed) loaded++;
          get().updateGame(g.id, { images, palette, imagesCheckedAt: Date.now() });
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
}));
