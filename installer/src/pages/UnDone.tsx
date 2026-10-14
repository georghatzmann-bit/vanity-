/**
 * Deinstallation fertig (C.9): „Signal verloren.“, Protokoll (Schritte, Daten, Einstellungen);
 * bei `revertOk === false` Hinweis als Alarm.
 */
import { api } from "../api";
import { UNINSTALL_STEPS } from "../flow/useSetupFlow";
import { useT } from "../i18n";
import { LogList } from "../components/LogList";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import { UNINSTALL_RAIL } from "./UnConfirm";
import type { PageViewProps } from "./Welcome";

export function UnDone({ flow }: PageViewProps) {
  const t = useT();
  const { unDone, keepData, lang } = flow;
  const revertFailed = unDone?.revertOk === false;
  const dataKept = unDone?.dataKept ?? keepData;
  const up = (s: string) => s.toLocaleUpperCase(lang);
  const n = UNINSTALL_STEPS.length;
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
      <Block y={232}>
        <LogList
          title={t("uninstall.log")}
          testId="undone-log"
          rows={[
            { label: t("uninstall.logRemoved"), value: up(t("uninstall.logRemovedValue", { n, total: n })) },
            { label: t("uninstall.logData"), value: up(t(dataKept ? "uninstall.logDataKept" : "uninstall.logDataDeleted")) },
            {
              label: t("uninstall.logSettings"),
              value: <span className={revertFailed ? "text-obs-warn" : undefined}>{up(t(revertFailed ? "uninstall.logSettingsPartial" : "uninstall.logSettingsYes"))}</span>,
            },
          ]}
        />
      </Block>
      {revertFailed && (
        <Block y={322}>
          <Notice tone="warn" role="alert" title={t("uninstall.revertFailed")} testId="revert-failed">
            <span className="block">
              {t("uninstall.revertFailedText")} {t(keepData ? "uninstall.revertFailedKept" : "uninstall.revertFailedForced")}
            </span>
            <ol className="m-0 mt-2 list-none p-0">
              {(["uninstall.revertFailedHow", "uninstall.revertFailedHow2"] as const).map((k, i) => (
                <li key={k} className="flex gap-2">
                  <span aria-hidden className="obs-value w-5 shrink-0 text-[11px] leading-5 text-obs-fg-3">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0">{t(k)}</span>
                </li>
              ))}
            </ol>
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
