import { create } from "zustand";
import { listen } from "@/lib/api";
import {
  SONAR_ACCENT,
  SONAR_FADE_S,
  SONAR_LEVEL_RAMP_S,
  SONAR_PREVIEW_MS,
  SONAR_PREVIEW_PERIOD_MS,
  alertDecision,
  emptyAlertMemo,
  sonarAlertLevel,
  sonarGain,
  sonarParams,
  sonarPreviewSeries,
  sonarSettings,
  type AlertMemo,
  type SonarPreviewKind,
} from "@/lib/sonar";
import type { LagEvent, PingSample, SonarParams } from "@/lib/types";
import { sound, type PulseEvent, type PulseVoice } from "@shared/sound/engine";
import { useLibrary } from "./library";
import { useNet } from "./net";
import { useSettings } from "./settings";

/**
 * Zustand „Hör dein Netz“ (Vertrag: docs/API.md, „Hör dein Netz“). Nur im Hauptfenster (das Overlay lädt diesen
 * Store nicht). Der Ton startet nur per Klick (Autoplay-Regel) und stoppt beim Ausschalten, bei `document.hidden`
 * und wenn der Monitor stoppt. Ob er läuft, wird nicht gespeichert.
 *
 * Abbildung auf die Engine (PulseVoice E.11): Periode → `setPeriod`, Zittern → `setJitter`, Verlust → `skipNext`,
 * Ausreißer → `accentNext(1,5)`, Pegel → `setLevel` (Rampe 30 ms), Tonstufe → `setStep` (Harmonische von 173,7 Hz),
 * Ein/Aus → `start`/`stop` (100 ms), danach `dispose`. Warnton → `sound.alertTone`.
 */
export interface SonarPulse {
  /** fortlaufend – ändert sich bei jedem Puls (für die Pegelanzeige) */
  seq: number;
  /** Pegel 0–1 dieses Pulses (betont bis 1) */
  level: number;
  /** Aussetzer (Verlust): Stille statt Ton */
  dropped: boolean;
}

export interface SonarStoreState {
  /** „Hör dein Netz“ läuft (Live-Ping) */
  on: boolean;
  /** laufender Probe-Knopf (Einstellungen) */
  preview: SonarPreviewKind | null;
  /** zuletzt erklungener Puls – null, solange keiner kam */
  pulse: SonarPulse | null;
  /** Pulse seit dem letzten Start (Live oder Probe) */
  pulses: number;
  /** Aussetzer seit dem letzten Start */
  drops: number;
  /** Audio-Kontext läuft (false: Ton von Browser/WebView blockiert oder nicht vorhanden) */
  audible: boolean;
  /** Warnton-Hörer (`net://lag`) eingerichtet */
  ready: boolean;
  /** Warnton-Hörer einrichten (einmalig, nur im Hauptfenster) */
  init: () => Promise<void>;
  /** An/aus (nur aus einem Klick heraus aufrufen) */
  toggle: () => void;
  start: () => void;
  stop: () => void;
  /** Probe-Knopf: 4 s Beispielwerte */
  playPreview: (kind: SonarPreviewKind) => void;
  stopPreview: () => void;
}

/** Erster Puls so weit nach dem Klick (s) – sonst verfällt er, wenn das Rendern nach dem Klick länger dauert */
const START_LEAD_S = 0.08;
/** Ohne neue Messung so lange (× Messabstand) → Pulse fallen aus (keine erfundenen Töne) */
const STALE_FACTOR = 2.5;

let voice: PulseVoice | null = null;
let offPulse: (() => void) | null = null;
let disposeTimer: ReturnType<typeof setTimeout> | null = null;
let liveOff: (() => void) | null = null;
let previewTimers: ReturnType<typeof setTimeout>[] = [];
let lastApplied: { periodMs: number; jitter: number; step: number | null; gain: number } | null = null;
let lastSampleAt = 0;
let alertMemo: AlertMemo = emptyAlertMemo();
let initStarted: Promise<void> | null = null;

const timeoutNow = (fn: () => void, ms: number) => setTimeout(fn, Math.max(0, ms));

function ensureVoice(periodMs: number): PulseVoice {
  if (disposeTimer) {
    clearTimeout(disposeTimer);
    disposeTimer = null;
  }
  if (voice) return voice;
  sound.warmup();
  const v = sound.createVoice({ timbre: "radio", tone: false, loudnessComp: false, gainDb: -20, periodS: periodMs / 1000 });
  voice = v;
  lastApplied = null;
  offPulse = v.onPulse(onPulse);
  return v;
}

