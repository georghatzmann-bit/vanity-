/** Deinstallieren bestätigen (C.9) */
import { Trash2 } from "lucide-react";
import { api } from "../api";
import { useT } from "../i18n";
import { ObsButton } from "../components/ObsButton";
import { ObsCheckbox } from "../components/ObsCheckbox";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Rule, Title } from "./Page";
import type { PageViewProps } from "./Welcome";

export const UNINSTALL_RAIL = ["steps.unConfirm", "steps.unRun", "steps.unDone"] as const;

export function UnConfirm({ flow }: PageViewProps) {
  const t = useT();
  const { keepData, setKeepData, info } = flow;
  // Aus der Wartung gibt es einen Rückweg; sonst (Deinstallation aus Windows) beendet „Abbrechen“.
  const cancel = () => (info?.mode === "maintenance" ? flow.go("maintenance", -1) : void api.quit());
  return (
    <Page testId="page-un-confirm">
      <Block y={56}>
        <StepScale steps={UNINSTALL_RAIL.map((k) => t(k))} current={0} />
      </Block>
      <Block y={136}>
        <Title>{t("uninstall.title")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body">{t("uninstall.text")}</p>
      </Block>
      <Rule y={288} />
      <Block y={300}>
        <ObsCheckbox checked={keepData} onChange={setKeepData} label={t("uninstall.keepData")} description={t("uninstall.keepDataDesc")} />
      </Block>
      <Footer
        left={
          <ObsButton variant="ghost" className="-ml-2" onClick={cancel}>
            {t("uninstall.cancel")}
          </ObsButton>
        }
        right={
          <ObsButton variant="danger" icon={<Trash2 aria-hidden />} onClick={flow.startUninstall}>
            {t("uninstall.confirm")}
          </ObsButton>
        }
      />
    </Page>
  );
}
