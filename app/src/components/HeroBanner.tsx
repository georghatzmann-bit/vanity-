import { motion } from "motion/react";
import { Clock, Info, Play, Radar, Sparkles, Square, Timer, Zap } from "lucide-react";
import { imgSrc } from "@/lib/api";
import { formatClock, formatDuration, formatRelative } from "@/lib/format";
import { gradeColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Game, PlayStats, RunningGame, SessionReport } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameCover } from "./GameCover";
import { Button } from "@shared/ui/Button";
import { PulsarLogo } from "@shared/ui/PulsarLogo";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";

/**
 * Großes Banner im Cockpit (wie „Weiterspielen“ bei NOVA): Hintergrundbild und Logo des Spiels,
 * Spielzeit, letzte Runde mit Note – und direkt „Boost & Spielen“.
 */
export function HeroBanner({ game, stats, running, report, now, targetLabel }: { game?: Game; stats?: PlayStats; running?: RunningGame; report?: SessionReport; now: number; targetLabel: string }) {
  const t = useT();
  const navigate = useUI((s) => s.navigate);
  const launching = useLibrary((s) => (game ? s.launching.has(game.id) : false));

  if (!game) {
    return (
      <div className="glass relative flex h-[260px] items-center overflow-hidden rounded-2xl px-10">
        <div className="absolute -right-10 -bottom-24 opacity-30">
          <PulsarLogo size={420} mode="idle" glow={false} />
        </div>
        <div className="relative max-w-[520px]">
          <div className="flex items-center gap-3 text-[11px] font-semibold tracking-[0.2em] text-accent uppercase">
            <span className="h-px w-8 bg-accent" />
            {t("games.title")}
          </div>
          <h2 className="mt-3 font-display text-3xl font-bold text-fg">{t("cockpit.heroEmpty")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("cockpit.heroEmptyText")}</p>
          <Button variant="primary" size="lg" className="mt-5" icon={<Radar className="h-4 w-4" />} onClick={() => useUI.getState().setScan(true)}>
            {t("games.fillLibrary")}
          </Button>
        </div>
      </div>
    );
  }

  const isGame = game.kind === "game";
  const hasHero = !!game.images.hero;
  const open = () => navigate({ page: "game", id: game.id });

  return (
    <motion.div layout className="group relative h-[280px] overflow-hidden rounded-2xl shadow-[0_30px_80px_-40px_rgb(0_0_0/0.9)] ring-1 ring-white/[0.06]">
      {/* Hintergrundbild des Spiels – ohne breites Bild: unscharfes Cover bzw. Farbverlauf */}
      <motion.div className="absolute inset-0" initial={{ scale: 1.06, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}>
        <div className={cn("h-full w-full transition-transform duration-[1400ms] ease-out group-hover:scale-[1.04]", !hasHero && "scale-125 opacity-70 blur-2xl")}>
          <GameCover game={game} variant="hero" imgClassName="object-[50%_25%]" />
        </div>
      </motion.div>
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--nv-bg)]/95 via-[var(--nv-bg)]/55 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-t from-[var(--nv-bg)]/80 via-transparent to-transparent" />

      {/* Kein breites Bild: Cover schwebt rechts im Banner */}
      {!hasHero && (
        <motion.div className="absolute top-16 right-[7%] hidden h-[196px] w-[131px] lg:block" initial={{ opacity: 0, y: 30, rotate: 0 }} animate={{ opacity: 1, y: 0, rotate: 5 }} transition={{ ...spring.gravity, delay: 0.2 }}>
          <div className="absolute -inset-6 rounded-[28px] bg-[radial-gradient(circle,var(--nv-glow-a),transparent_70%)] blur-xl" />
          <div className="relative h-full w-full overflow-hidden rounded-xl shadow-[0_24px_60px_-20px_rgb(0_0_0/0.9)] ring-1 ring-white/15 transition-transform duration-500 group-hover:-translate-y-1 group-hover:rotate-[-2deg]">
            <GameCover game={game} />
          </div>
        </motion.div>
      )}

      {/* Messziel oben rechts */}
      <div className="absolute top-4 right-4 flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 text-[11px] font-medium text-white/85 backdrop-blur-md">
        <Radar className="h-3.5 w-3.5 text-accent" />
        {t("cockpit.measuringTo", { target: game.serverGame ? t(`network.regions.games.${game.serverGame}`) : targetLabel })}
      </div>

      <div className="relative flex h-full max-w-[640px] flex-col justify-center px-9">
        <div className="flex items-center gap-3 text-[11px] font-semibold tracking-[0.22em] uppercase">
          {running ? (
            <span className="flex items-center gap-2 text-success">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-70" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              {t("cockpit.runningGame")}
            </span>
          ) : (
            <span className="flex items-center gap-3 text-accent">
              <span className="h-px w-8 bg-accent" />
              {t("cockpit.continue")}
            </span>
          )}
        </div>

        <button type="button" onClick={open} className="mt-3 block w-fit text-left" title={game.name}>
          {game.images.logo ? (
            <motion.img src={imgSrc(game.images.logo)} alt={game.name} className="nv-logo max-h-[92px] max-w-[380px] object-contain object-left" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring.gravity, delay: 0.15 }} />
          ) : (
            <motion.h2 className="font-display text-[40px] leading-tight font-bold text-fg" initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ ...spring.gravity, delay: 0.15 }}>
              {game.name}
            </motion.h2>
          )}
        </button>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-fg-soft">
          {running ? (
            <span className="flex items-center gap-1.5 font-display text-lg font-bold text-fg tabular">
              <Timer className="h-4 w-4 text-success" /> {formatClock((now - running.startedAt) / 1000)}
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" /> {stats?.totalSeconds ? formatDuration(stats.totalSeconds, { short: true }) : t("games.neverPlayed")}
              </span>
              {stats?.lastPlayedAt ? <span>{formatRelative(stats.lastPlayedAt)}</span> : null}
            </>
          )}
          {report && !running && (
            <span className="flex items-center gap-2">
              <span className="rounded-md px-1.5 py-0.5 font-display text-[12px] font-bold" style={{ color: gradeColor(report.grade), background: `color-mix(in oklab, ${gradeColor(report.grade)} 22%, transparent)` }}>
                {report.grade}
              </span>
              <span>
                Ø {Math.round(report.avgPing ?? 0)} ms · {t("cockpit.spikes", { n: report.spikes })}
              </span>
              {report.boosted && <Sparkles className="h-3.5 w-3.5 text-accent" />}
            </span>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2.5">
          {running ? (
            <Button variant="danger-solid" size="lg" icon={<Square className="h-4 w-4" />} onClick={() => void useLibrary.getState().stop(game.id)}>
              {t("common.stop")}
            </Button>
          ) : (
            <>
              <Button variant="primary" size="lg" icon={<Zap className="h-4 w-4" />} loading={launching} onClick={() => void useLibrary.getState().launch(game, { boost: isGame })}>
                {isGame ? t("games.boostAndPlay") : t("common.start")}
              </Button>
              {isGame && (
                <Button variant="glass" size="lg" icon={<Play className="h-4 w-4" />} onClick={() => void useLibrary.getState().launch(game, { boost: false })}>
                  {t("common.play")}
                </Button>
              )}
            </>
          )}
          <Button variant="ghost" size="lg" icon={<Info className="h-4 w-4" />} onClick={open} className="text-fg-soft">
            {t("cockpit.details")}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
