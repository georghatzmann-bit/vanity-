/**
 * Optionszeile (B.7): ganze Breite, 64 px, Haarlinie unten. Die Zeile selbst ist `role="switch"`
 * (Leertaste/Enter schalten), innen gibt es kein zweites Bedienelement.
 */
import { useId } from "react";
import { sound } from "@shared/sound/engine";
import { useT } from "../i18n";

export interface OptionRowProps {
  index: number;
  title: string;
  desc: string;
  checked: boolean;
  onChange(v: boolean): void;
}

export function OptionRow({ index, title, desc, checked, onChange }: OptionRowProps) {
  const t = useT();
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      className="obs-option"
      onMouseEnter={() => sound.play("hover")}
      onClick={() => {
        sound.play(checked ? "toggleOff" : "toggleOn");
        onChange(!checked);
      }}
    >
      <span aria-hidden className="obs-value w-7 shrink-0 text-[11px] leading-4 text-obs-fg-3">
        {String(index).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-t`} className="block text-[14px] leading-5 font-semibold text-obs-fg">
          {title}
        </span>
        <span id={`${id}-d`} className="block text-[13px] leading-[18px] text-obs-fg-2">
          {desc}
        </span>
      </span>
      <span aria-hidden className="obs-label w-[26px] text-right">
        {checked ? t("obs.on") : t("obs.off")}
      </span>
      <span aria-hidden className="obs-switch" data-on={checked} />
    </button>
  );
}
