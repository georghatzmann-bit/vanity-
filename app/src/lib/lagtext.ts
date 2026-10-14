/**
 * Ursachen-Zählung als Satz – überall gleich (Lag-Detektiv-Karte, Bericht-Detail, Berichte › Ausreißer,
 * PNG-Bildkarte, Anbieter-Protokoll). Immer mit Gesamtzahl und „unklar“, nie ohne „vermutlich“:
 * „5 Ausreißer untersucht – vermutlich: 3× WLAN, 1× Anschluss/Anbieter, 1× unklar“.
 */
import { LAG_CAUSES, type LagCause } from "./types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Nur ganze, positive Zählungen */
const count = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function causeSummary(counts: Partial<Record<LagCause, number>>, t: Translate): string {
  const known = LAG_CAUSES.filter((c) => c !== "unknown")
    .map((c, i) => ({ c, n: count(counts[c]), i }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i);
  const unclear = count(counts.unknown);
  const total = known.reduce((a, x) => a + x.n, 0) + unclear;
  if (total === 0) return t("lag.summary.none");
  const head = total === 1 ? t("lag.summary.headOne") : t("lag.summary.head", { n: total });
  const unclearText = t("lag.summary.unclear", { n: unclear });
  if (!known.length) return `${head} – ${unclearText}`;
  const list = known.map((x) => t("lag.summary.item", { n: x.n, cause: t(`lag.cause.${x.c}`) })).join(", ");
  return `${head} – ${t("lag.summary.likely", { list })}, ${unclearText}`;
}
