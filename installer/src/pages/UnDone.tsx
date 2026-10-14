/** Deinstallation fertig (C.9): „Signal verloren.“; bei `revertOk === false` Hinweis als Alarm. */
import { api } from "../api";
import { useT } from "../i18n";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import { UNINSTALL_RAIL } from "./UnConfirm";
import type { PageViewProps } from "./Welcome";

export function UnDone({ flow }: PageViewProps) {
  const t = useT();
  const { unDone, keepData } = flow;
  const revertFailed = unDone?.revertOk === false;
  return (
    <Page testId="page-un-done">
      <Block y={56}>
        <StepScale steps={UNINSTALL_RAIL.map((k) => t(k))} current={2} />
      </Block>
      <Block y={136}>
        <Title autoFocus={!revertFailed}>{t("uninstall.doneTitle")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body">{t("uninstall.doneText")}</p>
      </Block>
      {revertFailed && (
        <Block y={228}>
          <Notice tone="warn" role="alert" title={t("uninstall.revertFailed")} testId="revert-failed">
            <span className="block">{t(keepData ? "uninstall.revertFailedKept" : "uninstall.revertFailedForced")}</span>
            <span className="mt-1 block">{t("uninstall.revertFailedHow")}</span>
          </Notice>
        </Block>
      )}
      <Footer
        right={
          <ObsButton variant="primary" autoFocus={revertFailed} onClick={() => void api.quit()}>
            {t("common.close")}
          </ObsButton>
        }
      />
    </Page>
  );
}
