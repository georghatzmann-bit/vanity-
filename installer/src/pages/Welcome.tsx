/** Willkommen (C.3) */
import { ArrowRight } from "lucide-react";
import type { SetupFlow } from "../flow/useSetupFlow";
import { RAIL } from "../flow/useSetupFlow";
import { useT } from "../i18n";
import type { ObsState } from "../obs/types";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { bytes } from "../components/Readout";
import { StepScale } from "../components/StepScale";
import { Block, DASH, Footer, Page, Title } from "./Page";

export interface PageViewProps {
  flow: SetupFlow;
  obs: ObsState;
}

export function Welcome({ flow }: PageViewProps) {
  const t = useT();
  const { manifest, manifestError } = flow;
  const size = manifest?.app.size;
  const features = [
    { a: t("welcome.f1"), b: t("welcome.f1d") },
    { a: t("welcome.f2"), b: t("welcome.f2d") },
    { a: t("welcome.f3"), b: t("welcome.f3d") },
  ];
  return (
    <Page testId="page-welcome">
      <Block y={56}>
        <StepScale steps={RAIL.map((s) => t(`steps.${s}`))} current={0} />
      </Block>
      <Block y={120}>
        <div className="obs-label">{t("welcome.eyebrow")}</div>
      </Block>
      <Block y={136}>
        <Title>{t("welcome.title")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body">{t("welcome.text")}</p>
      </Block>
      <Block y={300}>
        <ul className="m-0 list-none p-0">
          {features.map((f, i) => (
            <li key={i} className="flex h-[52px] items-center border-t border-obs-rule last:border-b">
              <span aria-hidden className="obs-value w-7 shrink-0 self-start pt-[9px] text-[11px] leading-4 text-obs-fg-3">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] leading-[18px] font-semibold text-obs-fg">{f.a}</span>
                <span className="block text-[12px] leading-[18px] text-obs-fg-2">{f.b}</span>
              </span>
            </li>
          ))}
        </ul>
      </Block>
      <Block y={manifestError ? 466 : 472}>
        {manifestError ? (
          <Notice tone="warn" role="status" compact>
            {t("welcome.manifestError")}
          </Notice>
        ) : (
          <div className="obs-label" data-testid="manifest-line">
            {manifest ? (
              <>
                {size ? t("welcome.size", { size: bytes(size) }) : t("welcome.size", { size: DASH })}
                {manifest.app.sha256 ? ` · ${t("welcome.sha")}` : ""}
              </>
            ) : (
              <>{t("welcome.size", { size: DASH })}</>
            )}
          </div>
        )}
      </Block>
      <Footer
        left={<p className="obs-fine m-0 max-w-[300px]">{t("welcome.license")}</p>}
        right={
          <ObsButton variant="primary" iconRight={<ArrowRight aria-hidden />} onClick={() => flow.go("folder")}>
            {t("welcome.start")}
          </ObsButton>
        }
      />
    </Page>
  );
}
