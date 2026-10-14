import { Stethoscope } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Netzwerk › „Warum laggt es?“: geführte Prüfung (Gerüst – Umsetzung: F6). */
export function DiagnosePanel() {
  const t = useT();
  return <Placeholder title={t("diagnose.title")} icon={<Stethoscope className="h-4 w-4" />} />;
}
