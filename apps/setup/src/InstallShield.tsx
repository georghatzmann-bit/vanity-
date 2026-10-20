/**
 * Eigene Animation des Setups: Das AEGIS-Schild sitzt in einem Ring, der sich mit dem
 * Fortschritt schließt (SVG-Linie zeichnen über `stroke-dashoffset` – die erlaubte Ausnahme),
 * dazu ein ruhiges Atmen über `transform`/`opacity`. Bei „Bewegung reduzieren“ springt der Ring
 * ohne Übergang, das Atmen entfällt.
 */
import { AegisLogo } from '@aegis/ui';

const RADIUS = 54;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function InstallShield({
  progress,
  done = false,
  label,
}: {
  /** 0–1; `null` = noch kein Fortschritt (nur Atmen). */
  readonly progress: number | null;
  readonly done?: boolean;
  readonly label: string;
}) {
  const value = progress === null ? 0 : Math.min(1, Math.max(0, progress));
  return (
    <div
      className="relative grid size-40 place-items-center"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress === null ? undefined : Math.round(value * 100)}
      data-testid="install-shield"
    >
      <svg
        viewBox="0 0 120 120"
        className="absolute inset-0 size-full -rotate-90"
        aria-hidden="true"
      >
        <circle cx="60" cy="60" r={RADIUS} fill="none" className="stroke-border" strokeWidth="4" />
        <circle
          cx="60"
          cy="60"
          r={RADIUS}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - value)}
          className={`${done ? 'stroke-success' : 'stroke-accent'} transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none`}
        />
      </svg>
      <div
        className={
          done
            ? 'scale-105 transition-transform duration-300 motion-reduce:transition-none'
            : 'animate-pulse motion-reduce:animate-none'
        }
      >
        <AegisLogo size={72} decorative />
      </div>
    </div>
  );
}
