import type { ReactNode } from "react";
import { Hourglass } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@shared/lib/cn";

/**
 * Ehrlicher Platzhalter für eine Funktion, die gerade eingebaut wird (Gerüst Teil 2): Titel plus
 * „Kommt gleich“. Wird von der jeweiligen Funktion durch die echte Ansicht ersetzt.
 */
export function Placeholder({ title, icon, className, compact }: { title: string; icon?: ReactNode; className?: string; compact?: boolean }) {
  const t = useT();
  return (
    // compact = als Zeile in einem Einstellungs-Abschnitt (ohne eigene Karte)
    <div className={cn("flex items-center gap-3 text-sm", compact ? "py-4" : "glass rounded-xl px-5 py-4", className)} data-placeholder="soon">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-muted">{icon ?? <Hourglass className="h-4 w-4" />}</span>
      <div className="min-w-0">
        <div className="font-semibold text-fg">{title}</div>
        <div className="text-xs text-muted">{t("common.soon")}</div>
      </div>
    </div>
  );
}
