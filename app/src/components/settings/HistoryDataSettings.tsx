import { Database } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Einstellungen › Daten: „Messverlauf löschen“ (Gerüst – Umsetzung: F7). */
export function HistoryDataSettings() {
  const t = useT();
  return <Placeholder compact title={t("history.title")} icon={<Database className="h-4 w-4" />} />;
}
