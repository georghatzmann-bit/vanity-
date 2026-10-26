import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  Clock,
  FileDown,
  FolderOpen,
  FolderSync,
  Gauge,
  HardDrive,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconTile } from "@/components/common";
import { GlowCard, ProgressBeam, ShimmerButton, StepTimeline } from "@/components/fx";
import { openFolder } from "@/lib/api";
import {
  downloadSteps,
  errorFix,
  errorTitle,
  formatDuration,
  formatGB,
  formatSpeed,
  phaseFraction,
  phaseIndex,
  playDownloadedBuild,
  useDownloads,
  type DownloadJobView,
} from "@/lib/downloads";
import { EASE_OUT, SPRING_PLAYFUL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { VersionTile } from "./parts";

/**
 * One download: steps, progress, speed, time left, Pause/Resume/Cancel – or what went wrong,
 * or "Ready" with Play. `onPickFolder` opens the build dialog again (for folder problems).
 */
export function JobCard({ job, onPickFolder }: { job: DownloadJobView; onPickFolder?: (key: string) => void }) {
  const { pause, resume, dismiss } = useDownloads.getState();
  const [cancelOpen, setCancelOpen] = useState(false);
  const p = job.progress;
  const step = phaseIndex(p.phase);
  const running = job.state === "running";
  const paused = job.state === "paused";
  const failed = job.state === "error";
  const done = job.state === "done";
  const cancelling = job.pending === "cancelling";

  const current = done ? downloadSteps.length : step;
  const fraction = phaseFraction(p);

  return (
    <GlowCard
      layout
      initial={{ opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: cancelling ? 0.6 : 1, y: 0, scale: 1, transition: { duration: 0.4, ease: EASE_OUT } }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16 } }}
      glow={running || done}
      strong
      className={cn("relative overflow-hidden", failed && "shadow-[inset_0_0_0_1px_rgb(239_68_68/0.25)]")}
    >
      {/* soft light in the state's colour */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-24 -right-16 size-72 rounded-full",
          done
            ? "bg-[radial-gradient(closest-side,rgb(34_197_94/0.18),transparent)]"
            : failed
              ? "bg-[radial-gradient(closest-side,rgb(239_68_68/0.16),transparent)]"
              : "bg-[radial-gradient(closest-side,rgb(139_92_246/0.28),transparent)]",
        )}
      />

      <div className="relative flex flex-col gap-6 p-6">
        {/* Head: build, folder, state, actions */}
        <div className="flex flex-wrap items-start gap-4">
          <VersionTile version={job.version} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg leading-tight font-semibold">
                Fortnite <span className="tabular-nums">{job.version}</span>
              </h2>
              <StateBadge job={job} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">CL-{job.cl}</p>
            <p title={job.folder} className="selectable mt-1.5 max-w-xl truncate font-mono text-[11px] text-faint">
              {job.folder}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {running && (
              <Button variant="secondary" size="sm" onClick={() => pause(job.key)} disabled={job.pending !== null}>
                {job.pending === "pausing" ? <Loader2 className="animate-spin" /> : <Pause />}
                {job.pending === "pausing" ? "Pausing…" : "Pause"}
              </Button>
            )}
            {paused && (
              <Button size="sm" onClick={() => resume(job.key)} disabled={job.pending !== null}>
                {job.pending === "resuming" ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
                Resume
              </Button>
            )}
            {(running || paused) && (
              <Button variant="ghost" size="sm" onClick={() => setCancelOpen(true)} disabled={cancelling}>
                {cancelling ? <Loader2 className="animate-spin" /> : <X />}
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            )}
            {done && (
              <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => dismiss(job.key)}>
                <X />
              </Button>
            )}
          </div>
        </div>

        <StepTimeline steps={downloadSteps} current={current} failed={failed} paused={paused} />

        <AnimatePresence mode="wait" initial={false}>
          {done ? (
            <ReadyBlock key="done" job={job} />
          ) : failed && job.error ? (
            <ErrorBlock
              key="error"
              job={job}
              onRemove={() => setCancelOpen(true)}
              onPickFolder={onPickFolder ? () => onPickFolder(job.key) : undefined}
            />
          ) : (
            <motion.div
              key="progress"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              className="flex flex-col gap-4"
            >
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <p className={cn("text-sm font-medium", paused ? "text-warning" : "text-foreground")}>
                    {paused ? "Paused – everything downloaded so far is kept." : downloadSteps[step].doing}
                  </p>
                  {p.currentFile && running && (
                    <p title={p.currentFile} className="mt-1 truncate font-mono text-[11px] text-faint">
                      {p.currentFile}
                    </p>
                  )}
                </div>
                {p.phase !== "importing" && (
                  <p className="shrink-0 text-3xl leading-none font-semibold tracking-tight tabular-nums">
                    {Math.floor(fraction * 100)}
                    <span className="text-lg text-muted-foreground">%</span>
                  </p>
                )}
              </div>
              <ProgressBeam value={p.phase === "importing" ? 1 : fraction} active={running} className="h-2" />
              <Stats job={job} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <CancelDownloadDialog job={job} open={cancelOpen} onOpenChange={setCancelOpen} />
    </GlowCard>
  );
}

