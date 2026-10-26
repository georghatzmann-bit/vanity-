import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown, ArrowDownToLine, Copy, Eraser, FolderOpen, ScrollText, Search, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState, PageHeader, PageShell } from "@/components/common";
import { GlowCard, NumberTicker } from "@/components/fx";
import { pageGroup, pageLabel } from "@/components/layout/nav";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { api, openFolder, type LogLine } from "@/lib/api";
import { EASE_OUT } from "@/lib/motion";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

type Source = LogLine["source"];
type Level = LogLine["level"];

const sourceLabel: Record<Source, string> = { game: "Game", server: "Server", backend: "Backend", launcher: "Niobium" };

/**
 * Topics: lines of our own server DLL get their own category (Rust `logparse.rs`, `tagged_line`):
 * `[NiobiumLoot]` → "loot", `[PlayerBots]` → "bots", `[LivingWorld]` → "livingWorld".
 */
const topics = [
  { category: "loot", label: "Loot" },
  { category: "bots", label: "AI bots" },
  { category: "livingWorld", label: "Bosses & NPCs" },
] as const;
type Topic = (typeof topics)[number]["category"];
const levelStyle: Record<Level, { label: string; text: string; dot: string }> = {
  info: { label: "Info", text: "text-muted-foreground", dot: "bg-muted-foreground/70" },
  warning: { label: "Warning", text: "text-warning", dot: "bg-warning shadow-[0_0_6px_rgb(245_158_11/0.7)]" },
  error: { label: "Error", text: "text-destructive", dot: "bg-destructive shadow-[0_0_6px_rgb(239_68_68/0.7)]" },
};

/** Stable row keys: log lines are plain objects that stay the same while the list grows or gets trimmed. */
const rowIds = new WeakMap<LogLine, number>();
let nextRowId = 1;
function rowId(line: LogLine): number {
  let id = rowIds.get(line);
  if (id === undefined) {
    id = nextRowId++;
    rowIds.set(line, id);
  }
  return id;
}

