import { create } from "zustand";
import { api, listen } from "@/lib/api";
import { uid } from "@/lib/defaults";
import { compressTimeline, countSpikes, pingGrade, summarize } from "@/lib/grade";
import { t } from "@/lib/i18n";
import type { BoostState, Game, PingSample, Session, SessionReport } from "@/lib/types";
import { gameHooks, useLibrary } from "./library";
import { useNet } from "./net";
import { useSettings } from "./settings";
import { toast } from "./ui";
import { sound } from "@shared/sound/engine";

interface BoostStore {
  state: BoostState;
  busy: boolean;
  reports: SessionReport[];
  init: () => Promise<void>;
  start: (gameId?: string | null, opts?: { quiet?: boolean }) => Promise<void>;
  stop: (opts?: { quiet?: boolean }) => Promise<void>;
  toggle: () => Promise<void>;
  loadReports: () => Promise<void>;
  deleteReport: (id: string) => Promise<void>;
  deleteAllReports: () => Promise<void>;
}

/** Laufende Aufzeichnung einer Spielsitzung (Ping-Verlauf) */
let recording: { gameId: string; start: number; samples: PingSample[]; targetLabel: string; boosted: boolean } | null = null;
let unlisten: (() => void) | null = null;

function buildReport(game: Game, session: Session, rec: NonNullable<typeof recording>): SessionReport {
  const stats = summarize(rec.gameId, rec.samples);
  const rtts = rec.samples.map((s) => s.rtt);
  return {
    id: uid("rep"),
    gameId: game.id,
    gameName: game.name,
    start: session.start,
    end: session.end,
    targetLabel: rec.targetLabel,
    avgPing: stats.avg,
    minPing: stats.min,
    maxPing: stats.max,
    jitter: stats.jitter,
    loss: stats.loss,
    spikes: countSpikes(rtts),
    timeline: compressTimeline(rec.samples.map((s) => [s.t, s.rtt] as [number, number | null])),
    boosted: rec.boosted,
    grade: pingGrade(stats.avg, stats.jitter, stats.loss) ?? "F",
  };
}

export const useBoost = create<BoostStore>((set, get) => ({
  state: { active: false, since: null, gameId: null, actions: [] },
  busy: false,
  reports: [],

  init: async () => {
    try {
      set({ state: await api.boostState() });
    } catch {
      /* Standard */
    }
    if (!unlisten) unlisten = await listen<BoostState>("boost://state", (state) => set({ state }));
    await get().loadReports();

    // Sitzungen aufzeichnen: beim Start Messziel des Spiels wählen, beim Ende Bericht schreiben
    gameHooks.onStarted = (game, startedAt) => {
      const net = useNet.getState();
      // Messziel: echte Spielserver (schnellster Standort), sonst die Region des Spiels
      if (game.serverGame) {
        void net.useGameServerTarget(game.serverGame).then((ok) => {
          if (!ok && game.region) void net.useRegionTarget(game.region);
        });
      } else if (game.region) {
        void net.useRegionTarget(game.region);
      }
      recording = { gameId: game.id, start: startedAt, samples: [], targetLabel: net.targetLabel, boosted: get().state.active };
    };
    gameHooks.onStopped = (game, session) => {
      const rec = recording;
      recording = null;
      // Boost nach dem Spiel wieder beenden
      if (get().state.active && get().state.gameId === game.id) void get().stop({ quiet: true });
      if (!rec || rec.gameId !== game.id || rec.samples.length < 5) return;
      const report = buildReport(game, session, { ...rec, boosted: rec.boosted || get().state.active });
      set({ reports: [report, ...get().reports].slice(0, 500) });
      void api.dbPut("reports", report.id, report).catch(() => undefined);
      toast({ kind: "success", title: t("toast.reportSaved"), text: t("toast.reportText", { name: game.name, ping: Math.round(report.avgPing ?? 0), grade: report.grade }) });
      // Zurück zum normalen Messziel
      void useNet.getState().useRegionTarget();
    };
    // Messwerte während der Sitzung einsammeln
    useNet.subscribe((s, prev) => {
      if (!recording || s.samples === prev.samples) return;
      const fresh = s.samples.slice(prev.samples.length > s.samples.length ? 0 : prev.samples.length);
      recording.samples.push(...fresh.filter((x) => x.t >= recording!.start - 2000));
      recording.targetLabel = s.targetLabel;
    });
  },

  start: async (gameId, opts = {}) => {
    if (get().busy) return;
    set({ busy: true });
    try {
      const lib = useLibrary.getState();
      const game = gameId ? lib.games.find((g) => g.id === gameId) : undefined;
      const profile = { ...useSettings.getState().settings.boostProfile, ...(game?.boost ?? {}) };
      const state = await api.boostStart(profile, gameId ?? null, null);
      set({ state });
      if (recording && recording.gameId === gameId) recording.boosted = true;
      sound.play("achievement", { gain: 0.7 });
      if (!opts.quiet) {
        const failed = state.actions.filter((a) => !a.ok);
        toast(failed.length ? { kind: "warning", title: t("toast.boostFailed"), text: failed.map((f) => f.detail).join(" · ") } : { kind: "success", title: t("toast.boostOn") });
      }
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: false });
    }
  },

  stop: async (opts = {}) => {
    if (get().busy) return;
    set({ busy: true });
    try {
      const state = await api.boostStop();
      set({ state });
      sound.play("toggleOff");
      if (!opts.quiet) toast({ kind: "info", title: t("toast.boostOff") });
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ busy: false });
    }
  },

  toggle: async () => {
    if (get().state.active) await get().stop();
    else {
      const running = [...useLibrary.getState().running.keys()][0] ?? null;
      await get().start(running);
    }
  },

  loadReports: async () => {
    try {
      const list = await api.dbList<SessionReport>("reports");
      set({ reports: list.filter((r) => r && typeof r.id === "string").sort((a, b) => b.end - a.end) });
    } catch {
      /* leer */
    }
  },

  deleteReport: async (id) => {
    set({ reports: get().reports.filter((r) => r.id !== id) });
    await api.dbDelete("reports", id).catch(() => undefined);
  },

  deleteAllReports: async () => {
    const ids = get().reports.map((r) => r.id);
    set({ reports: [] });
    for (const id of ids) await api.dbDelete("reports", id).catch(() => undefined);
  },
}));
