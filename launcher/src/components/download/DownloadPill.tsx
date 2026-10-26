import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowDown, Check, Pause } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { downloadSteps, formatDuration, formatSpeed, mainJob, phaseFraction, phaseIndex, useDownloads, type DownloadJobView } from "@/lib/downloads";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ProgressRing } from "./parts";

/** Small progress pill in the sidebar while a download runs (also: paused, stopped, ready). Opens the download page. */
export function DownloadPill({ wide }: { wide: boolean }) {
  const job = useDownloads((s) => mainJob(s.jobs));
  const setPage = useApp((s) => s.setPage);
  return (
    <AnimatePresence initial={false}>
      {job && (
        <motion.div
          key="download-pill"
          initial={{ opacity: 0, height: 0, scale: 0.9 }}
          animate={{ opacity: 1, height: "auto", scale: 1, transition: { ...SPRING_UI, opacity: { duration: 0.2 } } }}
          exit={{ opacity: 0, height: 0, scale: 0.9, transition: { duration: 0.18, ease: EASE_OUT } }}
          className="overflow-hidden"
        >
          <Pill job={job} wide={wide} onOpen={() => setPage("download")} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function texts(job: DownloadJobView) {
  const p = job.progress;
  const pct = Math.floor(phaseFraction(p) * 100);
  if (job.state === "done") return { title: `${job.version} is ready`, line: "Press Play", tone: "success" as const, pct: 100 };
  if (job.state === "error") return { title: "Download stopped", line: `${job.version} · open to fix`, tone: "danger" as const, pct };
  if (job.state === "paused") return { title: `Paused · ${job.version}`, line: "Open to resume", tone: "warning" as const, pct };
  const step = downloadSteps[phaseIndex(p.phase)];
  if (p.phase === "downloading") {
    const eta = p.etaSecs !== null ? `${formatDuration(p.etaSecs)} left` : "";
    return { title: `Downloading ${job.version}`, line: [formatSpeed(p.speedBps), eta].filter(Boolean).join(" · "), tone: "brand" as const, pct };
  }
  return { title: `${step.badge} · ${job.version}`, line: p.phase === "checking" ? "Checking at Epic, a few minutes" : step.doing, tone: "brand" as const, pct };
}

function Pill({ job, wide, onOpen }: { job: DownloadJobView; wide: boolean; onOpen: () => void }) {
  const calm = useCalmMotion();
  const t = texts(job);
  const running = job.state === "running";
  const Icon = job.state === "done" ? Check : job.state === "error" ? AlertTriangle : job.state === "paused" ? Pause : ArrowDown;
  const iconTone = {
    brand: "text-violet-text",
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
  }[t.tone];

  const button = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${t.title}. ${t.line}. Open downloads`}
      className={cn(
        "group relative mb-2 flex w-full cursor-pointer items-center rounded-lg bg-black/20 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)] transition-colors duration-150 outline-none hover:bg-white/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/50",
        wide ? "gap-2.5 px-2.5 py-2" : "justify-center py-1.5",
        t.tone === "brand" && "shadow-[inset_0_0_0_1px_rgb(180_155_255/0.16),0_8px_24px_-16px_rgb(122_60_255/0.9)]",
        t.tone === "success" && "shadow-[inset_0_0_0_1px_rgb(34_197_94/0.25)]",
        t.tone === "danger" && "shadow-[inset_0_0_0_1px_rgb(239_68_68/0.25)]",
      )}
    >
      <ProgressRing value={t.pct / 100} size={30} tone={t.tone} spin={running && job.progress.phase === "importing"}>
        <Icon
          className={cn(
            "size-3.5",
            iconTone,
            running && job.progress.phase === "downloading" && !calm && "nb-loop [animation:nb-float_1.6s_ease-in-out_infinite]",
          )}
          strokeWidth={2.5}
        />
      </ProgressRing>
      {wide && (
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="flex w-full items-center justify-between gap-2">
            <span className="truncate text-xs font-medium text-foreground">{t.title}</span>
            {job.state !== "done" && job.state !== "error" && <span className="text-[11px] text-muted-foreground tabular-nums">{t.pct}%</span>}
          </span>
          <span className="w-full truncate text-left text-[11px] text-muted-foreground tabular-nums">{t.line}</span>
        </span>
      )}
    </button>
  );

  if (wide) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">
        <p className="font-medium">{t.title}</p>
        <p className="text-muted-foreground">{t.line}</p>
      </TooltipContent>
    </Tooltip>
  );
}