/** Stimme ausblenden (≤ 150 ms) und danach freigeben */
function releaseVoice() {
  const v = voice;
  if (!v) return;
  v.stop({ fadeS: SONAR_FADE_S });
  if (disposeTimer) clearTimeout(disposeTimer);
  disposeTimer = timeoutNow(() => {
    disposeTimer = null;
    if (voice !== v) return;
    offPulse?.();
    offPulse = null;
    v.dispose();
    voice = null;
    lastApplied = null;
  }, SONAR_FADE_S * 1000 + 150);
}

/** Pulse-Ereignis der Stimme (beim Planen, bis zu ~0,3 s vor dem Klang) → Pegelanzeige zum Klang-Zeitpunkt */
function onPulse(e: PulseEvent) {
  const st = useSonar.getState();
  if (!st.on && !st.preview) return;
  // keine frische Messung mehr (Monitor hängt) → nächste Pulse fallen aus statt „stabil“ vorzutäuschen
  if (st.on) {
    const interval = useSettings.getState().settings.pingIntervalMs;
    if (Date.now() - lastSampleAt > STALE_FACTOR * interval) voice?.skipNext();
  }
  const delay = (e.atModel - sound.clock.now()) * 1000;
  timeoutNow(() => {
    const s = useSonar.getState();
    if (!s.on && !s.preview) return;
    useSonar.setState({
      pulse: { seq: (s.pulse?.seq ?? 0) + 1, level: e.dropped ? 0 : e.level, dropped: e.dropped },
      pulses: s.pulses + 1,
      drops: s.drops + (e.dropped ? 1 : 0),
    });
  }, delay);
}

/** Klang-Parameter einer Messung auf die Stimme anwenden */
function apply(v: PulseVoice, p: SonarParams, withEvents: boolean) {
  const prev = lastApplied;
  if (!prev || prev.periodMs !== p.periodMs) v.setPeriod(p.periodMs / 1000);
  if (!prev || prev.jitter !== p.jitter) v.setJitter(p.jitter);
  if (!prev || prev.step !== p.step) v.setStep(p.step);
  if (!prev || prev.gain !== p.gain) v.setLevel(p.gain, { rampS: SONAR_LEVEL_RAMP_S });
  lastApplied = { periodMs: p.periodMs, jitter: p.jitter, step: p.step, gain: p.gain };
  if (!withEvents) return;
  if (p.drop) v.skipNext();
  else if (p.accent) v.accentNext(SONAR_ACCENT);
}

/** Neue Messungen des Hauptziels → Stimme */
function feedLive(samples: PingSample[], fromIndex: number) {
  const v = voice;
  if (!v) return;
  const { settings } = useSettings.getState();
  const stats = useNet.getState().stats;
  for (let i = Math.max(0, fromIndex); i < samples.length; i++) {
    const window = samples.slice(Math.max(0, i - 59), i + 1).map((s) => s.rtt);
    apply(v, sonarParams(samples[i], window, stats, settings), true);
  }
  lastSampleAt = Date.now();
}

function clearPreviewTimers() {
  for (const t of previewTimers) clearTimeout(t);
  previewTimers = [];
}

