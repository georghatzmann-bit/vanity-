/**
 * Logarithmische Periodenskala des Schirms (C.2): x 24–396, 4 Dekaden 1 ms … 10 s,
 * x(P) = 24 + 93·log10(P / 1 ms). Vier Katalogmarken, Tonbereich (P < 50 ms) schraffiert,
 * gelbe Nadel bei der aktuellen Periode. Die Nadel liest `periodRef` mit 10 Hz (kein Re-Render).
 */
import { useRef, type RefObject } from "react";
import { useT } from "../i18n";
import { useFrameLoop } from "../hooks/useFrameLoop";
import { logScaleX, REFERENCES, REF_ORDER, type RefId } from "../obs/catalog";
import { NBSP } from "../obs/format";

export interface LogScaleProps {
  periodRef: RefObject<number>;
  nearest: RefId;
  /** Nadel ausblenden (z. B. Signal verloren) */
  hideNeedle?: boolean;
  /** reduzierte Bewegung: Nadel springt */
  reduced?: boolean;
}

/** Lage der Skala im Fenster */
export const SCALE_TOP = 476;
const X0 = 24;
const X1 = 396;
const BASE = 510; // Grundlinie (Fenster-y)
const TONE_MAX_P = 0.05; // P < 50 ms ⇒ f > 20 Hz

/** Nadel-x zur Periode, begrenzt auf die Skala */
export function needleX(periodS: number): number {
  if (!(periodS > 0) || !Number.isFinite(periodS)) return X1;
  return Math.min(X1, Math.max(X0, logScaleX(periodS)));
}

const DECADES = [
  { p: 0.001, label: `1${NBSP}ms` },
  { p: 0.01, label: `10${NBSP}ms` },
  { p: 0.1, label: `100${NBSP}ms` },
  { p: 1, label: `1${NBSP}s` },
  { p: 10, label: `10${NBSP}s` },
];

const y = (v: number) => v - SCALE_TOP;

export function LogScale({ periodRef, nearest, hideNeedle = false, reduced = false }: LogScaleProps) {
  const t = useT();
  const needle = useRef<SVGGElement>(null);
  const lastX = useRef(-1);

  useFrameLoop(
    () => {
      const g = needle.current;
      if (!g) return;
      const x = Math.round(needleX(periodRef.current ?? 1.3373) * 10) / 10;
      if (x === lastX.current) return;
      lastX.current = x;
      g.style.transform = `translateX(${x}px)`;
    },
    true,
    10,
  );

  // Teilstriche: Dekaden 8 px, „5er“ 6 px, übrige 4 px (60 %)
  const ticks: { x: number; h: number; minor: boolean }[] = [];
  for (let d = 0; d < 4; d++)
    for (let k = 1; k <= 9; k++) {
      const p = 0.001 * 10 ** d * k;
      ticks.push({ x: logScaleX(p), h: k === 1 ? 8 : k === 5 ? 6 : 4, minor: k !== 1 });
    }
  ticks.push({ x: X1, h: 8, minor: false });
  const toneX = logScaleX(TONE_MAX_P);
  const markLabel = (id: RefId) => (id === "vela" ? t("obs.mark.vela") : id === "crab" ? t("obs.mark.crab") : id === "j0437" ? "J0437" : "B1919");

  return (
    <div className="pointer-events-none absolute left-0 w-[420px]" style={{ top: SCALE_TOP, height: 56 }} data-testid="obs-logscale">
      {/* Beschriftungen der Katalogmarken (DOM-Text, nie im Canvas) */}
      <span className="obs-label absolute whitespace-nowrap" style={{ left: X0, top: y(482) }}>
        {t("obs.toneZone")}
      </span>
      {REF_ORDER.map((id) => (
        <span key={id} className={`obs-label absolute whitespace-nowrap -translate-x-1/2 ${id === nearest ? "text-obs-fg" : ""}`} style={{ left: logScaleX(REFERENCES[id].periodS), top: y(482) }}>
          {markLabel(id)}
        </span>
      ))}
      <svg className="absolute top-0 left-0" width={420} height={56} aria-hidden="true" style={{ overflow: "visible" }}>
        <defs>
          <pattern id="obs-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--obs-fg-4)" strokeWidth="1" />
          </pattern>
        </defs>
        {/* Tonbereich */}
        <rect x={X0} y={y(502)} width={toneX - X0} height={6} fill="url(#obs-hatch)" />
        <g shapeRendering="crispEdges">
          <line x1={X0} x2={X1} y1={y(BASE) + 0.5} y2={y(BASE) + 0.5} stroke="var(--obs-rule-strong)" />
          {ticks.map((k, i) => (
            <line key={i} x1={Math.round(k.x) + 0.5} x2={Math.round(k.x) + 0.5} y1={y(BASE)} y2={y(BASE) - k.h} stroke="var(--obs-fg-3)" strokeOpacity={k.minor ? 0.6 : 1} />
          ))}
          {REF_ORDER.map((id) => {
            const x = Math.round(logScaleX(REFERENCES[id].periodS)) + 0.5;
            return <line key={id} x1={x} x2={x} y1={y(BASE)} y2={y(BASE) - 10} stroke={id === nearest ? "var(--obs-fg)" : "var(--obs-fg-3)"} />;
          })}
        </g>
        {!hideNeedle && (
          <g ref={needle} style={{ transform: `translateX(${needleX(periodRef.current ?? 1.3373)}px)`, transition: reduced ? "none" : "transform 100ms linear" }} data-testid="obs-needle">
            <path d={`M-3.5 ${y(493)} L3.5 ${y(493)} L0 ${y(498)} Z`} fill="var(--obs-signal)" />
            <line x1={0} x2={0} y1={y(498)} y2={y(BASE)} stroke="var(--obs-signal)" strokeWidth={1} />
          </g>
        )}
      </svg>
      {DECADES.map((d, i) => (
        <span
          key={d.p}
          className={`obs-label absolute whitespace-nowrap normal-case ${i === 0 ? "" : i === DECADES.length - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
          style={{ left: logScaleX(d.p), top: y(BASE) + 4 }}
        >
          {d.label}
        </span>
      ))}
    </div>
  );
}
