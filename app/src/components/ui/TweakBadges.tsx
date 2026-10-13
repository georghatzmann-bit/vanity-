import { RotateCw, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@shared/lib/cn";

/** Abzeichen mit Symbol und Text: „Windows fragt nach“ (Adminrechte) und „Neustart nötig“ */
export function TweakBadges({ admin, restart, className }: { admin?: boolean; restart?: boolean; className?: string }) {
  const t = useT();
  if (!admin && !restart) return null;
  const cls = "inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-fg-soft";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {admin && (
        <span className={cls} title={t("optimize.badges.adminHint")}>
          <ShieldCheck className="h-3 w-3 text-accent" aria-hidden />
          {t("optimize.badges.admin")}
        </span>
      )}
      {restart && (
        <span className={cls} title={t("optimize.badges.restartHint")}>
          <RotateCw className="h-3 w-3 text-accent" aria-hidden />
          {t("optimize.badges.restart")}
        </span>
      )}
    </span>
  );
}
