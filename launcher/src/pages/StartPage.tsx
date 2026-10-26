import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUpRight,
  CircleSlash,
  FlaskConical,
  FolderInput,
  Gamepad2,
  PanelsTopLeft,
  Play,
  ScrollText,
  Server,
  Square,
  UserPlus,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BubbleStatus } from "@/components/bubble/BubbleStatus";
import { Eyebrow, IconTile, PageShell, Panel, Reveal, StatusPill, type IconTone } from "@/components/common";
import { GlowCard, GradientText, HeroBackdrop, NumberTicker, ProgressBeam, ShimmerButton, Stagger, StepTimeline } from "@/components/fx";
import { runDemoLaunch, stopDemoLaunch } from "@/components/LaunchDemoDriver";
import { api, BACKEND_PORT, GAME_SERVER_PORT, inTauri, type ServiceStatus } from "@/lib/api";
import { EASE_IN, EASE_OUT } from "@/lib/motion";
import { activeProfile, buildOf, launchSteps, useApp, type PageId } from "@/lib/store";
import { cn } from "@/lib/utils";

const swap = {
  initial: { opacity: 0, scale: 0.94, filter: "blur(4px)" },
  animate: { opacity: 1, scale: 1, filter: "blur(0px)", transition: { duration: 0.32, ease: EASE_OUT }, transitionEnd: { filter: "none" } },
  exit: { opacity: 0, scale: 0.96, filter: "blur(4px)", transition: { duration: 0.14, ease: EASE_IN } },
};

export function StartPage() {
  const config = useApp((s) => s.config);
  const services = useApp((s) => s.services);
  const launchStep = useApp((s) => s.launchStep);
  const setPage = useApp((s) => s.setPage);

  const profile = activeProfile(config);
  const build = buildOf(config, profile?.buildId);
  const total = launchSteps.length;
  const running = launchStep >= 0 && launchStep < total;
  const done = launchStep >= total;
  const busy = running || done;
  // Untested builds start too (Rust only warns); only versions Niobium can't start are blocked
  const canStart = Boolean(build) && build?.support !== "unsupported";

  const start = async () => {
    if (!profile) {
      toast.error("No profile yet", { description: "Add a build in the Library first." });
      return;
    }
    if (!inTauri) {
      runDemoLaunch();
      return;
    }
    try {
      await api.hostAndPlay(profile.id);
    } catch (e) {
      toast.error("Couldn't start", { description: String(e) });
    }
  };

  const stop = async () => {
    if (!inTauri) {
      stopDemoLaunch();
      toast("Everything stopped");
      return;
    }
    await api.stopAll();
  };

  const setActive = (id: string) => {
    useApp.setState((s) => ({ config: { ...s.config, activeProfileId: id } }));
    api.setActiveProfile(id);
  };

  const heroProgress = done ? 1 : running ? Math.min((launchStep + 0.5) / total, 1) : 0;
  const stepNow = running ? launchSteps[launchStep] : null;

  return (
    <PageShell>
      {/* Hero: active build + the big Host & Play button */}
      <GlowCard strong className="relative overflow-hidden">
        <HeroBackdrop />

        <div className="relative grid gap-8 p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="px-2.5 py-1 text-xs">
                {build?.season ?? "No build"}
              </Badge>
              {build && <span className="text-xs text-muted-foreground">Active build</span>}
              {build && <BubbleStatus version={build.version} hideUnavailable />}
            </div>

            <h1 className="mt-5 text-[2.75rem] leading-none font-semibold tracking-tight">
              {build ? (
                <>
                  Fortnite <GradientText variant="brand" className="tabular-nums">{build.version}</GradientText>
                </>
              ) : (
                <GradientText>No build yet</GradientText>
              )}
            </h1>

            {build ? (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
                {build.changelist ? <span className="tabular-nums">CL-{build.changelist}</span> : null}
                {build.changelist ? <Dot /> : null}
                <span>{build.engine}</span>
                <Dot />
                <span className="inline-flex items-center gap-2">
                  Launch args
                  <code className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-foreground/90 ring-1 ring-white/[0.06]">
                    {profile?.launchArgs || "-d3d11"}
                  </code>
                </span>
              </div>
            ) : (
              <p className="mt-4 max-w-md text-sm text-muted-foreground">
                Add your Fortnite folder in the Library (for example 19.10). Niobium finds the version for you.
              </p>
            )}

            {build?.support === "experimental" && (
              <p className="mt-3 inline-flex items-center gap-2 text-xs text-warning">
                <FlaskConical className="size-3.5" />
                Untested version – Niobium will try anyway.
              </p>
            )}
            {build?.support === "unsupported" && (
              <p className="mt-3 inline-flex items-center gap-2 text-xs text-destructive">
                <CircleSlash className="size-3.5" />
                Niobium can't start this version. Pick another profile or build.
              </p>
            )}

            {config.profiles.length > 0 ? (
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <span className="text-xs font-medium text-muted-foreground">Profile</span>
                <Select value={profile?.id} onValueChange={setActive} disabled={busy}>
                  <SelectTrigger className="h-9 w-56 bg-white/[0.05]" aria-label="Active profile">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.profiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <Button variant="secondary" className="mt-7" onClick={() => setPage("library")}>
                <FolderInput />
                Open the Library
              </Button>
            )}
          </div>

          <div className="flex flex-col items-start gap-3 lg:items-end">
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.div key="stop" {...swap}>
                  <ShimmerButton
                    size="xl"
                    tone="neutral"
                    loading={running}
                    sheenOnMount={false}
                    icon={<Square className="size-4 fill-current" />}
                    onClick={stop}
                    className="min-w-60"
                  >
                    {running ? "Starting… · Cancel" : "Stop all"}
                  </ShimmerButton>
                </motion.div>
              ) : (
                <motion.div key="start" {...swap}>
                  <ShimmerButton
                    size="xl"
                    pulse
                    icon={<Play className="fill-current" />}
                    onClick={start}
                    disabled={!canStart}
                    className="min-w-60"
                  >
                    Host &amp; Play
                  </ShimmerButton>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="h-9 max-w-60 text-xs lg:text-right">
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={running ? `step-${launchStep}` : done ? "done" : "idle"}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } }}
                  exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
                  className="text-muted-foreground"
                >
                  {stepNow ? (
                    <>
                      <span className="font-medium text-violet-text">
                        Step {launchStep + 1} of {total}
                      </span>{" "}
                      · {stepNow.label}: {stepNow.hint}
                    </>
                  ) : done ? (
                    <span className="text-success">You're in. Press Play in Fortnite.</span>
                  ) : (
                    "Starts the backend, the server and your game in one click."
                  )}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Thin progress beam along the bottom edge while launching */}
        <AnimatePresence>
          {busy && (
            <motion.div
              key="beam"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-x-0 bottom-0"
            >
              <ProgressBeam value={heroProgress} active={running} tip={running} className="h-[2px] rounded-none bg-transparent" />
            </motion.div>
          )}
        </AnimatePresence>
      </GlowCard>

      {/* Launch steps */}
      <Panel
        title="Launch steps"
        description="What happens after you press Host & Play, one step after another."
        actions={<LaunchStateBadge step={launchStep} total={total} />}
        bodyClassName="pt-6 pb-6"
      >
        <StepTimeline steps={launchSteps} current={launchStep} />
      </Panel>

      {/* Services */}
      <Stagger className="grid gap-4 md:grid-cols-3" delay={0.12}>
        <ServiceCard icon={Waypoints} name="Backend" status={services.backend} detail={`127.0.0.1:${BACKEND_PORT}`} />
        <ServiceCard icon={Server} name="Game server" status={services.server} detail={`127.0.0.1:${GAME_SERVER_PORT} · ${config.settings.headlessServer ? "no graphics" : "with a window"}`} />
        <ServiceCard icon={Gamepad2} name="Your game" status={services.game} detail={build ? `Fortnite ${build.version}` : "–"} />
      </Stagger>

      {/* Quick actions */}
      <Reveal>
        <Eyebrow className="mb-3">Quick actions</Eyebrow>
        <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" delay={0.18}>
          <QuickAction icon={FolderInput} title="Add a build" hint="Choose your Fortnite folder" to="library" onGo={setPage} />
          <QuickAction icon={UserPlus} title="Join a friend" hint="By IP over Tailscale or Radmin VPN" to="servers" onGo={setPage} />
          <QuickAction icon={PanelsTopLeft} title="In-game menu" hint="Edit on release, field of view, keys" to="ingame" onGo={setPage} />
          <QuickAction icon={ScrollText} title="Live log" hint="See what's happening right now" to="logs" onGo={setPage} />
        </Stagger>
      </Reveal>
    </PageShell>
  );
}

