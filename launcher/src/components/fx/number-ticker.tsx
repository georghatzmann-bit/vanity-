import { useEffect, useRef } from "react";
import { useMotionValue, useSpring } from "motion/react";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { cn } from "@/lib/utils";

export interface NumberTickerProps {
  value: number;
  /** Digits after the dot (default 0). */
  decimals?: number;
  /** Own formatting, e.g. (n) => `${n} m`. Gets the rounded number. */
  format?: (n: number) => string;
  /** Count up from 0 when it first appears (default true). */
  fromZero?: boolean;
  className?: string;
}

/** A number that rolls to its new value (tabular digits, so nothing jumps). */
export function NumberTicker({ value, decimals = 0, format, fromZero = true, className }: NumberTickerProps) {
  const calm = useCalmMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(calm || !fromZero ? value : 0);
  const spring = useSpring(mv, { stiffness: 90, damping: 20, restDelta: 0.001 });

  const render = (n: number) => {
    const rounded = Number(n.toFixed(decimals));
    return format ? format(rounded) : rounded.toFixed(decimals);
  };

  // The text is written by the spring; React only renders the first value (so it never fights the spring).
  const first = useRef<string | null>(null);
  if (first.current === null) first.current = render(calm || !fromZero ? value : 0);

  useEffect(() => {
    if (calm) spring.jump(value);
    else mv.set(value);
  }, [value, calm, mv, spring]);

  useEffect(
    () =>
      spring.on("change", (n) => {
        if (ref.current) ref.current.textContent = render(n);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spring, decimals, format],
  );

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {first.current}
    </span>
  );
}
