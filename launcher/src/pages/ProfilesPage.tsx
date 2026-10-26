import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, FolderInput, Gamepad2, ListMusic, MonitorOff, MoreHorizontal, Monitor, Pencil, Plus, Save, Trash2, UserRound, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader, PageShell, Reveal } from "@/components/common";
import { GlowCard } from "@/components/fx";
import { pageGroup } from "@/components/layout/nav";
import { playlistLabel, playlists } from "@/lib/demo-data";
import { api, type BuildInfo, type Profile } from "@/lib/api";
import { buildFolderName, coverGradient } from "@/lib/builds";
import { EASE_OUT, SPRING_UI } from "@/lib/motion";
import { activeProfile, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function ProfilesPage() {
  const config = useApp((s) => s.config);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** null = the dialog makes a new profile */
  const [editing, setEditing] = useState<Profile | null>(null);
  const setConfig = useApp.getState().setConfig;
  const setPage = useApp((s) => s.setPage);

  const activate = async (id: string) => {
    useApp.setState((s) => ({ config: { ...s.config, activeProfileId: id } }));
    await api.setActiveProfile(id);
    toast.success("Profile switched");
  };
  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (p: Profile) => {
    setEditing(p);
    setDialogOpen(true);
  };
  const remove = async (id: string) => {
    setConfig(await api.removeProfile(id));
    toast("Profile deleted");
  };

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("profiles")}
        title="Profiles"
        description="A profile remembers the build, player name, playlist and server settings. Switch between Standard, Trickshot or Arena in one click."
        actions={
          <Button onClick={openNew} disabled={config.builds.length === 0}>
            <Plus />
            New profile
          </Button>
        }
      />

      {config.profiles.length === 0 ? (
        <Reveal>
          <EmptyState
            icon={UserRound}
            title="No profile yet"
            hint={config.builds.length === 0 ? "Add a build in the Library first." : "Create a profile to get started."}
            action={
              config.builds.length > 0 ? (
                <Button size="sm" onClick={openNew}>
                  <Plus />
                  Create profile
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setPage("library")}>
                  <FolderInput />
                  Open the Library
                </Button>
              )
            }
          />
        </Reveal>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <AnimatePresence>
            {config.profiles.map((p, i) => {
              const active = p.id === config.activeProfileId;
              const version = config.builds.find((b) => b.id === p.buildId)?.version;
              return (
                <motion.div key={p.id} {...cardMotion(i)} className="flex">
                  <GlowCard
                    initial={false}
                    glow={active}
                    spotlight
                    whileHover={{ y: -3 }}
                    className={cn("group flex w-full flex-col gap-4 p-5", !active && "hover-glow")}
                  >
                    <div className="flex items-start gap-3">
                      <ProfileMark name={p.name} active={active} />
                      <div className="min-w-0 flex-1">
                        <h2 className="truncate text-[15px] font-semibold">{p.name}</h2>
                        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`More for ${p.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(p)}>
                            <Pencil />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" disabled={config.profiles.length <= 1} onClick={() => remove(p.id)}>
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <dl className="grid grid-cols-2 gap-2">
                      <Fact icon={Gamepad2} label="Build" value={version ? `Fortnite ${version}` : "Missing – edit to pick one"} />
                      <Fact icon={UserRound} label="Player" value={p.playerName} />
                      <Fact icon={ListMusic} label="Playlist" value={`${playlistLabel(p.playlist)}${p.lategame ? " · Lategame" : ""}`} />
                      <Fact icon={p.headlessServer ? MonitorOff : Monitor} label="Server" value={p.headlessServer ? "No graphics" : "With a window"} />
                    </dl>

                    {p.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {p.tags.map((t) => (
                          <Badge key={t} variant="secondary">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}

                    <div className="mt-auto flex h-9 items-center">
                      {active ? (
                        <motion.span
                          layoutId="profile-active"
                          transition={SPRING_UI}
                          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brand px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_20px_-8px_rgb(122_60_255/0.8)]"
                        >
                          <Check className="size-3.5" strokeWidth={3} />
                          Active profile
                        </motion.span>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => activate(p.id)}>
                          Use this profile
                        </Button>
                      )}
                    </div>
                  </GlowCard>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      <ProfileDialog open={dialogOpen} onOpenChange={setDialogOpen} profile={editing} />
    </PageShell>
  );
}

/**
 * Entrance/exit for a card in a list that can grow and shrink. The card drives its own animation
 * (instead of waiting for the page's stagger), so it can never get stuck hidden, and new cards pop in.
 */
function cardMotion(i: number) {
  return {
    layout: true,
    initial: { opacity: 0, scale: 0.96, y: 8 },
    animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT, delay: 0.08 + i * 0.06 } },
    exit: { opacity: 0, scale: 0.95, transition: { duration: 0.16 } },
    transition: SPRING_UI,
  } as const;
}

/** Round tile with the first letter; brand gradient when the profile is active. */
function ProfileMark({ name, active }: { name: string; active: boolean }) {
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold transition-[background,color,box-shadow] duration-300",
        active
          ? "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_8px_24px_-8px_rgb(122_60_255/0.8)]"
          : "bg-gradient-to-br from-white/[0.09] to-white/[0.03] text-violet-text ring-1 ring-white/[0.08]",
      )}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </div>
  );
}

function Fact({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg surface-subtle px-3 py-2">
      <dt className="flex items-center gap-1.5 text-[11px] text-faint">
        <Icon className="size-3" />
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-xs font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** Tags that come from the playlist and Lategame switch – they are made again when those change. */
const autoTags = new Set([...playlists.map((pl) => pl.label), "Lategame"]);

/** New profile (profile = null) or edit an existing one. Same form for both. */
function ProfileDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: Profile | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Inside the content, so every opening starts with fresh fields */}
        <ProfileForm key={profile?.id ?? "new"} profile={profile} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ProfileForm({ profile, onDone }: { profile: Profile | null; onDone: () => void }) {
  const config = useApp((s) => s.config);
  const builds = config.builds;
  const editing = profile !== null;

  const [name, setName] = useState(profile?.name ?? "");
  const [buildId, setBuildId] = useState(() => {
    const known = (id: string | undefined): id is string => !!id && builds.some((b) => b.id === id);
    if (known(profile?.buildId)) return profile.buildId;
    const active = activeProfile(config)?.buildId;
    if (known(active)) return active;
    return builds[0]?.id ?? profile?.buildId ?? "";
  });
  const [playerName, setPlayerName] = useState(profile?.playerName ?? config.settings.playerName);
  const [playlist, setPlaylist] = useState(profile?.playlist ?? playlists[0].id);
  const [lategame, setLategame] = useState(profile?.lategame ?? false);
  const [headless, setHeadless] = useState(profile?.headlessServer ?? true);

  const nameOk = name.trim().length > 0;
  const playerOk = /^[A-Za-z0-9]{3,16}$/.test(playerName);
  // Editing with no builds left keeps the old one; a new profile needs a real build
  const buildOk = builds.some((b) => b.id === buildId) || (editing && builds.length === 0);
  const canSave = nameOk && playerOk && buildOk;

  const save = async () => {
    const tags = [playlistLabel(playlist), ...(lategame ? ["Lategame"] : []), ...(profile?.tags.filter((t) => !autoTags.has(t)) ?? [])];
    const next: Profile = {
      id: profile?.id ?? `p-${Date.now()}`,
      description: profile?.description ?? "Custom profile",
      launchArgs: profile?.launchArgs ?? config.settings.launchArgs,
      name: name.trim(),
      buildId,
      playerName,
      headlessServer: headless,
      playlist,
      lategame,
      tags,
    };
    try {
      useApp.getState().setConfig(await (editing ? api.updateProfile(next) : api.addProfile(next)));
    } catch (e) {
      toast.error("Couldn't save the profile", { description: String(e) });
      return;
    }
    onDone();
    toast.success(editing ? "Profile saved" : "Profile created", { description: next.name });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit profile" : "New profile"}</DialogTitle>
        <DialogDescription>{editing ? "Changes apply the next time you start." : "You can change everything later."}</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="p-name">Profile name</Label>
          <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Trickshot with Max" autoFocus={!editing} />
          {!editing && <p className="text-xs text-muted-foreground">For example "Trickshot with Max"</p>}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="p-build">Build</Label>
          <Select value={buildId} onValueChange={setBuildId} disabled={builds.length === 0}>
            <SelectTrigger id="p-build" className="w-full py-2 data-[size=default]:h-auto" aria-invalid={!buildOk}>
              <SelectValue placeholder="Add a build in the Library first" />
            </SelectTrigger>
            <SelectContent>
              {builds.map((b) => (
                <SelectItem key={b.id} value={b.id} className="py-2">
                  <BuildOption build={b} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="p-player">Player name</Label>
          <Input id="p-player" value={playerName} onChange={(e) => setPlayerName(e.target.value)} aria-invalid={!playerOk} />
          <p className={cn("text-xs transition-colors", playerOk ? "text-muted-foreground" : "text-destructive")}>
            3–16 letters or numbers, no spaces
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="p-playlist">Playlist</Label>
          <Select value={playlist} onValueChange={setPlaylist}>
            <SelectTrigger id="p-playlist" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {playlists.map((pl) => (
                <SelectItem key={pl.id} value={pl.id}>
                  {pl.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg surface-subtle px-3 py-2.5">
          <div>
            <Label htmlFor="p-late">Lategame</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">Starts in a late zone with full gear</p>
          </div>
          <Switch id="p-late" checked={lategame} onCheckedChange={setLategame} />
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg surface-subtle px-3 py-2.5">
          <div>
            <Label htmlFor="p-headless">Server with no graphics</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">Saves performance</p>
          </div>
          <Switch id="p-headless" checked={headless} onCheckedChange={setHeadless} />
        </div>
        <DialogFooter className="pt-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            {editing ? <Save /> : <Plus />}
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

/** One build in the picker: a small chapter-coloured version tile, the name and the season. */
function BuildOption({ build }: { build: BuildInfo }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "flex h-8 w-12 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-[11px] font-semibold text-white tabular-nums shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] ring-1 ring-white/10",
          coverGradient(build.version),
        )}
      >
        {build.version}
      </span>
      <span className="flex min-w-0 flex-col items-start gap-0.5 text-left leading-tight">
        <span className="truncate font-medium">
          Fortnite <span className="tabular-nums">{build.version}</span>
        </span>
        <span className="max-w-full truncate text-xs text-muted-foreground">
          {build.season} · {buildFolderName(build.path)}
          {build.support === "unsupported" && <span className="text-destructive"> · Can't start</span>}
        </span>
      </span>
    </span>
  );
}
