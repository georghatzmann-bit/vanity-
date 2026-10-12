import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CheckCircle2, Gamepad2, Info, X, XCircle } from "lucide-react";
import { useUI, type Toast } from "@/store/ui";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";

const ICON = { success: CheckCircle2, error: XCircle, info: Info, game: Gamepad2, warning: AlertTriangle };
const COLOR = { success: "text-success", error: "text-danger", info: "text-info", game: "text-accent", warning: "text-warning" };

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUI((s) => s.dismiss);
  const duration = toast.duration ?? (toast.kind === "error" ? 7000 : 4200);
  useEffect(() => {
    const id = window.setTimeout(() => dismiss(toast.id), duration);
    return () => window.clearTimeout(id);
  }, [toast.id, duration, dismiss]);
  const I = ICON[toast.kind];
  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95, transition: { duration: 0.18 } }}
      transition={spring.gentle}
      className="glass-strong pointer-events-auto relative w-[360px] overflow-hidden rounded-xl p-4 pr-10"
    >
      <div className="flex gap-3">
        <I className={cn("mt-0.5 h-5 w-5 shrink-0", COLOR[toast.kind])} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg">{toast.title}</div>
          {toast.text && <div className="mt-1 text-[13px] leading-snug break-words text-muted">{toast.text}</div>}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
              className="mt-2 text-[13px] font-semibold text-accent hover:underline"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      </div>
      <button type="button" onClick={() => dismiss(toast.id)} className="absolute top-3 right-3 grid h-6 w-6 place-items-center rounded-md text-faint transition hover:bg-surface-2 hover:text-fg" aria-label="Schließen">
        <X className="h-3.5 w-3.5" />
      </button>
      <motion.div className="absolute bottom-0 left-0 h-[2px] bg-gradient-accent opacity-70" initial={{ width: "100%" }} animate={{ width: "0%" }} transition={{ duration: duration / 1000, ease: "linear" }} />
    </motion.div>
  );
}

/** Kurze Rückmeldungen unten rechts, verschwinden von selbst */
export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-5 bottom-5 flex flex-col items-end gap-2.5" style={{ zIndex: "var(--nv-z-toast)" }}>
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}
