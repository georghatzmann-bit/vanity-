import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowLeft, CloudDownload, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, PageShell, Panel, Reveal } from "@/components/common";
import { Skeleton } from "@/components/fx";
import { BuildPickerDialog, type PickerTarget } from "@/components/download/BuildPickerDialog";
import { JobCard } from "@/components/download/JobCard";
import { SeasonBrowser } from "@/components/download/SeasonBrowser";
import type { Catalog } from "@/lib/api";
import { useDownloads } from "@/lib/downloads";
import { previewParam, useApp } from "@/lib/store";

/** Library → "Download a version": chapter tabs, season cards, a season's builds, and the downloads. */
export function DownloadPage() {
  const setPage = useApp((s) => s.setPage);
  const library = useApp((s) => s.config.builds);
  const catalog = useDownloads((s) => s.catalog);
  const catalogError = useDownloads((s) => s.catalogError);
  const loadCatalog = useDownloads((s) => s.loadCatalog);
  const jobs = useDownloads((s) => s.jobs);

  const [chapter, setChapter] = useState<string | null>(null);
  const [target, setTarget] = useState<PickerTarget | null>(null);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // Start on the first chapter that has something to download (preview: ?season=2-5 opens one)
  useEffect(() => {
    if (!catalog || chapter) return;
    const wanted = previewParam("season")?.split("-").map(Number);
    if (wanted && wanted.length === 2) {
      const c = catalog.chapters.find((x) => x.chapter === wanted[0]);
      const s = c?.seasons.find((x) => x.season === wanted[1]);
      if (c) setChapter(String(c.chapter));
      if (c && s && s.status === "available") setTarget({ chapter: c, season: s });
      if (c) return;
    }
    const first = catalog.chapters.find((c) => c.seasons.some((s) => s.status === "available")) ?? catalog.chapters[0];
    if (first) setChapter(String(first.chapter));
  }, [catalog, chapter]);

  // Running first, then stopped, paused and finished ones
  const ordered = useMemo(() => {
    const rank = { running: 0, error: 1, paused: 2, done: 3, cancelled: 4 } as const;
    return [...jobs].sort((a, b) => rank[a.state] - rank[b.state]);
  }, [jobs]);

  /** "Pick another folder" on a stopped download: open its season with that build picked. */
  const pickFolderFor = (key: string) => {
    const where = findSeason(catalog, key);
    if (where) setTarget({ ...where, key });
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow="Library"
        title="Download a version"
        description="Niobium gets every game file straight from Epic's own download servers. Pick a chapter, then a season."
        actions={
          <Button variant="ghost" onClick={() => setPage("library")}>
            <ArrowLeft />
            Back to Library
          </Button>
        }
      />

      <AnimatePresence initial={false}>
        {ordered.map((job) => (
          <JobCard key={job.key} job={job} onPickFolder={pickFolderFor} />
        ))}
      </AnimatePresence>

      <Panel
        icon={CloudDownload}
        title="Pick a season"
        description={
          <>
            Only seasons that Epic still has completely are offered.
            {catalog?.checkedOn ? <> Checked on {formatDay(catalog.checkedOn)}.</> : null}
          </>
        }
        actions={
          <span className="hidden items-center gap-1.5 text-[11px] text-faint lg:inline-flex">
            <ShieldCheck className="size-3.5 text-success" />
            Files come from Epic only
          </span>
        }
      >
        {catalog && chapter ? (
          <SeasonBrowser
            catalog={catalog}
            chapter={chapter}
            onChapter={setChapter}
            onPick={(c, s) => setTarget({ chapter: c, season: s })}
            library={library}
          />
        ) : catalogError ? (
          <EmptyState
            icon={CloudDownload}
            title="Couldn't load the list of versions"
            hint={catalogError}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  useDownloads.setState({ catalogError: null });
                  void loadCatalog();
                }}
              >
                <RotateCcw />
                Try again
              </Button>
            }
          />
        ) : (
          <Reveal className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-10 w-[28rem] max-w-full rounded-xl" />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-36 rounded-xl" />
              ))}
            </div>
          </Reveal>
        )}
      </Panel>

      <BuildPickerDialog
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onStarted={() => document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" })}
      />
    </PageShell>
  );
}

function findSeason(catalog: Catalog | null, key: string): PickerTarget | null {
  for (const chapter of catalog?.chapters ?? []) {
    for (const season of chapter.seasons) {
      if (season.builds.some((b) => b.key === key)) return { chapter, season };
    }
  }
  return null;
}

/** "2026-10-26" → "26 October 2026" */
function formatDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
