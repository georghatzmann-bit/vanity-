/**
 * „Warum laggt es?“ – reine Auswertung der geführten Prüfung (keine Seiteneffekte).
 * Vertrag: docs/API.md, „„Warum laggt es?““ (Regeln, Schwellen, Sortierung, verdict).
 *
 * Ehrlich: Die Diagnose ist eine regelbasierte Einschätzung aus einer Prüfung von etwa einer
 * Minute. Pulsar sieht andere Geräte im Haushalt nicht und kann Serverlast/Tickrate nicht messen.
 */
import { channelAdvice, connectedNetwork, sameRadio, type OwnNetwork } from "./wifichan";
import { reZone } from "./zones";
import {
  DIAGNOSE_STEPS,
  FINDING_IDS,
  type AdapterInfo,
  type DiagnoseInput,
  type DiagnoseLast,
  type DiagnoseResult,
  type DiagnoseStep,
  type DiagnoseStepId,
  type Finding,
  type FindingId,
  type IfCounters,
  type PingStats,
  type PingTarget,
  type RouteJump,
  type Severity,
  type TraceHop,
  type WifiInfo,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Ablauf: Zeitlimits, Speedtest-Verbrauch, Router-Ziel
// ---------------------------------------------------------------------------------------------

/** Zeitlimit je Schritt (ms) */
export const STEP_TIMEOUT_MS: Record<DiagnoseStepId, number> = {
  connection: 8_000,
  router: 10_000,
  server: 20_000,
  route: 45_000,
  local: 5_000,
  speed: 40_000,
};

/** Router-Pings */
export const ROUTER_PINGS = 20;
/** Server-Messungen: 20 + 20 + 10 = 50 (bzw. ≥ 50 aus dem Live-Monitor) */
export const SERVER_PINGS = [20, 20, 10] as const;
export const SERVER_MIN_SAMPLES = 50;
/** Stationen der Routen-Analyse */
export const ROUTE_MAX_HOPS = 15;
/** Abstand der beiden Zähler-Lesungen (Datenverkehr vor dem Speedtest) */
export const LOCAL_GAP_MS = 2_000;

/**
 * Laufzeit des Speedtests (`speed.rs`: `DOWNLOAD_DURATION`, `UPLOAD_DURATION`). Der Speedtest lädt
 * nicht eine feste Menge, sondern so viel, wie die Leitung in dieser Zeit schafft – der Verbrauch
 * hängt deshalb von der Leitung ab. `diagnose.test.ts` gleicht die Werte gegen `speed.rs` ab.
 */
export const SPEEDTEST_DOWN_S = 8;
export const SPEEDTEST_UP_S = 6;
/** Ohne bekannte Leitung angenommene Obergrenze (Mbit/s) */
export const SPEEDTEST_FALLBACK_MBPS = 1000;
/** Obergrenze bei Gigabit (Standard der Anzeige, wenn nichts über die Leitung bekannt ist) */
export const SPEEDTEST_MAX_MB = speedtestMaxMb(SPEEDTEST_FALLBACK_MBPS, SPEEDTEST_FALLBACK_MBPS);

/**
 * Obergrenze des Datenverbrauchs eines Speedtests (MB, auf 10 aufgerundet): Download- und
 * Upload-Zeit bei voller Leitung plus 5 % für Anlauf und Latenzmessung.
 */
export function speedtestMaxMb(downMbps: number, upMbps: number): number {
  const down = Number.isFinite(downMbps) && downMbps > 0 ? downMbps : SPEEDTEST_FALLBACK_MBPS;
  const up = Number.isFinite(upMbps) && upMbps > 0 ? upMbps : down;
  const mb = ((down * SPEEDTEST_DOWN_S + up * SPEEDTEST_UP_S) / 8) * 1.05;
  return Math.max(10, Math.ceil(mb / 10) * 10);
}

/**
 * Leitung für die Verbrauchsangabe: eingetragene Maximal-Geschwindigkeit (Download/Upload), sonst
 * die Verbindungsgeschwindigkeit des Adapters (mehr geht physikalisch nicht), sonst 1 Gbit/s. Ohne
 * eingetragenen Upload gilt höchstens der Download-Wert.
 */
export function speedtestBudgetMb(contract: { down: number | null; up: number | null }, linkMbps: number | null): number {
  const link = linkMbps && linkMbps > 0 ? linkMbps : null;
  const down = contract.down ?? link ?? SPEEDTEST_FALLBACK_MBPS;
  // Upload ist praktisch nie schneller als der Download der Leitung
  const up = contract.up ?? Math.min(down, link ?? down);
  return speedtestMaxMb(down, up);
}

/** Router-Ziel (immer mit `label`, ICMP wie im Vertrag) */
export function routerTarget(gateway: string): PingTarget {
  return { id: "gateway", label: "Router", host: gateway, method: "icmp" } satisfies PingTarget;
}

/** Hauptverbindung aus der Adapterliste */
export const primaryAdapter = (adapters: AdapterInfo[] | null): AdapterInfo | null => adapters?.find((a) => a.primary) ?? null;

/** Fester Text des Backends, wenn eine Funktion nur unter Windows läuft (→ Schritt `skipped`) */
export const NOT_WINDOWS = "Nur unter Windows verfügbar.";

// ---------------------------------------------------------------------------------------------
// Messwerte zusammenführen
// ---------------------------------------------------------------------------------------------

/** Verloren als Anzahl (aus `loss` × `samples`) */
export const lostOf = (s: Pick<PingStats, "loss" | "samples">) => Math.round(s.loss * s.samples);

/** Antwortet das Ziel überhaupt? */
export const answers = (s: PingStats | null | undefined): s is PingStats => !!s && s.samples > 0 && s.avg !== null && s.loss < 1;

/**
 * Mehrere `net_ping_once`-Ergebnisse desselben Ziels zusammenführen, gewichtet nach Messungen
 * (Ø und Schwankung nach Antworten, Verlust nach Messungen). `null` ohne Teile.
 */
export function mergeStats(parts: PingStats[]): PingStats | null {
  const valid = parts.filter((p) => p.samples > 0);
  if (!valid.length) return null;
  const samples = valid.reduce((a, p) => a + p.samples, 0);
  const lost = valid.reduce((a, p) => a + p.loss * p.samples, 0);
  const answered = valid.map((p) => ({ p, ok: p.samples - p.loss * p.samples })).filter((x) => x.p.avg !== null && x.ok > 0);
  const okSum = answered.reduce((a, x) => a + x.ok, 0);
  const avg = okSum > 0 ? answered.reduce((a, x) => a + (x.p.avg ?? 0) * x.ok, 0) / okSum : null;
  const withJitter = answered.filter((x) => x.p.jitter !== null);
  const jitterWeight = withJitter.reduce((a, x) => a + x.ok, 0);
  const jitter = jitterWeight > 0 ? withJitter.reduce((a, x) => a + (x.p.jitter ?? 0) * x.ok, 0) / jitterWeight : null;
  const mins = answered.map((x) => x.p.min).filter((v): v is number => v !== null);
  const maxs = answered.map((x) => x.p.max).filter((v): v is number => v !== null);
  return {
    targetId: valid[0].targetId,
    last: valid[valid.length - 1].last,
    avg,
    min: mins.length ? Math.min(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
    jitter,
    loss: lost / samples,
    samples,
  };
}

/** Datenverkehr der Hauptverbindung zwischen zwei Zähler-Lesungen (Mbit/s; null = nicht messbar) */
export function trafficMbps(counters: DiagnoseInput["counters"]): { rx: number; tx: number; total: number } | null {
  if (!counters) return null;
  const [a, b] = counters as [IfCounters | null, IfCounters | null];
  if (!a || !b || a.adapterId !== b.adapterId) return null;
  const dt = (b.at - a.at) / 1000;
  const drx = b.rxBytes - a.rxBytes;
  const dtx = b.txBytes - a.txBytes;
  // Zähler zurückgesetzt (Adapter neu verbunden) oder keine Zeit vergangen → nicht messbar
  if (!(dt > 0.2) || drx < 0 || dtx < 0) return null;
  const rx = (drx * 8) / dt / 1e6;
  const tx = (dtx * 8) / dt / 1e6;
  return { rx, tx, total: rx + tx };
}

// ---------------------------------------------------------------------------------------------
// Routen-Auswertung
// ---------------------------------------------------------------------------------------------

/** Sprung ab dieser Höhe über der ersten Station (ms) */
export const JUMP_MS = 30;
/** Folgestationen dürfen höchstens so viel darunter liegen (ms) */
export const JUMP_STAYS_MS = 10;
/** So viele antwortende Stationen (inklusive Ziel) müssen nach dem Sprung folgen */
export const JUMP_FOLLOWERS = 2;

export interface RouteJumpResult {
  jump: RouteJump;
  /** Station (TTL) des Sprungs */
  hop: number | null;
  /** Höhe des Sprungs über der ersten antwortenden Station (ms) */
  jumpMs: number | null;
}

/**
 * Wo steigt die Antwortzeit dauerhaft? Zonen nach der Zonenregel der Teilroute (`reZone`, CGNAT und
 * doppeltes NAT) – nicht die `zone` aus `net_traceroute`. Gesucht ist die erste Station k mit
 * `min(rtts) − base ≥ 30 ms`, nach der mindestens 2 antwortende Stationen folgen, die alle höchstens
 * 10 ms darunter liegen („bleibt erhöht“). Ein einzelner langsamer Hop (Router drosseln
 * Ping-Antworten) zählt deshalb nicht.
 */
export function routeJump(hops: TraceHop[], gateway: string | null): RouteJumpResult {
  const zoned = reZone(
    [...hops].sort((a, b) => a.hop - b.hop),
    gateway,
  );
  const answering = zoned
    .map((h) => {
      const ok = h.rtts.filter((v): v is number => v !== null && Number.isFinite(v));
      return { hop: h.hop, zone: h.zone, min: ok.length && h.zone !== null ? Math.min(...ok) : null };
    })
    .filter((h): h is { hop: number; zone: NonNullable<typeof h.zone>; min: number } => h.min !== null && h.zone !== null);
  if (!answering.some((h) => h.zone !== "lan")) return { jump: "notMeasurable", hop: null, jumpMs: null };
  const base = answering[0].min;
  for (let k = 1; k < answering.length; k++) {
    const st = answering[k];
    const rise = st.min - base;
    if (rise < JUMP_MS) continue;
    const after = answering.slice(k + 1);
    if (after.length < JUMP_FOLLOWERS) continue;
    if (!after.every((h) => h.min >= st.min - JUMP_STAYS_MS)) continue;
    const jump: RouteJump = st.zone === "lan" ? "home" : st.zone;
    return { jump, hop: st.hop, jumpMs: Math.round(rise * 10) / 10 };
  }
  return { jump: "none", hop: null, jumpMs: null };
}

// ---------------------------------------------------------------------------------------------
// Diagnose-Regeln
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, info: 2, ok: 3 };
const ORDER = new Map<FindingId, number>(FINDING_IDS.map((id, i) => [id, i]));

/** Höchstens so viele Befunde (verdict eingeschlossen) */
export const MAX_FINDINGS = 4;

/** Schritte, die für `incomplete` zählen */
export const CORE_STEPS: readonly DiagnoseStepId[] = ["router", "server", "route", "speed"];

const r1 = (x: number) => Math.round(x * 10) / 10;

/** WLAN-Werte der Hauptverbindung (aus `net_wifi_state`, sonst aus der Momentaufnahme) */
function wifiOf(input: DiagnoseInput): Pick<WifiInfo, "signal" | "rssi" | "band" | "channel" | "ssid"> | null {
  const st = input.wifiState;
  if (st?.state === "connected" && st.wifi) return st.wifi;
  const snap = input.snapshot?.snapshot.wifi;
  return snap ? { signal: snap.signal, rssi: snap.rssi, band: snap.band, channel: null, ssid: "" } : null;
}

/** Sortierung: hoch vor mittel vor Hinweis vor ok, bei gleicher Schwere wie in der Tabelle */
export function sortFindings(list: Finding[]): Finding[] {
  return [...list].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (ORDER.get(a.id) ?? 99) - (ORDER.get(b.id) ?? 99));
}

