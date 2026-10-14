/**
 * Intro „Signalsuche“ (C.1, D): Himmelskarte, Rauschen, Faltfrequenz-Regler, zwei Echtzeit-Pulse
 * im Abstand 1337,3 ms, gekennzeichneter Zeitraffer, Ridgeline mit Σ, Faltung zum Zeichen.
 * Bild und Ton lesen dieselbe Tabelle (`introEvents` / `introStateAt`). Werte pro Bild laufen
 * über Refs; React-State ändert sich nur bei Phasenwechseln.
 */
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { MARK_GEOMETRY, PulsarMark } from "@shared/ui/PulsarMark";
import { sound, type ChordOptions, type NoiseBed, type ScoreEvent, type Timbre } from "@shared/sound/engine";
import { dbToGain, harmonic } from "@shared/sound/dsp";
import type { SetupInfo } from "../api";
import { CanvasBoundary } from "../components/CanvasBoundary";
import { announce } from "../components/LiveRegion";
import { ObsButton } from "../components/ObsButton";
import { useFrameLoop } from "../hooks/useFrameLoop";
import { QUALITY_FPS } from "../hooks/useQuality";
import { getLang, useT } from "../i18n";
import { formatPeriod } from "../obs/format";
import {
  PULSE_MS,
  bandpassHz,
  chooseVariant,
  introEvents,
  introStateAt,
  introTimings,
  needleHzAt,
  skipState,
  type IntroPhase,
  type IntroState,
  type IntroVariant,
} from "../obs/introTimeline";
import { INTRO_MARK_CENTER, INTRO_MARK_SIZE, ROWS, ROW_DY, ROW_Y0, SUM_Y } from "../obs/ridgeline";
import type { Quality } from "../obs/types";
import { IntroCanvas, type IntroCanvasHandle } from "./IntroCanvas";
import { SkyGrid } from "./SkyGrid";
import { Tuner, type TunerHandle } from "./Tuner";

export interface IntroScreenProps {
  info: SetupInfo | null;
  reduced: boolean;
  quality: Quality;
  onExit(): void;
}

/* ── reine Helfer (getestet) ────────────────────────────── */

/** Wie lange auf `setupInfo` gewartet wird, bevor die Vollfassung gilt (D.5) */
export const VARIANT_WAIT_MS = 250;
/** Überspringen: Bild springt in 150 ms, Ausgang nach 350 ms (D.7) */
export const SKIP_JUMP_MS = 150;
export const SKIP_EXIT_MS = 350;
/** Halten ohne `setupInfo` (D.8): Puls −30 dBFS, Kern 0,8 → 1 für 80 ms */
export const HOLD_PULSE_DB = -30;
const HOLD_BLINK_MS = 80;
/** Pegel des Rastklicks `tick` (Rezept −30) → −42 dBFS */
const TICK_RECIPE_DB = -30;
/** Pegel der Teiltöne 2 und 4 zum Schlusspuls */
const FINAL_PARTIALS = { partials: [2, 4], levelsDb: [-30, -32], attacksS: [0.004, 0.004], holdS: 0.004, releaseTauS: 0.14 } as const;

/**
 * Löst die Taste das Überspringen aus? Esc, Enter, Leertaste und jede druckbare Taste;
 * ausgenommen Tab, reine Modifier, Tastenkürzel und M (Ton).
 */
export function isSkipKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = e.key;
  if (k === "m" || k === "M") return false;
  if (k === "Escape" || k === "Enter" || k === " " || k === "Spacebar") return true;
  return [...k].length === 1;
}

/** Was die Partitur von der Engine braucht (für Tests austauschbar) */
export interface IntroSound {
  pulse(o: { timbre?: Timbre; gainDb?: number; at?: number; reverb?: boolean }): void;
  play(name: "tick", o: { at?: number; gain?: number }): void;
  chord(o: ChordOptions): unknown;
  noiseBed(): NoiseBed;
  /** Modellzeit (s) */
  now(): number;
  /** verzögerter Rückruf (Rauschbett-Stopp genau zur Zeit) */
  later(ms: number, fn: () => void): void;
}

