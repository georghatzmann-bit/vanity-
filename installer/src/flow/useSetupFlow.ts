/**
 * Ablauf des Setups: Zustand, Backend-Events, Installation, Fertig, Deinstallation.
 * 1:1 aus der alten App.tsx gelöst; die Oberfläche ist reine Darstellung.
 * Klänge: nur der Sweep beim Seitenwechsel. Stimme, Fehlerklang, Akkord usw. gehören
 * `useObservatory`, das über `onEvent` mithört.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, on, pickFolder, type DiskInfo, type InstallDone, type InstallError, type InstallOptions, type Manifest, type Progress, type SetupInfo, type UninstallDone, type UninstallProgress } from "../api";
import { getLang, setLang as setI18nLang, type Lang } from "../i18n";
import { sound } from "@shared/sound/engine";
import {
  advancePhaseClock, COUNTDOWN_S, DISK_DEBOUNCE_MS, DONE_DELAY_MS, emptyPhaseClock, FALLBACK_INFO, nextStepAfterIntro, phaseIndexOf, RESUME_NOTE_MS, TIP_COUNT, TIP_INTERVAL_MS, UNDONE_DELAY_MS, UPDATE_RESTART_MS, withPulsarSuffix,
  type PhaseClock, type PhaseDurations, type Step,
} from "./logic";

export * from "./logic";

/** Alles, was der Ablauf meldet – Backend-Events wörtlich plus eigene `flow://`-Ereignisse. */
export type FlowEvent =
  | { type: "install://progress"; payload: Progress }
  | { type: "install://error"; payload: InstallError; local: boolean }
  | { type: "install://done"; payload: InstallDone }
  | { type: "uninstall://progress"; payload: UninstallProgress }
  | { type: "uninstall://done"; payload: UninstallDone }
  | { type: "uninstall://error"; payload: { message: string } }
  | { type: "flow://step"; step: Step; prev: Step; dir: number; silent: boolean }
  | { type: "flow://install-start"; options: InstallOptions; retry: boolean }
  | { type: "flow://uninstall-start"; keepData: boolean }
  | { type: "flow://intro-finished" };

export interface GoOptions {
  /** ohne Sweep (z. B. Fertig nach dem Akkord, Deinstallation fertig) */
  silent?: boolean;
}

function readMuted() {
  try {
    return localStorage.getItem("pulsar-setup-muted") === "1";
  } catch {
    return false;
  }
}

/** Dispersions-Sweep (E.7): vorwärts 3200 → 400 Hz, zurück 1800 → 300 Hz. Ältere Engine: „whoosh“. */
type SweepFn = (o: { fHi: number; fLo: number; durS: number; gainDb: number }) => void;
function playSweep(back: boolean) {
  const sweep = (sound as unknown as { sweep?: SweepFn }).sweep;
  if (typeof sweep !== "function") {
    sound.play("whoosh", { gain: 0.6 });
    return;
  }
  try {
    if (back) sweep.call(sound, { fHi: 1800, fLo: 300, durS: 0.16, gainDb: -27 });
    else sweep.call(sound, { fHi: 3200, fLo: 400, durS: 0.22, gainDb: -24 });
  } catch {
    /* Klang ist nie Pflicht */
  }
}

