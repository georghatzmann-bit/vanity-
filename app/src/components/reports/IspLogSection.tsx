import { ScrollText } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Berichte › Anbieter-Protokoll (Gerüst – Umsetzung: F7). */
export function IspLogSection() {
  const t = useT();
  return <Placeholder title={t("ispLog.title")} icon={<ScrollText className="h-4 w-4" />} />;
}
