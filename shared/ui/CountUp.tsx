import { useEffect, useRef } from "react";
import { animate, useInView } from "motion/react";

export interface CountUpProps {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  className?: string;
}

/** Zahl, die beim Erscheinen hochzählt */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString(), duration = 1.1, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const from = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || !inView) return;
    if (document.documentElement.dataset.motion === "off") {
      el.textContent = format(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        el.textContent = format(v);
      },
    });
    from.current = value;
    return () => controls.stop();
  }, [value, inView, duration, format]);

  return (
    <span ref={ref} className={className}>
      {format(0)}
    </span>
  );
}
