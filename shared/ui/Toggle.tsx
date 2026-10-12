import { motion } from "motion/react";
import { cn } from "../lib/cn";
import { spring } from "../design/motion";
import { sound } from "../sound/engine";

export interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

/** Schalter mit federndem Knopf und Leuchten im aktiven Zustand */
export function Toggle({ checked, onChange, disabled, label, className, size = "md" }: ToggleProps) {
  const w = size === "sm" ? 36 : 44;
  const h = size === "sm" ? 20 : 24;
  const knob = h - 6;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        sound.play(checked ? "toggleOff" : "toggleOn");
        onChange(!checked);
      }}
      onMouseEnter={() => !disabled && sound.play("hover")}
      className={cn(
        "relative shrink-0 rounded-full border transition-[background-color,border-color,box-shadow] duration-300 ease-nova disabled:opacity-40",
        checked ? "border-transparent bg-gradient-accent shadow-[0_0_18px_-4px_var(--nv-accent)]" : "border-line-strong bg-surface-2",
        className,
      )}
      style={{ width: w, height: h }}
    >
      <motion.span
        className="absolute top-[2px] block rounded-full bg-white shadow-[0_2px_6px_rgb(0_0_0/0.35)]"
        style={{ width: knob, height: knob }}
        initial={false}
        animate={{ left: checked ? w - knob - 4 : 2, scale: 1 }}
        whileTap={{ scale: 0.88 }}
        transition={spring.snappy}
      />
    </button>
  );
}
