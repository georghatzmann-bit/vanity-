import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { BarChart3, CalendarRange, Clock3, Crown, Flame, Gamepad2, Hourglass, ListChecks, Sparkles, Timer, TrendingUp, Trophy } from "lucide-react";
import { formatDuration, formatHours } from "@/lib/format";
import { getLanguage, useT } from "@/lib/i18n";
import { backlogEstimate, heatmap, monthSeconds, perDay, perHour, perWeek, streaks, topGames, weekSeconds, yearReview } from "@/lib/stats";
import { useLibrary } from "@/store/library";
import { BarChart } from "@/components/charts/BarChart";
import { Heatmap } from "@/components/charts/Heatmap";
import { RadialHours } from "@/components/charts/RadialHours";
import { TopList } from "@/components/charts/TopList";
import { GameCover } from "@/components/GameCover";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { CountUp } from "@shared/ui/CountUp";
import { staggerContainer, staggerItem } from "@shared/design/motion";

function Kpi({ icon, label, children, accent }: { icon: React.ReactNode; label: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <motion.div variants={staggerItem} className={`glass relative overflow-hidden rounded-xl p-4 ${accent ? "ring-1 ring-accent/40" : ""}`}>
      {accent && <div className="absolute -top-10 -right-10 h-28 w-28 rounded-full opacity-40 blur-2xl" style={{ background: "var(--nv-gradient)" }} />}
      <div className="relative flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <span className="text-accent">{icon}</span>
        {label}
      </div>
      <div className="relative mt-2 font-display text-2xl font-bold text-fg tabular">{children}</div>
    </motion.div>
  );
}

function Card({ title, icon, children, className, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <motion.section variants={staggerItem} className={`glass rounded-xl p-5 ${className ?? ""}`}>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
          <span className="text-accent">{icon}</span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </motion.section>
  );
}

