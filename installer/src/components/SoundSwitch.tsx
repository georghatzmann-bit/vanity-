/**
 * Ton an/aus (C.0): `role="switch"`, Name aus dem Inhalt „Ton“; Icon und AN/AUS sind `aria-hidden`.
 */
import { Volume2, VolumeX } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { useT } from "../i18n";

export interface SoundSwitchProps {
  muted: boolean;
  onMute(m: boolean): void;
}

export function SoundSwitch({ muted, onMute }: SoundSwitchProps) {
  const t = useT();
  const Icon = muted ? VolumeX : Volume2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!muted}
      onClick={() => onMute(!muted)}
      className={cn("no-drag group flex h-10 items-center gap-2 px-3 transition-colors duration-[120ms]", muted ? "text-obs-fg-3" : "text-obs-fg-2", "hover:text-obs-fg")}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
      <span className="obs-label text-current">{t("common.sound")}</span>
      <span aria-hidden className={cn("obs-label w-[26px] text-left", muted ? "text-obs-fg-3" : "text-obs-fg")}>
        {muted ? t("obs.off") : t("obs.on")}
      </span>
    </button>
  );
}