export function useSetupFlow() {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [infoReady, setInfoReady] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("intro");
  const [dir, setDir] = useState(1);
  const [muted, setMuted] = useState(readMuted);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [opts, setOpts] = useState<InstallOptions>({ dir: "", desktopShortcut: true, startMenu: true, autostart: false, launchAfter: true });
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<InstallError | null>(null);
  const [done, setDone] = useState<InstallDone | null>(null);
  const [keepData, setKeepData] = useState(true);
  const [unProgress, setUnProgress] = useState<UninstallProgress | null>(null);
  const [unDone, setUnDone] = useState<UninstallDone | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phaseClock, setPhaseClock] = useState<PhaseClock>(emptyPhaseClock);
  const [resumedAt, setResumedAt] = useState<number | null>(null);

  const stepRef = useRef<Step>("intro");
  const infoRef = useRef<SetupInfo | null>(null);
  const listeners = useRef(new Set<(e: FlowEvent) => void>());
  const timers = useRef(new Set<number>());
  const phaseClockRef = useRef<PhaseClock>(emptyPhaseClock());
  const awaitingResume = useRef(false);
  const resumeTimer = useRef<number | undefined>(undefined);

  const emit = useCallback((e: FlowEvent) => {
    listeners.current.forEach((cb) => {
      try {
        cb(e);
      } catch (err) {
        console.warn("[setup] onEvent:", err);
      }
    });
  }, []);

  /** Rückruf für Ereignisse; liefert die Abmeldung. */
  const onEvent = useCallback((cb: (e: FlowEvent) => void) => {
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      fn();
    }, ms);
    timers.current.add(id);
  }, []);

  useEffect(() => {
    const ts = timers.current;
    return () => {
      ts.forEach((id) => window.clearTimeout(id));
      ts.clear();
      window.clearTimeout(resumeTimer.current);
    };
  }, []);

  const setStepTracked = useCallback((s: Step) => {
    stepRef.current = s;
    setStep(s);
  }, []);

  const go = useCallback(
    (s: Step, d = 1, o: GoOptions = {}) => {
      const prev = stepRef.current;
      setDir(d);
      setStepTracked(s);
      const silent = Boolean(o.silent);
      if (!silent) playSweep(d < 0 || s === "un-run");
      emit({ type: "flow://step", step: s, prev, dir: d, silent });
    },
    [emit, setStepTracked],
  );

  useEffect(() => {
    sound.setMuted(muted);
    try {
      localStorage.setItem("pulsar-setup-muted", muted ? "1" : "0");
    } catch {
      /* egal */
    }
  }, [muted]);

  const setLang = useCallback((l: Lang) => {
    setI18nLang(l);
    setLangState(l);
  }, []);

  const resetPhaseClock = useCallback(() => {
    phaseClockRef.current = emptyPhaseClock();
    setPhaseClock(phaseClockRef.current);
  }, []);
  const tickPhaseClock = useCallback((phase: Progress["phase"]) => {
    const next = advancePhaseClock(phaseClockRef.current, phase, performance.now());
    if (next !== phaseClockRef.current) {
      phaseClockRef.current = next;
      setPhaseClock(next);
    }
  }, []);

  const startInstall = useCallback(
    async (o: InstallOptions, retry = false) => {
      setError(null);
      setBusy(true);
      resetPhaseClock();
      if (stepRef.current !== "install") {
        const prev = stepRef.current;
        setDir(1);
        setStepTracked("install");
        // Kein Sweep: Der erste Puls ist der Übergang.
        emit({ type: "flow://step", step: "install", prev, dir: 1, silent: true });
      }
      emit({ type: "flow://install-start", options: o, retry });
      try {
        // Ordner braucht Adminrechte? Dann mit UAC neu starten (nur wenn nötig).
        const d = await api.diskSpace(o.dir).catch(() => null);
        if (d?.needsAdmin && !infoRef.current?.elevated) {
          await api.relaunchElevated(o);
          return;
        }
        await api.startInstall(o);
      } catch (e) {
        const err: InstallError = { phase: "connect", code: "unknown", message: e instanceof Error ? e.message : String(e), retryable: true };
        setBusy(false);
        setError(err);
        emit({ type: "install://error", payload: err, local: true });
      }
    },
    [emit, resetPhaseClock, setStepTracked],
  );
  const startInstallRef = useRef(startInstall);
  startInstallRef.current = startInstall;
  const goRef = useRef(go);
  goRef.current = go;

  // Start: Infos laden. Weiter geht es erst, wenn das Intro `introFinished()` meldet.
  const loadedRef = useRef<SetupInfo | null>(null);
  const introDoneRef = useRef(false);
  const routedRef = useRef(false);
  const route = useCallback(() => {
    const si = loadedRef.current;
    if (!si || !introDoneRef.current || routedRef.current) return;
    routedRef.current = true;
    const target = nextStepAfterIntro(si);
    if (target.start) {
      if (si.preset && si.mode !== "update") setOpts(si.preset);
      void startInstallRef.current(target.start);
    } else goRef.current(target.step);
  }, []);

  useEffect(() => {
    void api
      .setupInfo()
      .then((si) => {
        infoRef.current = si;
        setInfo(si);
        setI18nLang(si.systemLang);
        setLangState(si.systemLang);
        setOpts((o) => ({ ...o, dir: si.preset?.dir ?? si.installed?.dir ?? si.defaultDir }));
        loadedRef.current = loadedRef.current ?? si;
        setInfoReady(true);
        route();
      })
      .catch(() => {
        loadedRef.current = loadedRef.current ?? FALLBACK_INFO;
        setInfoReady(true);
        route();
      });
    void api
      .fetchManifest()
      .then(setManifest)
      .catch((e) => setManifestError(e instanceof Error ? e.message : String(e)));
  }, [route]);

  /** Das Intro ist fertig (ersetzt den alten 3300-ms-Timer). */
  const introFinished = useCallback(() => {
    if (introDoneRef.current) return;
    introDoneRef.current = true;
    emit({ type: "flow://intro-finished" });
    route();
  }, [emit, route]);

  // Backend-Events
  useEffect(() => {
    const uns: Promise<() => void>[] = [
      on<Progress>("install://progress", (p) => {
        setProgress(p);
        setError(null);
        tickPhaseClock(p.phase);
        if (awaitingResume.current && p.phase === "download") {
          awaitingResume.current = false;
          if (p.downloaded > 0) {
            setResumedAt(p.downloaded);
            window.clearTimeout(resumeTimer.current);
            resumeTimer.current = window.setTimeout(() => setResumedAt(null), RESUME_NOTE_MS);
          }
        }
        emit({ type: "install://progress", payload: p });
      }),
      on<InstallError>("install://error", (e) => {
        setError(e);
        setBusy(false);
        emit({ type: "install://error", payload: e, local: false });
      }),
      on<InstallDone>("install://done", (d) => {
        setDone(d);
        setBusy(false);
        tickPhaseClock("done");
        setProgress((p) => (p ? { ...p, phase: "done", percent: 100 } : p));
        emit({ type: "install://done", payload: d });
        later(() => goRef.current("done", 1, { silent: true }), DONE_DELAY_MS);
      }),
      on<UninstallProgress>("uninstall://progress", (p) => {
        setUnProgress(p);
        emit({ type: "uninstall://progress", payload: p });
      }),
      on<UninstallDone>("uninstall://done", (d) => {
        setUnDone(d);
        emit({ type: "uninstall://done", payload: d });
        later(() => goRef.current("un-done", 1, { silent: true }), UNDONE_DELAY_MS);
      }),
      on<{ message: string }>("uninstall://error", (e) => {
        setError({ phase: "install", code: "unknown", message: e.message, retryable: true });
        emit({ type: "uninstall://error", payload: e });
      }),
    ];
    return () => uns.forEach((u) => void u.then((f) => f()));
  }, [emit, later, tickPhaseClock]);

  // Speicherplatz prüfen, wenn sich der Ordner ändert
  useEffect(() => {
    if (step !== "folder" || !opts.dir) return;
    const id = window.setTimeout(() => {
      void api
        .diskSpace(opts.dir)
        .then(setDisk)
        .catch(() => setDisk(null));
    }, DISK_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [opts.dir, step]);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const errorRef = useRef(error);
  errorRef.current = error;

  const retry = useCallback(async () => {
    if (errorRef.current?.code === "running") {
      await api.closeApp().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 800));
    }
    awaitingResume.current = true;
    setResumedAt(null);
    void startInstallRef.current(optsRef.current, true);
  }, []);

  const finishing = useRef(false);
  const finish = useCallback(async (launch: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    // Kein „launch“-Klang (G.1); nur der normale Klick des Knopfs.
    if (launch) {
      await api.launchApp().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 900));
    }
    await api.quit();
  }, []);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Option „Pulsar danach starten“: nach kurzem Countdown automatisch starten (abbrechbar)
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (step === "done" && infoRef.current?.mode !== "update" && optsRef.current.launchAfter) setCountdown(COUNTDOWN_S);
  }, [step]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      void finishRef.current(true);
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown]);
  const stopCountdown = useCallback(() => setCountdown(null), []);

  // Nach einem Update startet Pulsar automatisch neu
  useEffect(() => {
    if (step === "done" && info?.mode === "update") {
      const id = window.setTimeout(() => void finishRef.current(true), UPDATE_RESTART_MS);
      return () => window.clearTimeout(id);
    }
  }, [step, info]);

  // Während der Installation: kleine Tipps im Wechsel
  const [tip, setTip] = useState(0);
  useEffect(() => {
    if (step !== "install") return;
    const id = window.setInterval(() => setTip((x) => (x + 1) % TIP_COUNT), TIP_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [step]);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  /** Fenster schließen: während der Installation erst nachfragen */
  const requestClose = useCallback(() => {
    if (stepRef.current === "install" && busyRef.current) setConfirmClose(true);
    else void api.quit();
  }, []);

  /** Abbruch bestätigt (Dialog) */
  const cancelInstall = useCallback(async () => {
    setConfirmClose(false);
    await api.cancelInstall().catch(() => undefined);
  }, []);

  const keepDataRef = useRef(keepData);
  keepDataRef.current = keepData;
  const startUninstall = useCallback(() => {
    const kd = keepDataRef.current;
    goRef.current("un-run");
    emit({ type: "flow://uninstall-start", keepData: kd });
    void api.startUninstall(kd);
  }, [emit]);

  /** Ordner per Dialog wählen */
  const browseFolder = useCallback(async () => {
    const p = await pickFolder(optsRef.current.dir);
    if (p) setOpts((o) => ({ ...o, dir: withPulsarSuffix(p) }));
  }, []);
  const resetFolder = useCallback(() => {
    const si = infoRef.current;
    if (si) setOpts((o) => ({ ...o, dir: si.defaultDir }));
  }, []);

  const requiredOk = !disk || (disk.valid && disk.free >= disk.required);
  const phaseIndex = phaseIndexOf(progress);
  const phaseDurations: PhaseDurations = phaseClock.durations;

  return useMemo(
    () => ({
      // Zustand
      info, infoReady, manifest, manifestError, step, dir, lang, muted, opts, disk, progress, error, done, keepData, unProgress, unDone, confirmClose, busy, countdown, tip,
      phaseDurations, phaseStartedAt: phaseClock.since, resumedAt,
      // abgeleitet
      mode: info?.mode ?? "install",
      isUpdate: info?.mode === "update",
      requiredOk, phaseIndex,
      // Aktionen
      go, introFinished, startInstall, retry, finish, stopCountdown, requestClose, cancelInstall, setConfirmClose, startUninstall, browseFolder, resetFolder,
      setOpts, setKeepData, setLang, setMuted, onEvent,
    }),
    [info, infoReady, manifest, manifestError, step, dir, lang, muted, opts, disk, progress, error, done, keepData, unProgress, unDone, confirmClose, busy, countdown, tip, phaseDurations, phaseClock.since, resumedAt, requiredOk, phaseIndex, go, introFinished, startInstall, retry, finish, stopCountdown, requestClose, cancelInstall, startUninstall, browseFolder, resetFolder, setLang, onEvent],
  );
}

export type SetupFlow = ReturnType<typeof useSetupFlow>;
