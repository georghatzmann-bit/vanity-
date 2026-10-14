/**
 * Ablauf des Setups: Zustand, Backend-Events, Installation, Fertig, Deinstallation.
 * 1:1 aus der alten App.tsx gelöst; die Oberfläche ist reine Darstellung.
 * Klänge: nur der Sweep beim Seitenwechsel. Stimme, Fehlerklang, Akkord usw. gehören
 * `useObservatory`, das über `onEvent` mithört.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, on, pickFolder, type DiskInfo, type InstallDone, type InstallError, type InstallOptions, type Manifest, type Progress, type SetupInfo, type UninstallDone, type UninstallProgress } from "../api";
import { getLang, setLang as setI18nLang, type Lang } from "../i18n";
import { sound } from "@shared/sound/engine";
import { prefersReducedMotion } from "../hooks/useReducedMotion";
import {
  acceptResumeProgress, advancePhaseClock, CLOSE_NOTICE_MS, COUNTDOWN_S, DISK_DEBOUNCE_MS, DONE_DELAY_MS, emptyPhaseClock, emptyTally, FALLBACK_INFO, invalidDisk, isAlreadyRunning, isDownloadRestart, nextStepAfterIntro, pausePhaseClock, phaseIndexOf, RESUME_NOTE_MS, RETRY_CLOSE_WAIT_MS, tallyDownload, tallyRunStart, tallyTransferred, TIP_COUNT, TIP_INTERVAL_MS, UNDONE_DELAY_MS, UNDONE_DELAY_REDUCED_MS, UPDATE_RESTART_MS, withPulsarSuffix,
  type PhaseClock, type PhaseDurations, type Step, type TransferTally,
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

/** Dispersions-Sweep (E.7): vorwärts 3200 → 400 Hz, zurück 1800 → 300 Hz. */
function playSweep(back: boolean) {
  try {
    if (back) sound.sweep({ fHi: 1800, fLo: 300, durS: 0.16, gainDb: -27 });
    else sound.sweep({ fHi: 3200, fLo: 400, durS: 0.22, gainDb: -24 });
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
  /** Nach dem Fortsetzen begann der Server neu bei 0 (kein Range / `.part` ungültig) */
  const [downloadRestarted, setDownloadRestarted] = useState(false);
  /** in dieser Sitzung wirklich übertragene Bytes (für das Protokoll auf „Fertig“) */
  const [transferred, setTransferred] = useState<number | null>(null);
  /** Speicherplatz wird gerade geprüft (sperrt „Weiter“) */
  const [checking, setChecking] = useState(false);
  /** „Erneut versuchen“ läuft (Pulsar wird geschlossen, 800 ms) */
  const [retrying, setRetrying] = useState(false);
  /** X während der Deinstallation: Hinweis statt Beenden */
  const [closeBlocked, setCloseBlocked] = useState(false);

  const stepRef = useRef<Step>("intro");
  const infoRef = useRef<SetupInfo | null>(null);
  const listeners = useRef(new Set<(e: FlowEvent) => void>());
  const timers = useRef(new Set<number>());
  const phaseClockRef = useRef<PhaseClock>(emptyPhaseClock());
  const tallyRef = useRef<TransferTally>(emptyTally());
  /** „Erneut versuchen“ nach einem Download-Fehler: Fortsetzen wird erwartet (sonst kein Neustart-Hinweis) */
  const resumeExpected = useRef(false);
  const awaitingResume = useRef(false);
  const resumeTimer = useRef<number | undefined>(undefined);
  /** start_install ist unterwegs bzw. läuft (Schutz gegen Doppelklick, synchron) */
  const startingRef = useRef(false);
  /** install://done ist eingetroffen: ein folgendes install://error wird ignoriert */
  const installDoneRef = useRef(false);
  /** letzter angezeigter Prozentstand (für das Fortsetzen) */
  const lastPercentRef = useRef(0);
  /** run_uninstall läuft (ohne uninstall://done/-error) */
  const unRunningRef = useRef(false);
  const closeNoticeTimer = useRef<number | undefined>(undefined);

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
      window.clearTimeout(closeNoticeTimer.current);
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
  const pauseClock = useCallback(() => {
    const next = pausePhaseClock(phaseClockRef.current, performance.now());
    if (next !== phaseClockRef.current) {
      phaseClockRef.current = next;
      setPhaseClock(next);
    }
  }, []);
  const tickPhaseClock = useCallback((phase: Progress["phase"]) => {
    const next = advancePhaseClock(phaseClockRef.current, phase, performance.now());
    if (next !== phaseClockRef.current) {
      phaseClockRef.current = next;
      setPhaseClock(next);
    }
  }, []);

  const busyRef = useRef(busy);
  busyRef.current = busy;

  const startInstall = useCallback(
    async (o: InstallOptions, retry = false) => {
      // Wiedereintritt (Doppelklick, ausgehende Seite): nur ein start_install gleichzeitig
      if (startingRef.current || busyRef.current) return;
      startingRef.current = true;
      busyRef.current = true;
      installDoneRef.current = false;
      setError(null);
      setBusy(true);
      if (!retry) {
        setProgress(null);
        lastPercentRef.current = 0;
        // Nur ein neuer Lauf beginnt bei 0; nach „Erneut versuchen“ addieren sich die Dauern.
        resetPhaseClock();
        setTransferred(null);
      } else pauseClock();
      tallyRef.current = tallyRunStart(tallyRef.current, !retry);
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
        const message = e instanceof Error ? e.message : String(e);
        // „Die Installation läuft bereits.“ heißt: Es läuft – kein Fehler für die Oberfläche.
        if (isAlreadyRunning(message)) return;
        startingRef.current = false;
        busyRef.current = false;
        const err: InstallError = { phase: "connect", code: "unknown", message, retryable: true };
        pauseClock();
        setBusy(false);
        setError(err);
        emit({ type: "install://error", payload: err, local: true });
      }
    },
    [emit, pauseClock, resetPhaseClock, setStepTracked],
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
    } else {
      // Erste Seite nach dem Intro als Transition: React rendert Seite, Schirm-Wechsel usw. in kleinen
      // Stücken statt in einem langen Task mitten im Übergang (der Schirm ist schon vorab gemountet).
      const target_ = target.step;
      startTransition(() => goRef.current(target_));
    }
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
        // Fortsetzen: „connect = 0“ nicht zeigen (kein 40 → 0 → 40 %). Ein Neustart bei 0 wird übernommen.
        if (awaitingResume.current && !acceptResumeProgress(p)) return;
        let restarted = false;
        if (p.phase === "download") {
          const prev = tallyRef.current;
          restarted = awaitingResume.current && resumeExpected.current && isDownloadRestart(prev.last, p.downloaded);
          tallyRef.current = tallyDownload(prev, p.downloaded);
          setTransferred(tallyTransferred(tallyRef.current));
        }
        setProgress(p);
        setError(null);
        lastPercentRef.current = p.percent;
        tickPhaseClock(p.phase);
        if (awaitingResume.current) {
          awaitingResume.current = false;
          window.clearTimeout(resumeTimer.current);
          if (restarted) {
            setDownloadRestarted(true);
            resumeTimer.current = window.setTimeout(() => setDownloadRestarted(false), RESUME_NOTE_MS);
          } else if (p.phase === "download" && p.downloaded > 0) {
            setResumedAt(p.downloaded);
            resumeTimer.current = window.setTimeout(() => setResumedAt(null), RESUME_NOTE_MS);
          }
        }
        emit({ type: "install://progress", payload: p });
      }),
      on<InstallError>("install://error", (e) => {
        // Nach dem Erfolg zählt kein Fehler mehr (z. B. ein verspäteter Abbruch)
        if (installDoneRef.current) return;
        startingRef.current = false;
        busyRef.current = false;
        awaitingResume.current = false;
        pauseClock();
        setConfirmClose(false);
        setError(e);
        setBusy(false);
        emit({ type: "install://error", payload: e, local: false });
      }),
      on<InstallDone>("install://done", (d) => {
        installDoneRef.current = true;
        startingRef.current = false;
        busyRef.current = false;
        awaitingResume.current = false;
        setConfirmClose(false);
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
        unRunningRef.current = false;
        setCloseBlocked(false);
        setUnDone(d);
        emit({ type: "uninstall://done", payload: d });
        // Die Seite erscheint erst nach dem Zerfall im Schirm (mode „lost“); reduziert wie bisher
        later(() => goRef.current("un-done", 1, { silent: true }), prefersReducedMotion() ? UNDONE_DELAY_REDUCED_MS : UNDONE_DELAY_MS);
      }),
      on<{ message: string }>("uninstall://error", (e) => {
        unRunningRef.current = false;
        setCloseBlocked(false);
        setError({ phase: "install", code: "unknown", message: e.message, retryable: true });
        emit({ type: "uninstall://error", payload: e });
      }),
    ];
    return () => uns.forEach((u) => void u.then((f) => f()));
  }, [emit, later, tickPhaseClock]);

  // Speicherplatz prüfen, wenn sich der Ordner ändert. Für den Vorschlag schon auf „Willkommen“
  // vorladen (kein Einspringen der Werte mitten in der Staffelung des Speicherorts).
  // Jede Anfrage hat eine Nummer; überholte Antworten werden verworfen.
  const diskSeq = useRef(0);
  const diskDirRef = useRef<string | null>(null);
  const diskActive = step === "welcome" || step === "folder";
  useEffect(() => {
    const dir = opts.dir;
    if (!diskActive || !dir || diskDirRef.current === dir) return;
    diskDirRef.current = dir;
    const seq = ++diskSeq.current;
    setDisk(null);
    setChecking(true);
    let fired = false;
    const id = window.setTimeout(() => {
      fired = true;
      void api
        .diskSpace(dir)
        .then((d) => {
          if (seq !== diskSeq.current) return;
          setDisk(d);
          setChecking(false);
        })
        .catch((e) => {
          if (seq !== diskSeq.current) return;
          setDisk(invalidDisk(dir, e instanceof Error ? e.message : String(e)));
          setChecking(false);
        });
    }, DISK_DEBOUNCE_MS);
    return () => {
      if (fired) return;
      window.clearTimeout(id);
      diskDirRef.current = null;
    };
  }, [opts.dir, diskActive]);

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const errorRef = useRef(error);
  errorRef.current = error;

  const retryingRef = useRef(false);
  const retry = useCallback(async () => {
    if (retryingRef.current || startingRef.current || busyRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      if (errorRef.current?.code === "running") {
        await api.closeApp().catch(() => undefined);
        await new Promise((r) => setTimeout(r, RETRY_CLOSE_WAIT_MS));
      }
      // Nur ein Download setzt fort; nach anderen Fehlern beginnt die Anzeige ehrlich bei 0.
      resumeExpected.current = errorRef.current?.phase === "download";
      if (!resumeExpected.current) {
        lastPercentRef.current = 0;
        setProgress(null);
      } else {
        // alte Rate/Rest nicht als „live gemessen“ stehen lassen → „—“ bis zum ersten neuen Messwert
        setProgress((p) => p && { ...p, speed: 0, eta: 0 });
      }
      awaitingResume.current = true;
      setResumedAt(null);
      setDownloadRestarted(false);
      await startInstallRef.current(optsRef.current, true);
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  }, []);

  // Option „Pulsar danach starten“: nach kurzem Countdown automatisch starten (abbrechbar)
  const [countdown, setCountdown] = useState<number | null>(null);
  /** Fertig: Pulsar wird gestartet bzw. das Setup geschlossen (Fußknöpfe gesperrt) */
  const [finishing, setFinishing] = useState<"launch" | "close" | null>(null);
  const finishingRef = useRef(false);
  const finish = useCallback(async (launch: boolean) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setCountdown(null);
    setFinishing(launch ? "launch" : "close");
    // Kein „launch“-Klang (G.1); nur der normale Klick des Knopfs.
    if (launch) {
      await api.launchApp().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 900));
    }
    await api.quit();
  }, []);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (step === "done" && infoRef.current?.mode !== "update" && optsRef.current.launchAfter) setCountdown(COUNTDOWN_S);
  }, [step]);
  useEffect(() => {
    if (countdown === null || confirmClose) return; // pausiert, solange ein Dialog offen ist
    if (countdown <= 0) {
      void finishRef.current(true);
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown, confirmClose]);
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

  // Schließen beendet gerade nicht (Rückfrage/Hinweis) → kein Abschieds-Ausblenden des Fensters
  const closeGuarded = (step === "install" && busy) || (step === "un-run" && !unDone && !error);
  useEffect(() => {
    const root = document.documentElement;
    if (closeGuarded) root.dataset.closeGuarded = "1";
    else delete root.dataset.closeGuarded;
  }, [closeGuarded]);

  /** Fenster schließen: während der Installation erst nachfragen, während der Deinstallation warten */
  const requestClose = useCallback(() => {
    if (stepRef.current === "install" && busyRef.current) setConfirmClose(true);
    else if (stepRef.current === "un-run" && unRunningRef.current) {
      setCloseBlocked(true);
      window.clearTimeout(closeNoticeTimer.current);
      closeNoticeTimer.current = window.setTimeout(() => setCloseBlocked(false), CLOSE_NOTICE_MS);
    } else void api.quit();
  }, []);

  /** Abbruch bestätigt (Dialog). Nur wenn wirklich noch installiert wird – sonst nur schließen. */
  const cancelInstall = useCallback(async () => {
    setConfirmClose(false);
    if (stepRef.current !== "install" || !busyRef.current || installDoneRef.current) return;
    await api.cancelInstall().catch(() => undefined);
  }, []);

  const keepDataRef = useRef(keepData);
  keepDataRef.current = keepData;
  const startUninstall = useCallback(() => {
    if (unRunningRef.current) return;
    unRunningRef.current = true;
    const kd = keepDataRef.current;
    setError(null);
    setUnProgress(null);
    if (stepRef.current !== "un-run") goRef.current("un-run");
    emit({ type: "flow://uninstall-start", keepData: kd });
    // Sofortige Ablehnung (z. B. keine Rechte): nicht ewig bei 0 % stehen bleiben
    api.startUninstall(kd).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      unRunningRef.current = false;
      setCloseBlocked(false);
      setError({ phase: "install", code: "unknown", message, retryable: true });
      emit({ type: "uninstall://error", payload: { message } });
    });
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

  const requiredOk = !checking && Boolean(disk?.valid) && (disk?.free ?? 0) >= (disk?.required ?? 0);
  const phaseIndex = phaseIndexOf(progress);
  const phaseDurations: PhaseDurations = phaseClock.durations;

  return useMemo(
    () => ({
      // Zustand
      info, infoReady, manifest, manifestError, step, dir, lang, muted, opts, disk, progress, error, done, keepData, unProgress, unDone, confirmClose, busy, countdown, tip,
      checking, retrying, closeBlocked,
      phaseDurations, phaseStartedAt: phaseClock.since, resumedAt, downloadRestarted, transferred, finishing,
      // abgeleitet
      mode: info?.mode ?? "install",
      isUpdate: info?.mode === "update",
      requiredOk, phaseIndex,
      // Aktionen
      go, introFinished, startInstall, retry, finish, stopCountdown, requestClose, cancelInstall, setConfirmClose, startUninstall, browseFolder, resetFolder,
      setOpts, setKeepData, setLang, setMuted, onEvent,
    }),
    [info, infoReady, manifest, manifestError, step, dir, lang, muted, opts, disk, progress, error, done, keepData, unProgress, unDone, confirmClose, busy, countdown, tip, checking, retrying, closeBlocked, phaseDurations, phaseClock.since, resumedAt, downloadRestarted, transferred, finishing, requiredOk, phaseIndex, go, introFinished, startInstall, retry, finish, stopCountdown, requestClose, cancelInstall, startUninstall, browseFolder, resetFolder, setLang, onEvent],
  );
}

export type SetupFlow = ReturnType<typeof useSetupFlow>;
