import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  FolderInput,
  Gamepad2,
  Loader2,
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
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconTile, PageShell, Reveal, StatusPill } from "@/components/common";
import { runDemoLaunch, stopDemoLaunch } from "@/components/LaunchDemoDriver";
import { api, inTauri, type ServiceStatus } from "@/lib/api";
import { activeProfile, buildOf, launchSteps, useApp, type PageId } from "@/lib/store";
import { cn } from "@/lib/utils";

export function StartPage() {
  const config = useApp((s) => s.config);
  const services = useApp((s) => s.services);
  const launchStep = useApp((s) => s.launchStep);
  const setPage = useApp((s) => s.setPage);

  const profile = activeProfile(config);
  const build = buildOf(config, profile?.buildId);
  const running = launchStep >= 0 && launchStep < launchSteps.length;
  const done = launchStep >= launchSteps.length;
  const busy = running || done;

  const start = async () => {
    if (!profile) {
      toast.error("Kein Profil", { description: "Lege zuerst in der Bibliothek einen Build an." });
      return;
    }
    if (!inTauri) {
      runDemoLaunch();
      return;
    }
    try {
      await api.hostAndPlay(profile.id);
    } catch (e) {
      toast.error("Start fehlgeschlagen", { description: String(e) });
    }
  };

  const stop = async () => {
    if (!inTauri) {
      stopDemoLaunch();
      toast("Alles gestoppt");
      return;
    }
    await api.stopAll();
  };

  const setActive = (id: string) => {
    useApp.setState((s) => ({ config: { ...s.config, activeProfileId: id } }));
    api.setActiveProfile(id);
  };

  return (
    <PageShell>
      <Reveal className="glass relative overflow-hidden rounded-xl">
        <HeroGlow />
        <div className="relative flex flex-col gap-8 p-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-md bg-white/[0.08] px-2 py-1 font-medium">
                {build?.season ?? "Kein Build"}
              </span>
              <span className="text-muted-foreground">Aktiver Build</span>
            </div>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight">
              {build ? (
                <>
                  Fortnite <span className="text-primary-text">{build.version}</span>
                </>
              ) : (
                "Noch kein Build"
              )}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {build
                ? `${build.changelist ? `CL-${build.changelist} · ` : ""}${build.engine} · Start mit ${profile?.launchArgs || "-d3d11"}`
                : "Füge in der Bibliothek deinen Fortnite-Ordner hinzu (z. B. 19.10)."}
            </p>
            {config.profiles.length > 0 && (
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted-foreground">Profil</span>
                <Select value={profile?.id} onValueChange={setActive} disabled={busy}>
                  <SelectTrigger className="h-9 w-52 bg-white/[0.05]">
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
            )}
          </div>

          <div className="flex flex-col items-start gap-3 lg:items-end">
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.div key="stop" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}>
                  <Button size="lg" variant="secondary" onClick={stop} className="h-12 min-w-56 gap-3 px-8 font-semibold">
                    {running ? <Loader2 className="size-5 animate-spin" /> : <Square className="size-4" />}
                    {running ? "Startet … · Abbrechen" : "Alles stoppen"}
                  </Button>
                </motion.div>
              ) : (
                <motion.div key="start" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                  <Button size="lg" onClick={start} disabled={!build || build.support !== "supported"} className="glow-primary h-12 min-w-56 gap-3 px-8 font-semibold">
                    <Play className="size-5 fill-current" />
                    Host &amp; Play
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
            <p className="max-w-56 text-right text-xs text-muted-foreground">
              Startet Backend, Server und dein Spiel mit einem Klick.
            </p>
          </div>
        </div>
      </Reveal>

      <Reveal className="glass rounded-xl px-6 pt-5 pb-5">
        <h2 className="text-sm font-semibold">Startablauf</h2>
        <p className="mt-1 text-xs text-muted-foreground">Was bei „Host &amp; Play“ nacheinander passiert.</p>
        <div className="mt-4">
          <LaunchTimeline step={launchStep} />
        </div>
      </Reveal>

      <div className="grid gap-4 md:grid-cols-3">
        <ServiceCard icon={Waypoints} name="Backend" status={services.backend} detail={`127.0.0.1:${config.settings.backendPort}`} />
        <ServiceCard icon={Server} name="Game Server" status={services.server} detail={`127.0.0.1:${config.settings.gameServerPort} · ohne Grafik`} />
        <ServiceCard icon={Gamepad2} name="Dein Spiel" status={services.game} detail={build ? `Fortnite ${build.version}` : "–"} />
      </div>

      <Reveal>
        <h2 className="mb-3 text-sm font-semibold">Schnellzugriff</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <QuickAction icon={FolderInput} title="Build importieren" hint="Ordner wählen, Version wird erkannt" to="library" onGo={setPage} />
          <QuickAction icon={UserPlus} title="Bei Freund beitreten" hint="Per IP über Tailscale oder Radmin" to="servers" onGo={setPage} />
          <QuickAction icon={PanelsTopLeft} title="Ingame-Menü" hint="Edit on Release, FOV, Tasten" to="ingame" onGo={setPage} />
          <QuickAction icon={ScrollText} title="Live-Log" hint="Sehen, was gerade passiert" to="logs" onGo={setPage} />
        </div>
      </Reveal>
    </PageShell>
  );
}

