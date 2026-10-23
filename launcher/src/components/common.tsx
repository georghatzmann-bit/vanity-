import { useEffect, useState, type ReactNode } from "react";
import { motion, type Variants } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { keyLabel } from "@/lib/keys";
import type { ServiceStatus } from "@/lib/store";

const ease = [0.2, 0, 0, 1] as const;

const pageVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};

export const revealVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease } },
};

/** Rahmen für jede Seite: Innenabstand, maximale Breite, gestaffeltes Einblenden. */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      variants={pageVariants}
      initial="hidden"
      animate="show"
      className={cn("mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-8", className)}
    >
      {children}
    </motion.div>
  );
}

/** Blendet ein Element innerhalb einer PageShell nacheinander ein. */
export function Reveal({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={revealVariants} className={className}>
      {children}
    </motion.div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <Reveal className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </Reveal>
  );
}

/** Glas-Fläche mit optionaler Überschrift. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Reveal className={cn("glass rounded-xl", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("px-6 pt-4 pb-5", !(title || actions) && "pt-5", bodyClassName)}>
        {children}
      </div>
    </Reveal>
  );
}

/** Eine Option: Name, eine Zeile Erklärung in Grau, rechts das Bedienelement. */
export function SettingRow({
  label,
  hint,
  children,
  disabled,
  htmlFor,
}: {
  label: string;
  hint: string;
  children: ReactNode;
  disabled?: boolean;
  htmlFor?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0",
        disabled && "opacity-50",
      )}
    >
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

const statusStyle: Record<ServiceStatus, { dot: string; text: string; label: string }> = {
  stopped: { dot: "bg-muted-foreground/60", text: "text-muted-foreground", label: "Gestoppt" },
  starting: { dot: "bg-warning", text: "text-warning", label: "Startet …" },
  running: { dot: "bg-success", text: "text-success", label: "Läuft" },
  error: { dot: "bg-destructive", text: "text-destructive", label: "Fehler" },
};

export function statusLabel(status: ServiceStatus): string {
  return statusStyle[status].label;
}

/** Status immer mit Text, nie nur Farbe. */
export function StatusPill({ status, label }: { status: ServiceStatus; label?: string }) {
  const s = statusStyle[status];
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs font-medium", s.text)}>
      <span className="relative flex size-2">
        {(status === "starting" || status === "running") && (
          <span
            className={cn(
              "absolute inline-flex size-full rounded-full opacity-60",
              s.dot,
              status === "starting" ? "animate-ping" : "animate-pulse",
            )}
          />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", s.dot)} />
      </span>
      {label ?? s.label}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg bg-white/[0.02] px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg bg-white/[0.05] text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{hint}</p>
      </div>
      {action}
    </div>
  );
}

/** Kleiner Hinweis „Vorschau – ab Phase N“. */
export function PhaseNote({ phase, children }: { phase: number; children: ReactNode }) {
  return (
    <Reveal className="flex items-center gap-3 rounded-lg bg-primary/10 px-4 py-3 text-xs text-primary-text">
      <span className="rounded-md bg-primary/20 px-2 py-0.5 font-medium">Ab Phase {phase}</span>
      <span className="text-muted-foreground">{children}</span>
    </Reveal>
  );
}

/** Zeigt den aktuellen Wert eines Reglers. */
export function ValueChip({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-14 rounded-md bg-white/[0.05] px-2 py-1 text-center font-mono text-xs tabular-nums">
      {children}
    </span>
  );
}

/** Knopf, der auf die nächste Taste wartet und sie dann anzeigt. */
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
          : "bg-white/[0.06] hover:bg-white/[0.1]",
      )}
    >
      {listening ? "Taste drücken …" : value}
    </button>
  );
}

/** Kleines Symbol in einer getönten Kachel. */
export function IconTile({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary-text",
        className,
      )}
    >
      <Icon className="size-[18px]" />
    </div>
  );
}
