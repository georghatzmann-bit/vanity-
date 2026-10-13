import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { api, initImgSrc } from "@/lib/api";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { useBreakReminder, useDragDrop, useHotkeys, useStartupTasks } from "@/hooks/useAppEffects";
import { AchievementPopup } from "@/components/AchievementPopup";
import { Background } from "@/components/Background";
import { BigPicture } from "@/components/BigPicture";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DiceModal } from "@/components/DiceModal";
import { Dock } from "@/components/Dock";
import { DropZone } from "@/components/DropZone";
import { Intro } from "@/components/Intro";
import { LaunchRitual } from "@/components/LaunchRitual";
import { ManualAdd } from "@/components/ManualAdd";
import { ScanWizard } from "@/components/ScanWizard";
import { Sidebar } from "@/components/Sidebar";
import { TitleBar } from "@/components/TitleBar";
import { Toasts } from "@/components/Toasts";
import { ContextMenuHost } from "@/components/ui/ContextMenu";
import { Achievements } from "@/pages/Achievements";
import { Cleanup } from "@/pages/Cleanup";
import { Collections } from "@/pages/Collections";
import { GameDetail } from "@/pages/GameDetail";
import { Home } from "@/pages/Home";
import { Library } from "@/pages/Library";
import { SettingsPage } from "@/pages/Settings";
import { Stats } from "@/pages/Stats";
import { Wishlist } from "@/pages/Wishlist";
import { pageVariants } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

// Für automatische Oberflächen-Tests (nur im Entwicklungsmodus)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__nova = { useUI, useLibrary, useSettings };
}

function CurrentPage() {
  const route = useUI((s) => s.route);
  switch (route.page) {
    case "home":
      return <Home />;
    case "library":
      return <Library />;
    case "game":
      return <GameDetail id={route.id ?? ""} />;
    case "collections":
      return <Collections id={route.id} />;
    case "stats":
      return <Stats />;
    case "achievements":
      return <Achievements />;
    case "wishlist":
      return <Wishlist />;
    case "cleanup":
      return <Cleanup />;
    case "settings":
      return <SettingsPage section={route.section} />;
    default:
      return <Home />;
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const motionLevel = useSettings((s) => s.settings.motion);
  const settingsLoaded = useSettings((s) => s.loaded);
  const introEnabled = useSettings((s) => s.settings.introAnimation);
  const route = useUI((s) => s.route);
  const bigPicture = useUI((s) => s.bigPicture);

  useEffect(() => {
    void (async () => {
      await initImgSrc();
      // Autostart mit Windows (unsichtbar im Infobereich): keine Startanimation, kein Startklang
      const info = await api.appInfo().catch(() => null);
      if (info?.startedMinimized) {
        setShowIntro(false);
        useUI.getState().setLogoDocked(true);
        useUI.getState().setIntroDone();
      } else {
        sound.warmup();
      }
      await useSettings.getState().load();
      await useLibrary.getState().load();
      setReady(true);
      if (isTauri() && !info?.startedMinimized) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        // Kleiner Bildschirm (z. B. 1366×768)? Dann passt das Fenster nicht - also maximieren.
        try {
          const [size, factor] = await Promise.all([win.outerSize(), win.scaleFactor()]);
          if (size.width / factor > window.screen.availWidth || size.height / factor > window.screen.availHeight) await win.maximize();
        } catch {
          /* egal */
        }
        await win.setFocus().catch(() => undefined);
      }
    })();
  }, []);

  // Startanimation abgeschaltet? Dann direkt in die App.
  useEffect(() => {
    if (settingsLoaded && !introEnabled) {
      setShowIntro(false);
      useUI.getState().setLogoDocked(true);
      useUI.getState().setIntroDone();
    }
  }, [settingsLoaded, introEnabled]);

  useHotkeys();
  useDragDrop();
  useBreakReminder();
  useStartupTasks(ready);

  const onIntroLeave = useCallback(() => useUI.getState().setLogoDocked(true), []);
  const onIntroDone = useCallback(() => {
    setShowIntro(false);
    useUI.getState().setIntroDone();
  }, []);

  const routeKey = `${route.page}:${route.id ?? ""}`;

  return (
    <MotionConfig reducedMotion={motionLevel === "full" ? "never" : "always"}>
      <LayoutGroup>
        <Background />
        <div className="app-shell flex h-full flex-col">
          <TitleBar />
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            <main className="relative min-w-0 flex-1 overflow-hidden">
              <AnimatePresence mode="wait">
                <motion.div key={routeKey} className="h-full overflow-y-auto" variants={pageVariants} initial="initial" animate="enter" exit="exit">
                  {ready && <CurrentPage />}
                </motion.div>
              </AnimatePresence>
            </main>
          </div>
        </div>
        {ready && <Dock />}
        <CommandPalette />
        <DiceModal />
        <ScanWizard />
        <ManualAdd />
        <DropZone />
        <ConfirmDialog />
        <AnimatePresence>{bigPicture && <BigPicture />}</AnimatePresence>
        <LaunchRitual />
        <AchievementPopup />
        <Toasts />
        <ContextMenuHost />
        {showIntro && settingsLoaded && introEnabled && <Intro ready={ready} onLeave={onIntroLeave} onDone={onIntroDone} />}
        {showIntro && !settingsLoaded && <div className="fixed inset-0" style={{ background: "var(--nv-bg)", zIndex: "var(--nv-z-intro)" }} />}
      </LayoutGroup>
    </MotionConfig>
  );
}
