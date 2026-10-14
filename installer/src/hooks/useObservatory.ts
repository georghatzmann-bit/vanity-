/**
 * Observatorium (I.3): besitzt Drehmodell, Stimme, Rauschbett, Akkord und Gewöhnung und hört über
 * `flow.onEvent` mit (F.1, F.5, G.1, G.2). Bild und Ton lesen dasselbe `SpinModel` (Modellzeit =
 * `sound.clock.now()`). Der Zustand ändert sich nur bei Ereignissen und Referenzwechseln – nie pro Bild.
 */
import { useEffect, useRef, useState } from "react";
import { sound, F_STAR, type ChordHandle, type PulseVoice } from "@shared/sound/engine";
import { heardAs, harmonic } from "@shared/sound/dsp";
import { SpinModel } from "@shared/sound/spin";
import type { ErrorCode, Progress, UninstallDone, UninstallProgress } from "../api";
import type { FlowEvent, SetupFlow } from "../flow/useSetupFlow";
import { nearestReference, REFERENCES, type RefId } from "../obs/catalog";
import { driveFor, installNoiseDb, periodForProgress } from "../obs/drive";
import { LOGO_PHASE } from "../obs/star";
import type { ObsMode, ObsState } from "../obs/types";

/* ── Zeitachsen (rein, ms ab Ereignis) ───────────────────── */

/** G.1 Fertig */
export const DONE_TIMING = {
  strobeMs: 800,
  morphEndMs: 1300,
  voiceFadeAtMs: 400,
  voiceFadeS: 0.9,
  voiceStopMs: 1300,
  chordReleaseMs: 2400,
  chordReleaseTau: 0.7,
  updateChordReleaseMs: 1200,
  updateChordReleaseTau: 0.4,
} as const;

/** G.2 Deinstallieren */
export const UNINSTALL_TIMING = {
  /** Zeichen → Stern */
  morphMs: 500,
  /** danach öffnet sich das Stroboskop (Belichtung 0 → 2) */
  strobeOpenMs: 600,
  /** Pulse nach `uninstall://done` (ms) */
  pulsesMs: [0, 1337.3, 2674.6] as const,
  /** Bayer-Zerfall ab t_d + 500 bis t_d + 2000 */
  decayFromMs: 500,
  decayToMs: 2000,
  noiseRiseFromMs: 2674.6,
  noiseRiseToMs: 3400,
  noiseFadeS: 2.1,
  notifyMs: 500,
} as const;

/** F.5 */
export const ERROR_TIMING = { dropoutRampS: 0.3, voiceStopMs: 400, bedDb: -38, bedHoldMs: 100, bedFadeS: 2.5 } as const;
export const HALT_TIMING = { voiceStopMs: 2400, voiceFadeS: 0.6 } as const;
export const RELOCK_MS = 300;
/** Tag „Rastet ein …“ steht mindestens so lange (bzw. bis zum ersten echten Fortschritt danach) */
export const RELOCK_TAG_MS = 800;
/** Sicherheitsnetz: spätestens dann wieder „installing“ */
export const RELOCK_TAG_MAX_MS = 2500;
/** Vorlauf für geplante Pulse (Latenz-Offset): der erste Puls liegt nie in der Vergangenheit */
export const PULSE_LEAD_S = 0.08;
/** E.6 Gewöhnung */
export const HABITUATION = { afterMs: 20000, level: 0.4, downS: 3, upS: 0.5 } as const;

/** Regelgesetze (F.2 Tabelle) */
export const CONTROL = {
  install: { tauS: 0.35, maxOctPerS: 5 },
  done: { tauS: 0.15, maxOctPerS: 3 },
  halt: { tauS: 0.5, maxOctPerS: 5 },
  idle: { tauS: 0.6, maxOctPerS: 3 },
  decay: { tauS: 1.2, maxOctPerS: 2 },
} as const;
export const DECAY_FREQ = 0.02;

/** Strahlen-Deckkraft nach `uninstall://done`: 1 → 0,6 → 0,3 → 0 mit jedem Puls (G.2) */
export function decayBeamAlpha(elapsedMs: number): number {
  const [p1, p2, p3] = UNINSTALL_TIMING.pulsesMs;
  if (elapsedMs < p1) return 1;
  if (elapsedMs < p2) return 0.6;
  if (elapsedMs < p3) return 0.3;
  return 0;
}

