/**
 * Einstellungen › Ton › „Hör dein Netz“: Lautstärke, Tonhöhe folgt dem Ping, Warnton im Spiel (Standard aus),
 * Warnton-Lautstärke (0,05–0,3) und Probe-Knöpfe (je 4 s Beispielwerte). Vertrag: docs/API.md, „Hör dein Netz“.
 */
import { useEffect } from "react";
import { Activity, AudioWaveform, BellRing, Headphones, Square, Unplug } from "lucide-react";
import { useT } from "@/lib/i18n";
import { SONAR_PREVIEWS, sonarSettings, type SonarPreviewKind } from "@/lib/sonar";
import { mergeSonar } from "@/lib/settings/sonar";
import type { SonarSettings as SonarSettingsValue } from "@/lib/types";
import { useSettings } from "@/store/settings";
import { useSonar } from "@/store/sonar";
import { Chip, Field } from "@/components/ui/Field";
import { Toggle } from "@shared/ui/Toggle";

const PREVIEW_ICONS: Record<SonarPreviewKind, typeof Activity> = {
  stable: Activity,
  unstable: AudioWaveform,
  loss: Unplug,
  alert: BellRing,
};

function Range({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex w-56 items-center gap-3">
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[var(--nv-accent)] flex-1" />
      <span className="w-14 text-right text-[13px] text-fg-soft tabular">{Math.round(value * 100)} %</span>
    </div>
  );
}

export function SonarSettings() {
  const t = useT();
  const stored = useSettings((s) => s.settings.sonar);
  const sonar = sonarSettings({ sonar: stored });
  const soundOn = useSettings((s) => s.settings.sound && s.settings.volume > 0);
  const update = useSettings((s) => s.update);
  const preview = useSonar((s) => s.preview);
  const set = (patch: Partial<SonarSettingsValue>) => update({ sonar: mergeSonar({ ...sonarSettings(useSettings.getState().settings), ...patch }) });
  // Probe beim Verlassen der Seite beenden
  useEffect(() => () => useSonar.getState().stopPreview(), []);

  return (
    <div data-testid="sonar-settings">
      <Field
        label={
          <span className="flex items-center gap-2">
            <Headphones className="h-4 w-4 text-accent" /> {t("sonar.title")}
          </span>
        }
        description={t("sonar.settings.desc")}
      />
      <Field label={t("sonar.settings.volume")} description={t("sonar.settings.volumeDesc")}>
        <Range label={t("sonar.settings.volume")} value={sonar.volume} min={0} max={1} step={0.05} onChange={(v) => set({ volume: v })} />
      </Field>
      <Field label={t("sonar.settings.pitch")} description={t("sonar.settings.pitchDesc")}>
        <Toggle checked={sonar.pitch} onChange={(v) => set({ pitch: v })} />
      </Field>
      <Field label={t("sonar.settings.alertInGame")} description={t("sonar.settings.alertInGameDesc")}>
        <Toggle checked={sonar.alertInGame} onChange={(v) => set({ alertInGame: v })} />
      </Field>
      <Field label={t("sonar.settings.alertVolume")}>
        <Range label={t("sonar.settings.alertVolume")} value={sonar.alertVolume} min={0.05} max={0.3} step={0.05} onChange={(v) => set({ alertVolume: v })} />
      </Field>
      <Field label={t("sonar.settings.preview")} description={t("sonar.settings.previewDesc")} stacked>
        <div className="flex flex-wrap items-center gap-2">
          {SONAR_PREVIEWS.map((kind) => {
            const Icon = PREVIEW_ICONS[kind];
            const active = preview === kind;
            return (
              <Chip key={kind} active={active} onClick={() => (active ? useSonar.getState().stopPreview() : useSonar.getState().playPreview(kind))}>
                {active ? <Square className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                <span data-testid={`sonar-preview-${kind}`}>{t(`sonar.settings.previewNames.${kind}`)}</span>
                {active && <span className="sr-only">{t("sonar.settings.previewStop")}</span>}
              </Chip>
            );
          })}
        </div>
        {!soundOn && <p className="mt-2 text-[12px] text-warning">{t("sonar.settings.mutedHint")}</p>}
        <p className="mt-2 text-[12px] leading-snug text-faint">{t("sonar.settings.honest")}</p>
      </Field>
    </div>
  );
}
