import { cx } from '../../utils/cx.ts';

export interface SpinnerProps {
  /** Kantenlänge in px. */
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}

/**
 * Dezenter Lade-Kreis (rotiert per transform). Dekorativ – den Ladezustand meldet die
 * umgebende Komponente (z. B. `aria-busy` am Button). Bei „Bewegung reduzieren“ steht der
 * Bogen still (globale Regel in styles.css).
 */
export function Spinner({ size = 16, className }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cx('shrink-0 animate-spin', className)}
      data-testid="aegis-spinner"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
