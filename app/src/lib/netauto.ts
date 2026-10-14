/**
 * „Netzwerk automatisch optimieren“: Wahl des besten DNS-Dienstes (Vertrag: docs/API.md,
 * Abschnitt „Netzwerk automatisch optimieren“). Reine Funktionen ohne Seiteneffekte – gut testbar.
 */
import type { AutoReport, DnsResult, TweakId } from "./types";

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
  /**
   * faster = Wechsel lohnt sich · alreadyFast = DNS bleibt · noData = kein Kandidat hat zuverlässig geantwortet ·
   * notMeasured = der jetzige DNS steht nicht im Vergleich (z. B. nach einer Änderung) – erst erneut vergleichen
   */
  reason: "faster" | "alreadyFast" | "noData" | "notMeasured";
}

/** Kleine Toleranz gegen Rundungsfehler bei Kommazahlen (Grenzwerte zählen als erreicht) */
const EPS = 1e-9;

/**
 * Wählt den besten DNS-Dienst aus einem Vergleich (net_dns_benchmark).
 * - Kandidaten: nur auto-Dienste mit failed = 0 und beiden Medianen.
 * - Verglichen wird mit dem Eintrag current: true.
 * - Gewechselt wird nur bei mindestens 15 % **und** mindestens 3 ms Vorsprung.
 * - Ist der aktuelle DNS selbst der beste Kandidat, bleibt alles, wie es ist.
 * - Fehlt der Eintrag current: true, wurde der jetzige DNS nicht gemessen: kein Wechselvorschlag (reason "notMeasured").
 * - Hat der aktuelle DNS keine Messwerte oder Fehler (failed > 0), hat er nicht zuverlässig geantwortet:
 *   Dann lohnt sich der Wechsel zum besten Kandidaten (currentScore und gainMs sind dann null).
 */
