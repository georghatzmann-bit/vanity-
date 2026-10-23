import { useEffect, useRef, type ComponentType } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { LaunchDemoDriver } from "@/components/LaunchDemoDriver";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Background } from "@/components/layout/Background";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { useUi, type PageId } from "@/lib/store";
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
  const page = useUi((s) => s.page);
  const appearance = useUi((s) => s.appearance);
  const Page = pages[page];
  const mainRef = useRef<HTMLElement>(null);

  // Kein Browser-Kontextmenü (Neu laden, Untersuchen …) im fertigen Launcher
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  return (
    <MotionConfig reducedMotion={appearance.reduceMotion ? "always" : "user"}>
      <TooltipProvider delayDuration={250}>
        <div
          className={cn(
            "relative flex h-full flex-col overflow-hidden",
            !appearance.glass && "no-glass",
            appearance.reduceMotion && "reduce-motion",
            !appearance.animatedBackground && "static-background",
          )}
        >
          <Background />
          <TitleBar />
          <div className="relative flex min-h-0 flex-1">
            <Sidebar />
            <main ref={mainRef} className="relative min-w-0 flex-1 overflow-y-auto">
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
            </main>
          </div>
          <Toaster position="bottom-right" />
          <LaunchDemoDriver />
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}
