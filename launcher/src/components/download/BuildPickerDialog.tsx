import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, CloudDownload, FlaskConical, FolderOpen, HardDrive, Info, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShimmerButton } from "@/components/fx";
import { api, errorText, pickFolder, type CatalogBuild, type CatalogChapter, type CatalogSeason, type DownloadError } from "@/lib/api";
import { formatGB, roughTimeAt50Mbit, spaceNeeded, useDownloads } from "@/lib/downloads";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { VersionTile } from "./parts";

export interface PickerTarget {
  chapter: CatalogChapter;
  season: CatalogSeason;
  /** Pre-select this build (e.g. "Pick another folder" on a stopped download). */
  key?: string;
}

/**
 * A season's builds: version, CL, sizes, rough time, badge → folder (prefilled) → Start.
 * When Rust refuses the folder, its text shows right under the folder field.
 */
export function BuildPickerDialog({
  target,
  onOpenChange,
  onStarted,
}: {
  target: PickerTarget | null;
  onOpenChange: (open: boolean) => void;
  onStarted?: (key: string) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-3rem)] overflow-y-auto sm:max-w-2xl"
        onOpenAutoFocus={(e) => {
          // Focus (and show) the picked build instead of the first one in the list
          const picked = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
          if (!picked) return;
          e.preventDefault();
          picked.focus({ preventScroll: true });
          picked.scrollIntoView({ block: "nearest" });
        }}
      >
        {target && <PickerBody key={`${target.chapter.chapter}-${target.season.season}-${target.key ?? ""}`} target={target} onDone={(key) => { onOpenChange(false); onStarted?.(key); }} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({ target, onDone, onCancel }: { target: PickerTarget; onDone: (key: string) => void; onCancel: () => void }) {
  const { chapter, season } = target;
  const libraryBuilds = useApp((s) => s.config.builds);
  const jobs = useDownloads((s) => s.jobs);
  const start = useDownloads((s) => s.start);

  const owned = (b: CatalogBuild) => libraryBuilds.some((x) => x.version === b.version && x.changelist === b.cl);
  const jobOf = (b: CatalogBuild) => jobs.find((j) => j.key === b.key && j.state !== "done");
  const selectable = (b: CatalogBuild) => !owned(b) && (!jobOf(b) || target.key === b.key);

  // Newest first: the season's last update is usually the one people played most
  const list = useMemo(() => [...season.builds].reverse(), [season.builds]);
  const firstFree = list.find((b) => b.key === target.key) ?? list.find(selectable) ?? null;
  const [key, setKey] = useState<string | null>(firstFree?.key ?? null);
  const build = season.builds.find((b) => b.key === key) ?? null;

  /** null = use Rift's default folder for the picked build */
  const [customParent, setCustomParent] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<DownloadError | null>(null);
  const [busy, setBusy] = useState(false);

  // Default folder (drive with the most free space), or the picked parent + the build's own folder
  useEffect(() => {
    if (!build || edited) return;
    setError(null);
    if (customParent) {
      setFolder(joinPath(customParent, build.key));
      return;
    }
    let alive = true;
    api
      .defaultDownloadFolder(build.key)
      .then((f) => alive && setFolder(f))
      .catch((e) => alive && setError({ code: "", message: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [build, customParent, edited]);

  const running = jobs.find((j) => j.state === "running" && j.key !== key);
  const blocked: DownloadError | null = running
    ? { code: "ANOTHER_RUNNING", message: "Another version is downloading. Pause it first, then start this one." }
    : null;

  const change = async () => {
    const picked = await pickFolder({ title: "Choose where to put the build", defaultPath: parentOf(folder) });
    if (!picked || !build) return;
    setEdited(false);
    setCustomParent(picked);
    setFolder(joinPath(picked, build.key));
    setError(null);
  };

  const go = async () => {
    if (!build || !folder.trim() || busy) return;
    setBusy(true);
    setError(null);
    const refused = await start(build, folder.trim());
    setBusy(false);
    if (refused) setError(refused);
    else onDone(build.key);
  };

  const shown = error ?? blocked;
  const tested = useMemo(() => season.builds.some((b) => b.badge === "tested"), [season.builds]);

  // A long list scrolls: fade the edge where more builds are hidden
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const top = el.scrollTop > 2;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  };
  useLayoutEffect(() => {
    measure();
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [list.length]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {chapter.label} · {season.label}
        </DialogTitle>
        <DialogDescription>
          Fortnite {season.versions}. Pick a build and where to put it. Every game file comes straight from Epic's own servers.
        </DialogDescription>
      </DialogHeader>

      <div
        ref={listRef}
        role="radiogroup"
        aria-label="Builds"
        onScroll={measure}
        className="-mx-1 flex max-h-[min(19rem,42vh)] flex-col gap-2 overflow-y-auto px-1 py-1"
        style={{
          maskImage: `linear-gradient(to bottom, transparent 0, #000 ${edges.top ? 28 : 0}px, #000 calc(100% - ${edges.bottom ? 28 : 0}px), transparent 100%)`,
        }}
      >
        {list.map((b, i) => {
          const isOwned = owned(b);
          const job = jobOf(b);
          const disabled = !selectable(b);
          const active = b.key === key;
          return (
            <motion.button
              key={b.key}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => {
                setKey(b.key);
                setEdited(false);
              }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT, delay: 0.04 * i } }}
              className={cn(
                "group relative flex w-full shrink-0 cursor-pointer items-center gap-4 rounded-xl px-4 py-3 text-left transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                active ? "bg-brand-violet/[0.1]" : "surface-subtle hover:bg-white/[0.05]",
                disabled && "cursor-not-allowed opacity-55 hover:bg-transparent",
              )}
            >
              {active && (
                <motion.span
                  layoutId="picker-active"
                  transition={SPRING_UI}
                  className="pointer-events-none absolute inset-0 rounded-xl shadow-[inset_0_0_0_1px_rgb(196_181_253/0.55),0_0_24px_-10px_rgb(139_92_246/0.9)]"
                />
              )}
              <VersionTile version={b.version} />
              <div className="relative min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">
                    Fortnite <span className="tabular-nums">{b.version}</span>
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">CL-{b.cl}</span>
                  {b.badge === "tested" ? (
                    <Badge variant="success">
                      <ShieldCheck />
                      Tested
                    </Badge>
                  ) : (
                    <Badge variant="warning">
                      <FlaskConical />
                      Experimental
                    </Badge>
                  )}
                  {isOwned && (
                    <Badge variant="secondary">
                      <Check />
                      In your Library
                    </Badge>
                  )}
                  {job && !isOwned && <Badge variant="default">{job.state === "running" ? "Downloading" : job.state === "paused" ? "Paused" : "Stopped"}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                  {formatGB(b.downloadBytes)} download · {formatGB(b.installedBytes)} on disk · {roughTimeAt50Mbit(b.downloadBytes)} at 50 Mbit/s
                </p>
                {b.note && (
                  <p className={cn("mt-1 text-xs", /very big/i.test(b.note) ? "text-warning" : "text-faint")}>{b.note}</p>
                )}
              </div>
              <span
                aria-hidden
                className={cn(
                  "relative flex size-5 shrink-0 items-center justify-center rounded-full ring-1 transition-colors duration-200",
                  active ? "bg-brand text-white ring-transparent" : "ring-white/20",
                )}
              >
                {active && <Check className="size-3" strokeWidth={3} />}
              </span>
            </motion.button>
          );
        })}
      </div>

      {!tested && (
        <p className="-mt-2 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-faint" />
          Experimental: nobody has played this version with Rift yet. It may not start or may have bugs.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="dl-folder">Download to</Label>
        <div className="flex gap-2">
          <Input
            id="dl-folder"
            value={folder}
            onChange={(e) => {
              setEdited(true);
              setFolder(e.target.value);
              setError(null);
            }}
            placeholder="D:\Rift\Builds\…"
            className="font-mono text-xs"
            aria-invalid={Boolean(error)}
            disabled={!build}
          />
          <Button variant="secondary" onClick={change} disabled={!build}>
            <FolderOpen />
            Change folder
          </Button>
        </div>
        {build && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <HardDrive className="size-3.5 text-faint" />
            Needs about {formatGB(spaceNeeded(build.installedBytes))} free on that drive.
          </p>
        )}
        <AnimatePresence initial={false}>
          {shown && (
            <motion.p
              key={shown.message}
              role="alert"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto", transition: { duration: 0.25, ease: EASE_OUT } }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
              className="overflow-hidden"
            >
              <span className="mt-1 flex items-start gap-2 rounded-lg bg-destructive/[0.08] px-3 py-2.5 text-xs leading-relaxed text-destructive ring-1 ring-destructive/20 ring-inset">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                {shown.message}
              </span>
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <DialogFooter className="items-center pt-1">
        <p className="mr-auto hidden text-[11px] text-faint sm:block">First Rift checks that Epic still has every file.</p>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <ShimmerButton size="md" icon={<CloudDownload />} loading={busy} disabled={!build || !folder.trim() || Boolean(blocked)} onClick={go}>
          {build ? `Download ${build.version}` : "Download"}
        </ShimmerButton>
      </DialogFooter>
    </>
  );
}

/** "D:\Games" + "18.30-CL-…" → "D:\Games\18.30-CL-…" (no doubled separator, keeps the picked one). */
function joinPath(parent: string, name: string): string {
  const sep = parent.includes("/") && !parent.includes("\\") ? "/" : "\\";
  const trimmed = parent.replace(/[\\/]+$/, "");
  const last = trimmed.split(/[\\/]/).pop();
  if (last === name) return trimmed;
  return `${trimmed}${sep}${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i > 0 ? trimmed.slice(0, i) : trimmed;
}
