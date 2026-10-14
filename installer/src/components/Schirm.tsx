/**
 * Schirm (C.2): links x 0–420, bleibt beim Seitenwechsel bestehen. Kopfzeile, Gratikül (statisches
 * SVG) mit Neutronenstern-Canvas bzw. Zeichen, Zustands-Tag, Kamera-Label, inszenierte Messwerte
 * (Periode, Frequenz), Zeile „Hörbar als · Zustand“, Log-Skala und Referenzzeile. Texte stehen im DOM;
 * laufende Werte werden höchstens 10-mal pro Sekunde per Ref und `textContent` gesetzt (F.4) – die
 * Nadel der Skala im selben Aufruf wie die Zahl.
 */
import { memo, useRef } from "react";
import { motion } from "motion/react";
import { PulsarMark } from "@shared/ui/PulsarMark";
import { sound, F_STAR } from "@shared/sound/engine";
import { getLang, useT } from "../i18n";
import { REFERENCES } from "../obs/catalog";
import { formatHz, formatPeriod, NBSP } from "../obs/format";
import { exposureTime, exposureTurns, MARK_SIZE_PX, STAR_CENTER } from "../obs/star";
import type { ObsMode, ObsState, Quality } from "../obs/types";
import { useFrameLoop } from "../hooks/useFrameLoop";
import { CanvasBoundary } from "./CanvasBoundary";
import { LogScale, needleTransform } from "./LogScale";
import { omegaLabelAnchor, sceneFor, StarCanvas, STAR_CANVAS_H, STAR_CANVAS_W, STAR_CANVAS_X, STAR_CANVAS_Y, type CameraKind } from "./StarCanvas";

export interface SchirmProps {
  obs: ObsState;
  reduced: boolean;
  quality: Quality;
}

type T = ReturnType<typeof useT>;
/** schmales geschütztes Leerzeichen (U+202F) */
const NNBSP = "\u202F";
type Lang = "de" | "en";

/** Schirm-eigene Texte (noch nicht im gemeinsamen Wörterbuch) */
const LOCAL: Record<Lang, { fading: string }> = {
  de: { fading: "Signal schwindet" },
  en: { fading: "Signal fading" },
};

/** Zustand (zweites Glied der Zeile „Hörbar als“) */
export function driveLabelKey(mode: ObsMode): string {
  switch (mode) {
    case "idle":
      return "obs.idle";
    case "installing":
    case "relock":
      return "obs.drive";
    case "halted":
    case "error":
      return "obs.halted";
    case "release":
    case "uninstalling":
      return "obs.driveDown";
    case "strobe":
    case "installed":
      return "obs.installed";
    default:
      return "obs.lost";
  }
}

function stateText(t: T, mode: ObsMode, lang: Lang): string {
  return mode === "decay" ? LOCAL[lang].fading : t(driveLabelKey(mode));
}

/** Erstes Glied: „Hörbar als Knattern“ / „lautlos“ / „Ton aus“ */
export function heardPart(t: T, heard: ObsState["heard"], muted: boolean): string {
  if (muted) return t("obs.soundOff");
  if (heard) return `${t("obs.heardAs")} ${t(`obs.heard.${heard}`)}`;
  return t("obs.silent");
}

/** Zustände, in denen das zweite Glied („Drehzahl = Fortschritt“ …) nichts Neues sagt: nur „Hörbar als …“ */
const HEARD_ONLY: ReadonlySet<ObsMode> = new Set<ObsMode>(["installing", "relock", "release", "uninstalling"]);

/** Zeile „Hörbar als · Zustand“ (C.2); zu lang (> 52 Zeichen) → ohne „Hörbar als“ */
export function heardLine(t: T, mode: ObsMode, heard: ObsState["heard"], muted: boolean, lang: Lang = "de"): string {
  if (HEARD_ONLY.has(mode)) return heardPart(t, heard, muted);
  const state = stateText(t, mode, lang);
  const s = `${heardPart(t, heard, muted)} · ${state}`;
  if (s.length <= 52 || !heard || muted) return s;
  return `${t(`obs.heard.${heard}`)} · ${state}`;
}

