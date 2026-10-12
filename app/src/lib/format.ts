import { getLanguage, t } from "./i18n";

const locale = () => (getLanguage() === "de" ? "de-DE" : "en-US");

/** 5400 -> "1 Std. 30 Min." (kurz: "1h 30m") */
export function formatDuration(seconds: number, opts: { short?: boolean; showSeconds?: boolean } = {}): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (opts.short) {
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    if (m > 0) return opts.showSeconds && sec ? `${m}m ${sec}s` : `${m}m`;
    return opts.showSeconds || sec > 0 ? `${sec}s` : "0m";
  }
  if (h > 0) return m > 0 ? `${h} ${t("time.h")} ${m} ${t("time.m")}` : `${h} ${t("time.h")}`;
  if (m > 0) return opts.showSeconds && sec ? `${m} ${t("time.m")} ${sec} ${t("time.s")}` : `${m} ${t("time.m")}`;
  return `${sec} ${t("time.s")}`;
}

/** Stunden mit einer Nachkommastelle: 5400 -> "1,5" */
export function formatHours(seconds: number, digits = 1): string {
  return (seconds / 3600).toLocaleString(locale(), { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** Laufzeit-Uhr: 3725 -> "1:02:05" */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** "vor 3 Std.", "Gestern", ... */
export function formatRelative(ts?: number): string {
  if (!ts) return t("common.never");
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.minutesAgo", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("time.hoursAgo", { n: h });
  const d = Math.floor(h / 24);
  if (d === 1) return t("common.yesterday");
  if (d < 7) return t("time.daysAgo", { n: d });
  if (d < 30) return t("time.weeksAgo", { n: Math.floor(d / 7) });
  if (d < 365) return t("time.monthsAgo", { n: Math.floor(d / 30) });
  return t("time.yearsAgo", { n: Math.floor(d / 365) });
}

export function formatDate(ts: number, opts: Intl.DateTimeFormatOptions = { day: "2-digit", month: "short", year: "numeric" }): string {
  return new Date(ts).toLocaleDateString(locale(), opts);
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(ts: number, withSeconds = false): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: withSeconds ? "2-digit" : undefined });
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v.toLocaleString(locale(), { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

export function formatNumber(n: number, digits = 0): string {
  return n.toLocaleString(locale(), { maximumFractionDigits: digits });
}

/** Lokaler Tagesschlüssel "2026-10-12" */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Montag 00:00 der Woche */
export function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.getTime();
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
