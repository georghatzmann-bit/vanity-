import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bubbles,
  Check,
  CircleDashed,
  CircleSlash,
  Clock,
  CloudDownload,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  Layers,
  MoreHorizontal,
  Plus,
  ShieldCheck,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ImportBuildDialog } from "@/components/build/ImportBuild";
import { ProgressRing } from "@/components/download/parts";
import { IconTile, PageHeader, PageShell, Panel, type IconTone } from "@/components/common";
import { GlowCard, NumberTicker, Reveal, Sheen, Stagger } from "@/components/fx";
import { pageGroup } from "@/components/layout/nav";
import { useBubbleSupport } from "@/hooks/use-bubble-support";
import { bubbleLevelFor } from "@/lib/bubble";
import { coverGradient } from "@/lib/builds";
import { versionSupport } from "@/lib/demo-data";
import { api, openFolder, type BuildInfo } from "@/lib/api";
import { formatDuration, formatSpeed, mainJob, phaseFraction, useDownloads, type DownloadJobView } from "@/lib/downloads";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function LibraryPage() {
  const builds = useApp((s) => s.config.builds);
  const setPage = useApp((s) => s.setPage);
  const activeBuildId = useApp((s) => s.config.profiles.find((p) => p.id === s.config.activeProfileId)?.buildId);
  const [importOpen, setImportOpen] = useState(false);

  const remove = async (id: string) => {
    const config = await api.removeBuild(id);
    useApp.getState().setConfig(config);
    toast("Removed from the list", { description: "Your build files stay untouched." });
  };

  const tested = builds.filter((b) => b.support === "supported").length;
  const bubbleReady = builds.filter((b) => bubbleLevelFor(b.version) !== "unavailable").length;

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("library")}
        title="Library"
        description="Your Fortnite builds. When you add one, Niobium finds the version and checks if it's supported."
        actions={
          <>
            <Button variant="secondary" onClick={() => setPage("download")}>
              <CloudDownload />
              Download a version
            </Button>
            <Button onClick={() => setImportOpen(true)}>
              <Plus />
              Add a build
            </Button>
          </>
        }
      />

      {builds.length > 0 && (
        <Stagger className="grid grid-cols-3 gap-3" delay={0.06}>
          <Stat icon={Layers} label="Builds" value={builds.length} />
          <Stat icon={ShieldCheck} label="Tested" value={tested} tone="success" />
          <Stat icon={Bubbles} label="Bubble Builds ready" value={bubbleReady} />
        </Stagger>
      )}

      <Stagger className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" delay={0.1} stagger={0.06}>
        <AnimatePresence>
          {builds.map((build, i) => (
            <motion.div key={build.id} {...cardMotion(i)} className="flex">
              <BuildCard
                build={build}
                active={build.id === activeBuildId}
                onOpen={() => openFolder(build.path)}
                onRemove={() => remove(build.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
        <AddTiles first={builds.length === 0} onAdd={() => setImportOpen(true)} onDownload={() => setPage("download")} />
      </Stagger>

      <Panel
        title="Which versions work"
        description="Niobium starts every version from 1.7 to 30.x – Chapter 1 to Chapter 5 Season 3. Only 19.10 is tested so far; the others are untested, but every part is built for them. The game server doesn't know newer versions yet."
      >
        <Stagger className="relative flex flex-col gap-2" inView stagger={0.05}>
          {/* the chapter line on the left */}
          <span aria-hidden className="absolute top-4 bottom-4 left-[19px] w-px bg-gradient-to-b from-brand-blue/50 via-brand-violet/40 to-transparent" />
          {versionSupport.map((v) => (
            <Reveal key={v.version} kind="slide" className="relative flex items-center gap-4 rounded-lg py-2.5 pr-4 pl-3 transition-colors hover:bg-white/[0.03]">
              <SupportDot level={v.level} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  <span className="tabular-nums">{v.version}</span> <span className="font-normal text-muted-foreground">· {v.label}</span>
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{v.note}</p>
              </div>
              <SupportBadge level={v.level} />
            </Reveal>
          ))}
        </Stagger>
      </Panel>

      <ImportBuildDialog open={importOpen} onOpenChange={setImportOpen} />
    </PageShell>
  );
}

/**
 * Entrance/exit for a card in a list that can grow and shrink. The card drives its own animation
 * (instead of waiting for the page's stagger), so it can never get stuck hidden, and new cards pop in.
 */
function cardMotion(i: number) {
  return {
    layout: true,
    initial: { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT, delay: 0.08 + i * 0.06 } },
    exit: { opacity: 0, scale: 0.95, transition: { duration: 0.16 } },
    transition: SPRING_UI,
  } as const;
}

function Stat({ icon, label, value, tone = "brand" }: { icon: LucideIcon; label: string; value: number; tone?: IconTone }) {
  return (
    <GlowCard kind="scale" className="flex items-center gap-3 px-4 py-3">
      <IconTile icon={icon} tone={tone} size="sm" />
      <div className="min-w-0">
        <p className="text-xl leading-tight font-semibold">
          <NumberTicker value={value} />
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{label}</p>
      </div>
    </GlowCard>
  );
}

const supportChip = {
  supported: { icon: ShieldCheck, text: "Tested", variant: "success" },
  experimental: { icon: Clock, text: "Untested", variant: "warning" },
  unsupported: { icon: CircleSlash, text: "Can't start", variant: "destructive" },
} as const;

function BuildCard({ build, active, onOpen, onRemove }: { build: BuildInfo; active: boolean; onOpen: () => void; onRemove: () => void }) {
  const chip = supportChip[build.support] ?? supportChip.experimental;
  const ChipIcon = chip.icon;
  const note = build.supportNote && !/^(tested|getestet)$/i.test(build.supportNote.trim()) ? build.supportNote : null;
  return (
    <GlowCard
      initial={false}
      glow={active}
      spotlight
      whileHover={{ y: -3 }}
      className="group hover-glow flex w-full flex-col overflow-hidden"
    >
      {/* Cover */}
      <div className={cn("relative h-32 overflow-hidden rounded-t-xl bg-gradient-to-br", coverGradient(build.version))}>
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.16]"
          style={{ backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 18px)", maskImage: "linear-gradient(90deg, transparent, black 70%)" }}
        />
        <div aria-hidden className="absolute -top-16 -left-10 size-48 rounded-full bg-[radial-gradient(closest-side,rgb(143_168_255/0.35),transparent)]" />
        <span
          aria-hidden
          className="absolute right-4 -bottom-3 text-6xl font-bold tracking-tighter text-white/[0.13] tabular-nums transition-[translate,color] duration-500 ease-out group-hover:-translate-x-1.5 group-hover:text-white/[0.22]"
        >
          {build.version}
        </span>
        <Sheen />
        <div className="absolute inset-x-4 top-4 flex items-center justify-between gap-2">
          <Badge variant={chip.variant} className="bg-black/30 backdrop-blur-md">
            <ChipIcon />
            {chip.text}
          </Badge>
          {active && (
            <Badge variant="brand" className="shadow-[0_0_14px_-2px_rgb(122_60_255/0.8)]">
              <Check />
              Active
            </Badge>
          )}
        </div>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <h2 className="text-[15px] font-semibold">
            Fortnite <span className="tabular-nums">{build.version}</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {build.season}
            {build.changelist ? <span className="tabular-nums"> · CL-{build.changelist}</span> : null} · {build.engine}
          </p>
          {note && <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{note}</p>}
        </div>

        <BubbleRow version={build.version} />

        <p title={build.path} className="selectable truncate rounded-md bg-black/25 px-3 py-2 font-mono text-xs text-muted-foreground ring-1 ring-white/[0.04]">
          {build.path}
        </p>

        <div className="mt-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onOpen}>
            <FolderOpen />
            Open folder
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More for Fortnite ${build.version}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>
                <Trash2 />
                Remove from list
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </GlowCard>
  );
}

/** "Bubble Builds  Supported / Experimental / —" with the English note as a tooltip. */
function BubbleRow({ version }: { version: string }) {
  const info = useBubbleSupport(version);
  if (!info) return null;
  const chip =
    info.level === "supported" ? (
      <Badge variant="default">
        <Bubbles />
        Supported
      </Badge>
    ) : info.level === "experimental" || info.level === "lowMeshes" ? (
      <Badge variant="warning">
        <FlaskConical />
        Experimental
      </Badge>
    ) : (
      <span className="px-1.5 text-sm leading-none text-faint" aria-label="Not available">
        —
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} className="focus-ring flex cursor-help items-center justify-between gap-3 rounded-lg surface-subtle px-3 py-2">
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Bubbles className="size-3.5 text-faint" />
            Bubble Builds
          </span>
          {chip}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{info.note}</TooltipContent>
    </Tooltip>
  );
}

/**
 * "Add a build folder" and "Download a version": stacked in one grid cell next to the builds,
 * or side by side across the row while there is no build yet.
 */
function AddTiles({ first, onAdd, onDownload }: { first: boolean; onAdd: () => void; onDownload: () => void }) {
  return (
    <div className={cn(first ? "grid gap-4 sm:grid-cols-2 md:col-span-2 xl:col-span-3" : "flex min-h-52 flex-col gap-4")}>
      <AddTile big={first} onClick={onAdd} />
      <DownloadTile big={first} onClick={onDownload} />
    </div>
  );
}

const dashedTile = "border border-dashed bg-white/[0.01] text-muted-foreground backdrop-blur-none before:hidden";
const tileLayout = (big: boolean) =>
  big ? "flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center" : "flex flex-1 items-center gap-4 px-5 py-4 text-left";

/** Dashed "add" card. With no builds yet it is big and says so. */
function AddTile({ big, onClick }: { big: boolean; onClick: () => void }) {
  return (
    <GlowCard
      interactive
      kind="scale"
      onClick={onClick}
      aria-label="Add a build folder"
      className={cn(tileLayout(big), dashedTile, "border-white/[0.1] hover:border-brand-violet/40")}
    >
      <TileIcon tone="violet">
        <FolderPlus className="size-6" />
      </TileIcon>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{big ? "Add your first build" : "Add a build folder"}</p>
        <p className="mt-1 text-xs">
          Choose the folder that contains "FortniteGame".{big ? " Niobium only reads it – nothing in it is changed." : ""}
        </p>
      </div>
    </GlowCard>
  );
}

/**
 * "Download a version": a dashed tile under "Add a build". While a download runs it shows it
 * (ring, percent, speed) and opens the download page.
 */
function DownloadTile({ big, onClick }: { big: boolean; onClick: () => void }) {
  const job = useDownloads((s) => mainJob(s.jobs));
  return (
    <GlowCard
      interactive
      kind="scale"
      onClick={onClick}
      aria-label={job ? "Open your downloads" : "Download a version"}
      className={cn(
        tileLayout(big),
        dashedTile,
        job ? "border-brand-violet/30 bg-brand-violet/[0.04] hover:border-brand-violet/50" : "border-white/[0.1] hover:border-brand-blue/50",
      )}
    >
      {job ? (
        <DownloadTileJob job={job} big={big} />
      ) : (
        <>
          <TileIcon tone="blue">
            <CloudDownload className="size-6 transition-transform duration-300 group-hover:translate-y-0.5" />
          </TileIcon>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Download a version</p>
            <p className="mt-1 text-xs">Get an older Fortnite straight from Epic's servers.</p>
          </div>
        </>
      )}
    </GlowCard>
  );
}

function TileIcon({ tone, children }: { tone: "violet" | "blue"; children: ReactNode }) {
  return (
    <div className="relative shrink-0">
      <div
        aria-hidden
        className={cn(
          "absolute -inset-5 rounded-full opacity-60 transition-opacity duration-300 group-hover:opacity-100",
          tone === "violet" ? "bg-[radial-gradient(closest-side,rgb(122_60_255/0.22),transparent)]" : "bg-[radial-gradient(closest-side,rgb(43_91_255/0.26),transparent)]",
        )}
      />
      <div
        className={cn(
          "relative flex size-12 items-center justify-center rounded-xl bg-gradient-to-b from-white/[0.09] to-white/[0.03] shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_0_0_1px_rgb(255_255_255/0.06)] transition-transform duration-300 group-hover:scale-110",
          tone === "violet" ? "text-violet-text group-hover:-rotate-3" : "text-blue-text",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function DownloadTileJob({ job, big }: { job: DownloadJobView; big: boolean }) {
  const p = job.progress;
  const pct = Math.floor(phaseFraction(p) * 100);
  const line =
    job.state === "done"
      ? "Ready – open to play"
      : job.state === "error"
        ? "Stopped – open to fix"
        : job.state === "paused"
          ? `Paused at ${pct}%`
          : p.phase === "downloading"
            ? [formatSpeed(p.speedBps), p.etaSecs !== null ? `${formatDuration(p.etaSecs)} left` : ""].filter(Boolean).join(" · ")
            : p.phase === "checking"
              ? "Checking that Epic has every file"
              : p.phase === "verifying"
                ? "Checking files"
                : "Adding to Library";
  const tone = job.state === "done" ? "success" : job.state === "error" ? "danger" : job.state === "paused" ? "warning" : "brand";
  return (
    <>
      <ProgressRing value={job.state === "done" ? 1 : pct / 100} size={big ? 64 : 52} stroke={4} tone={tone}>
        {job.state === "done" ? (
          <Check className="size-5 text-success" strokeWidth={2.6} />
        ) : (
          <span className="text-xs font-semibold text-foreground tabular-nums">{pct}%</span>
        )}
      </ProgressRing>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">
          {job.state === "done" ? "Ready: " : job.state === "running" ? "Downloading " : ""}Fortnite <span className="tabular-nums">{job.version}</span>
        </p>
        <p className="mt-1 truncate text-xs tabular-nums">{line}</p>
      </div>
    </>
  );
}

const supportLevels: Record<string, { icon: LucideIcon; text: string; variant: "success" | "warning" | "muted" }> = {
  supported: { icon: Check, text: "Tested", variant: "success" },
  experimental: { icon: Clock, text: "Untested", variant: "warning" },
  unsupported: { icon: CircleDashed, text: "Not yet", variant: "muted" },
  later: { icon: CircleDashed, text: "Later", variant: "muted" },
};

function SupportBadge({ level }: { level: string }) {
  const m = supportLevels[level] ?? supportLevels.later;
  const Icon = m.icon;
  return (
    <Badge variant={m.variant} className="w-24 shrink-0">
      <Icon />
      {m.text}
    </Badge>
  );
}

function SupportDot({ level }: { level: string }) {
  return (
    <span className="relative z-10 flex size-4 shrink-0 items-center justify-center">
      <span
        className={cn(
          "size-2.5 rounded-full ring-4 ring-[#10121b]",
          level === "supported" && "bg-success shadow-[0_0_10px_rgb(34_197_94/0.7)]",
          level === "experimental" && "bg-warning/80",
          level !== "supported" && level !== "experimental" && "bg-white/20",
        )}
      />
    </span>
  );
}
