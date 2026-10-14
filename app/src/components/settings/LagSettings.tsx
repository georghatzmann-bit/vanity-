/** Einstellungen › Monitor: „Momentaufnahmen bei Ausreißern“ (`lag.snapshots`, Lag-Detektiv). */
import { useT } from "@/lib/i18n";
import { defaultLag } from "@/lib/settings/lag";
import { useSettings } from "@/store/settings";
import { Field } from "@/components/ui/Field";
import { Toggle } from "@shared/ui/Toggle";

export function LagSettings() {
  const t = useT();
  const snapshots = useSettings((s) => s.settings.lag?.snapshots ?? defaultLag().snapshots);
  const update = useSettings((s) => s.update);
  return (
    <Field label={t("lag.settings.snapshots")} description={t("lag.settings.snapshotsDesc")}>
      <Toggle checked={snapshots} onChange={(v) => update({ lag: { ...(useSettings.getState().settings.lag ?? defaultLag()), snapshots: v } })} />
    </Field>
  );
}