function HeroGlow() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true">
      <div className="absolute -top-24 -right-16 size-96 rounded-full bg-primary/30 blur-3xl" />
      <div className="absolute -bottom-32 left-1/3 size-80 rounded-full bg-[#1f4fd1]/20 blur-3xl" />
      <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 22px)", maskImage: "linear-gradient(90deg, transparent 35%, black 100%)" }} />
    </div>
  );
}

function LaunchTimeline({ step }: { step: number }) {
  const total = launchSteps.length;
  const progress = step < 0 ? 0 : Math.min(step / (total - 1), 1);
  return (
    <div className="relative">
      <div className="absolute top-4 right-[7%] left-[7%] h-0.5 rounded-full bg-white/[0.06]">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-primary to-primary-text" initial={false} animate={{ width: `${progress * 100}%` }} transition={{ duration: 0.4, ease: [0.2, 0, 0, 1] }} />
      </div>
      <ol className="relative grid grid-cols-7 gap-2">
        {launchSteps.map((s, i) => {
          const state = step > i ? "done" : step === i ? "active" : "pending";
          return (
            <li key={s.label} className="flex flex-col items-center text-center">
              <motion.div initial={false} animate={{ scale: state === "active" ? 1.1 : 1 }} className={cn("flex size-8 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-200", state === "done" && "bg-success/20 text-success", state === "active" && "bg-primary text-primary-foreground glow-primary", state === "pending" && "bg-[#1b1e29] text-muted-foreground ring-1 ring-white/[0.08]")}>
                {state === "done" ? <Check className="size-4" /> : state === "active" ? <Loader2 className="size-4 animate-spin" /> : i + 1}
              </motion.div>
              <p className={cn("mt-3 text-xs font-medium", state === "pending" && "text-muted-foreground")}>{s.label}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.hint}</p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ServiceCard({ icon, name, status, detail }: { icon: LucideIcon; name: string; status: ServiceStatus; detail: string }) {
  return (
    <Reveal className="glass flex items-center gap-4 rounded-xl p-5">
      <IconTile icon={icon} className={cn("transition-colors duration-200", status === "running" && "bg-success/15 text-success", status === "starting" && "bg-warning/15 text-warning")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{name}</p>
          <StatusPill status={status} />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
      </div>
    </Reveal>
  );
}

function QuickAction({ icon, title, hint, to, onGo }: { icon: LucideIcon; title: string; hint: string; to: PageId; onGo: (p: PageId) => void }) {
  return (
    <motion.button type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} transition={{ duration: 0.15 }} onClick={() => onGo(to)} className="glass flex items-center gap-3 rounded-xl p-4 text-left outline-none transition-colors hover:bg-white/[0.06] focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <IconTile icon={icon} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{hint}</p>
      </div>
    </motion.button>
  );
}
