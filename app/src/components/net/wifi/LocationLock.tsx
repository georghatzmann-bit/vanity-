/** WLAN-Scanner: Erklärung der Standortsperre (Windows 11 24H2) mit Knopf zu den Windows-Einstellungen. */
import { MapPinOff, RefreshCw, Settings2 } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { toast } from "@/store/ui";
import { Button } from "@shared/ui/Button";

export const PRIVACY_LOCATION_URL = "ms-settings:privacy-location";

export function LocationLock({ onRetry, busy }: { onRetry: () => void; busy?: boolean }) {
  const t = useT();
  const open = async () => {
    try {
      await api.openUrl(PRIVACY_LOCATION_URL);
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  };
  return (
    <div className="glass rounded-xl p-5 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-warning)_45%,transparent)]">
      <div className="flex items-start gap-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning">
          <MapPinOff className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold text-fg">{t("wifiScan.locked.title")}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-soft">{t("wifiScan.locked.text")}</p>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-[13px] text-fg-soft marker:text-faint">
            <li>{t("wifiScan.locked.step1")}</li>
            <li>{t("wifiScan.locked.step2")}</li>
            <li>{t("wifiScan.locked.step3")}</li>
            <li>{t("wifiScan.locked.step4", { button: t("wifiScan.locked.retry") })}</li>
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" icon={<Settings2 className="h-4 w-4" />} onClick={() => void open()}>
              {t("wifiScan.locked.open")}
            </Button>
            <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} loading={busy} onClick={onRetry}>
              {t("wifiScan.locked.retry")}
            </Button>
          </div>
          <p className="mt-3 text-[12px] text-muted">{t("wifiScan.locked.firstTime")}</p>
        </div>
      </div>
    </div>
  );
}
