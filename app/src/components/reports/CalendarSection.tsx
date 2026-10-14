import { CalendarDays } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Berichte › Kalender: Heatmap Wochentag × Stunde (Gerüst – Umsetzung: F3). */
export function CalendarSection() {
  const t = useT();
  return <Placeholder title={t("calendar.title")} icon={<CalendarDays className="h-4 w-4" />} />;
}
