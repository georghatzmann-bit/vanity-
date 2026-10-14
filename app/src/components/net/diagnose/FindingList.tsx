/** „Warum laggt es?“: Befund-Bausteine (Schwere-Abzeichen, Schritte, Verweise) und die Liste weiterer Befunde. */
import { AlertOctagon, AlertTriangle, ArrowUpRight, Info } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { LINKS, findingNotes, findingText, fixTexts, type DiagnoseLink } from "@/lib/diagnose";
import { formatNumber } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Finding, Severity } from "@/lib/types";
import { toast, useUI } from "@/store/ui";
import { Button } from "@shared/ui/Button";
import { cn } from "@shared/lib/cn";

export const fmt = (n: number, digits = 1) => formatNumber(n, digits);

export const SEVERITY_TONE: Record<Severity, { text: string; bg: string; ring: string }> = {
  high: { text: "text-danger", bg: "bg-danger/15", ring: "var(--nv-danger)" },
  medium: { text: "text-warning", bg: "bg-warning/15", ring: "var(--nv-warning)" },
  info: { text: "text-accent", bg: "bg-accent/15", ring: "var(--nv-accent)" },
  // „kein Befund“ ist neutral – wer gerade laggt, soll daraus nicht „alles gut“ lesen
  ok: { text: "text-muted", bg: "bg-surface-3", ring: "var(--nv-border-strong)" },
};

export function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  const Icon = severity === "high" ? AlertOctagon : severity === "medium" ? AlertTriangle : Info;
  return <Icon className={cn(SEVERITY_TONE[severity].text, className)} aria-hidden />;
}

export function SeverityChip({ severity }: { severity: Severity }) {
  const t = useT();
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase", SEVERITY_TONE[severity].bg, SEVERITY_TONE[severity].text)}>{t(`diagnose.severity.${severity}`)}</span>;
}

async function follow(link: DiagnoseLink) {
  if (link.kind === "route") {
    useUI.getState().navigate({ page: link.page, section: link.section });
    return;
  }
  try {
    await api.openUrl(link.url);
  } catch (e) {
    toast({ kind: "error", title: errorText(e) });
  }
}

/** Verweise eines Befunds (WLAN-Tab, Anbieter-Protokoll, Windows-Einstellungen …) */
export function FindingLinks({ finding, className }: { finding: Finding; className?: string }) {
  const t = useT();
  const links = LINKS[finding.id] ?? [];
  if (!links.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {links.map((l) => (
        <Button key={l.label} variant="secondary" size="sm" iconRight={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => void follow(l)}>
          {t(`diagnose.link.${l.label}`)}
        </Button>
      ))}
    </div>
  );
}

/** Nummerierte konkrete Schritte */
export function FixSteps({ finding, compact }: { finding: Finding; compact?: boolean }) {
  const t = useT();
  return (
    <ol className={cn("space-y-1.5", compact ? "text-[12px]" : "text-[13px]")}>
      {fixTexts(finding, t, fmt).map((text, i) => (
        <li key={i} className="flex gap-2.5 text-fg-soft">
          <span className={cn("grid shrink-0 place-items-center rounded-full bg-surface-3 font-semibold text-muted tabular", compact ? "h-4.5 w-4.5 text-[10px]" : "h-5 w-5 text-[11px]")}>{i + 1}</span>
          <span className="min-w-0">{text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Zusatzsätze („Manche Server drosseln Ping-Antworten.“ …) */
export function FindingNotes({ finding }: { finding: Finding }) {
  const t = useT();
  const notes = findingNotes(finding);
  if (!notes.length) return null;
  return (
    <div className="mt-2 space-y-0.5 text-[11px] leading-relaxed text-faint">
      {notes.map((n) => (
        <p key={n}>{t(`diagnose.note.${n}`)}</p>
      ))}
    </div>
  );
}

/** Weitere Befunde und Hinweise unter der Einschätzung */
export function FindingList({ findings }: { findings: Finding[] }) {
  const t = useT();
  if (!findings.length) return null;
  return (
    <div className="glass rounded-xl p-5" data-testid="diagnose-findings">
      <div className="mb-3 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("diagnose.more")}</div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {findings.map((f) => (
          <div key={f.id} className="rounded-lg bg-surface px-4 py-3" data-finding={f.id}>
            <div className="flex items-start gap-2.5">
              <SeverityIcon severity={f.severity} className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityChip severity={f.severity} />
                </div>
                <p className="mt-1 text-[13px] font-medium text-fg">{findingText(f, t, fmt)}</p>
                <div className="mt-2">
                  <FixSteps finding={f} compact />
                </div>
                <FindingNotes finding={f} />
                <FindingLinks finding={f} className="mt-2.5" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
