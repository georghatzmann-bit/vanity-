/** „Warum laggt es?“: große Einschätzung (verdict) mit Werten, nummerierten Schritten und Verweisen. */
import { Stethoscope } from "lucide-react";
import { findingText } from "@/lib/diagnose";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { DiagnoseLast } from "@/lib/types";
import { FindingLinks, FindingNotes, FixSteps, SEVERITY_TONE, SeverityChip, SeverityIcon, fmt } from "./FindingList";
import { cn } from "@shared/lib/cn";

export function VerdictCard({ result, fromLast }: { result: DiagnoseLast; fromLast?: boolean }) {
  const t = useT();
  const verdict = result.findings.find((f) => f.id === result.verdict) ?? { id: result.verdict, severity: "ok" as const, values: {} };
  const tone = SEVERITY_TONE[verdict.severity];
  return (
    <div
      className="glass relative overflow-hidden rounded-xl p-5"
      style={{ boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone.ring} 40%, transparent)` }}
      data-testid="diagnose-verdict"
      data-verdict={verdict.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
          <Stethoscope className="h-4 w-4 text-accent" /> {t("diagnose.verdict")}
        </div>
        <span className="text-[11px] text-faint tabular" title={formatDateTime(result.at)}>
          {fromLast ? t("diagnose.lastCheck", { when: formatRelative(result.at) }) : formatDateTime(result.at)}
        </span>
      </div>
      <div className="mt-4 flex items-start gap-4">
        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", tone.bg)}>
          <SeverityIcon severity={verdict.severity} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <SeverityChip severity={verdict.severity} />
          <p className="mt-1.5 font-display text-[19px] leading-snug font-semibold text-fg">{findingText(verdict, t, fmt)}</p>
          {verdict.id === "allGood" && <p className="mt-1 text-[13px] text-muted">{t("diagnose.allGoodSub")}</p>}
          <FindingNotes finding={verdict} />
        </div>
      </div>
      <div className="mt-5">
        <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("diagnose.whatToDo")}</div>
        <FixSteps finding={verdict} />
        <FindingLinks finding={verdict} className="mt-4" />
      </div>
      {fromLast && <p className="mt-4 text-[11px] text-faint">{t("diagnose.lastHint")}</p>}
    </div>
  );
}
