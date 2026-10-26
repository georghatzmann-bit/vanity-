import { motion } from "motion/react";
import { ArrowRight, Check, CircleCheck, Clock, CloudOff, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GlowCard, Sheen } from "@/components/fx";
import type { BuildInfo, Catalog, CatalogChapter, CatalogSeason, SeasonStatus } from "@/lib/api";
import { parseVersionNumber } from "@/lib/bubble";
import { coverGradient } from "@/lib/builds";
import { formatGB } from "@/lib/downloads";
import { EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

const statusBadge: Record<SeasonStatus, { text: string; icon: typeof Check; variant: "success" | "muted" | "secondary" }> = {
  available: { text: "Available", icon: CircleCheck, variant: "success" },
  notFromEpic: { text: "Not available from Epic", icon: CloudOff, variant: "muted" },
  notOfferedYet: { text: "Not offered yet", icon: Clock, variant: "muted" },
};

/** Short line on a card; the full text is shown once above the cards. */
const shortLine: Record<SeasonStatus, string> = {
  available: "",
  notFromEpic: "Epic deleted some of its files.",
  notOfferedYet: "The game server isn't ready for it yet.",
};

/** Chapter tabs (1–5) → season cards with one badge each. Clicking an available season opens its builds. */
export function SeasonBrowser({
  catalog,
  chapter,
  onChapter,
  onPick,
  library,
}: {
  catalog: Catalog;
  chapter: string;
  onChapter: (chapter: string) => void;
  onPick: (chapter: CatalogChapter, season: CatalogSeason) => void;
  library: BuildInfo[];
}) {
  return (
    <Tabs value={chapter} onValueChange={onChapter} className="gap-5">
      <TabsList className="h-11 w-full justify-start overflow-x-auto sm:w-fit">
        {catalog.chapters.map((c) => {
          const available = c.seasons.filter((s) => s.status === "available").length;
          return (
            <TabsTrigger key={c.chapter} value={String(c.chapter)} className="px-4">
              {c.label}
              {available > 0 && (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-success/15 px-1 text-[10px] font-semibold text-success tabular-nums">
                  {available}
                </span>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>

      {catalog.chapters.map((c) => (
        <TabsContent key={c.chapter} value={String(c.chapter)} className="flex flex-col gap-4">
          <ChapterNotes chapter={c} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {c.seasons.map((s, i) => (
              <SeasonCard
                key={s.season}
                chapter={c}
                season={s}
                index={i}
                owned={ownedIn(library, s)}
                sharedNote={groupNote(c, s.status)}
                onPick={() => onPick(c, s)}
              />
            ))}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** Builds from the Library that belong to this season (same major version). */
function ownedIn(library: BuildInfo[], season: CatalogSeason): BuildInfo[] {
  const major = Number(season.versions.split(".")[0]);
  return library.filter((b) => parseVersionNumber(b.version)?.[0] === major);
}

/** The text shown once above the cards for every season of this status in the chapter. */
function groupNote(chapter: CatalogChapter, status: SeasonStatus): string {
  if (status === "available") return "";
  return chapter.seasons.find((s) => s.status === status && s.note)?.note ?? "";
}

/** Why seasons can't be downloaded – once per reason, not on every card. */
function ChapterNotes({ chapter }: { chapter: CatalogChapter }) {
  const groups = (["notFromEpic", "notOfferedYet"] as const)
    .map((status) => {
      const seasons = chapter.seasons.filter((s) => s.status === status);
      return { status, seasons, note: groupNote(chapter, status) };
    })
    .filter((g) => g.seasons.length > 0 && g.note);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {groups.map((g) => {
        const all = g.seasons.length === chapter.seasons.length;
        const which = all ? `All of ${chapter.label}` : seasonList(g.seasons);
        return (
          <motion.div
            key={g.status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT } }}
            className="flex items-start gap-3 rounded-xl surface-subtle px-4 py-3"
          >
            <Info className={cn("mt-0.5 size-4 shrink-0", g.status === "notFromEpic" ? "text-violet-text" : "text-faint")} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">
                {which} · {statusBadge[g.status].text}.
              </span>{" "}
              {g.note}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
}

function SeasonCard({
  chapter,
  season,
  index,
  owned,
  sharedNote,
  onPick,
}: {
  chapter: CatalogChapter;
  season: CatalogSeason;
  index: number;
  owned: BuildInfo[];
  /** Shown above the cards already – the card then only gets a short line. */
  sharedNote: string;
  onPick: () => void;
}) {
  const available = season.status === "available";
  const badge = statusBadge[season.status];
  const BadgeIcon = badge.icon;
  const smallest = available ? Math.min(...season.builds.map((b) => b.downloadBytes)) : 0;
  const ownedText = ownedLine(owned, available);
  const short = shortLine[season.status];
  const enter = { opacity: 1, y: 0, scale: 1, transition: { duration: 0.38, ease: EASE_OUT, delay: 0.03 * index } };

  if (!available) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={enter}
        className="flex min-h-32 flex-col gap-3 rounded-xl border border-dashed border-white/[0.08] bg-white/[0.012] p-4"
        role="group"
        aria-label={`${chapter.label} ${season.label}: ${badge.text}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-foreground/75">{season.label}</p>
            <p className="text-xs text-faint tabular-nums">{season.versions}</p>
          </div>
          <span className="flex size-7 items-center justify-center rounded-lg bg-white/[0.04] text-faint">
            <BadgeIcon className="size-3.5" />
          </span>
        </div>
        {/* Right under the title, so the badges of one row line up */}
        <div className="flex flex-col gap-2">
          <Badge variant={badge.variant}>{badge.text}</Badge>
          <p className="text-xs leading-snug text-faint">{season.note && season.note !== sharedNote ? season.note : short}</p>
          {ownedText && (
            <p className="flex items-start gap-1.5 text-xs leading-snug text-success">
              <Check className="mt-px size-3.5 shrink-0" strokeWidth={2.5} />
              {ownedText}
            </p>
          )}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={enter} className="flex">
      <GlowCard
        interactive
        initial={false}
        onClick={onPick}
        aria-label={`${chapter.label} ${season.label}: ${season.builds.length} builds to download`}
        className="flex min-h-36 w-full flex-col overflow-hidden"
      >
        <div className={cn("relative h-16 overflow-hidden rounded-t-xl bg-gradient-to-br", coverGradient(season.builds[0]?.version ?? "15.00"))}>
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.14]"
            style={{ backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 16px)", maskImage: "linear-gradient(90deg, transparent, black 70%)" }}
          />
          <span aria-hidden className="absolute right-3 -bottom-2.5 text-4xl font-bold tracking-tighter text-white/[0.16] tabular-nums transition-[translate,color] duration-500 group-hover:-translate-x-1 group-hover:text-white/[0.26]">
            {season.versions}
          </span>
          <Sheen />
          <Badge variant={badge.variant} className="absolute top-3 left-3 bg-black/35 backdrop-blur-md">
            <BadgeIcon />
            {badge.text}
          </Badge>
        </div>
        <div className="flex flex-1 flex-col gap-1 p-4">
          <p className="text-sm font-semibold">{season.label}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {season.builds.length} {season.builds.length === 1 ? "build" : "builds"} · from {formatGB(smallest)}
          </p>
          {ownedText && (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <Check className="size-3.5" strokeWidth={2.5} />
              {ownedText}
            </p>
          )}
          <span className="mt-auto inline-flex items-center gap-1 pt-2 text-xs font-medium text-violet-text">
            Choose a build
            <ArrowRight className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </span>
        </div>
      </GlowCard>
    </motion.div>
  );
}

/**
 * What the user already has of this season: "You have 15.40." on a season to download, and
 * "Your 19.10 keeps working." on one Epic can't deliver any more ("" = nothing).
 */
function ownedLine(owned: BuildInfo[], available: boolean): string {
  const versions = [...new Set(owned.map((b) => b.version))];
  if (versions.length === 0) return "";
  const list = versions.length === 1 ? versions[0] : `${versions.slice(0, -1).join(", ")} and ${versions[versions.length - 1]}`;
  if (available) return `You have ${list}.`;
  return versions.length === 1 ? `Your ${list} keeps working.` : `Your ${list} keep working.`;
}

/** "Season 1", "Seasons 1 and 2", "Seasons 1, 2 and 4", "Season X" … */
function seasonList(seasons: CatalogSeason[]): string {
  const names = seasons.map((s) => s.label.replace(/^Season /, ""));
  if (names.length === 1) return seasons[0].label;
  return `Seasons ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
