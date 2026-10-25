import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleDashed, Clock, FolderOpen, FolderPlus, Loader2, MoreHorizontal, Plus, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, PageShell, Panel, Reveal } from "@/components/common";
import { versionSupport } from "@/lib/demo-data";
import { api, openFolder, pickFolder, type BuildInfo, type DetectReport } from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function LibraryPage() {
  const builds = useApp((s) => s.config.builds);
  const activeBuildId = useApp((s) => s.config.profiles.find((p) => p.id === s.config.activeProfileId)?.buildId);
  const [importOpen, setImportOpen] = useState(false);

  const remove = async (id: string) => {
    const config = await api.removeBuild(id);
    useApp.getState().setConfig(config);
    toast("Aus der Liste entfernt", { description: "Deine Build-Dateien bleiben unangetastet." });
  };

  return (
    <PageShell>
      <PageHeader
        title="Bibliothek"
        description="Deine Fortnite-Builds. Beim Hinzufügen erkennt Vanity die Version automatisch und prüft, ob sie unterstützt wird."
        actions={<Button onClick={() => setImportOpen(true)}><Plus />Build hinzufügen</Button>}
      />

      <Reveal className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {builds.map((build) => (
          <BuildCard key={build.id} build={build} active={build.id === activeBuildId} onOpen={() => openFolder(build.path)} onRemove={() => remove(build.id)} />
        ))}
        <motion.button type="button" whileHover={{ y: -2 }} transition={{ duration: 0.15 }} onClick={() => setImportOpen(true)} className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.12] p-6 text-center text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <div className="flex size-12 items-center justify-center rounded-xl bg-white/[0.05]"><FolderPlus className="size-6" /></div>
          <div>
            <p className="text-sm font-medium text-foreground">Build-Ordner hinzufügen</p>
            <p className="mt-1 text-xs">Den Ordner wählen, in dem „FortniteGame“ liegt.</p>
          </div>
        </motion.button>
      </Reveal>

      <Panel title="Welche Versionen gehen" description="Vanity startet jede Version von 1.7 bis 30.x – Chapter 1 bis Chapter 5 Season 3. Getestet ist bisher nur 19.10; alle anderen sind ungetestet, die Bauteile sind aber dafür gebaut. Neuere Versionen kennt der Game Server noch nicht.">
        <ul className="flex flex-col gap-2">
          {versionSupport.map((v) => (
            <li key={v.version} className="flex items-center gap-4 rounded-lg bg-white/[0.02] px-4 py-3">
              <SupportBadge level={v.level} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{v.version} <span className="font-normal text-muted-foreground">· {v.label}</span></p>
                <p className="mt-0.5 text-xs text-muted-foreground">{v.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </PageShell>
  );
}

function BuildCard({ build, active, onOpen, onRemove }: { build: BuildInfo; active: boolean; onOpen: () => void; onRemove: () => void }) {
  const supported = build.support === "supported";
  const tooOld = build.support === "unsupported";
  return (
    <motion.article whileHover={{ y: -2 }} transition={{ duration: 0.15 }} className="glass overflow-hidden rounded-xl">
      <div className="relative h-28 overflow-hidden bg-gradient-to-br from-primary/40 via-[#2a1f6e]/40 to-[#1f4fd1]/20">
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 18px)" }} />
        <span className="absolute right-4 bottom-1 text-5xl font-bold tracking-tighter text-white/15">{build.version}</span>
        <span className={cn("absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium", supported ? "bg-success/15 text-success" : tooOld ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning")}>
          {supported ? <ShieldCheck className="size-3.5" /> : <Clock className="size-3.5" />}
          {supported ? "Getestet" : tooOld ? "Nicht startbar" : "Ungetestet"}
        </span>
        {active && <span className="absolute top-4 right-4 rounded-md bg-black/30 px-2 py-1 text-xs font-medium">Aktiv</span>}
      </div>
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-sm font-semibold">Fortnite {build.version}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{build.season}{build.changelist ? ` · CL-${build.changelist}` : ""} · {build.engine}</p>
          {build.supportNote && build.supportNote !== "getestet" && <p className="mt-1 text-xs text-muted-foreground">{build.supportNote}</p>}
        </div>
        <p title={build.path} className="selectable truncate rounded-md bg-black/20 px-3 py-2 font-mono text-xs text-muted-foreground">{build.path}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onOpen}><FolderOpen />Ordner öffnen</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Mehr Aktionen"><MoreHorizontal /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem variant="destructive" onClick={onRemove}>Aus Liste entfernen</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </motion.article>
  );
}

function SupportBadge({ level }: { level: string }) {
  const map: Record<string, { icon: typeof Check; text: string; cls: string }> = {
    supported: { icon: Check, text: "Getestet", cls: "bg-success/15 text-success" },
    experimental: { icon: Clock, text: "Ungetestet", cls: "bg-warning/15 text-warning" },
    unsupported: { icon: CircleDashed, text: "Noch nicht", cls: "bg-white/[0.06] text-muted-foreground" },
    later: { icon: CircleDashed, text: "Später", cls: "bg-white/[0.06] text-muted-foreground" },
  };
  const m = map[level] ?? map.later;
  const Icon = m.icon;
  return <span className={cn("inline-flex w-28 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium", m.cls)}><Icon className="size-3.5" />{m.text}</span>;
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [path, setPath] = useState("");
  const [checking, setChecking] = useState(false);
  const [report, setReport] = useState<DetectReport | null>(null);

  useEffect(() => {
    if (!open) {
      setReport(null);
      setChecking(false);
    }
  }, [open]);

  const browse = async () => {
    const p = await pickFolder();
    if (p) {
      setPath(p);
      setReport(null);
    }
  };

  const check = async () => {
    setChecking(true);
    setReport(null);
    try {
      const r = await api.detectBuild(path);
      setReport(r);
    } catch (e) {
      toast.error("Prüfen fehlgeschlagen", { description: String(e) });
    } finally {
      setChecking(false);
    }
  };

  const add = async () => {
    if (!report?.build) return;
    const config = await api.addBuild(report.build);
    useApp.getState().setConfig(config);
    onOpenChange(false);
    toast.success("Build hinzugefügt", { description: `Fortnite ${report.build.version}` });
  };

  const canAdd = report?.build && report.build.support !== "unsupported" && report.checks.every((c) => c.ok);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Build hinzufügen</DialogTitle>
          <DialogDescription>Wähle den Ordner deines Builds. Vanity liest nur – im Ordner wird nichts verändert.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="build-path">Build-Ordner</Label>
          <div className="flex gap-2">
            <Input id="build-path" value={path} onChange={(e) => { setPath(e.target.value); setReport(null); }} placeholder="C:\…\windows-19.10" className="font-mono text-xs" />
            <Button variant="secondary" onClick={browse}>Durchsuchen</Button>
          </div>
        </div>
        <div className="min-h-36 rounded-lg bg-black/20 p-4">
          {!report && !checking && <p className="text-xs text-muted-foreground">Klick auf „Prüfen“. Vanity sucht die Spieldatei und liest die Version aus.</p>}
          {checking && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />Prüfe …</div>}
          {report && (
            <ul className="flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {report.checks.map((c, i) => (
                  <motion.li key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2 text-xs">
                    {c.ok ? <Check className="size-4 text-success" /> : <X className="size-4 text-destructive" />}
                    <span className={c.ok ? "" : "text-destructive"}>{c.text}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Abbrechen</Button>
          {report ? (
            <Button onClick={add} disabled={!canAdd}><Check />Hinzufügen</Button>
          ) : (
            <Button onClick={check} disabled={!path || checking}>{checking && <Loader2 className="animate-spin" />}Prüfen</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

