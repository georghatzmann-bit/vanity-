/**
 * Countdown als Instrument (C.7): Wert in Mono 15 („AUTOSTART IN 4 s“), darunter eine Linearskala
 * 472 px von ⌈`totalS`⌉ (links) bis 0 s (rechts). Hauptstriche je 1 s in gleichen Abständen (8 px,
 * fg-3), Beschriftung Mono 10 nur mit ganzen Sekunden (…·2·1·0). Die Restzeit darf bei 2,6 starten. Die Restzeit ist eine 2-px-Linie in fg-2 AUF der Grundlinie, rechtsbündig bei 0 – sie
 * schrumpft nach rechts. Kein Gelb (das Signal gehört dem Schirm). Reduzierte Bewegung: Sprünge
 * statt Gleiten. Ohne Ton.
 */
import type { ReactNode } from "react";
import { motion } from "motion/react";
import type { Lang } from "../i18n";

export interface CountdownProps {
  label: ReactNode;
  /** Skala von `totalS` bis 0 */
  totalS: number;
  /** Restzeit jetzt (s); null = angehalten (keine Linie) */
  remainingS: number | null;
  /** Restzeit, auf die die Linie in `glideS` linear zuläuft (Standard: gleich bleiben) */
  toS?: number;
  glideS?: number;
  lang: Lang;
  reduced?: boolean;
  testValue?: number | string;
}

const W = 472;

/** Skalenlänge: auf ganze Sekunden aufgerundet (2,6 s → Skala 3…0) */
export const countdownSpan = (totalS: number) => Math.ceil(totalS - 1e-9);

/** x-Lage (px) einer Restzeit auf der Skala: links ⌈`totalS`⌉, rechts 0 */
export function countdownX(t: number, totalS: number): number {
  const span = countdownSpan(totalS);
  if (!(span > 0)) return W;
  const v = Math.max(0, Math.min(span, t));
  return W - (v / span) * W;
}

/** Striche: jede ganze Sekunde von ⌈`totalS`⌉ (links) bis 0 (rechts), gleiche Abstände */
export function countdownTicks(totalS: number): { t: number; x: number }[] {
  const span = countdownSpan(totalS);
  if (!(span > 0)) return [];
  const out: { t: number; x: number }[] = [];
  for (let t = span; t >= 0; t--) out.push({ t, x: countdownX(t, totalS) });
  return out;
}

export function Countdown({ label, totalS, remainingS, toS, glideS = 1, reduced, testValue }: CountdownProps) {
  const ticks = countdownTicks(totalS);
  const from = remainingS === null ? 0 : W - countdownX(remainingS, totalS);
  const to = remainingS === null ? 0 : W - countdownX(toS ?? remainingS, totalS);
  return (
    <div className="w-[472px]" data-testid="countdown" data-value={testValue ?? remainingS ?? ""}>
      <div className="obs-value obs-value-md text-obs-fg" aria-live="off">
        {label}
      </div>
      <div aria-hidden className="relative mt-3 h-[34px] w-[472px]">
        <svg width={W} height={12} className="absolute top-0 left-0 block overflow-visible" shapeRendering="crispEdges">
          <line x1={0} x2={W} y1={1.5} y2={1.5} stroke="var(--obs-rule-strong)" style={{ strokeWidth: "var(--hair, 1px)" }} />
          {ticks.map((k) => {
            const x = Math.min(W - 0.5, Math.round(k.x) + 0.5);
            return <line key={k.t} x1={x} x2={x} y1={2} y2={10} stroke="var(--obs-fg-3)" style={{ strokeWidth: "var(--hair, 1px)" }} />;
          })}
        </svg>
        {remainingS !== null &&
          (reduced || from === to ? (
            <div className="absolute top-px right-0 h-[2px] bg-obs-fg-2" style={{ width: to }} />
          ) : (
            <motion.div
              key={`${remainingS}-${toS}`}
              className="absolute top-px right-0 h-[2px] bg-obs-fg-2"
              initial={{ width: from }}
              animate={{ width: to }}
              transition={{ duration: glideS, ease: "linear" }}
            />
          ))}
        {ticks.map((k, i) => (
          <span
            key={k.t}
            className={i === 0 ? "obs-label absolute top-[14px] left-0" : i === ticks.length - 1 ? "obs-label absolute top-[14px] right-0" : "obs-label absolute top-[14px] -translate-x-1/2"}
            style={i === 0 || i === ticks.length - 1 ? undefined : { left: Math.round(k.x) }}
          >
            {String(k.t)}
          </span>
        ))}
      </div>
    </div>
  );
}
