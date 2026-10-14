/**
 * Zustand: „Warum laggt es?“ – geführter Ablauf (Schritte mit Zeitlimit und Fortschritt), Abbruch,
 * letztes Ergebnis (kv `diagnose.last`, ohne `input`). Vertrag: docs/API.md, „„Warum laggt es?““.
 *
 * Nur eine Prüfung gleichzeitig. Abbrechen jederzeit: Ein laufender Speedtest wird per
 * `net_speedtest_cancel` beendet, eine laufende Routen-Analyse abgewartet und ihr Ergebnis verworfen.
 * Ein Schritt mit Fehler oder Zeitüberschreitung wird `failed`, ein nicht möglicher `skipped`.
 */
import { create } from "zustand";
import { api, errorText, listen } from "@/lib/api";
import {
  LOCAL_GAP_MS,
  NOT_WINDOWS,
  ROUTE_MAX_HOPS,
  ROUTER_PINGS,
  SERVER_MIN_SAMPLES,
  SERVER_PINGS,
  STEP_TIMEOUT_MS,
  diagnose,
  mergeStats,
  parseLast,
  primaryAdapter,
  routerTarget,
  stripInput,
} from "@/lib/diagnose";
import { t } from "@/lib/i18n";
import {
  DIAGNOSE_STEPS,
  type DiagnoseInput,
  type DiagnoseLast,
  type DiagnoseResult,
  type DiagnoseStepId,
  type DiagnoseStepStatus,
  type IfCounters,
  type PingStats,
  type PingTarget,
  type Region,
  type SpeedProgress,
  type TraceHop,
} from "@/lib/types";
import { useNet } from "./net";
import { useSettings } from "./settings";
import { toast } from "./ui";

/** kv-Schlüssel des letzten Ergebnisses */
export const LAST_KEY = "diagnose.last";

/** Zustand eines Schritts während der Prüfung */
export type LiveStepStatus = "pending" | "running" | "cancelled" | DiagnoseStepStatus;
export interface LiveStep {
  status: LiveStepStatus;
  error?: string;
}

export type DiagnosePhase = "idle" | "running" | "cancelling";

export interface DiagnoseStoreState {
  phase: DiagnosePhase;
  steps: Record<DiagnoseStepId, LiveStep>;
  current: DiagnoseStepId | null;
  /** Fortschritt des Speedtests (`net://speed`) */
  speedProgress: SpeedProgress | null;
  /** Stationen der laufenden Routen-Analyse (`net://trace`) */
  traceHops: TraceHop[];
  /** Messwerte der laufenden bzw. letzten Prüfung dieser Sitzung (für die Schritt-Details) */
  input: DiagnoseInput | null;
  /** Server-Werte stammen aus dem Live-Monitor */
  serverLive: boolean;
  /** Ergebnis dieser Sitzung (mit `input`) */
  result: DiagnoseResult | null;
  /** kv `diagnose.last` */
  last: DiagnoseLast | null;
  /** Schalter „mit Speedtest“ */
  withSpeedtest: boolean;
  /** vom Nutzer umgestellt (dann bleibt seine Wahl, auch bei getakteter Verbindung) */
  speedTouched: boolean;
  /** getaktete Verbindung (null = unbekannt) */
  metered: boolean | null;
  /** letzte Prüfung wurde abgebrochen */
  cancelled: boolean;
  /** Startdaten geladen (letztes Ergebnis, getaktet) */
  ready: boolean;

  init: () => Promise<void>;
  setWithSpeedtest: (on: boolean) => void;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

const pendingSteps = (): Record<DiagnoseStepId, LiveStep> => Object.fromEntries(DIAGNOSE_STEPS.map((id) => [id, { status: "pending" }])) as Record<DiagnoseStepId, LiveStep>;

const emptyInput = (): DiagnoseInput => ({
  steps: [],
  adapters: null,
  wifiState: null,
  wifiScan: null,
  metered: null,
  router: null,
  snapshot: null,
  target: null,
  server: null,
  regions: null,
  trace: null,
  system: null,
  counters: null,
  speed: null,
  contractDownMbps: null,
});

/** Zeitüberschreitung eines Schritts */
class StepTimeout extends Error {}
/** Schritt nicht möglich (→ `skipped`) */
class StepSkipped extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeout(t("diagnose.error.timeout", { s: Math.round(ms / 1000) }))), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Laufende Prüfung (Abbruch-Merker); `null` = keine */
let run: { cancelled: boolean } | null = null;
/** Initialisierung nur einmal gleichzeitig */
let initPromise: Promise<void> | null = null;

