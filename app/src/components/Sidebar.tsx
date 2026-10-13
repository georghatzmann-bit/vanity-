import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Activity, ChevronsLeft, ChevronsRight, FileBarChart2, Gauge, LayoutGrid, Play, Settings, SlidersHorizontal, Zap } from "lucide-react";
import { imgSrc } from "@/lib/api";
import { gradeColor } from "@/lib/grade";
import { useLanguage, useT } from "@/lib/i18n";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useUI, type Page } from "@/store/ui";
import { GenIcon } from "./GenCover";
import { Tooltip } from "./ui/Tooltip";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

const NAV: { page: Page; icon: typeof Gauge; key: string }[] = [
  { page: "cockpit", icon: Gauge, key: "nav.cockpit" },
  { page: "games", icon: LayoutGrid, key: "nav.games" },
  { page: "network", icon: Activity, key: "nav.network" },
  { page: "optimize", icon: SlidersHorizontal, key: "nav.optimize" },
  { page: "reports", icon: FileBarChart2, key: "nav.reports" },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("pulsar-sidebar-collapsed") === "1";
  } catch {
    return false;
  }
}

/** Seitenleiste mit gleitender Markierung, Live-Ping und Boost-Knopf */
export function Sidebar() {
  const t = useT();
  const lang = useLanguage();
  const route = useUI((s) => s.route);
  const navigate = useUI((s) => s.navigate);
  const games = useLibrary((s) => s.games);
  const count = useMemo(() => games.filter((g) => !g.hidden).length, [games]);
  const playStats = useLibrary((s) => s.stats);
  const running = useLibrary((s) => s.running);
  // Zuletzt gespielt (wie die Sammlungen in NOVA): die drei letzten Spiele mit Icon
  const recent = useMemo(
    () => games.filter((g) => !g.hidden && g.kind === "game" && playStats.get(g.id)?.lastPlayedAt).sort((a, b) => (playStats.get(b.id)?.lastPlayedAt ?? 0) - (playStats.get(a.id)?.lastPlayedAt ?? 0)).slice(0, 3),
    [games, playStats],
  );
  const reports = useBoost((s) => s.reports.length);
  const boostActive = useBoost((s) => s.state.active);
  const toggleBoost = useBoost((s) => s.toggle);
  const last = useNet((s) => s.stats?.last ?? null);
  const grade = useNet((s) => s.grade);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = () => {
    const c = !collapsed;
    setCollapsed(c);
    sound.play("click");
    try {
      localStorage.setItem("pulsar-sidebar-collapsed", c ? "1" : "0");
    } catch {
      /* egal */
    }
  };

  const badges: Partial<Record<Page, number>> = { games: count, reports };
  const isActive = (p: Page) => route.page === p || (p === "games" && route.page === "game");

  return (
    <motion.aside animate={{ width: collapsed ? 76 : 232 }} transition={spring.gentle} className="relative flex h-full shrink-0 flex-col overflow-hidden px-3 pt-2 pb-4" style={{ zIndex: "var(--nv-z-content)" }}>
      <nav className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active = isActive(item.page);
          const btn = (
            <button
              key={item.page}
              type="button"
              onMouseEnter={() => sound.play("hover")}
              onClick={() => navigate({ page: item.page })}
              className={cn("relative flex h-11 w-full items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors duration-200", active ? "text-fg" : "text-muted hover:text-fg-soft", collapsed && "justify-center px-0")}
              aria-current={active ? "page" : undefined}
            >
              {active && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-surface-2 shadow-[inset_0_0_0_1px_var(--nv-border)]" transition={spring.snappy} />}
              {active && <motion.span layoutId="nav-bar" className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-gradient-accent shadow-[0_0_12px_var(--nv-accent)]" transition={spring.snappy} />}
              <item.icon className={cn("relative h-[18px] w-[18px] shrink-0 transition-transform", active && "text-accent", !collapsed && "group-hover:scale-110")} />
              {!collapsed && (
                <span className="relative flex flex-1 items-center justify-between">
                  {t(item.key)}
                  {badges[item.page] ? <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-muted tabular">{badges[item.page]}</span> : null}
                </span>
              )}
            </button>
          );
          return collapsed ? (
            <Tooltip key={item.page} label={t(item.key)} side="right">
              {btn}
            </Tooltip>
          ) : (
            btn
          );
        })}
      </nav>

      {/* Live-Ping */}
      <button type="button" onClick={() => navigate({ page: "cockpit" })} className={cn("mt-4 flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5 text-left transition hover:bg-surface-2", collapsed && "justify-center px-0")} title={t("cockpit.ping")}>
        <span className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full font-display text-[12px] font-bold tabular" style={{ color: gradeColor(grade), boxShadow: `inset 0 0 0 2px ${gradeColor(grade)}` }}>
          {grade ?? "–"}
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block font-display text-lg leading-tight font-bold text-fg tabular">{last === null ? "–" : `${Math.round(last)} ms`}</span>
            <span className="block text-[11px] text-muted">{t("cockpit.live")}</span>
          </span>
        )}
      </button>

      {recent.length > 0 && (
        <div className="mt-5 flex flex-col gap-0.5">
          {!collapsed && <div className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.16em] text-faint uppercase">{t("games.recent")}</div>}
          {recent.map((g) => {
            const isRunning = running.has(g.id);
            const icon = g.images.icon ? (
              <img src={imgSrc(g.images.icon)} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : g.images.cover ? (
              <img src={imgSrc(g.images.cover)} alt="" className="h-full w-full object-cover object-top" draggable={false} />
            ) : (
              <GenIcon name={g.name} />
            );
            const row = (
              <div key={g.id} className={cn("group relative flex h-10 items-center gap-3 rounded-lg px-2 transition hover:bg-surface-2", collapsed && "justify-center px-0")}>
                <button type="button" onMouseEnter={() => sound.play("hover")} onClick={() => navigate({ page: "game", id: g.id })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <span className={cn("relative h-7 w-7 shrink-0 overflow-hidden rounded-md ring-1 ring-white/10", isRunning && "ring-2 ring-success")}>{icon}</span>
                  {!collapsed && <span className="truncate text-[13px] text-fg-soft group-hover:text-fg">{g.name}</span>}
                </button>
                {!collapsed && (
                  <button type="button" onClick={() => void useLibrary.getState().launch(g, { boost: true })} className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-accent text-accent-fg opacity-0 shadow-glow transition group-hover:opacity-100" aria-label={t("games.boostAndPlay")} title={t("games.boostAndPlay")}>
                    <Play className="ml-0.5 h-3 w-3" fill="currentColor" />
                  </button>
                )}
              </div>
            );
            return collapsed ? (
              <Tooltip key={g.id} label={g.name} side="right">
                {row}
              </Tooltip>
            ) : (
              row
            );
          })}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-1">
        <motion.button
          type="button"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onMouseEnter={() => sound.play("hover")}
          onClick={() => void toggleBoost()}
          className={cn("relative flex h-12 items-center gap-3 overflow-hidden rounded-xl px-3 text-left text-[13px] font-semibold transition", boostActive ? "bg-gradient-accent text-accent-fg shadow-glow" : "bg-surface text-fg hover:bg-surface-2", collapsed && "justify-center px-0")}
        >
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", boostActive ? "bg-black/15" : "bg-gradient-accent text-accent-fg shadow-glow")}>
            <Zap className="h-4 w-4" fill={boostActive ? "currentColor" : "none"} />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate">{boostActive ? t("cockpit.boostActive") : t("cockpit.boost")}</span>
              <span className={cn("block text-[11px] font-normal", boostActive ? "text-accent-fg/80" : "text-muted")}>{lang === "de" ? "Strg" : "Ctrl"} + B</span>
            </span>
          )}
        </motion.button>
        <button type="button" onMouseEnter={() => sound.play("hover")} onClick={() => navigate({ page: "settings" })} className={cn("relative flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors", route.page === "settings" ? "bg-surface-2 text-fg" : "text-muted hover:text-fg-soft", collapsed && "justify-center px-0")}>
          <Settings className={cn("h-[18px] w-[18px]", route.page === "settings" && "text-accent")} />
          {!collapsed && t("nav.settings")}
        </button>
        <button type="button" onClick={toggle} className="mt-1 flex h-8 items-center justify-center rounded-md text-faint transition hover:bg-surface-2 hover:text-muted" aria-label={collapsed ? "Ausklappen" : "Einklappen"}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        </button>
      </div>
    </motion.aside>
  );
}
