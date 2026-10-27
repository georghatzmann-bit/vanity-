import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Check,
  FlaskConical,
  FolderInput,
  Gamepad2,
  Info,
  ListMusic,
  MonitorOff,
  MoreHorizontal,
  Monitor,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Swords,
  Trash2,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, PageHeader, PageShell, Reveal, ValueChip } from "@/components/common";
import { GlowCard } from "@/components/fx";
import { pageGroup } from "@/components/layout/nav";
import { useBotsSupport } from "@/hooks/use-bots-support";
import { BOT_COUNT_MAX, BOT_COUNT_MIN, botSkillLabel, botSkills, botsSupportFor, botsText, clampBotCount } from "@/lib/bots";
import { classicMatch, playlistLabel, playlists } from "@/lib/demo-data";
import { soloVariant, teamSize, teamVariant } from "@/lib/friends";
import { LIVING_WORLD_MAX_MAX, LIVING_WORLD_MAX_MIN, clampLivingWorldMax, livingWorldText } from "@/lib/livingworld";
import { api, type BotSkill, type BuildInfo, type Profile } from "@/lib/api";
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
              const build = config.builds.find((b) => b.id === p.buildId);
              const version = build?.version;
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
                      <Fact icon={ListMusic} label="Playlist" value={playlistLabel(p.playlist)} />
                      <Fact icon={Users} label="With friends" value={p.friendsTogether && teamSize(p.playlist) > 1 ? "Together, one team" : "Against each other"} />
                      <Fact icon={p.headlessServer ? MonitorOff : Monitor} label="Server" value={p.headlessServer ? "No graphics" : "With a window"} />
                      <Fact icon={Swords} label="Rules" value={rulesText(p)} />
                      <Fact icon={Bot} label="AI bots" value={botsFact(p, build)} />
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
                          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-brand px-3 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_6px_20px_-8px_rgb(139_92_246/0.8)]"
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
          ? "bg-brand text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_8px_24px_-8px_rgb(139_92_246/0.8)]"
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

/** "Classic match", or what's switched on: "Lategame · Infinite ammo". */
function rulesText(p: Pick<Profile, "lategame" | "infiniteAmmo" | "infiniteMats">): string {
  const on = [p.lategame && "Lategame", p.infiniteAmmo && "Infinite ammo", p.infiniteMats && "Infinite mats"].filter(Boolean);
  return on.length === 0 ? "Classic match" : on.join(" · ");
}

/** "Off", "24 · Normal", or "Not for 15.40" when bots are on but this build has none. */
function botsFact(p: Profile, build: BuildInfo | undefined): string {
  if (!p.bots) return "Off";
  if (build && botsSupportFor(build.version, build.changelist).level !== "experimental") return `Not for ${build.version}`;
  return `${clampBotCount(p.botCount)} · ${botSkillLabel(p.botSkill)}`;
}

/** Tags that come from the playlist, Lategame, AI bots and Bosses & NPCs switches – they are made again when those change. */
const autoTags = new Set([...playlists.map((pl) => pl.label), "Lategame", "AI bots", livingWorldText.tag]);