/* ── Kamera-Label: Stufen mit Hysterese ─────────────────── */

/** Stufen 1/60 … 1/2 s (Index 0–5), Index 6 = „2 × P“ */
export const EXPOSURE_STEP_DEN = [60, 30, 15, 8, 4, 2] as const;
export const EXPOSURE_FULL = 6;
const HYST = 1.15;

/** Grenze zwischen Stufe i und i + 1 (geometrische Mitte, s) */
const stepBound = (i: number) => Math.sqrt(1 / EXPOSURE_STEP_DEN[i] / EXPOSURE_STEP_DEN[i + 1]);

/** Stufe zur Frequenz; mit `prev` erst bei 15 % über der Stufengrenze wechseln (rein) */
export function exposureStep(f: number, prev: number | null = null): number {
  const n = exposureTurns(f);
  if (n >= 2 - 1e-9) return EXPOSURE_FULL;
  if (prev === EXPOSURE_FULL && n >= 2 / HYST) return EXPOSURE_FULL;
  const t = exposureTime(f);
  let raw = 0;
  while (raw < EXPOSURE_STEP_DEN.length - 1 && t > stepBound(raw)) raw++;
  if (prev === null || prev === EXPOSURE_FULL || prev === raw) return raw;
  let i = prev;
  while (i < raw && t > stepBound(i) * HYST) i++;
  while (i > raw && t < stepBound(i - 1) / HYST) i--;
  return i;
}

export function exposureStepLabel(i: number): string {
  return i >= EXPOSURE_FULL ? `2${NNBSP}×${NNBSP}P` : `1/${EXPOSURE_STEP_DEN[Math.max(0, i)]}${NBSP}s`;
}

