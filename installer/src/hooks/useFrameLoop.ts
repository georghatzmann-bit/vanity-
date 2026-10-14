/**
 * Ein gemeinsamer rAF für alle Zeichenflächen (H „Leistung“). Läuft nur mit Abonnenten
 * und steht bei `document.hidden` (danach kein Nachholen, der Abstand beginnt neu).
 */
import { useEffect, useRef } from "react";

/** nowMs = rAF-Zeit (performance.now), dtMs = Abstand zum letzten Aufruf dieses Abonnenten, rafGapMs = roher rAF-Abstand */
export type FrameCallback = (nowMs: number, dtMs: number, rafGapMs: number) => void;
type Sub = (now: number, rafGap: number) => void;

const subs = new Set<Sub>();
let raf = 0;
let last = 0;

function tick(now: number) {
  raf = 0;
  const gap = last ? now - last : 16.7;
  last = now;
  subs.forEach((cb) => {
    try {
      cb(now, gap);
    } catch (e) {
      console.warn("[frame]", e);
    }
  });
  schedule();
}

function schedule() {
  if (raf || subs.size === 0 || typeof document === "undefined" || document.hidden || typeof requestAnimationFrame === "undefined") return;
  raf = requestAnimationFrame(tick);
}

function halt() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) halt();
    else schedule();
  });
}

/** Zahl der Abonnenten (für Tests/Diagnose) */
export function frameLoopSubscribers(): number {
  return subs.size;
}

/**
 * Abonniert den gemeinsamen rAF. `fps` drosselt (z. B. 30 bei Qualitätsstufe L1);
 * `active = false` meldet ab (z. B. Standbild).
 */
export function useFrameLoop(cb: FrameCallback, active = true, fps?: number): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!active) return;
    // 1 ms Toleranz, damit 30 fps bei 60-Hz-Bildschirm nicht auf 20 fps rutschen
    const minGap = fps && fps < 120 ? 1000 / fps - 1.5 : 0;
    let prev = 0;
    const sub: Sub = (now, rafGap) => {
      if (minGap && prev && now - prev < minGap && rafGap < 250) return;
      const dt = prev ? now - prev : 16.7;
      prev = now;
      ref.current(now, dt, rafGap);
    };
    subs.add(sub);
    schedule();
    return () => {
      subs.delete(sub);
      if (subs.size === 0) halt();
    };
  }, [active, fps]);
}