/** New profile (profile = null) or edit an existing one. Same form for both. */
function ProfileDialog({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: Profile | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
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
  // "With friends": Together = Duos/Trios/Squads with every human in one team; Against each other = Solo
  const [together, setTogether] = useState(() => Boolean(profile?.friendsTogether) || teamSize(profile?.playlist ?? "") > 1);
  const pickPlaylist = (id: string) => {
    setPlaylist(id);
    setTogether(teamSize(id) > 1);
  };
  const pickMode = (t: boolean) => {
    setTogether(t);
    setPlaylist((cur) => (t ? teamVariant(cur) : soloVariant(cur)));
  };
  const [headless, setHeadless] = useState(profile?.headlessServer ?? true);
  // Match rules: a new profile starts as a "Classic match" (like back then)
  const [lategame, setLategame] = useState(profile?.lategame ?? classicMatch.lategame);
  const [infiniteAmmo, setInfiniteAmmo] = useState(profile?.infiniteAmmo ?? classicMatch.infiniteAmmo);
  const [infiniteMats, setInfiniteMats] = useState(profile?.infiniteMats ?? classicMatch.infiniteMats);
  const [bots, setBots] = useState(profile?.bots ?? classicMatch.bots);
  const [botCount, setBotCount] = useState(clampBotCount(profile?.botCount ?? classicMatch.botCount));
  const [botSkill, setBotSkill] = useState<BotSkill>(profile?.botSkill ?? classicMatch.botSkill);
  // Bosses & NPCs: off in a new profile, one click to turn on (it fits a Classic match)
  const [livingWorld, setLivingWorld] = useState(profile?.livingWorld ?? classicMatch.livingWorld);
  const [livingWorldMax, setLivingWorldMax] = useState(clampLivingWorldMax(profile?.livingWorldMaxAI ?? classicMatch.livingWorldMaxAI));

  const build = builds.find((b) => b.id === buildId);
  const botsInfo = useBotsSupport(build?.version, build?.changelist);
  const botsOk = botsInfo?.level === "experimental";
  const botsOn = botsOk && bots;
  const classic = !lategame && !infiniteAmmo && !infiniteMats;

  const nameOk = name.trim().length > 0;
  const playerOk = /^[A-Za-z0-9]{3,16}$/.test(playerName);
  // Editing with no builds left keeps the old one; a new profile needs a real build
  const buildOk = builds.some((b) => b.id === buildId) || (editing && builds.length === 0);
  const canSave = nameOk && playerOk && buildOk;

  const save = async () => {
    const tags = [
      playlistLabel(playlist),
      ...(lategame ? ["Lategame"] : []),
      ...(botsOn ? ["AI bots"] : []),
      ...(livingWorld ? [livingWorldText.tag] : []),
      ...(profile?.tags.filter((t) => !autoTags.has(t)) ?? []),
    ];
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
      infiniteAmmo,
      infiniteMats,
      // A build without AI bots never sends "bots on" (the server would only say no every match)
      bots: botsOn,
      botCount: clampBotCount(botCount),
      botSkill,
      livingWorld,
      livingWorldMaxAI: clampLivingWorldMax(livingWorldMax),
      friendsTogether: together && teamSize(playlist) > 1,
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
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void save();
        }}
      >
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left: who and what */}
          <div className="flex flex-col gap-4">
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
              <Select value={playlist} onValueChange={pickPlaylist}>
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
            <div className="flex flex-col gap-2">
              <Label id="p-friends">With friends</Label>
              <ToggleGroup
                type="single"
                value={together ? "together" : "versus"}
                onValueChange={(v) => v && pickMode(v === "together")}
                aria-labelledby="p-friends"
                className="w-full"
              >
                <ToggleGroupItem value="versus" className="flex-1">
                  Against each other
                </ToggleGroupItem>
                <ToggleGroupItem value="together" className="flex-1">
                  Together
                </ToggleGroupItem>
              </ToggleGroup>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {together
                  ? `You and your friends play in one ${playlistLabel(playlist)} team${botsOn ? "; bots fill the other teams" : ""}. Pick Duos, Trios or Squads above for the team size.`
                  : `Solo: everyone plays for themselves${botsOn ? ", every bot too" : ""}.`}
                {!botsOk && " Bots: only on 19.10 for now."} Bots, Lategame and the match rules work with both.
              </p>
            </div>
            <SwitchRow id="p-headless" label="Server with no graphics" hint="Saves performance" checked={headless} onChange={setHeadless} />
          </div>

          {/* Right: how the match plays */}
          <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2.5" aria-labelledby="p-rules">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h3 id="p-rules" className="text-sm font-semibold">
                    Match rules
                  </h3>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span key={classic ? "classic" : "custom"} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={SPRING_UI}>
                      {classic ? (
                        <Badge variant="gold">Classic match</Badge>
                      ) : (
                        <Badge variant="secondary">Custom</Badge>
                      )}
                    </motion.span>
                  </AnimatePresence>
                </div>
                {!classic && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setLategame(false);
                      setInfiniteAmmo(false);
                      setInfiniteMats(false);
                    }}
                  >
                    <RotateCcw />
                    Classic
                  </Button>
                )}
              </div>
              <div className="flex flex-col divide-y divide-white/[0.05] rounded-lg surface-subtle">
                <SwitchRow id="p-late" label="Lategame" hint="Starts in a late zone with full gear" checked={lategame} onChange={setLategame} flat />
                <SwitchRow id="p-ammo" label="Infinite ammo" hint="Ammo never runs out" checked={infiniteAmmo} onChange={setInfiniteAmmo} flat />
                <SwitchRow id="p-mats" label="Infinite materials" hint="Wood, stone and metal never run out" checked={infiniteMats} onChange={setInfiniteMats} flat />
                <SwitchRow
                  id="p-living"
                  label={livingWorldText.switchLabel}
                  badge={
                    <Badge variant="warning">
                      <FlaskConical />
                      {livingWorldText.badge}
                    </Badge>
                  }
                  hint={livingWorldText.hint}
                  checked={livingWorld}
                  onChange={setLivingWorld}
                  flat
                />
                <div className={cn("flex flex-col gap-2 px-3 py-2.5 transition-opacity duration-200", !livingWorld && "opacity-50")}>
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor="p-living-max">{livingWorldText.maxLabel}</Label>
                    <ValueChip className="min-w-10">{livingWorldMax}</ValueChip>
                  </div>
                  <Slider
                    id="p-living-max"
                    aria-label={livingWorldText.maxLabel}
                    min={LIVING_WORLD_MAX_MIN}
                    max={LIVING_WORLD_MAX_MAX}
                    step={1}
                    value={[livingWorldMax]}
                    disabled={!livingWorld}
                    onValueChange={([v]) => setLivingWorldMax(clampLivingWorldMax(v))}
                  />
                  <p className="flex justify-between text-[11px] text-faint tabular-nums">
                    <span>{LIVING_WORLD_MAX_MIN}</span>
                    <span>Fewer = smoother on one PC</span>
                    <span>{LIVING_WORLD_MAX_MAX}</span>
                  </p>
                </div>
              </div>
              <p className="text-xs text-faint">Classic match = like back then: full map, normal ammo and materials. Bosses &amp; NPCs can be on too.</p>
            </section>

            <BotsSection
              info={botsInfo}
              version={build?.version}
              bots={botsOn}
              setBots={setBots}
              count={botCount}
              setCount={setBotCount}
              skill={botSkill}
              setSkill={setBotSkill}
            />
          </div>
        </div>

        <DialogFooter className="pt-1">
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

