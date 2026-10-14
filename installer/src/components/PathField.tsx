/**
 * Pfad-Eingabe (B.7): Label oben (Mono 10), Feld 472 × 40, Plex Mono 13, Fokus = gelber Rand + Inset.
 */
import { useId } from "react";

export interface PathFieldProps {
  label: string;
  value: string;
  onChange(v: string): void;
  invalid?: boolean;
  describedBy?: string;
}

export function PathField({ label, value, onChange, invalid, describedBy }: PathFieldProps) {
  const id = useId();
  return (
    <div className="w-[472px]">
      <label htmlFor={id} className="obs-label block">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="obs-input mt-0.5"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    </div>
  );
}