function StateBadge({ job }: { job: DownloadJobView }) {
  if (job.state === "done")
    return (
      <Badge variant="success">
        <Check />
        Ready
      </Badge>
    );
  if (job.state === "error")
    return (
      <Badge variant="destructive">
        <AlertTriangle />
        Stopped
      </Badge>
    );
  if (job.state === "paused")
    return (
      <Badge variant="warning">
        <Pause />
        Paused
      </Badge>
    );
  return (
    <Badge variant="default">
      <Loader2 className="animate-spin" />
      {downloadSteps[phaseIndex(job.progress.phase)].badge}
    </Badge>
  );
}

/** GB, speed, time left, files – what fits the phase. */
function Stats({ job }: { job: DownloadJobView }) {
  const p = job.progress;
  const running = job.state === "running";
  const eta = running && p.etaSecs !== null ? formatDuration(p.etaSecs) : "–";
  const items: { icon: LucideIcon; label: string; value: string }[] =
    p.phase === "checking"
      ? [
          { icon: HardDrive, label: "Checked", value: `${formatGB(p.bytesDone)} of ${formatGB(p.bytesTotal)}` },
          { icon: Clock, label: "Time left", value: eta },
          { icon: FileDown, label: "Downloaded", value: "Nothing yet" },
        ]
      : p.phase === "downloading"
        ? [
            { icon: HardDrive, label: "Downloaded", value: `${formatGB(p.bytesDone)} of ${formatGB(p.bytesTotal)}` },
            { icon: Gauge, label: "Speed", value: running ? formatSpeed(p.speedBps) : "–" },
            { icon: Clock, label: "Time left", value: eta },
            { icon: FileDown, label: "Files", value: `${p.filesDone} of ${p.filesTotal}` },
          ]
        : p.phase === "verifying"
          ? [
              { icon: FileDown, label: "Files checked", value: `${p.filesDone} of ${p.filesTotal}` },
              { icon: HardDrive, label: "On disk", value: `${formatGB(p.bytesDone)} of ${formatGB(p.bytesTotal)}` },
            ]
          : [{ icon: FileDown, label: "Files", value: `${p.filesTotal} ready` }];
  return (
    <dl className={cn("grid gap-2", items.length >= 4 ? "grid-cols-2 lg:grid-cols-4" : items.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0 rounded-lg surface-subtle px-3 py-2">
          <dt className="flex items-center gap-1.5 text-[11px] text-faint">
            <it.icon className="size-3" />
            {it.label}
          </dt>
          <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ErrorBlock({ job, onRemove, onPickFolder }: { job: DownloadJobView; onRemove: () => void; onPickFolder?: () => void }) {
  const { resume, dismiss } = useDownloads.getState();
  const error = job.error!;
  const fix = errorFix(error.code, job.filesKept);
  const resuming = job.pending === "resuming";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      role="alert"
      className="flex flex-wrap items-start gap-4 rounded-xl bg-destructive/[0.07] p-4 ring-1 ring-destructive/20 ring-inset"
    >
      <IconTile icon={AlertTriangle} tone="danger" />
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-semibold">{errorTitle(error.code)}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{error.message}</p>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {(fix === "resume" || fix === "retry" || error.code === "NOT_ENOUGH_SPACE") && (
            <Button size="sm" onClick={() => resume(job.key)} disabled={resuming}>
              {resuming ? <Loader2 className="animate-spin" /> : fix === "resume" ? <Play className="fill-current" /> : <RotateCcw />}
              {fix === "resume" ? "Resume" : "Try again"}
            </Button>
          )}
          {fix === "folder" && onPickFolder && (
            <Button size="sm" variant={error.code === "NOT_ENOUGH_SPACE" ? "secondary" : "default"} onClick={onPickFolder}>
              <FolderSync />
              Pick another folder
            </Button>
          )}
          {fix === "import" && (
            <Button size="sm" variant="secondary" onClick={() => openFolder(job.folder)}>
              <FolderOpen />
              Open folder
            </Button>
          )}
          {/* Nothing on disk: just close it. Files on disk: Remove asks whether to delete them. */}
          {!job.filesKept ? (
            <Button size="sm" variant="ghost" onClick={() => dismiss(job.key)}>
              <X />
              Close
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={onRemove}>
              <Trash2 />
              Remove
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function ReadyBlock({ job }: { job: DownloadJobView }) {
  const [busy, setBusy] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE_OUT } }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      className="flex flex-wrap items-center gap-5 rounded-xl bg-success/[0.06] p-5 ring-1 ring-success/20 ring-inset"
    >
      <motion.span
        initial={{ scale: 0.4, rotate: -20, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ ...SPRING_PLAYFUL, delay: 0.1 }}
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-success/15 text-success ring-1 ring-success/35 shadow-[0_0_30px_-6px_rgb(34_197_94/0.7)]"
      >
        <Check className="size-6" strokeWidth={2.6} />
      </motion.span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-base font-semibold">
          Fortnite <span className="tabular-nums">{job.version}</span> is ready
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">It's in your Library now. Press Play to use it.</p>
      </div>
      <ShimmerButton
        size="md"
        pulse
        loading={busy}
        icon={<Play className="fill-current" />}
        onClick={async () => {
          setBusy(true);
          try {
            await playDownloadedBuild(job);
          } finally {
            setBusy(false);
          }
        }}
      >
        Play
      </ShimmerButton>
    </motion.div>
  );
}

/** "Delete the downloaded files?" – keeping them is the default. */
export function CancelDownloadDialog({
  job,
  open,
  onOpenChange,
}: {
  job: DownloadJobView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cancel = useDownloads((s) => s.cancel);
  const stopped = job.state === "error";
  const go = (deleteFiles: boolean) => {
    onOpenChange(false);
    void cancel(job.key, deleteFiles);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{stopped ? `Remove the download of ${job.version}?` : `Cancel the download of ${job.version}?`}</DialogTitle>
          <DialogDescription>
            Delete the downloaded files? If you keep them, downloading {job.version} into the same folder again continues where it stopped.
          </DialogDescription>
        </DialogHeader>
        <p title={job.folder} className="selectable truncate rounded-md bg-black/25 px-3 py-2 font-mono text-xs text-muted-foreground ring-1 ring-white/[0.04]">
          {job.folder}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {job.state === "running" ? "Keep downloading" : "Back"}
          </Button>
          <Button variant="destructive" onClick={() => go(true)}>
            <Trash2 />
            Delete files
          </Button>
          <Button autoFocus onClick={() => go(false)}>
            <Check />
            Keep files
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