export const useSonar = create<SonarStoreState>((set, get) => ({
  on: false,
  preview: null,
  pulse: null,
  pulses: 0,
  drops: 0,
  audible: true,
  ready: false,

  init: () => {
    if (!initStarted) {
      initStarted = (async () => {
        try {
          await listen<LagEvent>("net://lag", (ev) => {
            const decision = alertDecision(ev, alertMemo, {
              settings: useSettings.getState().settings,
              gameRunning: useLibrary.getState().running.size > 0,
              now: Date.now(),
            });
            alertMemo = decision.memo;
            // auch wenn Pulsar im Hintergrund liegt (sofern WebView2 dann Ton spielt – von Hand auf Windows prüfen)
            if (decision.play) sound.alertTone(sonarAlertLevel(useSettings.getState().settings), { whileHidden: true });
          });
        } catch (e) {
          console.warn("Hör dein Netz (Warnton):", e);
        }
        sound.onAvailabilityChange((a) => set({ audible: a }));
        set({ ready: true });
      })();
    }
    return initStarted;
  },

  toggle: () => (get().on ? get().stop() : get().start()),

  start: () => {
    if (get().on) return;
    const net = useNet.getState();
    if (!net.monitorOn) return;
    if (get().preview) get().stopPreview();
    if (typeof document !== "undefined" && document.hidden) return;
    const { settings } = useSettings.getState();
    const v = ensureVoice(settings.pingIntervalMs);
    // Ausgangslage aus der letzten Messung (ohne Aussetzer/Betonung – die gehörten zu einem früheren Puls)
    const last = net.samples[net.samples.length - 1];
    if (last) apply(v, sonarParams(last, net.samples.slice(-60).map((s) => s.rtt), net.stats, settings), false);
    else apply(v, sonarParams({ rtt: null }, [], net.stats, settings), false);
    lastSampleAt = last ? Date.now() : 0;
    set({ on: true, pulse: null, pulses: 0, drops: 0 });
    v.start({ fadeS: SONAR_FADE_S, atModel: sound.clock.now() + START_LEAD_S });
    // Läuft der Audio-Kontext? (blockiert z. B. ohne Nutzeraktion oder ohne Audiogerät)
    timeoutNow(() => {
      if (get().on) set({ audible: sound.available });
    }, 1000);

    let seenLast = last;
    const offNet = useNet.subscribe((s, prev) => {
      if (!s.monitorOn) {
        get().stop();
        return;
      }
      if (s.samples === prev.samples) return;
      const tail = s.samples[s.samples.length - 1];
      if (!tail || tail === seenLast) return;
      // neue Werte hinter dem zuletzt gesehenen (Messziel gewechselt → Liste neu: nur der neueste Wert)
      const idx = seenLast ? s.samples.lastIndexOf(seenLast) : -1;
      seenLast = tail;
      feedLive(s.samples, idx >= 0 ? idx + 1 : s.samples.length - 1);
    });
    const offSettings = useSettings.subscribe((s, prev) => {
      const a = s.settings;
      const b = prev.settings;
      if (a.sound === b.sound && a.volume === b.volume && a.sonar === b.sonar) return;
      const vv = voice;
      if (!vv || !lastApplied) return;
      const gain = sonarGain(a);
      const step = sonarSettings(a).pitch ? lastApplied.step : null;
      apply(vv, { ...lastApplied, gain, step, drop: false, accent: false }, false);
    });
    const onVis = () => {
      if (document.hidden) get().stop();
    };
    document.addEventListener("visibilitychange", onVis);
    liveOff = () => {
      offNet();
      offSettings();
      document.removeEventListener("visibilitychange", onVis);
    };
  },

  stop: () => {
    liveOff?.();
    liveOff = null;
    if (!get().on) return;
    set({ on: false, pulse: null });
    releaseVoice();
  },

  playPreview: (kind) => {
    if (get().on) get().stop();
    clearPreviewTimers();
    const series = sonarPreviewSeries(kind);
    const base = useSettings.getState().settings;
    // Beispielwerte im 500-ms-Takt, sonst die echten Einstellungen (Lautstärke, Tonhöhe, Stummschaltung)
    const settings = { ...base, pingIntervalMs: SONAR_PREVIEW_PERIOD_MS };
    const v = ensureVoice(SONAR_PREVIEW_PERIOD_MS);
    const window: (number | null)[] = [...series.history];
    const feed = (i: number, withEvents: boolean) => {
      const rtt = series.rtts[i] ?? null;
      window.push(rtt);
      apply(v, sonarParams({ rtt }, window.slice(-60), { jitter: series.jitterMs }, settings), withEvents);
      if (kind === "alert" && withEvents && rtt !== null && rtt > 100) {
        // Warnton zum betonten Puls (der Wert gilt für den nächsten noch nicht geplanten Puls)
        previewTimers.push(timeoutNow(() => sound.alertTone(sonarAlertLevel(base)), SONAR_PREVIEW_PERIOD_MS - 120));
      }
    };
    lastApplied = null;
    feed(0, true);
    set({ preview: kind, pulse: null, pulses: 0, drops: 0 });
    v.start({ fadeS: SONAR_FADE_S, atModel: sound.clock.now() + START_LEAD_S });
    // Messwert i wirkt auf Puls i (Nennzeit i·500 + 80 ms): vorher einspeisen – geplant wird frühestens 295 ms davor (Lookahead + Zittern)
    for (let i = 1; i < series.rtts.length; i++) {
      previewTimers.push(timeoutNow(() => feed(i, true), i * SONAR_PREVIEW_PERIOD_MS - 350));
    }
    // nach dem 8. Puls (Nennzeit 3,58 s, mit Zittern bis 3,73 s) ausblenden, bevor ein 9. geplant wird (frühestens 3,82 s)
    previewTimers.push(timeoutNow(() => get().stopPreview(), SONAR_PREVIEW_MS - 250));
  },

  stopPreview: () => {
    clearPreviewTimers();
    if (!get().preview) return;
    set({ preview: null, pulse: null });
    if (!get().on) releaseVoice();
  },
}));
