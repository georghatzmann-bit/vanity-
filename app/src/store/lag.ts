import { create } from "zustand";

/** Zustand: Lag-Detektiv (letzte Ausreißer, `net://lag`) – Umsetzung: F1. Gerüst: noch leer, damit `App.tsx` den Store schon kennt. */
export interface LagStoreState {}

export const useLag = create<LagStoreState>(() => ({}));
