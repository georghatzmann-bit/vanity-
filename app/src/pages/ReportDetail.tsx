import { ArrowLeft, ChartSpline } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUI } from "@/store/ui";
import { Placeholder } from "@/components/ui/Placeholder";
import { Button } from "@shared/ui/Button";

/**
 * Detail eines Berichts bzw. einer Sitzung: Match-Zeitleiste und Bildkarte. Aufruf über
 * `{ page: "reports", id: report.id }` oder `{ page: "reports", section: "session", id: <sessionId> }`.
 * Gerüst – Umsetzung: F2.
 */
export function ReportDetail({ id, section }: { id: string; section?: string }) {
  const t = useT();
  return (
    <div className="mx-auto max-w-[1400px] px-8 pt-3 pb-24" data-report-id={id} data-section={section ?? "report"}>
      <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => useUI.getState().navigate({ page: "reports" })}>
        {t("common.back")}
      </Button>
      <Placeholder className="mt-4" title={t("timeline.title")} icon={<ChartSpline className="h-4 w-4" />} />
    </div>
  );
}
