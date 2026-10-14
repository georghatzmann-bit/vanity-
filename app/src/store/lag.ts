import { create } from "zustand";
import { api, listen } from "@/lib/api";
import { upsertLagEvent } from "@/lib/lag";
import type { LagEvent } from "@/lib/types";

/** Zustand: Lag-Detektiv – die letzten 20 Ausreißer (`net_lag_recent` + Event `net://lag`, neueste zuerst). */
export interface LagStoreState {
  events: LagEvent[];
  /** `net_lag_recent` geladen und `net://lag` abonniert */
  ready: boolean;
  /** Einmalig laden und abonnieren (mehrfacher Aufruf schadet nicht) */
  init: () => Promise<void>;
  /** Ein Ereignis aufnehmen (gleiches `at` + `targetId` ersetzt) */
  add: (ev: LagEvent) => void;
}

let started: Promise<void> | null = null;

export const useLag = create<LagStoreState>((set, get) => ({
  events: [],
  ready: false,
  add: (ev) => set({ events: upsertLagEvent(get().events, ev) }),
  init: () => {
    if (!started) {
      started = (async () => {
        try {
          await listen<LagEvent>("net://lag", (ev) => get().add(ev));
        } catch (e) {
          console.warn("Lag-Detektiv (Event):", e);
        }
        try {
          const recent = await api.lagRecent();
          // Live-Meldungen, die während des Ladens kamen, bleiben erhalten
          set({ events: recent.reduce((list, ev) => upsertLagEvent(list, ev), get().events) });
        } catch (e) {
          console.warn("Lag-Detektiv (letzte Ausreißer):", e);
        }
        set({ ready: true });
      })();
    }
    return started;
  },
}));