/** Die Intro-Partitur: jedes Ereignis aus `introEvents(v)` wird ein Klang-Aufruf zur Modellzeit */
export function buildIntroScore(v: IntroVariant, snd: IntroSound): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  for (const ev of introEvents(v)) {
    const at = ev.at / 1000;
    switch (ev.kind) {
      case "noise-in":
        out.push({ at, run: (m) => snd.noiseBed().set({ levelDb: ev.gainDb ?? -34, centerHz: bandpassHz(needleHzAt(ev.at, v)), q: 4, glideS: 0.3, at: m }) });
        break;
      case "search": {
        const dur = ev.durMs ?? 0;
        const curve = new Float32Array(48);
        for (let i = 0; i < curve.length; i++) curve[i] = bandpassHz(needleHzAt(ev.at + (dur * i) / (curve.length - 1), v));
        out.push({ at, run: (m) => snd.noiseBed().follow(curve, { at: m, durS: dur / 1000 }) });
        break;
      }
      case "lock":
        out.push({ at, run: (m) => snd.noiseBed().set({ levelDb: ev.gainDb ?? -44, centerHz: harmonic(6), q: 0.7, glideS: (ev.durMs ?? 200) / 1000, at: m }) });
        break;
      case "tick":
        out.push({ at, run: (m) => snd.play("tick", { at: m, gain: dbToGain((ev.gainDb ?? -42) - TICK_RECIPE_DB) }) });
        break;
      case "pulse":
        out.push({ at, run: (m) => snd.pulse({ timbre: "radio", gainDb: ev.gainDb ?? -14, at: m }) });
        break;
      case "noise-stop":
        out.push({
          at,
          run: (m) => {
            const fadeS = (ev.durMs ?? 600) / 1000;
            snd.later(Math.max(0, (m - snd.now()) * 1000), () => snd.noiseBed().stop({ fadeS }));
          },
        });
        break;
      case "final":
        out.push({
          at,
          run: (m) => {
            snd.pulse({ timbre: "radio", gainDb: ev.gainDb ?? -18, at: m, reverb: v !== "reducedShort" });
            if (v !== "reducedShort") snd.chord({ ...FINAL_PARTIALS, partials: [...FINAL_PARTIALS.partials], levelsDb: [...FINAL_PARTIALS.levelsDb], attacksS: [...FINAL_PARTIALS.attacksS], reverb: true, at: m });
          },
        });
        break;
      default:
        break; // acquired / exit / end: nur Bild
    }
  }
  return out;
}

/* ── Panel (C.1): Rahmen, Achse, Zeilennummern, Σ ───────── */
const MONO10 = { fontFamily: "var(--obs-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", fill: "var(--obs-fg-3)" } as const;
const AXIS_TICKS = Array.from({ length: 17 }, (_, i) => -80 + 10 * i);
const LABELED_ROWS = [1, 4, 8, 12, 16];
const AXIS_Y = 386.5;

function minus(n: number): string {
  return n < 0 ? `−${-n}` : n > 0 ? `+${n}` : "0";
}

