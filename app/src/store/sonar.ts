import { create } from "zustand";

/** Zustand: „Hör dein Netz“ (läuft/aus, Pegel) – Umsetzung: F4. Gerüst: noch leer, damit `App.tsx` den Store schon kennt. */
export interface SonarStoreState {}

export const useSonar = create<SonarStoreState>(() => ({}));
