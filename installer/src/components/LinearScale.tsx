/**
 * Lineare Prozentskala (B.5/C.6), 472 px: Grundlinie `rule-strong`, Füllwert = 2 px gelbe Linie
 * AUF der Grundlinie (kein Balken). Hauptstriche alle 25 % (8 px), Zwischenstriche alle 5 % (4 px, 60 %).
 * Eingefroren (Fehler): Linie in `fg-3`.
 */
import { cn } from "@shared/lib/cn";

export interface LinearScaleProps {
  /** 0…100 */
  value: number;
  frozen?: boolean;
  labels?: string[];
  /** Sprünge statt Gleiten (reduzierte Bewegung) */
  reduced?: boolean;
  className?: string;
}

const W = 472;
/** Haarlinie: 1 Gerätepixel auch bei 150 % (siehe --hair in main.tsx) */
const HAIR = { strokeWidth: "var(--hair, 1px)" } as const;
const DEFAULT_LABELS = ["0", "25", "50", "75", "100"];

export function LinearScale({ value, frozen, labels = DEFAULT_LABELS, reduced, className }: LinearScaleProps) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const ticks: { x: number; main: boolean }[] = [];
  for (let p = 0; p <= 100; p += 5) ticks.push({ x: Math.min(W - 0.5, Math.round((p / 100) * W) + 0.5), main: p % 25 === 0 });
  return (
    <div className={cn("relative h-[28px] w-[472px]", className)} aria-hidden>
      <svg width={W} height={12} className="absolute -top-px left-0 block overflow-visible" shapeRendering="crispEdges">
        <line x1={0} x2={W} y1={1.5} y2={1.5} stroke="var(--obs-rule-strong)" style={HAIR} />
        {ticks.map((t) => (
          <line key={t.x} x1={t.x} x2={t.x} y1={2} y2={t.main ? 10 : 6} stroke="var(--obs-fg-3)" strokeOpacity={t.main ? 1 : 0.6} style={HAIR} />
        ))}
        <rect x={0} y={0.5} height={2} width={(v / 100) * W} fill={frozen ? "var(--obs-fg-3)" : "var(--obs-signal)"} style={reduced ? undefined : { transition: "width 240ms linear" }} />
      </svg>
      {labels.map((l, i) => {
        const n = labels.length;
        const left = n > 1 ? (i / (n - 1)) * W : 0;
        return (
          <span key={l + i} className={cn("obs-label absolute top-[14px]", i === 0 ? "left-0" : i === n - 1 ? "right-0" : "-translate-x-1/2")} style={i === 0 || i === n - 1 ? undefined : { left }}>
            {l}
          </span>
        );
      })}
    </div>
  );
}
