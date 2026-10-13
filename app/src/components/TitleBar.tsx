import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Download, Search, Volume2, VolumeX } from "lucide-react";
import { formatClock } from "@/lib/format";
import { useLanguage, useT } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { Kbd } from "@shared/ui/Kbd";
import { PulsarLogo } from "@shared/ui/PulsarLogo";
import { WindowControls } from "@shared/ui/WindowControls";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

function RunningPill() {
  const t = useT();
  const running = useLibrary((s) => s.running);
  const games = useLibrary((s) => s.games);
  const now = useNow(1000, running.size > 0);
  const first = [...running.values()][0];
  const game = first ? games.find((g) => g.id === first.gameId) : undefined;
  return (
    <AnimatePresence>
      {first && game && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.8, width: 0 }}
          animate={{ opacity: 1, scale: 1, width: "auto" }}
          exit={{ opacity: 0, scale: 0.8, width: 0 }}
          transition={spring.gentle}
          onClick={() => useUI.getState().navigate({ page: "game", id: game.id })}
          className="no-drag flex h-8 items-center gap-2 overflow-hidden rounded-full border border-success/30 bg-success/10 pr-3 pl-2.5 text-[12px] font-medium whitespace-nowrap text-fg"
          title={t("common.running")}
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          <span className="max-w-40 truncate">{game.name}</span>
          <span className="tabular text-muted">{formatClock((now - first.startedAt) / 1000)}</span>
          {running.size > 1 && <span className="text-muted">+{running.size - 1}</span>}
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** Eigene, rahmenlose Titelleiste: ziehbar, mit Suche, laufendem Spiel und Fenster-Knöpfen */
export function TitleBar() {
  const t = useT();
  const canBack = useUI((s) => s.history.length > 0);
  const soundOn = useSettings((s) => s.settings.sound);
  const update = useUpdate((s) => s.info);
  const logoDocked = useUI((s) => s.logoDocked);
  const lang = useLanguage();

  return (
    <header data-tauri-drag-region className="relative flex h-12 items-center gap-3 pl-4" style={{ zIndex: "var(--nv-z-titlebar)" }}>
      <div className="no-drag flex items-center gap-2.5">
        {logoDocked ? (
          <motion.div layoutId="pulsar-logo" transition={{ type: "spring", stiffness: 110, damping: 18 }}>
            <PulsarLogo size={24} mode="static" />
          </motion.div>
        ) : (
          <div style={{ width: 24, height: 24 }} />
        )}
        <motion.span data-tauri-drag-region className="font-display text-[15px] font-bold tracking-[0.18em] text-fg" initial={false} animate={{ opacity: logoDocked ? 1 : 0, x: logoDocked ? 0 : -6 }} transition={{ delay: 0.25 }}>
          PULSAR
        </motion.span>
      </div>

      <AnimatePresence>
        {canBack && (
          <motion.button type="button" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} onClick={() => useUI.getState().back()} className="no-drag ml-2 grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-surface-2 hover:text-fg" aria-label={t("common.back")}>
            <ArrowLeft className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>

      <div data-tauri-drag-region className="flex flex-1 justify-center">
        <button
          type="button"
          onMouseEnter={() => sound.play("hover")}
          onClick={() => {
            sound.play("open");
            useUI.getState().setPalette(true);
          }}
          className="no-drag group flex h-9 w-full max-w-[460px] items-center gap-2.5 rounded-full border border-line bg-surface px-4 text-[13px] text-muted transition hover:border-line-strong hover:bg-surface-2 hover:text-fg-soft"
        >
          <Search className="h-4 w-4 transition-transform group-hover:scale-110" />
          <span className="flex-1 text-left">{t("nav.search")}</span>
          <Kbd>{lang === "de" ? "Strg" : "Ctrl"}</Kbd>
          <Kbd>K</Kbd>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <RunningPill />
        {update?.available && (
          <motion.button type="button" initial={{ scale: 0 }} animate={{ scale: 1 }} onClick={() => useUI.getState().navigate({ page: "settings", section: "about" })} className="no-drag flex h-8 items-center gap-1.5 rounded-full bg-gradient-accent px-3 text-[12px] font-semibold text-accent-fg shadow-glow">
            <Download className="h-3.5 w-3.5" /> {update.latest}
          </motion.button>
        )}
        <button
          type="button"
          onClick={() => {
            const on = !useSettings.getState().settings.sound;
            useSettings.getState().update({ sound: on });
            if (on) sound.play("toggleOn");
          }}
          className={cn("no-drag grid h-8 w-8 place-items-center rounded-md transition hover:bg-surface-2", soundOn ? "text-muted hover:text-fg" : "text-faint")}
          aria-label={t("settings.soundOn")}
          title={t("settings.soundOn")}
        >
          {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </button>
      </div>
      <WindowControls className="ml-1" />
    </header>
  );
}
