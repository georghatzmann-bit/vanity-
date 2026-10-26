import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { GlowCard } from "@/components/fx/glow-card";
import { Reveal } from "@/components/fx/reveal";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { keyLabel } from "@/lib/keys";
import { staggerVariants } from "@/lib/motion";
import type { ServiceStatus } from "@/lib/store";
import { cn } from "@/lib/utils";

export { Reveal } from "@/components/fx/reveal";
export { revealVariants } from "@/lib/motion";

/** Frame for every page: padding, max width, children appear one after another. */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      variants={staggerVariants(0.05, 0.04)}
      initial="hidden"
      animate="show"
      className={cn("mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 pt-7 pb-10", className)}
    >
      {children}
    </motion.div>
  );
}

/** Small uppercase label above a title or a group ("QUICK ACTIONS"). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-semibold tracking-[0.14em] text-violet-text/80 uppercase", className)}>{children}</p>
  );
}

/** Page title (24 px), one line of description, actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  icon: Icon,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  /** Small label above the title, e.g. the group in the sidebar ("Play", "Help"). */
  eyebrow?: string;
  icon?: LucideIcon;
}) {
  return (
    <Reveal className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-center gap-4">
        {Icon && <IconTile icon={Icon} size="lg" />}
        <div className="min-w-0">
          {eyebrow && <Eyebrow className="mb-1.5">{eyebrow}</Eyebrow>}
          <h1 className="text-2xl leading-tight font-semibold">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </Reveal>
  );
}

/** Glass card with an optional header (title, one-line description, actions). */
export function Panel({
  title,
  description,
  actions,
  icon: Icon,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHeader = Boolean(title || actions);
  return (
    <GlowCard className={className}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="flex min-w-0 items-start gap-3">
            {Icon && <IconTile icon={Icon} size="sm" className="mt-0.5" />}
            <div className="min-w-0">
              {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
              {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("px-6 pt-4 pb-5", !hasHeader && "pt-5", bodyClassName)}>{children}</div>
    </GlowCard>
  );
}

/** One option: name, one grey line of explanation, the control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  disabled,
  htmlFor,
  badge,
}: {
  label: string;
  hint: ReactNode;
  children: ReactNode;
  disabled?: boolean;
  htmlFor?: string;
  /** Small chip after the label, e.g. <Badge variant="warning">Experimental</Badge>. */
  badge?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0",
        disabled && "opacity-50",
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={htmlFor} className="text-sm font-medium">
            {label}
          </label>
          {badge}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

const statusStyle: Record<ServiceStatus, { dot: string; text: string; label: string }> = {
  stopped: { dot: "bg-muted-foreground/60", text: "text-muted-foreground", label: "Stopped" },
  starting: { dot: "bg-warning", text: "text-warning", label: "Starting…" },
  running: { dot: "bg-success", text: "text-success", label: "Running" },
  error: { dot: "bg-destructive", text: "text-destructive", label: "Error" },
};

export function statusLabel(status: ServiceStatus): string {
  return statusStyle[status].label;
}

/** Status always with text, never colour alone. */
export function StatusPill({ status, label }: { status: ServiceStatus; label?: string }) {
  const s = statusStyle[status];
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs font-medium", s.text)}>
      <span className="relative flex size-2">
        {(status === "starting" || status === "running") && (
          <span
            className={cn(
              "nb-loop absolute inline-flex size-full rounded-full opacity-60",
              s.dot,
              status === "starting" ? "animate-ping" : "animate-pulse",
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            s.dot,
            status === "running" && "shadow-[0_0_8px_rgb(34_197_94/0.7)]",
            status === "error" && "shadow-[0_0_8px_rgb(239_68_68/0.7)]",
          )}
        />
      </span>
      {label ?? s.label}
    </span>
  );
}

/** "Nothing here yet" with a hint what to do, instead of an empty area. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: ReactNode;
  className?: string;
}) {
  const calm = useCalmMotion();
  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-4 overflow-hidden rounded-xl border border-dashed border-white/[0.08] bg-white/[0.015] px-6 py-12 text-center",
        className,
      )}
    >
      <div className="relative">
        <div className="absolute -inset-4 rounded-full bg-[radial-gradient(closest-side,rgb(122_60_255/0.25),transparent)]" />
        {/* CSS loop (.nb-loop), not Motion: it pauses with the window and while you play */}
        <div
          className={cn(
            "relative flex size-12 items-center justify-center rounded-xl bg-gradient-to-b from-white/[0.09] to-white/[0.03] text-violet-text shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_0_0_1px_rgb(255_255_255/0.06)]",
            !calm && "nb-loop [animation:nb-float_4s_ease-in-out_infinite]",
          )}
        >
          <Icon className="size-5" />
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      {action}
    </div>
  );
}

/** Small "Preview – from phase N" note (kept for older pages). */
export function PhaseNote({ phase, children }: { phase: number; children: ReactNode }) {
  return (
    <Reveal className="flex items-center gap-3 rounded-lg bg-primary/10 px-4 py-3 text-xs text-primary-text">
      <span className="rounded-md bg-primary/20 px-2 py-0.5 font-medium">From phase {phase}</span>
      <span className="text-muted-foreground">{children}</span>
    </Reveal>
  );
}

/** Shows the current value of a slider. */
export function ValueChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "min-w-14 rounded-md bg-white/[0.05] px-2 py-1 text-center font-mono text-xs tabular-nums ring-1 ring-white/[0.06]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Keycap, e.g. <Kbd>F9</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("kbd", className)}>{children}</kbd>;
}

/** Button that waits for the next key press and then shows it. */
export function KeyCaptureButton({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== "Escape") onChange(keyLabel(e));
      setListening(false);
    };
    window.addEventListener("keydown", onKey, { capture: true, once: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, onChange]);

  return (
    <button
      type="button"
      onClick={() => setListening(true)}
      className={cn(
        "h-9 min-w-24 rounded-md px-3 font-mono text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        listening
          ? "bg-primary/20 text-primary-text ring-1 ring-primary/60"
          : "bg-white/[0.06] ring-1 ring-white/[0.08] hover:bg-white/[0.1]",
      )}
    >
      {listening ? "Press a key…" : value}
    </button>
  );
}

export type IconTone = "brand" | "success" | "warning" | "danger" | "muted" | "gold";

const toneStyle: Record<IconTone, string> = {
  brand: "from-brand-blue/25 to-brand-violet/25 text-violet-text ring-brand-violet/25",
  success: "from-success/20 to-success/10 text-success ring-success/25",
  warning: "from-warning/20 to-warning/10 text-warning ring-warning/25",
  danger: "from-destructive/20 to-destructive/10 text-destructive ring-destructive/25",
  muted: "from-white/[0.08] to-white/[0.03] text-muted-foreground ring-white/[0.08]",
  gold: "from-gold/25 to-gold/5 text-gold ring-gold/25",
};

const tileSize = {
  sm: "size-8 rounded-lg [&_svg]:size-4",
  md: "size-9 rounded-lg [&_svg]:size-[18px]",
  lg: "size-11 rounded-xl [&_svg]:size-5",
};

/** Small icon in a tinted tile. tone: brand (default), success, warning, danger, muted, gold. */
export function IconTile({
  icon: Icon,
  className,
  tone = "brand",
  size = "md",
}: {
  icon: LucideIcon;
  className?: string;
  tone?: IconTone;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center bg-gradient-to-br shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 transition-colors duration-200",
        toneStyle[tone],
        tileSize[size],
        className,
      )}
    >
      <Icon />
    </div>
  );
}
