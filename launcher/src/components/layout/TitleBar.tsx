import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { closeWindow, minimizeWindow, toggleMaximizeWindow, watchMaximized } from "@/lib/window";

/**
 * Eigene Titelleiste (das Fenster hat keinen Windows-Rahmen).
 * Ziehen verschiebt das Fenster, Doppelklick maximiert.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => watchMaximized(setMaximized), []);

  return (
    <header
      data-tauri-drag-region
      className="relative z-20 flex h-10 shrink-0 items-center justify-between pl-4"
    >
      <div data-tauri-drag-region className="flex items-center gap-3 text-xs text-muted-foreground">
        <span data-tauri-drag-region className="font-medium text-foreground/80">
          Vanity
        </span>
        <span
          data-tauri-drag-region
          className="rounded-md bg-primary/15 px-2 py-0.5 font-medium text-primary-text"
        >
          Phase 1 · Design-Vorschau
        </span>
        <span data-tauri-drag-region className="hidden md:inline">
          Knöpfe zeigen nur, wie es später aussieht.
        </span>
      </div>

      <div className="flex h-full">
        <WindowButton label="Minimieren" onClick={minimizeWindow}>
          <Minus className="size-4" />
        </WindowButton>
        <WindowButton
          label={maximized ? "Wiederherstellen" : "Maximieren"}
          onClick={toggleMaximizeWindow}
        >
          {maximized ? <Copy className="size-3.5 -scale-x-100" /> : <Square className="size-3.5" />}
        </WindowButton>
        <WindowButton label="Schließen" onClick={closeWindow} danger>
          <X className="size-4" />
        </WindowButton>
      </div>
    </header>
  );
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