/** verdict: erster Befund mit Schwere hoch/mittel, sonst `incomplete`, sonst `allGood` */
export function verdictOf(sorted: Finding[]): FindingId {
  const main = sorted.find((f) => f.severity === "high" || f.severity === "medium");
  if (main) return main.id;
  return sorted.some((f) => f.id === "incomplete") ? "incomplete" : "allGood";
}

/** Schrittliste in fester Reihenfolge (fehlende Schritte gelten als `skipped`) */
export function normalizeSteps(steps: DiagnoseStep[]): DiagnoseStep[] {
  return DIAGNOSE_STEPS.map((id) => steps.find((s) => s.id === id) ?? { id, status: "skipped" as const });
}

/** Alle zutreffenden Befunde (unsortiert, ungekürzt) */
export function findingsOf(input: DiagnoseInput): Finding[] {
  const out: Finding[] = [];
  const add = (id: FindingId, severity: Severity, values: Record<string, number | string> = {}) => out.push({ id, severity, values });
  const steps = normalizeSteps(input.steps);
  const status = (id: DiagnoseStepId) => steps.find((s) => s.id === id)?.status ?? "skipped";

  // incomplete: mindestens 2 der Kernschritte fehlgeschlagen/übersprungen (`off` zählt nicht)
  const missing = CORE_STEPS.filter((id) => status(id) === "failed" || status(id) === "skipped");
  const incomplete = missing.length >= 2;
  const addIncomplete = () => incomplete && add("incomplete", "info", { steps: missing.join(",") });

  // noLink: keine Hauptverbindung oder kein Gateway (nur, wenn die Adapter gelesen wurden)
  const primary = primaryAdapter(input.adapters);
  if (input.adapters !== null && (!primary || !primary.gateway)) {
    add("noLink", "high");
    addIncomplete();
    return out;
  }

  const isWifi = (primary?.kind ?? input.snapshot?.snapshot.connection) === "wifi";
  const router = input.router;
  const routerAnswers = answers(router);
  const routerLost = router ? lostOf(router) : 0;
  const server = input.server;
  const serverAnswers = answers(server);
  const regionsAnswer = (input.regions ?? []).some((r) => answers(r.stats));
  const speed = input.speed;
  const traffic = trafficMbps(input.counters);
  const icmp = input.target?.method === "icmp" ? 1 : 0;

  // offline: Router antwortet, dahinter nichts (Server, alle Regionen, Speedtest)
  const offline = routerAnswers && !serverAnswers && !regionsAnswer && speed === null;
  if (offline) add("offline", "high");

  // localTraffic: Datenverkehr vor dem Speedtest > 5 Mbit/s oder > 30 % des Downloads
  const localTraffic = !!traffic && (traffic.total > 5 || (speed !== null && speed.downloadMbps > 0 && traffic.total > 0.3 * speed.downloadMbps));
  if (localTraffic && traffic) add("localTraffic", "high", { mbps: r1(traffic.total) });

  // bufferbloat: ab 60 ms (Note C oder schlechter), hoch ab 200 ms
  if (speed && speed.bufferbloatMs >= 60) add("bufferbloat", speed.bufferbloatMs >= 200 ? "high" : "medium", { ms: Math.round(speed.bufferbloatMs) });

  // WLAN-Befunde nur, wenn das WLAN die Hauptverbindung ist
  const wifi = isWifi ? wifiOf(input) : null;
  if (wifi) {
    const rssi = wifi.rssi;
    if ((rssi !== null && rssi < -70) || wifi.signal < 50) {
      add("wifiWeak", rssi !== null && rssi < -75 ? "high" : "medium", rssi !== null ? { rssi: Math.round(rssi), signal: Math.round(wifi.signal) } : { signal: Math.round(wifi.signal), variant: "signal" });
    }
    const networks = input.wifiScan?.networks ?? null;
    if (wifi.band === "2.4") {
      const ownScan = networks ? connectedNetwork(networks) : null;
      const other = networks
        ? networks
            .filter((n) => n.band !== "2.4" && n.rssi >= -70)
            .filter((n) => (wifi.ssid !== "" && n.ssid === wifi.ssid) || (!!ownScan && sameRadio(n.bssid, ownScan.bssid)))
            .sort((a, b) => b.rssi - a.rssi)[0]
        : undefined;
      const visibleAtAll = networks ? networks.some((n) => n.band !== "2.4" && ((wifi.ssid !== "" && n.ssid === wifi.ssid) || (!!ownScan && sameRadio(n.bssid, ownScan.bssid)))) : false;
      if (other) add("wifiBand24", "medium", { rssi: Math.round(other.rssi), band: other.band });
      else if (!visibleAtAll) add("wifiBand24Maybe", "info");
    }
    if (networks && wifi.band && wifi.channel) {
      const own: OwnNetwork = connectedNetwork(networks) ?? { ssid: wifi.ssid, bssid: "", channel: wifi.channel, band: wifi.band, widthMhz: null };
      const advice = channelAdvice(networks, own, { wiredPrimary: false, fresh: input.wifiScan?.fresh ?? false }).find((a) => a.band === own.band && a.current !== null);
      if (advice && advice.improvement === "clear" && advice.current !== null) {
        add("wifiChannel", "medium", { current: advice.current, recommended: advice.recommended, band: advice.band });
      }
    }
  }
  if (isWifi && input.wifiState?.state === "locked") add("wifiLocked", "info");

  // Router
  if (router && !routerAnswers) add("routerNoAnswer", "info");
  if (router && routerAnswers) {
    const avg = router.avg ?? 0;
    const limit = isWifi ? 20 : 10;
    const slow = avg > limit || (router.jitter ?? 0) > 10 || routerLost >= 2;
    if (slow) {
      const high = (routerLost >= 2 && router.loss >= 0.1) || avg > 50;
      add("routerSlow", high ? "high" : "medium", { ms: r1(avg), jitter: r1(router.jitter ?? 0), lost: routerLost, n: router.samples, via: isWifi ? "wifi" : "cable" });
    }
  }
  const routerQuiet = !routerAnswers; // Router nicht bewertbar → Textvariante „noRouter“

  // Route
  if (input.trace) {
    const gateway = primary?.gateway ?? null;
    const rj = routeJump(input.trace.hops, gateway);
    if (rj.jump === "home") add("homeRouterJump", "medium", { ms: Math.round(rj.jumpMs ?? 0), hop: rj.hop ?? 0 });
    if (rj.jump === "isp") add("ispPath", (rj.jumpMs ?? 0) >= 60 ? "high" : "medium", { ms: Math.round(rj.jumpMs ?? 0), hop: rj.hop ?? 0 });
    if (rj.jump === "internet" || rj.jump === "target") add("internetPath", "medium", { ms: Math.round(rj.jumpMs ?? 0), hop: rj.hop ?? 0, target: input.target?.label ?? input.trace.target });
  }

  // Server (nicht bei offline – dann sagt der Verlust nichts zusätzlich)
  if (server && !offline) {
    const lost = lostOf(server);
    if (lost >= 2 && server.loss >= 0.03 && (routerQuiet || (router !== null && router.loss === 0))) {
      add("serverLoss", server.loss >= 0.05 ? "high" : "medium", { lost, n: server.samples, icmp, ...(routerQuiet ? { variant: "noRouter" } : {}) });
    }
    const avg = server.avg;
    if (avg !== null && avg > 80) {
      const better = (input.regions ?? [])
        .filter((r) => r.stats.avg !== null && answers(r.stats) && (r.stats.avg as number) <= avg - 30)
        .sort((a, b) => (a.stats.avg ?? 0) - (b.stats.avg ?? 0))[0];
      if (better) add("serverFar", "medium", { region: better.name, ms: Math.round(better.stats.avg ?? 0), cur: Math.round(avg) });
    }
    if (server.jitter !== null && server.jitter >= 12 && server.samples >= SERVER_MIN_SAMPLES && (routerQuiet || (router?.jitter ?? 99) < 5)) {
      add("jitterHigh", "medium", { ms: r1(server.jitter), icmp, ...(routerQuiet ? { variant: "noRouter" } : {}) });
    }
  }

  // slowLine: Bandbreite (nur hier wird die Breitbandmessung genannt)
  if (speed) {
    const contract = input.contractDownMbps;
    const mbps = Math.round(speed.downloadMbps);
    if (contract && contract > 0) {
      if (speed.downloadMbps < 0.5 * contract) {
        const pct = Math.round((speed.downloadMbps / contract) * 100);
        if (isWifi) add("slowLine", "info", { pct, mbps, contract: Math.round(contract), variant: "wifi" });
        else if (localTraffic) add("slowLine", "info", { pct, mbps, contract: Math.round(contract), variant: "busy" });
        else add("slowLine", "medium", { pct, mbps, contract: Math.round(contract) });
      }
    } else if (speed.downloadMbps < 10) {
      add("slowLine", "info", { mbps: r1(speed.downloadMbps), variant: "noContract" });
    }
  }

  // cpuHigh: kein Netzproblem, fühlt sich aber wie Lag an
  if (input.system && input.system.cpu >= 90) add("cpuHigh", "medium", { pct: Math.round(input.system.cpu) });

  // VPN
  if (input.snapshot?.snapshot.viaVpn) add("vpnActive", "info");

  addIncomplete();
  if (!out.some((f) => f.severity === "high" || f.severity === "medium") && !incomplete) add("allGood", "ok");
  return out;
}

