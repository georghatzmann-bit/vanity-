/**
 * Installation (C.6): zeigt nur GEMESSENES – Prozent, Bytes, Rate, Rest, Phasendauern,
 * „Fortgesetzt bei“. Die Inszenierung (Periode, Stern) zeigt der Schirm.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { api, type ErrorCode } from "../api";
import { PHASES, RAIL, errorBackTarget } from "../flow/useSetupFlow";
import { useT, type Lang } from "../i18n";
import { fixed, NBSP } from "../obs/format";
import { cn } from "@shared/lib/cn";
import { Glyph } from "../components/Glyph";
import { LinearScale } from "../components/LinearScale";
import { Notice } from "../components/Notice";
import { ObsButton } from "../components/ObsButton";
import { PhaseList, type PhaseItem } from "../components/PhaseList";
import { bytes, eta, Readout, TightDecimal } from "../components/Readout";
import { StepScale } from "../components/StepScale";
import { formatDuration } from "../obs/format";
import { Block, DASH, Footer, Page, Title } from "./Page";
import type { PageViewProps } from "./Welcome";

/** Ganze Prozent mit Einheit („43 %“ de, „43%“ en) */
export const pctShort = (p: number, lang: Lang) => `${Math.floor(Math.max(0, Math.min(100, p)))}${lang === "de" ? NBSP : ""}%`;

/** Update-Kopf: „UPDATE · v0.9.0 → v1.0.0“ (Pfeil als SVG) */
export function UpdateLabel({ from, to }: { from?: string; to?: string }) {
  const t = useT();
  return (
    <>
      <span>{t("obs.modeUpdate")} ·</span>
      <span className="normal-case">v{from ?? DASH}</span>
      <Glyph name="arrow-right" size={11} />
      <span className="normal-case">v{to ?? DASH}</span>
    </>
  );
}

