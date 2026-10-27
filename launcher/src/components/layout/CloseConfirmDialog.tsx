import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Loader2, Power } from "lucide-react";
import { toast } from "sonner";
import { stopDemoLaunch } from "@/components/LaunchDemoDriver";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { api, inTauri } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import { useApp } from "@/lib/store";

/**
 * Asked when the window should close (X, Alt+F4, taskbar) while something still runs or starts
 * (event "app:close-requested"). "Stop & close" stops the game, the game server, the backend and
 * the helpers, then closes Rift. "Cancel" keeps everything running.
 * Browser preview: open it with ?closeconfirm=1, or with the X while a preview start runs.
 */
export function CloseConfirmDialog() {
  const request = useApp((s) => s.closeRequest);
  const dismiss = useApp((s) => s.dismissCloseRequest);
  const calm = useCalmMotion();
  const [busy, setBusy] = useState(false);

  const running = request?.running ?? [];

  // Tell Rust the question is on screen. Without this answer (page error, WebView hangs) Rust
  // stops everything and closes Rift by itself, so the window can always be closed.
  const requestId = request?.id;
  useEffect(() => {
    if (requestId === undefined) return;
    api.closePromptShown(requestId).catch(() => {});
  }, [requestId]);

  const stopAndClose = async () => {
    setBusy(true);
    try {
      // The real launcher stops everything and exits – the dialog stays busy until the window is gone
      await api.quitApp();
      if (!inTauri) {
        // Nothing closes in the browser preview, so say what would happen
        stopDemoLaunch();
        toast("Everything stopped (preview)", { description: "In the real launcher, Rift closes now." });
        setBusy(false);
        dismiss();
      }
    } catch (e) {
      toast.error("Couldn't close Rift", { description: String(e) });
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !busy && dismiss()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="pr-0">
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-violet/30 to-brand-violet/5 text-violet-text ring-1 ring-brand-violet/30">
            <Power className="size-5" />
          </div>
          <DialogTitle>Close Rift?</DialogTitle>
          <DialogDescription>This also stops your game, the game server and the backend.</DialogDescription>
        </DialogHeader>

        {running.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span aria-hidden className="text-xs text-faint">Running now</span>
            <ul aria-label="Running now" className="flex flex-wrap gap-2">
              {running.map((name, i) => (
                <motion.li
                  key={name}
                  initial={calm ? false : { opacity: 0, scale: 0.9, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.28, ease: EASE_OUT, delay: 0.08 + i * 0.05 }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success ring-1 ring-success/25 ring-inset"
                >
                  <span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_rgb(34_197_94/0.7)]" />
                  {name}
                </motion.li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={dismiss} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={stopAndClose} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Power />}
            {busy ? "Stopping…" : "Stop & close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
