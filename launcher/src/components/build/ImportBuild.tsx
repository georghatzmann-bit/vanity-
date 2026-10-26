import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, FolderOpen, Loader2, ScanSearch, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, pickFolder, type BuildInfo, type DetectReport } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * State and actions for adding a build folder: pick → check → add.
 * Niobium only reads the folder – nothing in it is changed.
 */
export function useBuildImport(onAdded?: (build: BuildInfo) => void) {
  const [path, setPathState] = useState("");
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<DetectReport | null>(null);

  const setPath = (p: string) => {
    setPathState(p);
    setReport(null);
  };

  const check = async (p = path) => {
    if (!p) return;
    setChecking(true);
    setReport(null);
    try {
      setReport(await api.detectBuild(p));
    } catch (e) {
      toast.error("Couldn't check this folder", { description: String(e) });
    } finally {
      setChecking(false);
    }
  };

  /** Opens the folder picker and checks the folder right away. */
  const browse = async () => {
    const p = await pickFolder();
    if (p) {
      setPath(p);
      await check(p);
    }
  };

  const canAdd = Boolean(report?.build && report.build.support !== "unsupported" && report.checks.every((c) => c.ok));

  const add = async () => {
    if (!report?.build || !canAdd) return;
    try {
      const config = await api.addBuild(report.build);
      useApp.getState().setConfig(config);
      toast.success("Build added", { description: `Fortnite ${report.build.version} · ${report.build.season}` });
      onAdded?.(report.build);
    } catch (e) {
      toast.error("Couldn't add the build", { description: String(e) });
    }
  };

  const reset = () => {
    setPathState("");
    setReport(null);
    setChecking(false);
  };

  return { path, setPath, checking, report, check, browse, canAdd, add, reset };
}

export type BuildImport = ReturnType<typeof useBuildImport>;

/** Folder field + "Browse" + the animated check list. Buttons to check/add come from the parent. */
export function ImportBuildForm({ state, className }: { state: BuildImport; className?: string }) {
  const { path, setPath, checking, report, browse, check } = state;
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="build-path">Build folder</Label>
        <div className="flex gap-2">
          <Input
            id="build-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && check()}
            placeholder="C:\…\windows-19.10"
            className="font-mono text-xs"
          />
          <Button variant="secondary" onClick={browse}>
            <FolderOpen />
            Browse
          </Button>
        </div>
      </div>

      <div className="relative min-h-36 overflow-hidden rounded-xl bg-black/25 p-4 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
        <AnimatePresence mode="wait" initial={false}>
          {!report && !checking && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex h-28 flex-col items-center justify-center gap-2 text-center"
            >
              <ScanSearch className="size-6 text-faint" />
              <p className="max-w-xs text-xs text-muted-foreground">
                Pick the folder of your Fortnite build. Niobium finds the game file and reads the version.
              </p>
            </motion.div>
          )}
          {checking && (
            <motion.div
              key="checking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex h-28 items-center justify-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin text-violet-text" />
              Checking…
            </motion.div>
          )}
          {report && (
            <motion.ul key="report" className="flex flex-col gap-2" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }}>
              {report.checks.map((c, i) => (
                <motion.li
                  key={i}
                  variants={{ hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0, transition: { duration: 0.3, ease: EASE_OUT } } }}
                  className="flex items-center gap-2.5 text-xs"
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full",
                      c.ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
                    )}
                  >
                    {c.ok ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />}
                  </span>
                  <span className={c.ok ? "" : "text-destructive"}>{c.text}</span>
                </motion.li>
              ))}
              {report.build && (
                <motion.li
                  variants={{ hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE_OUT } } }}
                  className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] px-3 py-2.5 ring-1 ring-white/[0.06]"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      Fortnite <span className="text-violet-text tabular-nums">{report.build.version}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {report.build.season} · {report.build.engine}
                    </p>
                  </div>
                </motion.li>
              )}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Dialog version for the Library: "Add a build". */
export function ImportBuildDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const state = useBuildImport(() => onOpenChange(false));
  const { reset } = state;
  useEffect(() => {
    if (!open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a build</DialogTitle>
          <DialogDescription>Choose the folder of your build. Niobium only reads it – nothing in the folder is changed.</DialogDescription>
        </DialogHeader>
        <ImportBuildForm state={state} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {state.report ? (
            <Button onClick={state.add} disabled={!state.canAdd}>
              <Check />
              Add build
            </Button>
          ) : (
            <Button onClick={() => state.check()} disabled={!state.path || state.checking}>
              {state.checking && <Loader2 className="animate-spin" />}
              Check
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
