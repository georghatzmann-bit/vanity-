import { useState } from "react";
import { Loader2, MonitorCog, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { bubbleText } from "@/lib/bubble";
import { useApp } from "@/lib/store";

/**
 * Asked after a game with Bubble Builds when Fortnite saved Performance Mode as its default
 * (event "bubble:ini-changed"). Only "Reset" touches the file – and only the two remembered lines.
 */
export function BubbleIniDialog() {
  const info = useApp((s) => s.bubbleIni);
  const dismiss = useApp((s) => s.dismissBubbleIni);
  const [busy, setBusy] = useState(false);

  const reset = async () => {
    setBusy(true);
    try {
      await api.resetPerformanceModeIni();
      toast.success("Performance Mode reset", { description: "Your other builds start with normal graphics again." });
      dismiss();
    } catch (e) {
      toast.error("Couldn't reset Performance Mode", { description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={info !== null} onOpenChange={(open) => !open && !busy && dismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-warning/25 to-warning/5 text-warning ring-1 ring-warning/25">
            <MonitorCog className="size-5" />
          </div>
          <DialogTitle>{bubbleText.iniTitle}</DialogTitle>
          <DialogDescription>{bubbleText.iniQuestion}</DialogDescription>
        </DialogHeader>
        {info?.path && (
          <p className="truncate rounded-lg bg-black/25 px-3 py-2 font-mono text-[11px] text-faint ring-1 ring-white/[0.05]" title={info.path}>
            {info.path}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={dismiss} disabled={busy}>
            {bubbleText.iniKeep}
          </Button>
          <Button onClick={reset} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            {bubbleText.iniReset}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
