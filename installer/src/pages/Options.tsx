/** Optionen (C.5): vier Optionszeilen y 224–480 mit Haarlinien bei 224, 288, 352, 416, 480. */
import { ArrowLeft, Download } from "lucide-react";
import type { InstallOptions } from "../api";
import { RAIL } from "../flow/useSetupFlow";
import { useT } from "../i18n";
import { ObsButton } from "../components/ObsButton";
import { OptionRow } from "../components/OptionRow";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import type { PageViewProps } from "./Welcome";

type BoolKey = Exclude<keyof InstallOptions, "dir">;

export function Options({ flow }: PageViewProps) {
  const t = useT();
  const { opts, setOpts } = flow;
  const rows: { key: BoolKey; title: string; desc: string }[] = [
    { key: "desktopShortcut", title: t("options.desktop"), desc: t("options.desktopDesc") },
    { key: "startMenu", title: t("options.startMenu"), desc: t("options.startMenuDesc") },
    { key: "autostart", title: t("options.autostart"), desc: t("options.autostartDesc") },
    { key: "launchAfter", title: t("options.launch"), desc: t("options.launchDesc") },
  ];
  return (
    <Page testId="page-options">
      <Block y={56}>
        <StepScale steps={RAIL.map((s) => t(`steps.${s}`))} current={2} />
      </Block>
      <Block y={136}>
        <Title>{t("options.title")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body">{t("options.text")}</p>
      </Block>
      <Block y={224}>
        <div className="border-t border-obs-rule">
          {rows.map((r, i) => (
            <OptionRow key={r.key} index={i + 1} title={r.title} desc={r.desc} checked={opts[r.key]} onChange={(v) => setOpts({ ...opts, [r.key]: v })} />
          ))}
        </div>
      </Block>
      <Footer
        left={
          <ObsButton variant="ghost" className="-ml-2" icon={<ArrowLeft aria-hidden />} onClick={() => flow.go("folder", -1)}>
            {t("common.back")}
          </ObsButton>
        }
        right={
          <ObsButton variant="primary" icon={<Download aria-hidden />} onClick={() => void flow.startInstall(opts)}>
            {t("options.install")}
          </ObsButton>
        }
      />
    </Page>
  );
}
