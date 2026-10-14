/** Wartung (C.8): Kopfzeile statt Schrittskala, zwei Knopfzeilen à 72 px (y 248–392). */
import { useId } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";
import { useT } from "../i18n";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import type { PageViewProps } from "./Welcome";

function RowButton({ index, title, desc, tone, onClick }: { index: string; title: string; desc: string; tone?: "error"; onClick(): void }) {
  const id = useId();
  return (
    <button
      type="button"
      className="obs-rowbtn"
      data-tone={tone}
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-d`}
      onMouseEnter={() => sound.play("hover")}
      onClick={() => {
        sound.play("click");
        onClick();
      }}
    >
      <span aria-hidden className={cn("obs-value w-7 shrink-0 pl-0 text-[11px] leading-4", tone === "error" ? "text-obs-error" : "text-obs-fg-3")}>
        {index}
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-t`} className="block text-[14px] leading-5 font-semibold text-obs-fg">
          {title}
        </span>
        <span id={`${id}-d`} className="block text-[13px] leading-[18px] text-obs-fg-2">
          {desc}
        </span>
      </span>
      <ArrowRight aria-hidden className="h-4 w-4 shrink-0 text-obs-fg-2" strokeWidth={1.5} />
    </button>
  );
}

/** VERSAL, aber Versionsnummern bleiben „v0.9.0“ */
const versal = (s: string, lang: string) => s.toLocaleUpperCase(lang).replace(/\bV(?=\d)/g, "v");

export function Maintenance({ flow }: PageViewProps) {
  const t = useT();
  const { info, opts, lang } = flow;
  const installed = info?.installed;
  return (
    <Page testId="page-maintenance">
      <Block y={56}>
        <StepScale label={<span className="normal-case">{versal(`${t("obs.modeMaintenance")} · ${t("maintenance.eyebrow", { v: installed?.version ?? "—" })}`, lang)}</span>} />
      </Block>
      <Block y={136}>
        <Title>{t("maintenance.title")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body break-words">{t("maintenance.text", { v: installed?.version ?? "—", dir: installed?.dir ?? "—" })}</p>
      </Block>
      <Block y={248}>
        <div className="border-t border-obs-rule">
          <RowButton index="A" title={t("maintenance.update")} desc={t("maintenance.updateDesc")} onClick={() => installed && void flow.startInstall({ ...opts, dir: installed.dir })} />
          <RowButton index="B" tone="error" title={t("maintenance.uninstall")} desc={t("maintenance.uninstallDesc")} onClick={() => flow.go("un-confirm")} />
        </div>
      </Block>
      <Footer />
    </Page>
  );
}
