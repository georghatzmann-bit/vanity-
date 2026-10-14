/**
 * Schirm (C.2): links x 0–420, bleibt beim Seitenwechsel bestehen. Kopfzeile, Gratikül (statisches
 * SVG) mit Neutronenstern-Canvas bzw. Zeichen, Zustands-Tag, Kamera-Label, inszenierte Messwerte
 * (Periode, Frequenz), „Hörbar als“, Log-Skala und Referenzzeile. Texte stehen im DOM; laufende Werte
 * werden höchstens 10-mal pro Sekunde per Ref und `textContent` gesetzt (F.4).
 */
import { useRef } from "react";
import { motion } from "motion/react";
import { PulsarMark } from "@shared/ui/PulsarMark";
import { sound, F_STAR } from "@shared/sound/engine";
import { getLang, useT } from "../i18n";
import { REFERENCES } from "../obs/catalog";
import { formatExposure, formatHz, formatPeriod, NBSP } from "../obs/format";
import { MARK_SIZE_PX, STAR_CENTER } from "../obs/star";
import type { ObsMode, ObsState, Quality } from "../obs/types";
import { useFrameLoop } from "../hooks/useFrameLoop";
import { CanvasBoundary } from "./CanvasBoundary";
import { LogScale } from "./LogScale";
import { sceneFor, StarCanvas, STAR_CANVAS_H, STAR_CANVAS_W, STAR_CANVAS_X, STAR_CANVAS_Y, type CameraKind } from "./StarCanvas";

export interface SchirmProps {
  obs: ObsState;
  reduced: boolean;
  quality: Quality;
}

type T = ReturnType<typeof useT>;