/** Text eines Platzhalter-Satzes in [davor, danach] zerlegen (Wert mit Einheit bleibt in normaler Schreibung) */
function splitTpl(t: T, key: string, name: string): [string, string] {
  const MARK = "\u0001";
  const s = t(key, { [name]: MARK });
  const i = s.indexOf(MARK);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** Kamera-Label (C.2): Teile [Wort davor, Wert, Wort danach]; `step` = gehaltene Stufe (sonst aus f) */
export function cameraParts(t: T, kind: CameraKind, f: number, lang: Lang, step?: number): [string, string, string] {
  if (kind === "still") return [t("obs.still"), "", ""];
  if (kind === "nosignal") return [splitTpl(t, "obs.exposure", "t")[0], "—", ""];
  if (kind === "strobe") {
    const [a, b] = splitTpl(t, "obs.strobe", "f");
    return [a, formatHz(F_STAR, lang), b];
  }
  if (kind === "exposure") {
    const [a, b] = splitTpl(t, "obs.exposure", "t");
    const i = step ?? exposureStep(f);
    return [a, exposureStepLabel(i), b];
  }
  return ["", "", ""];
}

/** Zahl in [ganzzahliger Teil, Trennzeichen, Nachkommateil] zerlegen („89,87“ → [„89“, „,“, „87“]) */
export function splitDecimal(v: string): [string, string, string] {
  const m = /^(.*?)([.,])(\d+)$/.exec(v);
  return m ? [m[1], m[2], m[3]] : [v, "", ""];
}

/** Wert und Einheit trennen („1,3373 s“ → [„1,3373“, „s“]) */
const splitUnit = (s: string): [string, string] => {
  const i = s.lastIndexOf(NBSP);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
};

const setText = (el: HTMLElement | null, s: string) => {
  if (el && el.textContent !== s) el.textContent = s;
};

const EASE = [0.2, 0, 0, 1] as const;
/** Mindest-Standzeit eines Kamera-Werts (s) */
const CAMERA_DWELL_S = 0.4;

function SchirmImpl({ obs, reduced, quality }: SchirmProps) {
  const t = useT();
  const lang = getLang() as Lang;
  const ref = REFERENCES[obs.reference];
  const lost = obs.mode === "lost";

  // Laufende Werte (Refs, 10 Hz)
  const pInt = useRef<HTMLSpanElement>(null);
  const pSep = useRef<HTMLSpanElement>(null);
  const pFrac = useRef<HTMLSpanElement>(null);
  const pUnit = useRef<HTMLSpanElement>(null);
  const pBox = useRef<HTMLSpanElement>(null);
  const fVal = useRef<HTMLSpanElement>(null);
  const fUnit = useRef<HTMLSpanElement>(null);
  const fBox = useRef<HTMLSpanElement>(null);
  const camBox = useRef<HTMLSpanElement>(null);
  const camA = useRef<HTMLSpanElement>(null);
  const camV = useRef<HTMLSpanElement>(null);
  const camB = useRef<HTMLSpanElement>(null);
  const heardEl = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<SVGGElement>(null);
  const camStep = useRef<{ i: number | null; since: number }>({ i: null, since: -Infinity });
  const live = useRef({ obs, reduced, lang, t });
  live.current = { obs, reduced, lang, t };

  const update = () => {
    const { obs: o, reduced: r, lang: l, t: tt } = live.current;
    const now = sound.clock.now();
    const gone = o.mode === "lost";
    const fading = o.mode === "decay";
    // Im Zerfall stehen Periode und Frequenz beim Wert des Zerfallsbeginns (kein unlesbares Hochzählen)
    const f = o.model.freqAt(fading ? o.modeSince : now);
    const P = f > 0 ? 1 / f : Infinity;
    const [pv, pu] = gone ? ["—", ""] : splitUnit(formatPeriod(P, l));
    const [fv, fu] = gone ? ["—", ""] : splitUnit(formatHz(f, l));
    const [pi, ps, pf] = splitDecimal(pv);
    setText(pInt.current, pi);
    setText(pSep.current, ps);
    setText(pFrac.current, pf);
    setText(pUnit.current, pu ? NBSP + pu : "");
    setText(fVal.current, fv);
    setText(fUnit.current, fu ? NBSP + fu : "");
    const valColor = fading ? "var(--obs-fg-3)" : "";
    if (pBox.current) {
      pBox.current.dataset.value = gone ? "" : P.toPrecision(6);
      if (pBox.current.style.color !== valColor) pBox.current.style.color = valColor;
    }
    if (fBox.current && fBox.current.style.color !== valColor) fBox.current.style.color = valColor;
    // Nadel im selben Frame mit demselben Wert wie die Zahl
    if (needleRef.current) {
      const tr = needleTransform(P);
      if (needleRef.current.style.transform !== tr) needleRef.current.style.transform = tr;
    }
    // Kamera: Stufen mit Hysterese und Mindest-Standzeit; im Zerfall ausblenden
    const sc = sceneFor(o.mode, (now - o.modeSince) * 1000, 0, f, r);
    const cs = camStep.current;
    const want = exposureStep(f, cs.i);
    if (cs.i === null || (want !== cs.i && now - cs.since >= CAMERA_DWELL_S)) {
      if (want !== cs.i) cs.since = now;
      cs.i = want;
    }
    const kind: CameraKind = o.showMark || sc.bayer >= 0 ? "none" : sc.camera;
    const [a, v, b] = cameraParts(tt, kind, f, l, cs.i ?? undefined);
    setText(camA.current, a);
    setText(camV.current, v);
    setText(camB.current, b);
    if (camBox.current) camBox.current.style.visibility = kind === "none" ? "hidden" : "";
    setText(heardEl.current, heardLine(tt, o.mode, o.heard, sound.muted, l));
  };
  useFrameLoop(update, true, 10);

  // Zustands-Tag oben links im Canvas
  let tag: { text: string; cls: string } | null = null;
  if (obs.mode === "error") tag = { text: t("obs.noSignal"), cls: "text-obs-error" };
  else if (obs.mode === "halted") tag = { text: t("obs.halted"), cls: "text-obs-fg-2" };
  else if (obs.mode === "relock") tag = { text: t("obs.relock"), cls: "text-obs-signal" };
  else if (obs.mode === "decay") tag = { text: LOCAL[lang].fading, cls: "text-obs-fg-2" };
  // „Signal verloren“: kein Canvas-Tag (steht schon in der Überschrift und in der Zeile „Hörbar als“)

  const markLeft = STAR_CENTER[0] - MARK_SIZE_PX / 2;
  const markTop = STAR_CENTER[1] - MARK_SIZE_PX / 2;
  const fade = { duration: 0.12, ease: EASE };
  // Keine gleichzeitige Kreuzblende über deckungsgleiche Bilder (sonst Deckung 0,75 in der Mitte, Flackern):
  // Zeichen erscheint sofort, danach blendet der Canvas aus; umgekehrt Canvas sofort, dann Zeichen aus.
  const canvasFade = obs.showMark ? { ...fade, delay: 0.05 } : { duration: 0 };
  const markFade = obs.showMark ? { duration: 0 } : fade;
  const omega = omegaLabelAnchor();
  const showOmega = !obs.showMark && (obs.mode === "idle" || obs.mode === "installing" || obs.mode === "relock" || obs.mode === "halted" || obs.mode === "uninstalling");
  const first = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: reduced ? 0.12 : 0.18, ease: EASE } };

  return (
    <section className="pointer-events-none absolute top-0 left-0 h-[640px] w-[420px]" aria-label={t("obs.view")} data-testid="schirm" data-mode={obs.mode}>
      <motion.div className="absolute inset-0" {...first}>
        {/* Kopfzeile */}
        <span className="obs-label absolute whitespace-nowrap" style={{ left: 24, top: 52 }}>
          {t("obs.view")}
        </span>
        <span className="obs-label absolute whitespace-nowrap -translate-x-full" style={{ left: 396, top: 52 }}>
          {t("obs.schematic")}
        </span>

        {/* Gratikül (statisch) */}
        <Graticule />

        {/* Stern bzw. Zeichen */}
        <motion.div className="absolute" style={{ left: STAR_CANVAS_X, top: STAR_CANVAS_Y }} animate={{ opacity: obs.showMark ? 0 : 1 }} transition={canvasFade} initial={false}>
          <CanvasBoundary width={STAR_CANVAS_W} height={STAR_CANVAS_H} label={t("obs.schematic")}>
            <StarCanvas model={obs.model} mode={obs.mode} modeSince={obs.modeSince} reduced={reduced} quality={quality} />
          </CanvasBoundary>
        </motion.div>
        <motion.div className="absolute" style={{ left: markLeft, top: markTop }} animate={{ opacity: obs.showMark ? 1 : 0 }} transition={markFade} initial={false} data-testid="schirm-mark">
          <PulsarMark size={MARK_SIZE_PX} variant="rays" />
        </motion.div>

        {/* Drehachse Ω̂: Beschriftung am oberen Ende der gestrichelten Achse (4 px versetzt) */}
        <motion.span
          className="obs-label absolute whitespace-nowrap normal-case"
          style={{ left: omega.x + 4 * omega.dx, top: omega.y + 4 * omega.dy, transform: "translateY(-100%)", color: "rgba(168,174,184,0.6)", letterSpacing: 0 }}
          animate={{ opacity: showOmega ? 1 : 0 }}
          transition={fade}
          initial={false}
          aria-hidden="true"
          data-testid="schirm-omega"
        >
          Ω
        </motion.span>
        {tag && (
          <span className={`obs-label absolute whitespace-nowrap ${tag.cls}`} style={{ left: 32, top: 82 }} data-testid="schirm-tag">
            {tag.text}
          </span>
        )}
        <span ref={camBox} className="obs-label absolute whitespace-nowrap" style={{ left: 32, top: 370 }} data-testid="schirm-camera">
          <span ref={camA} />
          <span ref={camV} className="normal-case" />
          <span ref={camB} />
        </span>

        {/* Messwerte (inszeniert) */}
        <span className="obs-label absolute whitespace-nowrap" style={{ left: 24, top: 408 }}>
          {t("obs.period")}
        </span>
        <span className="obs-label absolute whitespace-nowrap" style={{ left: 196, top: 408 }}>
          {t("obs.frequency")}
        </span>
        <span className="obs-tag absolute whitespace-nowrap -translate-x-full" style={{ left: 396, top: 406 }}>
          {t("obs.staged")}
        </span>
        <span ref={pBox} className="obs-value obs-value-lg absolute" style={{ left: 24, top: 422 }} data-testid="obs-period" data-value="" aria-describedby="obs-staged-note">
          <span ref={pInt} />
          <span ref={pSep} style={{ marginInline: "-0.15em" }} />
          <span ref={pFrac} />
          <span ref={pUnit} className="obs-unit" />
        </span>
        <span ref={fBox} className="obs-value obs-value-md absolute" style={{ left: 196, top: 427 }} data-testid="obs-frequency">
          <span ref={fVal} />
          <span ref={fUnit} className="obs-unit" />
        </span>

        {/* Hörbar als · Zustand (eine Zeile) */}
        <span ref={heardEl} className="obs-label absolute whitespace-nowrap text-obs-fg-2" style={{ left: 24, top: 456 }} data-testid="schirm-heard" />

        <LogScale needleRef={needleRef} nearest={obs.reference} hideNeedle={lost} />

      </motion.div>

      {/* Für Screenreader: Canvas ist aria-hidden */}
      <span className="obs-sr-only">{t("a11y.star", { p: formatPeriod(ref.periodS, lang) })}</span>
      <span id="obs-staged-note" className="obs-sr-only">
        {t("obs.stagedNote")}
      </span>
    </section>
  );
}

