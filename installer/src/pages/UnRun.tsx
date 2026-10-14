/** Deinstallation läuft (C.9): Schritte mit OK / ▶ / —, Prozentskala, Statuszeile. */
import { UNINSTALL_STEPS, uninstallIndexOf } from "../flow/useSetupFlow";
import { useT } from "../i18n";
import { fixed } from "../obs/format";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { LinearScale } from "../components/LinearScale";
import { Notice } from "../components/Notice";
import { PhaseList, type PhaseItem } from "../components/PhaseList";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import { pctShort } from "./Install";
import { UNINSTALL_RAIL } from "./UnConfirm";
import type { PageViewProps } from "./Welcome";

export function UnRun({ flow }: PageViewProps) {
  const t = useT();
  const reduced = useReducedMotion();
  const { unProgress, keepData, error, lang } = flow;
  const cur = uninstallIndexOf(unProgress);
  const pct = unProgress?.percent ?? 0;
  const up = (s: string) => s.toLocaleUpperCase(lang);
  const items: PhaseItem[] = UNINSTALL_STEPS.map((s, i) => {
    const base = { id: s, index: i + 1, label: t(`uninstall.steps.${s}`) };
    if (s === "data" && keepData) return { ...base, state: "kept", status: up(t("uninstall.kept")) };
    if (i < cur) return { ...base, state: "done", status: up(t("install.ok")) };
    if (i === cur) return { ...base, state: "active", status: up(t("install.running")) };
    return { ...base, state: "todo" };
  });
  const idx = Math.max(0, Math.min(UNINSTALL_STEPS.length - 1, cur));
  const statusLine = t("uninstall.stepStatus", { n: idx + 1, total: UNINSTALL_STEPS.length, step: t(`uninstall.steps.${UNINSTALL_STEPS[idx]}`) });
  return (
    <Page testId="page-un-run">
      <Block y={56}>
        <StepScale steps={UNINSTALL_RAIL.map((k) => t(k))} current={1} />
      </Block>
      <Block y={124}>
        <Title small>{t("uninstall.running")}</Title>
      </Block>
      <Block y={168}>
        <div className="obs-label">{t("uninstall.stepsLabel")}</div>
      </Block>
      <Block y={184}>
        <PhaseList items={items} />
      </Block>
      <Block y={322}>
        <div
          role="progressbar"
          aria-label={t("uninstall.running")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          aria-valuetext={t("a11y.uninstallProgress", { step: t(`uninstall.steps.${UNINSTALL_STEPS[idx]}`), percent: fixed(pct, 0, lang) })}
        >
          <div className="obs-label mb-1 flex justify-end text-obs-fg-2" data-testid="un-percent" data-value={pct}>
            {pctShort(pct, lang)}
          </div>
          <LinearScale value={pct} reduced={reduced} />
        </div>
      </Block>
      {error && (
        <Block y={400}>
          <Notice tone="error" role="alert" title={t("errors.unknown")}>
            <span className="obs-value line-clamp-3 block text-[12px] leading-[18px] break-words whitespace-normal">{error.message}</span>
          </Notice>
        </Block>
      )}
      <Footer left={<span className="obs-label truncate text-obs-fg-2">{statusLine}</span>} />
    </Page>
  );
}
