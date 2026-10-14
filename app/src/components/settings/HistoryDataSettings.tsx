/**
 * Einstellungen › Daten & Sicherung: „Messverlauf dauerhaft speichern“ (was lokal gespeichert wird) und
 * gleich daneben „Messverlauf löschen“ (`net_history_clear("all")`) mit Rückfrage. Die Berichte
 * bleiben; ältere Datenbank-Sicherungen enthalten den Verlauf noch, bis sie ersetzt werden.
 */
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { backendText } from "@/lib/netauto";
import { defaultHistory } from "@/lib/settings/history";
import { useSettings } from "@/store/settings";
import { confirmDialog, toast } from "@/store/ui";
import { Field } from "@/components/ui/Field";
import { Button } from "@shared/ui/Button";
import { Toggle } from "@shared/ui/Toggle";

export function HistoryDataSettings() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const record = useSettings((s) => s.settings.history?.record ?? defaultHistory().record);
  const update = useSettings((s) => s.update);
  const clear = async () => {
    const ok = await confirmDialog({ title: t("history.clearConfirmTitle"), text: t("history.clearConfirm"), danger: true, confirmLabel: t("history.clearButton") });
    if (!ok) return;
    setBusy(true);
    try {
      const n = await api.historyClear("all");
      toast({ kind: "success", title: t("history.cleared"), text: t("history.clearedCount", { n }) });
    } catch (e) {
      toast({ kind: "error", title: t("history.clearFailed"), text: backendText(errorText(e), t) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Field
        label={t("history.record")}
        description={
          <>
            {t("history.recordDesc")}
            <span className="mt-1 block text-[12px] text-faint">{t("history.stored")}</span>
          </>
        }
      >
        <Toggle checked={record} onChange={(v) => update({ history: { ...(useSettings.getState().settings.history ?? defaultHistory()), record: v } })} />
      </Field>
      <Field label={t("history.clear")} description={t("history.clearDesc")}>
        <Button variant="secondary" loading={busy} icon={<Trash2 className="h-4 w-4" />} onClick={() => void clear()} data-testid="history-clear">
          {t("history.clearButton")}
        </Button>
      </Field>
    </>
  );
}
