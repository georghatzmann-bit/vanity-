import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Activity, Cable, Clock, Cpu, Gauge, Globe, Heart, MemoryStick, Pause, Play, Route, Wifi, WifiOff, Zap } from "lucide-react";
import { formatClock } from "@/lib/format";
import { pingColor, signalLabel } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { BoostButton } from "@/components/BoostButton";
import { GameShelf } from "@/components/GameShelf";
import { HeroBanner } from "@/components/HeroBanner";
import { ReportCard } from "@/components/ReportCard";
import { GradeRing } from "@/components/net/GradeRing";
import { PingChart } from "@/components/net/PingChart";
import { Ring } from "@/components/ui/Ring";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Button } from "@shared/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@shared/lib/cn";
import { staggerContainer, staggerItem } from "@shared/design/motion";

function greeting(t: (k: string) => string) {
  const h = new Date().getHours();
  if (h < 5) return t("cockpit.hello.night");
  if (h < 11) return t("cockpit.hello.morning");
  if (h < 18) return t("cockpit.hello.day");
  return t("cockpit.hello.evening");
}

const fmt = (v: number | null, digits = 0) => (v === null ? "–" : v.toFixed(digits));

function LoadRing({ label, value, icon }: { label: string; value: number | null; icon: React.ReactNode }) {
  const v = value ?? 0;
  const color = v >= 90 ? "var(--nv-danger)" : v >= 75 ? "var(--nv-warning)" : undefined;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Ring value={v / 100} size={64} stroke={6} color={color}>
        <span className="font-display text-[14px] font-bold text-fg tabular">{value === null ? "–" : `${Math.round(v)}%`}</span>
      </Ring>
      <span className="flex items-center gap-1 text-[11px] font-medium text-muted">
        {icon}
        {label}
      </span>
    </div>
  );
}

