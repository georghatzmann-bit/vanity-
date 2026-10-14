import { Wifi } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Placeholder } from "@/components/ui/Placeholder";

/** Netzwerk › WLAN: WLAN-Scanner und Raum-Scan (Gerüst – Umsetzung: F5). */
export function WifiPanel() {
  const t = useT();
  return <Placeholder title={t("wifiScan.title")} icon={<Wifi className="h-4 w-4" />} />;
}