/** `diagnose(input)`: Befunde sortiert, verdict, höchstens 4 Befunde (verdict immer dabei). */
export function diagnose(input: DiagnoseInput, at = Date.now()): DiagnoseResult {
  const sorted = sortFindings(findingsOf(input));
  const verdict = verdictOf(sorted);
  let findings = sorted.slice(0, MAX_FINDINGS);
  if (!findings.some((f) => f.id === verdict)) {
    const v = sorted.find((f) => f.id === verdict) ?? { id: verdict, severity: "ok" as const, values: {} };
    findings = sortFindings([...findings.slice(0, MAX_FINDINGS - 1), v]);
  }
  return { at, verdict, findings, steps: normalizeSteps(input.steps), input };
}

/** Für kv `diagnose.last`: ohne `input` (nur abgeleitete Werte) */
export function stripInput(result: DiagnoseResult): DiagnoseLast {
  return { at: result.at, verdict: result.verdict, findings: result.findings.map((f) => ({ ...f, values: { ...f.values } })), steps: result.steps.map((s) => ({ ...s })) };
}

const SEVERITIES: readonly Severity[] = ["high", "medium", "info", "ok"];
const STATUSES = ["done", "skipped", "failed", "off"] as const;

/** kv `diagnose.last` tolerant lesen (unbekannte Befunde fallen weg; kaputt → null) */
export function parseLast(raw: unknown): DiagnoseLast | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "number" || typeof o.verdict !== "string" || !ORDER.has(o.verdict as FindingId)) return null;
  const findings: Finding[] = Array.isArray(o.findings)
    ? o.findings.flatMap((f): Finding[] => {
        if (!f || typeof f !== "object") return [];
        const x = f as Record<string, unknown>;
        if (!ORDER.has(x.id as FindingId) || !SEVERITIES.includes(x.severity as Severity)) return [];
        const values: Record<string, number | string> = {};
        if (x.values && typeof x.values === "object") {
          for (const [k, v] of Object.entries(x.values as Record<string, unknown>)) if (typeof v === "number" || typeof v === "string") values[k] = v;
        }
        return [{ id: x.id as FindingId, severity: x.severity as Severity, values }];
      })
    : [];
  const steps: DiagnoseStep[] = Array.isArray(o.steps)
    ? o.steps.flatMap((s): DiagnoseStep[] => {
        if (!s || typeof s !== "object") return [];
        const x = s as Record<string, unknown>;
        if (!DIAGNOSE_STEPS.includes(x.id as DiagnoseStepId) || !STATUSES.includes(x.status as (typeof STATUSES)[number])) return [];
        return [{ id: x.id as DiagnoseStepId, status: x.status as DiagnoseStep["status"], ...(typeof x.error === "string" ? { error: x.error } : {}) }];
      })
    : [];
  if (!findings.some((f) => f.id === o.verdict)) return null;
  return { at: o.at, verdict: o.verdict as FindingId, findings, steps: normalizeSteps(steps) };
}