function Dot() {
  return <span aria-hidden className="size-1 rounded-full bg-white/20" />;
}

function LaunchStateBadge({ step, total }: { step: number; total: number }) {
  const state = step < 0 ? "idle" : step >= total ? "done" : "running";
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={state}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1, transition: { duration: 0.2, ease: EASE_OUT } }}
        exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.12 } }}
      >
        {state === "idle" && <Badge variant="muted">Ready</Badge>}
        {state === "running" && (
          <Badge variant="default">
            <span className="nb-loop size-1.5 animate-pulse rounded-full bg-violet-text" />
            Step <NumberTicker value={Math.min(step + 1, total)} fromZero={false} /> of {total}
          </Badge>
        )}
        {state === "done" && <Badge variant="success">In the lobby</Badge>}
      </motion.span>
    </AnimatePresence>
  );
}

const statusTone: Record<ServiceStatus, IconTone> = {
  stopped: "brand",
  starting: "warning",
  running: "success",
  error: "danger",
};

function ServiceCard({ icon, name, status, detail }: { icon: LucideIcon; name: string; status: ServiceStatus; detail: string }) {
  return (
    <GlowCard
      kind="scale"
      className={cn(
        "relative overflow-hidden p-5 transition-shadow duration-300",
        status === "running" && "shadow-[0_0_0_1px_rgb(34_197_94/0.18),0_14px_40px_-22px_rgb(34_197_94/0.55)]",
        status === "error" && "shadow-[0_0_0_1px_rgb(239_68_68/0.25)]",
      )}
    >
      <div className="flex items-center gap-4">
        <IconTile icon={icon} tone={statusTone[status]} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">{name}</p>
            <StatusPill status={status} />
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      <AnimatePresence>
        {status === "starting" && (
          <motion.div
            key="starting"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-x-0 bottom-0"
          >
            <ProgressBeam value={1} active tip={false} className="h-[2px] rounded-none bg-transparent opacity-80" />
          </motion.div>
        )}
      </AnimatePresence>
    </GlowCard>
  );
}

function QuickAction({ icon, title, hint, to, onGo }: { icon: LucideIcon; title: string; hint: string; to: PageId; onGo: (p: PageId) => void }) {
  return (
    <GlowCard interactive kind="scale" onClick={() => onGo(to)} aria-label={title} className="flex h-full items-start gap-3 p-4">
      <IconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hint}</p>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-faint transition-[color,translate] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-violet-text" />
    </GlowCard>
  );
}
