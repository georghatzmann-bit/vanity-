import type { ReactNode } from 'react';
import {
  IconCheck,
  IconDanger,
  IconMinus,
  IconPower,
  IconScan,
  IconWarning,
} from '../../icons/icons.tsx';
import type { IconComponent } from '../../icons/createIcon.tsx';
import { cx } from '../../utils/cx.ts';

/** Zustand eines Moduls (z. B. Echtzeit-Wächter, Signaturen, Web-Schutz). */
export const moduleStates = ['ok', 'warn', 'danger', 'off', 'unavailable', 'scanning'] as const;
export type ModuleState = (typeof moduleStates)[number];

/** Deutsche Standard-Beschriftungen der Zustände. */
export const moduleStateLabels: Readonly<Record<ModuleState, string>> = {
  ok: 'In Ordnung',
  warn: 'Achtung',
  danger: 'Gefahr',
  off: 'Aus',
  unavailable: 'Nicht verfügbar',
  scanning: 'Prüft …',
};

const stateIcons: Readonly<Record<ModuleState, IconComponent>> = {
  ok: IconCheck,
  warn: IconWarning,
  danger: IconDanger,
  off: IconPower,
  unavailable: IconMinus,
  scanning: IconScan,
};

const toneText: Readonly<Record<ModuleState, string>> = {
  ok: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  off: 'text-text-muted',
  unavailable: 'text-text-subtle',
  scanning: 'text-accent',
};

export interface StatusRingProps {
  readonly state: ModuleState;
  /** Name des Moduls, z. B. „Echtzeit-Wächter“. */
  readonly label: string;
  /** Ergänzung unter dem Zustand, z. B. „Folgt in P3“ oder „Signaturen vom 18.10.“. */
  readonly sublabel?: ReactNode;
  /** Eigene Zustands-Beschriftung (Standard aus `moduleStateLabels`). */
  readonly stateLabel?: string | undefined;
  /** Icon in der Mitte (Standard: Zustands-Symbol). */
  readonly icon?: ReactNode;
  /** Ring-Durchmesser in px (Standard 88). */
  readonly size?: number | undefined;
  /** `stacked` = Ring über dem Text, `inline` = Ring links, Text rechts. */
  readonly layout?: 'stacked' | 'inline' | undefined;
  /**
   * Text ausblenden (z. B. im Tray). Dann ist der Ring eine benannte Grafik
   * (`role="img"`, Name = „Modul: Zustand“).
   */
  readonly hideText?: boolean | undefined;
  readonly className?: string | undefined;
}

const VIEWBOX = 100;
const CENTER = VIEWBOX / 2;
const RADIUS = 42;
const STROKE = 5;
const TICKS = 48;

/** Feine Skalenstriche um den Ring (Instrumenten-Anmutung). */
const tickPath = Array.from({ length: TICKS }, (_, index) => {
  const angle = (index / TICKS) * Math.PI * 2;
  const inner = RADIUS + STROKE / 2 + 2.5;
  const outer = inner + (index % 4 === 0 ? 3 : 1.75);
  const x1 = CENTER + inner * Math.sin(angle);
  const y1 = CENTER - inner * Math.cos(angle);
  const x2 = CENTER + outer * Math.sin(angle);
  const y2 = CENTER - outer * Math.cos(angle);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
}).join('');

/** Bogenlänge des Scan-Segments (Anteil am Umfang). */
const SCAN_FRACTION = 0.26;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({ state }: { readonly state: ModuleState }) {
  const tone = toneText[state];
  const filled = state === 'ok' || state === 'warn' || state === 'danger';
  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className="absolute inset-0 size-full overflow-visible"
      aria-hidden="true"
      focusable="false"
    >
      <path d={tickPath} className="stroke-border" strokeWidth="0.9" strokeLinecap="round" />
      {state === 'unavailable' ? (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          className="stroke-border-strong"
          strokeWidth={STROKE - 2}
          strokeDasharray="1.5 5"
          strokeLinecap="round"
          data-part="dashed"
        />
      ) : (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          className={state === 'off' ? 'stroke-border-strong' : 'stroke-surface-3'}
          strokeWidth={state === 'off' ? STROKE - 2 : STROKE}
          data-part="track"
        />
      )}
      {filled && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className={tone}
          data-part="arc"
        />
      )}
      {state === 'scanning' && (
        <g
          className="origin-center animate-aegis-orbit motion-reduce:animate-none"
          data-part="scan"
        >
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * SCAN_FRACTION).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
            transform={`rotate(-90 ${CENTER} ${CENTER})`}
            className="text-accent"
          />
        </g>
      )}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS - STROKE - 3}
        fill="none"
        className="stroke-border"
        strokeWidth="0.75"
      />
    </svg>
  );
}

/**
 * Status-Ring eines Moduls. Der Zustand steht immer als Text daneben (nie nur Farbe);
 * „Nicht verfügbar“ ist neutral gestrichelt, „Prüft …“ ein rotierender Bogen (transform),
 * bei „Bewegung reduzieren“ steht er still.
 */
export function StatusRing({
  state,
  label,
  sublabel,
  stateLabel,
  icon,
  size = 88,
  layout = 'stacked',
  hideText = false,
  className,
}: StatusRingProps) {
  const resolvedStateLabel = stateLabel ?? moduleStateLabels[state];
  const StateIcon = stateIcons[state];
  const tone = toneText[state];
  const ring = (
    <div
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
      {...(hideText
        ? { role: 'img', 'aria-label': `${label}: ${resolvedStateLabel}` }
        : { 'aria-hidden': true })}
    >
      <Ring state={state} />
      <span
        className={cx(
          'relative grid place-items-center [&_svg]:size-[34%]',
          icon === undefined ? tone : 'text-text-muted',
        )}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {icon ?? <StateIcon />}
      </span>
    </div>
  );
  if (hideText) {
    return (
      <div className={cx('inline-flex', className)} data-state={state}>
        {ring}
      </div>
    );
  }
  return (
    <div
      className={cx(
        'flex',
        layout === 'stacked' ? 'flex-col items-center gap-3 text-center' : 'items-center gap-4',
        className,
      )}
      data-state={state}
    >
      {ring}
      <div className="min-w-0">
        <p className="text-sm font-medium text-text">{label}</p>
        <p
          className={cx(
            'mt-0.5 flex items-center gap-1.5 text-xs font-medium',
            layout === 'stacked' && 'justify-center',
            tone,
          )}
        >
          <span aria-hidden="true" className="inline-flex [&_svg]:size-3">
            <StateIcon strokeWidth={2.5} />
          </span>
          {resolvedStateLabel}
        </p>
        {sublabel !== undefined && <p className="mt-0.5 text-xs text-text-subtle">{sublabel}</p>}
      </div>
    </div>
  );
}