/** Nur von obs/reduced/quality abhängig (Fortschritts-Events rendern den Schirm nicht neu) */
export const Schirm = memo(SchirmImpl, (a, b) => a.obs === b.obs && a.reduced === b.reduced && a.quality === b.quality);

/** Gratikül 10 × 8 (38 × 40 px), Mittelachsen mit Kleinteilung, Rahmen 1 px (B.5) – statisch */
const Graticule = memo(function Graticule() {
  const W = STAR_CANVAS_W;
  const H = STAR_CANVAS_H;
  const v = Array.from({ length: 9 }, (_, i) => 38 * (i + 1)).filter((x) => x !== 190);
  const h = Array.from({ length: 7 }, (_, j) => 40 * (j + 1)).filter((y) => y !== 160);
  const ticksX = Array.from({ length: 49 }, (_, i) => 7.6 * (i + 1)).filter((x) => x < W && Math.abs(x % 38) > 0.01 && Math.abs((x % 38) - 38) > 0.01);
  const ticksY = Array.from({ length: 39 }, (_, j) => 8 * (j + 1)).filter((y) => y < H && y % 40 !== 0);
  const px = (n: number) => Math.round(n) + 0.5;
  return (
    <svg className="absolute" style={{ left: STAR_CANVAS_X, top: STAR_CANVAS_Y }} width={W} height={H} aria-hidden="true" shapeRendering="crispEdges">
      <g stroke="var(--obs-grid)" strokeWidth={1} shapeRendering="crispEdges">
        {v.map((x) => (
          <line key={`v${x}`} x1={px(x)} x2={px(x)} y1={0} y2={H} />
        ))}
        {h.map((y) => (
          <line key={`h${y}`} x1={0} x2={W} y1={px(y)} y2={px(y)} />
        ))}
      </g>
      <g stroke="var(--obs-grid-axis)" strokeWidth={1} shapeRendering="crispEdges">
        <line x1={px(190)} x2={px(190)} y1={0} y2={H} />
        <line x1={0} x2={W} y1={px(160)} y2={px(160)} />
        {ticksX.map((x) => (
          <line key={`tx${x}`} x1={px(x)} x2={px(x)} y1={158} y2={162} />
        ))}
        {ticksY.map((y) => (
          <line key={`ty${y}`} x1={188} x2={192} y1={px(y)} y2={px(y)} />
        ))}
      </g>
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="var(--obs-rule-strong)" strokeWidth={1} shapeRendering="crispEdges" />
    </svg>
  );
});
