/**
 * „Netzwerk automatisch optimieren“: Wahl des besten DNS-Dienstes (Vertrag: docs/API.md,
 * Abschnitt „Netzwerk automatisch optimieren“). Reine Funktionen ohne Seiteneffekte – gut testbar.
 */
import type { DnsResult, TweakId } from "./types";

/** Bekannte DNS-Dienste (wie dns::PROVIDERS im Backend). `auto` = darf automatisch gewählt werden. */
export const DNS_PROVIDERS: { id: string; name: string; auto: boolean; note?: "malware" | "ads" | "encrypted" }[] = [
  { id: "cloudflare", name: "Cloudflare", auto: true },
  { id: "google", name: "Google", auto: true },
  { id: "quad9", name: "Quad9", auto: true, note: "malware" },
  { id: "opendns", name: "OpenDNS", auto: true },
  { id: "adguard", name: "AdGuard", auto: false, note: "ads" },
  { id: "dns0", name: "DNS0.eu", auto: false },
  { id: "mullvad", name: "Mullvad", auto: false, note: "encrypted" },
];

/** Diese Dienste darf „Automatisch optimieren“ wählen */
export const AUTO_PROVIDERS: readonly string[] = DNS_PROVIDERS.filter((p) => p.auto).map((p) => p.id);

/** Optimierungen, die zur Netzwerk-Automatik gehören (beide mit Windows-Abfrage, wirken nach Neustart) */
export const AUTO_TWEAKS: readonly TweakId[] = ["nagle", "netThrottle"];

/** Gewechselt wird nur, wenn der beste Dienst mindestens so viel besser ist … */
export const MIN_GAIN_RATIO = 0.15;
/** … und mindestens so viele Millisekunden */
export const MIN_GAIN_MS = 3;

/** Name eines bekannten Dienstes (sonst die ID selbst) */
export const providerName = (id: string | null | undefined): string => DNS_PROVIDERS.find((p) => p.id === id)?.name ?? id ?? "";

/** Ein bekannter Dienst, den man nur von Hand wählt (z. B. AdGuard wegen der Werbefilter) */
export const isManualProvider = (id: string | null | undefined): boolean => DNS_PROVIDERS.some((p) => p.id === id && !p.auto);

/** Punktzahl eines Dienstes: 0,7 × neue + 0,3 × bekannte Adressen (ms, kleiner ist besser). Ohne beide Werte: null */
export function dnsScore(r: DnsResult): number | null {
  if (r.uncachedMs === null || r.cachedMs === null || !Number.isFinite(r.uncachedMs) || !Number.isFinite(r.cachedMs)) return null;
  return 0.7 * r.uncachedMs + 0.3 * r.cachedMs;
}

export interface DnsPick {
  /** Bester Kandidat (nur auto-Dienste ohne Fehler mit beiden Messwerten), sonst null */
  best: DnsResult | null;
  /** Der aktuell eingestellte DNS (Eintrag mit current: true), sonst null */
  current: DnsResult | null;
  /** Lohnt sich ein Wechsel zu `best`? */
  change: boolean;
  /** So viele ms ist `best` besser als `current` (Punktzahl); null, wenn nicht vergleichbar */
  gainMs: number | null;
  bestScore: number | null;
  currentScore: number | null;
  /** faster = Wechsel lohnt sich · alreadyFast = DNS bleibt · noData = kein Kandidat hat zuverlässig geantwortet */
  reason: "faster" | "alreadyFast" | "noData";
}

/** Kleine Toleranz gegen Rundungsfehler bei Kommazahlen (Grenzwerte zählen als erreicht) */
const EPS = 1e-9;

/**
 * Wählt den besten DNS-Dienst aus einem Vergleich (net_dns_benchmark).
 * - Kandidaten: nur auto-Dienste mit failed = 0 und beiden Medianen.
 * - Verglichen wird mit dem Eintrag current: true.
 * - Gewechselt wird nur bei mindestens 15 % **und** mindestens 3 ms Vorsprung.
 * - Ist der aktuelle DNS selbst der beste Kandidat, bleibt alles, wie es ist.
 * - Hat der aktuelle DNS keine Messwerte (oder ist unbekannt), lohnt sich der Wechsel zum besten Kandidaten.
 */
export function pickBestDns(results: DnsResult[]): DnsPick {
  const current = results.find((r) => r.current) ?? null;
  const currentScore = current ? dnsScore(current) : null;

  let best: DnsResult | null = null;
  let bestScore: number | null = null;
  for (const r of results) {
    if (!AUTO_PROVIDERS.includes(r.id) || r.failed !== 0) continue;
    const s = dnsScore(r);
    if (s === null) continue;
    // Bei Gleichstand gewinnt der aktuelle DNS (kein unnötiger Wechsel), sonst der zuerst gelistete
    if (bestScore === null || s < bestScore - EPS || (Math.abs(s - bestScore) <= EPS && r.current)) {
      best = r;
      bestScore = s;
    }
  }

  if (!best || bestScore === null) return { best: null, current, change: false, gainMs: null, bestScore: null, currentScore, reason: "noData" };
  if (current && (best === current || best.id === current.id)) return { best, current, change: false, gainMs: 0, bestScore, currentScore, reason: "alreadyFast" };
  if (currentScore === null) return { best, current, change: true, gainMs: null, bestScore, currentScore: null, reason: "faster" };

  const gain = currentScore - bestScore;
  const change = gain >= MIN_GAIN_MS - EPS && gain >= currentScore * MIN_GAIN_RATIO - EPS;
  return { best, current, change, gainMs: gain, bestScore, currentScore, reason: change ? "faster" : "alreadyFast" };
}

/** Kurzer Name des aktuellen DNS für „Router → Cloudflare“ (ohne die Adresse in Klammern) */
export function shortDnsName(r: DnsResult | null | undefined): string {
  if (!r) return "";
  return r.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || r.primary;
}

/** Der Satz, mit dem das Backend eine abgelehnte Windows-Abfrage meldet */
export const DECLINED_TEXT = "Windows-Abfrage abgelehnt";

/** Hat der Nutzer die Windows-Abfrage abgelehnt? (aus einer Fehlermeldung des Backends) */
export const isDeclined = (error: string | null | undefined): boolean => !!error && error.includes(DECLINED_TEXT);
