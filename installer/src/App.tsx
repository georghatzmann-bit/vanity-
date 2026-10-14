/**
 * Setup „Radioteleskop“: nur Komposition (I.4). Rahmen, Intro oder Schirm + Seiten des
 * Bedienfelds, Abbruch-Dialog und Ansagen. Ablauf: `useSetupFlow`, Bild und Ton: `useObservatory`.
 */
import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { emptyAnnounce, nextAnnouncement, nextStepAfterIntro, useSetupFlow, type FlowEvent, type Step } from "./flow/useSetupFlow";
import { useObservatory } from "./hooks/useObservatory";
import { useQuality } from "./hooks/useQuality";
import { useReducedMotion } from "./hooks/useReducedMotion";
import { useT } from "./i18n";
import { coordLine } from "./obs/catalog";
import { Frame } from "./components/Frame";
import { HoldEnter } from "./pages/Page";
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

/** Vorab-Mount unter dem Intro: Verzögerung ab „Signal erfasst.“ (volles Intro) für Schirm bzw. Seite */
const EARLY_SCHIRM_MS = 200;
const EARLY_PAGE_MS = 420;
/** „Erfasst“ früher als nach so vielen ms = Überspringen/Kurzfassung: sofort mounten */
const EARLY_FULL_INTRO_MS = 4000;
const EARLY_QUICK_PAGE_MS = 120;

/** Höchstens so lange liegt das ausblendende Intro über der neuen Oberfläche (Ausblenden 200–300 ms) */
const INTRO_OVERLAP_MS = 450;

/** Fokus auf die H1 der aktuellen Seite (wenn das vorher fokussierte Element verschwunden ist) */
function focusPageTitle() {
  const h = document.querySelector<HTMLElement>("[data-testid^='page-'] h1");
  h?.focus({ preventScroll: true });
}

