import { AnimatePresence, motion } from "motion/react";
import { Download } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUI } from "@/store/ui";

/** Overlay beim Hineinziehen von Dateien */
export function DropZone() {
  const t = useT();
  const dragging = useUI((s) => s.dragging);
  return (
    <AnimatePresence>
      {dragging && (
        <motion.div className="pointer-events-none fixed inset-0 grid place-items-center p-8" style={{ zIndex: "var(--nv-z-modal)" }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-[var(--nv-overlay)] backdrop-blur-md" />
          <motion.div className="relative flex h-full w-full flex-col items-center justify-center rounded-3xl border-2 border-dashed border-accent" style={{ background: "var(--nv-gradient-soft)" }} initial={{ scale: 0.96 }} animate={{ scale: 1 }}>
            <motion.div animate={{ y: [0, -10, 0] }} transition={{ duration: 1.4, repeat: Infinity }} className="grid h-20 w-20 place-items-center rounded-2xl bg-gradient-accent text-white shadow-glow">
              <Download className="h-9 w-9" />
            </motion.div>
            <div className="mt-6 font-display text-2xl font-bold text-fg">{t("library.dropTitle")}</div>
            <div className="mt-1 text-sm text-muted">{t("library.dropText")}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
