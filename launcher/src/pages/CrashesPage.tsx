import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Copy, FolderOpen, Lightbulb, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, PageShell, Reveal } from "@/components/common";
import { api, openFolder, type CrashReport } from "@/lib/api";
import { cn } from "@/lib/utils";

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
  useEffect(() => { load(); }, []);

  const selected = crashes.find((c) => c.id === selectedId);

  return (
    <PageShell>
      <PageHeader
        title="Absturz-Analyse"
        description="Wenn Fortnite abstürzt, liest Vanity den Absturzbericht und erklärt in einfachen Worten, was los war und was du tun kannst."
        actions={<Button variant="secondary" size="sm" onClick={load}><RefreshCw className={cn(loading && "animate-spin")} />Neu laden</Button>}
      />

      {crashes.length === 0 ? (
        <Reveal>
          <EmptyState icon={ShieldCheck} title={loading ? "Suche Absturzberichte …" : "Keine Abstürze gefunden"} hint="Sehr gut. Falls doch mal etwas passiert, erscheint es automatisch hier." />
        </Reveal>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Reveal className="flex flex-col gap-2">
            {crashes.map((c) => (
              <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} className={cn("glass relative flex flex-col gap-1 rounded-xl px-4 py-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50", c.id === selectedId ? "bg-white/[0.08]" : "hover:bg-white/[0.05]")}>
                {c.id === selectedId && <motion.span layoutId="crash-active" className="absolute top-3 bottom-3 left-0 w-[3px] rounded-full bg-primary-text" />}
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{c.title}</p>
                  <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-xs font-medium", c.severity === "high" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning")}>{c.severity === "high" ? "Schwer" : "Mittel"}</span>
                </div>
                <p className="text-xs text-muted-foreground">{formatTime(c.time)} · Version {c.version}</p>
              </button>
            ))}
          </Reveal>
          <AnimatePresence mode="wait">
            {selected && (
              <motion.div key={selected.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} transition={{ duration: 0.16 }}>
                <CrashDetail crash={selected} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </PageShell>
  );
}

function formatTime(secs: number): string {
  if (!secs) return "unbekannt";
  const d = new Date(secs * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Heute, ${time}` : `${d.toLocaleDateString("de-DE")}, ${time}`;
}

function CrashDetail({ crash }: { crash: CrashReport }) {
  const [showTech, setShowTech] = useState(false);

  const copyReport = async () => {
    const text = [
      `Absturz: ${crash.title} (${formatTime(crash.time)}, Version ${crash.version})`,
      `Was passiert ist: ${crash.whatHappened}`,
      `Wahrscheinliche Ursache: ${crash.likelyCause}`,
      ...crash.technical.map(([k, v]) => `${k}: ${v}`),
      "Aufrufliste:", ...crash.callstack,
    ].join("\n");
    try { await navigator.clipboard.writeText(text); toast.success("Bericht kopiert", { description: "Du kannst ihn jetzt an mich schicken." }); } catch { toast.error("Kopieren hat nicht geklappt"); }
  };

  return (
    <article className="glass flex flex-col gap-6 rounded-xl p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{crash.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{formatTime(crash.time)} · Fortnite {crash.version}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => openFolder(crash.folder)}><FolderOpen />Ordner</Button>
          <Button variant="secondary" size="sm" onClick={copyReport}><Copy />Bericht kopieren</Button>
        </div>
      </header>

      <section>
        <h3 className="text-sm font-semibold">Was ist passiert?</h3>
        <p className="mt-2 text-sm leading-relaxed text-foreground/90">{crash.whatHappened}</p>
      </section>
      <section className="rounded-lg bg-warning/[0.07] p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-warning"><TriangleAlert className="size-4" />Woran lag es wahrscheinlich?</h3>
        <p className="mt-2 text-sm leading-relaxed text-foreground/90">{crash.likelyCause}</p>
      </section>
      <section className="rounded-lg bg-success/[0.06] p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-success"><Lightbulb className="size-4" />Was du tun kannst</h3>
        <ol className="mt-3 flex flex-col gap-2">
          {crash.whatToDo.map((step, i) => (
            <li key={i} className="flex gap-3 text-sm"><span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/20 text-xs font-semibold text-success">{i + 1}</span><span className="text-foreground/90">{step}</span></li>
          ))}
        </ol>
      </section>

      {(crash.technical.length > 0 || crash.callstack.length > 0) && (
        <section>
          <button type="button" onClick={() => setShowTech(!showTech)} aria-expanded={showTech} className="flex items-center gap-2 rounded-md text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <motion.span animate={{ rotate: showTech ? 180 : 0 }} transition={{ duration: 0.15 }}><ChevronDown className="size-4" /></motion.span>Technische Details
          </button>
          <AnimatePresence initial={false}>
            {showTech && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
                <div className="selectable mt-3 flex flex-col gap-3 rounded-lg bg-black/25 p-4 font-mono text-xs">
                  {crash.technical.map(([k, v], i) => <div key={i} className="grid grid-cols-[80px_minmax(0,1fr)] gap-3"><span className="text-muted-foreground">{k}</span><span className="break-all">{v}</span></div>)}
                  {crash.callstack.length > 0 && <div className="border-t border-white/[0.06] pt-3 text-muted-foreground">{crash.callstack.map((line, i) => <p key={i}>{line}</p>)}</div>}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
    </article>
  );
}
