/**
 * Messwert (B.3/F.4): Plex Mono mit Einheit (−2 px, NBSP davor). `layout="row"` = Label links
 * (Spalte 90 px), Wert rechts – wie EMPFANGEN / RATE / REST in der Installation.
 */
import type { Ref } from "react";
import { cn } from "@shared/lib/cn";
import { formatBytes, formatEta } from "../i18n";
import { NBSP } from "../obs/format";

export interface ReadoutProps {
  label?: string;
  value: string;
  unit?: string;
  /** Leerzeichen vor der Einheit (en-Prozent: nein) */
  unitGap?: boolean;
  size: "xl" | "lg" | "md" | "sm";
  tone?: "fg" | "signal" | "muted" | "error";
  layout?: "stack" | "row";
  valueRef?: Ref<HTMLSpanElement>;
  testId?: string;
  dataValue?: string | number;
  className?: string;
}

const TONE = { fg: "text-obs-fg", signal: "text-obs-signal", muted: "text-obs-fg-3", error: "text-obs-error" } as const;

/** Leerzeichen innerhalb eines Werts → U+00A0 (B.3) */
export const nb = (s: string) => s.replace(/ /g, NBSP);
/** formatBytes mit NBSP */
export const bytes = (b: number) => nb(formatBytes(b));
/** formatEta mit NBSP */
export const eta = (s: number) => nb(formatEta(s));

/**
 * Große Mono-Ziffern (≥ 24 px): Das Dezimaltrennzeichen füllt sonst eine ganze Mono-Zelle und reißt
 * ein Loch („47 ,1“ liest sich wie zwei Zahlen). Trennzeichen in einen Span mit −0,15em links und rechts.
 */
export function TightDecimal({ text }: { text: string }) {
  const m = /^(.*\d)([.,])(\d.*)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="obs-decimal" style={{ marginInline: "-0.15em" }}>
        {m[2]}
      </span>
      {m[3]}
    </>
  );
}

export function Readout({ label, value, unit, unitGap = true, size, tone = "fg", layout = "stack", valueRef, testId, dataValue, className }: ReadoutProps) {
  const v = (
    <span className={cn("obs-value", `obs-value-${size}`, TONE[tone])} data-testid={testId} data-value={dataValue}>
      <span ref={valueRef}>{size === "xl" ? <TightDecimal text={value} /> : value}</span>
      {unit && (
        <span className="obs-unit">
          {unitGap ? NBSP : ""}
          {unit}
        </span>
      )}
    </span>
  );
  if (layout === "row") {
    return (
      <div className={cn("flex items-baseline", className)}>
        {label && <span className="obs-label w-[90px] shrink-0">{label}</span>}
        {v}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col", className)}>
      {label && <span className="obs-label">{label}</span>}
      {v}
    </div>
  );
}
