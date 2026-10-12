import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "../lib/cn";
import { isTauri } from "../lib/env";
import { sound } from "../sound/engine";

type WinAction = "minimize" | "maximize" | "close";

async function getWin() {
  if (!isTauri()) return null;
  const mod = await import("@tauri-apps/api/window");
  return mod.getCurrentWindow();
}

/** Fenster-Inhalt kurz ausblenden, bevor minimiert/geschlossen wird (wirkt wie eine native Animation) */
function playLeave(): Promise<void> {
  const root = document.documentElement;
  if (root.dataset.motion === "off") return Promise.resolve();
  root.classList.add("nv-window-leave");
  return new Promise((r) => window.setTimeout(r, 190));
}

function clearLeave() {
  document.documentElement.classList.remove("nv-window-leave");
}

export interface WindowControlsProps {
  className?: string;
  /** Maximieren-Knopf zeigen (Installer: nein) */
  maximizable?: boolean;
  /** Wird statt des normalen Schließens aufgerufen (z. B. "in den Tray") */
  onClose?: () => void;
}

/** Minimieren, Maximieren, Schließen – mit Animationen, passend zur rahmenlosen Titelleiste */
export function WindowControls({ className, maximizable = true, onClose }: WindowControlsProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void getWin().then(async (w) => {
      if (!w || !alive) return;
      setMaximized(await w.isMaximized().catch(() => false));
      unlisten = await w.onResized(async () => {
        setMaximized(await w.isMaximized().catch(() => false));
      });
      const unFocus = await w.onFocusChanged(({ payload }) => {
        if (payload) clearLeave();
      });
      const prev = unlisten;
      unlisten = () => {
        prev?.();
        unFocus();
      };
    });
    const onVis = () => !document.hidden && clearLeave();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      unlisten?.();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const act = async (a: WinAction) => {
    sound.play(a === "close" ? "close" : "click");
    const w = await getWin();
    if (a === "maximize") {
      await w?.toggleMaximize().catch(() => undefined);
      return;
    }
    if (a === "close" && onClose) {
      await playLeave();
      onClose();
      window.setTimeout(clearLeave, 400);
      return;
    }
    await playLeave();
    if (!w) {
      clearLeave();
      return;
    }
    if (a === "minimize") {
      await w.minimize().catch(() => undefined);
      window.setTimeout(clearLeave, 350);
    } else {
      await w.close().catch(() => undefined);
      // Falls das Backend das Schließen abfängt (Tray), Inhalt wieder zeigen
      window.setTimeout(clearLeave, 600);
    }
  };

  const btn = "no-drag group relative grid h-full w-[46px] place-items-center text-muted transition-colors duration-150 hover:text-fg";

  return (
    <div className={cn("flex h-full items-stretch", className)}>
      <button type="button" aria-label="Minimieren" className={cn(btn, "hover:bg-surface-2")} onClick={() => act("minimize")}>
        <motion.span whileHover={{ y: 2 }} transition={{ type: "spring", stiffness: 500, damping: 20 }}>
          <Minus className="h-4 w-4" strokeWidth={1.8} />
        </motion.span>
      </button>
      {maximizable && (
        <button type="button" aria-label="Maximieren" className={cn(btn, "hover:bg-surface-2")} onClick={() => act("maximize")}>
          <motion.span whileHover={{ scale: 1.15 }} transition={{ type: "spring", stiffness: 500, damping: 20 }}>
            {maximized ? <Copy className="h-[13px] w-[13px] -scale-x-100" strokeWidth={1.8} /> : <Square className="h-[12px] w-[12px]" strokeWidth={1.9} />}
          </motion.span>
        </button>
      )}
      <button type="button" aria-label="Schließen" className={cn(btn, "hover:bg-[#e81123] hover:text-white")} onClick={() => act("close")}>
        <motion.span whileHover={{ rotate: 90 }} transition={{ type: "spring", stiffness: 400, damping: 16 }}>
          <X className="h-4 w-4" strokeWidth={1.8} />
        </motion.span>
      </button>
    </div>
  );
}
