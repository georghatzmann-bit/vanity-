/** Lag-Detektiv. Vertrag: docs/API.md, „Lag-Detektiv“ (Event `net://lag` über `listen`). */
import { call } from "../api";
import type { IfCounters, LagCheck, LagEvent, PingTarget } from "../types";

export const lagApi = {
  /** Byte-Zähler der Hauptverbindung (null ohne Hauptverbindung/außerhalb von Windows) */
  ifCounters: () => call<IfCounters | null>("net_if_counters"),
  /** Momentaufnahme auf Wunsch (Ziel nur gemessen, nicht bewertet) – nie ein Fehler */
  lagSnapshot: (target: PingTarget) => call<LagCheck>("net_lag_snapshot", { target }),
  /** Die letzten höchstens 20 Ausreißer seit dem Start, neueste zuerst */
  lagRecent: () => call<LagEvent[]>("net_lag_recent"),
};