export function pickBestDns(results: DnsResult[]): DnsPick {
  const current = results.find((r) => r.current) ?? null;
  // Mit Fehlern zählt der aktuelle DNS wie die Kandidaten als „nicht zuverlässig“ – kein Vergleichswert
  const currentScore = current && current.failed === 0 ? dnsScore(current) : null;

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
  // Ohne Messung des jetzigen DNS lässt sich nichts ehrlich vergleichen
  if (!current) return { best, current: null, change: false, gainMs: null, bestScore, currentScore: null, reason: "notMeasured" };
  if (best === current || best.id === current.id) return { best, current, change: false, gainMs: 0, bestScore, currentScore, reason: "alreadyFast" };
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

/**
 * Damit endet eine Fehlermeldung des Backends, wenn danach eine Sicherung besteht (Teilerfolg, Zeitüberschreitung,
 * Nachkontrolle ohne Bestätigung). Windows kann dann schon (teilweise) geändert sein – nie „Nicht geändert“ zeigen.
 */
export const RESTORE_HINT_TEXT = "Zurückstellen ist weiter möglich";

/** Kann Windows trotz Fehler schon (teilweise) geändert sein? (aus einer Fehlermeldung des Backends, vor dem Übersetzen) */
export const mayBeChanged = (error: string | null | undefined): boolean => !!error && error.includes(RESTORE_HINT_TEXT);

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Feste Sätze des Backends (deutsch, wie in elevate.rs, net/dnsctl.rs und opt/tweaks.rs) → Übersetzungsschlüssel.
 * Reihenfolge: längere Sätze vor Sätzen, die in ihnen enthalten sind.
 */
export const BACKEND_TEXTS: readonly (readonly [string, string])[] = [
  ["Du hast die Windows-Abfrage abgelehnt – es wurde nichts geändert.", "backend.declined"],
  ["Windows hat nicht alle Änderungen übernommen.", "backend.partly"],
  ["Der Admin-Helfer hat nicht rechtzeitig geantwortet.", "backend.timedOut"],
  ["Der Admin-Helfer läuft noch – bitte gleich noch einmal versuchen.", "backend.busy"],
  ["Der Admin-Helfer hat den Auftrag als ungültig abgelehnt.", "backend.invalid"],
  ["Der Admin-Helfer hat kein Ergebnis geliefert.", "backend.noResult"],
  ["Pulsar kann den DNS auf diesem System nicht einstellen. Dafür braucht es Windows 10 Version 2004 oder neuer.", "backend.cannotChange"],
  ["Dafür braucht es Windows 10 Version 2004 oder neuer.", "backend.needs2004"],
  ["Windows hat die DNS-Änderung nicht übernommen.", "backend.dnsNotTaken"],
  ["Windows hat die Änderung nicht übernommen.", "backend.notTaken"],
  ["Pulsar hat den DNS nicht geändert – es gibt nichts zurückzustellen.", "backend.nothingToRestore"],
  ["Bei dieser Verbindung sind mehr als 3 DNS-Server fest eingetragen – Pulsar ändert den DNS hier nicht, damit er sich sicher zurückstellen lässt.", "backend.tooManyServers"],
  ["Zurückstellen ist weiter möglich.", "backend.restoreHint"],
  ["Es sind noch weitere Verbindungen übrig – bitte noch einmal zurückstellen.", "backend.moreLeft"],
  ["„Nagle“ ist noch an einer anderen Verbindung eingestellt – bitte erst zurückstellen.", "backend.nagleOther"],
  ["Keine Hauptverbindung gefunden, an der „Nagle“ eingestellt werden kann.", "backend.nagleNoAdapter"],
  ["Keine aktive Netzwerkverbindung gefunden.", "backend.noConnection"],
  ["Nur unter Windows verfügbar.", "backend.notWindows"],
  // Netzwerk-Verlauf und die 7 Netzwerk-Funktionen (Teil 2, docs/API.md „Gemeinsam für die 7 Funktionen“)
  ["Für diese Sitzung gibt es keine Messwerte.", "backend.noSamples"],
  ["Ungültiger Zeitraum.", "backend.badRange"],
  ["Unbekannter Bereich.", "backend.badScope"],
  [
    "WLAN-Daten gesperrt: Windows gibt sie nur mit Standortzugriff frei. Bitte unter Einstellungen › Datenschutz und Sicherheit › Standort die Standortdienste und „Desktop-Apps den Zugriff auf Ihren Standort erlauben“ einschalten.",
    "backend.wifiLocked",
  ],
  ["Dateityp nicht erlaubt.", "backend.fileType"],
  ["Datei ist zu groß.", "backend.fileTooBig"],
  ["Ungültiger Speicherort.", "backend.badPath"],
];

/** Sätze des Backends mit einem Platzhalter ({value}) */
const BACKEND_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^(.+?) antwortet gerade nicht – Pulsar stellt ihn deshalb nicht ein\.$/, "backend.noAnswer"],
  [/Pulsar hat den DNS schon an (\d+) Verbindungen geändert – bitte erst zurückstellen\./, "backend.tooManyAdapters"],
  [/Der Admin-Helfer wurde unerwartet beendet \(Code (\d+)\)\./, "backend.unexpectedExit"],
  [/^Datei konnte nicht gespeichert werden: ([\s\S]+)$/, "backend.saveFailed"],
];

/**
 * Meldung des Backends in der Sprache der Oberfläche: Bekannte Sätze werden übersetzt, unbekannte bleiben, wie sie
 * sind (das Backend meldet immer auf Deutsch). Auf Deutsch ändert sich nichts.
 */
export function backendText(msg: string, tr: Translate): string {
  let out = msg;
  for (const [re, key] of BACKEND_PATTERNS) out = out.replace(re, (_m, value: string) => tr(key, { value }));
  for (const [de, key] of BACKEND_TEXTS) out = out.split(de).join(tr(key));
  return out;
}

/**
 * Was ist nach net_auto_restore übrig geblieben? Gründe als Sätze (ohne die Ablehnung der Windows-Abfrage).
 * Steht danach noch eine DNS-Sicherung da, hat Windows den alten DNS nicht übernommen – dafür steht `dnsLeftText`.
 */
export function restoreProblems(rep: AutoReport, dnsLeftText: string): string[] {
  if (rep.declined) return [];
  const dnsLeft = !rep.dnsError && (!!rep.dns?.changedByPulsar || (rep.dns?.otherBackups ?? []).length > 0);
  return [
    ...(rep.dnsError && !isDeclined(rep.dnsError) ? [rep.dnsError] : []),
    ...(dnsLeft ? [dnsLeftText] : []),
    ...rep.failed.filter((f) => !isDeclined(f.error)).map((f) => f.error),
  ];
}

/** Wurde die Windows-Abfrage beim Zurückstellen abgelehnt (und sonst nichts falsch gelaufen)? */
export const restoreDeclined = (rep: AutoReport): boolean => rep.declined || (rep.failed.length > 0 && rep.failed.every((f) => isDeclined(f.error)) && !rep.dnsError);
