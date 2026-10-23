import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CircleDashed,
  Clock,
  FolderOpen,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, PageShell, Panel, Reveal } from "@/components/common";
import { demoBuilds, versionSupport, type SupportLevel } from "@/lib/demo-data";
import { previewToast } from "@/lib/preview";
import { cn } from "@/lib/utils";

export function LibraryPage() {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <PageShell>
      <PageHeader
        title="Bibliothek"
        description="Deine Fortnite-Builds. Beim Hinzufügen erkennt Vanity die Version automatisch und prüft, ob sie unterstützt wird."
        actions={
          <Button onClick={() => setImportOpen(true)}>
            <Plus />
            Build hinzufügen
          </Button>
        }
      />

      <Reveal className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {demoBuilds.map((build) => (
          <motion.article
            key={build.id}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.15 }}
            className="glass overflow-hidden rounded-xl"
          >
            {/* Kopfbereich mit großer Season-Kennung */}
            <div className="relative h-28 overflow-hidden bg-gradient-to-br from-primary/40 via-[#2a1f6e]/40 to-[#1f4fd1]/20">
              <div
                className="absolute inset-0 opacity-20"
                style={{ backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 18px)" }}
              />
              <span className="absolute right-4 bottom-1 text-6xl font-bold tracking-tighter text-white/15">
                C3S1
              </span>
              <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-md bg-success/15 px-2 py-1 text-xs font-medium text-success">
                <ShieldCheck className="size-3.5" />
                Unterstützt
              </span>
              <span className="absolute top-4 right-4 rounded-md bg-black/30 px-2 py-1 text-xs font-medium">
                Aktiv
              </span>
            </div>
            <div className="flex flex-col gap-4 p-5">
              <div>
                <h2 className="text-sm font-semibold">Fortnite {build.version}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {build.season} · CL-{build.changelist} · {build.engine}
                </p>
              </div>
              <p
                title={build.path}
                className="selectable truncate rounded-md bg-black/20 px-3 py-2 font-mono text-xs text-muted-foreground"
              >
                {build.path}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => previewToast("Ordner öffnen", 2)}>
                  <FolderOpen />
                  Ordner öffnen
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Mehr Aktionen">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => previewToast("Erneut prüfen", 2)}>
                      Erneut prüfen
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => previewToast("Startargumente ändern", 2)}>
                      Startargumente ändern
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() =>
                        toast("Nur aus der Liste entfernen", {
                          description: "Vanity löscht nie Dateien deines Builds. Vorschau – ab Phase 2.",
                        })
                      }
                    >
                      Aus Liste entfernen
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </motion.article>
        ))}

        <motion.button
          type="button"
          whileHover={{ y: -2 }}
          transition={{ duration: 0.15 }}
          onClick={() => setImportOpen(true)}
          className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-white/[0.12] p-6 text-center text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <div className="flex size-12 items-center justify-center rounded-xl bg-white/[0.05]">
            <FolderPlus className="size-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Build-Ordner hinzufügen</p>
            <p className="mt-1 text-xs">Den Ordner wählen, in dem „FortniteGame“ liegt.</p>
          </div>
        </motion.button>
      </Reveal>

      <Panel
        title="Unterstützte Versionen"
        description="Vanity startet nur Builds, die es sicher als alt erkennt. Neue Versionen kommen nach und nach dazu."
      >
        <ul className="flex flex-col gap-2">
          {versionSupport.map((v) => (
            <li key={v.version} className="flex items-center gap-4 rounded-lg bg-white/[0.02] px-4 py-3">
              <SupportBadge level={v.level} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {v.version} <span className="font-normal text-muted-foreground">· {v.label}</span>
                </p>
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

function SupportBadge({ level }: { level: SupportLevel }) {
  const map = {
    supported: { icon: Check, text: "Unterstützt", cls: "bg-success/15 text-success" },
    planned: { icon: Clock, text: "Geplant", cls: "bg-primary/15 text-primary-text" },
    later: { icon: CircleDashed, text: "Später", cls: "bg-white/[0.06] text-muted-foreground" },
  }[level];
  const Icon = map.icon;
  return (
    <span className={cn("inline-flex w-28 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium", map.cls)}>
      <Icon className="size-3.5" />
      {map.text}
    </span>
  );
}

const checks = [
  "FortniteClient-Win64-Shipping.exe gefunden",
  "Version aus den Datei-Infos gelesen: 19.10 (CL-18675304)",
  "Spieldaten (.pak) vorhanden",
  "Version wird unterstützt",
];

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [path, setPath] = useState("C:\\Users\\georg\\Downloads\\windows-19.10");
  const [checked, setChecked] = useState(-1);

  // Prüfschritte nacheinander „abhaken“ (Vorschau)
  useEffect(() => {
    if (checked < 0 || checked >= checks.length) return;
    const t = window.setTimeout(() => setChecked((c) => c + 1), 450);
    return () => window.clearTimeout(t);
  }, [checked]);

  useEffect(() => {
    if (!open) setChecked(-1);
  }, [open]);

  const finished = checked >= checks.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Build hinzufügen</DialogTitle>
          <DialogDescription>
            Wähle den Ordner deines Builds. Vanity liest nur – im Ordner wird nichts verändert.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="build-path">Build-Ordner</Label>
          <div className="flex gap-2">
            <Input
              id="build-path"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setChecked(-1);
              }}
              className="font-mono text-xs"
            />
            <Button variant="secondary" onClick={() => previewToast("Ordner-Auswahl", 2)}>
              Durchsuchen
            </Button>
          </div>
        </div>

        <div className="min-h-36 rounded-lg bg-black/20 p-4">
          {checked < 0 ? (
            <p className="text-xs text-muted-foreground">
              Klick auf „Prüfen“. Vanity sucht die Spieldatei und liest die Version aus.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {checks.slice(0, Math.min(checked + 1, checks.length)).map((text, i) => (
                  <motion.li
                    key={text}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-2 text-xs"
                  >
                    {i < checked ? (
                      <Check className="size-4 text-success" />
                    ) : (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    )}
                    <span className={i < checked ? "" : "text-muted-foreground"}>{text}</span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          {finished ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                previewToast("Build importieren", 2);
              }}
            >
              <Check />
              Hinzufügen
            </Button>
          ) : (
            <Button onClick={() => setChecked(0)} disabled={checked >= 0}>
              {checked >= 0 && <Loader2 className="animate-spin" />}
              Prüfen
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
