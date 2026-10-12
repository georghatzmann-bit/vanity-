import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { spring } from "../design/motion";
import { sound } from "../sound/engine";

export interface CheckboxProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** Kästchen mit animiertem Häkchen (wird "gezeichnet") */
export function Checkbox({ checked, onChange, label, description, disabled, className }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onMouseEnter={() => !disabled && sound.play("hover")}
      onClick={() => {
        sound.play(checked ? "toggleOff" : "toggleOn");
        onChange(!checked);
      }}
      className={cn("group flex w-full items-start gap-3 text-left disabled:opacity-45", className)}
    >
      <motion.span
        className={cn(
          "relative mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[7px] border transition-colors duration-200",
          checked ? "border-transparent bg-gradient-accent shadow-[0_0_14px_-3px_var(--nv-accent)]" : "border-line-strong bg-surface-2 group-hover:border-accent/60",
        )}
        animate={{ scale: checked ? [1, 0.86, 1.06, 1] : 1 }}
        transition={{ duration: 0.38 }}
      >
        <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="none">
          <motion.path
            d="M5 12.5 L10 17 L19 7.5"
            stroke="white"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={false}
            animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
            transition={{ ...spring.snappy, opacity: { duration: 0.1 } }}
          />
        </svg>
      </motion.span>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium text-fg">{label}</span>}
          {description && <span className="mt-0.5 block text-[13px] leading-snug text-muted">{description}</span>}
        </span>
      )}
    </button>
  );
}
