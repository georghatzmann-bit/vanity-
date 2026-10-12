import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "../lib/cn";

export interface BurstOptions {
  count?: number;
  speed?: number;
  /** Lebensdauer in Sekunden */
  life?: number;
  spread?: number;
}

export interface StarfieldHandle {
  /** Partikel-Explosion an Position (Pixel relativ zum Canvas) */
  burst: (x: number, y: number, opts?: BurstOptions) => void;
}

export interface StarfieldProps {
  className?: string;
  /** Sterne pro 10.000 px² */
  density?: number;
  parallax?: boolean;
  /** 0 = still, 1 = normale Drift */
  drift?: number;
  /** Komplett aus (z. B. "Animationen aus") - dann nur ein stilles Bild */
  still?: boolean;
}

interface Star {
  x: number;
  y: number;
  z: number; // Tiefe 0..1 (1 = nah)
  r: number;
  tw: number; // Funkel-Phase
  tws: number; // Funkel-Tempo
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

function readVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Sternenhimmel auf Canvas: drei Tiefenebenen, Funkeln, Maus-Parallax und Partikel-Explosionen.
 * Pausiert automatisch, wenn das Fenster nicht sichtbar ist.
 */
export const Starfield = forwardRef<StarfieldHandle, StarfieldProps>(function Starfield(
  { className, density = 1.2, parallax = true, drift = 1, still = false },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particles = useRef<Particle[]>([]);
  const colors = useRef<string[]>(["#ff8a4c", "#ff4f8b", "#8b5cf6", "#ffffff"]);
  const kick = useRef<() => void>(() => undefined);

  useImperativeHandle(ref, () => ({
    burst(x, y, opts = {}) {
      const { count = 90, speed = 7, life = 1.6, spread = Math.PI * 2 } = opts;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
        const s = speed * (0.25 + Math.random() * 0.9);
        particles.current.push({
          x,
          y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: 0,
          max: life * (0.5 + Math.random() * 0.7),
          size: 0.8 + Math.random() * 2.4,
          color: colors.current[Math.floor(Math.random() * colors.current.length)],
        });
      }
      kick.current();
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let stars: Star[] = [];
    let starRgb = "255 255 255";
    let raf = 0;
    let last = performance.now();
    let running = false;
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };

    const readColors = () => {
      starRgb = readVar("--nv-star", "255 255 255");
      colors.current = [readVar("--nv-accent-2", "#ff8a4c"), readVar("--nv-accent", "#ff4f8b"), readVar("--nv-accent-3", "#8b5cf6"), "#ffffff"];
    };

    const seed = () => {
      const count = Math.round(((w * h) / 10000) * density);
      stars = Array.from({ length: Math.min(count, 900) }, () => {
        const z = Math.random();
        return { x: Math.random() * w, y: Math.random() * h, z, r: 0.35 + z * 1.25, tw: Math.random() * Math.PI * 2, tws: 0.6 + Math.random() * 1.8 };
      });
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      draw(0);
    };

    const draw = (dt: number) => {
      ctx.clearRect(0, 0, w, h);
      mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 3);
      mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 3);
      const t = performance.now() / 1000;
      for (const s of stars) {
        if (!still) {
          s.y += dt * drift * (2 + s.z * 7);
          if (s.y > h + 4) {
            s.y = -4;
            s.x = Math.random() * w;
          }
        }
        const px = parallax ? mouse.x * (6 + s.z * 26) : 0;
        const py = parallax ? mouse.y * (4 + s.z * 18) : 0;
        const tw = still ? 0.8 : 0.55 + 0.45 * Math.sin(t * s.tws + s.tw);
        const a = (0.18 + s.z * 0.62) * tw;
        ctx.fillStyle = `rgb(${starRgb} / ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(s.x + px, s.y + py, s.r, 0, Math.PI * 2);
        ctx.fill();
        if (s.z > 0.92 && !still) {
          // helle Sterne bekommen ein kleines Kreuz-Funkeln
          ctx.strokeStyle = `rgb(${starRgb} / ${(a * 0.5).toFixed(3)})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(s.x + px - s.r * 3, s.y + py);
          ctx.lineTo(s.x + px + s.r * 3, s.y + py);
          ctx.moveTo(s.x + px, s.y + py - s.r * 3);
          ctx.lineTo(s.x + px, s.y + py + s.r * 3);
          ctx.stroke();
        }
      }
      // Partikel
      const ps = particles.current;
      if (ps.length) {
        ctx.globalCompositeOperation = "lighter";
        for (let i = ps.length - 1; i >= 0; i--) {
          const p = ps[i];
          p.life += dt;
          if (p.life >= p.max) {
            ps.splice(i, 1);
            continue;
          }
          p.vx *= 1 - dt * 1.8;
          p.vy *= 1 - dt * 1.8;
          p.vy += dt * 2.2;
          p.x += p.vx * dt * 60;
          p.y += p.vy * dt * 60;
          const k = 1 - p.life / p.max;
          ctx.globalAlpha = Math.max(0, k);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.4 + k * 0.8), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(dt);
      if (still && particles.current.length === 0) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (running || document.hidden) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    kick.current = start;

    const onMove = (e: PointerEvent) => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    const onVis = () => (document.hidden ? stop() : start());

    readColors();
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const mo = new MutationObserver(() => {
      readColors();
      if (!running) draw(0);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    if (!still) start();

    return () => {
      stop();
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [density, parallax, drift, still]);

  return <canvas ref={canvasRef} className={cn("pointer-events-none block h-full w-full", className)} aria-hidden />;
});
