import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, Check, Search, Volume2, VolumeX, Download, UserPlus } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { useLanguage, useT } from "@/lib/i18n";
import type { ProfilesState } from "@/lib/types";
import { useNow } from "@/hooks/useNow";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { toast, useUI } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { Kbd } from "@shared/ui/Kbd";
import { NovaLogo } from "@shared/ui/NovaLogo";
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

function ProfileMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProfilesState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.profilesList().then(setState).catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const active = state?.profiles.find((p) => p.id === state.activeId);
  const switchTo = async (id: string) => {
    setOpen(false);
    if (id === state?.activeId) return;
    try {
      await api.profileSwitch(id);
      await useSettings.getState().load();
      await useLibrary.getState().reload();
      useUI.getState().navigate({ page: "home" });
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    }
  };

  return (
    <div ref={ref} className="no-drag relative">
      <button
        type="button"
        onMouseEnter={() => sound.play("hover")}
        onClick={() => {
          sound.play(open ? "close" : "open");
          setOpen(!open);
        }}
        className="grid h-8 w-8 place-items-center rounded-full text-[13px] font-bold text-white ring-2 ring-transparent transition hover:ring-line-strong"
        style={{ background: active?.color ?? "var(--nv-accent)" }}
        title={active?.name}
      >
        {active?.avatar || active?.name?.[0]?.toUpperCase() || "N"}
      </button>
      <AnimatePresence>
        {open && state && (
          <motion.div className="glass-strong absolute top-11 right-0 z-50 w-60 rounded-xl p-1.5" initial={{ opacity: 0, y: -6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4 }} transition={spring.snappy}>
            <div className="px-2.5 pt-1.5 pb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">{t("settings.profiles")}</div>
            {state.profiles.map((p) => (
              <button key={p.id} type="button" onMouseEnter={() => sound.play("hover")} onClick={() => void switchTo(p.id)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-fg-soft transition hover:bg-surface-3 hover:text-fg">
                <span className="grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold text-white" style={{ background: p.color }}>
                  {p.avatar || p.name[0]?.toUpperCase()}
                </span>
                <span className="flex-1 truncate">{p.name}</span>
                {p.id === state.activeId && <Check className="h-4 w-4 text-accent" />}
              </button>
            ))}
            <div className="my-1 h-px bg-line" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                useUI.getState().navigate({ page: "settings", section: "profiles" });
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-muted transition hover:bg-surface-3 hover:text-fg"
            >
              <UserPlus className="h-4 w-4" /> {t("settings.newProfile")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Eigene, rahmenlose Titelleiste: ziehbar, mit Suche, laufendem Spiel und Fenster-Knöpfen */
export function TitleBar() {
  const t = useT();
  const canBack = useUI((s) => s.history.length > 0);
  const muted = useSettings((s) => s.settings.soundMuted);
  const update = useUpdate((s) => s.info);
  const logoDocked = useUI((s) => s.logoDocked);
  const lang = useLanguage();

  return (
    <header data-tauri-drag-region className="relative flex h-12 items-center gap-3 pl-4" style={{ zIndex: "var(--nv-z-titlebar)" }}>
      <div className="no-drag flex items-center gap-2.5">
        {logoDocked ? (
          <motion.div layoutId="nova-logo" transition={{ type: "spring", stiffness: 110, damping: 18 }}>
            <NovaLogo size={24} mode="static" />
          </motion.div>
        ) : (
          <div style={{ width: 24, height: 24 }} />
        )}
        <motion.span data-tauri-drag-region className="font-display text-[15px] font-bold tracking-[0.18em] text-fg" initial={false} animate={{ opacity: logoDocked ? 1 : 0, x: logoDocked ? 0 : -6 }} transition={{ delay: 0.25 }}>
          NOVA
        </motion.span>
      </div>

      <AnimatePresence>
        {canBack && (
          <motion.button
            type="button"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -6 }}
            onClick={() => useUI.getState().back()}
            className="no-drag ml-2 grid h-8 w-8 place-items-center rounded-md text-muted transition hover:bg-surface-2 hover:text-fg"
            aria-label={t("common.back")}
          >
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
          <motion.button
            type="button"
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            onClick={() => useUI.getState().navigate({ page: "settings", section: "about" })}
            className="no-drag flex h-8 items-center gap-1.5 rounded-full bg-gradient-accent px-3 text-[12px] font-semibold text-white shadow-glow"
          >
            <Download className="h-3.5 w-3.5" /> {update.latest}
          </motion.button>
        )}
        <button
          type="button"
          onClick={() => {
            const m = !useSettings.getState().settings.soundMuted;
            useSettings.getState().update({ soundMuted: m });
            if (!m) sound.play("toggleOn");
          }}
          className={cn("no-drag grid h-8 w-8 place-items-center rounded-md transition hover:bg-surface-2", muted ? "text-faint" : "text-muted hover:text-fg")}
          aria-label={t("settings.mute")}
          title={t("settings.mute")}
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <ProfileMenu />
      </div>
      <WindowControls className="ml-1" />
    </header>
  );
}