export function LogsPage() {
  const logs = useApp((s) => s.logs);
  const clearLogs = useApp((s) => s.clearLogs);
  const calm = useCalmMotion();
  const [source, setSource] = useState<"all" | Source>("all");
  const [levels, setLevels] = useState<Level[]>(["info", "warning", "error"]);
  /** "" = every topic */
  const [topic, setTopic] = useState<Topic | "">("");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  // Every line gets its id when it arrives (hidden ones too), so ids follow the arrival order
  useMemo(() => {
    for (const l of logs) rowId(l);
  }, [logs]);
  // Lines that were already there when the page opened don't slide in – only new ones do
  const [firstNewId] = useState(() => nextRowId);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (source === "all" || l.source === source) &&
        levels.includes(l.level) &&
        (!topic || l.category === topic) &&
        (!q || `${l.category} ${l.message}`.toLowerCase().includes(q)),
    );
  }, [logs, source, levels, topic, query]);

  const counts = useMemo(
    () => ({
      info: logs.filter((l) => l.level === "info").length,
      warning: logs.filter((l) => l.level === "warning").length,
      error: logs.filter((l) => l.level === "error").length,
    }),
    [logs],
  );
  const spotted = useMemo(() => logs.filter((l) => l.detected).length, [logs]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  const copyAll = async () => {
    const text = visible.map((l) => `[${l.time}] [${sourceLabel[l.source]}] ${l.category}: ${l.message}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Log copied", { description: `${visible.length} ${visible.length === 1 ? "line" : "lines"}` });
    } catch {
      toast.error("Couldn't copy");
    }
  };

  const openLogs = async () => {
    const p = await api.paths();
    openFolder(p.logs);
  };

  const filtered = visible.length !== logs.length;

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("logs")}
        title={pageLabel("logs")}
        icon={ScrollText}
        description="Everything the game, the server, the backend and Niobium write right now. Niobium spots important lines and marks them."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={openLogs}>
              <FolderOpen />
              Folder
            </Button>
            <Button variant="secondary" size="sm" onClick={copyAll} disabled={visible.length === 0}>
              <Copy />
              Copy
            </Button>
          </>
        }
      />

      <GlowCard className="flex flex-col">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 px-4 pt-4 pb-3">
          <ToggleGroup type="single" value={source} onValueChange={(v) => v && setSource(v as typeof source)} aria-label="Show lines from">
            <ToggleGroupItem value="all" className="px-3">
              All
            </ToggleGroupItem>
            {(Object.keys(sourceLabel) as Source[]).map((s) => (
              <ToggleGroupItem key={s} value={s} className="px-3">
                {sourceLabel[s]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup type="multiple" value={levels} onValueChange={(v) => setLevels(v as Level[])} aria-label="Show levels" className="gap-1">
            {(Object.keys(levelStyle) as Level[]).map((lv) => (
              <ToggleGroupItem key={lv} value={lv} className="gap-2 px-3">
                <span className={cn("size-1.5 rounded-full", levelStyle[lv].dot)} />
                <span>{levelStyle[lv].label}</span>
                <NumberTicker value={counts[lv]} fromZero={false} className="font-mono text-[11px] text-faint" />
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {/* One topic at a time; click it again to see everything */}
          <ToggleGroup type="single" value={topic} onValueChange={(v) => setTopic(v as Topic | "")} aria-label="Show only one topic" className="gap-1">
            {topics.map((t) => (
              <ToggleGroupItem key={t.category} value={t.category} className="px-3">
                {t.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search the log…"
              aria-label="Search the log"
              className="pr-9 pl-9"
            />
            <AnimatePresence>
              {query && (
                <motion.button
                  type="button"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  transition={{ duration: 0.12 }}
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="focus-ring absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                >
                  <X className="size-3.5" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between gap-3 border-y border-white/[0.06] bg-black/15 px-4 py-2 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-4">
            <span className={cn("inline-flex items-center gap-2 font-medium", follow ? "text-success" : "text-muted-foreground")}>
              <span className="relative flex size-2">
                {follow && <span className="nb-loop absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />}
                <span className={cn("relative inline-flex size-2 rounded-full", follow ? "bg-success shadow-[0_0_8px_rgb(34_197_94/0.7)]" : "bg-muted-foreground/60")} />
              </span>
              {follow ? "Live" : "Paused"}
            </span>
            <span className="truncate tabular-nums">
              {filtered ? (
                <>
                  <NumberTicker value={visible.length} fromZero={false} /> of <NumberTicker value={logs.length} fromZero={false} /> lines
                </>
              ) : (
                <>
                  <NumberTicker value={logs.length} fromZero={false} /> {logs.length === 1 ? "line" : "lines"}
                </>
              )}
            </span>
            {spotted > 0 && (
              <span className="hidden items-center gap-1.5 text-violet-text sm:inline-flex">
                <Sparkles className="size-3" />
                <NumberTicker value={spotted} fromZero={false} /> spotted
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setFollow(!follow)}
              aria-pressed={follow}
              className={cn(follow && "text-violet-text")}
            >
              <ArrowDownToLine />
              Auto-scroll {follow ? "on" : "off"}
            </Button>
            <Button variant="ghost" size="xs" onClick={clearLogs} disabled={logs.length === 0}>
              <Eraser />
              Clear
            </Button>
          </div>
        </div>

        {/* Lines */}
        <div className="relative">
          <div ref={scroller} className="selectable h-[calc(100vh-372px)] min-h-72 overflow-y-auto py-2 font-mono text-xs">
            {visible.length === 0 ? (
              <div className="p-6 font-sans">
                <EmptyState
                  icon={logs.length === 0 ? ScrollText : Search}
                  title={logs.length === 0 ? "Nothing in the log yet" : "No matching lines"}
                  hint={logs.length === 0 ? "As soon as you start something, the lines show up here live." : "Change the filters or the search above."}
                />
              </div>
            ) : (
              visible.map((l) => {
                const id = rowId(l);
                const fresh = !calm && id >= firstNewId;
                return (
                  <div
                    key={id}
                    className={cn(
                      "grid grid-cols-[88px_64px_minmax(0,1fr)] gap-3 px-4 py-[3px] leading-5 transition-colors hover:bg-white/[0.035]",
                      fresh && "animate-in fade-in-0 slide-in-from-left-1 duration-300",
                      l.level === "error" && "bg-destructive/[0.07] shadow-[inset_2px_0_0_rgb(239_68_68/0.75)]",
                      l.level === "warning" && "bg-warning/[0.05] shadow-[inset_2px_0_0_rgb(245_158_11/0.6)]",
                      l.detected && "bg-brand-violet/[0.08] shadow-[inset_2px_0_0_rgb(139_92_246/0.85)]",
                    )}
                  >
                    <span className="text-faint tabular-nums">{l.time}</span>
                    <span className="truncate text-muted-foreground">{sourceLabel[l.source]}</span>
                    <span className="min-w-0 break-words">
                      <span className={cn("mr-2", levelStyle[l.level].text)}>{l.category}</span>
                      <span className={cn(l.level === "error" && "text-destructive", l.level === "warning" && "text-warning")}>{l.message}</span>
                      {l.detected && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-brand-violet/15 px-2 py-px align-[1px] font-sans text-[11px] font-medium text-violet-text ring-1 ring-brand-violet/30 ring-inset">
                          <Sparkles className="size-3" />
                          {l.detected}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          {/* Paused with lines below: one click brings you back to the newest line */}
          <AnimatePresence>
            {!follow && visible.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2, ease: EASE_OUT }}
                className="absolute right-4 bottom-4"
              >
                <Button size="sm" onClick={() => setFollow(true)} className="rounded-full shadow-[0_10px_30px_-10px_rgb(139_92_246/0.8)]">
                  <ArrowDown />
                  Back to live
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </GlowCard>
    </PageShell>
  );
}
