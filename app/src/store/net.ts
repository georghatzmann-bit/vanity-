import { create } from "zustand";
import { api, listen } from "@/lib/api";
import { pingGrade, summarize } from "@/lib/grade";
import { t } from "@/lib/i18n";
import type { AdapterInfo, Grade, MonitorUpdate, PingSample, PingStats, PingTarget, Region, RegionPing, SystemStats, WifiInfo } from "@/lib/types";
import { useSettings } from "./settings";
import { toast } from "./ui";
import { isTauri } from "@shared/lib/env";

/** So viele Messungen bleiben im Speicher (15 Minuten bei 1 s) */
const KEEP = 900;

interface NetState {
  regions: Region[];
  /** Ping-Ergebnisse pro Region (Regionen-Seite) */
  regionPings: Map<string, PingStats>;
  measuringRegions: boolean;

  /** Aktuelles Messziel des Live-Monitors */
  target: PingTarget | null;
  targetLabel: string;
  samples: PingSample[];
  stats: PingStats | null;
  grade: Grade | null;
  monitorOn: boolean;
  monitorError: string | null;

  adapters: AdapterInfo[];
  wifi: WifiInfo | null;
  system: SystemStats | null;

  init: () => Promise<void>;
  loadRegions: () => Promise<void>;
  pingRegions: (ids?: string[]) => Promise<void>;
  setTarget: (target: PingTarget, label: string) => Promise<void>;
  /** Messziel aus den Einstellungen (bzw. dem Spiel) wählen */
  useRegionTarget: (regionId?: string) => Promise<void>;
  /** Echte Spielserver (cs2, dota2, deadlock, lol) messen und den schnellsten als Messziel setzen */
  useGameServerTarget: (game: string) => Promise<boolean>;
  startMonitor: () => Promise<void>;
  stopMonitor: () => Promise<void>;
  refreshConnection: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  clearSamples: () => void;
}

let unlisten: (() => void) | null = null;
let lastAlertAt = 0;

export const useNet = create<NetState>((set, get) => ({
  regions: [],
  regionPings: new Map(),
  measuringRegions: false,
  target: null,
  targetLabel: "",
  samples: [],
  stats: null,
  grade: null,
  monitorOn: false,
  monitorError: null,
  adapters: [],
  wifi: null,
  system: null,

  init: async () => {
    await get().loadRegions();
    if (!unlisten) {
      unlisten = await listen<MonitorUpdate>("net://ping", (u) => {
        const target = get().target;
        if (!target) return;
        const fresh = u.samples.filter((s) => s.targetId === target.id);
        if (!fresh.length) return;
        const samples = [...get().samples, ...fresh].slice(-KEEP);
        const stats = u.stats.find((s) => s.targetId === target.id) ?? summarize(target.id, samples.slice(-60));
        const grade = pingGrade(stats.avg, stats.jitter, stats.loss);
        set({ samples, stats, grade });
        // Warnung bei hohem Ping (höchstens alle 60 s)
        const { pingAlertMs, notifications } = useSettings.getState().settings;
        const last = fresh[fresh.length - 1].rtt;
        if (last !== null && last >= pingAlertMs && Date.now() - lastAlertAt > 60_000) {
          lastAlertAt = Date.now();
          const text = t("cockpit.alert", { ms: Math.round(last), target: get().targetLabel });
          toast({ kind: "warning", title: text, duration: 6000 });
          if (notifications && isTauri()) {
            void import("@tauri-apps/plugin-notification")
              .then(async (n) => {
                let ok = await n.isPermissionGranted();
                if (!ok) ok = (await n.requestPermission()) === "granted";
                if (ok) n.sendNotification({ title: "Pulsar", body: text });
              })
              .catch(() => undefined);
          }
        }
      });
    }
    await get().useRegionTarget();
    void get().refreshConnection();
    void get().refreshSystem();
  },

  loadRegions: async () => {
    try {
      const regions = await api.regions();
      set({ regions });
    } catch (e) {
      console.warn("Regionen:", e);
    }
  },

  pingRegions: async (ids) => {
    if (get().measuringRegions) return;
    set({ measuringRegions: true });
    try {
      const res: RegionPing[] = await api.regionsPing(ids, 4);
      const map = new Map(get().regionPings);
      res.forEach((r) => map.set(r.id, r.stats));
      set({ regionPings: map });
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ measuringRegions: false });
    }
  },

  setTarget: async (target, label) => {
    const changed = get().target?.id !== target.id;
    set({ target, targetLabel: label, samples: changed ? [] : get().samples, stats: changed ? null : get().stats, grade: changed ? null : get().grade });
    if (get().monitorOn || changed) await get().startMonitor();
  },

  useRegionTarget: async (regionId) => {
    const id = regionId ?? useSettings.getState().settings.monitorRegion;
    const region = get().regions.find((r) => r.id === id) ?? get().regions[0];
    if (!region) return;
    await get().setTarget(region.target, region.name);
  },

  useGameServerTarget: async (game) => {
    try {
      const servers = await api.gameServers(game);
      if (!servers.length) return false;
      // Alle Standorte kurz anpingen (höchstens 8 gleichzeitig), den schnellsten nehmen
      const results: { region: Region; avg: number }[] = [];
      for (let i = 0; i < servers.length; i += 8) {
        const chunk = servers.slice(i, i + 8);
        const stats = await Promise.all(chunk.map((r) => api.pingOnce(r.target, 2).catch(() => null)));
        chunk.forEach((region, k) => {
          const s = stats[k];
          if (s && s.avg !== null && s.loss < 1) results.push({ region, avg: s.avg });
        });
      }
      if (!results.length) return false;
      results.sort((a, b) => a.avg - b.avg);
      const best = results[0].region;
      await get().setTarget(best.target, `${best.name} (${best.provider})`);
      return true;
    } catch {
      return false;
    }
  },

  startMonitor: async () => {
    const target = get().target;
    if (!target) return;
    try {
      await api.monitorStart([target], useSettings.getState().settings.pingIntervalMs);
      set({ monitorOn: true, monitorError: null });
    } catch (e) {
      set({ monitorOn: false, monitorError: e instanceof Error ? e.message : String(e) });
    }
  },

  stopMonitor: async () => {
    set({ monitorOn: false });
    await api.monitorStop().catch(() => undefined);
  },

  refreshConnection: async () => {
    try {
      const [adapters, wifi] = await Promise.all([api.adapters().catch(() => [] as AdapterInfo[]), api.wifi().catch(() => null)]);
      set({ adapters, wifi });
    } catch {
      /* Anzeige bleibt leer */
    }
  },

  refreshSystem: async () => {
    try {
      const system = await api.systemStats();
      set({ system });
    } catch {
      /* egal */
    }
  },

  clearSamples: () => set({ samples: [], stats: null, grade: null }),
}));
