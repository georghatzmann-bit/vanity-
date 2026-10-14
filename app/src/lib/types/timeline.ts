/**
 * Match-Zeitleiste (Oberfläche). Die Daten-Typen (`SessionTimeline`, `TimelinePoint` …) stehen in
 * ./history.ts. Vertrag: docs/API.md, „Match-Zeitleiste“.
 */

/** Zoom der Zeitleiste: ganze Runde (Standard), 5 min, 1 min */
export type TimelineZoom = "all" | "5m" | "1m";

/** Bericht-Bereiche (`route.section` der Seite „Berichte“) */
export type ReportsSection = "rounds" | "calendar" | "isp" | "lag" | "session";
