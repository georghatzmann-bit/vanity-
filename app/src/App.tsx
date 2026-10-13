import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import { api, initImgSrc } from "@/lib/api";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useNetAuto } from "@/store/netauto";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { useDragDrop, useHotkeys, useLiveStats, useStartupTasks } from "@/hooks/useAppEffects";
import { Background } from "@/components/Background";
import { CommandPalette } from "@/components/CommandPalette";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DropZone } from "@/components/DropZone";
import { Intro } from "@/components/Intro";
import { LaunchRitual } from "@/components/LaunchRitual";
import { ManualAdd } from "@/components/ManualAdd";
import { ScanWizard } from "@/components/ScanWizard";
import { Sidebar } from "@/components/Sidebar";
import { TitleBar } from "@/components/TitleBar";
import { Toasts } from "@/components/Toasts";
import { ContextMenuHost } from "@/components/ui/ContextMenu";
import { Cockpit } from "@/pages/Cockpit";
import { GameDetail } from "@/pages/GameDetail";
import { Games } from "@/pages/Games";
import { Network } from "@/pages/Network";
import { Optimize } from "@/pages/Optimize";
import { Reports } from "@/pages/Reports";
import { SettingsPage } from "@/pages/Settings";
import { pageVariants } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

// Für automatische Oberflächen-Tests (nur im Entwicklungsmodus)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__pulsar = { useUI, useLibrary, useSettings, useNet, useBoost, useNetAuto };
}

function CurrentPage() {
  const route = useUI((s) => s.route);
  switch (route.page) {
    case "cockpit":
      return <Cockpit />;
    case "games":
      return <Games />;
    case "game":
      return <GameDetail id={route.id ?? ""} section={route.section} />;
    case "network":
      return <Network section={route.section} />;
    case "optimize":
      return <Optimize section={route.section} />;
    case "reports":
      return <Reports />;
    case "settings":
      return <SettingsPage section={route.section} />;
    default:
      return <Cockpit />;
  }
}

export function App() {
  const [ready, setReady] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const motionLevel = useSettings((s) => s.settings.motion);
  const settingsLoaded = useSettings((s) => s.loaded);
  const introEnabled = useSettings((s) => s.settings.introAnimation);
  const route = useUI((s) => s.route);

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
      // Netzwerk und Boost dürfen scheitern – die App bleibt bedienbar
      await useNet.getState().init().catch((e) => console.warn("Netzwerk-Start:", e));
      await useBoost.getState().init().catch((e) => console.warn("Boost-Start:", e));
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
  useLiveStats(ready);
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
        <CommandPalette />
        <ScanWizard />
        <ManualAdd />
        <DropZone />
        <ConfirmDialog />
        <LaunchRitual />
        <Toasts />
        <ContextMenuHost />
        {showIntro && settingsLoaded && introEnabled && <Intro ready={ready} onLeave={onIntroLeave} onDone={onIntroDone} />}
        {showIntro && !settingsLoaded && <div className="fixed inset-0" style={{ background: "var(--nv-bg)", zIndex: "var(--nv-z-intro)" }} />}
      </LayoutGroup>
    </MotionConfig>
  );
}
