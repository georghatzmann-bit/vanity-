/** Sprachwahl DE | EN in der Titelleiste (C.0): zwei Knöpfe 32 × 40 mit `aria-pressed`. */
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";
import { useT, type Lang } from "../i18n";

export interface LangSwitchProps {
  lang: Lang;
  onLang(l: Lang): void;
}

const LANGS: Lang[] = ["de", "en"];

export function LangSwitch({ lang, onLang }: LangSwitchProps) {
  const t = useT();
  return (
    <div role="group" aria-label={t("common.language")} className="no-drag flex h-10 items-center">
      {LANGS.map((l, i) => (
        <span key={l} className="flex h-10 items-center">
          {i > 0 && <span aria-hidden className="h-3 w-px bg-obs-rule-strong" />}
          <button
            type="button"
            aria-pressed={lang === l}
            lang={l}
            onMouseEnter={() => sound.play("hover")}
            onClick={() => {
              sound.play("click");
              onLang(l);
            }}
            className={cn(
              "obs-label grid h-10 w-8 place-items-center transition-colors duration-[120ms]",
              lang === l ? "text-obs-fg" : "text-obs-fg-3 hover:text-obs-fg-2",
            )}
          >
            {l}
          </button>
        </span>
      ))}
    </div>
  );
}
