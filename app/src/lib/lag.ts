/**
 * Lag-Detektiv in der Oberfläche: Symbole, Farben und Texte je Ursache, Liste der letzten Ausreißer
 * (Ersetzen per `at` + `targetId`), Zählungen. Vertrag: docs/API.md, „Lag-Detektiv“.
 * Ursachen sind immer eine Einschätzung – Texte nur mit „vermutlich“ bzw. „Einschätzung“.
 */
import { ArrowDownUp, Building, CircleQuestionMark, Globe, Router, Wifi, type LucideIcon } from "lucide-react";
import { LAG_CAUSES, type EventSummaryRow, type LagCause, type LagEvent, type QuickHop, type Reason, type TargetKind } from "./types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Höchstzahl der Ereignisse in Karte und `net_lag_recent` */
export const LAG_RECENT_MAX = 20;
/** Das Cockpit zeigt den letzten Ausreißer so lange (ms) */
export const LAG_BADGE_MS = 60_000;

export const CAUSE_ICONS: Record<LagCause, LucideIcon> = {
  wifi: Wifi,
  router: Router,
  isp: Building,
  internet: Globe,
  localTraffic: ArrowDownUp,
  unknown: CircleQuestionMark,
};

/** Farbe je Ursache (Design-Token) – „unklar“ bewusst neutral */
export const CAUSE_TONE: Record<LagCause, string> = {
  wifi: "var(--nv-warning)",
  router: "var(--nv-warning)",
  isp: "var(--nv-danger)",
  internet: "var(--nv-info)",
  localTraffic: "var(--nv-accent-2)",
  unknown: "var(--nv-muted)",
};

/** Anzeigename der Ursache; „Internet“ bekommt bei Spielserver-Zielen den Zusatz „– Spielserver-Netz“ */
export function causeLabel(cause: LagCause, targetKind: TargetKind | null, t: Translate): string {
  const name = t(`lag.cause.${cause}`);
  return cause === "internet" && targetKind === "server" ? `${name} ${t("lag.causeNote.internetServer")}` : name;
}

/** „vermutlich WLAN“ bzw. „Ursache unklar“ */
export function causeLine(cause: LagCause, targetKind: TargetKind | null, t: Translate): string {
  return cause === "unknown" ? t("lag.unclearCause") : t("lag.likely", { cause: causeLabel(cause, targetKind, t) });
}

/** Fester Untertitel einer Ursache (nur „Anschluss/Anbieter“) */
export function causeNote(cause: LagCause, t: Translate): string | null {
  return cause === "isp" ? t("lag.causeNote.isp") : null;
}

/** Begründung als Satz */
export const reasonText = (reason: Reason, t: Translate) => t(`lag.reason.${reason}`);

/** Begründungen ohne `cpuHigh` (das zeigt die Oberfläche als eigenen Hinweis) */
export const visibleReasons = (ev: Pick<LagEvent, "reasons">) => ev.reasons.filter((r) => r !== "cpuHigh");

/** Ereignis in die Liste aufnehmen: gleiches `at` + `targetId` ersetzt (zweite Meldung mit endgültigem `count`), neueste zuerst, höchstens 20 */
export function upsertLagEvent(list: LagEvent[], ev: LagEvent, max = LAG_RECENT_MAX): LagEvent[] {
  const rest = list.filter((e) => !(e.at === ev.at && e.targetId === ev.targetId));
  return [...rest, ev].sort((a, b) => b.at - a.at).slice(0, max);
}

/** Letzter Ausreißer der letzten 60 s (für das Cockpit) */
export function latestRecent(list: LagEvent[], now: number, windowMs = LAG_BADGE_MS): LagEvent | null {
  const ev = list.reduce<LagEvent | null>((best, e) => (!best || e.at > best.at ? e : best), null);
  return ev && now - ev.at >= 0 && now - ev.at <= windowMs ? ev : null;
}

/** Zählung je Ursache aus Live-Ereignissen (Summe von `count`) */
export function countsFromEvents(list: LagEvent[]): Partial<Record<LagCause, number>> {
  const out: Partial<Record<LagCause, number>> = {};
  for (const e of list) out[e.cause] = (out[e.cause] ?? 0) + Math.max(1, Math.round(e.count || 1));
  return out;
}

/** Zählung je Ursache aus `net_events_summary` (nur `spike`, Summe von `countSum`; fehlende Ursache = unklar) */
export function countsFromSummary(rows: EventSummaryRow[]): Partial<Record<LagCause, number>> {
  const out: Partial<Record<LagCause, number>> = {};
  for (const r of rows) {
    if (r.kind !== "spike") continue;
    const cause: LagCause = r.cause && (LAG_CAUSES as readonly string[]).includes(r.cause) ? r.cause : "unknown";
    const n = Number.isFinite(r.countSum) && r.countSum > 0 ? r.countSum : r.rows;
    out[cause] = (out[cause] ?? 0) + n;
  }
  return out;
}

/** Zone einer Station als Text („keine Antwort“ bei stummer Station) */
export function zoneText(hop: Pick<QuickHop, "zone" | "cgnat" | "rtt" | "address">, t: Translate): string {
  if (!hop.zone) return t("lag.card.hopNoAnswer");
  if (hop.zone === "isp" && hop.cgnat) return t("lag.zone.ispCgnat");
  return t(`lag.zone.${hop.zone}`);
}

/** Millisekunden kurz (ganze ms, unter 10 ms eine Nachkommastelle) */
export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
}

/** Mbit/s kurz */
export function fmtMbps(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}
