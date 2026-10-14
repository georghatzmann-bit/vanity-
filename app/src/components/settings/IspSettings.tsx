/**
 * Einstellungen › Monitor: Anbieter-Protokoll und Messverlauf – „Langsam ab … ms“, Maximal-Geschwindigkeit
 * laut Vertrag (optional „normalerweise verfügbar“/„minimal“), „Messverlauf dauerhaft speichern“ und
 * was lokal gespeichert wird. Vertrag: docs/API.md, „Anbieter-Protokoll“ (Einstellungen).
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { defaultHistory } from "@/lib/settings/history";
import { defaultIspLog, mergeIspLog } from "@/lib/settings/isplog";
import type { IspLogSettings } from "@/lib/types";
import { useSettings } from "@/store/settings";
import { Field } from "@/components/ui/Field";
import { Toggle } from "@shared/ui/Toggle";

type ContractKey = "contractDownMbps" | "contractUpMbps" | "contractDownNormalMbps" | "contractDownMinMbps";

export function IspSettings() {
  const t = useT();
  const isp = useSettings((s) => s.settings.ispLog) ?? defaultIspLog();
  const record = useSettings((s) => s.settings.history?.record ?? defaultHistory().record);
  const update = useSettings((s) => s.update);
  const set = (patch: Partial<IspLogSettings>) => {
    const current = useSettings.getState().settings.ispLog ?? defaultIspLog();
    update({ ispLog: mergeIspLog({ ...current, ...patch }) });
  };
  const contractInput = (key: ContractKey, label: string) => (
    <label className="flex items-center gap-2 text-[13px] text-fg-soft">
      <span className="w-40 shrink-0 text-muted">{label}</span>
      <NumberInput value={isp[key]} min={1} max={10_000} allowEmpty placeholder={t("ispLog.settings.placeholder")} onCommit={(v) => set({ [key]: v })} testId={`isp-${key}`} />
      <span className="text-muted">{t("ispLog.settings.mbps")}</span>
    </label>
  );

  return (
    <>
      <Field label={t("ispLog.settings.slowMs")} description={t("ispLog.settings.slowMsDesc")}>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <NumberInput value={isp.slowMs} min={30} max={1000} onCommit={(v) => set({ slowMs: v ?? defaultIspLog().slowMs })} testId="isp-slowMs" />
          ms
        </div>
      </Field>
      <Field label={t("ispLog.settings.contract")} description={t("ispLog.settings.contractDesc")} stacked>
        <div className="flex flex-col gap-2">
          {contractInput("contractDownMbps", t("ispLog.settings.down"))}
          {contractInput("contractUpMbps", t("ispLog.settings.up"))}
          <div className="pt-1 text-[12px] text-muted">
            {t("ispLog.settings.optional")} · {t("ispLog.settings.optionalDesc")}
          </div>
          {contractInput("contractDownNormalMbps", `${t("ispLog.settings.down")} – ${t("ispLog.settings.normal")}`)}
          {contractInput("contractDownMinMbps", `${t("ispLog.settings.down")} – ${t("ispLog.settings.min")}`)}
        </div>
      </Field>
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
    </>
  );
}

/**
 * Zahlenfeld, das erst beim Verlassen bzw. mit Enter übernimmt (so springt der Wert beim Tippen nicht
 * auf die Grenzen). Leer = `null`, wenn erlaubt, sonst zurück auf den alten Wert.
 */
function NumberInput({ value, min, max, allowEmpty = false, placeholder, onCommit, testId }: { value: number | null; min: number; max: number; allowEmpty?: boolean; placeholder?: string; onCommit: (v: number | null) => void; testId?: string }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);
  const commit = () => {
    const raw = text.trim().replace(",", ".");
    if (!raw) {
      if (allowEmpty) onCommit(null);
      else setText(value === null ? "" : String(value));
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setText(value === null ? "" : String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    onCommit(clamped);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      className="input h-9 w-24 text-right tabular"
      data-testid={testId}
    />
  );
}