function Panel({ labelRef, countRef }: { labelRef: RefObject<SVGTextElement | null>; countRef: RefObject<SVGTextElement | null> }) {
  const t = useT();
  return (
    <svg aria-hidden width={980} height={560} viewBox="0 40 980 560" className="pointer-events-none absolute top-0 left-0" data-testid="intro-panel">
      <rect x={210.5} y={88.5} width={559} height={323} fill="var(--obs-bg)" stroke="var(--obs-rule-strong)" strokeWidth={1} style={{ shapeRendering: "crispEdges" }} />
      <g style={MONO10}>
        <text x={222} y={96} dominantBaseline="hanging">
          {t("intro.profile").toUpperCase()}
        </text>
        <text ref={labelRef} x={758} y={96} dominantBaseline="hanging" textAnchor="end" data-testid="intro-rate" />
        {LABELED_ROWS.map((k) => (
          <text key={k} x={222} y={ROW_Y0 + ROW_DY * (k - 1)}>
            {String(k).padStart(2, "0")}
          </text>
        ))}
        <text ref={countRef} x={736} y={SUM_Y} data-testid="intro-count">
          00
        </text>
      </g>
      <text x={222} y={SUM_Y} style={{ fontFamily: "var(--obs-sans)", fontSize: 11, fontWeight: 600, fill: "var(--obs-fg-2)" }}>
        Σ
      </text>
      {/* Achse −80…+80 ms, 3 px/ms; Hauptstriche alle 40 ms */}
      <g style={{ shapeRendering: "crispEdges" }}>
        <line x1={250} y1={AXIS_Y} x2={730} y2={AXIS_Y} stroke="var(--obs-rule-strong)" strokeWidth={1} />
        {AXIS_TICKS.map((ms) => {
          const x = 490 + 3 * ms + 0.5;
          const major = ms % 40 === 0;
          return <line key={ms} x1={x} y1={AXIS_Y} x2={x} y2={AXIS_Y - (major ? 8 : 4)} stroke="var(--obs-fg-3)" strokeOpacity={major ? 1 : 0.6} strokeWidth={1} />;
        })}
      </g>
      <g style={MONO10}>
        {[-80, -40, 0, 40, 80].map((ms) => (
          <text key={ms} x={490 + 3 * ms} y={391} dominantBaseline="hanging" textAnchor="middle">
            {minus(ms)}
            {ms === 80 ? " ms" : ""}
          </text>
        ))}
        <text x={670} y={391} dominantBaseline="hanging" textAnchor="middle">
          {t("intro.phase").toUpperCase()}
        </text>
      </g>
    </svg>
  );
}

/* ── Intro ──────────────────────────────────────────────── */
type Stage = { phase: IntroPhase; acquired: boolean; folded: boolean };

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const CORE_PX = (MARK_GEOMETRY.CORE_R * INTRO_MARK_SIZE) / MARK_GEOMETRY.VIEWBOX;

