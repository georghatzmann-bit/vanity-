/**
 * Schrittskala (C.3): Ziffern y 56, Grundlinie y 76, gelbes Caret y 82–87, Name y 90.
 * Ticks gleichmäßig über 472 px (bei 5 Schritten x 468 + 118·i). Nummern für alle Schritte
 * (erledigt fg-2, offen fg-3, aktuell fg); den NAMEN trägt nur der aktuelle Schritt – zentriert
 * unter seinem Tick, auf 468–940 begrenzt (keine Phrasen aus Nachbarnamen). Kopfzeilen-Modus: nur `label`
 * mit Grundlinie (Wartung). Mit `steps` und `label` ersetzt das Label die Ziffernzeile (Update).
 * Lage im Block: oben = y 56.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@shared/lib/cn";
import { Glyph } from "./Glyph";

export type StepScaleProps = { steps: string[]; current: number; label?: ReactNode } | { label: ReactNode; steps?: undefined; current?: undefined };

const W = 472;

function align(i: number, n: number) {
  if (i === 0) return "left-0";
  if (i === n - 1) return "right-0";
  return "-translate-x-1/2";
}

/** Name des aktuellen Schritts: zentriert unter dem Tick, innerhalb von 0…472 gehalten */
function CurrentName({ text, x }: { text: string; x: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setW(el.offsetWidth);
    // Schrift kann später fertig laden (andere Breite)
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live && ref.current) setW(ref.current.offsetWidth);
    });
    return () => {
      live = false;
    };
  }, [text]);
  const left = Math.max(0, Math.min(W - w, Math.round(x - w / 2)));
  return (
    <span ref={ref} className="obs-label absolute top-[34px] whitespace-nowrap text-obs-fg" style={{ left, visibility: w ? undefined : "hidden" }}>
      {text}
    </span>
  );
}

export function StepScale(props: StepScaleProps) {
  if (!props.steps) {
    return (
      <div className="relative h-12 w-[472px]">
        <div className="obs-label absolute top-0 left-0 text-obs-fg-2">{props.label}</div>
        <div aria-hidden className="absolute top-5 left-0 h-px w-full bg-obs-rule-strong" />
      </div>
    );
  }
  const { steps, current, label } = props;
  const n = steps.length;
  const gap = n > 1 ? W / (n - 1) : 0;
  const x = (i: number) => Math.round(i * gap);
  const cur = Math.max(0, Math.min(n - 1, current));
  return (
    <div className="relative h-12 w-[472px]">
      {/* Bildschirmleser: geordnete Liste mit aktuellem Schritt */}
      <ol className="obs-sr-only">
        {steps.map((s, i) => (
          <li key={s + i} aria-current={i === cur ? "step" : undefined}>
            {s}
          </li>
        ))}
      </ol>
      <div aria-hidden>
        {label ? (
          <div className="obs-label absolute top-0 left-0 flex items-center gap-1.5 text-obs-fg-2">{label}</div>
        ) : (
          steps.map((_, i) => (
            <span
              key={i}
              className={cn("obs-label absolute top-0", align(i, n), i === cur ? "text-obs-fg" : i < cur ? "text-obs-fg-2" : "text-obs-fg-3")}
              style={i === 0 || i === n - 1 ? undefined : { left: x(i) }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
          ))
        )}
        {/* Grundlinie: bis zum aktuellen Tick fg-2, danach rule-strong */}
        <div className="absolute top-5 left-0 h-px w-full bg-obs-rule-strong" />
        <div className="absolute top-5 left-0 h-px bg-obs-fg-2" style={{ width: x(cur) + 1 }} />
        {steps.map((_, i) => (
          <div key={i} className={cn("absolute top-4 h-2 w-px", i <= cur ? "bg-obs-fg-2" : "bg-obs-fg-3")} style={{ left: Math.min(x(i), W - 1) }} />
        ))}
        <span className="absolute top-[26px] text-obs-signal" style={{ left: Math.min(x(cur), W - 1) - 3 }}>
          <Glyph name="tri-up" className="block" />
        </span>
        <CurrentName text={steps[cur]} x={Math.min(x(cur), W - 1)} />
      </div>
    </div>
  );
}