// ---------------------------------------------------------------------------------------------
// Texte und Verweise
// ---------------------------------------------------------------------------------------------

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Konkrete Schritte je Befund (`diagnose.fix.<id>.<n>`, n = 1 … Anzahl) */
export const FIX_COUNT: Record<FindingId, number> = {
  noLink: 3,
  offline: 3,
  localTraffic: 3,
  bufferbloat: 4,
  wifiWeak: 4,
  wifiBand24: 2,
  wifiChannel: 2,
  routerSlow: 4,
  homeRouterJump: 2,
  serverLoss: 4,
  ispPath: 3,
  internetPath: 3,
  serverFar: 2,
  jitterHigh: 3,
  slowLine: 4,
  cpuHigh: 3,
  vpnActive: 2,
  wifiLocked: 2,
  routerNoAnswer: 2,
  wifiBand24Maybe: 2,
  incomplete: 2,
  allGood: 3,
};

/** Verweis aus einem Befund: Seite der App oder Windows-Einstellung bzw. Webseite */
export type DiagnoseLink = { kind: "route"; page: "network" | "reports"; section: string; label: string } | { kind: "url"; url: string; label: string };

/** Verweise je Befund (Texte `diagnose.link.*`) */
export const LINKS: Partial<Record<FindingId, DiagnoseLink[]>> = {
  wifiWeak: [{ kind: "route", page: "network", section: "wifi", label: "roomScan" }],
  wifiBand24: [{ kind: "route", page: "network", section: "wifi", label: "wifiTab" }],
  wifiChannel: [{ kind: "route", page: "network", section: "wifi", label: "wifiTab" }],
  wifiBand24Maybe: [{ kind: "route", page: "network", section: "wifi", label: "wifiTab" }],
  wifiLocked: [{ kind: "url", url: "ms-settings:privacy-location", label: "windowsSettings" }],
  serverLoss: [
    { kind: "route", page: "reports", section: "isp", label: "ispLog" },
    { kind: "route", page: "reports", section: "calendar", label: "calendar" },
  ],
  ispPath: [
    { kind: "route", page: "reports", section: "isp", label: "ispLog" },
    { kind: "route", page: "reports", section: "calendar", label: "calendar" },
  ],
  jitterHigh: [
    { kind: "route", page: "reports", section: "isp", label: "ispLog" },
    { kind: "route", page: "reports", section: "calendar", label: "calendar" },
  ],
  internetPath: [{ kind: "route", page: "network", section: "regions", label: "regions" }],
  serverFar: [{ kind: "route", page: "network", section: "regions", label: "regions" }],
  slowLine: [{ kind: "url", url: "https://breitbandmessung.de", label: "breitbandmessung" }],
  allGood: [
    { kind: "route", page: "network", section: "connection", label: "lagDetective" },
    { kind: "route", page: "reports", section: "isp", label: "ispLog" },
  ],
};

