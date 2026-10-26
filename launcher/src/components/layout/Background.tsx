import { useEffect, useRef } from "react";

/** Frames per second for the aurora. It moves so slowly that 24 fps looks smooth and keeps the GPU calm. */
const FPS = 24;

/** Each blob drifts on its own slow Lissajous path: [x amplitude, y amplitude] in vmax, periods in seconds. */
const paths = [
  { ax: 7, ay: 5, px: 46, py: 58, s: 0.08, ps: 52, phase: 0 },
  { ax: 8, ay: 6, px: 58, py: 44, s: 0.1, ps: 61, phase: 1.7 },
  { ax: 5, ay: 4, px: 40, py: 50, s: 0.12, ps: 37, phase: 3.1 },
  { ax: 9, ay: 5, px: 64, py: 52, s: 0.07, ps: 70, phase: 4.4 },
];

/**
 * Background behind all glass: a slow aurora in the brand colours (blue, violet, a small gold one),
 * a fine dot grid, film grain and a vignette.
 * `animate` = settings.animatedBackground and not reduced motion; `paused` = window hidden/minimized.
 */
export function Background({ animate = true, paused = false }: { animate?: boolean; paused?: boolean }) {
  const blobs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (!animate || paused) return;
    let raf = 0;
    let last = 0;
    const start = performance.now() - 20_000; // start mid-path so it never begins in the same spot
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 1000 / FPS) return;
      last = now;
      const t = (now - start) / 1000;
      paths.forEach((p, i) => {
        const el = blobs.current[i];
        if (!el) return;
        const x = Math.sin((t / p.px) * Math.PI * 2 + p.phase) * p.ax;
        const y = Math.cos((t / p.py) * Math.PI * 2 + p.phase) * p.ay;
        const s = 1 + Math.sin((t / p.ps) * Math.PI * 2 + p.phase) * p.s;
        el.style.transform = `translate3d(${x.toFixed(3)}vmax, ${y.toFixed(3)}vmax, 0) scale(${s.toFixed(4)})`;
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [animate, paused]);

  return (
    <div className="nb-backdrop" aria-hidden="true">
      <div className="aurora">
        {paths.map((_, i) => (
          <span key={i} ref={(el) => void (blobs.current[i] = el)} />
        ))}
      </div>
      <div className="dot-grid" />
      <div className="nb-grain" />
      <div className="nb-vignette" />
    </div>
  );
}