export function Install({ flow }: PageViewProps) {
  const t = useT();
  const groupId = useId();
  const { lang, progress, error, info, manifest, busy, phaseIndex, phaseDurations, tip, resumedAt, downloadRestarted, isUpdate, retrying } = flow;
  const retryRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const failed = Boolean(error && error.code !== "cancelled");
  const cancelled = error?.code === "cancelled";
  const stopped = Boolean(error);
  const pct = progress?.percent ?? 0;
  const inDownload = progress?.phase === "download";
  const total = progress?.total ?? 0;

  const received = progress && total > 0 ? `${bytes(progress.downloaded)} / ${bytes(total)}` : DASH;
  const rate = !stopped && inDownload && progress.speed > 0 ? `${bytes(progress.speed)}/s` : DASH;
  const rest = !stopped && inDownload ? (progress.eta > 0 ? eta(progress.eta) : t("install.calculating")) : DASH;

  const up = (s: string) => s.toLocaleUpperCase(lang);
  const phaseName = (i: number) => t(`install.phases.${PHASES[Math.max(0, Math.min(PHASES.length - 1, i))]}`);
  const items: PhaseItem[] = PHASES.map((ph, i) => {
    const base = { id: ph, index: i + 1, label: phaseName(i) };
    if (i < phaseIndex) {
      const d = phaseDurations[ph];
      return { ...base, state: "done", status: d !== undefined ? `${up(t("install.ok"))} · ${formatDuration(d, lang)}` : up(t("install.ok")) };
    }
    if (i === phaseIndex) return ph === "download" ? { ...base, state: "active", status: pctShort(pct, lang), signal: true } : { ...base, state: "active", status: up(t("install.running")) };
    return { ...base, state: "todo" };
  });
  // Fehler/Abbruch: nur die abgebrochene Zeile
  const stopIdx = error ? (PHASES.indexOf(error.phase as (typeof PHASES)[number]) >= 0 ? PHASES.indexOf(error.phase as (typeof PHASES)[number]) : Math.min(phaseIndex, PHASES.length - 1)) : -1;
  const shownItems: PhaseItem[] = error
    ? [{ id: PHASES[stopIdx], index: stopIdx + 1, label: phaseName(stopIdx), state: failed ? "failed" : "todo", status: up(failed ? t("install.failed") : t("obs.halted")) }]
    : items;

  const statusLine = t("install.phaseStatus", { n: Math.min(phaseIndex + 1, PHASES.length), total: PHASES.length, phase: phaseName(phaseIndex) });
  const valueText = t("a11y.progressValue", {
    percent: fixed(pct, 0, lang),
    done: progress ? bytes(progress.downloaded) : "0",
    total: total > 0 ? bytes(total) : DASH,
  });

  // Hinweis im Bedienfeld; die Aktionen stehen in der Fußleiste (primär rechts, Zurück/Schließen links)
  let notice: ReactNode = null;
  let footLeft: ReactNode = !stopped && <span className="obs-label truncate text-obs-fg-2" data-testid="install-status">{statusLine}</span>;
  let footRight: ReactNode =
    busy && !stopped ? (
      <ObsButton variant="secondary" onClick={() => flow.setConfirmClose(true)}>
        {t("install.cancel")}
      </ObsButton>
    ) : null;
  const retryBtn = (label: string) => (
    <ObsButton ref={retryRef} variant="primary" icon={<RefreshCw aria-hidden />} disabled={retrying} onClick={() => void flow.retry()}>
      {label}
    </ObsButton>
  );
  if (failed && error) {
    notice = (
      <Notice tone="error" role="alert" title={t(`errors.${error.code as ErrorCode}`)} testId="install-error">
        {error.message && <span className="obs-value line-clamp-3 block text-[12px] leading-[18px] break-words whitespace-normal text-obs-fg-2">{error.message}</span>}
        {error.code === "network" && <span className="mt-1 block">{t("errors.resumeHint")}</span>}
      </Notice>
    );
    footLeft = !isUpdate && (
      <ObsButton variant="ghost" className="-ml-2" onClick={() => flow.go(errorBackTarget(error.code), -1)}>
        {t("errors.back")}
      </ObsButton>
    );
    footRight = error.retryable ? (
      retryBtn(error.code === "running" ? t("errors.closeApp") : t("errors.retry"))
    ) : isUpdate ? (
      // Update ohne Wiederholung: sonst bliebe nur das X
      <ObsButton variant="primary" autoFocus onClick={() => void api.quit()}>
        {t("common.close")}
      </ObsButton>
    ) : null;
  } else if (cancelled) {
    notice = (
      <Notice tone="neutral" testId="install-cancelled">
        {t("install.cancelledText")}
      </Notice>
    );
    footLeft = (
      <ObsButton variant="ghost" className="-ml-2" onClick={() => void api.quit()}>
        {t("common.close")}
      </ObsButton>
    );
    footRight = retryBtn(t("errors.retry"));
  }

  // Fokus (H): Nach Abbruch/Fehler verschwindet „Abbrechen“ → Fokus auf „Erneut versuchen“;
  // nach dem Fortsetzen verschwindet „Erneut versuchen“ → Fokus auf die H1.
  const wasStopped = useRef(stopped);
  useEffect(() => {
    const before = wasStopped.current;
    wasStopped.current = stopped;
    if (before === stopped) return;
    const lost = () => {
      const a = document.activeElement;
      return !a || a === document.body || !a.isConnected || Boolean(a.closest("[data-leaving]"));
    };
    const id = window.setTimeout(() => {
      if (stopped) {
        if (cancelled || lost()) retryRef.current?.focus({ preventScroll: true });
      } else if (lost()) document.getElementById(titleId)?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(id);
  }, [stopped, cancelled, titleId]);

  return (
    <Page testId="page-install">
      <Block y={56}>
        {isUpdate ? (
          <StepScale steps={[t("steps.install"), t("steps.done")]} current={0} label={<UpdateLabel from={info?.installed?.version} to={manifest?.version} />} />
        ) : (
          <StepScale steps={RAIL.map((s) => t(`steps.${s}`))} current={3} />
        )}
      </Block>
      <Block y={124}>
        <Title small id={titleId}>
          {cancelled ? t("install.cancelled") : failed ? t("install.failedTitle") : isUpdate ? t("install.updateTitle", { v: manifest?.version ?? "" }) : t("install.title")}
        </Title>
      </Block>

      {/* Übertragung: y 168 Kopf, 188 Prozent, 190/210/230 Werte, 252 Skala */}
      <Block y={168} className="h-[112px]">
        <div role="progressbar" aria-labelledby={groupId} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={valueText} className="relative h-full">
          <div id={groupId} className="obs-label flex h-[18px] items-center gap-2">
            {stopped ? (
              <span>
                {t("install.transfer")} · {t("install.lastMeasured")}
              </span>
            ) : (
              <span>{t("install.transfer")}</span>
            )}
          </div>
          {/* Prozent: Ziffern Mono 44, „%“ Mono 22 fg-3 auf derselben Grundlinie, 4 px Abstand */}
          <div className="absolute top-5 left-0 flex items-baseline">
            <span className={cn("obs-value obs-value-xl", stopped ? "text-obs-fg-3" : "text-obs-fg")} data-testid="obs-percent" data-value={pct}>
              <TightDecimal text={fixed(pct, 1, lang)} />
            </span>
            <span className="obs-value obs-value-lg ml-1 text-obs-fg-3">%</span>
          </div>
          {/* GEMESSEN gilt für Bytes, Rate und Rest (der Prozentwert folgt nach dem Download dem Schema) */}
          {!stopped && (
            <span className="obs-tag absolute top-0 left-[232px]" data-testid="measured-tag">
              {t("obs.measured")}
            </span>
          )}
          <div className="absolute top-[22px] left-[232px] flex flex-col">
            <Readout layout="row" size="sm" label={t("install.received")} value={received} tone={stopped ? "muted" : "fg"} testId="obs-received" />
            <Readout layout="row" size="sm" label={t("install.rate")} value={rate} tone={stopped ? "muted" : "fg"} />
            <Readout layout="row" size="sm" label={t("install.rest")} value={rest} tone={stopped ? "muted" : "fg"} />
          </div>
          <div className="absolute top-[84px] left-0">
            <LinearScale value={pct} frozen={stopped} />
          </div>
        </div>
      </Block>

      <Block y={290}>
        <div className="obs-label">{t("install.phasesLabel")}</div>
      </Block>
      <Block y={308}>
        <PhaseList items={shownItems} />
      </Block>

      {notice ? (
        <Block y={344}>{notice}</Block>
      ) : (
        <Block y={480} className="flex gap-3">
          {downloadRestarted ? (
            <span className="obs-label text-obs-fg-2" data-testid="download-restarted">
              {t("install.restarted")}
            </span>
          ) : resumedAt !== null ? (
            <span className="obs-label text-obs-fg-2" data-testid="resumed-at">
              {t("install.resumedAt", { size: bytes(resumedAt) })}
            </span>
          ) : (
            <>
              <span className="obs-label shrink-0 pt-[2px]">{t("install.note")}</span>
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={tip} className="obs-small min-w-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                  {t(`install.tips.t${tip + 1}`)}
                </motion.span>
              </AnimatePresence>
            </>
          )}
        </Block>
      )}

      <Footer left={footLeft} right={footRight} />
    </Page>
  );
}
