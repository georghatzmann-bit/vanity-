/**
 * Einstellungen › Monitor, Unterabschnitt „Für das Anbieter-Protokoll (optional)“: „Langsam ab … ms“ und
 * Maximal-Geschwindigkeit laut Vertrag (optional „normalerweise verfügbar“/„minimal“) im üblichen
 * Zeilen-Layout. „Messverlauf dauerhaft speichern“ steht unter Daten & Sicherung (`HistoryDataSettings`).
 * Vertrag: docs/API.md, „Anbieter-Protokoll“ (Einstellungen).
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { defaultIspLog, mergeIspLog } from "@/lib/settings/isplog";
import type { IspLogSettings } from "@/lib/types";
import { useSettings } from "@/store/settings";
import { Field } from "@/components/ui/Field";

type ContractKey = "contractDownMbps" | "contractUpMbps" | "contractDownNormalMbps" | "contractDownMinMbps";

export function IspSettings() {
  const t = useT();
  const isp = useSettings((s) => s.settings.ispLog) ?? defaultIspLog();
  const update = useSettings((s) => s.update);
  const set = (patch: Partial<IspLogSettings>) => {
    const current = useSettings.getState().settings.ispLog ?? defaultIspLog();
    update({ ispLog: mergeIspLog({ ...current, ...patch }) });
  };
  // übliches Field-Layout: Titel links, Feld rechts
  const contractField = (key: ContractKey, label: string, description?: string) => (
    <Field label={label} description={description}>
      <div className="flex items-center gap-2 text-[13px] text-muted">
        <NumberInput value={isp[key]} min={1} max={10_000} allowEmpty placeholder={t("ispLog.settings.placeholder")} onCommit={(v) => set({ [key]: v })} testId={`isp-${key}`} />
        <span className="w-12">{t("ispLog.settings.mbps")}</span>
      </div>
    </Field>
  );

  return (
    <>
      <div className="pt-5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("ispLog.settings.forLog")}</div>
      <Field label={t("ispLog.settings.slowMs")} description={t("ispLog.settings.slowMsDesc")}>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <NumberInput value={isp.slowMs} min={30} max={1000} onCommit={(v) => set({ slowMs: v ?? defaultIspLog().slowMs })} testId="isp-slowMs" />
          <span className="w-12">ms</span>
        </div>
      </Field>
      {contractField("contractDownMbps", `${t("ispLog.settings.down")} – ${t("ispLog.settings.max")}`, t("ispLog.settings.contractDesc"))}
      {contractField("contractUpMbps", `${t("ispLog.settings.up")} – ${t("ispLog.settings.max")}`)}
      {contractField("contractDownNormalMbps", `${t("ispLog.settings.down")} – ${t("ispLog.settings.normal")}`, `${t("ispLog.settings.optional")} · ${t("ispLog.settings.optionalDesc")}`)}
      {contractField("contractDownMinMbps", `${t("ispLog.settings.down")} – ${t("ispLog.settings.min")}`)}
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
      className="input h-9 w-28 text-right tabular"
      data-testid={testId}
    />
  );
}