/** Messziel: das des Live-Monitors, sonst die Region aus den Einstellungen */
async function resolveTarget(): Promise<{ target: PingTarget; label: string; regions: Region[] } | null> {
  const net = useNet.getState();
  let regions = net.regions;
  if (!regions.length) regions = await api.regions().catch(() => [] as Region[]);
  if (net.target) return { target: net.target, label: net.targetLabel || net.target.label, regions };
  const id = useSettings.getState().settings.monitorRegion;
  const region = regions.find((r) => r.id === id) ?? regions[0];
  return region ? { target: region.target, label: region.name, regions } : null;
}

/** Läuft gerade eine Prüfung? (auch für Tests) */
export const diagnoseRunning = () => run !== null;

export const useDiagnose = create<DiagnoseStoreState>((set, get) => ({
  phase: "idle",
  steps: pendingSteps(),
  current: null,
  speedProgress: null,
  traceHops: [],
  input: null,
  serverLive: false,
  result: null,
  last: null,
  withSpeedtest: true,
  speedTouched: false,
  metered: null,
  cancelled: false,
  ready: false,

  init: async () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const [last, metered] = await Promise.all([api.kvGet<unknown>(LAST_KEY).catch(() => null), api.metered().catch(() => null)]);
      const s = get();
      set({
        last: parseLast(last),
        metered,
        // Getaktet → Speedtest standardmäßig aus (eine eigene Wahl des Nutzers bleibt)
        withSpeedtest: s.speedTouched ? s.withSpeedtest : metered !== true,
        ready: true,
      });
    })().finally(() => {
      initPromise = null;
    });
    return initPromise;
  },

  setWithSpeedtest: (on) => set({ withSpeedtest: on, speedTouched: true }),

  cancel: async () => {
    if (!run || run.cancelled) return;
    run.cancelled = true;
    set({ phase: "cancelling" });
    if (get().current === "speed") await api.speedtestCancel().catch(() => undefined);
  },

  start: async () => {
    if (run) {
      toast({ kind: "info", title: t("diagnose.alreadyRunning") });
      return;
    }
    const me = { cancelled: false };
    run = me;
    const input = emptyInput();
    const stepStatus: { id: DiagnoseStepId; status: DiagnoseStepStatus; error?: string }[] = [];
    set({ phase: "running", steps: pendingSteps(), current: null, speedProgress: null, traceHops: [], input: { ...input }, serverLive: false, result: null, cancelled: false });

    const setStep = (id: DiagnoseStepId, s: LiveStep) => {
      if (run === me) set({ steps: { ...get().steps, [id]: s } });
    };
    const finishStep = (id: DiagnoseStepId, status: DiagnoseStepStatus, error?: string) => {
      stepStatus.push({ id, status, ...(error ? { error } : {}) });
      setStep(id, { status, ...(error ? { error } : {}) });
      if (run === me) set({ input: { ...input, steps: [...stepStatus] } });
    };

    /** Einen Schritt mit Zeitlimit ausführen; Ergebnis verwerfen, wenn inzwischen abgebrochen wurde */
    const step = async (id: DiagnoseStepId, fn: () => Promise<void>) => {
      if (me.cancelled) return;
      set({ current: id });
      setStep(id, { status: "running" });
      let status: DiagnoseStepStatus = "done";
      let error: string | undefined;
      try {
        await withTimeout(fn(), STEP_TIMEOUT_MS[id]);
      } catch (e) {
        const msg = errorText(e);
        status = e instanceof StepSkipped || msg === NOT_WINDOWS ? "skipped" : "failed";
        error = msg;
        if (id === "speed" && e instanceof StepTimeout) await api.speedtestCancel().catch(() => undefined);
      }
      if (me.cancelled) return;
      finishStep(id, status, error);
    };

    try {
      // Messziel und Einstellungen
      const settings = useSettings.getState().settings;
      input.contractDownMbps = settings.ispLog?.contractDownMbps ?? null;
      const resolved = await resolveTarget().catch(() => null);
      if (resolved) input.target = { id: resolved.target.id, label: resolved.label, method: resolved.target.method };

      // 1) Verbindung: Adapter, WLAN-Zustand, Scan (Zwischenspeicher), getaktet – Teilergebnisse zählen
      await step("connection", async () => {
        const [adapters, wifiState, metered] = await Promise.all([api.adapters(), api.wifiState().catch(() => null), api.metered().catch(() => null)]);
        input.adapters = adapters;
        input.wifiState = wifiState;
        input.metered = metered;
        if (primaryAdapter(adapters)?.kind === "wifi") input.wifiScan = await api.wifiScan(false).catch(() => null);
        if (metered !== null) set({ metered });
        // Getaktet → Speedtest aus, sofern der Nutzer nicht selbst gewählt hat
        if (metered === true && !get().speedTouched) set({ withSpeedtest: false });
      });

      // 2) Router: 20 Pings ans Gateway, dazu die Momentaufnahme (erste Stationen, VPN, Verbindungsart)
      await step("router", async () => {
        const gateway = primaryAdapter(input.adapters)?.gateway ?? null;
        const snapshot = resolved ? api.lagSnapshot(resolved.target).catch(() => null) : Promise.resolve(null);
        if (!gateway) {
          input.snapshot = await snapshot;
          throw new StepSkipped(t("diagnose.error.noGateway"));
        }
        const [router, snap] = await Promise.all([api.pingOnce(routerTarget(gateway), ROUTER_PINGS), snapshot]);
        input.router = router;
        input.snapshot = snap;
      });

      // 3) Server: Live-Monitor (≥ 50 Messungen auf demselben Ziel) oder 20 + 20 + 10, dazu Lieblingsregionen
      await step("server", async () => {
        if (!resolved) throw new Error(t("diagnose.error.noTarget"));
        const net = useNet.getState();
        const favorites = settings.favoriteRegions;
        const regionsP = favorites.length ? api.regionsPing(favorites, 4).catch(() => null) : Promise.resolve(null);
        let server: PingStats | null;
        if (net.monitorOn && net.target?.id === resolved.target.id && net.stats && net.stats.samples >= SERVER_MIN_SAMPLES) {
          server = net.stats;
          set({ serverLive: true });
        } else {
          const parts: PingStats[] = [];
          for (const n of SERVER_PINGS) {
            if (me.cancelled) return;
            parts.push(await api.pingOnce(resolved.target, n));
          }
          server = mergeStats(parts);
        }
        input.server = server;
        const regionPings = await regionsP;
        input.regions = regionPings ? regionPings.map((r) => ({ ...r, name: resolved.regions.find((x) => x.id === r.id)?.name ?? r.id })) : null;
      });

      // 4) Route: Routen-Analyse zum Host des Messziels (Stationen live aus `net://trace`)
      await step("route", async () => {
        if (!resolved) throw new Error(t("diagnose.error.noTarget"));
        const un = await listen<TraceHop>("net://trace", (h) => {
          if (run === me && !me.cancelled) set({ traceHops: [...get().traceHops.filter((x) => x.hop !== h.hop), h].sort((a, b) => a.hop - b.hop) });
        });
        try {
          input.trace = await api.traceroute(resolved.target.host, ROUTE_MAX_HOPS);
        } finally {
          un();
        }
      });

      // 5) Datenverkehr vor dem Speedtest: CPU und Byte-Zähler zweimal im Abstand von 2 s
      await step("local", async () => {
        const [system, first] = await Promise.all([api.systemStats().catch(() => null), api.ifCounters().catch(() => null)]);
        input.system = system;
        await sleep(LOCAL_GAP_MS);
        if (me.cancelled) return;
        const second: IfCounters | null = await api.ifCounters().catch(() => null);
        input.counters = [first, second];
      });

      // 6) Speedtest (abgewählt → `off`)
      if (!me.cancelled) {
        if (!get().withSpeedtest) {
          finishStep("speed", "off");
        } else {
          await step("speed", async () => {
            const un = await listen<SpeedProgress>("net://speed", (p) => {
              if (run === me) set({ speedProgress: p });
            });
            try {
              input.speed = await api.speedtest();
            } finally {
              un();
            }
          });
        }
      }

      if (me.cancelled) {
        // Der beim Abbruch laufende Schritt gilt als abgebrochen (sein Ergebnis ist verworfen)
        const steps = Object.fromEntries(Object.entries(get().steps).map(([id, st]) => [id, st.status === "running" ? { status: "cancelled" as const } : st])) as Record<DiagnoseStepId, LiveStep>;
        set({ cancelled: true, steps });
        return;
      }
      input.steps = [...stepStatus];
      const result = diagnose(input);
      const last = stripInput(result);
      set({ result, last, input });
      await api.kvSet(LAST_KEY, last).catch((e: unknown) => console.warn("diagnose.last:", e));
    } finally {
      if (run === me) {
        run = null;
        set({ phase: "idle", current: null, speedProgress: null });
      }
    }
  },
}));
