import { useEffect, useRef } from "react";
import { motion } from "motion/react";

/**
 * Fortschritt als leuchtende Kugel, die sich mit "Flüssigkeit" füllt.
 * Zwei überlagerte Wellen bewegen sich gegeneinander - wirkt lebendig, kostet kaum Leistung.
 */
export function WaveRing({ value, size = 220, children, error }: { value: number; size?: number; children?: React.ReactNode; error?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(value);
  target.current = value;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const c1 = css.getPropertyValue("--nv-accent-2").trim() || "#ff8a4c";
    const c2 = css.getPropertyValue("--nv-accent").trim() || "#ff4f8b";
    const c3 = css.getPropertyValue("--nv-accent-3").trim() || "#8b5cf6";
    let level = target.current;
    let raf = 0;
    const r = size / 2 - 14;
    const cx = size / 2;
    const draw = (time: number) => {
      level += (target.current - level) * 0.06;
      const t = time / 1000;
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cx, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, size, size);
      const y = cx + r - level * 2 * r;
      const wave = (amp: number, len: number, speed: number, offset: number, fill: string | CanvasGradient, alpha: number) => {
        ctx.beginPath();
        ctx.moveTo(0, size);
        for (let x = 0; x <= size; x += 2) ctx.lineTo(x, y + Math.sin(x / len + t * speed + offset) * amp);
        ctx.lineTo(size, size);
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = fill;
        ctx.fill();
      };
      const g = ctx.createLinearGradient(0, cx - r, 0, cx + r);
      g.addColorStop(0, c1);
      g.addColorStop(0.5, c2);
      g.addColorStop(1, c3);
      const amp = level > 0.995 ? 1.5 : 7;
      wave(amp, 26, 2.2, 0, g, 0.45);
      wave(amp * 0.8, 20, -1.6, 2, g, 0.85);
      // Glanzlicht
      ctx.globalAlpha = 1;
      const shine = ctx.createRadialGradient(cx - r * 0.4, cx - r * 0.5, 2, cx - r * 0.4, cx - r * 0.5, r);
      shine.addColorStop(0, "rgba(255,255,255,0.18)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      ctx.fillRect(0, 0, size, size);
      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  const circ = 2 * Math.PI * (size / 2 - 4);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full blur-2xl" style={{ background: error ? "color-mix(in oklab, var(--nv-danger) 35%, transparent)" : "color-mix(in oklab, var(--nv-accent) 30%, transparent)" }} />
      <canvas ref={ref} className="absolute inset-0" style={{ width: size, height: size }} />
      <svg width={size} height={size} className="absolute inset-0 -rotate-90">
        <defs>
          <linearGradient id="wr-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--nv-accent-2)" />
            <stop offset="0.5" stopColor="var(--nv-accent)" />
            <stop offset="1" stopColor="var(--nv-accent-3)" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={size / 2 - 4} fill="none" stroke="var(--nv-surface-3)" strokeWidth="3" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 4}
          fill="none"
          stroke={error ? "var(--nv-danger)" : "url(#wr-g)"}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circ}
          animate={{ strokeDashoffset: circ * (1 - Math.min(1, Math.max(0, value))) }}
          transition={{ type: "spring", stiffness: 60, damping: 20 }}
          style={{ filter: "drop-shadow(0 0 6px var(--nv-accent))" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