export function App() {
  const t = useT();
  const flow = useSetupFlow();
  const reduced = useReducedMotion();
  const { quality } = useQuality();
  const obs = useObservatory(flow, reduced);
  const { step, info, lang, muted } = flow;

  // Ansagen (H): Phasenwechsel und 25-%-Schritte, höchstens alle 5 s; Fertig-Titel
  const lastAnnounced = useRef(emptyAnnounce());
  const lastUnAnnounced = useRef(emptyAnnounce());
  useEffect(
    () =>
      flow.onEvent((e: FlowEvent) => {
        switch (e.type) {
          case "install://progress": {
            const p = e.payload;
            const next = nextAnnouncement(lastAnnounced.current, p, performance.now());
            if (!next) break;
            lastAnnounced.current = next;
            announce(t("a11y.progress", { phase: t(`install.phases.${p.phase}`), percent: Math.floor(Math.max(0, Math.min(100, p.percent))) }));
            break;
          }
          case "uninstall://progress": {
            // dieselbe Drossel wie bei der Installation (Schritt = Phase, höchstens alle 5 s)
            const p = e.payload;
            if (p.step === "done") break;
            const next = nextAnnouncement(lastUnAnnounced.current, { phase: p.step, percent: p.percent }, performance.now());
            if (!next) break;
            lastUnAnnounced.current = next;
            announce(t("a11y.uninstallProgress", { step: t(`uninstall.steps.${p.step}`), percent: Math.round(p.percent) }));
            break;
          }
          case "flow://uninstall-start":
            lastUnAnnounced.current = emptyAnnounce();
            break;
          case "flow://install-start":
            lastAnnounced.current = emptyAnnounce();
            break;
          case "flow://step":
            if (e.step === "done") announce(t("done.title"));
            else if (e.step === "un-done") announce(t("uninstall.doneTitle"));
            break;
        }
      }),
    [flow.onEvent, t],
  );

  // Kreuzblende Intro → Schirm + Bedienfeld (ohne Schwarzphase): Sobald das Intro ausblendet
  // (body[data-intro-done]), geht der Ablauf weiter und die Oberfläche entsteht UNTER dem Intro.
  // Das Intro bleibt darüber, bis es selbst `onExit` meldet.
  const [introGone, setIntroGone] = useState(false);
  const introFinished = flow.introFinished;
  useEffect(() => {
    if (introGone) return;
    const check = () => {
      if (document.body.dataset.introDone) introFinished();
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-intro-done"] });
    return () => mo.disconnect();
  }, [introGone, introFinished]);
  const onIntroExit = () => {
    introFinished();
    // Halten ohne Setup-Infos: `onExit` kommt früh, das Intro bleibt, bis es weitergeht
    if (step !== "intro") setIntroGone(true);
  };
  useEffect(() => {
    if (step === "intro" || introGone) return;
    const id = window.setTimeout(() => setIntroGone(true), INTRO_OVERLAP_MS);
    return () => window.clearTimeout(id);
  }, [step, introGone]);

  // Schirm (Schirm + StarCanvas) schon in der letzten Intro-Phase („Signal erfasst.“ bzw. sofort nach
  // dem Überspringen) unsichtbar mounten: Mount-, Layer- und Konturkosten fallen dann VOR dem Übergang an,
  // nicht mitten in der Überblendung.
  // Zwei kleine Schritte statt eines großen: erst der Schirm, dann die erste Seite – beim vollen Intro
  // nach dem Auftritt von „Signal erfasst.“ (ruhige Phase bis 5,3 s), nach dem Überspringen sofort.
  const [schirmEarly, setSchirmEarly] = useState(false);
  const [pageEarly, setPageEarly] = useState(false);
  const appT0 = useRef(performance.now());
  useEffect(() => {
    if (pageEarly || step !== "intro") return;
    const ids: number[] = [];
    let armed = false;
    const check = () => {
      if (armed) return;
      const ph = document.querySelector<HTMLElement>("[data-testid='intro']")?.dataset.phase;
      if (ph !== "acquired" && ph !== "exit") return;
      armed = true;
      const quick = performance.now() - appT0.current < EARLY_FULL_INTRO_MS;
      ids.push(window.setTimeout(() => setSchirmEarly(true), quick ? 0 : EARLY_SCHIRM_MS));
      ids.push(window.setTimeout(() => setPageEarly(true), quick ? EARLY_QUICK_PAGE_MS : EARLY_PAGE_MS));
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-phase"] });
    check();
    return () => {
      mo.disconnect();
      ids.forEach((id) => window.clearTimeout(id));
    };
  }, [pageEarly, step]);
  const schirmOn = step !== "intro" || schirmEarly;

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

  // Die erste Seite wird zusammen mit dem Schirm schon unter dem Intro gemountet (unsichtbar, inert,
  // gleicher Key) – beim Wechsel auf den Schritt entsteht nichts Neues mehr, sie tritt nur noch auf.
  const pendingStep: Step | null = step === "intro" && pageEarly && info ? nextStepAfterIntro(info).step : null;
  const shownStep: Step | null = step !== "intro" ? step : pendingStep;
  const PageView = shownStep ? PAGES[shownStep] : undefined;
  const pageProps: PageViewProps = { flow, obs };

  return (
    <div className="relative h-full w-full bg-obs-bg">
      <Frame lang={lang} onLang={flow.setLang} muted={muted} onMute={flow.setMuted} onClose={flow.requestClose} status={status} split={step !== "intro"} reduced={reduced}>
        {/* Der Schirm bleibt beim Seitenwechsel bestehen (außerhalb von AnimatePresence) */}
        {schirmOn && (
          <div className="absolute inset-0" style={{ opacity: step === "intro" ? 0 : 1 }} aria-hidden={step === "intro" || undefined}>
            <Schirm obs={obs} reduced={reduced} quality={quality} />
          </div>
        )}
        {shownStep && (
          // Staffeln statt kreuzen: Die erste Seite tritt erst auf, wenn das Intro ausgeblendet ist.
          // Seitenwechsel: alte Seite blendet in 80 ms aus, die neue staffelt sich gleichzeitig ein.
          <div className="pointer-events-none absolute inset-0" inert={step === "intro"} aria-hidden={step === "intro" || undefined}>
            <HoldEnter.Provider value={!introGone}>
              <AnimatePresence>{PageView && <PageView key={shownStep} {...pageProps} />}</AnimatePresence>
            </HoldEnter.Provider>
          </div>
        )}
        {!introGone && (
          <div className="absolute inset-0 z-20">
            <IntroScreen info={info} reduced={reduced} quality={quality} onExit={onIntroExit} />
          </div>
        )}
      </Frame>
      <ConfirmDialog
        open={flow.confirmClose && step === "install"}
        title={t("install.cancelTitle")}
        text={t("install.cancelConfirm")}
        cancelLabel={t("install.cancelKeep")}
        confirmLabel={t("install.cancelConfirmBtn")}
        onCancel={() => flow.setConfirmClose(false)}
        onConfirm={() => void flow.cancelInstall()}
        onClosedFocus={focusPageTitle}
      />
      <LiveRegion />
    </div>
  );
}
