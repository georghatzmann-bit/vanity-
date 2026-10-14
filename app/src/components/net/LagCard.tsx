import { Siren } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Steckplatz unter Netzwerk › Verbindung: Karte „Lag-Detektiv“ (Gerüst – Umsetzung: F1). */
export function LagCard() {
  const t = useT();
  return <Placeholder title={t("lag.title")} icon={<Siren className="h-4 w-4" />} />;
}
