// Games screen micro-FX: spark bursts and shockwave rings (DOM + GSAP, rich motion only).
import { gsap, richMotion, motionOK } from '../core/motion.js';

/** Point (relative to host) at the centre of `el`, or the host centre. */
export function centerIn(host, el) {
  const hr = host.getBoundingClientRect();
  if (!el) return { x: hr.width / 2, y: hr.height / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left - hr.left + r.width / 2, y: r.top - hr.top + r.height / 2 };
}

/**
 * Spark burst from (x, y) inside host (host needs position: relative and visible overflow).
 * colors: CSS colors the sparks pick from. Returns nothing; sparks remove themselves.
 */
export function sparkBurst(host, { x, y, count = 16, spread = 120, colors = ['#ede9fe', '#c4b5fd', '#a78bfa', '#8b5cf6'] } = {}) {
  if (!host || !richMotion()) return;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'gspark';
    s.setAttribute('aria-hidden', 'true');
    const size = 3 + Math.random() * 4;
    const color = colors[i % colors.length];
    Object.assign(s.style, { left: `${x}px`, top: `${y}px`, width: `${size}px`, height: `${size}px`, background: color, boxShadow: `0 0 10px ${color}` });
    host.append(s);
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const d = spread * (0.45 + Math.random() * 0.75);
    gsap.fromTo(
      s,
      { x: 0, y: 0, scale: 1, opacity: 1 },
      {
        x: Math.cos(a) * d,
        y: Math.sin(a) * d - 18,
        scale: 0,
        opacity: 0,
        duration: 0.7 + Math.random() * 0.5,
        ease: 'expo.out',
        onComplete: () => s.remove(),
      },
    );
  }
}

/** Expanding ring from (x, y). */
export function shockwave(host, { x, y, size = 220, color = 'rgba(196, 181, 253, 0.85)', duration = 0.85 } = {}) {
  if (!host || !motionOK()) return;
  const ring = document.createElement('span');
  ring.className = 'gshock';
  ring.setAttribute('aria-hidden', 'true');
  Object.assign(ring.style, { left: `${x - size / 2}px`, top: `${y - size / 2}px`, width: `${size}px`, height: `${size}px`, borderColor: color });
  host.append(ring);
  gsap.fromTo(ring, { scale: 0.1, opacity: 1 }, { scale: 1, opacity: 0, duration, ease: 'expo.out', onComplete: () => ring.remove() });
}
