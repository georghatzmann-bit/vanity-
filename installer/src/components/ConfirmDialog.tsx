/**
 * Bestätigungsdialog (B.7): Overlay ohne Unschärfe, Kasten 420 breit, Fokusfalle, Esc = Abbrechen
 * des Dialogs. Der Abbrechen-Knopf hat den Anfangsfokus.
 */
import { useEffect, useId, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ObsButton } from "./ObsButton";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  text: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ open, title, text, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const els = [...box.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (!box.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog"
          className="absolute inset-0 z-50 grid place-items-center"
          style={{ background: "rgb(10 11 13 / 0.82)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
        >
          <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className="w-[420px] border border-obs-rule-strong bg-obs-panel p-6">
            <h2 id={`${id}-t`} className="m-0 text-[16px] leading-6 font-semibold tracking-normal text-obs-fg">
              {title}
            </h2>
            <p id={`${id}-d`} className="obs-body mt-2 text-[13px] leading-5">
              {text}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <ObsButton variant="secondary" autoFocus onClick={onCancel}>
                {cancelLabel}
              </ObsButton>
              <ObsButton variant="danger" onClick={onConfirm}>
                {confirmLabel}
              </ObsButton>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
