import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Activity, CalendarDays, CornerDownLeft, FileBarChart2, FolderSearch, Gauge, Globe, LayoutGrid, Palette, Play, Plus, RefreshCw, ScrollText, Search, Settings, SlidersHorizontal, Sparkles, Square, Stethoscope, Volume2, Wand2, WifiCog, Zap, Eraser } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { useLanguage, useT } from "@/lib/i18n";
import { fuzzyScore } from "@/lib/search";
import { THEMES, transitionTheme } from "@/lib/theme";
import type { Game } from "@/lib/types";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { toast, useUI, type Page } from "@/store/ui";
import { useUpdate } from "@/store/update";
import { GameCover } from "./GameCover";
import { Kbd } from "@shared/ui/Kbd";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

interface Item {
  id: string;
  group: "games" | "actions" | "pages";
  label: string;
  sub?: string;
  icon: ReactNode;
  game?: Game;
  run: (shift?: boolean) => void;
  score: number;
}

/** Befehlspalette (Strg+K): alles per Tastatur finden und starten */
export function CommandPalette() {
  const t = useT();
  const lang = useLanguage();
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPalette);
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  const boostActive = useBoost((s) => s.state.active);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const close = () => {
    sound.play("close");
    setOpen(false);
  };

  const items = useMemo<Item[]>(() => {
    const nav = (page: Page, section?: string) => () => useUI.getState().navigate({ page, section });
    const pages: Omit<Item, "score">[] = [
      { id: "p-cockpit", group: "pages", label: t("nav.cockpit"), icon: <Gauge className="h-4 w-4" />, run: nav("cockpit") },
      { id: "p-games", group: "pages", label: t("nav.games"), icon: <LayoutGrid className="h-4 w-4" />, run: nav("games") },
      { id: "p-net", group: "pages", label: t("nav.network"), icon: <Activity className="h-4 w-4" />, run: nav("network") },
      { id: "p-opt", group: "pages", label: t("nav.optimize"), icon: <SlidersHorizontal className="h-4 w-4" />, run: nav("optimize") },
      { id: "p-rep", group: "pages", label: t("nav.reports"), icon: <FileBarChart2 className="h-4 w-4" />, run: nav("reports") },
      { id: "p-set", group: "pages", label: t("nav.settings"), icon: <Settings className="h-4 w-4" />, run: nav("settings") },
    ];
    const s = useSettings.getState();
    const actions: Omit<Item, "score">[] = [
      { id: "a-boost", group: "actions", label: boostActive ? t("palette.boostStop") : t("palette.boost"), icon: <Zap className="h-4 w-4" />, run: () => void useBoost.getState().toggle() },
      { id: "a-netauto", group: "actions", label: t("palette.netAuto"), sub: t("palette.netAutoSub"), icon: <Sparkles className="h-4 w-4" />, run: nav("optimize", "auto") },
      { id: "a-speed", group: "actions", label: t("palette.speedtest"), icon: <Gauge className="h-4 w-4" />, run: nav("network", "speed") },
      { id: "a-regions", group: "actions", label: t("palette.regions"), icon: <Globe className="h-4 w-4" />, run: nav("network", "regions") },
      { id: "a-diagnose", group: "actions", label: t("palette.diagnose"), sub: t("palette.diagnoseSub"), icon: <Stethoscope className="h-4 w-4" />, run: nav("network", "diagnose") },
      { id: "a-wifiscan", group: "actions", label: t("palette.wifiScan"), icon: <WifiCog className="h-4 w-4" />, run: nav("network", "wifi") },
      { id: "a-isplog", group: "actions", label: t("palette.ispLog"), icon: <ScrollText className="h-4 w-4" />, run: nav("reports", "isp") },
      { id: "a-calendar", group: "actions", label: t("palette.calendar"), icon: <CalendarDays className="h-4 w-4" />, run: nav("reports", "calendar") },
      { id: "a-scan", group: "actions", label: t("palette.scan"), icon: <FolderSearch className="h-4 w-4" />, run: () => useUI.getState().setScan(true) },
      { id: "a-add", group: "actions", label: t("palette.addManual"), icon: <Plus className="h-4 w-4" />, run: () => useUI.getState().setManual(true) },
      { id: "a-ov", group: "actions", label: t("palette.overlay"), icon: <Wand2 className="h-4 w-4" />, run: () => void api.overlayToggle().catch(() => undefined) },
      { id: "a-flush", group: "actions", label: t("palette.flushDns"), icon: <Eraser className="h-4 w-4" />, run: () => void api.flushDns().then(() => toast({ kind: "success", title: t("optimize.flushed") })).catch((e) => toast({ kind: "error", title: String(e) })) },
      { id: "a-sound", group: "actions", label: t("palette.toggleSound"), icon: <Volume2 className="h-4 w-4" />, run: () => s.update({ sound: !s.settings.sound }) },
      { id: "a-motion", group: "actions", label: t("palette.toggleMotion"), icon: <Zap className="h-4 w-4" />, run: () => s.update({ motion: s.settings.motion === "full" ? "off" : "full" }) },
      {
        id: "a-upd",
        group: "actions",
        label: t("palette.checkUpdate"),
        icon: <RefreshCw className="h-4 w-4" />,
        run: () =>
          void useUpdate
            .getState()
            .check()
            .then((i) => i && toast({ kind: i.available ? "info" : "success", title: i.available ? t("settings.updateAvailable", { v: i.latest ?? "" }) : t("settings.upToDate") })),
      },
      ...THEMES.map((th) => ({
        id: `a-theme-${th}`,
        group: "actions" as const,
        label: t("palette.themeTo", { name: t(`settings.themes.${th}`) }),
        icon: <Palette className="h-4 w-4" />,
        run: () => transitionTheme(() => useSettings.getState().update({ theme: th })),
      })),
    ];
    const gameItems: Omit<Item, "score">[] = games
      .filter((g) => !g.hidden)
      .map((g) => ({
        id: g.id,
        group: "games",
        label: g.name,
        sub: running.has(g.id) ? t("common.running") : stats.get(g.id) ? formatDuration(stats.get(g.id)!.totalSeconds, { short: true }) : g.kind === "app" ? t("common.app") : t(`source.${g.source}`),
        icon: running.has(g.id) ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />,
        game: g,
        run: (shift) => {
          if (shift || running.has(g.id)) useUI.getState().navigate({ page: "game", id: g.id });
          else void useLibrary.getState().launch(g);
        },
      }));
    const all = [...gameItems, ...actions, ...pages];
    if (!q.trim()) {
      const recent = gameItems
        .filter((g) => stats.get(g.id))
        .sort((a, b) => (stats.get(b.id)?.lastPlayedAt ?? 0) - (stats.get(a.id)?.lastPlayedAt ?? 0))
        .slice(0, 5);
      return [...recent, ...actions.slice(0, 5), ...pages].map((x) => ({ ...x, score: 1 }));
    }
    return all
      .map((x) => ({ ...x, score: fuzzyScore(q, x.label) * (x.group === "games" ? 1.15 : 1) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, games, stats, running, lang, t, boostActive]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (it: Item, shift = false) => {
    sound.play("click");
    setOpen(false);
    window.setTimeout(() => it.run(shift), 60);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sound.play("tick");
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sound.play("tick");
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) run(it, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  const groups: { key: Item["group"]; label: string }[] = [
    { key: "games", label: t("palette.games") },
    { key: "actions", label: t("palette.actions") },
    { key: "pages", label: t("palette.pages") },
  ];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 flex justify-center pt-[12vh]" style={{ zIndex: "var(--nv-z-modal)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0 bg-[var(--nv-overlay)] backdrop-blur-sm" onClick={close} />
          <motion.div className="glass-strong relative flex h-fit max-h-[70vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl" initial={{ opacity: 0, y: -16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={spring.snappy}>
            <div className="flex items-center gap-3 border-b border-line px-5">
              <Search className="h-5 w-5 text-accent" />
              <input ref={inputRef} autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={t("palette.placeholder")} className="h-14 flex-1 bg-transparent text-[16px] text-fg outline-none placeholder:text-faint" spellCheck={false} />
              <Kbd>Esc</Kbd>
            </div>
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
              {items.length === 0 && <div className="px-4 py-10 text-center text-sm text-muted">{t("palette.empty")}</div>}
              {groups.map((g) => {
                const list = items.filter((i) => i.group === g.key);
                if (!list.length) return null;
                return (
                  <div key={g.key} className="mb-1">
                    <div className="px-3 pt-2 pb-1.5 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">{g.label}</div>
                    {list.map((it) => {
                      const myIdx = items.indexOf(it);
                      const active = myIdx === sel;
                      return (
                        <button key={it.id} type="button" data-idx={myIdx} onMouseMove={() => sel !== myIdx && setSel(myIdx)} onClick={(e) => run(it, e.shiftKey)} className={cn("relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors", active ? "text-fg" : "text-fg-soft")}>
                          {active && <motion.span layoutId="palette-sel" className="absolute inset-0 rounded-lg bg-surface-3 shadow-[inset_0_0_0_1px_var(--nv-border)]" transition={{ type: "spring", stiffness: 700, damping: 40 }} />}
                          {it.game ? (
                            <span className="relative h-10 w-7 shrink-0 overflow-hidden rounded-[5px]">
                              <GameCover game={it.game} />
                            </span>
                          ) : (
                            <span className={cn("relative grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2", active ? "text-accent" : "text-muted")}>{it.icon}</span>
                          )}
                          <span className="relative min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{it.label}</span>
                            {it.sub && <span className="block truncate text-[12px] text-muted">{it.sub}</span>}
                          </span>
                          {active && (
                            <span className="relative flex items-center gap-1 text-[11px] text-muted">
                              {it.game && (running.has(it.game.id) ? "" : t("common.start"))} <CornerDownLeft className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-line px-5 py-2.5 text-[11px] text-faint">{t("palette.hint")} · Shift+Enter {t("common.details")}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