/** Cockpit: großes Spiel-Banner, Verbindungsnote, Live-Ping, Boost, Cover-Reihen, PC-Auslastung */
export function Cockpit() {
  const t = useT();
  const navigate = useUI((s) => s.navigate);
  const { stats, grade, samples, monitorOn, targetLabel, regions, adapters, wifi, system, monitorError } = useNet();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const boost = useBoost((s) => s.state);
  const reports = useBoost((s) => s.reports);
  const games = useLibrary((s) => s.games);
  const running = useLibrary((s) => s.running);
  const playStats = useLibrary((s) => s.stats);
  const now = useNow(1000, running.size > 0 || boost.active);
  const [win, setWin] = useState<"60" | "300" | "900">("60");

  const primary = adapters.find((a) => a.primary) ?? adapters.find((a) => a.up);
  const points = useMemo(() => samples.map((s) => ({ t: s.t, rtt: s.rtt })), [samples]);
  const current = [...running.values()][0];
  const currentGame = current ? games.find((g) => g.id === current.gameId) : undefined;
  const visible = useMemo(() => games.filter((g) => !g.hidden), [games]);
  const recent = useMemo(
    () => visible.filter((g) => playStats.get(g.id)?.lastPlayedAt).sort((a, b) => (playStats.get(b.id)?.lastPlayedAt ?? 0) - (playStats.get(a.id)?.lastPlayedAt ?? 0)),
    [visible, playStats],
  );
  const favorites = useMemo(() => visible.filter((g) => g.favorite), [visible]);
  // Banner: laufendes Spiel, sonst zuletzt gespielt, sonst ein Spiel mit Bild
  const spotlight = currentGame ?? recent[0] ?? visible.find((g) => g.kind === "game" && (g.images.hero || g.images.cover)) ?? visible[0];
  const spotlightReport = spotlight ? reports.find((r) => r.gameId === spotlight.id) : undefined;
  const lastReport = reports[0];
  const regionOptions = regions.map((r) => ({ value: r.id, label: `${r.name} · ${r.provider}` }));

  // Das Spielbild des Banners färbt auch den Hintergrund (wie bei NOVA)
  useEffect(() => {
    useUI.getState().setFocusGame(spotlight?.id ?? null);
  }, [spotlight?.id]);
  useEffect(() => () => useUI.getState().setFocusGame(null), []);

  return (
    <motion.div className="mx-auto flex max-w-[1500px] flex-col gap-6 px-8 pt-3 pb-12" variants={staggerContainer(0.05)} initial="initial" animate="enter">
      <motion.div variants={staggerItem} className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">
            {greeting(t)}
            <span className="text-accent">.</span>
          </h1>
          <p className="mt-1 text-sm text-muted">{t("cockpit.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {primary ? (
            <span className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[12px] font-medium text-fg-soft">
              {primary.kind === "wifi" ? <Wifi className="h-4 w-4 text-accent" /> : <Cable className="h-4 w-4 text-accent" />}
              {primary.kind === "wifi" ? t("cockpit.wifi") : primary.kind === "ethernet" ? t("cockpit.ethernet") : t("cockpit.other")}
              {primary.speedMbps ? <span className="text-muted tabular">· {primary.speedMbps >= 1000 ? `${primary.speedMbps / 1000} Gbit/s` : `${primary.speedMbps} Mbit/s`}</span> : null}
              {wifi && primary.kind === "wifi" && <span className="text-muted">· {t(`cockpit.signal.${signalLabel(wifi.signal)}`)}</span>}
            </span>
          ) : (
            <span className="flex h-9 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[12px] text-muted">
              <WifiOff className="h-4 w-4" /> {t("cockpit.offline")}
            </span>
          )}
        </div>
      </motion.div>

      <motion.div variants={staggerItem}>
        <HeroBanner game={spotlight} stats={spotlight ? playStats.get(spotlight.id) : undefined} running={currentGame && current ? current : undefined} report={spotlightReport} now={now} targetLabel={targetLabel} />
      </motion.div>

      {/* Hauptreihe: Note, Live-Diagramm, Boost */}
      <div className="grid grid-cols-[auto_1fr] gap-5 xl:grid-cols-[auto_1fr_auto]">
        <motion.div variants={staggerItem} className="glass flex flex-col items-center justify-center gap-4 rounded-2xl px-8 py-6">
          <GradeRing grade={grade} size={176} live={monitorOn} />
          <div className="max-w-[200px] text-center text-[12px] leading-snug text-muted">{grade ? t(`grade.${grade}`) : t("grade.none")}</div>
        </motion.div>

        <motion.div variants={staggerItem} className="glass order-first col-span-2 flex min-w-0 flex-col rounded-2xl p-5 xl:order-none xl:col-span-1">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className={cn("relative flex h-2.5 w-2.5", !monitorOn && "opacity-40")}>
                {monitorOn && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
                <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", monitorOn ? "bg-success" : "bg-muted")} />
              </span>
              <span className="text-[12px] font-semibold tracking-[0.14em] text-muted uppercase">{monitorOn ? t("cockpit.live") : t("cockpit.paused")}</span>
              <Select value={settings.monitorRegion} onChange={(v) => (update({ monitorRegion: v }), void useNet.getState().useRegionTarget(v))} options={regionOptions.length ? regionOptions : [{ value: settings.monitorRegion, label: targetLabel }]} className="w-56" />
            </div>
            <div className="flex items-center gap-2">
              <Segmented size="sm" value={win} onChange={setWin} options={[{ value: "60", label: t("cockpit.last60") }, { value: "300", label: t("cockpit.last5m") }, { value: "900", label: t("cockpit.last15m") }]} />
              <Button size="sm" variant="ghost" icon={monitorOn ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} onClick={() => void (monitorOn ? useNet.getState().stopMonitor() : useNet.getState().startMonitor())} title={monitorOn ? t("cockpit.pauseMonitor") : t("cockpit.resumeMonitor")}>
                <span className="hidden 2xl:inline">{monitorOn ? t("cockpit.pauseMonitor") : t("cockpit.resumeMonitor")}</span>
              </Button>
            </div>
          </div>
          {monitorError && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{t("cockpit.monitorError")} {monitorError}</div>}
          <div className="mt-3 flex items-baseline gap-3">
            <span className="font-display text-5xl font-bold tabular" style={{ color: pingColor(stats?.last ?? null) }}>
              {stats?.last === null || stats?.last === undefined ? "–" : Math.round(stats.last)}
            </span>
            <span className="text-sm text-muted">ms · {targetLabel}</span>
          </div>
          <PingChart points={points} height={150} alertMs={settings.pingAlertMs} windowMs={Number(win) * 1000} className="mt-2" />
          <div className="mt-3 grid grid-cols-3 gap-2 text-[12px] lg:grid-cols-5">
            {[
              [t("cockpit.avg"), `${fmt(stats?.avg ?? null)} ms`],
              [t("cockpit.min"), `${fmt(stats?.min ?? null)} ms`],
              [t("cockpit.max"), `${fmt(stats?.max ?? null)} ms`],
              [t("cockpit.jitter"), `${fmt(stats?.jitter ?? null, 1)} ms`],
              [t("cockpit.loss"), `${((stats?.loss ?? 0) * 100).toFixed(1)} %`],
            ].map(([l, v]) => (
              <div key={l} className="min-w-0 rounded-lg bg-surface px-3 py-2">
                <div className="truncate text-[10px] font-semibold tracking-[0.12em] text-faint uppercase">{l}</div>
                <div className="truncate font-display text-[15px] font-bold text-fg tabular">{v}</div>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div variants={staggerItem} className="glass flex min-w-0 flex-col items-center justify-between rounded-2xl px-5 py-6 xl:w-[280px]">
          <BoostButton size={150} />
          <div className="text-center">
            {boost.active ? (
              <>
                <div className="flex items-center justify-center gap-1.5 text-[13px] font-semibold text-accent">
                  <Zap className="h-4 w-4" fill="currentColor" /> {t("cockpit.boostActive")}
                </div>
                <div className="mt-0.5 text-[12px] text-muted tabular">{t("cockpit.boostSince", { time: formatClock((now - (boost.since ?? now)) / 1000) })}</div>
                <ul className="mt-3 space-y-1 text-left text-[11px] text-muted">
                  {boost.actions.map((a) => (
                    <li key={a.id} className="flex items-start gap-1.5">
                      <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", a.ok ? "bg-success" : "bg-warning")} />
                      <span className="leading-snug">{a.detail}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="text-[12px] leading-snug text-muted">{t("cockpit.boostIdle")}</div>
            )}
          </div>
        </motion.div>
      </div>

      <motion.div variants={staggerItem}>
        <GameShelf title={t("games.recent")} icon={<Clock className="h-4 w-4" />} games={recent.slice(0, 14)} onShowAll={() => navigate({ page: "games" })} />
      </motion.div>

      {/* PC-Auslastung, Schnellzugriff, letzte Runde */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-[1fr_1fr_1.25fr]">
        <motion.div variants={staggerItem} className="glass rounded-2xl p-5">
          <div className="mb-3 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("cockpit.system")}</div>
          <div className="flex justify-around">
            <LoadRing label={t("cockpit.cpu")} value={system?.cpu ?? null} icon={<Cpu className="h-3 w-3" />} />
            <LoadRing label={t("cockpit.ram")} value={system ? (system.ramUsed / system.ramTotal) * 100 : null} icon={<MemoryStick className="h-3 w-3" />} />
            <LoadRing label={t("cockpit.gpu")} value={system?.gpu ?? null} icon={<Gauge className="h-3 w-3" />} />
          </div>
          <div className="mt-3 truncate text-center text-[11px] text-faint">{[system?.cpuName, system?.gpuName].filter(Boolean).join(" · ")}</div>
        </motion.div>

        <motion.div variants={staggerItem} className="glass rounded-2xl p-4">
          <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("cockpit.quick")}</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { icon: <Globe className="h-4 w-4" />, label: t("network.tabs.regions"), section: "regions" },
              { icon: <Route className="h-4 w-4" />, label: t("network.tabs.route"), section: "route" },
              { icon: <Activity className="h-4 w-4" />, label: t("network.tabs.dns"), section: "dns" },
              { icon: <Gauge className="h-4 w-4" />, label: t("network.tabs.speed"), section: "speed" },
            ].map((q) => (
              <motion.button key={q.section} type="button" whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }} onClick={() => navigate({ page: "network", section: q.section })} className="flex min-w-0 items-center gap-2.5 rounded-xl bg-surface px-3 py-3 text-left text-[13px] font-medium text-fg-soft transition hover:bg-surface-2 hover:text-fg">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">{q.icon}</span>
                <span className="truncate">{q.label}</span>
              </motion.button>
            ))}
          </div>
        </motion.div>

        <motion.div variants={staggerItem} className="lg:col-span-2 2xl:col-span-1">
          {lastReport ? (
            <div className="flex h-full flex-col">
              <div className="mb-2 flex items-center justify-between px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
                {t("cockpit.lastReport")}
                <button type="button" onClick={() => navigate({ page: "reports" })} className="text-[12px] font-medium tracking-normal text-muted normal-case transition hover:text-fg">
                  {t("cockpit.showAll")} →
                </button>
              </div>
              <ReportCard report={lastReport} />
            </div>
          ) : (
            <div className="glass h-full rounded-2xl">
              <EmptyState icon={<Zap className="h-6 w-6" />} title={t("reports.empty")} text={t("reports.emptyText")} />
            </div>
          )}
        </motion.div>
      </div>

      {favorites.length > 0 && (
        <motion.div variants={staggerItem}>
          <GameShelf title={t("games.favorites")} icon={<Heart className="h-4 w-4" />} games={favorites.slice(0, 14)} onShowAll={() => (useUI.getState().setFilter({ favoritesOnly: true }), navigate({ page: "games" }))} />
        </motion.div>
      )}
    </motion.div>
  );
}
