import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Clock3, FolderSearch, Info, MousePointerClick, Play, Square, Timer } from "lucide-react";
import { api, imgSrc } from "@/lib/api";
import { formatDuration, formatRelative } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { todaySeconds, weekSeconds } from "@/lib/stats";
import type { Game } from "@/lib/types";
import { useNow } from "@/hooks/useNow";
import { liveSeconds, useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "@/components/GameCover";
import { Shelf } from "@/components/Shelf";
import { ClockWidget } from "@/components/widgets/ClockWidget";
import { GoalWidget } from "@/components/widgets/GoalWidget";
import { RandomWidget } from "@/components/widgets/RandomWidget";
import { SystemWidget } from "@/components/widgets/SystemWidget";
import { WeatherWidget } from "@/components/widgets/WeatherWidget";
import { Button } from "@shared/ui/Button";
import { NovaLogo } from "@shared/ui/NovaLogo";
import { spring, staggerContainer } from "@shared/design/motion";

function greeting(t: (k: string) => string) {
  const h = new Date().getHours();
  if (h < 5) return t("home.greetingNight");
  if (h < 11) return t("home.greetingMorning");
  if (h < 18) return t("home.greetingDay");
  return t("home.greetingEvening");
}

function Hero({ game }: { game: Game }) {
  const t = useT();
  const stats = useLibrary((s) => s.stats.get(game.id));
  const run = useLibrary((s) => s.running.get(game.id));
  const launching = useLibrary((s) => s.launching.has(game.id));
  const now = useNow(1000, !!run);
  const logo = game.images.logo;
  return (
    <motion.div initial={{ opacity: 0, y: 20, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring.smooth} className="glow-edge card-shadow group relative h-[300px] overflow-hidden rounded-2xl [--glow-opacity:0.35] hover:[--glow-opacity:1]">
      <div className="absolute inset-0 transition-transform duration-[1200ms] ease-nova group-hover:scale-[1.04]">
        <GameCover game={game} variant="hero" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/45 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
      <div className="relative flex h-full flex-col justify-end p-8">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[0.22em] text-white/70 uppercase">
          <span className="h-px w-6 bg-gradient-accent" />
          {t("home.continue")}
        </div>
        {logo ? (
          <img src={imgSrc(logo)} alt={game.name} className="mb-4 max-h-24 max-w-[380px] object-contain object-left drop-shadow-[0_6px_24px_rgb(0_0_0/0.6)]" draggable={false} />
        ) : (
          <h1 className="mb-3 max-w-xl font-display text-4xl leading-tight font-bold text-white [text-shadow:0_4px_24px_rgb(0_0_0/0.5)]">{game.name}</h1>
        )}
        <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-white/75">
          <span className="flex items-center gap-1.5">
            <Clock3 className="h-3.5 w-3.5" /> {formatDuration(liveSeconds(stats, run, now))}
          </span>
          {stats?.lastSessionSeconds && (
            <span className="flex items-center gap-1.5">
              <Timer className="h-3.5 w-3.5" /> {t("game.lastSession")}: {formatDuration(stats.lastSessionSeconds)}
            </span>
          )}
          <span>{run ? t("game.playing", { time: formatDuration((now - run.startedAt) / 1000, { showSeconds: true }) }) : t("home.continueSub", { when: formatRelative(stats?.lastPlayedAt) })}</span>
        </div>
        <div className="flex gap-3">
          {run ? (
            <Button variant="danger-solid" size="lg" icon={<Square className="h-4 w-4" fill="currentColor" />} onClick={() => void useLibrary.getState().stop(game.id)}>
              {t("common.stop")}
            </Button>
          ) : (
            <Button variant="primary" size="lg" loading={launching} icon={<Play className="h-5 w-5" fill="currentColor" />} silent onClick={() => void useLibrary.getState().launch(game)} className="min-w-40">
              {t("common.play")}
            </Button>
          )}
          <Button variant="ghost" size="lg" icon={<Info className="h-4 w-4" />} onClick={() => useUI.getState().navigate({ page: "game", id: game.id })} className="border border-white/20 bg-white/10 text-white backdrop-blur-md hover:bg-white/20 hover:text-white">
            Details
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

function Welcome() {
  const t = useT();
  return (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={spring.smooth} className="glass relative overflow-hidden rounded-2xl p-12">
      <div className="absolute -top-24 -right-24 h-80 w-80 rounded-full opacity-60 blur-3xl" style={{ background: "var(--nv-gradient)" }} />
      <div className="relative flex items-center gap-12">
        <NovaLogo size={150} mode="idle" />
        <div className="max-w-xl">
          <h1 className="font-display text-4xl font-bold text-fg">{t("home.emptyTitle")}</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-fg-soft">{t("home.emptyText")}</p>
          <div className="mt-7 flex flex-wrap items-center gap-4">
            <Button variant="primary" size="lg" icon={<FolderSearch className="h-5 w-5" />} onClick={() => useUI.getState().setScan(true)}>
              {t("home.emptyScan")}
            </Button>
            <span className="flex items-center gap-2 text-[13px] text-muted">
              <MousePointerClick className="h-4 w-4" /> {t("home.emptyDrop")}
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function Home() {
  const t = useT();
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const sessions = useLibrary((s) => s.sessions);
  const running = useLibrary((s) => s.running);
  const [profileName, setProfileName] = useState("");
  useEffect(() => {
    void api
      .profilesList()
      .then((p) => setProfileName(p.profiles.find((x) => x.id === p.activeId)?.name ?? ""))
      .catch(() => undefined);
  }, []);
  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);

  const recent = useMemo(
    () =>
      visible
        .filter((g) => stats.get(g.id)?.lastPlayedAt)
        .sort((a, b) => (stats.get(b.id)?.lastPlayedAt ?? 0) - (stats.get(a.id)?.lastPlayedAt ?? 0))
        .slice(0, 14),
    [visible, stats],
  );
  const favorites = useMemo(() => visible.filter((g) => g.favorite).slice(0, 20), [visible]);
  const newest = useMemo(() => [...visible].sort((a, b) => b.addedAt - a.addedAt).slice(0, 14), [visible]);
  const runningGame = [...running.keys()].map((id) => games.find((g) => g.id === id)).find(Boolean);
  const heroGame = runningGame ?? recent.find((g) => g.kind === "game") ?? favorites[0] ?? visible.find((g) => g.kind === "game");

  useEffect(() => {
    if (heroGame) useUI.getState().setFocusGame(heroGame.id);
  }, [heroGame]);

  const week = weekSeconds(sessions);
  const today = todaySeconds(sessions);

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-8 px-8 pt-4 pb-28">
      <div className="flex items-end justify-between gap-6">
        <div>
          <motion.h1 initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} className="font-display text-3xl font-bold text-fg">
            {greeting(t)}
            {profileName && `, ${profileName}`}
            <span className="text-gradient">.</span>
          </motion.h1>
          <p className="mt-1 text-sm text-muted">{t("app.tagline")}</p>
        </div>
        {visible.length > 0 && (
          <div className="flex gap-3">
            <div className="glass rounded-xl px-4 py-2.5 text-right">
              <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t("home.playedToday")}</div>
              <div className="font-display text-lg font-bold text-fg tabular">{formatDuration(today, { short: true })}</div>
            </div>
            <div className="glass rounded-xl px-4 py-2.5 text-right">
              <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t("home.thisWeek")}</div>
              <div className="font-display text-lg font-bold text-fg tabular">{formatDuration(week, { short: true })}</div>
            </div>
          </div>
        )}
      </div>

      {visible.length === 0 ? <Welcome /> : heroGame && <Hero game={heroGame} />}

      <motion.div variants={staggerContainer(0.06, 0.15)} initial="initial" animate="enter" className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-5">
        <ClockWidget />
        <WeatherWidget />
        <SystemWidget />
        <GoalWidget />
        <div className="lg:col-span-2 2xl:col-span-1 [&>*]:h-full">
          <RandomWidget />
        </div>
      </motion.div>

      <Shelf title={t("home.recent")} games={recent} />
      <Shelf
        title={t("home.favorites")}
        games={favorites}
        action={
          <button type="button" onClick={() => (useUI.getState().setFilter({ favoritesOnly: true }), useUI.getState().navigate({ page: "library" }))} className="flex items-center gap-1 text-[13px] text-muted transition hover:text-fg">
            {t("home.seeAll")} <ArrowRight className="h-3.5 w-3.5" />
          </button>
        }
      />
      <Shelf title={t("home.newlyAdded")} games={newest} />
    </div>
  );
}
