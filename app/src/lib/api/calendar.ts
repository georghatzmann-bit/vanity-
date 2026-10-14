/** Pulsar-Kalender. Vertrag: docs/API.md, „Pulsar-Kalender“. */
import { call } from "../api";
import type { HourlyRow } from "../types";

export const calendarApi = {
  /** Stunden-Summen (`from <= hourStart <= to`, höchstens 400 Tage), optional nur ein Ziel/Netz */
  historyHourly: (from: number, to: number, targetKey?: string, netId?: string) => call<HourlyRow[]>("net_history_hourly", { from, to, targetKey, netId }),
};