/** Rechte Seite der Referenzzeile (C.2) */
export function driveLabelKey(mode: ObsMode): string {
  switch (mode) {
    case "idle":
      return "obs.idle";
    case "installing":
    case "error":
    case "halted":
    case "relock":
      return "obs.drive";
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

/** Zeile „Hörbar als“ (C.2) */
export function heardLine(t: T, mode: ObsMode, heard: ObsState["heard"], muted: boolean): string {
  let s: string;
  if (heard) s = `${t("obs.heardAs")} · ${t(`obs.heard.${heard}`)}`;
  else if (mode === "idle") s = `${t("obs.idle")} · ${t("obs.silent")}`;
  else s = `${t("obs.heardAs")} · ${t("obs.silent")}`;
  return muted ? `${s} · ${t("obs.soundOff")}` : s;
}

/** Text eines Platzhalter-Satzes in [davor, danach] zerlegen (Wert mit Einheit bleibt in normaler Schreibung) */
function splitTpl(t: T, key: string, name: string): [string, string] {
  const MARK = "\u0001";
  const s = t(key, { [name]: MARK });
  const i = s.indexOf(MARK);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** Kamera-Label (C.2): Teile [Wort davor, Wert, Wort danach] */
export function cameraParts(t: T, kind: CameraKind, f: number, lang: "de" | "en"): [string, string, string] {
  if (kind === "still") return [t("obs.still"), "", ""];
  if (kind === "strobe") {
    const [a, b] = splitTpl(t, "obs.strobe", "f");
    return [a, formatHz(F_STAR, lang), b];
  }
  if (kind === "exposure") {
    const [a, b] = splitTpl(t, "obs.exposure", "t");
    return [a, formatExposure(f, lang), b];
  }
  return ["", "", ""];
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

export function Schirm({ obs, reduced, quality }: SchirmProps) {
  const t = useT();
  const lang = getLang();
  const ref = REFERENCES[obs.reference];
  const lost = obs.mode === "lost" || obs.mode === "decay";

  // Laufende Werte (Refs, 10 Hz)
  const periodRef = useRef<number>(REFERENCES.b1919.periodS);
  const pVal = useRef<HTMLSpanElement>(null);
  const pUnit = useRef<HTMLSpanElement>(null);
  const pBox = useRef<HTMLSpanElement>(null);
  const fVal = useRef<HTMLSpanElement>(null);
  const fUnit = useRef<HTMLSpanElement>(null);
  const camA = useRef<HTMLSpanElement>(null);
  const camV = useRef<HTMLSpanElement>(null);
  const camB = useRef<HTMLSpanElement>(null);
  const heardEl = useRef<HTMLSpanElement>(null);
  const live = useRef({ obs, reduced, lang, t });
  live.current = { obs, reduced, lang, t };

  const update = () => {
    const { obs: o, reduced: r, lang: l, t: tt } = live.current;
    const now = sound.clock.now();
    const f = o.model.freqAt(now);
    const P = f > 0 ? 1 / f : Infinity;
    const gone = o.mode === "lost" || o.mode === "decay";
    periodRef.current = P;
    const [pv, pu] = gone ? ["—", ""] : splitUnit(formatPeriod(P, l));
    const [fv, fu] = gone ? ["—", ""] : splitUnit(formatHz(f, l));
    setText(pVal.current, pv);
    setText(pUnit.current, pu ? NBSP + pu : "");
    setText(fVal.current, fv);
    setText(fUnit.current, fu ? NBSP + fu : "");
    if (pBox.current) pBox.current.dataset.value = gone ? "" : P.toPrecision(6);
    const cam = sceneFor(o.mode, (now - o.modeSince) * 1000, 0, f, r).camera;
    const [a, v, b] = cameraParts(tt, o.showMark ? "none" : cam, f, l);
    setText(camA.current, a);
    setText(camV.current, v);
    setText(camB.current, b);
    setText(heardEl.current, heardLine(tt, o.mode, o.heard, sound.muted));
  };
  useFrameLoop(update, true, 10);

  // Zustands-Tag oben links im Canvas
  let tag: { text: string; cls: string } | null = null;
  if (obs.mode === "error") tag = { text: `${t("obs.noSignal")} · ${(obs.errorCode ?? "unknown").toUpperCase()}`, cls: "text-obs-error" };
  else if (obs.mode === "halted") tag = { text: t("obs.halted"), cls: "text-obs-fg-2" };
  else if (obs.mode === "relock") tag = { text: t("obs.relock"), cls: "text-obs-signal" };
  else if (lost) tag = { text: t("obs.lost"), cls: "text-obs-fg-2" };

  const markLeft = STAR_CENTER[0] - MARK_SIZE_PX / 2;
  const markTop = STAR_CENTER[1] - MARK_SIZE_PX / 2;
  const fade = { duration: 0.12, ease: EASE };
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
        <motion.div className="absolute" style={{ left: STAR_CANVAS_X, top: STAR_CANVAS_Y }} animate={{ opacity: obs.showMark ? 0 : 1 }} transition={fade} initial={false}>
          <CanvasBoundary width={STAR_CANVAS_W} height={STAR_CANVAS_H} label={t("obs.schematic")}>
            <StarCanvas model={obs.model} mode={obs.mode} modeSince={obs.modeSince} reduced={reduced} quality={quality} />
          </CanvasBoundary>
        </motion.div>
        <motion.div className="absolute" style={{ left: markLeft, top: markTop }} animate={{ opacity: obs.showMark ? 1 : 0 }} transition={fade} initial={false} data-testid="schirm-mark">
          <PulsarMark size={MARK_SIZE_PX} variant="rays" />
        </motion.div>

        {tag && (
          <span className={`obs-label absolute whitespace-nowrap ${tag.cls}`} style={{ left: 32, top: 82 }} data-testid="schirm-tag">
            {tag.text}
          </span>
        )}
        <span className="obs-label absolute whitespace-nowrap" style={{ left: 32, top: 370 }} data-testid="schirm-camera">
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
          <span ref={pVal} />
          <span ref={pUnit} className="obs-unit" />
        </span>
        <span className="obs-value obs-value-md absolute" style={{ left: 196, top: 427 }} data-testid="obs-frequency">
          <span ref={fVal} />
          <span ref={fUnit} className="obs-unit" />
        </span>

        <span ref={heardEl} className="obs-label absolute whitespace-nowrap text-obs-fg-2" style={{ left: 24, top: 456 }} data-testid="schirm-heard" />

        <LogScale periodRef={periodRef} nearest={obs.reference} hideNeedle={lost} reduced={reduced} />

        {/* Referenz */}
        <span className="obs-label absolute whitespace-nowrap" style={{ left: 24, top: 546 }} data-testid="schirm-ref">
          REF {ref.designation} · {t(`obs.ref.${obs.reference}`)}
        </span>
        <span className="obs-label absolute whitespace-nowrap -translate-x-full text-obs-fg-2" style={{ left: 396, top: 564 }} data-testid="schirm-drive">
          {t(driveLabelKey(obs.mode))}
        </span>
      </motion.div>

      {/* Für Screenreader: Canvas ist aria-hidden */}
      <span className="obs-sr-only">{t("a11y.star", { p: formatPeriod(ref.periodS, lang) })}</span>
      <span id="obs-staged-note" className="obs-sr-only">
        {t("obs.stagedNote")}
      </span>
    </section>
  );
}

/** Gratikül 10 × 8 (38 × 40 px), Mittelachsen mit Kleinteilung, Rahmen 1 px (B.5) */
function Graticule() {
  const W = STAR_CANVAS_W;
  const H = STAR_CANVAS_H;
  const v = Array.from({ length: 9 }, (_, i) => 38 * (i + 1)).filter((x) => x !== 190);
  const h = Array.from({ length: 7 }, (_, j) => 40 * (j + 1)).filter((y) => y !== 160);
  const ticksX = Array.from({ length: 49 }, (_, i) => 7.6 * (i + 1)).filter((x) => x < W && Math.abs(x % 38) > 0.01 && Math.abs((x % 38) - 38) > 0.01);
  const ticksY = Array.from({ length: 39 }, (_, j) => 8 * (j + 1)).filter((y) => y < H && y % 40 !== 0);
  const px = (n: number) => Math.round(n) + 0.5;
  return (
    <svg className="absolute" style={{ left: STAR_CANVAS_X, top: STAR_CANVAS_Y }} width={W} height={H} aria-hidden="true" shapeRendering="crispEdges">
      <g stroke="var(--obs-grid)" strokeWidth={1}>
        {v.map((x) => (
          <line key={`v${x}`} x1={px(x)} x2={px(x)} y1={0} y2={H} />
        ))}
        {h.map((y) => (
          <line key={`h${y}`} x1={0} x2={W} y1={px(y)} y2={px(y)} />
        ))}
      </g>
      <g stroke="var(--obs-grid-axis)" strokeWidth={1}>
        <line x1={px(190)} x2={px(190)} y1={0} y2={H} />
        <line x1={0} x2={W} y1={px(160)} y2={px(160)} />
        {ticksX.map((x) => (
          <line key={`tx${x}`} x1={px(x)} x2={px(x)} y1={158} y2={162} />
        ))}
        {ticksY.map((y) => (
          <line key={`ty${y}`} x1={188} x2={192} y1={px(y)} y2={px(y)} />
        ))}
      </g>
      <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="var(--obs-rule-strong)" strokeWidth={1} />
    </svg>
  );
}