/** Label + grey hint on the left, a switch on the right. `flat` = inside a shared box. */
function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
  disabled,
  flat = false,
  badge,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  flat?: boolean;
  /** Small chip after the label, e.g. "Experimental". */
  badge?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4 px-3 py-2.5", !flat && "rounded-lg surface-subtle")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={id}>{label}</Label>
          {badge}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/**
 * "AI bots": on/off, how many, how good. Only usable when the build has them (19.10-CL-18675304
 * for now); otherwise greyed out with the reason.
 */
function BotsSection({
  info,
  version,
  bots,
  setBots,
  count,
  setCount,
  skill,
  setSkill,
}: {
  info: ReturnType<typeof useBotsSupport>;
  version: string | undefined;
  bots: boolean;
  setBots: (v: boolean) => void;
  count: number;
  setCount: (v: number) => void;
  skill: BotSkill;
  setSkill: (v: BotSkill) => void;
}) {
  const ok = info?.level === "experimental";
  const note = info?.note ?? botsText.noteNotYet;
  return (
    <section className="flex flex-col gap-2.5" aria-labelledby="p-bots">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="p-bots" className="text-sm font-semibold">
          {botsText.section}
        </h3>
        <Badge variant="warning">
          <FlaskConical />
          {botsText.badge}
        </Badge>
      </div>

      <div className={cn("relative flex flex-col divide-y divide-white/[0.05] rounded-lg surface-subtle transition-opacity duration-200", !ok && "opacity-45")} aria-disabled={!ok}>
        <SwitchRow id="p-bots-on" label={botsText.switchLabel} hint={botsText.switchHint} checked={ok && bots} onChange={setBots} disabled={!ok} flat />
        <div className={cn("flex flex-col gap-2 px-3 py-2.5 transition-opacity duration-200", ok && !bots && "opacity-50")}>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="p-bots-count">{botsText.countLabel}</Label>
            <ValueChip className="min-w-10">{count}</ValueChip>
          </div>
          <Slider
            id="p-bots-count"
            aria-label={botsText.countLabel}
            min={BOT_COUNT_MIN}
            max={BOT_COUNT_MAX}
            step={1}
            value={[count]}
            disabled={!ok || !bots}
            onValueChange={([v]) => setCount(clampBotCount(v))}
          />
          <p className="flex justify-between text-[11px] text-faint tabular-nums">
            <span>{BOT_COUNT_MIN}</span>
            <span>Fewer bots = smoother on one PC</span>
            <span>{BOT_COUNT_MAX}</span>
          </p>
        </div>
        <div className={cn("flex items-center justify-between gap-4 px-3 py-2.5 transition-opacity duration-200", ok && !bots && "opacity-50")}>
          <div className="min-w-0">
            <Label>{botsText.skillLabel}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">{botSkills.find((s) => s.id === skill)?.hint}</p>
          </div>
          <ToggleGroup
            type="single"
            size="sm"
            value={skill}
            onValueChange={(v) => v && setSkill(v as BotSkill)}
            disabled={!ok || !bots}
            aria-label={botsText.skillLabel}
          >
            {botSkills.map((s) => (
              <ToggleGroupItem key={s.id} value={s.id} className="px-3 text-xs">
                {s.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <p className={cn("flex items-start gap-2 text-xs leading-relaxed", ok ? "text-faint" : "text-muted-foreground")}>
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {ok ? note : version ? `Fortnite ${version}: ${note}` : note}
        </span>
      </p>
    </section>
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
