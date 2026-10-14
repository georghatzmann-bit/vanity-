/**
 * Logarithmische Periodenskala des Schirms (C.2): x 24–396, 4 Dekaden 1 ms … 10 s,
 * x(P) = 24 + 93·log10(P / 1 ms). Vier Katalogmarken, Tonbereich (P < 50 ms) als 4-px-Schraffur unter der
 * Grundlinie, gelbe Nadel bei der aktuellen Periode. Die Nadel setzt der Schirm im selben `update()` wie die
 * Zahl (gleicher Wert, gleicher Frame, kein CSS-Übergang) über `needleRef`.
 */
import { memo, type RefObject } from "react";
import { useT } from "../i18n";
import { logScaleX, REFERENCES, REF_ORDER, type RefId } from "../obs/catalog";
import { NBSP } from "../obs/format";

export interface LogScaleProps {
  /** Nadel-Gruppe; der Schirm setzt `transform` */
  needleRef: RefObject<SVGGElement | null>;
  nearest: RefId;
  /** Nadel ausblenden (z. B. Signal verloren) */
  hideNeedle?: boolean;
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

/** Nadel-Transform (auf 0,1 px gerundet) */
export function needleTransform(periodS: number): string {
  return `translateX(${Math.round(needleX(periodS) * 10) / 10}px)`;
}

/** Beschriftete Dekaden: nur die Enden 1 ms und 10 s (Zwischendekaden als 8-px-Striche) */
const DECADES = [
  { p: 0.001, label: `1${NBSP}ms`, align: "start" },
  { p: 10, label: `10${NBSP}s`, align: "end" },
] as const;

/** Marken: J0437 und Krebs links der Marke (rechtsbündig), Vela und B1919 rechts davon (linksbündig) */
const LEFT_OF_MARK: ReadonlySet<RefId> = new Set<RefId>(["j0437", "crab"]);

const y = (v: number) => v - SCALE_TOP;

/** Teilstriche: Dekaden 8 px, „5er“ 6 px, übrige 4 px (60 %) – statisch */
const TICKS: { x: number; h: number; minor: boolean }[] = (() => {
  const out: { x: number; h: number; minor: boolean }[] = [];
  for (let d = 0; d < 4; d++)
    for (let k = 1; k <= 9; k++) {
      const p = 0.001 * 10 ** d * k;
      out.push({ x: logScaleX(p), h: k === 1 ? 8 : k === 5 ? 6 : 4, minor: k !== 1 });
    }
  out.push({ x: X1, h: 8, minor: false });
  return out;
})();
const TONE_X = logScaleX(TONE_MAX_P);

const ScaleSvg = memo(function ScaleSvg({ nearest }: { nearest: RefId }) {
  return (
    <>
      <defs>
        <pattern id="obs-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--obs-fg-4)" strokeOpacity={0.5} strokeWidth="1" />
        </pattern>
      </defs>
      {/* Tonbereich: 4 px hoch unter der Grundlinie, Striche bleiben frei */}
      <rect x={X0} y={y(BASE) + 1} width={TONE_X - X0} height={4} fill="url(#obs-hatch)" />
      <g shapeRendering="crispEdges">
        <line x1={X0} x2={X1} y1={y(BASE) + 0.5} y2={y(BASE) + 0.5} stroke="var(--obs-rule-strong)" />
        {TICKS.map((k, i) => (
          <line key={i} x1={Math.round(k.x) + 0.5} x2={Math.round(k.x) + 0.5} y1={y(BASE)} y2={y(BASE) - k.h} stroke="var(--obs-fg-3)" strokeOpacity={k.minor ? 0.6 : 1} />
        ))}
        <line x1={Math.round(TONE_X) + 0.5} x2={Math.round(TONE_X) + 0.5} y1={y(BASE) + 1} y2={y(BASE) + 5} stroke="var(--obs-fg-4)" />
        {/* Klammer des Tonbereichs direkt unter der Schraffur (1 px, Enden 3 px hoch) */}
        <path
          d={`M${X0 + 0.5} ${y(BASE) + 3.5} V${y(BASE) + 6.5} H${Math.round(TONE_X) + 0.5} V${y(BASE) + 3.5}`}
          fill="none"
          stroke="var(--obs-fg-4)"
          strokeWidth={1}
          data-testid="obs-tone-bracket"
        />
        {REF_ORDER.map((id) => {
          const x = Math.round(logScaleX(REFERENCES[id].periodS)) + 0.5;
          return <line key={id} x1={x} x2={x} y1={y(BASE)} y2={y(BASE) - 10} stroke={id === nearest ? "var(--obs-fg)" : "var(--obs-fg-3)"} />;
        })}
      </g>
    </>
  );
});

export const LogScale = memo(function LogScale({ needleRef, nearest, hideNeedle = false }: LogScaleProps) {
  const t = useT();
  const markLabel = (id: RefId) => (id === "vela" ? t("obs.mark.vela") : id === "crab" ? t("obs.mark.crab") : id === "j0437" ? "J0437" : "B1919");

  return (
    <div className="pointer-events-none absolute left-0 w-[420px]" style={{ top: SCALE_TOP, height: 68 }} data-testid="obs-logscale">
      {/* Beschriftungen der Katalogmarken (DOM-Text, nie im Canvas), 3 px neben der Marke */}
      {REF_ORDER.map((id) => {
        const x = logScaleX(REFERENCES[id].periodS);
        const left = LEFT_OF_MARK.has(id);
        return (
          <span
            key={id}
            className={`obs-label absolute whitespace-nowrap ${left ? "-translate-x-full" : ""} ${id === nearest ? "text-obs-fg" : ""}`}
            style={{ left: left ? x - 3 : x + 3, top: y(482) }}
          >
            {markLabel(id)}
          </span>
        );
      })}
      <svg className="absolute top-0 left-0" width={420} height={56} aria-hidden="true" style={{ overflow: "visible" }}>
        <ScaleSvg nearest={nearest} />
        {!hideNeedle && (
          <g ref={needleRef} data-testid="obs-needle">
            <path d={`M-3.5 ${y(493)} L3.5 ${y(493)} L0 ${y(498)} Z`} fill="var(--obs-signal)" />
            <line x1={0} x2={0} y1={y(498)} y2={y(BASE)} stroke="var(--obs-signal)" strokeWidth={1} />
          </g>
        )}
      </svg>
      {DECADES.map((d) => (
        <span
          key={d.p}
          className={`obs-label absolute whitespace-nowrap normal-case ${d.align === "start" ? "" : d.align === "end" ? "-translate-x-full" : "-translate-x-1/2"}`}
          style={{ left: logScaleX(d.p), top: y(BASE) + 7 }}
        >
          {d.label}
        </span>
      ))}
      {/* Legende des Tonbereichs: mittig unter der Klammer, eine Zeile unter den Dekaden-Labels (kein Skalenwert) */}
      <span className="obs-label absolute whitespace-nowrap -translate-x-1/2 text-obs-fg-4" style={{ left: (X0 + TONE_X) / 2, top: y(BASE) + 18, fontSize: 9, lineHeight: "12px" }} data-testid="obs-tone-label">
        {t("obs.toneZone")}
      </span>
    </div>
  );
});
