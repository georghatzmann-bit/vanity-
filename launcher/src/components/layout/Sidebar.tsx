import { motion } from "motion/react";
import {
  Bug,
  Gamepad2,
  Info,
  Library,
  type LucideIcon,
  PanelsTopLeft,
  ScrollText,
  Settings,
  Swords,
  UserRound,
  Users,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusPill, statusLabel } from "@/components/common";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useApp, type PageId, type ServiceStatus } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LogoMark } from "./Logo";

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

const groups: { title: string; items: NavItem[] }[] = [
  {
    title: "Spielen",
    items: [
      { id: "start", label: "Start", icon: Gamepad2 },
      { id: "library", label: "Bibliothek", icon: Library },
      { id: "servers", label: "Server & Freunde", icon: Users },
    ],
  },
  {
    title: "Host",
    items: [{ id: "match", label: "Match-Steuerung", icon: Swords }],
  },
  {
    title: "Anpassen",
    items: [
      { id: "ingame", label: "Ingame-Menü", icon: PanelsTopLeft },
      { id: "profiles", label: "Profile", icon: UserRound },
    ],
  },
  {
    title: "Hilfe",
    items: [
      { id: "logs", label: "Live-Log", icon: ScrollText },
      { id: "crashes", label: "Absturz-Analyse", icon: Bug },
    ],
  },
];

const footerItems: NavItem[] = [
  { id: "settings", label: "Einstellungen", icon: Settings },
  { id: "about", label: "Über & Credits", icon: Info },
];

export function Sidebar() {
  const wide = useMediaQuery("(min-width: 1200px)");
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const services = useApp((s) => s.services);

  const renderItem = (item: NavItem) => (
    <NavButton
      key={item.id}
      item={item}
      active={page === item.id}
      wide={wide}
      onSelect={() => setPage(item.id)}
    />
  );

  return (
    <aside
      className={cn(
        "glass-strong relative z-10 m-2 mt-0 flex shrink-0 flex-col rounded-xl py-4 transition-[width] duration-200",
        wide ? "w-60 px-3" : "w-[72px] px-2",
      )}
    >
      <div className={cn("flex items-center gap-3 pb-5", wide ? "px-2" : "justify-center")}>
        <LogoMark className="size-9" />
        {wide && (
          <div>
            <p className="text-sm font-semibold tracking-wide">VANITY</p>
            <p className="text-xs text-muted-foreground">OG-Launcher</p>
          </div>
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" aria-label="Hauptmenü">
        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            {wide ? (
              <p className="px-3 pb-1 text-xs text-muted-foreground">{group.title}</p>
            ) : (
              <div className="mx-auto mb-1 h-px w-6 bg-white/[0.06]" />
            )}
            {group.items.map(renderItem)}
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-1 pt-4">
        <ServiceSummary services={services} wide={wide} />
        {footerItems.map(renderItem)}
      </div>
    </aside>
  );
}

function NavButton({
  item,
  active,
  wide,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  wide: boolean;
  onSelect: () => void;
}) {
  const Icon = item.icon;
  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-9 shrink-0 items-center gap-3 rounded-lg text-sm transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        wide ? "px-3" : "justify-center",
        active ? "text-foreground" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-lg bg-white/[0.07]"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        >
          <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-primary-text" />
        </motion.span>
      )}
      <Icon className={cn("relative size-[18px]", active && "text-primary-text")} />
      {wide && <span className="relative truncate">{item.label}</span>}
    </button>
  );

  if (wide) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

type Services = { backend: ServiceStatus; server: ServiceStatus; game: ServiceStatus };

/** Eine Zeile für alle drei Dienste – Details im Tooltip. */
function ServiceSummary({ services, wide }: { services: Services; wide: boolean }) {
  const all = [services.backend, services.server, services.game];
  const summary: ServiceStatus = all.includes("error")
    ? "error"
    : all.every((s) => s === "running")
      ? "running"
      : all.some((s) => s !== "stopped")
        ? "starting"
        : "stopped";
  const text = {
    stopped: "Alles gestoppt",
    starting: "Startet …",
    running: "Alles läuft",
    error: "Fehler",
  }[summary];
  const details = (
    <div className="flex flex-col gap-1.5 py-0.5">
      {(
        [
          ["Backend", services.backend],
          ["Game Server", services.server],
          ["Spiel", services.game],
        ] as const
      ).map(([label, status]) => (
        <div key={label} className="flex items-center justify-between gap-4">
          <span>{label}</span>
          <span>{statusLabel(status)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          aria-label={`Dienste: ${text}`}
          className={cn(
            "mb-2 flex h-9 items-center rounded-lg bg-white/[0.03] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            wide ? "justify-between px-3" : "justify-center",
          )}
        >
          {wide && <span className="text-xs text-muted-foreground">Dienste</span>}
          <StatusPill status={summary} label={wide ? text : ""} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{details}</TooltipContent>
    </Tooltip>
  );
}
