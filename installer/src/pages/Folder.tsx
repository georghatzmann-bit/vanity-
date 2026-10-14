/** Speicherort (C.4) */
import { useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { RAIL } from "../flow/useSetupFlow";
import { useT } from "../i18n";
import { DiskScale } from "../components/DiskScale";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { PathField } from "../components/PathField";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import type { PageViewProps } from "./Welcome";

export function Folder({ flow }: PageViewProps) {
  const t = useT();
  const { opts, setOpts, disk, info, requiredOk, checking } = flow;
  const bad = !checking && disk !== null && (!disk.valid || disk.free < disk.required);
  // Hinweis bleibt im DOM (aria-live polite): Beim Tippen wird er nicht entfernt und neu eingefügt
  // (sonst sagte jede Tipp-Pause ihn erneut assertiv an). Während der Prüfung bleibt der letzte Text stehen.
  const current: { tone: "error" | "warn"; text: string } | null =
    !checking && disk && (bad || disk.needsAdmin) ? (bad ? { tone: "error", text: !disk.valid ? (disk.message ?? t("folder.invalid")) : t("folder.lowSpace") } : { tone: "warn", text: t("folder.needsAdmin") }) : null;
  const shownRef = useRef(current);
  if (!checking) shownRef.current = current;
  const shown = shownRef.current;
  return (
    <Page testId="page-folder">
      <Block y={56}>
        <StepScale steps={RAIL.map((s) => t(`steps.${s}`))} current={1} />
      </Block>
      <Block y={136}>
        <Title>{t("folder.title")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body">{t("folder.text")}</p>
      </Block>
      <Block y={224}>
        <PathField label={t("folder.label")} value={opts.dir} onChange={(v) => setOpts({ ...opts, dir: v })} invalid={bad} describedBy={shown ? "folder-notice" : undefined} />
      </Block>
      <Block y={292} className="flex justify-end gap-2">
        {info && opts.dir !== info.defaultDir && (
          <ObsButton variant="ghost" size="sm" onClick={flow.resetFolder}>
            {t("folder.reset")}
          </ObsButton>
        )}
        <ObsButton variant="secondary" size="sm" onClick={() => void flow.browseFolder()}>
          {t("folder.browse")}
        </ObsButton>
      </Block>
      <Block y={352}>
        <DiskScale disk={disk} />
      </Block>
      <Block y={448}>
        <div id="folder-notice" aria-live="polite" aria-atomic="true" data-testid="folder-notice">
          {shown && (
            <Notice tone={shown.tone} compact>
              {shown.text}
            </Notice>
          )}
        </div>
      </Block>
      <Footer
        left={
          <ObsButton variant="ghost" className="-ml-2" icon={<ArrowLeft aria-hidden />} onClick={() => flow.go("welcome", -1)}>
            {t("common.back")}
          </ObsButton>
        }
        right={
          <ObsButton variant="primary" disabled={!requiredOk || !opts.dir.trim()} iconRight={<ArrowRight aria-hidden />} onClick={() => flow.go("options")}>
            {t("common.next")}
          </ObsButton>
        }
      />
    </Page>
  );
}
