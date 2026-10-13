import { useId, useMemo, useState } from "react";
import { pingColor } from "@/lib/grade";
import { cn } from "@shared/lib/cn";

export interface PingPoint {
  t: number;
  rtt: number | null;
}

/**
 * Live-Diagramm des Pings: weiche Linie mit Farbverlauf, verlorene Pakete als rote Marker,
 * Spitzen sichtbar. Selbst gezeichnet (SVG) – kein Diagramm-Paket nötig.
 */
export function PingChart({ points, height = 160, alertMs, className, compact = false, windowMs }: { points: PingPoint[]; height?: number; alertMs?: number; className?: string; compact?: boolean; windowMs?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = height;
  const padT = compact ? 4 : 10;
  const padB = compact ? 4 : 18;

  const view = useMemo(() => {
    const now = points.length ? points[points.length - 1].t : Date.now();
    const from = windowMs ? now - windowMs : points.length ? points[0].t : now - 60000;
    const span = Math.max(1000, now - from);
    const vals = points.map((p) => p.rtt).filter((v): v is number => v !== null);
    const max = Math.max(alertMs ? alertMs * 1.1 : 0, 40, ...vals) * 1.08;
    const x = (t: number) => ((t - from) / span) * W;
    const y = (v: number) => H - padB - (Math.min(v, max) / max) * (H - padT - padB);
    let d = "";
    let area = "";
    const lost: { x: number }[] = [];
    let open = false;
    for (const p of points) {
      if (p.t < from) continue;
      const px = x(p.t);
      if (p.rtt === null) {
        lost.push({ x: px });
        open = false;
        continue;
      }
      const py = y(p.rtt);
      if (!open) {
        d += `M${px.toFixed(1)},${py.toFixed(1)}`;
        area += `M${px.toFixed(1)},${H - padB}L${px.toFixed(1)},${py.toFixed(1)}`;
        open = true;
      } else {
        d += `L${px.toFixed(1)},${py.toFixed(1)}`;
        area += `L${px.toFixed(1)},${py.toFixed(1)}`;
      }
      // Fläche bis zum Boden schließen, wenn danach ein Verlust kommt – einfacher: am Ende schließen
    }
    const lastPt = [...points].reverse().find((p) => p.rtt !== null && p.t >= from);
    if (lastPt) area += `L${x(lastPt.t).toFixed(1)},${H - padB}Z`;
    const ticks = [0.25, 0.5, 0.75].map((f) => ({ v: Math.round(max * f), y: y(max * f) }));
    return { d, area, lost, max, x, y, from, span, ticks, last: lastPt };
  }, [points, alertMs, H, padT, padB, windowMs]);

  const hovered = hover !== null ? points.filter((p) => p.t >= view.from).reduce<PingPoint | null>((best, p) => (best === null || Math.abs(view.x(p.t) - hover) < Math.abs(view.x(best.t) - hover) ? p : best), null) : null;

  return (
    <div className={cn("relative w-full select-none", className)} style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHover(((e.clientX - r.left) / r.width) * W);
      }} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`${id}l`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--nv-danger)" />
            <stop offset={`${Math.max(0, 1 - 100 / view.max) * 100}%`} stopColor="var(--nv-warning)" />
            <stop offset={`${Math.max(0, 1 - 60 / view.max) * 100}%`} stopColor="var(--nv-accent)" />
            <stop offset={`${Math.max(0, 1 - 35 / view.max) * 100}%`} stopColor="var(--nv-success)" />
            <stop offset="1" stopColor="var(--nv-success)" />
          </linearGradient>
          <linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--nv-accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--nv-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {!compact &&
          view.ticks.map((tk) => (
            <g key={tk.v}>
              <line x1="0" x2={W} y1={tk.y} y2={tk.y} stroke="var(--nv-border)" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        {alertMs && alertMs < view.max && <line x1="0" x2={W} y1={view.y(alertMs)} y2={view.y(alertMs)} stroke="var(--nv-danger)" strokeOpacity="0.5" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />}
        <path d={view.area} fill={`url(#${id}a)`} />
        <path d={view.d} fill="none" stroke={`url(#${id}l)`} strokeWidth={compact ? 2 : 2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ filter: "drop-shadow(0 0 6px color-mix(in oklab, var(--nv-accent) 50%, transparent))" }} />
        {view.lost.map((l, i) => (
          <line key={i} x1={l.x} x2={l.x} y1={padT} y2={H - padB} stroke="var(--nv-danger)" strokeOpacity="0.7" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}
        {view.last && (
          <circle cx={view.x(view.last.t)} cy={view.y(view.last.rtt ?? 0)} r={compact ? 3 : 4.5} fill={pingColor(view.last.rtt)} style={{ filter: `drop-shadow(0 0 6px ${pingColor(view.last.rtt)})` }} vectorEffect="non-scaling-stroke" />
        )}
        {hovered && hover !== null && <line x1={view.x(hovered.t)} x2={view.x(hovered.t)} y1={padT} y2={H - padB} stroke="var(--nv-fg)" strokeOpacity="0.35" vectorEffect="non-scaling-stroke" />}
      </svg>
      {!compact && (
        <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between py-2 text-[10px] text-faint tabular">
          <span>{Math.round(view.max)}</span>
          <span>{Math.round(view.max / 2)}</span>
          <span>0 ms</span>
        </div>
      )}
      {hovered && hover !== null && (
        <div className="pointer-events-none absolute top-1 rounded-md bg-surface-solid px-2 py-1 text-[11px] whitespace-nowrap shadow-lg ring-1 ring-line" style={{ left: `calc(${(view.x(hovered.t) / W) * 100}% + 8px)` }}>
          <span className="font-semibold" style={{ color: pingColor(hovered.rtt) }}>
            {hovered.rtt === null ? "✕" : `${hovered.rtt.toFixed(1)} ms`}
          </span>
        </div>
      )}
    </div>
  );
}
