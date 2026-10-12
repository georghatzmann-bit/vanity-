import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  className?: string;
  /** Kein Schließen per Klick daneben (z. B. während einer Aktion) */
  locked?: boolean;
  footer?: ReactNode;
  bare?: boolean;
}

/** Glas-Dialog mit unscharfem Hintergrund */
export function Modal({ open, onClose, children, title, subtitle, width = 560, className, locked, footer, bare }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    sound.play("open");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !locked) {
        e.stopPropagation();
        sound.play("close");
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, locked, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 grid place-items-center p-6" style={{ zIndex: "var(--nv-z-modal)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <div
            className="absolute inset-0 bg-[var(--nv-overlay)] backdrop-blur-md"
            onClick={() => {
              if (!locked) {
                sound.play("close");
                onClose();
              }
            }}
          />
          <motion.div
            role="dialog"
            aria-modal
            className={cn("glass-strong relative flex max-h-[calc(100vh-80px)] w-full flex-col overflow-hidden rounded-2xl", className)}
            style={{ maxWidth: width }}
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={spring.smooth}
          >
            {!bare && (title || subtitle) && (
              <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
                <div className="min-w-0">
                  {title && <h2 className="text-xl font-semibold text-fg">{title}</h2>}
                  {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
                </div>
                {!locked && (
                  <button
                    type="button"
                    aria-label="Schließen"
                    onClick={() => {
                      sound.play("close");
                      onClose();
                    }}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-2 hover:text-fg"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            )}
            <div className={cn("min-h-0 flex-1 overflow-y-auto", !bare && "px-6 pb-6")}>{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-surface px-6 py-4">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
