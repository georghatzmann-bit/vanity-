import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, Cable, ExternalLink, Gauge, Globe, Loader2, Play, Route, Star, Wifi, X } from "lucide-react";
import { api, errorText, listen } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { gradeColor, pingColor, pingGrade, signalLabel } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Area, DnsConfig, DnsProgress, DnsResult, Region, SpeedProgress, SpeedResult, TraceHop, TraceResult } from "@/lib/types";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { toast, useUI, type NetworkTab } from "@/store/ui";
import { GradeRing } from "@/components/net/GradeRing";
import { StatTile } from "@/components/net/StatTile";
import { Ring } from "@/components/ui/Ring";
import { Tabs } from "@/components/ui/Tabs";
import { Button } from "@shared/ui/Button";
import { ProgressBar } from "@shared/ui/ProgressBar";
import { cn } from "@shared/lib/cn";
import { spring, staggerContainer, staggerItem } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

const AREAS: Area[] = ["eu", "na", "sa", "asia", "oce", "me", "af"];
const flag = (cc: string) => cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));

// ---------------------------------------------------------------------------------------------
function RegionRow({ region, onTarget }: { region: Region; onTarget?: () => void }) {
  const t = useT();
  const st = useNet((s) => s.regionPings.get(region.id));
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const fav = settings.favoriteRegions.includes(region.id);
  const current = settings.monitorRegion === region.id;
  const grade = st ? pingGrade(st.avg, st.jitter, st.loss) : null;
  return (
    <motion.div layout className={cn("glass flex items-center gap-3 rounded-lg px-3 py-2.5", current && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_55%,transparent)]")}>
      <span className="text-lg leading-none">{flag(region.country)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-fg">{region.name}</div>
        <div className="text-[11px] text-muted">{region.provider}</div>
      </div>
      <div className="w-24 text-right">
        {st ? (
          <>
            <div className="font-display text-base font-bold tabular" style={{ color: pingColor(st.avg) }}>
              {st.avg === null ? "✕" : `${Math.round(st.avg)} ms`}
            </div>
            <div className="text-[10px] text-faint tabular">
              ±{(st.jitter ?? 0).toFixed(1)} · {Math.round(st.loss * 100)}%
            </div>
          </>
        ) : (
          <span className="text-[11px] text-faint">{t("network.regions.unmeasured")}</span>
        )}
      </div>
      <span className="grid h-8 w-8 place-items-center rounded-full text-[12px] font-bold" style={{ color: gradeColor(grade), boxShadow: `inset 0 0 0 2px ${gradeColor(grade)}` }}>
        {grade ?? "–"}
      </span>
      {onTarget && (
        <button type="button" onClick={() => update({ favoriteRegions: fav ? settings.favoriteRegions.filter((x) => x !== region.id) : [...settings.favoriteRegions, region.id] })} className={cn("grid h-8 w-8 place-items-center rounded-md transition hover:bg-surface-3", fav ? "text-warning" : "text-faint")} title={t("network.regions.favorite")}>
          <Star className="h-4 w-4" fill={fav ? "currentColor" : "none"} />
        </button>
      )}
      {onTarget && (
        <Button size="sm" variant={current ? "primary" : "secondary"} onClick={onTarget}>
          {t("network.regions.useAsTarget")}
        </Button>
      )}
    </motion.div>
  );
}

function RegionsPanel() {
  const t = useT();
  const { regions, regionPings, measuringRegions, pingRegions } = useNet();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [serverGame, setServerGame] = useState<"cs2" | "dota2" | "deadlock" | "lol">("cs2");
  const [servers, setServers] = useState<Region[]>([]);
  const [serverPings, setServerPings] = useState<Map<string, ReturnType<typeof pingGrade>>>(new Map());
  const [serverStats, setServerStats] = useState<Map<string, { avg: number | null; jitter: number | null; loss: number }>>(new Map());
  const [loadingServers, setLoadingServers] = useState(false);

  useEffect(() => {
    if (regions.length && !regionPings.size) void pingRegions(settings.favoriteRegions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions.length]);

  const best = useMemo(() => {
    let b: { id: string; avg: number } | null = null;
    regionPings.forEach((st, id) => {
      if (st.avg !== null && (!b || st.avg < b.avg)) b = { id, avg: st.avg };
    });
    return b ? regions.find((r) => r.id === b!.id) : undefined;
  }, [regionPings, regions]);

  const loadServers = async (g: typeof serverGame) => {
    setServerGame(g);
    setLoadingServers(true);
    try {
      const list = await api.gameServers(g);
      setServers(list);
      const res = await Promise.all(list.slice(0, 12).map(async (r) => [r.id, await api.pingOnce(r.target, 3).catch(() => null)] as const));
      const grades = new Map<string, ReturnType<typeof pingGrade>>();
      const stats = new Map<string, { avg: number | null; jitter: number | null; loss: number }>();
      res.forEach(([id, st]) => {
        if (st) {
          grades.set(id, pingGrade(st.avg, st.jitter, st.loss));
          stats.set(id, st);
        }
      });
      setServerPings(grades);
      setServerStats(stats);
    } catch (e) {
      toast({ kind: "error", title: errorText(e) });
    } finally {
      setLoadingServers(false);
    }
  };

  const setTarget = (r: Region) => {
    update({ monitorRegion: r.id });
    void useNet.getState().useRegionTarget(r.id);
    sound.play("success");
  };

  return (
    <div className="grid grid-cols-[1.5fr_1fr] gap-5">
      <div>
        <div className="flex items-center justify-between">
          <p className="max-w-xl text-[13px] text-muted">{t("network.regions.intro")}</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" loading={measuringRegions} onClick={() => void pingRegions(settings.favoriteRegions)}>
              {t("network.regions.measureFav")}
            </Button>
            <Button variant="primary" size="sm" loading={measuringRegions} icon={<Globe className="h-3.5 w-3.5" />} onClick={() => void pingRegions()}>
              {t("network.regions.measureAll")}
            </Button>
          </div>
        </div>
        {best && (
          <motion.div className="mt-4 flex items-center gap-3 rounded-xl bg-gradient-soft p-4 ring-1 ring-accent/30" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <span className="text-2xl">{flag(best.country)}</span>
            <div className="flex-1">
              <div className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">{t("network.regions.best")}</div>
              <div className="font-display text-lg font-bold text-fg">
                {best.name} · {Math.round(regionPings.get(best.id)?.avg ?? 0)} ms
              </div>
            </div>
            <Button size="sm" variant="primary" onClick={() => setTarget(best)}>
              {t("network.regions.useAsTarget")}
            </Button>
          </motion.div>
        )}
        <div className="mt-4 flex flex-col gap-4">
          {AREAS.map((area) => {
            const list = regions.filter((r) => r.area === area);
            if (!list.length) return null;
            return (
              <div key={area}>
                <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t(`network.regions.areas.${area}`)}</div>
                <div className="grid grid-cols-1 gap-2">
                  {list.map((r) => (
                    <RegionRow key={r.id} region={r} onTarget={() => setTarget(r)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="glass rounded-xl p-4">
          <div className="text-sm font-semibold text-fg">{t("network.regions.gameServers")}</div>
          <p className="mt-1 text-[12px] text-muted">{t("network.regions.gameServersIntro")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["cs2", "dota2", "deadlock", "lol"] as const).map((g) => (
              <button key={g} type="button" onClick={() => void loadServers(g)} className={cn("rounded-full border px-3 py-1.5 text-[12px] font-medium transition", serverGame === g && servers.length ? "border-transparent bg-accent/15 text-fg" : "border-line text-muted hover:text-fg")}>
                {t(`network.regions.games.${g}`)}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {loadingServers && (
              <div className="flex items-center gap-2 py-4 text-[12px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> {t("common.measuring")}
              </div>
            )}
            {!loadingServers && servers.length === 0 && (
              <Button variant="secondary" size="sm" onClick={() => void loadServers(serverGame)}>
                {t("common.measuring").replace(" …", "")}
              </Button>
            )}
            {servers.map((r) => {
              const st = serverStats.get(r.id);
              const grade = serverPings.get(r.id) ?? null;
              return (
                <div key={r.id} className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2">
                  <span>{flag(r.country)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg">{r.name}</div>
                    <div className="text-[11px] text-muted">{r.provider}</div>
                  </div>
                  <div className="font-display text-base font-bold tabular" style={{ color: pingColor(st?.avg ?? null) }}>
                    {st?.avg == null ? "–" : `${Math.round(st.avg)} ms`}
                  </div>
                  <span className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold" style={{ color: gradeColor(grade), boxShadow: `inset 0 0 0 2px ${gradeColor(grade)}` }}>
                    {grade ?? "–"}
                  </span>
                  <button type="button" onClick={() => void useNet.getState().setTarget(r.target, `${r.name} (${r.provider})`)} className="text-[11px] font-medium text-accent hover:underline">
                    {t("network.regions.useAsTarget")}
                  </button>
                </div>
              );
            })}
            {!loadingServers && servers.length === 0 && serverPings.size === 0 && serverGame === "lol" && <div className="text-[12px] text-muted">{t("network.regions.noServers")}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function RoutePanel() {
  const t = useT();
  const targetLabel = useNet((s) => s.target?.host ?? "");
  const [host, setHost] = useState(targetLabel || "dynamodb.eu-central-1.amazonaws.com");
  const [hops, setHops] = useState<TraceHop[]>([]);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setHops([]);
    setResult(null);
    setRunning(true);
    const un = await listen<TraceHop>("net://trace", (h) => setHops((prev) => [...prev.filter((x) => x.hop !== h.hop), h].sort((a, b) => a.hop - b.hop)));
    try {
      const res = await api.traceroute(host.trim(), 30);
      setResult(res);
      setHops(res.hops);
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      un();
      setRunning(false);
    }
  };

  const verdict = useMemo(() => {
    if (!result) return null;
    let biggest: { hop: TraceHop; jump: number } | null = null;
    let prev = 0;
    for (const h of result.hops) {
      const ok = h.rtts.filter((v): v is number => v !== null);
      if (!ok.length) continue;
      const med = ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)];
      const jump = med - prev;
      if (!biggest || jump > biggest.jump) biggest = { hop: h, jump };
      prev = med;
    }
    if (!biggest || biggest.jump < 15) return { text: t("network.route.verdictFine"), hop: null };
    const key = biggest.hop.zone === "lan" ? "verdictLan" : biggest.hop.zone === "isp" ? "verdictIsp" : "verdictInternet";
    return { text: `${t(`network.route.${key}`)} ${t("network.route.biggestJump", { ms: Math.round(biggest.jump), hop: biggest.hop.hop })}`, hop: biggest.hop.hop };
  }, [result, t]);

  const maxRtt = Math.max(30, ...hops.flatMap((h) => h.rtts.filter((v): v is number => v !== null)));

  return (
    <div className="mx-auto max-w-[900px]">
      <p className="text-[13px] text-muted">{t("network.route.intro")}</p>
      <div className="mt-4 flex gap-2">
        <input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !running && void run()} className="input h-11 flex-1" placeholder={t("network.route.host")} spellCheck={false} />
        <Button variant="primary" size="lg" loading={running} icon={<Route className="h-4 w-4" />} onClick={() => void run()}>
          {running ? t("network.route.running") : t("network.route.start")}
        </Button>
      </div>
      <div className="mt-5 flex flex-col gap-1.5">
        <AnimatePresence>
          {hops.map((h) => {
            const ok = h.rtts.filter((v): v is number => v !== null);
            const med = ok.length ? ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null;
            const highlight = verdict?.hop === h.hop;
            return (
              <motion.div key={h.hop} className={cn("glass flex items-center gap-3 rounded-lg px-3 py-2", highlight && "shadow-[inset_0_0_0_1px_var(--nv-warning)]")} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={spring.gentle}>
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-bold text-muted tabular">{h.hop}</span>
                <span className={cn("w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-semibold uppercase", h.zone === "lan" ? "bg-success/15 text-success" : h.zone === "isp" ? "bg-accent/15 text-accent" : h.zone === "target" ? "bg-accent-3/20 text-fg" : "bg-surface-3 text-muted")}>{t(`network.route.zones.${h.zone}`)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-fg tabular">{h.address ?? "*"}</div>
                  {h.hostname && <div className="truncate text-[11px] text-muted">{h.hostname}</div>}
                </div>
                <div className="flex w-56 items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                    {med !== null && <motion.div className="h-full rounded-full" style={{ background: pingColor(med) }} initial={{ width: 0 }} animate={{ width: `${Math.min(100, (med / maxRtt) * 100)}%` }} />}
                  </div>
                  <span className="w-16 text-right text-[12px] font-semibold tabular" style={{ color: med === null ? "var(--nv-faint)" : pingColor(med) }}>
                    {med === null ? t("network.route.noReply") : `${med.toFixed(1)} ms`}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      {result && verdict && (
        <motion.div className="mt-4 rounded-xl bg-gradient-soft p-4 text-[13px] text-fg ring-1 ring-accent/30" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="font-semibold">{result.reached ? t("network.route.reached", { n: result.hops.length }) : t("network.route.notReached", { n: result.hops.length })}</div>
          <div className="mt-1 text-muted">{verdict.text}</div>
        </motion.div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function DnsPanel() {
  const t = useT();
  const [results, setResults] = useState<DnsResult[]>([]);
  const [progress, setProgress] = useState<DnsProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<DnsConfig | null>(null);

  useEffect(() => {
    void api.dnsCurrent().then(setCurrent).catch(() => setCurrent(null));
  }, []);

  const run = async () => {
    setRunning(true);
    setProgress({ done: 0, total: 8 });
    const un = await listen<DnsProgress>("net://dns", setProgress);
    try {
      setResults(await api.dnsBenchmark(5));
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      un();
      setRunning(false);
      setProgress(null);
    }
  };
  const fastest = results.find((r) => r.uncachedMs !== null && !r.current);
  const max = Math.max(1, ...results.map((r) => r.uncachedMs ?? 0));

  return (
    <div className="mx-auto grid max-w-[1100px] grid-cols-[1.4fr_1fr] gap-5">
      <div>
        <p className="text-[13px] text-muted">{t("network.dns.intro")}</p>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" loading={running} icon={<Activity className="h-4 w-4" />} onClick={() => void run()}>
            {running && progress ? t("network.dns.running", { done: progress.done, total: progress.total }) : t("network.dns.run")}
          </Button>
          {running && progress && <ProgressBar value={progress.done / progress.total} className="w-40" />}
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          {results.map((r, i) => (
            <motion.div key={r.id} className={cn("glass grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 rounded-lg px-3 py-2.5", r === fastest && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-success)_60%,transparent)]")} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                  {r.name}
                  {r === fastest && <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">{t("network.dns.fastest")}</span>}
                  {r.current && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-semibold text-muted">{t("network.dns.current")}</span>}
                </div>
                <div className="text-[11px] text-muted tabular">
                  {r.primary}
                  {r.secondary ? ` · ${r.secondary}` : ""}
                </div>
              </div>
              <div className="w-40">
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <motion.div className="h-full rounded-full bg-gradient-accent" initial={{ width: 0 }} animate={{ width: `${((r.uncachedMs ?? max) / max) * 100}%` }} />
                </div>
              </div>
              <div className="w-20 text-right">
                <div className="text-[10px] text-faint uppercase">{t("network.dns.uncached")}</div>
                <div className="text-[13px] font-semibold text-fg tabular">{r.uncachedMs === null ? "✕" : `${r.uncachedMs.toFixed(0)} ms`}</div>
              </div>
              <div className="w-16 text-right">
                <div className="text-[10px] text-faint uppercase">{t("network.dns.cached")}</div>
                <div className="text-[13px] text-muted tabular">{r.cachedMs === null ? "✕" : `${r.cachedMs.toFixed(0)} ms`}</div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="glass rounded-xl p-4">
          <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.dns.currentConfig")}</div>
          {current ? (
            <div className="mt-2 text-[13px] text-fg">
              <div className="font-medium">{current.adapter}</div>
              <div className="text-muted tabular">{current.dhcp ? `${t("network.dns.dhcp")} · ` : ""}{current.servers.join(", ") || "–"}</div>
            </div>
          ) : (
            <div className="mt-2 text-[12px] text-muted">{t("network.dns.noAdapter")}</div>
          )}
        </div>
        {fastest && (
          <motion.div className="glass rounded-xl p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <div className="text-sm font-semibold text-fg">{t("network.dns.howTo")}</div>
            <pre className="mt-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-muted">{t("network.dns.howToSteps", { primary: fastest.primary, secondary: fastest.secondary ?? fastest.primary })}</pre>
            <Button variant="secondary" size="sm" className="mt-3" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void api.openUrl("ms-settings:network-status").catch(() => undefined)}>
              {t("network.dns.openSettings")}
            </Button>
          </motion.div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function SpeedPanel() {
  const t = useT();
  const [progress, setProgress] = useState<SpeedProgress | null>(null);
  const [result, setResult] = useState<SpeedResult | null>(() => {
    try {
      const raw = localStorage.getItem("pulsar-speedtest");
      return raw ? (JSON.parse(raw) as SpeedResult) : null;
    } catch {
      return null;
    }
  });
  const [running, setRunning] = useState(false);
  const peak = useRef(0);

  const run = async () => {
    setRunning(true);
    setProgress({ phase: "latency", progress: 0, mbps: null, latencyMs: null });
    peak.current = 0;
    const un = await listen<SpeedProgress>("net://speed", (p) => {
      if (p.mbps) peak.current = Math.max(peak.current, p.mbps);
      setProgress(p);
    });
    try {
      const res = await api.speedtest();
      setResult(res);
      try {
        localStorage.setItem("pulsar-speedtest", JSON.stringify(res));
      } catch {
        /* egal */
      }
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      un();
      setRunning(false);
      setProgress(null);
    }
  };

  const mbps = progress?.mbps ?? null;
  const gaugeMax = Math.max(100, peak.current * 1.2, result?.downloadMbps ?? 0);

  return (
    <div className="mx-auto max-w-[1000px]">
      <p className="text-[13px] text-muted">{t("network.speed.intro")}</p>
      <div className="mt-5 grid grid-cols-[auto_1fr] gap-6">
        <div className="glass flex flex-col items-center justify-center gap-4 rounded-2xl px-8 py-6">
          <Ring value={mbps !== null ? mbps / gaugeMax : result ? 1 : 0} size={200} stroke={14}>
            <div className="text-center">
              <div className="font-display text-4xl font-bold text-fg tabular">{mbps !== null ? Math.round(mbps) : result ? Math.round(result.downloadMbps) : "–"}</div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{progress ? t(`network.speed.phases.${progress.phase}`) : "Mbit/s"}</div>
            </div>
          </Ring>
          {running ? (
            <Button variant="secondary" icon={<X className="h-4 w-4" />} onClick={() => void api.speedtestCancel()}>
              {t("network.speed.cancel")}
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon={<Play className="h-4 w-4" />} onClick={() => void run()}>
              {t("network.speed.start")}
            </Button>
          )}
          {progress && <ProgressBar value={progress.progress} className="w-full" />}
          {progress?.latencyMs != null && (
            <div className="text-[12px] text-muted tabular">
              {t("network.speed.loaded")}: <span style={{ color: pingColor(progress.latencyMs) }}>{progress.latencyMs.toFixed(0)} ms</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {result ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label={t("network.speed.download")} value={Math.round(result.downloadMbps)} unit="Mbit/s" icon={<Gauge className="h-3.5 w-3.5" />} />
                <StatTile label={t("network.speed.upload")} value={Math.round(result.uploadMbps)} unit="Mbit/s" />
                <StatTile label={t("network.speed.idle")} value={result.idleLatencyMs.toFixed(1)} unit="ms" color={pingColor(result.idleLatencyMs)} sub={`± ${result.idleJitterMs.toFixed(1)} ms`} />
              </div>
              <div className="glass flex items-center gap-5 rounded-xl p-5">
                <GradeRing grade={result.grade} size={120} label={t("network.speed.bufferbloat")} />
                <div className="flex-1">
                  <div className="font-display text-xl font-bold text-fg">
                    +{Math.round(result.bufferbloatMs)} ms <span className="text-sm font-medium text-muted">{t("network.speed.loaded")}</span>
                  </div>
                  <div className="mt-1 text-[12px] text-muted">{t("network.speed.bufferbloatHint")}</div>
                  <div className="mt-2 text-[13px] text-fg-soft">{t(`network.speed.verdict.${result.grade}`)}</div>
                  <div className="mt-2 text-[11px] text-faint">
                    {t("network.speed.server")}: {result.server} · {t("network.speed.lastResult")}: {formatDateTime(result.at)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="glass flex h-full items-center justify-center rounded-xl p-6 text-center text-sm text-muted">{t("network.speed.intro")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
function ConnectionPanel() {
  const t = useT();
  const { adapters, wifi, refreshConnection } = useNet();
  useEffect(() => {
    void refreshConnection();
  }, [refreshConnection]);
  const tips: string[] = [];
  if (wifi) {
    if (wifi.band === "2.4") tips.push(t("network.connection.tip24"));
    if (wifi.signal < 50) tips.push(t("network.connection.tipWeak"));
    tips.push(t("network.connection.tipCable"));
    if (!tips.length) tips.push(t("network.connection.tipGood"));
  }
  return (
    <div className="mx-auto grid max-w-[1100px] grid-cols-[1fr_1fr] gap-5">
      <div>
        <p className="text-[13px] text-muted">{t("network.connection.intro")}</p>
        <div className="mt-4 px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.connection.adapters")}</div>
        <div className="mt-2 flex flex-col gap-2">
          {adapters.length === 0 && <div className="glass rounded-xl p-5 text-sm text-muted">{t("network.connection.noAdapters")}</div>}
          {adapters.map((a) => (
            <div key={a.id} className={cn("glass rounded-xl p-4", a.primary && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_55%,transparent)]")}>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-surface-2 text-accent">{a.kind === "wifi" ? <Wifi className="h-5 w-5" /> : <Cable className="h-5 w-5" />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                    {a.name}
                    {a.primary && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">{t("network.connection.primary")}</span>}
                    {!a.up && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted">{t("common.off")}</span>}
                  </div>
                  <div className="truncate text-[11px] text-muted">{a.description}</div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                {[
                  [t("network.connection.speed"), a.speedMbps ? (a.speedMbps >= 1000 ? `${a.speedMbps / 1000} Gbit/s` : `${a.speedMbps} Mbit/s`) : "–"],
                  [t("network.connection.ip"), a.ipv4.join(", ") || "–"],
                  [t("network.connection.gateway"), a.gateway ?? "–"],
                  [t("network.connection.dns"), a.dns.join(", ") || "–"],
                ].map(([l, v]) => (
                  <div key={l} className="flex justify-between gap-3">
                    <span className="text-muted">{l}</span>
                    <span className="truncate text-fg tabular">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.connection.wifi")}</div>
        {wifi ? (
          <div className="glass mt-2 rounded-xl p-5">
            <div className="flex items-center gap-5">
              <Ring value={wifi.signal / 100} size={96} stroke={9} color={wifi.signal >= 60 ? "var(--nv-success)" : wifi.signal >= 40 ? "var(--nv-warning)" : "var(--nv-danger)"}>
                <div className="text-center">
                  <div className="font-display text-xl font-bold text-fg tabular">{wifi.signal}%</div>
                  <div className="text-[9px] text-muted uppercase">{t("network.connection.signal")}</div>
                </div>
              </Ring>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-lg font-bold text-fg">{wifi.ssid}</div>
                <div className="text-[12px] text-muted">{t(`cockpit.signal.${signalLabel(wifi.signal)}`)}{wifi.rssi !== null ? ` · ${wifi.rssi} dBm` : ""}</div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  {[
                    [t("network.connection.band"), wifi.band ? `${wifi.band} GHz` : "–"],
                    [t("network.connection.channel"), wifi.channel ?? "–"],
                    [t("network.connection.standard"), wifi.phy],
                    [t("network.connection.rate"), wifi.rxMbps ? `${Math.round(wifi.rxMbps)} Mbit/s` : "–"],
                  ].map(([l, v]) => (
                    <div key={String(l)} className="flex justify-between gap-3">
                      <span className="text-muted">{l}</span>
                      <span className="text-fg tabular">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="glass mt-2 flex items-center gap-3 rounded-xl p-5 text-sm text-fg-soft">
            <Cable className="h-5 w-5 text-success" /> {t("network.connection.noWifi")}
          </div>
        )}
        {tips.length > 0 && (
          <div className="glass mt-4 rounded-xl p-4">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.connection.tips")}</div>
            <ul className="mt-2 space-y-2 text-[13px] text-fg-soft">
              {tips.map((tip) => (
                <li key={tip} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
const TABS: { value: NetworkTab; icon: React.ReactNode }[] = [
  { value: "regions", icon: <Globe className="h-4 w-4" /> },
  { value: "route", icon: <Route className="h-4 w-4" /> },
  { value: "dns", icon: <Activity className="h-4 w-4" /> },
  { value: "speed", icon: <Gauge className="h-4 w-4" /> },
  { value: "connection", icon: <Wifi className="h-4 w-4" /> },
];

/** Netzwerk-Seite mit fünf Werkzeugen */
export function Network({ section }: { section?: string }) {
  const t = useT();
  const tab = (TABS.some((x) => x.value === section) ? section : "regions") as NetworkTab;
  const setTab = (v: NetworkTab) => useUI.getState().navigate({ page: "network", section: v });
  return (
    <motion.div className="mx-auto max-w-[1400px] px-8 pt-3 pb-24" variants={staggerContainer(0.04)} initial="initial" animate="enter">
      <motion.div variants={staggerItem}>
        <h1 className="font-display text-3xl font-bold text-fg">{t("network.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("network.subtitle")}</p>
      </motion.div>
      <motion.div variants={staggerItem}>
        <Tabs value={tab} onChange={setTab} className="mt-4 mb-6" tabs={TABS.map((x) => ({ value: x.value, label: <span className="flex items-center gap-2">{x.icon}{t(`network.tabs.${x.value}`)}</span> }))} />
      </motion.div>
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
          {tab === "regions" && <RegionsPanel />}
          {tab === "route" && <RoutePanel />}
          {tab === "dns" && <DnsPanel />}
          {tab === "speed" && <SpeedPanel />}
          {tab === "connection" && <ConnectionPanel />}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
