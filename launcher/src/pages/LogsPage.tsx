import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Eraser, FolderOpen, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState, PageHeader, PageShell, Reveal } from "@/components/common";
import { api, openFolder, type LogLine } from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

type Source = LogLine["source"];
type Level = LogLine["level"];

const sourceLabel: Record<Source, string> = { game: "Spiel", server: "Server", backend: "Backend", launcher: "Vanity" };
const levelStyle: Record<Level, { label: string; cls: string }> = {
  info: { label: "Info", cls: "text-muted-foreground" },
  warning: { label: "Warnung", cls: "text-warning" },
  error: { label: "Fehler", cls: "text-destructive" },
};

export function LogsPage() {
  const logs = useApp((s) => s.logs);
  const clearLogs = useApp((s) => s.clearLogs);
  const [source, setSource] = useState<"all" | Source>("all");
  const [levels, setLevels] = useState<Level[]>(["info", "warning", "error"]);
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((l) => (source === "all" || l.source === source) && levels.includes(l.level) && (!q || `${l.category} ${l.message}`.toLowerCase().includes(q)));
  }, [logs, source, levels, query]);

  const counts = useMemo(() => ({
    info: logs.filter((l) => l.level === "info").length,
    warning: logs.filter((l) => l.level === "warning").length,
    error: logs.filter((l) => l.level === "error").length,
  }), [logs]);

  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  const copyAll = async () => {
    const text = visible.map((l) => `[${l.time}] [${sourceLabel[l.source]}] ${l.category}: ${l.message}`).join("\n");
    try { await navigator.clipboard.writeText(text); toast.success("Log kopiert", { description: `${visible.length} Zeilen` }); } catch { toast.error("Kopieren hat nicht geklappt"); }
  };

  const openLogs = async () => {
    const p = await api.paths();
    openFolder(p.logs);
  };

  return (
    <PageShell>
      <PageHeader
        title="Live-Log"
        description="Alles, was Spiel, Server, Backend und Vanity gerade schreiben. Wichtige Stellen erkennt Vanity selbst und markiert sie."
        actions={<><Button variant="secondary" size="sm" onClick={openLogs}><FolderOpen />Ordner</Button><Button variant="secondary" size="sm" onClick={copyAll} disabled={visible.length === 0}><Copy />Kopieren</Button></>}
      />

      <Reveal className="flex flex-wrap items-center gap-3">
        <ToggleGroup type="single" value={source} onValueChange={(v) => v && setSource(v as typeof source)} className="bg-white/[0.04]">
          <ToggleGroupItem value="all" className="px-3">Alle</ToggleGroupItem>
          {(Object.keys(sourceLabel) as Source[]).map((s) => <ToggleGroupItem key={s} value={s} className="px-3">{sourceLabel[s]}</ToggleGroupItem>)}
        </ToggleGroup>
        <ToggleGroup type="multiple" value={levels} onValueChange={(v) => setLevels(v as Level[])} className="bg-white/[0.04]" aria-label="Stufen anzeigen">
          {(Object.keys(levelStyle) as Level[]).map((lv) => <ToggleGroupItem key={lv} value={lv} className="gap-2 px-3"><span className={levelStyle[lv].cls}>{levelStyle[lv].label}</span><span className="font-mono text-xs text-muted-foreground tabular-nums">{counts[lv]}</span></ToggleGroupItem>)}
        </ToggleGroup>
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Im Log suchen …" className="pl-9" />
        </div>
      </Reveal>

      <Reveal className="glass flex flex-col overflow-hidden rounded-xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-2 text-xs text-muted-foreground">
          <span>{visible.length} von {logs.length} Zeilen</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => setFollow(!follow)} className={cn(follow && "text-primary-text")}><ArrowDownToLine />Mitlaufen {follow ? "an" : "aus"}</Button>
            <Button variant="ghost" size="xs" onClick={clearLogs} disabled={logs.length === 0}><Eraser />Leeren</Button>
          </div>
        </div>
        <div ref={scroller} className="selectable h-[calc(100vh-340px)] min-h-72 overflow-y-auto py-2 font-mono text-xs">
          {visible.length === 0 ? (
            <div className="p-6"><EmptyState icon={Search} title={logs.length === 0 ? "Noch nichts im Log" : "Keine passenden Zeilen"} hint={logs.length === 0 ? "Sobald du etwas startest, erscheinen hier die Zeilen live." : "Ändere die Filter oder die Suche oben."} /></div>
          ) : (
            visible.map((l, i) => (
              <div key={i} className={cn("grid grid-cols-[92px_64px_minmax(0,1fr)] gap-3 px-4 py-1 leading-5 hover:bg-white/[0.03]", l.level === "error" && "bg-destructive/[0.08]", l.level === "warning" && "bg-warning/[0.05]", l.detected && "bg-primary/[0.08]")}>
                <span className="text-muted-foreground tabular-nums">{l.time}</span>
                <span className="text-muted-foreground">{sourceLabel[l.source]}</span>
                <span className="min-w-0 break-words">
                  <span className={cn("mr-2", levelStyle[l.level].cls)}>{l.category}</span>
                  <span className={cn(l.level === "error" && "text-destructive", l.level === "warning" && "text-warning")}>{l.message}</span>
                  {l.detected && <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 font-sans text-primary-text"><Sparkles className="size-3" />{l.detected}</span>}
                </span>
              </div>
            ))
          )}
        </div>
      </Reveal>
    </PageShell>
  );
}
