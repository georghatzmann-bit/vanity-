import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, MoreHorizontal, Plus, UserRound } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { EmptyState, PageHeader, PageShell, Reveal } from "@/components/common";
import { demoBuilds, type Profile } from "@/lib/demo-data";
import { previewToast } from "@/lib/preview";
import { useUi } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ProfilesPage() {
  const profiles = useUi((s) => s.profiles);
  const activeId = useUi((s) => s.activeProfileId);
  const setActive = useUi((s) => s.setActiveProfile);
  const removeProfile = useUi((s) => s.removeProfile);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <PageShell>
      <PageHeader
        title="Profile"
        description="Ein Profil merkt sich Build, Spielername, Startargumente und Server-Einstellungen. So wechselst du mit einem Klick zwischen z. B. normalem Match und Trickshot."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Neues Profil
          </Button>
        }
      />

      {profiles.length === 0 ? (
        <Reveal>
          <EmptyState
            icon={UserRound}
            title="Noch kein Profil"
            hint="Leg ein Profil an, damit Vanity weiß, welchen Build und welche Einstellungen es nehmen soll."
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus />
                Profil anlegen
              </Button>
            }
          />
        </Reveal>
      ) : (
        <Reveal className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {profiles.map((p) => {
              const active = p.id === activeId;
              return (
                <motion.article
                  key={p.id}
                  layout
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.18 }}
                  className={cn(
                    "glass flex flex-col gap-4 rounded-xl p-5 transition-shadow",
                    active && "ring-1 ring-primary/60",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold">{p.name}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Aktionen für ${p.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => previewToast("Profil bearbeiten", 2)}>Bearbeiten</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => previewToast("Profil kopieren", 2)}>Kopieren</DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={profiles.length <= 1}
                          onClick={() => {
                            removeProfile(p.id);
                            toast("Profil gelöscht", { description: p.name });
                          }}
                        >
                          Löschen
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                    <dt className="text-muted-foreground">Build</dt>
                    <dd>Fortnite {p.buildId}</dd>
                    <dt className="text-muted-foreground">Name</dt>
                    <dd className="truncate">{p.playerName}</dd>
                    <dt className="text-muted-foreground">Start</dt>
                    <dd className="font-mono">{p.launchArgs || "–"}</dd>
                    <dt className="text-muted-foreground">Server</dt>
                    <dd>{p.headlessServer ? "ohne Grafik" : "mit Fenster"}</dd>
                  </dl>

                  <div className="flex flex-wrap gap-1.5">
                    {p.tags.map((t) => (
                      <span key={t} className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs">
                        {t}
                      </span>
                    ))}
                  </div>

                  <div className="mt-auto">
                    {active ? (
                      <span className="inline-flex h-8 items-center gap-1.5 text-xs font-medium text-primary-text">
                        <Check className="size-4" />
                        Aktives Profil
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setActive(p.id);
                          toast.success(`„${p.name}“ ist jetzt aktiv`);
                        }}
                      >
                        Aktivieren
                      </Button>
                    )}
                  </div>
                </motion.article>
              );
            })}
          </AnimatePresence>
        </Reveal>
      )}

      <CreateProfileDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageShell>
  );
}

function CreateProfileDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const addProfile = useUi((s) => s.addProfile);
  const [name, setName] = useState("");
  const [playerName, setPlayerName] = useState("georg");
  const [args, setArgs] = useState("-d3d11");
  const [headless, setHeadless] = useState(true);

  const nameOk = name.trim().length > 0;
  const playerOk = /^[A-Za-z0-9]{3,16}$/.test(playerName);

  const save = () => {
    const profile: Profile = {
      id: `p-${Date.now()}`,
      name: name.trim(),
      description: "Eigenes Profil",
      buildId: demoBuilds[0].id,
      playerName,
      launchArgs: args.trim(),
      headlessServer: headless,
      tags: [],
    };
    addProfile(profile);
    onOpenChange(false);
    setName("");
    toast.success("Profil angelegt", { description: "In der Vorschau nur bis zum Schließen gespeichert." });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Neues Profil</DialogTitle>
          <DialogDescription>Du kannst alles später noch ändern.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (nameOk && playerOk) save();
          }}
        >
          <Field id="profile-name" label="Name des Profils" hint="Zum Beispiel „Trickshot mit Max“">
            <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field
            id="profile-player"
            label="Spielername"
            hint={playerOk ? "3–16 Zeichen, nur Buchstaben und Zahlen" : "Bitte 3–16 Buchstaben oder Zahlen, ohne Leerzeichen"}
            error={!playerOk}
          >
            <Input id="profile-player" value={playerName} onChange={(e) => setPlayerName(e.target.value)} aria-invalid={!playerOk} />
          </Field>
          <Field id="profile-args" label="Startargumente" hint="-d3d11 verhindert Grafikfehler bei 19.10">
            <Input id="profile-args" value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-xs" />
          </Field>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="headless">Server ohne Grafik</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">Spart Leistung – der Server braucht kein Bild</p>
            </div>
            <Switch id="headless" checked={headless} onCheckedChange={setHeadless} />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!nameOk || !playerOk}>
              Anlegen
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>{hint}</p>
    </div>
  );
}
