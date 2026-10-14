/**
 * Kontrollkästchen (B.7): 16 × 16, 1 px `control`; angehakt Fläche `signal`, SVG-Haken in 120 ms.
 * Die ganze Zeile (Kästchen, Titel, Beschreibung) ist ein einziges Bedienelement.
 */
import { useId } from "react";
import { motion } from "motion/react";
import { sound } from "@shared/sound/engine";

export interface ObsCheckboxProps {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  description?: string;
}

export function ObsCheckbox({ checked, onChange, label, description }: ObsCheckboxProps) {
  const id = useId();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-labelledby={`${id}-l`}
      aria-describedby={description ? `${id}-d` : undefined}
      className="flex w-[472px] items-start gap-3 rounded-[2px] text-left"
      onMouseEnter={() => sound.play("hover")}
      onClick={() => {
        sound.play(checked ? "toggleOff" : "toggleOn");
        onChange(!checked);
      }}
    >
      <span aria-hidden className="obs-check mt-0.5" data-on={checked}>
        {checked && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <motion.path d="M2.2 6.3L4.9 8.9L9.8 3.4" stroke="var(--obs-signal-ink)" strokeWidth={1.75} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }} />
          </svg>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-l`} className="block text-[14px] leading-5 font-semibold text-obs-fg">
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} className="mt-0.5 block text-[13px] leading-5 text-obs-fg-2">
            {description}
          </span>
        )}
      </span>
    </button>
  );
}
