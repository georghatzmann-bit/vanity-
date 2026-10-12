import { useState } from "react";
import { motion } from "motion/react";
import { BarChart3, ChevronsLeft, ChevronsRight, Dices, FolderHeart, Gift, Home, LayoutGrid, Settings, Sparkles, Trophy, Tv } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useLibrary } from "@/store/library";
import { useUI, type Page } from "@/store/ui";
import { Icon } from "./ui/icons";
import { Tooltip } from "./ui/Tooltip";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

const NAV: { page: Page; icon: typeof Home; key: string }[] = [
  { page: "home", icon: Home, key: "nav.home" },
  { page: "library", icon: LayoutGrid, key: "nav.library" },
  { page: "collections", icon: FolderHeart, key: "nav.collections" },
  { page: "stats", icon: BarChart3, key: "nav.stats" },
  { page: "achievements", icon: Trophy, key: "nav.achievements" },
  { page: "wishlist", icon: Gift, key: "nav.wishlist" },
  { page: "cleanup", icon: Sparkles, key: "nav.cleanup" },
];

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("nova-sidebar-collapsed") === "1";
  } catch {
    return false;
  }
}

/** Seitenleiste mit gleitender Markierung für die aktive Seite */
export function Sidebar() {
  const t = useT();
  const route = useUI((s) => s.route);
  const navigate = useUI((s) => s.navigate);
  const count = useLibrary((s) => s.games.filter((g) => !g.hidden).length);
  const collections = useLibrary((s) => s.collections);
  const unlocked = useLibrary((s) => s.unlocked.length);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggle = () => {
    const c = !collapsed;
    setCollapsed(c);
    sound.play("click");
    try {
      localStorage.setItem("nova-sidebar-collapsed", c ? "1" : "0");
    } catch {
      /* egal */
    }
  };

  const item = (page: Page, IconC: typeof Home, label: string, badge?: number, onClick?: () => void, id?: string) => {
    const active = route.page === page && (id === undefined || route.id === id) && !(page === "collections" && id === undefined && route.id);
    const content = (
      <button
        type="button"
        onMouseEnter={() => sound.play("hover")}
        onClick={onClick ?? (() => navigate({ page, id }))}
        className={cn(
          "group relative flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors duration-200",
          active ? "text-fg" : "text-muted hover:bg-surface hover:text-fg",
          collapsed && "justify-center px-0",
        )}
      >
        {active && (
          <motion.span layoutId="nav-active" className="absolute inset-0 rounded-lg bg-surface-3 shadow-[inset_0_0_0_1px_var(--nv-border)]" transition={spring.snappy}>
            <span className="absolute top-1/2 -left-[13px] h-5 w-[3px] -translate-y-1/2 rounded-full bg-gradient-accent shadow-[0_0_12px_var(--nv-accent)]" />
          </motion.span>
        )}
        <IconC className={cn("relative h-[18px] w-[18px] shrink-0 transition-transform duration-300 group-hover:scale-110", active && "text-accent")} strokeWidth={active ? 2.2 : 1.8} />
        {!collapsed && <span className="relative flex-1 truncate text-left">{label}</span>}
        {!collapsed && badge !== undefined && badge > 0 && <span className="relative rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted tabular">{badge}</span>}
      </button>
    );
    return collapsed ? (
      <Tooltip label={label} side="right" className="w-full">
        {content}
      </Tooltip>
    ) : (
      content
    );
  };

  return (
    <motion.nav animate={{ width: collapsed ? 76 : 236 }} transition={spring.smooth} className="relative flex h-full shrink-0 flex-col gap-1 overflow-hidden px-3 pt-2 pb-4">
      <div className="flex flex-col gap-1">
        {NAV.map((n) => (
          <div key={n.page}>{item(n.page, n.icon, t(n.key), n.page === "library" ? count : n.page === "achievements" ? unlocked : undefined)}</div>
        ))}
      </div>

      {!collapsed && collections.length > 0 && (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <div className="px-3 pb-2 text-[11px] font-semibold tracking-[0.14em] text-faint uppercase">{t("nav.collections")}</div>
          {collections.slice(0, 8).map((c) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => sound.play("hover")}
              onClick={() => navigate({ page: "collections", id: c.id })}
              className={cn(
                "flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] transition",
                route.page === "collections" && route.id === c.id ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface hover:text-fg",
              )}
            >
              <span className="grid h-5 w-5 place-items-center rounded-md" style={{ background: `color-mix(in oklab, ${c.color} 22%, transparent)`, color: c.color }}>
                <Icon name={c.icon} className="h-3 w-3" strokeWidth={2.2} />
              </span>
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </div>
      )}
      {(collapsed || collections.length === 0) && <div className="flex-1" />}

      <div className="flex flex-col gap-1 pt-3">
        {collapsed ? (
          <Tooltip label={t("nav.dice")} side="right" className="w-full">
            <button type="button" onClick={() => useUI.getState().setDice(true)} className="mx-auto grid h-10 w-10 place-items-center rounded-lg bg-gradient-accent text-white shadow-glow">
              <Dices className="h-5 w-5" />
            </button>
          </Tooltip>
        ) : (
          <motion.button
            type="button"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.97 }}
            onMouseEnter={() => sound.play("hover")}
            onClick={() => {
              sound.play("open");
              useUI.getState().setDice(true);
            }}
            className="group relative mb-2 flex items-center gap-3 overflow-hidden rounded-xl border border-line p-3 text-left"
            style={{ background: "var(--nv-gradient-soft)" }}
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-accent text-white shadow-glow transition-transform duration-500 group-hover:rotate-[20deg]">
              <Dices className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-fg">{t("nav.dice")}</span>
              <span className="block text-[11px] text-muted">Strg + D</span>
            </span>
          </motion.button>
        )}
        {item("home", Tv, t("nav.bigPicture"), undefined, () => useUI.getState().setBigPicture(true), "__bp")}
        {item("settings", Settings, t("nav.settings"))}
        <button type="button" onClick={toggle} className={cn("mt-1 flex h-8 items-center gap-2 rounded-md px-3 text-[12px] text-faint transition hover:text-muted", collapsed && "justify-center px-0")} aria-label="Seitenleiste umschalten">
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        </button>
      </div>
    </motion.nav>
  );
}
