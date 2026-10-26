import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Copy, Minus, Square, X } from "lucide-react";
import { demoBusy } from "@/components/LaunchDemoDriver";
import { inTauri } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import { isStarting, launchSteps, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { closeWindow, minimizeWindow, toggleMaximizeWindow, watchMaximized } from "@/lib/window";
import { pageLabel } from "./nav";

/**
 * Own title bar (the window has no Windows frame).
 * Dragging moves the window, double-click maximizes. Shows where you are and whether something runs.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => watchMaximized(setMaximized), []);
  const page = useApp((s) => s.page);
  const services = useApp((s) => s.services);
  const launchStep = useApp((s) => s.launchStep);

  // Step 6 ("Lobby") = the start is done: then the badge says "Live"
  const launching = isStarting(launchStep);
  const live = services.game === "running" || services.server === "running";

  return (
    <header data-tauri-drag-region className="relative z-30 flex h-10 shrink-0 items-center justify-between pl-4">
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span data-tauri-drag-region className="font-medium text-foreground/70">
          Niobium
        </span>
        <ChevronRight data-tauri-drag-region className="size-3.5 text-faint" />
        <span data-tauri-drag-region className="relative inline-flex h-4 min-w-24 items-center overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={page}
              data-tauri-drag-region
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="whitespace-nowrap text-foreground/90"
            >
              {pageLabel(page)}
            </motion.span>
          </AnimatePresence>
        </span>

        <AnimatePresence>
          {(launching || live) && (
            <motion.span
              key="live"
              data-tauri-drag-region
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className={cn(
                "ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
                launching ? "bg-warning/10 text-warning ring-warning/25" : "bg-success/10 text-success ring-success/25",
              )}
            >
              <span className="relative flex size-1.5">
                <span className={cn("nb-loop absolute inset-0 animate-ping rounded-full opacity-70", launching ? "bg-warning" : "bg-success")} />
                <span className={cn("relative size-1.5 rounded-full", launching ? "bg-warning" : "bg-success")} />
              </span>
              {launching ? `Starting · ${launchSteps[launchStep].label}` : "Live"}
            </motion.span>
          )}
        </AnimatePresence>

        {!inTauri && (
          <span data-tauri-drag-region className="ml-2 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] text-faint ring-1 ring-white/[0.06] ring-inset">
            Browser preview
          </span>
        )}
      </div>

      <div className="flex h-full">
        <WindowButton label="Minimize" onClick={minimizeWindow}>
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton label={maximized ? "Restore" : "Maximize"} onClick={toggleMaximizeWindow}>
          {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
        </WindowButton>
        <WindowButton label="Close" onClick={inTauri ? closeWindow : previewClose} danger>
          <X className="size-4" />
        </WindowButton>
      </div>
    </header>
  );
}

/**
 * Browser preview stand-in for the close button. In the real launcher, Rust catches every close
 * (X, Alt+F4, taskbar) and asks first via "app:close-requested" when something still runs.
 */
function previewClose() {
  if (demoBusy()) {
    useApp.setState({ closeRequest: { running: previewRunning() } });
  }
}

/** Names of what runs in the preview, in the same words Rust uses. */
function previewRunning(): string[] {
  const { services, launchStep } = useApp.getState();
  const names: string[] = [];
  if (services.game !== "stopped") names.push("Your game");
  if (services.server !== "stopped") names.push("Game server");
  if (services.backend !== "stopped" || (launchStep >= 0 && names.length === 0)) names.push("Backend");
  return names;
}

function WindowButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-full w-12 items-center justify-center text-muted-foreground transition-colors duration-150 outline-none focus-visible:bg-white/10",
        danger ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-white/[0.08] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
