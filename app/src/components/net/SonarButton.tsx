import { Headphones } from "lucide-react";
import { useT } from "@/lib/i18n";

/**
 * Steckplatz im Cockpit (Live-Ping-Karte): Knopf „Hör dein Netz“. Gerüst: noch ohne Funktion,
 * ehrlich als „kommt gleich“ gekennzeichnet (Umsetzung: F4).
 */
export function SonarButton() {
  const t = useT();
  const label = `${t("sonar.title")} – ${t("common.soon")}`;
  return (
    <button type="button" disabled title={label} aria-label={label} className="grid h-8 w-8 shrink-0 cursor-not-allowed place-items-center rounded-lg border border-line text-faint opacity-60">
      <Headphones className="h-4 w-4" />
    </button>
  );
}
