import { useCallback, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { create } from "zustand";
import { toast } from "sonner";
import {
  Anchor,
  ArrowRight,
  ArrowUpFromLine,
  Bot,
  Box as BoxIcon,
  Check,
  Crosshair,
  FastForward,
  Feather,
  FlaskConical,
  Flag,
  Gift,
  Heart,
  House,
  Info,
  ListChecks,
  MapPin,
  Mountain,
  Package,
  Pause,
  Play,
  Plane,
  Plus,
  RotateCcw,
  ServerOff,
  Shield,
  Spline,
  Swords,
  Target,
  Trash2,
  Undo2,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EmptyState,
  Eyebrow,
  IconTile,
  Kbd,
  PageHeader,
  PageShell,
  Panel,
  Reveal,
  SettingRow,
  StatusPill,
  ValueChip,
  type IconTone,
} from "@/components/common";
import { GlowCard, HeroBackdrop, NumberTicker, ShimmerButton, Stagger } from "@/components/fx";
import { pageGroup, pageLabel } from "@/components/layout/nav";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { playlistLabel, playlists } from "@/lib/demo-data";
import { api, inTauri, onEvent, type TrickshotPreset } from "@/lib/api";
import { botSkillLabel, botsSupportFor, clampBotCount } from "@/lib/bots";
import { LIVING_WORLD_MAX_MAX, LIVING_WORLD_MAX_MIN, clampLivingWorldMax, livingWorldStatus, livingWorldText } from "@/lib/livingworld";
import { EASE_OUT, SPRING_PLAYFUL, SPRING_UI } from "@/lib/motion";
import { activeProfile, buildOf, useApp, type ServiceStatus } from "@/lib/store";
import { parkourFile, parkours, kindLabel, levelWord, TILE_METERS, type Parkour } from "@/lib/parkours";
import { cn } from "@/lib/utils";

/*
 * Match Control. Every button sends exactly one real command to your server
 * (through the control pipe: "exec" = server command as the first player, "config" = a setting).
 */

// ---- Items to give (short names from native/server/Erbium/Private/Misc.cpp → ItemNames) ----------

const itemGroups: { label: string; items: { id: string; label: string }[] }[] = [
  {
    label: "Snipers",
    items: [
      { id: "heavy_sr", label: "Heavy Sniper" },
      { id: "bolt_sr", label: "Bolt-Action Sniper" },
      { id: "hunterbolt_sr", label: "Hunter Bolt-Action Sniper" },
      { id: "reaper_sr", label: "Reaper Sniper" },
    ],
  },
  {
    label: "Weapons",
    items: [
      { id: "pump_sr", label: "Pump Shotgun" },
      { id: "tac", label: "Tactical Shotgun" },
      { id: "rocket", label: "Rocket Launcher" },
    ],
  },
  {
    label: "Fly & jump",
    items: [
      { id: "grappler", label: "Grappler" },
      { id: "launchpad", label: "Launch Pad" },
      { id: "bouncer", label: "Bouncer (jump pad)" },
      { id: "crashpad", label: "Crash Pad" },
    ],
  },
  {
    label: "Healing",
    items: [{ id: "mini", label: "Small Shield Potion" }],
  },
];

// ---- Page state (kept when you switch pages, reset when the server stops) ----------------------

interface MatchState {
  tab: string;
  /** The server says the match has started (after that it doesn't accept another mode) */
  started: boolean;
  /** null = value from the active profile */
  playlist: string | null;
  lateGame: boolean | null;
  stormPaused: boolean;
  respawn: boolean;
  respawnTime: number;
  /** null = value from the active profile (the launcher sends it when the server starts) */
  infiniteAmmo: boolean | null;
  infiniteMats: boolean | null;
  /** Bosses & NPCs – null = value from the active profile (only before "Start match") */
  livingWorld: boolean | null;
  livingWorldMaxAI: number | null;
  item: string;
  activeParkour: string | null;
  targetHp: number;
  targetDistance: number;
  detection: boolean;
  autoReload: boolean;
  noJumpFatigue: boolean;
  slowMotion: boolean;
  botCount: number;
  botHealth: number;
  botShield: number;
}

/**
 * Start values = what the server uses, so switches and server agree: the server's defaults
 * (Configuration.h), and for lategame/infinite ammo/materials the active profile (the launcher
 * sends those right when the server starts).
 * Exception: dummy health/shield (server: 21/21) – "Place dummies" always sends the values shown here.
 */
const matchDefaults: Omit<MatchState, "tab"> = {
  started: false,
  playlist: null,
  lateGame: null,
  stormPaused: false,
  respawn: false,
  respawnTime: 3,
  infiniteAmmo: null,
  infiniteMats: null,
  livingWorld: null,
  livingWorldMaxAI: null,
  item: "heavy_sr",
  activeParkour: null,
  targetHp: 50,
  targetDistance: 30,
  detection: true,
  autoReload: false,
  noJumpFatigue: false,
  slowMotion: false,
  botCount: 5,
  botHealth: 100,
  botShield: 0,
};

const useMatch = create<MatchState>()(() => ({ tab: "game", ...matchDefaults }));
const setMatch = (patch: Partial<MatchState>) => useMatch.setState(patch);

// Server off → the defaults apply again on the next start
useApp.subscribe((s, prev) => {
  if (prev.services.server !== "stopped" && s.services.server === "stopped") setMatch({ ...matchDefaults });
});

/** Time of the last mode/lategame change made here – right after it, the server's status can still be old. */
let lastModePick = 0;

// The server reports its status every 2 seconds (NiobiumControl.cpp, StatusJson). Mode and lategame show
// what the server really uses – even if it turned a choice down.
onEvent<{ event: string; data?: { ready?: boolean; playlist?: string; lategame?: boolean } }>("server:event", ({ event, data }) => {
  if (event !== "status" || !data || useApp.getState().services.server === "stopped") return;
  const patch: Partial<MatchState> = { started: data.ready === true };
  if (Date.now() - lastModePick > 4000) {
    const id = data.playlist?.split(".").pop(); // "/Game/…/Playlist_DefaultSolo.Playlist_DefaultSolo" → "Playlist_DefaultSolo"
    if (id && playlists.some((p) => p.id === id)) patch.playlist = id;
    if (typeof data.lategame === "boolean") patch.lateGame = data.lategame;
  }
  setMatch(patch);
});

// ---- Sending commands --------------------------------------------------------------------------

type Action = () => Promise<void>;

/**
 * Sends a command. Returns true when it was sent to the server.
 * Whether it worked in the game (e.g. not in the lobby) only shows in the game –
 * so the messages say "sent" and never "done".
 */
async function run(fn: Action, what: string, done?: string): Promise<boolean> {
  if (inTauri && useApp.getState().services.server === "stopped") {
    toast.warning("No server yet", { description: "Start “Host & Play” first. Once you're in the match, this works." });
    return false;
  }
  try {
    await fn();
    if (done) toast.success(done);
    return true;
  } catch (e) {
    const text = String(e);
    toast.error(`${what} didn't work`, {
      description: /no server connected|kein server verbunden/i.test(text)
        ? "The server isn't connected yet. Wait until it has finished loading."
        : text,
    });
    return false;
  }
}

const exec = (text: string, what: string, done?: string) => run(() => api.serverExec(text), what, done);
const config = (key: string, value: unknown, what: string, done?: string) => run(() => api.serverConfig(key, value), what, done);

/** Message after sending: "“Button” sent – check the game". */
const sent = (label: string, look = "check the game") => `“${label}” sent – ${look}`;

/** Switch: flips at once, flips back on an error. */
async function flip<K extends keyof MatchState>(key: K, value: MatchState[K], send: () => Promise<boolean>) {
  const before = useMatch.getState()[key];
  setMatch({ [key]: value } as Partial<MatchState>);
  if (!(await send())) setMatch({ [key]: before } as Partial<MatchState>);
}

// ---- Page --------------------------------------------------------------------------------------

export function MatchPage() {
  const tab = useMatch((s) => s.tab);
  const started = useMatch((s) => s.started);
  const server = useApp((s) => s.services.server);

  return (
    <PageShell>
      <PageHeader
        eyebrow={pageGroup("match")}
        icon={Swords}
        title={pageLabel("match") || "Match Control"}
        description="Every button sends one command to your server. Most work once you're in the match. “You” means you on this PC – if you're not in the match, it's the first player."
      />

      {inTauri && server === "stopped" && <NoServerNote />}

      <Reveal>
        <Tabs value={tab} onValueChange={(v) => setMatch({ tab: v })} className="gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="game" className="px-5"><Flag />Game</TabsTrigger>
              <TabsTrigger value="trickshot" className="px-5"><Crosshair />Trickshot</TabsTrigger>
              <TabsTrigger value="bots" className="px-5"><Bot />Target dummies</TabsTrigger>
            </TabsList>
            <LiveStatus server={server} started={started} />
          </div>
          <TabsContent value="game"><GameTab /></TabsContent>
          <TabsContent value="trickshot"><TrickshotTab /></TabsContent>
          <TabsContent value="bots"><BotsTab /></TabsContent>
        </Tabs>
      </Reveal>
    </PageShell>
  );
}

/** Server and match state at a glance (top right). */
function LiveStatus({ server, started }: { server: ServiceStatus; started: boolean }) {
  return (
    <div className="glass flex items-center gap-4 rounded-full py-2 pr-4 pl-4 text-xs">
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">Server</span>
        <StatusPill status={server} />
      </span>
      <span aria-hidden className="h-4 w-px bg-white/10" />
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">Match</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={started ? "on" : "off"}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className={cn("font-medium", started ? "text-success" : "text-foreground/80")}
          >
            {started ? "Started" : "Not started"}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}

function NoServerNote() {
  const setPage = useApp((s) => s.setPage);
  return (
    <GlowCard className="flex flex-wrap items-center gap-4 py-4 pr-5 pl-4">
      <IconTile icon={ServerOff} tone="warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">No server yet</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Start “Host &amp; Play” first. Then everything here works.</p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => setPage("start")}>
        <House />
        Go to Home
      </Button>
    </GlowCard>
  );
}

// ---- Building blocks ---------------------------------------------------------------------------

/** Tab content: its cards appear one after another. */
function TabBody({ children, className }: { children: ReactNode; className?: string }) {
  return <Stagger className={cn("flex flex-col gap-6", className)}>{children}</Stagger>;
}

/** Rows inside a panel, with quiet lines between them. */
function Rows({ children }: { children: ReactNode }) {
  return <div className="flex flex-col divide-y divide-white/[0.05]">{children}</div>;
}

/** true for a moment after a command was sent (for the little "Sent" check). */
function useSentFlash(ms = 1600): [boolean, () => void] {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    window.clearTimeout(timer.current);
    setDone(true);
    timer.current = window.setTimeout(() => setDone(false), ms);
  }, [ms]);
  return [done, flash];
}

