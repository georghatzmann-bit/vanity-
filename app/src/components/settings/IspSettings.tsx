import { ScrollText } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Einstellungen › Messung: Schwelle „langsam“, Vertragswerte, Messverlauf (Gerüst – Umsetzung: F7). */
export function IspSettings() {
  const t = useT();
  return <Placeholder compact title={t("ispLog.title")} icon={<ScrollText className="h-4 w-4" />} />;
}
