import { colorVar, cx } from '@aegis/ui';
import type { CSSProperties } from 'react';

/**
 * Ruhiges Bauplan-Raster (Linien in Rahmenfarbe, zu den Rändern ausgeblendet) – „hier entsteht
 * etwas“, ohne Schmuck oder Bewegung. Rein dekorativ.
 */
const blueprintStyle: CSSProperties = {
  backgroundImage: [
    `linear-gradient(to right, ${colorVar('border')} 1px, transparent 1px)`,
    `linear-gradient(to bottom, ${colorVar('border')} 1px, transparent 1px)`,
  ].join(', '),
  backgroundSize: '28px 28px',
  backgroundPosition: 'center center',
  maskImage: 'radial-gradient(ellipse 60% 70% at 50% 45%, black 0%, transparent 75%)',
  opacity: 0.55,
};

export function Blueprint({ className }: { readonly className?: string | undefined }) {
  return (
    <div
      aria-hidden="true"
      className={cx('pointer-events-none absolute inset-0 -z-10', className)}
      style={blueprintStyle}
    />
  );
}

/** Eckmarken wie ein Sucher-/Scan-Rahmen (Motiv aus Logo und Start-Animation). */
const corners = [
  'top-0 left-0 border-t border-l',
  'top-0 right-0 border-t border-r',
  'bottom-0 left-0 border-b border-l',
  'bottom-0 right-0 border-b border-r',
] as const;

export function ViewfinderCorners({ className }: { readonly className?: string | undefined }) {
  return (
    <>
      {corners.map((corner) => (
        <span
          key={corner}
          aria-hidden="true"
          className={cx('absolute size-3.5 border-border-strong', corner, className)}
        />
      ))}
    </>
  );
}
