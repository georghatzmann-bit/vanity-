import { useEffect, useRef, type ComponentType } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import { BubbleIniDialog } from "@/components/bubble/BubbleIniDialog";
import { PageTransition, Skeleton } from "@/components/fx";
import { Background } from "@/components/layout/Background";
import { CloseConfirmDialog } from "@/components/layout/CloseConfirmDialog";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { Welcome } from "@/components/onboarding/Welcome";
import { WhatsNew } from "@/components/onboarding/WhatsNew";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useWindowActivity } from "@/hooks/use-window-active";
import { api, inTauri } from "@/lib/api";
import { useApp, type PageId } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AboutPage } from "@/pages/AboutPage";
import { CrashesPage } from "@/pages/CrashesPage";
import { IngameMenuPage } from "@/pages/IngameMenuPage";
import { LibraryPage } from "@/pages/LibraryPage";
import { LogsPage } from "@/pages/LogsPage";
import { MatchPage } from "@/pages/MatchPage";
import { ProfilesPage } from "@/pages/ProfilesPage";
import { ServersPage } from "@/pages/ServersPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { StartPage } from "@/pages/StartPage";

const pages: Record<PageId, ComponentType> = {
  start: StartPage,
  library: LibraryPage,
  servers: ServersPage,
  match: MatchPage,
  ingame: IngameMenuPage,
  profiles: ProfilesPage,
  logs: LogsPage,
  crashes: CrashesPage,
  settings: SettingsPage,
  about: AboutPage,
};

export function App() {
  const page = useApp((s) => s.page);
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const settings = useApp((s) => s.config.settings);
  const welcome = useApp((s) => s.welcome);
  const gameRunning = useApp((s) => s.services.game === "running");
  const Page = pages[page];
  const mainRef = useRef<HTMLElement>(null);

  const osReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { visible, focused } = useWindowActivity();
  const calm = settings.reduceMotion || osReducedMotion;
  // Decorative loops stop while the window is hidden, or while you play and the launcher is in the background
  const paused = !visible || (gameRunning && !focused);

  useEffect(() => {
    init();
  }, [init]);

  // The config is there: show the main window two frames later (after the first real paint)
  // and close the splash. The main window starts hidden, and a hidden page may get no animation
  // frames at all, so a short timer also fires; whichever comes first wins (app_ready is safe to
  // call twice). Rust does the same after 8 s as a last safety net.
  useEffect(() => {
    if (!ready || !inTauri) return;
    let done = false;
    const show = () => {
      if (done) return;
      done = true;
      api.appReady().catch(() => {});
    };
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(show);
    });
    const timer = window.setTimeout(show, 200);
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(timer);
    };
  }, [ready]);

  // No browser context menu (Reload, Inspect …) in the finished launcher
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  return (
    <MotionConfig reducedMotion={settings.reduceMotion ? "always" : "user"}>
      <TooltipProvider delayDuration={250}>
        <div
          className={cn(
            "relative flex h-full flex-col overflow-hidden",
            !settings.glass && "no-glass",
            settings.reduceMotion && "reduce-motion",
            !settings.animatedBackground && "static-background",
            paused && "nb-paused",
          )}
        >
          <Background animate={settings.animatedBackground && !calm} paused={paused} />
          <TitleBar />
          {/* While the welcome is open, the app behind it can't be reached with Tab */}
          <div className="relative flex min-h-0 flex-1" inert={ready && welcome !== "none"}>
            <Sidebar />
            <main ref={mainRef} className="relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
              {ready ? (
                <AnimatePresence
                  mode="wait"
                  initial={false}
                  onExitComplete={() => mainRef.current?.scrollTo({ top: 0 })}
                >
                  <PageTransition key={page}>
                    <Page />
                  </PageTransition>
                </AnimatePresence>
              ) : (
                <LoadingShell />
              )}
            </main>
          </div>

          <AnimatePresence>
            {ready && welcome === "full" && <Welcome key="welcome" />}
            {ready && welcome === "whatsnew" && <WhatsNew key="whatsnew" />}
          </AnimatePresence>

          <BubbleIniDialog />
          <CloseConfirmDialog />
          <Toaster position="bottom-right" />
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}

/** Placeholder while the config loads (usually only a few milliseconds). */
function LoadingShell() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 pt-7 pb-10" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-56 rounded-2xl" />
      <Skeleton className="h-32 rounded-xl" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-20 rounded-xl" />
      </div>
    </div>
  );
}
