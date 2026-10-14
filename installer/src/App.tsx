/**
 * Setup „Radioteleskop“: nur Komposition (I.4). Rahmen, Intro oder Schirm + Seiten des
 * Bedienfelds, Abbruch-Dialog und Ansagen. Ablauf: `useSetupFlow`, Bild und Ton: `useObservatory`.
 */
import { useEffect, useRef } from "react";
import { AnimatePresence } from "motion/react";
import { useSetupFlow, type FlowEvent, type Step } from "./flow/useSetupFlow";
import { useObservatory } from "./hooks/useObservatory";
import { useQuality } from "./hooks/useQuality";
import { useReducedMotion } from "./hooks/useReducedMotion";
import { useT } from "./i18n";
import { coordLine } from "./obs/catalog";
import { Frame } from "./components/Frame";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { LiveRegion, announce } from "./components/LiveRegion";
import { Schirm } from "./components/Schirm";
import { IntroScreen } from "./intro/IntroScreen";
import { Welcome, type PageViewProps } from "./pages/Welcome";
import { Maintenance } from "./pages/Maintenance";
import { Folder } from "./pages/Folder";
import { Options } from "./pages/Options";
import { Install } from "./pages/Install";
import { Done } from "./pages/Done";
import { UnConfirm } from "./pages/UnConfirm";
import { UnRun } from "./pages/UnRun";
import { UnDone } from "./pages/UnDone";

const PAGES: Partial<Record<Step, (p: PageViewProps) => React.ReactElement>> = {
  welcome: Welcome,
  maintenance: Maintenance,
  folder: Folder,
  options: Options,
  install: Install,
  done: Done,
  "un-confirm": UnConfirm,
  "un-run": UnRun,
  "un-done": UnDone,
};

export function App() {
  const t = useT();
  const flow = useSetupFlow();
  const reduced = useReducedMotion();
  const { quality } = useQuality();
  const obs = useObservatory(flow, reduced);
  const { step, info, lang, muted } = flow;

  // Ansagen (H): Phasenwechsel und 10-%-Schritte, Fertig-Titel
  const lastAnnounced = useRef({ phase: "", decile: -1 });
  useEffect(
    () =>
      flow.onEvent((e: FlowEvent) => {
        switch (e.type) {
          case "install://progress": {
            const p = e.payload;
            const decile = Math.floor(Math.max(0, Math.min(100, p.percent)) / 10);
            const last = lastAnnounced.current;
            if (p.phase === "done" || (p.phase === last.phase && decile === last.decile)) break;
            lastAnnounced.current = { phase: p.phase, decile };
            announce(t("a11y.progress", { phase: t(`install.phases.${p.phase}`), percent: decile * 10 }));
            break;
          }
          case "uninstall://progress": {
            const p = e.payload;
            if (p.step === "done") break;
            announce(t("a11y.uninstallProgress", { step: t(`uninstall.steps.${p.step}`), percent: Math.round(p.percent) }));
            break;
          }
          case "flow://install-start":
            lastAnnounced.current = { phase: "", decile: -1 };
            break;
          case "flow://step":
            if (e.step === "done") announce(t("done.title"));
            else if (e.step === "un-done") announce(t("uninstall.doneTitle"));
            break;
        }
      }),
    [flow.onEvent, t],
  );

  // Für Tour/E2E: Intro vorbei (J.1)
  useEffect(() => {
    if (step === "intro") return;
    try {
      document.body.dataset.introDone = "1";
    } catch {
      /* egal */
    }
  }, [step]);

  const mode = info?.mode ?? "install";
  const modeSuffix = mode === "update" ? t("obs.modeUpdate") : mode === "uninstall" ? t("obs.modeUninstall") : mode === "maintenance" ? t("obs.modeMaintenance") : "";
  const status = {
    label: t("obs.target"),
    left: coordLine(step === "intro" ? "b1919" : obs.reference),
    right: `${t("obs.setup", { v: info?.setupVersion ?? "1.0.0" })}${modeSuffix ? ` · ${modeSuffix}` : ""}`,
  };

  const PageView = PAGES[step];
  const pageProps: PageViewProps = { flow, obs };

  return (
    <div className="relative h-full w-full bg-obs-bg">
      <Frame lang={lang} onLang={flow.setLang} muted={muted} onMute={flow.setMuted} onClose={flow.requestClose} status={status} split={step !== "intro"} reduced={reduced}>
        {step === "intro" ? (
          <IntroScreen info={info} reduced={reduced} quality={quality} onExit={flow.introFinished} />
        ) : (
          <>
            {/* Der Schirm bleibt beim Seitenwechsel bestehen (außerhalb von AnimatePresence) */}
            <Schirm obs={obs} reduced={reduced} quality={quality} />
            <AnimatePresence mode="wait">{PageView && <PageView key={step} {...pageProps} />}</AnimatePresence>
          </>
        )}
      </Frame>
      <ConfirmDialog
        open={flow.confirmClose}
        title={t("install.cancelTitle")}
        text={t("install.cancelConfirm")}
        cancelLabel={t("install.cancelKeep")}
        confirmLabel={t("install.cancelConfirmBtn")}
        onCancel={() => flow.setConfirmClose(false)}
        onConfirm={() => void flow.cancelInstall()}
      />
      <LiveRegion />
    </div>
  );
}