export function Stats() {
  const t = useT();
  const sessions = useLibrary((s) => s.sessions);
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const [range, setRange] = useState<"7" | "30" | "90">("30");
  const year = new Date().getFullYear();
  const loc = getLanguage() === "de" ? "de-DE" : "en-US";

  const total = useMemo(() => [...stats.values()].reduce((a, s) => a + s.totalSeconds, 0), [stats]);
  const days = useMemo(() => perDay(sessions, Number(range)), [sessions, range]);
  const weeks = useMemo(() => perWeek(sessions, 12), [sessions]);
  const hours = useMemo(() => perHour(sessions), [sessions]);
  const st = useMemo(() => streaks(sessions), [sessions]);
  const top = useMemo(() => topGames(sessions, 8).map((x) => ({ game: games.find((g) => g.id === x.gameId), seconds: x.seconds })).filter((x): x is { game: (typeof games)[number]; seconds: number } => !!x.game), [sessions, games]);
  const heat = useMemo(() => heatmap(sessions, new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime()), [sessions, year]);
  const review = useMemo(() => yearReview(sessions, year), [sessions, year]);
  const backlog = useMemo(() => backlogEstimate(games, stats, sessions), [games, stats, sessions]);
  const reviewGame = games.find((g) => g.id === review.topGameId);
  const avg = sessions.length ? sessions.reduce((a, s) => a + s.seconds, 0) / sessions.length : 0;

  if (!sessions.length && total === 0) {
    return (
      <div className="mx-auto max-w-[1500px] px-8 pt-4">
        <h1 className="font-display text-3xl font-bold text-fg">{t("stats.title")}</h1>
        <EmptyState icon={<BarChart3 className="h-7 w-7" />} title={t("stats.title")} text={t("stats.noData")} />
      </div>
    );
  }

  const etaText = (() => {
    if (!Number.isFinite(backlog.weeks)) return "";
    if (backlog.weeks < 8) return `${Math.max(1, Math.round(backlog.weeks))} ${getLanguage() === "de" ? "Wochen" : "weeks"}`;
    if (backlog.weeks < 104) return `${Math.round(backlog.weeks / 4.345)} ${getLanguage() === "de" ? "Monaten" : "months"}`;
    return `${(backlog.weeks / 52).toFixed(1)} ${getLanguage() === "de" ? "Jahren" : "years"}`;
  })();

  return (
    <div className="mx-auto max-w-[1500px] px-8 pt-4 pb-28">
      <h1 className="font-display text-3xl font-bold text-fg">{t("stats.title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("stats.subtitle")}</p>

      <motion.div variants={staggerContainer(0.05, 0.05)} initial="initial" animate="enter" className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
        <Kpi icon={<Clock3 className="h-3.5 w-3.5" />} label={t("stats.total")} accent>
          <CountUp value={total / 3600} format={(v) => `${v.toLocaleString(loc, { maximumFractionDigits: 0 })} ${t("time.h")}`} />
        </Kpi>
        <Kpi icon={<CalendarRange className="h-3.5 w-3.5" />} label={t("stats.week")}>
          {formatDuration(weekSeconds(sessions), { short: true })}
        </Kpi>
        <Kpi icon={<CalendarRange className="h-3.5 w-3.5" />} label={t("stats.month")}>
          {formatDuration(monthSeconds(sessions), { short: true })}
        </Kpi>
        <Kpi icon={<Flame className="h-3.5 w-3.5" />} label={t("stats.streak")}>
          <CountUp value={st.current} /> <span className="text-sm font-medium text-muted">{t("time.days")}</span>
        </Kpi>
        <Kpi icon={<Trophy className="h-3.5 w-3.5" />} label={t("stats.bestStreak")}>
          <CountUp value={st.best} /> <span className="text-sm font-medium text-muted">{t("time.days")}</span>
        </Kpi>
        <Kpi icon={<Gamepad2 className="h-3.5 w-3.5" />} label={t("stats.gamesPlayed")}>
          <CountUp value={stats.size} />
        </Kpi>
        <Kpi icon={<ListChecks className="h-3.5 w-3.5" />} label={t("stats.sessions")}>
          <CountUp value={sessions.length} />
        </Kpi>
        <Kpi icon={<Timer className="h-3.5 w-3.5" />} label={t("stats.avgSession")}>
          {formatDuration(avg, { short: true })}
        </Kpi>
      </motion.div>

      <motion.div variants={staggerContainer(0.07, 0.2)} initial="initial" animate="enter" className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card
          title={t("stats.perDay")}
          icon={<BarChart3 className="h-4 w-4" />}
          className="xl:col-span-2"
          action={
            <Segmented
              size="sm"
              value={range}
              onChange={setRange}
              options={[
                { value: "7", label: t("stats.range7") },
                { value: "30", label: t("stats.range30") },
                { value: "90", label: t("stats.range90") },
              ]}
            />
          }
        >
          <BarChart
            key={range}
            data={days.map((d) => ({ key: d.key, label: range === "7" ? new Date(d.start).toLocaleDateString(loc, { weekday: "short" }) : String(new Date(d.start).getDate()), value: d.seconds, tooltip: new Date(d.start).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" }) }))}
            height={220}
            format={(v) => formatDuration(v, { short: true })}
            labelEvery={range === "90" ? 10 : range === "30" ? 3 : 1}
          />
        </Card>
        <Card title={t("stats.hours")} icon={<Clock3 className="h-4 w-4" />}>
          <div className="flex justify-center">
            <RadialHours hours={hours} />
          </div>
        </Card>

        <Card title={t("stats.perWeek")} icon={<TrendingUp className="h-4 w-4" />} className="xl:col-span-2">
          <BarChart data={weeks.map((w) => ({ key: w.key, label: new Date(w.start).toLocaleDateString(loc, { day: "2-digit", month: "2-digit" }), value: w.seconds }))} height={180} format={(v) => `${formatHours(v)} ${t("time.h")}`} />
        </Card>
        <Card title={t("stats.topGames")} icon={<Crown className="h-4 w-4" />} className="xl:row-span-2">
          <TopList items={top} />
        </Card>

        <Card title={t("stats.heatmap")} icon={<CalendarRange className="h-4 w-4" />} className="overflow-x-auto xl:col-span-2">
          <Heatmap values={heat} year={year} />
        </Card>

        {/* Jahresrückblick */}
        <motion.section variants={staggerItem} className="relative overflow-hidden rounded-2xl p-7 xl:col-span-2" style={{ background: "linear-gradient(135deg, color-mix(in oklab, var(--nv-accent-3) 35%, var(--nv-bg-elev)), color-mix(in oklab, var(--nv-accent) 30%, var(--nv-bg-elev)) 60%, color-mix(in oklab, var(--nv-accent-2) 30%, var(--nv-bg-elev)))" }}>
          <div className="absolute -top-20 -right-16 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          <div className="relative flex items-center gap-2 text-[12px] font-semibold tracking-[0.25em] text-white/70 uppercase">
            <Sparkles className="h-4 w-4" /> {t("stats.yearReview", { year })}
          </div>
          <div className="relative mt-5 grid grid-cols-2 gap-6 md:grid-cols-4">
            <div>
              <div className="font-display text-5xl font-bold text-white tabular">
                <CountUp value={review.seconds / 3600} format={(v) => Math.round(v).toLocaleString(loc)} />
              </div>
              <div className="mt-1 text-sm text-white/70">{t("stats.yearHours")}</div>
            </div>
            <div>
              <div className="font-display text-5xl font-bold text-white tabular">
                <CountUp value={review.sessions} />
              </div>
              <div className="mt-1 text-sm text-white/70">{t("stats.yearSessions")}</div>
            </div>
            <div>
              <div className="font-display text-3xl font-bold text-white capitalize">{review.bestMonth !== undefined ? new Date(year, review.bestMonth, 1).toLocaleDateString(loc, { month: "long" }) : "–"}</div>
              <div className="mt-1 text-sm text-white/70">{t("stats.yearMonth")}</div>
            </div>
            <div>
              <div className="font-display text-5xl font-bold text-white tabular">
                <CountUp value={review.newGames} />
              </div>
              <div className="mt-1 text-sm text-white/70">{t("stats.yearNew")}</div>
            </div>
          </div>
          {reviewGame && (
            <div className="relative mt-6 flex items-center gap-4 rounded-xl bg-black/25 p-3 backdrop-blur">
              <div className="h-20 w-14 overflow-hidden rounded-lg shadow-lg">
                <GameCover game={reviewGame} />
              </div>
              <div>
                <div className="text-[11px] font-semibold tracking-wider text-white/60 uppercase">{t("stats.yearTop")}</div>
                <div className="font-display text-xl font-bold text-white">{reviewGame.name}</div>
                <div className="text-sm text-white/70">{formatDuration(review.topGameSeconds)}</div>
              </div>
            </div>
          )}
        </motion.section>

        <Card title={t("stats.backlog")} icon={<Hourglass className="h-4 w-4" />}>
          {backlog.count === 0 ? (
            <p className="text-sm leading-relaxed text-muted">{t("stats.backlogEmpty")}</p>
          ) : !Number.isFinite(backlog.weeks) ? (
            <p className="text-sm leading-relaxed text-muted">{t("stats.backlogNoPace")}</p>
          ) : (
            <div>
              <div className="font-display text-4xl font-bold text-gradient">{etaText}</div>
              <p className="mt-3 text-sm leading-relaxed text-fg-soft">{t("stats.backlogText", { n: backlog.count, pace: formatDuration(backlog.pacePerWeek, { short: true }), eta: etaText })}</p>
              <div className="mt-3 text-[12px] text-faint">{new Date(Date.now() + backlog.weeks * 7 * 86400000).toLocaleDateString(loc, { month: "long", year: "numeric" })} · Ø {formatDuration(backlog.avgLength, { short: true })}</div>
            </div>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