/** Button that sends a command; its icon turns into a check for a moment once the command was sent. */
function SendButton({
  run: send,
  icon,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & { run: () => Promise<boolean>; icon?: ReactNode }) {
  const [done, flash] = useSentFlash();
  return (
    <Button
      {...props}
      onClick={async () => {
        if (await send()) flash();
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {done ? (
          <motion.span
            key="sent"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={SPRING_PLAYFUL}
            className="inline-flex"
          >
            <Check />
          </motion.span>
        ) : icon ? (
          <motion.span
            key="icon"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={SPRING_PLAYFUL}
            className="inline-flex"
          >
            {icon}
          </motion.span>
        ) : null}
      </AnimatePresence>
      {children}
    </Button>
  );
}

/** Arrow that slides in on hover, or a green "Sent" check right after a command. */
function SentMark({ done }: { done: boolean }) {
  return (
    <span className="relative mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-end">
      <AnimatePresence mode="popLayout" initial={false}>
        {done ? (
          <motion.span
            key="sent"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={SPRING_PLAYFUL}
            className="flex items-center gap-1 text-xs font-medium text-success"
          >
            <Check className="size-4" />
            Sent
          </motion.span>
        ) : (
          <motion.span key="go" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex">
            <ArrowRight className="size-4 -translate-x-1 text-violet-text opacity-0 transition-[opacity,translate] duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** Big clickable card with an explanation below – you see what happens before you click. */
function ActionTile({
  icon,
  label,
  hint,
  tone = "brand",
  onRun,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  tone?: IconTone;
  onRun: () => Promise<boolean>;
}) {
  const [done, flash] = useSentFlash();
  return (
    <GlowCard
      interactive
      onClick={async () => {
        if (await onRun()) flash();
      }}
      className="flex items-start gap-4 p-5"
    >
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <SentMark done={done} />
    </GlowCard>
  );
}

/** Small button with one line of explanation (for panels with several buttons). */
function SmallAction({ icon: Icon, label, hint, onRun }: { icon: LucideIcon; label: string; hint: string; onRun: () => Promise<boolean> }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      <SendButton variant="secondary" size="sm" className="shrink-0" icon={<Icon />} run={onRun}>
        {label}
      </SendButton>
    </div>
  );
}

/** "AI bots 24 · Normal" when the active profile plays with AI bots ("Off" if the server said no). */
function AiBotsChip() {
  const config = useApp((s) => s.config);
  const answer = useApp((s) => s.playerBots);
  const profile = activeProfile(config);
  if (!profile?.bots) return null;
  const build = buildOf(config, profile.buildId);
  const possible = build ? botsSupportFor(build.version, build.changelist).level === "experimental" : false;
  const value =
    answer?.state === "unavailable" || !possible ? "Off" : `${clampBotCount(profile.botCount)} · ${botSkillLabel(profile.botSkill)}`;
  return <InfoChip label="AI bots" value={value} />;
}

/**
 * What the server says about Bosses & NPCs this match: "Active · 12 spawned" or "Not available: …".
 * Nothing while there is no answer yet, after the match ended, or when the switch is off ("off").
 */
function LivingWorldStatusRow() {
  const answer = useApp((s) => s.livingWorld);
  if (!answer || answer.state === "off") return null;
  const { text, tone } = livingWorldStatus(answer);
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0">
      <p className="shrink-0 text-sm font-medium">This match</p>
      <span
        role="status"
        className={cn(
          "inline-flex min-w-0 items-start gap-2 rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ring-inset",
          tone === "success" && "bg-success/12 text-success ring-success/25",
          tone === "warning" && "bg-warning/12 text-warning ring-warning/25",
          tone === "muted" && "bg-white/[0.05] text-muted-foreground ring-white/[0.06]",
        )}
      >
        <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-current" />
        <span className="min-w-0 break-words">{text}</span>
      </span>
    </div>
  );
}

/** "Mode  Solo" chip whose value fades when it changes. */
function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="surface-subtle inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={value}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.16, ease: EASE_OUT }}
          className="font-medium text-foreground"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

const fmtSeconds = (n: number) => `${n} s`;

// ---- Tab "Game" --------------------------------------------------------------------------------

function GameTab() {
  const m = useMatch();
  const profile = useApp((s) => activeProfile(s.config));
  const playlist = m.playlist ?? profile?.playlist ?? playlists[0].id;
  const lateGame = m.lateGame ?? profile?.lategame ?? false;
  const infiniteAmmo = m.infiniteAmmo ?? profile?.infiniteAmmo ?? false;
  const infiniteMats = m.infiniteMats ?? profile?.infiniteMats ?? false;
  const livingWorld = m.livingWorld ?? profile?.livingWorld ?? false;
  const livingWorldMax = m.livingWorldMaxAI ?? clampLivingWorldMax(profile?.livingWorldMaxAI ?? 40);
  const allItems = itemGroups.flatMap((g) => g.items);
  const itemName = allItems.find((i) => i.id === m.item)?.label ?? m.item;

  return (
    <TabBody>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <StartMatchCard started={m.started} playlist={playlist} lateGame={lateGame} />
        <BusCard />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Game mode"
          icon={Flag}
          description={m.started ? "The match is already running. Pick the mode before the next start." : "Only before “Start match”."}
        >
          <Rows>
            <SettingRow label="Mode" hint="Solo, Duos, Squads, Arena and more" disabled={m.started}>
              <Select
                value={playlist}
                disabled={m.started}
                onValueChange={(v) => {
                  lastModePick = Date.now();
                  flip("playlist", v, () => config("playlist", v, "Mode"));
                }}
              >
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>{playlists.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="Lategame" hint="Start in a small zone with full gear" disabled={m.started}>
              <Switch
                checked={lateGame}
                disabled={m.started}
                onCheckedChange={(v) => {
                  lastModePick = Date.now();
                  flip("lateGame", v, () => config("bLateGame", v, "Lategame"));
                }}
              />
            </SettingRow>
            <SettingRow
              label={livingWorldText.switchLabel}
              htmlFor="m-living"
              badge={
                <Badge variant="warning">
                  <FlaskConical />
                  {livingWorldText.badge}
                </Badge>
              }
              hint={livingWorldText.hint}
              disabled={m.started}
            >
              <Switch
                id="m-living"
                checked={livingWorld}
                disabled={m.started}
                onCheckedChange={(v) =>
                  flip("livingWorld", v, async () =>
                    // The max isn't sent at connect while the profile has the switch off, so it goes along here
                    (!v || (await config("LivingWorldMaxAI", livingWorldMax, livingWorldText.maxLabel))) &&
                    config("bLivingWorld", v, livingWorldText.switchLabel),
                  )
                }
              />
            </SettingRow>
            <SettingRow label={livingWorldText.maxLabel} hint="Fewer = smoother on one PC" disabled={m.started || !livingWorld}>
              <Slider
                className="w-36"
                aria-label={livingWorldText.maxLabel}
                min={LIVING_WORLD_MAX_MIN}
                max={LIVING_WORLD_MAX_MAX}
                step={1}
                value={[livingWorldMax]}
                disabled={m.started || !livingWorld}
                onValueChange={([v]) => setMatch({ livingWorldMaxAI: clampLivingWorldMax(v) })}
                onValueCommit={([v]) => config("LivingWorldMaxAI", clampLivingWorldMax(v), livingWorldText.maxLabel)}
              />
              <ValueChip>{livingWorldMax}</ValueChip>
            </SettingRow>
            <LivingWorldStatusRow />
          </Rows>
        </Panel>

        <Panel title="Storm" icon={m.stormPaused ? Play : Pause} description="Works right away, for everyone in the match.">
          <Rows>
            <SmallAction
              icon={m.stormPaused ? Play : Pause}
              label={m.stormPaused ? "Resume storm" : "Pause storm"}
              hint={m.stormPaused ? "The storm is paused right now." : "The storm stops until you let it move again."}
              onRun={async () => {
                let ok = false;
                await flip("stormPaused", !m.stormPaused, async () => (ok = await exec(m.stormPaused ? "resumesafezone" : "pausesafezone", "Storm")));
                return ok;
              }}
            />
            <SmallAction
              icon={FastForward}
              label="Next zone now"
              hint="The zone jumps straight to the next circle."
              onRun={() => exec("skipsafezone", "Next zone", sent("Next zone now"))}
            />
          </Rows>
        </Panel>

        <Panel title="Respawn" icon={RotateCcw} description="Jump back in after you're eliminated.">
          <Rows>
            <SettingRow label="Respawn on" hint="You come back into the match after the wait">
              <Switch checked={m.respawn} onCheckedChange={(v) => flip("respawn", v, () => config("bForceRespawns", v, "Respawn"))} />
            </SettingRow>
            <SettingRow label="Wait time" hint="Seconds until you come back" disabled={!m.respawn}>
              <Slider
                className="w-36"
                min={1}
                max={10}
                step={1}
                value={[m.respawnTime]}
                disabled={!m.respawn}
                onValueChange={([v]) => setMatch({ respawnTime: v })}
                onValueCommit={([v]) => config("RespawnTime", v, "Wait time")}
              />
              <ValueChip>{fmtSeconds(m.respawnTime)}</ValueChip>
            </SettingRow>
          </Rows>
        </Panel>

        <Panel title="Infinite" icon={Package} description="For everyone in the match.">
          <Rows>
            <SettingRow label="Infinite ammo" hint="Ammo never runs out">
              <Switch checked={infiniteAmmo} onCheckedChange={(v) => flip("infiniteAmmo", v, () => config("bInfiniteAmmo", v, "Infinite ammo"))} />
            </SettingRow>
            <SettingRow label="Infinite materials" hint="Wood, stone and metal never run out">
              <Switch checked={infiniteMats} onCheckedChange={(v) => flip("infiniteMats", v, () => config("bInfiniteMats", v, "Infinite materials"))} />
            </SettingRow>
          </Rows>
        </Panel>

        <Panel
          title="Give items"
          icon={Gift}
          description="The item goes straight into the inventory. Not every Fortnite version has every item."
          className="lg:col-span-2"
        >
          <Rows>
            <SettingRow label="Item" hint="Pick what you want">
              <Select value={m.item} onValueChange={(v) => setMatch({ item: v })}>
                <SelectTrigger className="w-60"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {itemGroups.map((g) => (
                    <SelectGroup key={g.label}>
                      <SelectLabel>{g.label}</SelectLabel>
                      {g.items.map((i) => <SelectItem key={i.id} value={i.id}>{i.label}</SelectItem>)}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="Give" hint="“Give to me” = only you. “Give to all” = every player in the match">
              <SendButton size="sm" icon={<Gift />} run={() => exec(`give ${m.item}`, "Give item", `“${itemName}” sent – check your inventory`)}>
                Give to me
              </SendButton>
              <SendButton
                size="sm"
                variant="secondary"
                icon={<Users />}
                run={() => exec(`givetoall ${m.item}`, "Give to all", `“${itemName}” sent to everyone – check the game`)}
              >
                Give to all
              </SendButton>
            </SettingRow>
          </Rows>
        </Panel>
      </div>
    </TabBody>
  );
}

/** The page's main action: start the match (hero card with the current mode). */
function StartMatchCard({ started, playlist, lateGame }: { started: boolean; playlist: string; lateGame: boolean }) {
  return (
    <GlowCard className="relative overflow-hidden p-6">
      <HeroBackdrop />
      <div className="relative flex h-full flex-col gap-6">
        <div>
          <Eyebrow>Match</Eyebrow>
          <AnimatePresence mode="wait" initial={false}>
            <motion.h2
              key={started ? "running" : "ready"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="mt-1.5 text-2xl leading-tight font-semibold tracking-tight"
            >
              {started ? "The match is running" : "Ready to drop?"}
            </motion.h2>
          </AnimatePresence>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            {started ? "Already started. Press “Play” in the game." : "The server loads the map. Then press “Play” in the game."}
          </p>
        </div>
        <div className="mt-auto flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap gap-2">
            <InfoChip label="Mode" value={playlistLabel(playlist)} />
            <InfoChip label="Lategame" value={lateGame ? "On" : "Off"} />
            <AiBotsChip />
          </div>
          <ShimmerButton
            size="lg"
            pulse={!started}
            disabled={started}
            icon={started ? <Check /> : <Play className="fill-current" />}
            onClick={async () => {
              if (await run(() => api.serverStartMatch(), "Start match", sent("Start match"))) setMatch({ started: true });
            }}
          >
            {started ? "Match running" : "Start match"}
          </ShimmerButton>
        </div>
      </div>
    </GlowCard>
  );
}

/** "Launch the bus" with a little flight path – the plane takes off on hover. */
function BusCard() {
  const [done, flash] = useSentFlash();
  return (
    <GlowCard
      interactive
      onClick={async () => {
        if (await exec("startaircraft", "Launch the bus", sent("Launch the bus"))) flash();
      }}
      className="flex flex-col gap-5 p-5"
    >
      <div className="flex items-start gap-4">
        <IconTile icon={Plane} />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">Launch the bus</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The Battle Bus takes off. On older versions after 10 seconds.</p>
        </div>
        <SentMark done={done} />
      </div>
      <div aria-hidden className="relative mt-auto h-10 overflow-hidden rounded-lg bg-black/20 ring-1 ring-white/[0.04]">
        <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="absolute inset-0 size-full">
          <path d="M 8 32 C 60 32, 90 10, 192 8" fill="none" stroke="rgb(180 155 255 / 0.35)" strokeWidth="1.2" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        </svg>
        <Plane className="absolute bottom-1.5 left-2 size-4 rotate-[35deg] text-violet-text transition-[left,bottom,rotate] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:bottom-[1.3rem] group-hover:left-[calc(100%-1.75rem)] group-hover:rotate-[20deg] motion-reduce:transition-none" />
      </div>
    </GlowCard>
  );
}

// ---- Tab "Trickshot" ---------------------------------------------------------------------------

function TrickshotTab() {
  const m = useMatch();

  const load = async (p: Parkour) => {
    const ok = await exec(`parkour ${p.id}`, `Load “${p.name}”`, sent(p.name));
    if (ok) setMatch({ activeParkour: p.id });
    return ok;
  };

  return (
    <TabBody>
      <div className="grid gap-4 md:grid-cols-3">
        <ActionTile
          icon={RotateCcw}
          label="Start over"
          hint="Back to the start. Full health, weapons loaded, target bots back."
          onRun={() => exec("parkour retry", "Start over", sent("Start over"))}
        />
        <ActionTile
          icon={Trash2}
          tone="muted"
          label="Clear everything"
          hint="Removes all parkour parts and target bots."
          onRun={async () => {
            const ok = await exec("parkour clear", "Clear everything", sent("Clear everything"));
            if (ok) setMatch({ activeParkour: null });
            return ok;
          }}
        />
        <ActionTile
          icon={Crosshair}
          label="Give sniper"
          hint="Puts a sniper in your inventory."
          onRun={() => exec("parkour sniper", "Give sniper", sent("Give sniper", "check your inventory"))}
        />
      </div>

      <section className="flex flex-col gap-4">
        <Reveal className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-[15px] font-semibold">Load a parkour</h2>
              <Badge variant="muted" className="tabular-nums">
                <NumberTicker value={parkours.length} /> courses
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Pick a course. It's built around you, you land at the start and get a sniper. Also in the game: <Kbd className="h-5">F9</Kbd> → Trickshot.
            </p>
          </div>
          <MapLegend />
        </Reveal>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {parkours.map((p) => (
            <ParkourCard key={p.id} parkour={p} active={m.activeParkour === p.id} onLoad={() => load(p)} />
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Target bot" icon={Target} description="A bot that stands still in front of you – perfect for aiming.">
          <Rows>
            <SettingRow label="Health" hint="How much health the bot has (no shield)">
              <Slider className="w-36" min={1} max={200} step={1} value={[m.targetHp]} onValueChange={([v]) => setMatch({ targetHp: v })} />
              <ValueChip>{m.targetHp}</ValueChip>
            </SettingRow>
            <SettingRow label="Distance" hint="How far in front of you, at your height">
              <Slider className="w-36" min={5} max={100} step={5} value={[m.targetDistance]} onValueChange={([v]) => setMatch({ targetDistance: v })} />
              <ValueChip>{m.targetDistance} m</ValueChip>
            </SettingRow>
          </Rows>
          <RangePreview distance={m.targetDistance} hp={m.targetHp} />
          <div className="flex flex-wrap gap-2 pt-4">
            <SendButton icon={<Crosshair />} run={() => exec(`targetbot ${m.targetHp} ${m.targetDistance}`, "Place bot", sent("Place bot"))}>
              Place bot
            </SendButton>
            <SendButton variant="secondary" icon={<Trash2 />} run={() => exec("delbot", "Remove all bots", sent("Remove all bots"))}>
              Remove all bots
            </SendButton>
          </div>
        </Panel>

        <Panel
          title="Trickshot banner"
          icon={Zap}
          description="Eliminate someone while you're in the air and everyone sees a big banner with the name and distance."
        >
          <Rows>
            <SettingRow label="Banner on" hint="For everyone in the match">
              <Switch checked={m.detection} onCheckedChange={(v) => flip("detection", v, () => config("bTrickshotDetection", v, "Trickshot banner"))} />
            </SettingRow>
          </Rows>
          <AnimatePresence initial={false}>
            {m.detection && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
                className="overflow-hidden"
              >
                <div className="pt-4">
                  <p className="mb-2 text-xs text-muted-foreground">This is how the banner looks in the game:</p>
                  <TrickshotBannerPreview />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>

        <Panel title="Practice" icon={Heart} description="Helps you train. Works right away.">
          <Rows>
            <SettingRow label="Slow motion" hint="The whole match runs at half speed – for everyone">
              <Switch checked={m.slowMotion} onCheckedChange={(v) => flip("slowMotion", v, () => exec(v ? "demospeed 0.5" : "demospeed 1", "Slow motion"))} />
            </SettingRow>
            <SettingRow label="Gravity" hint="“Low”: you jump higher and fall slower. Only for you. Back to normal after you die">
              <SendButton size="sm" variant="secondary" icon={<Feather />} run={() => exec("gravity 0.4", "Low gravity", sent("Low gravity"))}>
                Low
              </SendButton>
              <SendButton size="sm" variant="secondary" icon={<Anchor />} run={() => exec("gravity 1", "Normal gravity", sent("Normal gravity"))}>
                Normal
              </SendButton>
            </SettingRow>
            <SettingRow label="Invincible on/off" hint="Click once: no damage. Click again: back to normal">
              <SendButton size="sm" variant="secondary" icon={<Shield />} run={() => exec("god", "Invincible", sent("Invincible on/off"))}>
                Toggle
              </SendButton>
            </SettingRow>
            <SettingRow label="No jump fatigue" hint="Jump as often as you like – without slowing down">
              <Switch checked={m.noJumpFatigue} onCheckedChange={(v) => flip("noJumpFatigue", v, () => config("bDisableJumpFatigue", v, "Jump fatigue"))} />
            </SettingRow>
            <SettingRow label="Auto-reload when going back" hint="After “Back to spot” your weapons are full right away">
              <Switch checked={m.autoReload} onCheckedChange={(v) => flip("autoReload", v, () => config("bAutoReloadOnWaypointTP", v, "Auto-reload"))} />
            </SettingRow>
          </Rows>
        </Panel>

        <Panel title="Spot & gear" icon={MapPin} description="Save a spot, jump back, refill.">
          <Rows>
            {/* Same waypoint name as the F9 menu ("cheat s niobium o"), so both use one saved spot */}
            <SmallAction icon={MapPin} label="Save spot" hint="Remembers where you're standing." onRun={() => exec("s niobium o", "Save spot", sent("Save spot"))} />
            <SmallAction icon={Undo2} label="Back to spot" hint="Takes you straight back to the saved spot." onRun={() => exec("w niobium", "Back to spot", sent("Back to spot"))} />
            <SmallAction icon={ArrowUpFromLine} label="Launch up" hint="Shoots you straight up into the air." onRun={() => exec("l 2500", "Launch up", sent("Launch up"))} />
            <SmallAction
              icon={BoxIcon}
              label="Give jump pads"
              hint="6 each of jump pads, bouncers and other traps."
              onRun={() => exec("givetraps", "Give jump pads", sent("Give jump pads", "check your inventory"))}
            />
            <SmallAction icon={Package} label="Refill ammo" hint="Refills your ammo." onRun={() => exec("giveammo", "Refill ammo", sent("Refill ammo"))} />
            <SmallAction icon={Heart} label="Refill health" hint="Health and shield back to full." onRun={() => exec("regen", "Refill health", sent("Refill health"))} />
          </Rows>
        </Panel>

        <PresetsPanel />
      </div>
    </TabBody>
  );
}

/** Your own presets (made on the "In-game Menu" page): one click sends all their commands in order. */
function PresetsPanel() {
  const presets = useApp((s) => s.config.trickshotPresets);
  const setPage = useApp((s) => s.setPage);

  const runPreset = async (preset: TrickshotPreset): Promise<boolean> => {
    const commands = preset.commands.map((c) => c.trim().replace(/^\//, "").replace(/^cheat\s+/i, "").trim()).filter(Boolean);
    for (const [i, command] of commands.entries()) {
      const last = i === commands.length - 1;
      if (!(await exec(command, `“${preset.name}”`, last ? sent(preset.name) : undefined))) return false;
    }
    return commands.length > 0;
  };

  return (
    <Panel
      title="Your presets"
      icon={ListChecks}
      description="One click sends all commands of a preset to the server, one after another."
      className="lg:col-span-2"
      actions={
        presets.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setPage("ingame")}>
            <Plus />
            New preset
          </Button>
        ) : undefined
      }
    >
      {presets.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No presets yet"
          hint="You create them on the “In-game Menu” page."
          className="py-8"
          action={
            <Button variant="secondary" size="sm" onClick={() => setPage("ingame")}>
              <Plus />
              Create preset
            </Button>
          }
        />
      ) : (
        <Stagger className="grid gap-2 md:grid-cols-2">
          {presets.map((preset, i) => (
            <Reveal key={`${preset.name}-${i}`} kind="slide" className="surface-subtle flex items-center gap-4 rounded-lg px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{preset.name}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {preset.commands.map((c, j) => (
                    <code key={j} className="max-w-full truncate rounded-md bg-black/25 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground ring-1 ring-white/[0.05]">
                      {c}
                    </code>
                  ))}
                </div>
              </div>
              <SendButton size="sm" className="shrink-0" icon={<Play className="fill-current" />} run={() => runPreset(preset)}>
                Run
              </SendButton>
            </Reveal>
          ))}
        </Stagger>
      )}
    </Panel>
  );
}

/** You on the left, the target bot at its distance – moves while you drag the slider. */
function RangePreview({ distance, hp }: { distance: number; hp: number }) {
  const pct = Math.min(Math.max(distance, 0), 100);
  return (
    <div aria-hidden className="surface-subtle relative mt-4 h-16 rounded-lg">
      <div className="absolute inset-x-6 top-[38px]">
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-white/15" />
        <div className="absolute top-0 left-0 h-px bg-gradient-to-r from-white/50 to-brand-violet/80 transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        {/* you */}
        <span className="absolute top-0 left-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_10px_rgb(255_255_255/0.6)]" />
        <span className="absolute top-0 left-0 -translate-x-[calc(100%+10px)] -translate-y-1/2 text-[10px] font-medium text-muted-foreground">You</span>
        {/* the bot */}
        <span className="absolute top-0 transition-[left] duration-300 ease-out motion-reduce:transition-none" style={{ left: `${pct}%` }}>
          <span className="absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-destructive/20" />
          <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-destructive shadow-[0_0_10px_rgb(239_68_68/0.7)]" />
          <span className="absolute -top-6 -translate-x-1/2 font-mono text-[10px] font-medium whitespace-nowrap tabular-nums">{distance} m</span>
          <span className="absolute top-3 -translate-x-1/2 font-mono text-[10px] whitespace-nowrap text-muted-foreground tabular-nums">{hp} HP</span>
        </span>
      </div>
    </div>
  );
}

function TrickshotBannerPreview() {
  const name = useApp((s) => s.config.settings.playerName) || "You";
  const [take, setTake] = useState(0);
  return (
    <div className="relative h-36 overflow-hidden rounded-lg ring-1 ring-white/[0.06]">
      {/* evening sky, sun and hills */}
      <div aria-hidden className="absolute inset-0 bg-[linear-gradient(180deg,#1d2552_0%,#3f4fa3_45%,#7f7bd0_72%,#c9a3c4_100%)]" />
      <div aria-hidden className="absolute -top-10 right-12 size-32 rounded-full bg-[radial-gradient(closest-side,rgb(255_200_87/0.5),transparent)]" />
      <svg aria-hidden viewBox="0 0 400 60" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-14 w-full">
        <path d="M0 40 C60 22 110 30 160 36 C220 44 260 18 320 26 C360 31 385 38 400 34 V60 H0 Z" fill="#2a2d5e" />
        <path d="M0 50 C80 38 140 46 200 48 C270 50 330 40 400 46 V60 H0 Z" fill="#151832" />
      </svg>
      <div aria-hidden className="absolute inset-0 bg-black/15" />
      <div className="absolute inset-0 flex items-center justify-center">
        <motion.div
          key={take}
          initial={{ scale: 0.7, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ ...SPRING_PLAYFUL, delay: 0.12 }}
          className="gradient-border gradient-border-brand relative rounded-xl bg-[#0a0b12]/80 px-7 py-3 text-center shadow-[0_18px_50px_-15px_rgb(122_60_255/0.75)] backdrop-blur"
        >
          <p className="text-gradient-brand text-xl font-extrabold tracking-[0.2em]">TRICKSHOT!</p>
          <p className="mt-0.5 text-sm font-medium">
            {name} – <NumberTicker value={128} /> m
          </p>
        </motion.div>
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="absolute right-2 bottom-2 bg-black/30 text-white/80 backdrop-blur hover:bg-black/45 hover:text-white"
        onClick={() => setTake((t) => t + 1)}
      >
        <RotateCcw />
        Replay
      </Button>
    </div>
  );
}

// ---- Parkour cards with a mini map ---------------------------------------------------------------

function LevelDots({ level }: { level: number }) {
  return (
    <span role="img" className="inline-flex items-center gap-2 text-[11px] text-muted-foreground" aria-label={`Level ${level} of 3 (${levelWord(level)})`}>
      <span aria-hidden className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={cn("h-1.5 w-3.5 rounded-full", n <= level ? "bg-brand shadow-[0_0_6px_rgb(122_60_255/0.6)]" : "bg-white/[0.12]")}
          />
        ))}
      </span>
      <span aria-hidden className="capitalize">{levelWord(level)}</span>
    </span>
  );
}

function StatChip({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.05] px-2 py-1 text-[11px] text-muted-foreground tabular-nums ring-1 ring-white/[0.04]">
      <Icon className="size-3 text-violet-text/80" />
      {children}
    </span>
  );
}

function ParkourCard({ parkour: p, active, onLoad }: { parkour: Parkour; active: boolean; onLoad: () => Promise<boolean> }) {
  const bots = p.bots.length;
  const parts = p.elements.length;
  return (
    <GlowCard interactive glow={active} kind="scale" className="flex cursor-default flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold">{p.name}</h3>
          <div className="mt-1">
            <LevelDots level={p.level} />
          </div>
        </div>
        <AnimatePresence initial={false}>
          {active && (
            <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={SPRING_UI} className="shrink-0">
              <Badge variant="brand">Last sent</Badge>
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <p className="mt-2 line-clamp-2 min-h-10 text-xs leading-relaxed text-muted-foreground">{p.description}</p>
      <ParkourMap parkour={p} className="mt-3" />
      <div className="mt-3 mb-4 flex flex-wrap gap-1.5">
        <StatChip icon={Mountain}>{p.height > 0 ? `${p.height} m up` : "On the ground"}</StatChip>
        <StatChip icon={Spline}>
          {parts} {parts === 1 ? "jump" : "jumps"}
        </StatChip>
        <StatChip icon={Target}>
          {bots} {bots === 1 ? "bot" : "bots"}
        </StatChip>
      </div>
      <SendButton className="mt-auto w-full" variant={active ? "default" : "secondary"} icon={<Play className="fill-current" />} run={onLoad}>
        {active ? "Load again" : "Load"}
      </SendButton>
    </GlowCard>
  );
}

// Mini map from above: you start on the left and look to the right (= forward). Down = to your right.
const MAP_W = 260;
const MAP_H = 112;
const MAP_PAD = 14;
const MAP_INK = "var(--nb-violet-text)";

function KindIcon({ kind, x, y }: { kind: string; x: number; y: number }) {
  const c = MAP_INK;
  switch (kind) {
    case "trampoline":
      return (
        <g>
          <circle cx={x} cy={y} r={5.2} fill="none" stroke={c} strokeWidth={1.6} />
          <circle cx={x} cy={y} r={1.7} fill={c} />
        </g>
      );
    case "launcher":
      return <path d={`M ${x} ${y - 6} L ${x + 5.5} ${y + 4} L ${x - 5.5} ${y + 4} Z`} fill={c} />;
    case "sideLauncher":
      return (
        <path
          d={`M ${x - 5} ${y - 5} L ${x} ${y} L ${x - 5} ${y + 5} M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5}`}
          fill="none"
          stroke={c}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    default:
      return <path d={`M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`} fill={c} />;
  }
}

function ParkourMap({ parkour: p, className }: { parkour: Parkour; className?: string }) {
  const calm = useCalmMotion();
  const gradientId = "route" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // World: f = forward (→ x), r = right (→ y downwards). Tiles [width (right), depth (forward)].
  type Rect = { f: number; r: number; w: number; d: number };
  const rects: { rect: Rect; start?: boolean }[] = [];
  const addTiles = (f: number, r: number, tiles: [number, number] | undefined, start?: boolean) => {
    if (!tiles || tiles[0] <= 0 || tiles[1] <= 0) return;
    rects.push({ rect: { f, r, w: tiles[0] * TILE_METERS, d: tiles[1] * TILE_METERS }, start });
  };
  addTiles(0, 0, p.platform, true);
  p.elements.forEach((e) => addTiles(e.at[0], e.at[1], e.platform));
  p.bots.forEach((b) => addTiles(b.at[0], b.at[1], b.platform ?? [1, 1]));

  let minF = 0, maxF = 0, minR = 0, maxR = 0;
  const grow = (f: number, r: number) => {
    minF = Math.min(minF, f); maxF = Math.max(maxF, f);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r);
  };
  rects.forEach(({ rect }) => { grow(rect.f - rect.d / 2, rect.r - rect.w / 2); grow(rect.f + rect.d / 2, rect.r + rect.w / 2); });
  [...p.elements, ...p.bots].forEach((o) => grow(o.at[0], o.at[1]));

  // Minimum size, so short courses don't look huge
  const padSpan = (lo: number, hi: number, min: number): [number, number] => {
    const span = hi - lo;
    if (span >= min) return [lo, hi];
    const extra = (min - span) / 2;
    return [lo - extra, hi + extra];
  };
  [minF, maxF] = padSpan(minF, maxF, 40);
  [minR, maxR] = padSpan(minR, maxR, 18);
  const scale = Math.min((MAP_W - 2 * MAP_PAD) / (maxF - minF), (MAP_H - 2 * MAP_PAD) / (maxR - minR));
  const offX = MAP_PAD + ((MAP_W - 2 * MAP_PAD) - (maxF - minF) * scale) / 2;
  const offY = MAP_PAD + ((MAP_H - 2 * MAP_PAD) - (maxR - minR) * scale) / 2;
  const X = (f: number) => offX + (f - minF) * scale;
  const Y = (r: number) => offY + (r - minR) * scale;

  const route = [[0, 0], ...p.elements.map((e) => [e.at[0], e.at[1]])].map(([f, r]) => `${X(f).toFixed(1)},${Y(r).toFixed(1)}`).join(" ");

  // Pieces pop in one after another once the route is drawn (static with reduced motion)
  const pop = (i: number) =>
    calm
      ? { initial: false as const }
      : {
          initial: { opacity: 0, scale: 0.3 },
          animate: { opacity: 1, scale: 1 },
          transition: { ...SPRING_PLAYFUL, delay: 0.45 + i * 0.08 },
        };
  const svgOrigin = { transformBox: "fill-box" as const, transformOrigin: "center" };

  return (
    <svg
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      className={cn("block h-32 w-full rounded-lg ring-1 ring-white/[0.05]", className)}
      style={{
        backgroundColor: "rgb(5 6 12 / 0.55)",
        backgroundImage:
          "radial-gradient(rgb(255 255 255 / 0.07) 1px, transparent 1px), radial-gradient(70% 120% at 12% 50%, rgb(122 60 255 / 0.16), transparent 70%)",
        backgroundSize: "12px 12px, 100% 100%",
      }}
      role="img"
      aria-label={`Map from above: ${p.elements.map((e) => kindLabel(e.kind)).join(", ")}; ${p.bots.length} target ${p.bots.length === 1 ? "bot" : "bots"}`}
    >
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={MAP_W} y2={0}>
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.75} />
          <stop offset="1" stopColor="#b49bff" stopOpacity={0.9} />
        </linearGradient>
      </defs>
      {rects.map(({ rect, start }, i) => {
        const w = Math.max(rect.d * scale, 5);
        const h = Math.max(rect.w * scale, 5);
        return (
          <rect
            key={i}
            x={X(rect.f) - w / 2}
            y={Y(rect.r) - h / 2}
            width={w}
            height={h}
            rx={2}
            fill={start ? "rgb(122 60 255 / 0.2)" : "rgb(255 255 255 / 0.06)"}
            stroke={start ? "rgb(180 155 255 / 0.6)" : "rgb(255 255 255 / 0.14)"}
            strokeWidth={1}
          />
        );
      })}
      {p.elements.length > 0 && (
        <motion.polyline
          points={route}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={0.7}
          initial={calm ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.25 }}
        />
      )}
      {p.elements.map((e, i) => (
        <motion.g key={i} style={svgOrigin} {...pop(i)}>
          <KindIcon kind={e.kind} x={X(e.at[0])} y={Y(e.at[1])} />
        </motion.g>
      ))}
      {p.bots.map((b, i) => {
        const x = X(b.at[0]);
        const y = Y(b.at[1]);
        const up = Math.round(b.at[2]);
        // Keep the label inside the picture (don't write over the edge)
        const labelX = Math.min(Math.max(x, 26), MAP_W - 26);
        const labelY = y - 9 < 9 ? y + 15 : y - 9;
        return (
          <motion.g key={i} style={svgOrigin} {...pop(p.elements.length + i)}>
            <circle cx={x} cy={y} r={7} fill="var(--destructive)" fillOpacity={0.16} />
            <circle cx={x} cy={y} r={7} fill="none" stroke="var(--destructive)" strokeOpacity={0.45} strokeWidth={0.8} />
            <circle cx={x} cy={y} r={3.4} fill="var(--destructive)" />
            {Math.abs(up) >= 3 && (
              <text x={labelX} y={labelY} textAnchor="middle" fontSize={8} fill="rgb(242 243 248 / 0.7)">
                {up > 0 ? `${up} m higher` : `${-up} m lower`}
              </text>
            )}
          </motion.g>
        );
      })}
      {/* you at the start, looking forward (right) */}
      <circle cx={X(0)} cy={Y(0)} r={6} fill="#ffffff" fillOpacity={0.12} />
      <circle cx={X(0)} cy={Y(0)} r={3.6} fill="#ffffff" />
      <path d={`M ${X(0) + 5.5} ${Y(0) - 3.2} L ${X(0) + 9.5} ${Y(0)} L ${X(0) + 5.5} ${Y(0) + 3.2} Z`} fill="#ffffff" fillOpacity={0.8} />
    </svg>
  );
}

function MapLegend() {
  const kinds = Object.keys(parkourFile.kinds);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 20 12" className="h-3 w-5">
          <circle cx={5} cy={6} r={3.4} fill="#fff" />
          <path d="M 10 3 L 14 6 L 10 9 Z" fill="#fff" fillOpacity={0.8} />
        </svg>
        You (looking right)
      </span>
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <svg aria-hidden viewBox="0 0 14 14" className="size-3.5">
            <KindIcon kind={k} x={7} y={7.5} />
          </svg>
          {kindLabel(k)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <svg aria-hidden viewBox="0 0 14 14" className="size-3.5">
          <circle cx={7} cy={7} r={3.6} fill="var(--destructive)" />
        </svg>
        Target bot
      </span>
    </div>
  );
}

// ---- Tab "Target dummies" (stand-still bots; real AI bots are a profile setting) ----------------

function BotsTab() {
  const m = useMatch();
  const setPage = useApp((s) => s.setPage);

  const place = async () => {
    // Send the values first, so the new dummies surely get them
    if (!(await config("BotHealth", m.botHealth, "Dummy health"))) return false;
    if (!(await config("BotShield", m.botShield, "Dummy shield"))) return false;
    return exec(`bot ${m.botCount}`, "Place dummies", sent("Place dummies"));
  };

  return (
    <TabBody>
      <GlowCard className="flex items-start gap-4 p-5">
        <IconTile icon={Info} tone="muted" />
        <div className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
          <p>
            To be honest: these bots <span className="font-medium text-foreground">stand still</span> – they don't walk, build or shoot. They're target
            dummies for practice. To place a single one at a set distance, use the{" "}
            <button
              type="button"
              onClick={() => setMatch({ tab: "trickshot" })}
              className="rounded-sm font-medium text-violet-text underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              Trickshot
            </button>{" "}
            tab.
          </p>
          <p className="text-xs">
            Want bots that really play? Turn on “Play with AI bots” in your{" "}
            <button
              type="button"
              onClick={() => setPage("profiles")}
              className="rounded-sm font-medium text-violet-text underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              profile
            </button>{" "}
            (experimental, 19.10 only).
          </p>
        </div>
      </GlowCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Place dummies" icon={Bot} description="The dummies appear where you're standing.">
          <Rows>
            <SettingRow label="Count" hint="How many dummies at once">
              <Slider className="w-36" min={1} max={20} step={1} value={[m.botCount]} onValueChange={([v]) => setMatch({ botCount: v })} />
              <ValueChip>{m.botCount}</ValueChip>
            </SettingRow>
          </Rows>
          <BotLineup count={m.botCount} />
          <div className="flex flex-wrap gap-2 pt-4">
            <SendButton icon={<Bot />} run={place}>
              Place dummies
            </SendButton>
            <SendButton variant="secondary" icon={<Users />} run={() => exec("tpbot", "Bring to me", sent("Bring to me"))}>
              Bring to me
            </SendButton>
            <SendButton variant="secondary" icon={<Trash2 />} run={() => exec("delbot", "Remove all", sent("Remove all"))}>
              Remove all
            </SendButton>
          </div>
        </Panel>

        <Panel title="Dummy stats" icon={Heart} description="For dummies you place here from now on. Target bots from “Trickshot” have their own health.">
          <Rows>
            <SettingRow label="Health" hint="100 is normal">
              <Slider
                className="w-36"
                min={1}
                max={100}
                step={1}
                value={[m.botHealth]}
                onValueChange={([v]) => setMatch({ botHealth: v })}
                onValueCommit={([v]) => config("BotHealth", v, "Dummy health")}
              />
              <ValueChip>{m.botHealth}</ValueChip>
            </SettingRow>
            <SettingRow label="Shield" hint="0 = no shield, 100 = full">
              <Slider
                className="w-36"
                min={0}
                max={100}
                step={5}
                value={[m.botShield]}
                onValueChange={([v]) => setMatch({ botShield: v })}
                onValueCommit={([v]) => config("BotShield", v, "Dummy shield")}
              />
              <ValueChip>{m.botShield}</ValueChip>
            </SettingRow>
          </Rows>
          <BotVitals health={m.botHealth} shield={m.botShield} />
        </Panel>
      </div>
    </TabBody>
  );
}

/** One little bot per bot you'll place – they pop in and out with the slider. */
function BotLineup({ count }: { count: number }) {
  return (
    <div className="surface-subtle mt-4 rounded-lg px-3 py-3">
      <div aria-hidden className="flex min-h-[3.875rem] flex-wrap content-center items-center gap-1.5">
        <AnimatePresence initial={false} mode="popLayout">
          {Array.from({ length: count }, (_, i) => (
            <motion.span
              key={i}
              layout
              initial={{ opacity: 0, scale: 0.4, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.4 }}
              transition={SPRING_PLAYFUL}
              className="flex size-7 items-center justify-center rounded-md bg-gradient-to-b from-white/[0.09] to-white/[0.02] text-violet-text ring-1 ring-white/[0.06]"
            >
              <Bot className="size-4" />
            </motion.span>
          ))}
        </AnimatePresence>
      </div>
      <p className="mt-2 text-[11px] text-faint">
        {count} {count === 1 ? "dummy" : "dummies"} will appear where you stand
      </p>
    </div>
  );
}

/** Health and shield bars of a new bot, like the game's own bars. */
function BotVitals({ health, shield }: { health: number; shield: number }) {
  return (
    <div className="surface-subtle mt-4 flex flex-col gap-2.5 rounded-lg px-4 py-3.5">
      <VitalBar icon={Shield} label="Shield" value={shield} barClass="from-brand-blue to-blue-text" />
      <VitalBar icon={Heart} label="Health" value={health} barClass="from-success to-[#86efac]" />
      <p className="text-[11px] text-faint">Preview of a new dummy</p>
    </div>
  );
}

function VitalBar({ icon: Icon, label, value, barClass }: { icon: LucideIcon; label: string; value: number; barClass: string }) {
  return (
    <div className="flex items-center gap-3">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="w-12 text-xs text-muted-foreground">{label}</span>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <motion.div
          className={cn("absolute inset-0 origin-left rounded-full bg-gradient-to-r", barClass)}
          initial={false}
          animate={{ scaleX: value / 100 }}
          transition={SPRING_UI}
        />
      </div>
      <span className="w-8 text-right font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}
