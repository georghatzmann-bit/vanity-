import { LayoutGroup, motion } from "motion/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusPill, statusLabel } from "@/components/common";
import { DownloadPill } from "@/components/download/DownloadPill";
import { Sheen } from "@/components/fx";
import { useMediaQuery } from "@/hooks/use-media-query";
import { SPRING_PLAYFUL, SPRING_UI } from "@/lib/motion";
import { useApp, type ServiceStatus } from "@/lib/store";
import { cn } from "@/lib/utils";
import { LogoMark, Wordmark } from "./Logo";
import { navFooter, navGroups, navParent, type NavItem } from "./nav";

export function Sidebar() {
  const wide = useMediaQuery("(min-width: 1200px)");
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const services = useApp((s) => s.services);
  const version = useApp((s) => s.appVersion);

  const renderItem = (item: NavItem) => (
    <NavButton key={item.id} item={item} active={navParent(page) === item.id} wide={wide} onSelect={() => setPage(item.id)} />
  );

  return (
    <aside
      className={cn(
        "glass-strong relative z-10 m-2 mt-0 flex shrink-0 flex-col rounded-2xl py-4 transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
        wide ? "w-60 px-3" : "w-[72px] px-2",
      )}
    >
      {/* Soft brand light behind the logo */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 rounded-t-2xl bg-[radial-gradient(120%_80%_at_20%_0%,rgb(122_60_255/0.16),transparent_70%)]"
      />

      <button
        type="button"
        onClick={() => setPage("start")}
        aria-label="Niobium – Home"
        className={cn(
          "group relative flex items-center gap-3 rounded-xl pb-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          wide ? "px-2" : "justify-center",
        )}
      >
        <motion.span
          whileHover={{ scale: 1.06, rotate: -3 }}
          whileTap={{ scale: 0.95 }}
          transition={SPRING_PLAYFUL}
          className="relative overflow-hidden rounded-[10px]"
        >
          <LogoMark className="size-9" />
          <Sheen once />
        </motion.span>
        {wide && (
          <span className="flex min-w-0 flex-col items-start gap-1">
            <Wordmark height={17} title="" className="text-foreground" />
            <span className="text-[11px] leading-none text-muted-foreground">old seasons, new shine.</span>
          </span>
        )}
      </button>

      <LayoutGroup id="sidebar">
        <nav className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto" aria-label="Main menu">
          {navGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5">
              {wide ? (
                <p className="px-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">{group.title}</p>
              ) : (
                <div className="mx-auto mb-1.5 h-px w-6 bg-white/[0.07]" />
              )}
              {group.items.map(renderItem)}
            </div>
          ))}
        </nav>

        <div className="relative flex flex-col gap-0.5 pt-4">
          <DownloadPill wide={wide} />
          <ServiceSummary services={services} wide={wide} />
          {navFooter.map(renderItem)}
          {wide && <p className="px-3 pt-2 text-[10.5px] text-faint tabular-nums">Version {version}</p>}
        </div>
      </LayoutGroup>
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
        "group relative flex h-9 shrink-0 cursor-pointer items-center gap-3 rounded-lg text-[13.5px] transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        wide ? "px-3" : "justify-center",
        active ? "text-foreground" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-lg bg-gradient-to-r from-brand-violet/[0.2] via-brand-indigo/[0.08] to-transparent shadow-[inset_0_0_0_1px_rgb(180_155_255/0.14),0_8px_24px_-14px_rgb(122_60_255/0.8)]"
          transition={SPRING_UI}
        >
          <span className="absolute top-2 bottom-2 -left-px w-[3px] rounded-full bg-gradient-to-b from-brand-blue to-brand-violet shadow-[0_0_10px_rgb(122_60_255/0.9)]" />
        </motion.span>
      )}
      <Icon
        className={cn(
          "relative size-[18px] transition-[color,scale] duration-200 group-hover:scale-110",
          active && "text-violet-text drop-shadow-[0_0_6px_rgb(122_60_255/0.7)]",
        )}
      />
      {wide && <span className="relative truncate font-medium">{item.label}</span>}
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

/** One line for all three services – details in the tooltip. */
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
    stopped: "All stopped",
    starting: "Starting…",
    running: "All running",
    error: "Error",
  }[summary];
  const details = (
    <div className="flex flex-col gap-1.5 py-0.5">
      {(
        [
          ["Backend", services.backend],
          ["Game server", services.server],
          ["Your game", services.game],
        ] as const
      ).map(([label, status]) => (
        <div key={label} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{label}</span>
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
          aria-label={`Services: ${text}`}
          className={cn(
            "mb-2 flex h-9 items-center rounded-lg bg-black/20 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            wide ? "justify-between px-3" : "justify-center",
          )}
        >
          {wide && <span className="text-xs text-muted-foreground">Services</span>}
          <StatusPill status={summary} label={wide ? text : ""} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{details}</TooltipContent>
    </Tooltip>
  );
}
