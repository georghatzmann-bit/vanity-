/** Netzwerk › Regionen: Ping zu Rechenzentren und echten Spielservern (aus pages/Network.tsx ausgelagert). */
import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Globe, Loader2, Star } from "lucide-react";
import { api, errorText, imgSrc } from "@/lib/api";
import { gradeColor, pingColor, pingGrade } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Area, Region } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/ui";
import { Button } from "@shared/ui/Button";
import { cn } from "@shared/lib/cn";
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
          <span className="text-[11px] whitespace-nowrap text-faint">{t("network.regions.unmeasured")}</span>
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

export function RegionsPanel() {
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
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.5fr_1fr]">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
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
              <button key={g} type="button" onClick={() => void loadServers(g)} className={cn("flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-[12px] font-medium transition", serverGame === g ? "border-transparent bg-accent/15 text-fg shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_45%,transparent)]" : "border-line text-muted hover:text-fg")}>
                <ServerGameIcon game={g} />
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
              <Button variant="secondary" size="sm" icon={<Globe className="h-3.5 w-3.5" />} onClick={() => void loadServers(serverGame)}>
                {t("network.regions.measureServers", { game: t(`network.regions.games.${serverGame}`) })}
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

/** Kleines Spiel-Icon für die Spielserver-Auswahl (aus der Bibliothek, sonst Kürzel) */
function ServerGameIcon({ game }: { game: string }) {
  const match = useLibrary((s) => s.games.find((g) => g.serverGame === game && (g.images.icon || g.images.cover)));
  const src = match?.images.icon ?? match?.images.cover;
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-3 text-[9px] font-bold text-muted uppercase">
      {src ? <img src={imgSrc(src)} alt="" className="h-full w-full object-cover" draggable={false} /> : game.slice(0, 2)}
    </span>
  );
}
