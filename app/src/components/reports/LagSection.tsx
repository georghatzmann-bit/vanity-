import { Siren } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Berichte › Ausreißer: Ursachen der letzten 30 Tage (Gerüst – Umsetzung: F1). */
export function LagSection() {
  const t = useT();
  return <Placeholder title={t("lag.title")} icon={<Siren className="h-4 w-4" />} />;
}
