import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CircleCheck,
  CircleSlash,
  FlaskConical,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Lock,
  Network,
  Palette,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageHeader, PageShell, Panel, SettingRow } from "@/components/common";
import { GlowCard, NewDot, Stagger } from "@/components/fx";
import { useBubbleSupport } from "@/hooks/use-bubble-support";
import { useMediaQuery } from "@/hooks/use-media-query";
import { api, BACKEND_PORT, GAME_SERVER_PORT, openFolder, type Settings } from "@/lib/api";
import { bubbleText, isExperimentalLevel, needsLowMeshes, type BubbleLevel } from "@/lib/bubble";
import { EASE_OUT, SPRING_PLAYFUL } from "@/lib/motion";
import { activeProfile, buildOf, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

function PortInput({ id, value, onChange, min }: { id: string; value: number; onChange: (v: number) => void; min: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const n = Number(text);
  const ok = /^\d+$/.test(text) && n >= min && n <= 65535;
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        id={id}
        value={text}
        inputMode="numeric"
        onChange={(e) => {
          const t = e.target.value.replace(/\D/g, "").slice(0, 5);
          setText(t);
          const v = Number(t);
          if (v >= min && v <= 65535) onChange(v);
        }}
        aria-invalid={!ok}
        className="h-8 w-24 text-right font-mono text-xs tabular-nums"
      />
      {!ok && <span className="text-xs text-destructive">{min}–65535</span>}
    </div>
  );
}

/** A port that can't be changed: looks like the port inputs, but plain text with a lock. */
function FixedPort({ value }: { value: number }) {
  return (
    <span
      aria-label={`Port ${value}, fixed`}
      className="inline-flex h-8 w-24 shrink-0 items-center justify-between gap-2 rounded-lg bg-white/[0.02] px-3 font-mono text-xs text-muted-foreground tabular-nums ring-1 ring-white/[0.06] ring-inset"
    >
      <Lock className="size-3 text-faint" aria-hidden />
      {value}
    </span>
  );
}

const rows = "flex flex-col divide-y divide-white/[0.05]";

export function SettingsPage() {
  const settings = useApp((s) => s.config.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const [paths, setPaths] = useState<{ config: string } | null>(null);
  const wide = useMediaQuery("(min-width: 1280px)");

  useEffect(() => {
    api.paths().then(setPaths).catch(() => {});
  }, []);

  const update = (patch: Partial<Settings>) => {
    void saveSettings(patch);
  };

  const general = (
    <Panel icon={UserRound} title="General" description="Applies to all profiles unless a profile says otherwise.">
      <div className={rows}>
        <SettingRow label="Player name" hint="Your name in the lobby and in matches" htmlFor="set-player">
          <Input id="set-player" defaultValue={settings.playerName} onBlur={(e) => update({ playerName: e.target.value })} className="h-8 w-40" />
        </SettingRow>
        <SettingRow label="Language" hint="More languages aren't planned">
          <span className="text-sm text-muted-foreground">English</span>
        </SettingRow>
      </div>
    </Panel>
  );
  const look = (
    <Panel icon={Palette} title="Look" description="These three switches work right away.">
      <div className={rows}>
        <SettingRow label="Reduce motion" hint="Less movement – changes happen instantly" htmlFor="set-motion">
          <Switch id="set-motion" checked={settings.reduceMotion} onCheckedChange={(v) => update({ reduceMotion: v })} />
        </SettingRow>
        <SettingRow label="Glass effect" hint="See-through surfaces. Off = plainer and a bit faster" htmlFor="set-glass">
          <Switch id="set-glass" checked={settings.glass} onCheckedChange={(v) => update({ glass: v })} />
        </SettingRow>
        <SettingRow label="Animated background" hint="The colours behind the glass drift slowly" htmlFor="set-bg">
          <Switch id="set-bg" checked={settings.animatedBackground} onCheckedChange={(v) => update({ animatedBackground: v })} />
        </SettingRow>
      </div>
    </Panel>
  );
  const game = (
    <Panel icon={Gamepad2} title="Game" description="How Fortnite is started.">
      <div className={rows}>
        <SettingRow
          label="Launch arguments"
          hint="Added to every launch. -d3d11 is recommended up to Chapter 5; from 33.00 Rift leaves it out by itself"
          htmlFor="set-args"
        >
          <Input id="set-args" defaultValue={settings.launchArgs} onBlur={(e) => update({ launchArgs: e.target.value })} className="h-8 w-40 font-mono text-xs" />
        </SettingRow>
        <SettingRow label="Server with no graphics" hint="The server Fortnite runs without a window and saves performance" htmlFor="set-headless">
          <Switch id="set-headless" checked={settings.headlessServer} onCheckedChange={(v) => update({ headlessServer: v })} />
        </SettingRow>
        <SettingRow
          label="Show the server window (for troubleshooting)"
          hint="Normally hidden: you control the match in the game (F9 → Host) and on Match Control. Only turn this on if something doesn't work"
          htmlFor="set-server-window"
        >
          <Switch
            id="set-server-window"
            checked={settings.showServerWindow ?? false}
            onCheckedChange={(v) => update({ showServerWindow: v })}
          />
        </SettingRow>
      </div>
    </Panel>
  );
  const network = (
    <Panel icon={Network} title="Network" description="Change the matchmaker port only if port 80 is already in use.">
      <div className={rows}>
        <SettingRow label="Backend port" hint="Fixed – the game always connects to this port.">
          <FixedPort value={BACKEND_PORT} />
        </SettingRow>
        <SettingRow label="Matchmaker port" hint="For match start and friends. Default: 80" htmlFor="set-mport">
          <PortInput id="set-mport" value={settings.matchmakerPort} onChange={(v) => update({ matchmakerPort: v })} min={1} />
        </SettingRow>
        <SettingRow label="Game server port" hint="Fixed – the game server always listens on this port.">
          <FixedPort value={GAME_SERVER_PORT} />
        </SettingRow>
        <SettingRow label="Share the backend on your network" hint="Only needed if friends should use your backend instead of their own" htmlFor="set-lan">
          <Switch id="set-lan" checked={settings.shareBackendLan} onCheckedChange={(v) => update({ shareBackendLan: v })} />
        </SettingRow>
      </div>
    </Panel>
  );
  const data = (
    <Panel icon={HardDrive} title="Data" description="Where Rift keeps its own files.">
      <SettingRow label="Location" hint="Settings, profiles and logs of Rift">
        <span className="font-mono text-xs text-muted-foreground">%APPDATA%\Rift</span>
        <Button variant="secondary" size="sm" onClick={() => paths && openFolder(paths.config)}>
          <FolderOpen />
          Open
        </Button>
      </SettingRow>
    </Panel>
  );
  const safety = (
    <Panel icon={ShieldCheck} title="Safety" description="These limits are built in.">
      <ul className="flex flex-col gap-3">
        {[
          "Only builds you own: Rift starts every version from 1.7 to 30.x; 19.10 is tested.",
          "Every request goes to your own backend, never to Epic's real servers.",
          "Nothing outside Rift is changed without asking you.",
        ].map((text) => (
          <li key={text} className="flex gap-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-violet-text/70" />
            <span className="text-foreground/90">{text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );

  return (
    <PageShell>
      <PageHeader
        title="Settings"
        description="Basic settings for Rift. Anything that should differ per profile, you set under Profiles."
      />

      <BubbleBuildsCard on={settings.bubbleBuilds} onChange={(v) => update({ bubbleBuilds: v })} />

      {/* Wide: two columns that fill up on their own (no gaps between rows). Narrow: one list in reading order. */}
      {wide ? (
        <div className="grid grid-cols-2 items-start gap-6">
          <Stagger className="flex flex-col gap-6" delay={0.1} stagger={0.07}>
            {general}
            {game}
            {safety}
          </Stagger>
          <Stagger className="flex flex-col gap-6" delay={0.13} stagger={0.07}>
            {look}
            {network}
            {data}
          </Stagger>
        </div>
      ) : (
        <Stagger className="flex flex-col gap-6" delay={0.1} stagger={0.06}>
          {general}
          {look}
          {game}
          {network}
          {data}
          {safety}
        </Stagger>
      )}
    </PageShell>
  );
}

/**
 * The Bubble Builds option: switch + what it does + whether the active profile's build can show it.
 * The level comes from Rust (api.bubbleBuildsSupport), with the same rules mirrored locally.
 */
function BubbleBuildsCard({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const config = useApp((s) => s.config);
  const gameRunning = useApp((s) => s.services.game === "running");
  const build = buildOf(config, activeProfile(config)?.buildId);
  const info = useBubbleSupport(build?.version);
  const level: BubbleLevel | null = info?.level ?? null;
  const lit = on && level !== null && level !== "unavailable";

  return (
    <GlowCard glow={on} className="relative overflow-hidden">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -top-24 -left-16 size-72 rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.28),transparent)] transition-opacity duration-500",
          on ? "opacity-100" : "opacity-40",
        )}
      />
      <div aria-hidden className="pointer-events-none absolute -right-10 -bottom-20 size-56 rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.18),transparent)]" />

      <div className="relative flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
        <BubbleWrap lit={lit} on={on} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="set-bubble" className="text-[15px] font-semibold">
              {bubbleText.label}
            </label>
            {isExperimentalLevel(level) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="warning" tabIndex={0} className="cursor-help">
                    <FlaskConical />
                    {bubbleText.experimentalBadge}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-64">{level === "lowMeshes" ? bubbleText.lowMeshesHint : bubbleText.experimentalHint}</TooltipContent>
              </Tooltip>
            ) : (
              <Badge variant="gold" className="gap-1.5">
                <NewDot className="size-1.5" />
                New
              </Badge>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {level === "lowMeshes" ? bubbleText.lowMeshesHint : bubbleText.hint}
          </p>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${build?.version ?? "none"}-${level ?? "none"}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE_OUT } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              className="mt-3"
            >
              <BuildStatus version={build?.version ?? null} level={level} />
            </motion.div>
          </AnimatePresence>

          {level && level !== "unavailable" && (
            <p className="mt-2 max-w-2xl text-[11px] leading-relaxed text-faint">
              {needsLowMeshes(level) ? bubbleText.settingsNoteMeshes : bubbleText.settingsNotePerformance}
            </p>
          )}
          {gameRunning && <p className="mt-2 text-[11px] text-faint">{bubbleText.restartHint} A change applies on the next launch.</p>}
        </div>

        <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end">
          <Switch id="set-bubble" checked={on} onCheckedChange={onChange} aria-label={bubbleText.label} />
          <span className={cn("text-[11px] font-medium transition-colors", on ? "text-violet-text" : "text-faint")}>{on ? "On" : "Off"}</span>
        </div>
      </div>
    </GlowCard>
  );
}

/** One line about the active build: works / experimental / not on this version. */
function BuildStatus({ version, level }: { version: string | null; level: BubbleLevel | null }) {
  if (!version || !level) {
    return <p className="text-xs text-muted-foreground">Add a build in the Library to see if it works with Bubble Builds.</p>;
  }
  const name = (
    <span className="font-medium text-foreground">
      Fortnite <span className="tabular-nums">{version}</span>
    </span>
  );
  if (level === "supported") {
    return (
      <p className="inline-flex items-start gap-2 rounded-lg bg-success/[0.08] px-3 py-2 text-xs text-success ring-1 ring-success/20">
        <CircleCheck className="mt-px size-3.5 shrink-0" />
        <span>
          Works on your active build, {name}.
        </span>
      </p>
    );
  }
  if (level === "experimental") {
    return (
      <p className="inline-flex items-start gap-2 rounded-lg bg-warning/[0.08] px-3 py-2 text-xs text-warning ring-1 ring-warning/20">
        <FlaskConical className="mt-px size-3.5 shrink-0" />
        <span>
          {name}: {bubbleText.experimentalHint}
        </span>
      </p>
    );
  }
  if (level === "lowMeshes") {
    return (
      <p className="inline-flex items-start gap-2 rounded-lg bg-warning/[0.08] px-3 py-2 text-xs text-warning ring-1 ring-warning/20">
        <FlaskConical className="mt-px size-3.5 shrink-0" />
        <span>Works as an experiment on your active build, {name}. It's not the exact Chapter 2 look.</span>
      </p>
    );
  }
  return (
    <p className="inline-flex items-start gap-2 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-muted-foreground ring-1 ring-white/[0.06]">
      <CircleSlash className="mt-px size-3.5 shrink-0" />
      <span>
        Not available on your active build, {name}. {bubbleText.unavailableWhere}
      </span>
    </p>
  );
}

/** A little sheet of bubble wrap: the bubbles fill up and glow when the option is on. */
function BubbleWrap({ lit, on }: { lit: boolean; on: boolean }) {
  const cells = Array.from({ length: 12 });
  return (
    <motion.div
      aria-hidden
      initial={false}
      animate={on ? "on" : "off"}
      variants={{ on: { transition: { staggerChildren: 0.035 } }, off: { transition: { staggerChildren: 0.02, staggerDirection: -1 } } }}
      className={cn(
        "grid size-[84px] shrink-0 grid-cols-4 place-items-center gap-1 rounded-2xl p-2.5 ring-1 transition-[background-color,box-shadow] duration-500",
        on ? "bg-brand-violet/[0.12] ring-brand-violet/30 shadow-[0_0_30px_-8px_rgb(139_92_246/0.6)]" : "bg-white/[0.03] ring-white/[0.08]",
      )}
    >
      {cells.map((_, i) => (
        <motion.span
          key={i}
          variants={{
            on: { scale: [0.6, 1.12, 1], opacity: 1, transition: SPRING_PLAYFUL },
            off: { scale: 0.86, opacity: 0.55, transition: { duration: 0.2 } },
          }}
          className={cn(
            "size-[14px] rounded-full transition-[background,box-shadow] duration-500",
            lit
              ? "bg-[radial-gradient(circle_at_32%_30%,rgb(255_255_255/0.85),rgb(196_181_253/0.55)_35%,rgb(139_92_246/0.25)_75%)] shadow-[0_0_10px_rgb(139_92_246/0.55)]"
              : on
                ? "bg-[radial-gradient(circle_at_32%_30%,rgb(255_255_255/0.5),rgb(196_181_253/0.25)_40%,transparent_80%)] ring-1 ring-white/15"
                : "bg-[radial-gradient(circle_at_32%_30%,rgb(255_255_255/0.25),transparent_60%)] ring-1 ring-white/10",
          )}
        />
      ))}
    </motion.div>
  );
}
