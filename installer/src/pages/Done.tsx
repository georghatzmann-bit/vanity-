/**
 * Fertig (C.7, G.1): „Signal steht.“, Prüfsumme (gemessen), Autostart als Instrument (Linearskala
 * 5 → 0 s) und ein Protokoll aus gemessenen Werten (Gesamtdauer, übertragen, mittlere Rate).
 * Die Staffelung beginnt 150 ms später (nach dem Stroboskop im Schirm).
 */
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { COUNTDOWN_S, installLog, RAIL, UPDATE_RESTART_MS } from "../flow/useSetupFlow";
import { useT, type Lang } from "../i18n";
import { fixed, formatDuration, NBSP } from "../obs/format";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { Countdown } from "../components/Countdown";
import { LogList } from "../components/LogList";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { bytes } from "../components/Readout";
import { StepScale } from "../components/StepScale";
import { Block, DASH, Footer, Page, Title } from "./Page";
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

/** Restzeit des Update-Neustarts, live in 0,1 s (ab dem Erscheinen der Seite = Start des Timers) */
function useUpdateRemaining(active: boolean): number {
  const [rem, setRem] = useState(UPDATE_RESTART_MS / 1000);
  useEffect(() => {
    if (!active) return;
    const t0 = performance.now();
    const id = window.setInterval(() => setRem(Math.max(0, (UPDATE_RESTART_MS - (performance.now() - t0)) / 1000)), 100);
    return () => window.clearInterval(id);
  }, [active]);
  return rem;
}

/** Countdown-Block erscheint nach der Staffelung (Seite kommt 650 ms nach `install://done`) */
const COUNTDOWN_IN_S = 0.6;
const UPDATE_TOTAL_S = UPDATE_RESTART_MS / 1000;

export function Done({ flow }: PageViewProps) {
  const t = useT();
  const reduced = useReducedMotion();
  const { info, done, manifest, countdown, isUpdate, lang, phaseDurations, progress, transferred, finishing } = flow;
  const version = done?.version ?? manifest?.version ?? "";
  const updateRem = useUpdateRemaining(isUpdate);
  // übertragen = in dieser Sitzung wirklich geladene Bytes (nach dem Fortsetzen nicht die ganze Datei)
  const log = installLog(phaseDurations, transferred, progress?.total);
  const l = lang as Lang;
  return (
    <Page delay={0.15} testId="page-done">
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
        <Block y={232}>
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
        <Block y={284} selfDelay={COUNTDOWN_IN_S}>
          <Countdown
            label={<CountLabel tpl={t("done.restartIn", { n: "\u0000" })} n={fixed(updateRem, 1, l)} />}
            totalS={UPDATE_TOTAL_S}
            remainingS={UPDATE_TOTAL_S}
            toS={0}
            glideS={UPDATE_TOTAL_S}
            lang={l}
            reduced={reduced}
            testValue={updateRem}
          />
        </Block>
      ) : (
        countdown !== null &&
        countdown > 0 && (
          <Block y={284} selfDelay={COUNTDOWN_IN_S}>
            <Countdown
              label={<CountLabel tpl={t("done.autoLaunchShort", { n: "\u0000" })} n={String(countdown)} />}
              totalS={COUNTDOWN_S}
              remainingS={countdown}
              toS={countdown - 1}
              glideS={1}
              lang={l}
              reduced={reduced}
            />
          </Block>
        )
      )}
      <Block y={384} selfDelay={COUNTDOWN_IN_S}>
        <LogList
          title={t("done.log")}
          tag={t("obs.measured")}
          testId="done-log"
          rows={[
            { label: t("done.logTotal"), value: log.totalMs !== null ? formatDuration(log.totalMs, l) : DASH },
            { label: t(log.resumed ? "done.logBytesResumed" : "done.logBytes"), value: log.bytes !== null ? bytes(log.bytes) : DASH },
            { label: t("done.logRate"), value: log.rate !== null ? `${bytes(log.rate)}/s` : DASH },
          ]}
        />
      </Block>
      <Footer
        left={
          !isUpdate &&
          (countdown !== null ? (
            <ObsButton variant="secondary" disabled={Boolean(finishing)} onClick={flow.stopCountdown}>
              {t("done.dontLaunch")}
            </ObsButton>
          ) : (
            <ObsButton variant="secondary" disabled={Boolean(finishing)} onClick={() => void flow.finish(false)}>
              {t("done.close")}
            </ObsButton>
          ))
        }
        right={
          !isUpdate && (
            <ObsButton variant="primary" iconRight={finishing ? undefined : <ArrowRight aria-hidden />} autoFocus disabled={Boolean(finishing)} onClick={() => void flow.finish(true)}>
              {finishing === "launch" ? t("done.starting") : t("done.launch")}
            </ObsButton>
          )
        }
      />
    </Page>
  );
}
