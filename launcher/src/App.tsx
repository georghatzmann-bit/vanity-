import { useEffect, useRef, type ComponentType } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Background } from "@/components/layout/Background";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
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
  const Page = pages[page];
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    init();
  }, [init]);

  // Kein Browser-Kontextmenü (Neu laden, Untersuchen …) im fertigen Launcher
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
          )}
        >
          <Background />
          <TitleBar />
          <div className="relative flex min-h-0 flex-1">
            <Sidebar />
            <main ref={mainRef} className="relative min-w-0 flex-1 overflow-y-auto">
              {ready && (
                <AnimatePresence
                  mode="wait"
                  initial={false}
                  onExitComplete={() => mainRef.current?.scrollTo({ top: 0 })}
                >
                  <motion.div
                    key={page}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
                  >
                    <Page />
                  </motion.div>
                </AnimatePresence>
              )}
            </main>
          </div>
          <Toaster position="bottom-right" />
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}
