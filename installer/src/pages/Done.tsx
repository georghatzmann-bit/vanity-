/**
 * Fertig (C.7, G.1): „Signal steht.“, Prüfsumme (gemessen), Autostart-Countdown in Segmenten.
 * Die Staffelung beginnt 450 ms später (nach dem Stroboskop im Schirm); der Countdown-Block
 * blendet bei t ≈ 1600 ms nach `install://done` ein.
 */
import { Sparkles } from "lucide-react";
import { COUNTDOWN_S, RAIL, UPDATE_RESTART_MS } from "../flow/useSetupFlow";
import { useT, type Lang } from "../i18n";
import { fixed, NBSP } from "../obs/format";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { Countdown } from "../components/Countdown";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { StepScale } from "../components/StepScale";
import { Block, Footer, Page, Title } from "./Page";
import { UpdateLabel } from "./Install";
import type { PageViewProps } from "./Welcome";

/** Vorlage „Autostart in {n} s“ → Text vor und nach der Zahl (Text VERSAL, Zahl und Einheit wie gesetzt) */
function splitTemplate(tpl: string): [string, string] {
  const i = tpl.indexOf("\u0000");
  return i < 0 ? [tpl, ""] : [tpl.slice(0, i), tpl.slice(i + 1)];
}

function CountLabel({ tpl, n }: { tpl: string; n: string }) {
  const [pre, post] = splitTemplate(tpl);
  return (
    <>
      <span className="uppercase">{pre}</span>
      <span>{n}</span>
      <span>{post.replace(/^ /, NBSP)}</span>
    </>
  );
}

/** Ab Seitenbeginn: Countdown-Block bei ≈ 1600 ms nach `install://done` (Seite kommt bei 650 ms) */
const COUNTDOWN_IN_S = 0.95;

export function Done({ flow }: PageViewProps) {
  const t = useT();
  const reduced = useReducedMotion();
  const { info, done, manifest, countdown, isUpdate, lang } = flow;
  const version = done?.version ?? manifest?.version ?? "";
  return (
    <Page delay={0.45} testId="page-done">
      <Block y={56}>
        {isUpdate ? (
          <StepScale steps={[t("steps.install"), t("steps.done")]} current={1} label={<UpdateLabel from={info?.installed?.version} to={version} />} />
        ) : (
          <StepScale steps={RAIL.map((s) => t(`steps.${s}`))} current={4} />
        )}
      </Block>
      <Block y={136}>
        <Title autoFocus={isUpdate}>{t("done.title")}</Title>
      </Block>
      <Block y={184}>
        <p className="obs-body">{isUpdate ? t("done.updated") : t("done.installed", { v: version })}</p>
      </Block>
      {done && (
        <Block y={240}>
          {done.verified ? (
            <div className="flex items-center gap-2" data-testid="done-verified">
              <span className="obs-label text-obs-fg-2">{t("done.verified")}</span>
              <span className="obs-tag">{t("obs.measured")}</span>
            </div>
          ) : (
            <Notice tone="warn" role="status" compact>
              {t("done.unverified")}
            </Notice>
          )}
        </Block>
      )}
      {isUpdate ? (
        <Block y={320} selfDelay={COUNTDOWN_IN_S}>
          <Countdown label={<CountLabel tpl={t("done.restartIn", { n: "\u0000" })} n={fixed(UPDATE_RESTART_MS / 1000, 1, lang as Lang)} />} seconds={null} total={1} mode="bar" durationMs={UPDATE_RESTART_MS} reduced={reduced} />
        </Block>
      ) : (
        countdown !== null &&
        countdown > 0 && (
          <Block y={320} selfDelay={COUNTDOWN_IN_S}>
            <Countdown label={<CountLabel tpl={t("done.autoLaunchShort", { n: "\u0000" })} n={String(countdown)} />} seconds={countdown} total={COUNTDOWN_S} mode="segments" reduced={reduced} />
          </Block>
        )
      )}
      <Footer
        left={
          !isUpdate &&
          (countdown !== null ? (
            <ObsButton variant="secondary" onClick={flow.stopCountdown}>
              {t("done.dontLaunch")}
            </ObsButton>
          ) : (
            <ObsButton variant="secondary" onClick={() => void flow.finish(false)}>
              {t("done.close")}
            </ObsButton>
          ))
        }
        right={
          !isUpdate && (
            <ObsButton variant="primary" icon={<Sparkles aria-hidden />} autoFocus onClick={() => void flow.finish(true)}>
              {t("done.launch")}
            </ObsButton>
          )
        }
      />
    </Page>
  );
}