/** Werte für die Texte (Zahlen im Format der Sprache, Schrittliste übersetzt) */
export function findingVars(f: Pick<Finding, "id" | "values">, t: Translate, fmt: (n: number, digits?: number) => string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f.values)) out[k] = typeof v === "number" ? fmt(v, 1) : v;
  if (typeof f.values.steps === "string") {
    out.list = f.values.steps
      .split(",")
      .filter(Boolean)
      .map((id) => t(`diagnose.step.${id}.name`))
      .join(", ");
  }
  if (typeof f.values.band === "string") out.band = fmt(Number(f.values.band), 1);
  return out;
}

/** Aussage eines Befunds (mit Textvariante `diagnose.variant.<id>.<variante>`) */
export function findingText(f: Pick<Finding, "id" | "values">, t: Translate, fmt: (n: number, digits?: number) => string): string {
  const vars = findingVars(f, t, fmt);
  const variant = typeof f.values.variant === "string" ? f.values.variant : null;
  return variant ? t(`diagnose.variant.${f.id}.${variant}`, vars) : t(`diagnose.finding.${f.id}`, vars);
}

/** Konkrete Schritte eines Befunds */
export function fixTexts(f: Pick<Finding, "id" | "values">, t: Translate, fmt: (n: number, digits?: number) => string): string[] {
  const vars = findingVars(f, t, fmt);
  // Per WLAN bzw. per Kabel: der zweite Router-Schritt unterscheidet sich
  return Array.from({ length: FIX_COUNT[f.id] }, (_, i) => {
    const n = i + 1;
    if (f.id === "routerSlow" && n === 2 && f.values.via === "wifi") return t("diagnose.fix.routerSlow.2wifi", vars);
    return t(`diagnose.fix.${f.id}.${n}`, vars);
  });
}

/** Zusatzsätze unter einem Befund (Texte `diagnose.note.*`) */
export function findingNotes(f: Pick<Finding, "id" | "values">): string[] {
  const notes: string[] = [];
  if ((f.id === "serverLoss" || f.id === "jitterHigh") && f.values.icmp === 1) notes.push("icmpThrottle");
  if (f.id === "ispPath" || f.id === "jitterHigh" || f.id === "serverLoss") notes.push("notGuaranteed");
  if (f.id === "internetPath") notes.push("gamePath");
  return notes;
}
