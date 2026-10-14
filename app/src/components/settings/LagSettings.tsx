import { Siren } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Einstellungen › Messung: „Momentaufnahmen bei Ausreißern“ (Gerüst – Umsetzung: F1). */
export function LagSettings() {
  const t = useT();
  return <Placeholder compact title={t("lag.title")} icon={<Siren className="h-4 w-4" />} />;
}
