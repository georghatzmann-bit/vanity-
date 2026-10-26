import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bug, ChevronDown, Clock3, Copy, FileWarning, Flame, FolderOpen, Lightbulb, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, IconTile, PageHeader, PageShell, Reveal, type IconTone } from "@/components/common";
import { GlowCard, NumberTicker, Skeleton, Stagger } from "@/components/fx";
import { pageGroup, pageLabel } from "@/components/layout/nav";
import { api, openFolder, type CrashReport } from "@/lib/api";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { cn } from "@/lib/utils";

const severityText: Record<CrashReport["severity"], string> = { high: "Severe", medium: "Medium" };

export function CrashesPage() {
  const [crashes, setCrashes] = useState<CrashReport[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const list = await api.listCrashes();
      setCrashes(list);
      setSelectedId((cur) => cur ?? list[0]?.id);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const selected = crashes.find((c) => c.id === selectedId);
  const severe = crashes.filter((c) => c.severity === "high").length;
  const latest = crashes.reduce((t, c) => Math.max(t, c.time || 0), 0);

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("crashes")}
        title={pageLabel("crashes")}
        icon={Bug}
        description="When Fortnite crashes, Niobium reads the crash report and explains in plain words what happened and what you can do."
        actions={
          <Button variant="secondary" size="sm" onClick={load}>
            <RefreshCw className={cn(loading && "animate-spin")} />
            Reload
          </Button>
        }
      />

      {crashes.length === 0 ? (
        loading ? (
          <Reveal kind="fade">
            <CrashesSkeleton />
          </Reveal>
        ) : (
          <Reveal>
            <EmptyState icon={ShieldCheck} title="No crashes found" hint="Great. If something ever goes wrong, it shows up here on its own." className="py-16" />
          </Reveal>
        )
      ) : (
        <>
          {/* Short summary on top */}
          <Stagger className="grid gap-4 sm:grid-cols-3">
            <SummaryTile icon={FileWarning} tone="brand" label="Crash reports">
              <NumberTicker value={crashes.length} />
            </SummaryTile>
            <SummaryTile icon={Flame} tone={severe > 0 ? "danger" : "success"} label="Severe">
              <NumberTicker value={severe} />
            </SummaryTile>
            <SummaryTile icon={Clock3} tone="muted" label="Last crash">
              {relativeTime(latest)}
            </SummaryTile>
          </Stagger>

          <div className="grid items-start gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            <Stagger className="flex flex-col gap-2" delay={0.08}>
              {crashes.map((c) => {
                const active = c.id === selectedId;
                return (
                  <GlowCard
                    key={c.id}
                    kind="slide"
                    interactive
                    glow={active}
                    onClick={() => setSelectedId(c.id)}
                    aria-pressed={active}
                    aria-label={`${c.title}, ${formatTime(c.time)}`}
                    className={cn("overflow-hidden px-4 py-3.5", active && "bg-white/[0.05]")}
                  >
                    {active && (
                      <motion.span
                        layoutId="crash-active"
                        transition={SPRING_UI}
                        className="absolute top-3 bottom-3 left-0 w-[3px] rounded-r-full bg-brand shadow-[0_0_10px_rgb(139_92_246/0.9)]"
                      />
                    )}
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 text-sm leading-snug font-medium">{c.title}</p>
                      <Badge variant={c.severity === "high" ? "destructive" : "warning"} className="mt-px">
                        {severityText[c.severity]}
                      </Badge>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                      {formatTime(c.time)} · Fortnite {c.version}
                    </p>
                  </GlowCard>
                );
              })}
            </Stagger>

            <AnimatePresence mode="wait">
              {selected && (
                <motion.div
                  key={selected.id}
                  initial={{ opacity: 0, x: 12, filter: "blur(4px)" }}
                  animate={{ opacity: 1, x: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
                  exit={{ opacity: 0, x: -8, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.3, ease: EASE_OUT }}
                  className="min-w-0"
                >
                  <CrashDetail crash={selected} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </>
      )}
    </PageShell>
  );
}

function SummaryTile({ icon, tone, label, children }: { icon: typeof Bug; tone: IconTone; label: string; children: ReactNode }) {
  return (
    <GlowCard kind="scale" className="flex items-center gap-4 px-5 py-4">
      <IconTile icon={icon} tone={tone} size="md" />
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</p>
        <p className="mt-0.5 truncate text-xl font-semibold tracking-tight tabular-nums">{children}</p>
      </div>
    </GlowCard>
  );
}

function CrashesSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]" aria-label="Looking for crash reports…" role="status">
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="glass flex flex-col gap-2 rounded-xl px-4 py-3.5">
            <div className="flex justify-between gap-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-12 rounded-full" />
            </div>
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
      <div className="glass flex flex-col gap-4 rounded-xl p-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-3 w-36" />
        <Skeleton className="mt-2 h-16 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function formatTime(secs: number): string {
  if (!secs) return "Unknown time";
  const d = new Date(secs * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today, ${clock(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${clock(d)}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${clock(d)}`;
}

/** "5 min ago", "2 h ago", "3 days ago". */
function relativeTime(secs: number): string {
  if (!secs) return "Unknown";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  const days = Math.floor(diff / 86400);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function CrashDetail({ crash }: { crash: CrashReport }) {
  const [showTech, setShowTech] = useState(false);
  const high = crash.severity === "high";

  const copyReport = async () => {
    const text = [
      `Crash: ${crash.title} (${formatTime(crash.time)}, version ${crash.version})`,
      `What happened: ${crash.whatHappened}`,
      `Likely cause: ${crash.likelyCause}`,
      ...crash.technical.map(([k, v]) => `${k}: ${v}`),
      "Call stack:",
      ...crash.callstack,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Report copied", { description: "You can paste it into a message now." });
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <article className="glass relative flex flex-col gap-6 overflow-hidden rounded-xl p-6">
      {/* soft light in the colour of the severity */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-32 -right-24 size-80 rounded-full",
          high ? "bg-[radial-gradient(closest-side,rgb(239_68_68/0.16),transparent)]" : "bg-[radial-gradient(closest-side,rgb(245_158_11/0.14),transparent)]",
        )}
      />
      <header className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <IconTile icon={high ? Flame : TriangleAlert} tone={high ? "danger" : "warning"} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{crash.title}</h2>
              <Badge variant={high ? "destructive" : "warning"}>{severityText[crash.severity]}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {formatTime(crash.time)} · Fortnite {crash.version}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => openFolder(crash.folder)}>
            <FolderOpen />
            Folder
          </Button>
          <Button variant="secondary" size="sm" onClick={copyReport}>
            <Copy />
            Copy report
          </Button>
        </div>
      </header>

      <Stagger className="relative flex flex-col gap-4" delay={0.05} stagger={0.06}>
        <Reveal>
          <h3 className="text-[15px] font-semibold">What happened?</h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/90">{crash.whatHappened}</p>
        </Reveal>
        <Reveal className="rounded-lg bg-warning/[0.07] p-4 shadow-[inset_0_0_0_1px_rgb(245_158_11/0.14)]">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-warning">
            <TriangleAlert className="size-4" />
            What probably caused it?
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-foreground/90">{crash.likelyCause}</p>
        </Reveal>
        <Reveal className="rounded-lg bg-success/[0.06] p-4 shadow-[inset_0_0_0_1px_rgb(34_197_94/0.14)]">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-success">
            <Lightbulb className="size-4" />
            What you can do
          </h3>
          <Stagger className="mt-3 flex flex-col gap-2.5" delay={0.2} stagger={0.07}>
            {crash.whatToDo.map((step, i) => (
              <Reveal key={i} kind="slide" className="flex gap-3 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/20 text-xs font-semibold text-success tabular-nums ring-1 ring-success/30">
                  {i + 1}
                </span>
                <span className="text-foreground/90">{step}</span>
              </Reveal>
            ))}
          </Stagger>
        </Reveal>

        {(crash.technical.length > 0 || crash.callstack.length > 0) && (
          <Reveal>
            <button
              type="button"
              onClick={() => setShowTech(!showTech)}
              aria-expanded={showTech}
              className="flex items-center gap-2 rounded-md text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <motion.span animate={{ rotate: showTech ? 180 : 0 }} transition={{ duration: 0.18 }}>
                <ChevronDown className="size-4" />
              </motion.span>
              Technical details
            </button>
            <AnimatePresence initial={false}>
              {showTech && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                  className="overflow-hidden"
                >
                  <div className="selectable mt-3 flex flex-col gap-3 rounded-lg bg-black/30 p-4 font-mono text-xs shadow-[inset_0_0_0_1px_rgb(255_255_255/0.05)]">
                    {crash.technical.map(([k, v], i) => (
                      <div key={i} className="grid grid-cols-[80px_minmax(0,1fr)] gap-3">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="break-all">{v}</span>
                      </div>
                    ))}
                    {crash.callstack.length > 0 && (
                      <div className="border-t border-white/[0.06] pt-3 text-muted-foreground">
                        {crash.callstack.map((line, i) => (
                          <p key={i} className="break-all">
                            {line}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Reveal>
        )}
      </Stagger>
    </article>
  );
}
