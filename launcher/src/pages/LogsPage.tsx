import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { ArrowDownToLine, Copy, Eraser, FolderOpen, Pause, Play, RotateCcw, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState, PageHeader, PageShell, Reveal } from "@/components/common";
import { demoLogScript, type LogLevel, type LogLine, type LogSource } from "@/lib/demo-data";
import { previewToast } from "@/lib/preview";
import { cn } from "@/lib/utils";

interface ShownLine extends LogLine {
  id: number;
  time: string;
}

/** Log-Zeilen bleiben erhalten, wenn man die Seite wechselt. */
const useLogStore = create<{
  lines: ShownLine[];
  next: number;
  paused: boolean;
  push: (line: LogLine) => void;
  clear: () => void;
  restart: () => void;
  setPaused: (p: boolean) => void;
}>((set) => ({
  lines: [],
  next: 0,
  paused: false,
  push: (line) =>
    set((s) => {
      const now = new Date();
      const time = now.toLocaleTimeString("de-DE", { hour12: false }) + "." + String(now.getMilliseconds()).padStart(3, "0");
      return { lines: [...s.lines, { ...line, id: s.next, time }].slice(-2000), next: s.next + 1 };
    }),
  clear: () => set({ lines: [] }),
  restart: () => set({ lines: [], next: 0, paused: false }),
  setPaused: (paused) => set({ paused }),
}));

const sourceLabel: Record<LogSource, string> = {
  game: "Spiel",
  server: "Server",
  backend: "Backend",
  launcher: "Vanity",
};

const levelStyle: Record<LogLevel, { label: string; cls: string }> = {
  info: { label: "Info", cls: "text-muted-foreground" },
  warning: { label: "Warnung", cls: "text-warning" },
  error: { label: "Fehler", cls: "text-destructive" },
};

export function LogsPage() {
  const { lines, next, paused, push, clear, restart, setPaused } = useLogStore();
  const [source, setSource] = useState<"all" | LogSource>("all");
  const [levels, setLevels] = useState<LogLevel[]>(["info", "warning", "error"]);
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  // Vorschau: Beispiel-Zeilen nach und nach „live“ einspielen
  useEffect(() => {
    if (paused || next >= demoLogScript.length) return;
    const t = window.setTimeout(() => push(demoLogScript[next]), next === 0 ? 300 : 260 + Math.random() * 380);
    return () => window.clearTimeout(t);
  }, [next, paused, push]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (source === "all" || l.source === source) &&
        levels.includes(l.level) &&
        (!q || `${l.category} ${l.message}`.toLowerCase().includes(q)),
    );
  }, [lines, source, levels, query]);

  const counts = useMemo(
    () => ({
      info: lines.filter((l) => l.level === "info").length,
      warning: lines.filter((l) => l.level === "warning").length,
      error: lines.filter((l) => l.level === "error").length,
    }),
    [lines],
  );

  // Automatisch nach unten scrollen, solange „Mitlaufen“ an ist
  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [visible, follow]);

  const copyAll = async () => {
    const text = visible.map((l) => `[${l.time}] [${sourceLabel[l.source]}] ${l.category}: ${l.message}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Log kopiert", { description: `${visible.length} Zeilen in der Zwischenablage` });
    } catch {
      toast.error("Kopieren hat nicht geklappt");
    }
  };

  return (
    <PageShell>
      <PageHeader
        title="Live-Log"
        description="Alles, was Spiel, Server, Backend und Vanity gerade schreiben. Wichtige Stellen erkennt Vanity selbst und markiert sie."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => previewToast("Log-Ordner öffnen", 2)}>
              <FolderOpen />
              Ordner
            </Button>
            <Button variant="secondary" size="sm" onClick={copyAll} disabled={visible.length === 0}>
              <Copy />
              Kopieren
            </Button>
          </>
        }
      />

      <Reveal className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          type="single"
          value={source}
          onValueChange={(v) => v && setSource(v as typeof source)}
          className="bg-white/[0.04]"
        >
          <ToggleGroupItem value="all" className="px-3">Alle</ToggleGroupItem>
          {(Object.keys(sourceLabel) as LogSource[]).map((s) => (
            <ToggleGroupItem key={s} value={s} className="px-3">
              {sourceLabel[s]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <ToggleGroup
          type="multiple"
          value={levels}
          onValueChange={(v) => setLevels(v as LogLevel[])}
          className="bg-white/[0.04]"
          aria-label="Stufen anzeigen"
        >
          {(Object.keys(levelStyle) as LogLevel[]).map((lv) => (
            <ToggleGroupItem key={lv} value={lv} className="gap-2 px-3">
              <span className={levelStyle[lv].cls}>{levelStyle[lv].label}</span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">{counts[lv]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Im Log suchen …"
            className="pl-9"
          />
        </div>
      </Reveal>

      <Reveal className="glass flex flex-col overflow-hidden rounded-xl">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-2 text-xs text-muted-foreground">
          <span>
            {visible.length} von {lines.length} Zeilen
            {next < demoLogScript.length && !paused && " · Beispiel läuft …"}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => setPaused(!paused)} disabled={next >= demoLogScript.length}>
              {paused ? <Play /> : <Pause />}
              {paused ? "Weiter" : "Pause"}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setFollow(!follow)}
              className={cn(follow && "text-primary-text")}
            >
              <ArrowDownToLine />
              Mitlaufen {follow ? "an" : "aus"}
            </Button>
            <Button variant="ghost" size="xs" onClick={clear} disabled={lines.length === 0}>
              <Eraser />
              Leeren
            </Button>
            <Button variant="ghost" size="xs" onClick={restart}>
              <RotateCcw />
              Beispiel neu
            </Button>
          </div>
        </div>

        <div ref={scroller} className="selectable h-[calc(100vh-340px)] min-h-72 overflow-y-auto py-2 font-mono text-xs">
          {visible.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={Search}
                title={lines.length === 0 ? "Noch nichts im Log" : "Keine passenden Zeilen"}
                hint={
                  lines.length === 0
                    ? "Sobald du etwas startest, erscheinen hier die Zeilen live."
                    : "Ändere die Filter oder die Suche oben."
                }
              />
            </div>
          ) : (
            visible.map((l) => (
              <div
                key={l.id}
                className={cn(
                  "grid grid-cols-[92px_64px_minmax(0,1fr)] gap-3 px-4 py-1 leading-5 hover:bg-white/[0.03]",
                  l.level === "error" && "bg-destructive/[0.08]",
                  l.level === "warning" && "bg-warning/[0.05]",
                  l.detected && "bg-primary/[0.08]",
                )}
              >
                <span className="text-muted-foreground tabular-nums">{l.time}</span>
                <span className="text-muted-foreground">{sourceLabel[l.source]}</span>
                <span className="min-w-0 break-words">
                  <span className={cn("mr-2", levelStyle[l.level].cls)}>{l.category}</span>
                  <span className={cn(l.level === "error" && "text-destructive", l.level === "warning" && "text-warning")}>
                    {l.message}
                  </span>
                  {l.detected && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 font-sans text-primary-text">
                      <Sparkles className="size-3" />
                      {l.detected}
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </Reveal>
    </PageShell>
  );
}
