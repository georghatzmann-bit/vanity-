import type { ReactNode } from "react";
import { cn } from "@shared/lib/cn";

/** Einstellungszeile: Titel + graue Erklärung links, Bedienelement rechts */
export function Field({ label, description, children, className, stacked }: { label: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; stacked?: boolean }) {
  return (
    <div className={cn("flex gap-6 py-4", stacked ? "flex-col gap-3" : "items-center justify-between", className)}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg">{label}</div>
        {description && <div className="mt-0.5 text-[13px] leading-snug text-muted">{description}</div>}
      </div>
      {children && <div className={cn(stacked ? "w-full" : "shrink-0")}>{children}</div>}
    </div>
  );
}

export function Section({ title, icon, children, id, actions }: { title: string; icon?: ReactNode; children: ReactNode; id?: string; actions?: ReactNode }) {
  return (
    <section id={id} className="glass rounded-xl px-6 py-2">
      <div className="flex items-center justify-between border-b border-line py-4">
        <h2 className="flex items-center gap-2.5 text-base font-semibold text-fg">
          {icon && <span className="text-accent">{icon}</span>}
          {title}
        </h2>
        {actions}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

export function Chip({ active, children, onClick, className }: { active?: boolean; children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-all duration-200",
        active ? "border-transparent bg-accent/15 text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_55%,transparent)]" : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}
