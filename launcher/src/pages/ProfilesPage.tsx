import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, MoreHorizontal, Plus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader, PageShell, Reveal } from "@/components/common";
import { playlistLabel, playlists } from "@/lib/demo-data";
import { api, type Profile } from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ProfilesPage() {
  const config = useApp((s) => s.config);
  const [createOpen, setCreateOpen] = useState(false);
  const setConfig = useApp.getState().setConfig;

  const activate = async (id: string) => {
    useApp.setState((s) => ({ config: { ...s.config, activeProfileId: id } }));
    await api.setActiveProfile(id);
    toast.success("Profil aktiviert");
  };
  const remove = async (id: string) => {
    setConfig(await api.removeProfile(id));
    toast("Profil gelöscht");
  };

  return (
    <PageShell>
      <PageHeader
        title="Profile"
        description="Ein Profil merkt sich Build, Spielername, Playlist und Server-Einstellungen. So wechselst du mit einem Klick zwischen z. B. Standard, Trickshot und Arena."
        actions={<Button onClick={() => setCreateOpen(true)} disabled={config.builds.length === 0}><Plus />Neues Profil</Button>}
      />

      {config.profiles.length === 0 ? (
        <Reveal>
          <EmptyState icon={UserRound} title="Noch kein Profil" hint={config.builds.length === 0 ? "Füge zuerst in der Bibliothek einen Build hinzu." : "Leg ein Profil an."} action={config.builds.length > 0 ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus />Profil anlegen</Button> : undefined} />
        </Reveal>
      ) : (
        <Reveal className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence initial={false}>
            {config.profiles.map((p) => {
              const active = p.id === config.activeProfileId;
              return (
                <motion.article key={p.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.18 }} className={cn("glass flex flex-col gap-4 rounded-xl p-5", active && "ring-1 ring-primary/60")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-semibold">{p.name}</h2>
                      <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Aktionen für ${p.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" disabled={config.profiles.length <= 1} onClick={() => remove(p.id)}>Löschen</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                    <dt className="text-muted-foreground">Build</dt><dd>Fortnite {config.builds.find((b) => b.id === p.buildId)?.version ?? "?"}</dd>
                    <dt className="text-muted-foreground">Name</dt><dd className="truncate">{p.playerName}</dd>
                    <dt className="text-muted-foreground">Playlist</dt><dd>{playlistLabel(p.playlist)}{p.lategame ? " · Lategame" : ""}</dd>
                    <dt className="text-muted-foreground">Server</dt><dd>{p.headlessServer ? "ohne Grafik" : "mit Fenster"}</dd>
                  </dl>
                  <div className="flex flex-wrap gap-1.5">{p.tags.map((t) => <span key={t} className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs">{t}</span>)}</div>
                  <div className="mt-auto">
                    {active ? <span className="inline-flex h-8 items-center gap-1.5 text-xs font-medium text-primary-text"><Check className="size-4" />Aktives Profil</span> : <Button variant="secondary" size="sm" onClick={() => activate(p.id)}>Aktivieren</Button>}
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
  const config = useApp((s) => s.config);
  const [name, setName] = useState("");
  const [playerName, setPlayerName] = useState(config.settings.playerName);
  const [playlist, setPlaylist] = useState(playlists[0].id);
  const [lategame, setLategame] = useState(false);
  const [headless, setHeadless] = useState(true);

  const nameOk = name.trim().length > 0;
  const playerOk = /^[A-Za-z0-9]{3,16}$/.test(playerName);

  const save = async () => {
    const profile: Profile = {
      id: `p-${Date.now()}`,
      name: name.trim(),
      description: "Eigenes Profil",
      buildId: config.builds[0]?.id ?? "",
      playerName,
      launchArgs: config.settings.launchArgs,
      headlessServer: headless,
      playlist,
      lategame,
      tags: [playlistLabel(playlist), ...(lategame ? ["Lategame"] : [])],
    };
    useApp.getState().setConfig(await api.addProfile(profile));
    onOpenChange(false);
    setName("");
    toast.success("Profil angelegt");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-md">
        <DialogHeader><DialogTitle>Neues Profil</DialogTitle><DialogDescription>Du kannst alles später noch ändern.</DialogDescription></DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (nameOk && playerOk) save(); }}>
          <div className="flex flex-col gap-2"><Label htmlFor="p-name">Name des Profils</Label><Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus /><p className="text-xs text-muted-foreground">Zum Beispiel „Trickshot mit Max“</p></div>
          <div className="flex flex-col gap-2"><Label htmlFor="p-player">Spielername</Label><Input id="p-player" value={playerName} onChange={(e) => setPlayerName(e.target.value)} aria-invalid={!playerOk} /><p className={cn("text-xs", playerOk ? "text-muted-foreground" : "text-destructive")}>3–16 Buchstaben oder Zahlen, ohne Leerzeichen</p></div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="p-playlist">Playlist</Label>
            <Select value={playlist} onValueChange={setPlaylist}><SelectTrigger id="p-playlist"><SelectValue /></SelectTrigger><SelectContent>{playlists.map((pl) => <SelectItem key={pl.id} value={pl.id}>{pl.label}</SelectItem>)}</SelectContent></Select>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div><Label htmlFor="p-late">Lategame</Label><p className="mt-0.5 text-xs text-muted-foreground">Startet in einer späten Zone mit voller Ausrüstung</p></div>
            <Switch id="p-late" checked={lategame} onCheckedChange={setLategame} />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div><Label htmlFor="p-headless">Server ohne Grafik</Label><p className="mt-0.5 text-xs text-muted-foreground">Spart Leistung</p></div>
            <Switch id="p-headless" checked={headless} onCheckedChange={setHeadless} />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Abbrechen</Button>
            <Button type="submit" disabled={!nameOk || !playerOk}>Anlegen</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