export function IntroScreen({ info, reduced, quality, onExit }: IntroScreenProps) {
  const t = useT();

  // Zeitbasis: t = 0 beim ersten Bild nach dem Mount (StrictMode-fest über Refs)
  const t0Ms = useRef<number | null>(null);
  const t0Model = useRef(0);
  if (t0Ms.current === null) {
    t0Ms.current = performance.now();
    t0Model.current = sound.clock.now();
  }
  const nowT = useCallback(() => performance.now() - (t0Ms.current ?? 0), []);
  const modelAt = useCallback((tIntro: number) => t0Model.current + tIntro / 1000, []);

  const infoRef = useRef(info);
  infoRef.current = info;
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  // Variante (D.5): auf setupInfo höchstens 250 ms warten
  const [variant, setVariant] = useState<IntroVariant | null>(null);
  const variantRef = useRef<IntroVariant | null>(null);
  variantRef.current = variant;
  const decide = useCallback(() => {
    if (variantRef.current) return variantRef.current;
    const si = infoRef.current;
    const v = chooseVariant({ reduced, mode: si?.mode, preset: Boolean(si?.preset) });
    variantRef.current = v;
    setVariant(v);
    return v;
  }, [reduced]);
  useEffect(() => {
    if (variant) return;
    if (info) {
      decide();
      return;
    }
    const id = window.setTimeout(decide, Math.max(0, VARIANT_WAIT_MS - nowT()));
    return () => window.clearTimeout(id);
  }, [info, variant, decide, nowT]);

  // Partitur (Ton) aus derselben Tabelle; Aufräumen stoppt alle Quellen
  const scoreRef = useRef<{ cancel(o?: { fadeS?: number }): void } | null>(null);
  useEffect(() => {
    if (!variant) return;
    const snd: IntroSound = {
      pulse: (o) => sound.pulse(o),
      play: (n, o) => sound.play(n, o),
      chord: (o) => sound.chord(o),
      noiseBed: () => sound.noiseBed(),
      now: () => sound.clock.now(),
      later: (ms, fn) => void window.setTimeout(fn, ms),
    };
    const h = sound.score(buildIntroScore(variant, snd), t0Model.current);
    scoreRef.current = h;
    if (import.meta.env.DEV) {
      const p = introEvents(variant).filter((e) => e.kind === "pulse" || e.kind === "final");
      if (p.length >= 2) console.debug(`[intro] ${variant}: Puls 1 → Puls 2 = ${(p[1].at - p[0].at).toFixed(1)} ms`);
    }
    return () => {
      h.cancel({ fadeS: 0.04 });
      scoreRef.current = null;
      try {
        if (variant === "full" || variant === "short") sound.noiseBed().stop({ fadeS: 0.08 });
      } catch {
        /* Audio blockiert nie */
      }
    };
  }, [variant]);

  // Ebenen per Ref
  const rootRef = useRef<HTMLElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tunerLayerRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<SVGCircleElement>(null);
  const objectRef = useRef<HTMLDivElement>(null);
  const rateRef = useRef<SVGTextElement>(null);
  const countRef = useRef<SVGTextElement>(null);
  const canvasRef = useRef<IntroCanvasHandle>(null);
  const tunerRef = useRef<TunerHandle>(null);
  const skipBtnRef = useRef<HTMLButtonElement>(null);

  const [stage, setStage] = useState<Stage>({ phase: reduced ? "realtime" : "search", acquired: false, folded: false });
  const stageRef = useRef(stage);
  const [skipped, setSkipped] = useState(false);

  const run = useRef({
    skipAt: null as number | null,
    exitStarted: false,
    fadeStart: null as number | null,
    exitCalled: false,
    holding: false,
    holdBase: 0,
    holdScheduled: -1,
    lastHoldPulse: -Infinity,
    lastRate: "",
    lastCount: -1,
  });

  const callExit = useCallback(() => {
    const R = run.current;
    if (R.exitCalled) return;
    R.exitCalled = true;
    exitRef.current();
  }, []);

  /** Überspringen (D.7) */
  const skip = useCallback(() => {
    const R = run.current;
    const tt = nowT();
    if (R.skipAt !== null || R.exitStarted) return;
    const v = decide();
    if (tt >= introTimings(v).exitAt) return;
    R.skipAt = tt;
    scoreRef.current?.cancel({ fadeS: 0.04 });
    try {
      sound.noiseBed().stop({ fadeS: 0.08 });
    } catch {
      /* ignorieren */
    }
    sound.pulse({ timbre: "radio", gainDb: -24 });
    R.holdBase = tt; // Halte-Pulse phasenrichtig zum Quittungspuls
    announce(t("a11y.skipped"));
    setSkipped(true);
  }, [decide, nowT, t]);

  // Tastatur: Esc, Enter, Leertaste, druckbare Tasten; Tab fokussiert „Überspringen“
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const a = document.activeElement;
        if (!a || a === document.body) {
          const b = skipBtnRef.current;
          if (b && !b.hidden) {
            e.preventDefault();
            b.focus();
          }
        }
        return;
      }
      if (!isSkipKey(e)) return;
      // Bedienelemente der Titelleiste behalten Enter/Leertaste
      const tgt = e.target instanceof Element ? e.target : null;
      if (tgt && tgt.closest("header") && (e.key === "Enter" || e.key === " ")) return;
      e.preventDefault();
      skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [skip]);

  // Bildschleife
  const frame = useCallback(() => {
    const R = run.current;
    const tt = nowT();
    const v: IntroVariant = variantRef.current ?? (reduced ? "reduced" : "full");
    const tm = introTimings(v);
    const isReduced = v === "reduced" || v === "reducedShort";

    let s: IntroState;
    let canvasAlpha = 1;
    let chromeFade = 1;
    let exitStart = tm.exitAt;
    if (R.skipAt !== null) {
      const u = isReduced ? 1 : clamp01((tt - R.skipAt) / SKIP_JUMP_MS);
      const frozen = introStateAt(R.skipAt, v);
      const end = skipState(v);
      canvasAlpha = 1 - u;
      chromeFade = 1 - u;
      s = { ...frozen, markAlpha: Math.max(frozen.markAlpha, u), acquired: true, foldedLine: true, phase: "acquired", core: end.core };
      exitStart = R.skipAt + SKIP_EXIT_MS;
    } else {
      s = introStateAt(Math.min(tt, exitStart - 1e-3), v);
    }

    // Ausgang bzw. Halten (D.8)
    let exitE = 0;
    let phase: IntroPhase = s.phase;
    if (tt >= exitStart) {
      if (!R.exitStarted) {
        R.exitStarted = true;
        try {
          document.body.dataset.introDone = "1";
        } catch {
          /* egal */
        }
      }
      if (!infoRef.current) {
        // Endzustand halten, Pulse alle 1337,3 ms; der Ablauf darf schon weiter (Fallback-Info)
        if (!R.holding) {
          R.holding = true;
          if (R.skipAt === null) R.holdBase = tm.finalAt;
          callExit();
        }
        phase = "acquired";
      } else {
        if (R.fadeStart === null) R.fadeStart = R.holding ? tt : exitStart;
        exitE = clamp01((tt - R.fadeStart) / Math.max(1, tm.exitDur));
        phase = "exit";
        if (exitE >= 1) callExit();
      }
    }

    // Halte-Pulse vorausplanen (phasenrichtig zum Schlusspuls)
    let coreAlpha = 1;
    if (R.holding && R.fadeStart === null) {
      const k = Math.max(1, Math.ceil((tt - R.holdBase) / PULSE_MS));
      const next = R.holdBase + k * PULSE_MS;
      if (k > R.holdScheduled && next - tt < 150) {
        R.holdScheduled = k;
        sound.pulse({ timbre: "radio", gainDb: HOLD_PULSE_DB, at: modelAt(next) });
      }
      const last = R.holdBase + Math.floor((tt - R.holdBase) / PULSE_MS) * PULSE_MS;
      coreAlpha = tt - last < HOLD_BLINK_MS && tt - R.holdBase >= PULSE_MS ? 1 : 0.8;
    }

    // Ebenen
    const root = rootRef.current;
    if (root) root.style.opacity = String(1 - exitE);
    if (mapRef.current) mapRef.current.style.opacity = String(s.mapAlpha);
    const chrome = s.panelAlpha * chromeFade;
    if (panelRef.current) panelRef.current.style.opacity = String(chrome);
    if (tunerLayerRef.current) tunerLayerRef.current.style.opacity = String(chrome);
    if (objectRef.current) objectRef.current.style.opacity = String(s.mapAlpha);
    if (markRef.current) {
      markRef.current.style.opacity = String(s.markAlpha);
      markRef.current.style.transform = exitE > 0 && !isReduced ? `scale(${1 - 0.04 * exitE})` : "";
    }
    if (coreRef.current) coreRef.current.style.opacity = String(coreAlpha);
    tunerRef.current?.set(s.needleHz, s.locked);

    // Kopfzeile: ×1 Echtzeit / ×n Zeitraffer, Zähler Σ
    const rate = s.label ? (s.label.kind === "realtime" ? t("intro.realtime") : t("intro.timelapse", { n: Math.round(s.label.factor) })).toUpperCase() : "";
    if (rate !== R.lastRate && rateRef.current) {
      rateRef.current.textContent = rate;
      rateRef.current.style.fill = rate ? "var(--obs-fg-2)" : "";
      R.lastRate = rate;
    }
    if (s.sumCount !== R.lastCount && countRef.current) {
      countRef.current.textContent = String(s.sumCount).padStart(2, "0");
      R.lastCount = s.sumCount;
    }

    // Zeichenfläche
    const flicker = isReduced || quality === 0 ? 0 : Math.floor(Math.max(0, tt) / (1000 / 12));
    canvasRef.current?.draw({ s, alpha: canvasAlpha, flicker });

    // seltene State-Wechsel
    const st = stageRef.current;
    if (st.phase !== phase || st.acquired !== s.acquired || st.folded !== s.foldedLine) {
      const next = { phase, acquired: s.acquired, folded: s.foldedLine };
      stageRef.current = next;
      setStage(next);
    }
  }, [callExit, modelAt, nowT, quality, reduced, t]);

  useFrameLoop(frame, true, QUALITY_FPS[quality]);
  // erstes Bild sofort (auch wenn rAF gedrosselt ist)
  useEffect(() => {
    frame();
  }, [frame]);

  // Aufräumen beim Abbau
  useEffect(
    () => () => {
      scoreRef.current?.cancel({ fadeS: 0.04 });
    },
    [],
  );

  const lang = getLang();
  const v = variant ?? (reduced ? "reduced" : "full");
  const endState = stage.phase === "acquired" || stage.phase === "exit" || skipped;
  const folded = useMemo(() => {
    const token = "\u0001";
    const parts = t("intro.folded", { n: ROWS, p: token }).split(token);
    return { before: parts[0] ?? "", after: parts[1] ?? "", p: formatPeriod(1.3373, lang) };
  }, [t, lang]);

  return (
    <section
      ref={rootRef}
      data-testid="intro"
      data-variant={v}
      data-phase={stage.phase}
      aria-label={t("intro.aria")}
      className="absolute top-10 left-0 h-[560px] w-[980px] overflow-hidden bg-obs-bg select-none"
      onPointerDown={(e) => {
        if (e.button === 0 || e.pointerType !== "mouse") skip();
      }}
    >
      <div ref={mapRef} className="absolute inset-0" style={{ opacity: 0 }}>
        <SkyGrid />
      </div>
      <div ref={panelRef} className="absolute inset-0" style={{ opacity: 0 }}>
        <Panel labelRef={rateRef} countRef={countRef} />
      </div>
      <CanvasBoundary fallback={<div data-testid="canvas-fallback" />}>
        <IntroCanvas quality={quality} handleRef={canvasRef} />
      </CanvasBoundary>
      <div ref={tunerLayerRef} className="absolute inset-0" style={{ opacity: 0 }}>
        <Tuner handleRef={tunerRef} />
      </div>

      {/* Zeichen bei (490, 250) = Lage von CP 1919 auf der Karte */}
      <div
        ref={markRef}
        className="pointer-events-none absolute"
        style={{
          left: INTRO_MARK_CENTER[0] - INTRO_MARK_SIZE / 2,
          top: INTRO_MARK_CENTER[1] - 40 - INTRO_MARK_SIZE / 2,
          width: INTRO_MARK_SIZE,
          height: INTRO_MARK_SIZE,
          opacity: 0,
          transformOrigin: "50% 50%",
        }}
        data-testid="intro-mark"
      >
        <PulsarMark size={INTRO_MARK_SIZE} variant="rays" core={0} />
        <svg aria-hidden width={INTRO_MARK_SIZE} height={INTRO_MARK_SIZE} className="absolute inset-0">
          <circle ref={coreRef} cx={INTRO_MARK_SIZE / 2} cy={INTRO_MARK_SIZE / 2} r={CORE_PX} fill="var(--obs-signal)" />
        </svg>
      </div>

      {/* „Signal erfasst.“ y 372–404 (Live-Region besteht vorher, Text kommt bei 4500) */}
      <div role="status" className="pointer-events-none absolute inset-x-0 top-[332px] flex h-8 justify-center">
        {stage.acquired && (
          <motion.p
            className="obs-h1"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            data-testid="intro-acquired"
          >
            {t("intro.acquired")}
          </motion.p>
        )}
      </div>

      {/* Objektzeile y 428 */}
      <div ref={objectRef} className="pointer-events-none absolute inset-x-0 top-[381px] text-center" style={{ opacity: 0 }}>
        <span className="obs-label">{t("intro.object")}</span>
      </div>
      {/* Gefaltet aus 16 Rotationen · P 1,3373 s · simuliertes Profil – y 448 */}
      <div className="pointer-events-none absolute inset-x-0 top-[401px] text-center" aria-hidden={!stage.folded}>
        {stage.folded && (
          <span className="obs-label" data-testid="intro-folded">
            {folded.before}
            <span className="normal-case">{folded.p}</span>
            {folded.after}
          </span>
        )}
      </div>

      {/* Überspringen (bis zum Endzustand) */}
      <div className="absolute top-[508px] right-[40px] flex h-10 items-center gap-4" hidden={endState}>
        <span className="obs-label" aria-hidden>
          {t("intro.skipHint")}
        </span>
        <ObsButton
          ref={skipBtnRef}
          variant="secondary"
          silent
          hidden={endState}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={skip}
          data-testid="intro-skip"
        >
          {t("intro.skip")}
        </ObsButton>
      </div>
    </section>
  );
}
