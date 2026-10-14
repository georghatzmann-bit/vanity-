import { Headphones } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Einstellungen › Ton › „Hör dein Netz“ (Gerüst – Umsetzung: F4). */
export function SonarSettings() {
  const t = useT();
  return <Placeholder compact title={t("sonar.title")} icon={<Headphones className="h-4 w-4" />} />;
}
