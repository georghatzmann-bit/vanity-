/** Anbieter-Protokoll und Messverlauf. Vertrag: docs/API.md, „Anbieter-Protokoll“ und „Datenbank v2“. */
import { call } from "../api";
import type { EventKind, EventSummaryRow, EventsPage, HistoryClearScope } from "../types";

export const isplogApi = {
  /** Ereignisse `from <= t <= to` (aufsteigend), mehr als `limit` → die neuesten und `truncated` */
  eventsList: (from: number, to: number, kinds?: EventKind[], netId?: string, limit?: number) => call<EventsPage>("net_events_list", { from, to, kinds, netId, limit }),
  /** Zählungen je UTC-Stunde, Art, Ursache, Umfang, Verbindung, Netz */
  eventsSummary: (from: number, to: number, netId?: string) => call<EventSummaryRow[]>("net_events_summary", { from, to, netId }),
  /** Messverlauf löschen: `events` = nur Ereignisse, `all` = alles; liefert die Zahl gelöschter Zeilen */
  historyClear: (scope: HistoryClearScope) => call<number>("net_history_clear", { scope }),
};