/** Hat der Zustand eine hörbare Stimme? (sonst „lautlos“) */
export function voiceModes(mode: ObsMode): boolean {
  return mode === "installing" || mode === "relock" || mode === "halted" || mode === "release" || mode === "uninstalling";
}

/** Fortsetzen: Rauschbett-Mitte 1800 → 1042 Hz in 0,3 s (F.5), geometrisch */
export function relockCurve(n = 16): Float32Array {
  const a = 1800;
  const b = harmonic(6);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.pow(b / a, i / (n - 1));
  return out;
}

const BED_FC = harmonic(6); // 1042,21 Hz
const BED_Q = 0.7;
const ln = Math.log;

/* ── Hook ───────────────────────────────────────────────── */

type Patch = Partial<Omit<ObsState, "model">>;

export function useObservatory(flow: SetupFlow, reduced: boolean): ObsState {
  const now = () => sound.clock.now();
  const [model0] = useState(() => new SpinModel({ t0: now(), f0: REFERENCES.b1919.freqHz, phi0: LOGO_PHASE }));
  const modelRef = useRef<SpinModel>(model0);
  const [state, setState] = useState<ObsState>(() => ({ model: model0, mode: "idle", modeSince: now(), reference: "b1919", heard: null, showMark: false }));
  const stateRef = useRef(state);
  stateRef.current = state;

  const flowRef = useRef(flow);
  flowRef.current = flow;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  // Ton-Objekte
  const voiceRef = useRef<PulseVoice | null>(null);
  const chordRef = useRef<ChordHandle | null>(null);
  const bedOn = useRef(false);
  /** Ziel-Frequenz des Antriebs (Referenz folgt dem Ziel, nicht dem nachlaufenden Modell) */
  const targetF = useRef<number>(REFERENCES.b1919.freqHz);
  /** letzter Antrieb x der Installation (Fehler friert dessen Periode ein, Fortsetzen rastet daran ein) */
  const lastX = useRef(0);
  const relock = useRef<{ minDone: boolean; progressed: boolean; atX: number }>({ minDone: false, progressed: false, atX: 0 });
  const timers = useRef(new Set<number>());
  const habit = useRef<{ timer: number | undefined; lowered: boolean; phase: string }>({ timer: undefined, lowered: false, phase: "" });

  useEffect(() => {
    const ts = timers.current;
    const h = habit.current;

    const patch = (p: Patch, newMode = false) =>
      setState((s) => {
        const next = { ...s, ...p, model: modelRef.current };
        if (newMode && p.modeSince === undefined) next.modeSince = now();
        stateRef.current = next;
        return next;
      });
    const setMode = (mode: ObsMode, p: Patch = {}) => patch({ mode, errorCode: undefined, ...p }, true);

    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        ts.delete(id);
        fn();
      }, ms);
      ts.add(id);
    };
    const clearTimers = () => {
      ts.forEach((id) => window.clearTimeout(id));
      ts.clear();
    };

    // --- Modell
    const freqNow = () => modelRef.current.freqAt(now());
    const target = (f: number, c: { tauS: number; maxOctPerS: number }) => {
      targetF.current = f;
      modelRef.current.setTarget({ f, ...c });
    };
    const replaceModel = (f: number, phi0 = LOGO_PHASE) => {
      const m = new SpinModel({ t0: now(), f0: f, phi0 });
      modelRef.current = m;
      voiceRef.current?.follow(m);
      patch({});
    };

    // --- Stimme
    const voice = (): PulseVoice => {
      if (!voiceRef.current) {
        voiceRef.current = sound.createVoice({ timbre: "radio" });
        voiceRef.current.follow(modelRef.current);
      }
      return voiceRef.current;
    };
    const startVoice = (fadeS = 0.01) => {
      const v = voice();
      v.follow(modelRef.current);
      v.setDropout(0);
      v.setLevel(1, { rampS: 0.02 });
      v.start({ fadeS });
    };
    const stopVoice = (fadeS = 0.1) => voiceRef.current?.stop({ fadeS });

    // --- Rauschbett
    const bed = () => sound.noiseBed();
    const bedSet = (levelDb: number, glideS = 0.3, centerHz = BED_FC, q = BED_Q) => {
      bed().set({ levelDb, centerHz, q, glideS });
      bedOn.current = true;
    };
    const bedStop = (fadeS = 0.3) => {
      if (!bedOn.current) return;
      bedOn.current = false;
      bed().stop({ fadeS });
    };

    // --- Akkord
    const releaseChord = (tauS = 0.3) => {
      chordRef.current?.release({ tauS });
      chordRef.current = null;
    };

    // --- Gewöhnung (E.6): 20 s ohne Phasenwechsel → 0,4 in 3 s; Wechsel → 1 in 0,5 s
    const habitArm = () => {
      window.clearTimeout(h.timer);
      h.timer = window.setTimeout(() => {
        h.lowered = true;
        voiceRef.current?.setLevel(HABITUATION.level, { rampS: HABITUATION.downS });
      }, HABITUATION.afterMs);
    };
    const habitStop = () => {
      window.clearTimeout(h.timer);
      h.timer = undefined;
      h.lowered = false;
      h.phase = "";
    };
    const habitPhase = (phase: string) => {
      if (phase === h.phase) return;
      h.phase = phase;
      if (h.lowered) voiceRef.current?.setLevel(1, { rampS: HABITUATION.upS });
      h.lowered = false;
      habitArm();
    };

    /* ── Übergänge ─────────────────────────────────────── */

    const toIdle = () => {
      if (stateRef.current.mode === "idle") return;
      clearTimers();
      habitStop();
      stopVoice(0.15);
      bedStop(0.3);
      releaseChord();
      if (stateRef.current.showMark) replaceModel(freqNow());
      target(REFERENCES.b1919.freqHz, CONTROL.idle);
      setMode("idle", { heard: null, showMark: false });
    };

    const toInstalled = () => {
      clearTimers();
      habitStop();
      stopVoice(0.15);
      bedStop(0.3);
      releaseChord();
      replaceModel(F_STAR);
      target(F_STAR, CONTROL.done);
      setMode("installed", { heard: null, showMark: true, reference: "j0437" });
    };

    const endRelock = () => {
      if (stateRef.current.mode !== "relock") return;
      setMode("installing", { heard: heardAs(freqNow()) });
    };

    const onInstallStart = (retry: boolean) => {
      clearTimers();
      releaseChord();
      if (!retry) lastX.current = 0;
      const s = stateRef.current;
      const fB = REFERENCES.b1919.freqHz;
      if (!retry && (s.showMark || Math.abs(ln(freqNow() / fB)) > 0.05)) replaceModel(fB);
      if (!retry) target(fB, CONTROL.install);
      // Fortsetzen: sofort auf den letzten Stand hochdrehen (läuft während „Rastet ein …“, kein Stillstand auf B1919)
      else target(1 / periodForProgress(lastX.current), CONTROL.install);
      habitStop();
      if (retry) {
        // Fortsetzen: „Rastet ein …“, Rauschbett sucht 1800 → 1042 Hz, nach 300 ms Puls und Stimme.
        // Der Tag steht mindestens 800 ms bzw. bis zum ersten echten Fortschritt (x ≥ letzter Stand).
        setMode("relock", { heard: null, showMark: false });
        relock.current = { minDone: false, progressed: false, atX: lastX.current };
        bedSet(-40, 0.02, 1800, 4);
        bed().follow(relockCurve(), { at: now() + 0.02, durS: 0.3 });
        later(() => {
          sound.pulse({ timbre: "radio", gainDb: -16 });
          bedStop(0.1);
          startVoice(0.1);
          patch({ heard: heardAs(freqNow()) });
          habitPhase(flowRef.current.progress?.phase ?? "resume");
        }, RELOCK_MS);
        later(() => {
          relock.current.minDone = true;
          if (relock.current.progressed) endRelock();
        }, RELOCK_TAG_MS);
        later(endRelock, RELOCK_TAG_MAX_MS);
        return;
      }
      setMode("installing", { heard: heardAs(freqNow()), showMark: false });
      startVoice(0.01);
      bedSet(installNoiseDb(0) ?? -46, 0.3);
      habitPhase("connect");
    };

    const onProgress = (p: Progress) => {
      const mode = stateRef.current.mode;
      if (mode !== "installing" && mode !== "relock") return;
      const x = driveFor("install", { progress: p, unProgress: null });
      target(1 / periodForProgress(x), CONTROL.install);
      if (mode === "relock" && p.phase !== "connect" && x >= relock.current.atX - 1e-9) {
        relock.current.progressed = true;
        if (relock.current.minDone) endRelock();
      }
      if (p.phase !== "connect") lastX.current = x;
      if (mode === "installing") {
        const db = installNoiseDb(x);
        if (db === null) bedStop(0.6);
        else bedSet(db, 0.3);
        habitPhase(p.phase);
      }
    };

    const onError = (code: ErrorCode) => {
      clearTimers();
      habitStop();
      // Stern dreht mit der Ist-Frequenz weiter (eingefroren, ohne Sprung auf die Zielfrequenz)
      const st = stateRef.current.mode;
      if (st === "installing" || st === "relock") {
        const m = modelRef.current;
        const t = now();
        const fx = m.freqAt(t);
        replaceModel(fx, m.phaseAt(t));
        target(fx, CONTROL.install);
      } else target(freqNow(), CONTROL.install);
      setMode("error", { errorCode: code, heard: null });
      sound.play("error");
      const v = voiceRef.current;
      if (v) {
        v.setDropout(1, { rampS: ERROR_TIMING.dropoutRampS });
        later(() => {
          v.stop({ fadeS: 0.1 });
          later(() => v.setDropout(0), 200);
        }, ERROR_TIMING.voiceStopMs);
      }
      bedSet(ERROR_TIMING.bedDb, 0.1);
      later(() => bedStop(ERROR_TIMING.bedFadeS), ERROR_TIMING.bedHoldMs);
    };

    const onHalt = () => {
      clearTimers();
      habitStop();
      target(REFERENCES.b1919.freqHz, CONTROL.halt);
      setMode("halted", { heard: voiceRef.current?.active ? heardAs(freqNow()) : null });
      bedStop(0.6);
      later(() => {
        stopVoice(HALT_TIMING.voiceFadeS);
        patch({ heard: null });
      }, HALT_TIMING.voiceStopMs);
    };

    const onDone = () => {
      clearTimers();
      habitStop();
      bedStop(0.3);
      const update = flowRef.current.isUpdate;
      target(F_STAR, CONTROL.done);
      releaseChord(0.1);
      chordRef.current = sound.chord({ holdS: update ? 1.2 : 2.4, releaseTauS: update ? 0.4 : 0.7 });
      const v = voiceRef.current;
      later(() => v?.setLevel(0, { rampS: DONE_TIMING.voiceFadeS }), DONE_TIMING.voiceFadeAtMs);
      later(() => v?.stop({ fadeS: 0.05 }), DONE_TIMING.voiceStopMs);
      const relAt = update ? DONE_TIMING.updateChordReleaseMs : DONE_TIMING.chordReleaseMs;
      const relTau = update ? DONE_TIMING.updateChordReleaseTau : DONE_TIMING.chordReleaseTau;
      later(() => {
        chordRef.current?.release({ tauS: relTau });
        chordRef.current = null;
      }, relAt);
      later(() => patch({ heard: null }), relAt + 3 * relTau * 1000);
      if (reducedRef.current) {
        // Stroboskop und Wandlung sofort als Endbild
        setMode("installed", { heard: "chord", showMark: true, reference: "j0437" });
        return;
      }
      setMode("strobe", { heard: "chord", reference: "j0437" });
      later(() => {
        if (stateRef.current.mode === "strobe") setMode("installed", { showMark: true, reference: "j0437" });
      }, DONE_TIMING.morphEndMs);
    };

    const onUninstallStart = () => {
      clearTimers();
      habitStop();
      releaseChord();
      bedStop(0.1);
      if (Math.abs(ln(freqNow() / F_STAR)) > 0.05 || !stateRef.current.showMark) replaceModel(F_STAR);
      target(F_STAR, CONTROL.install);
      startVoice(0.15);
      const heard = heardAs(F_STAR);
      // Kein Zeichen sichtbar (z. B. „Erneut versuchen“ nach einem Fehler): ohne Wandlung Zeichen → Stern
      if (reducedRef.current || !stateRef.current.showMark) {
        setMode("uninstalling", { heard, showMark: false, reference: "j0437" });
        return;
      }
      setMode("release", { heard, showMark: false, reference: "j0437" });
      later(() => {
        if (stateRef.current.mode === "release") setMode("uninstalling");
      }, UNINSTALL_TIMING.morphMs + UNINSTALL_TIMING.strobeOpenMs);
    };

    const onUnProgress = (p: UninstallProgress) => {
      const mode = stateRef.current.mode;
      if (mode !== "release" && mode !== "uninstalling") return;
      const x = Math.min(1, Math.max(0, 1 - p.percent / 100));
      target(1 / periodForProgress(x), CONTROL.install);
    };

    const onUnDone = (d: UninstallDone) => {
      clearTimers();
      habitStop();
      // Pulse mit Vorlauf, damit der erste nicht in der Vergangenheit liegt (Abstände bleiben exakt)
      const td = now() + PULSE_LEAD_S;
      target(DECAY_FREQ, CONTROL.decay);
      stopVoice(0.05);
      const [p1, p2, p3] = UNINSTALL_TIMING.pulsesMs;
      sound.pulse({ timbre: "radio", gainDb: -14, at: td + p1 / 1000 });
      sound.pulse({ timbre: "radio", gainDb: -20, at: td + p2 / 1000 });
      if (d.revertOk) {
        sound.pulse({ timbre: "soft", gainDb: -28, at: td + p3 / 1000 });
        // Rauschen steigt −44 → −34 dBFS, bei 3400 Ausklang; der 4. Puls bleibt aus (Lücke)
        later(() => {
          bedSet(-44, 0.01);
          bedSet(-34, (UNINSTALL_TIMING.noiseRiseToMs - UNINSTALL_TIMING.noiseRiseFromMs) / 1000);
        }, UNINSTALL_TIMING.noiseRiseFromMs);
        later(() => bedStop(UNINSTALL_TIMING.noiseFadeS), UNINSTALL_TIMING.noiseRiseToMs);
      } else {
        later(() => sound.play("notify", { gain: 0.5 }), UNINSTALL_TIMING.notifyMs);
      }
      if (reducedRef.current) {
        setMode("lost", { heard: null, showMark: false });
        return;
      }
      // Bild-Zeitachse = Ton-Zeitachse (t_d); „Signal verloren“ erst nach dem Zerfall
      setMode("decay", { heard: null, showMark: false, modeSince: td });
      later(() => {
        if (stateRef.current.mode === "decay") setMode("lost");
      }, UNINSTALL_TIMING.decayToMs + PULSE_LEAD_S * 1000);
    };

    const onStep = (step: string) => {
      if (step === "welcome" || step === "folder" || step === "options") toIdle();
      else if (step === "maintenance" || step === "un-confirm") toInstalled();
    };

    const off = flowRef.current.onEvent((e: FlowEvent) => {
      switch (e.type) {
        case "flow://step":
          onStep(e.step);
          break;
        case "flow://install-start":
          onInstallStart(e.retry);
          break;
        case "install://progress":
          onProgress(e.payload);
          break;
        case "install://error":
          if (e.payload.code === "cancelled") onHalt();
          else onError(e.payload.code);
          break;
        case "install://done":
          onDone();
          break;
        case "flow://uninstall-start":
          onUninstallStart();
          break;
        case "uninstall://progress":
          onUnProgress(e.payload);
          break;
        case "uninstall://done":
          onUnDone(e.payload);
          break;
        case "uninstall://error":
          onError("unknown");
          break;
      }
    });

    // Falls der Schirm erst nach einem Schritt erscheint (z. B. Neuladen in der Wartung)
    onStep(flowRef.current.step);

    // Referenz, „Hörbar als“ und Aufräumen des Modells: 10 Hz, Zustand nur bei Änderung
    const poll = window.setInterval(() => {
      const s = stateRef.current;
      const m = modelRef.current;
      const t = now();
      m.prune(t - 3);
      if (s.showMark || s.mode === "strobe") return;
      const f = m.freqAt(t);
      // Referenz aus dem Ziel des Antriebs (nicht aus dem nachlaufenden Modell)
      const fRef = s.mode === "installing" || s.mode === "relock" || s.mode === "error" || s.mode === "release" || s.mode === "uninstalling" ? targetF.current : f;
      const reference: RefId = nearestReference(1 / fRef);
      const heard = s.heard === "chord" ? "chord" : voiceModes(s.mode) && (s.mode !== "halted" || s.heard !== null) ? heardAs(f) : s.heard;
      if (reference !== s.reference || heard !== s.heard) patch({ reference, heard });
    }, 100);

    return () => {
      off();
      window.clearInterval(poll);
      clearTimers();
      habitStop();
      // StrictMode/Unmount: alle Quellen stoppen (idempotent)
      voiceRef.current?.dispose();
      voiceRef.current = null;
      releaseChord(0.05);
      bedStop(0.05);
    };
    // Einmal je Mount; aktuelle Werte kommen über Refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
