import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight } from "lucide-react";
import { create } from "zustand";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export interface MenuItem {
  label: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  hint?: ReactNode;
}

interface MenuState {
  items: MenuItem[] | null;
  x: number;
  y: number;
  open: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useContextMenu = create<MenuState>((set) => ({
  items: null,
  x: 0,
  y: 0,
  open: (x, y, items) => {
    sound.play("open", { gain: 0.6 });
    set({ items, x, y });
  },
  close: () => set({ items: null }),
}));

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <div key={i} className="relative" onMouseEnter={() => setSub(it.submenu ? i : null)}>
            <button
              type="button"
              disabled={it.disabled}
              onMouseEnter={() => sound.play("hover")}
              onClick={() => {
                if (it.submenu) return;
                sound.play("click");
                onDone();
                it.onClick?.();
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition disabled:opacity-40",
                it.danger ? "text-danger hover:bg-danger/12" : "text-fg-soft hover:bg-surface-3 hover:text-fg",
              )}
            >
              <span className="grid h-4 w-4 place-items-center opacity-80">{it.icon}</span>
              <span className="flex-1 whitespace-nowrap">{it.label}</span>
              {it.checked && <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--nv-accent)]" />}
              {it.hint && <span className="text-[11px] text-faint">{it.hint}</span>}
              {it.submenu && <ChevronRight className="h-3.5 w-3.5 text-muted" />}
            </button>
            {it.submenu && sub === i && (
              <motion.div className="glass-strong absolute top-0 left-full ml-1 min-w-48 rounded-lg p-1" initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={spring.snappy}>
                <MenuList items={it.submenu} onDone={onDone} />
              </motion.div>
            )}
          </div>
        ),
      )}
    </>
  );
}

/** Rechtsklick-Menü (eine Instanz in der App) */
export function ContextMenuHost() {
  const { items, x, y, close } = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (!items || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [items, x, y]);

  useEffect(() => {
    if (!items) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [items, close]);

  return createPortal(
    <AnimatePresence>
      {items && (
        <motion.div
          ref={ref}
          className="glass-strong fixed min-w-52 rounded-lg p-1"
          style={{ left: pos.x, top: pos.y, zIndex: "var(--nv-z-modal)" }}
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
          transition={spring.snappy}
          onContextMenu={(e) => e.preventDefault()}
        >
          <MenuList items={items} onDone={close} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
