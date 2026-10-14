import { create } from "zustand";

/** Zustand: „Warum laggt es?“ (Ablauf, Abbruch, letztes Ergebnis) – Umsetzung: F6. Gerüst: noch leer, damit `App.tsx` den Store schon kennt. */
export interface DiagnoseStoreState {}

export const useDiagnose = create<DiagnoseStoreState>(() => ({}));
