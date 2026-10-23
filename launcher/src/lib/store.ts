import { create } from "zustand";
import { persist } from "zustand/middleware";
import { demoProfiles, type Profile } from "./demo-data";

export type PageId =
  | "start"
  | "library"
  | "servers"
  | "match"
  | "ingame"
  | "profiles"
  | "logs"
  | "crashes"
  | "settings"
  | "about";

export type ServiceStatus = "stopped" | "starting" | "running" | "error";

export interface Appearance {
  reduceMotion: boolean;
  glass: boolean;
  animatedBackground: boolean;
}

/** Schritte beim „Host & Play“-Start. In Phase 1 nur als Vorschau animiert. */
export const launchSteps = [
  { label: "Backend", hint: "Port 3551" },
  { label: "Server-Fortnite", hint: "ohne Grafik" },
  { label: "Umleitung", hint: "alles an 127.0.0.1" },
  { label: "Anmeldung", hint: "im Log erkannt" },
  { label: "Game Server", hint: "Port 7777" },
  { label: "Dein Spiel", hint: "mit -d3d11" },
  { label: "Lobby", hint: "bereit zum Spielen" },
] as const;

interface UiState {
  page: PageId;
  setPage: (page: PageId) => void;

  appearance: Appearance;
  setAppearance: (patch: Partial<Appearance>) => void;

  /** -1 = nichts läuft; 0..n-1 = aktueller Schritt; n = fertig */
  launchStep: number;
  setLaunchStep: (step: number) => void;

  profiles: Profile[];
  activeProfileId: string;
  setActiveProfile: (id: string) => void;
  addProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      page: "start",
      setPage: (page) => set({ page }),

      appearance: { reduceMotion: false, glass: true, animatedBackground: true },
      setAppearance: (patch) => set((s) => ({ appearance: { ...s.appearance, ...patch } })),

      launchStep: -1,
      setLaunchStep: (launchStep) => set({ launchStep }),

      profiles: demoProfiles,
      activeProfileId: demoProfiles[0].id,
      setActiveProfile: (activeProfileId) => set({ activeProfileId }),
      addProfile: (profile) => set((s) => ({ profiles: [...s.profiles, profile] })),
      removeProfile: (id) =>
        set((s) => {
          const profiles = s.profiles.filter((p) => p.id !== id);
          const activeProfileId =
            s.activeProfileId === id ? (profiles[0]?.id ?? "") : s.activeProfileId;
          return { profiles, activeProfileId };
        }),
    }),
    {
      name: "vanity-ui",
      // Nur Darstellung merken – alles andere ist in Phase 1 Beispieldaten.
      partialize: (s) => ({ appearance: s.appearance }),
    },
  ),
);

/** Status der drei Dienste, abgeleitet aus dem Vorschau-Startablauf. */
export function servicesForStep(step: number): Record<"backend" | "server" | "game", ServiceStatus> {
  const last = launchSteps.length;
  const status = (startsAt: number, readyAt: number): ServiceStatus => {
    if (step < startsAt) return "stopped";
    if (step >= readyAt || step >= last) return "running";
    return "starting";
  };
  if (step < 0) return { backend: "stopped", server: "stopped", game: "stopped" };
  return {
    backend: status(0, 1),
    server: status(1, 5),
    game: status(5, last),
  };
}
