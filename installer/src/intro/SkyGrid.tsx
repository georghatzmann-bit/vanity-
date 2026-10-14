/**
 * Himmelskarte des Intros (B.6, C.1): Tangentialebene um CP 1919, Mittelpunkt (490, 250),
 * Maßstab 1′ = 100 px in beiden Richtungen (unverzerrt). RA steigt nach links.
 * Statisches SVG in Fensterkoordinaten (viewBox y 40–600); Beschriftungen wörtlich.
 */
import { memo } from "react";

/** 1 s Rektaszension = 15″·cos δ = 13,919″ = 23,198 px */
export const RA_SEC_PX = 23.198;
export const ARCMIN_PX = 100;

/** Senkrechte Linien (RA) mit Beschriftung, x in Fensterkoordinaten */
export const RA_LINES: ReadonlyArray<readonly [number, string]> = [
  [137.4, "19h22m00s"],
  [253.4, "21m55s"],
  [369.4, "21m50s"],
  [485.4, "21m45s"],
  [601.4, "21m40s"],
  [717.3, "21m35s"],
  [833.3, "21m30s"],
];

/** Waagerechte Linien (Dec) mit Beschriftung */
export const DEC_LINES: ReadonlyArray<readonly [number, string]> = [
  [153.3, "+21°54′"],
  [253.3, "+21°53′"],
  [353.3, "+21°52′"],
  [453.3, "+21°51′"],
  [553.3, "+21°50′"],
];

/** auf das Pixelraster (+0,5) */
const px = (v: number) => Math.round(v - 0.5) + 0.5;

const LABEL_STYLE = {
  fontFamily: "var(--obs-mono)",
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: "0.08em",
  fill: "var(--obs-fg-3)",
} as const;

export const SkyGrid = memo(function SkyGrid() {
  return (
    <svg
      aria-hidden
      width={980}
      height={560}
      viewBox="0 40 980 560"
      className="pointer-events-none absolute top-0 left-0"
      style={{ shapeRendering: "crispEdges" }}
    >
      <g stroke="var(--obs-grid)" strokeWidth={1}>
        {RA_LINES.map(([x]) => (
          <line key={`ra${x}`} x1={px(x)} y1={41} x2={px(x)} y2={600} />
        ))}
        {DEC_LINES.map(([y]) => (
          <line key={`de${y}`} x1={0} y1={px(y)} x2={980} y2={px(y)} />
        ))}
      </g>
      <g style={LABEL_STYLE}>
        {/* RA: y 46 (Oberkante), 4 px rechts der Linie */}
        {RA_LINES.map(([x, s]) => (
          <text key={`rat${x}`} x={x + 4} y={46} dominantBaseline="hanging">
            {s}
          </text>
        ))}
        {/* Dec: x 24, 4 px über der Linie */}
        {DEC_LINES.map(([y, s]) => (
          <text key={`det${y}`} x={24} y={y - 4}>
            {s}
          </text>
        ))}
      </g>
      {/* Maßstabsbalken 1′ = 100 px, x 24–124 bei y 576, Endstriche 4 px */}
      <g stroke="var(--obs-fg-3)" strokeWidth={1}>
        <line x1={24} y1={576.5} x2={124} y2={576.5} />
        <line x1={24.5} y1={574.5} x2={24.5} y2={578.5} />
        <line x1={123.5} y1={574.5} x2={123.5} y2={578.5} />
      </g>
      <text x={74} y={570} textAnchor="middle" style={LABEL_STYLE}>
        1′
      </text>
    </svg>
  );
});
