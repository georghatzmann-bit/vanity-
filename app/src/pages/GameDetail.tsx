import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Heart, ImageDown, MoreHorizontal, Play, Square, Trash2, Upload, Zap } from "lucide-react";
import { api, errorText, imgSrc } from "@/lib/api";
import { IMAGE_FILTERS, EXE_FILTERS, pickFile, pickFolder } from "@/lib/dialog";
import { formatDate, formatDuration, formatRelative } from "@/lib/format";
import { gradeColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { Game, ImageKind, LaunchType } from "@/lib/types";
import { gameMenuItems } from "@/hooks/gameMenu";
import { useNow } from "@/hooks/useNow";
import { useBoost } from "@/store/boost";
import { useLibrary } from "@/store/library";
import { useNet } from "@/store/net";
import { confirmDialog, toast, useUI } from "@/store/ui";
import { GameCover } from "@/components/GameCover";
import { ReportCard } from "@/components/ReportCard";
import { BarChart } from "@/components/charts/BarChart";
import { useContextMenu } from "@/components/ui/ContextMenu";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, Section } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Tabs } from "@/components/ui/Tabs";
import { Button } from "@shared/ui/Button";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";

type Tab = "overview" | "reports" | "settings";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass rounded-xl px-4 py-3">
      <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{label}</div>
      <div className="mt-1 font-display text-xl font-bold text-fg tabular">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function Overview({ game }: { game: Game }) {
  const t = useT();
  const allSessions = useLibrary((s) => s.sessions);
  const sessions = useMemo(() => allSessions.filter((x) => x.gameId === game.id), [allSessions, game.id]);
  const update = useLibrary((s) => s.updateGame);
  const regions = useNet((s) => s.regions);
  const allReports = useBoost((s) => s.reports);
  const reports = useMemo(() => allReports.filter((r) => r.gameId === game.id), [allReports, game.id]);
  const bars = useMemo(() => {
    const out: { key: string; label: string; value: number }[] = [];
    for (let d = 29; d >= 0; d--) {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - d);
      const start = day.getTime();
      const end = start + 86400000;
      const secs = sessions.filter((s) => s.start >= start && s.start < end).reduce((a, s) => a + s.seconds, 0);
      out.push({ key: String(start), label: d % 7 === 0 ? formatDate(start, { day: "2-digit", month: "2-digit" }) : "", value: Math.round(secs / 60) });
    }
    return out;
  }, [sessions]);
  const regionOptions = [{ value: "", label: t("game.useGlobal") }, ...regions.map((r) => ({ value: r.id, label: `${r.name} · ${r.provider}` }))];
  const serverOptions = [{ value: "", label: t("game.serverGameNone") }, ...(["cs2", "dota2", "deadlock", "lol"] as const).map((g) => ({ value: g, label: t(`network.regions.games.${g}`) }))];
  const last = reports[0];
  return (
    <div className="grid grid-cols-[1.2fr_1fr] gap-5">
      <div className="flex flex-col gap-5">
        <Section title={t("game.stats30")}>
          <div className="py-4">
            <BarChart data={bars} height={140} format={(v) => `${v} min`} labelEvery={1} />
          </div>
        </Section>
        {game.kind === "game" && (
          <Section title={t("game.region")}>
            <Field label={t("game.region")} description={t("game.regionDesc")}>
              <Select value={game.region ?? ""} onChange={(v) => update(game.id, { region: v || undefined })} options={regionOptions} className="w-60" align="right" />
            </Field>
            <Field label={t("game.serverGame")} description={t("game.serverGameDesc")}>
              <Select value={game.serverGame ?? ""} onChange={(v) => update(game.id, { serverGame: v || undefined })} options={serverOptions} className="w-60" align="right" />
            </Field>
            <Field label={t("game.autoBoost")} description={t("game.autoBoostDesc")}>
              <Toggle checked={game.autoBoost ?? true} onChange={(v) => update(game.id, { autoBoost: v })} />
            </Field>
          </Section>
        )}
      </div>
      <div className="flex flex-col gap-5">
        {last ? (
          <Section title={t("cockpit.lastReport")}>
            <div className="py-3">
              <ReportCard report={last} compact />
            </div>
          </Section>
        ) : (
          <div className="glass rounded-xl p-6 text-center text-sm text-muted">{t("game.noReports")}</div>
        )}
      </div>
    </div>
  );
}

function Reports({ game }: { game: Game }) {
  const t = useT();
  const allReports = useBoost((s) => s.reports);
  const reports = useMemo(() => allReports.filter((r) => r.gameId === game.id), [allReports, game.id]);
  if (!reports.length) return <EmptyState icon={<Zap className="h-7 w-7" />} title={t("reports.empty")} text={t("game.noReports")} />;
  return (
    <div className="grid grid-cols-2 gap-4">
      {reports.map((r) => (
        <ReportCard key={r.id} report={r} />
      ))}
    </div>
  );
}

function ImageSlot({ game, kind }: { game: Game; kind: ImageKind }) {
  const t = useT();
  const path = game.images[kind];
  const update = useLibrary((s) => s.updateGame);
  const pick = async () => {
    const file = await pickFile({ title: t("game.customImage"), filters: IMAGE_FILTERS });
    if (!file) return;
    try {
      const res = await api.imageSetCustom(game.id, kind, file);
      update(game.id, { images: { ...game.images, [kind]: res.path } });
    } catch (e) {
      toast({ kind: "error", title: errorText(e) });
    }
  };
  return (
    <div className="group relative overflow-hidden rounded-lg bg-surface-2 ring-1 ring-line" style={{ aspectRatio: kind === "cover" ? "2/3" : kind === "hero" ? "16/9" : "1/1" }}>
      {path ? <img src={imgSrc(path)} alt="" className="h-full w-full object-contain" /> : <div className="grid h-full place-items-center text-[11px] text-faint">{t(`network.regions.unmeasured`)}</div>}
      <div className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-black/60 p-1.5 opacity-0 transition group-hover:opacity-100">
        <button type="button" onClick={() => void pick()} className="grid h-7 w-7 place-items-center rounded-md bg-white/15 text-white hover:bg-white/30" title={t("game.customImage")}>
          <Upload className="h-3.5 w-3.5" />
        </button>
        {path && (
          <button type="button" onClick={() => update(game.id, { images: { ...game.images, [kind]: undefined } })} className="grid h-7 w-7 place-items-center rounded-md bg-white/15 text-white hover:bg-danger" title={t("common.remove")}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="absolute top-1.5 left-1.5 rounded bg-black/50 px-1.5 text-[10px] font-semibold text-white uppercase">{kind}</div>
    </div>
  );
}

function SettingsTab({ game }: { game: Game }) {
  const t = useT();
  const update = useLibrary((s) => s.updateGame);
  const launch = game.launch;
  const setLaunch = (patch: Partial<Game["launch"]>) => update(game.id, { launch: { ...launch, ...patch } });
  return (
    <div className="grid grid-cols-[1fr_320px] gap-5">
      <Section title={t("game.tabs.settings")}>
        <Field label={t("game.name")}>
          <input value={game.name} onChange={(e) => update(game.id, { name: e.target.value })} className="input w-72" />
        </Field>
        <Field label={t("game.kind")}>
          <Segmented value={game.kind} onChange={(v) => update(game.id, { kind: v })} options={[{ value: "game", label: t("common.game") }, { value: "app", label: t("common.app") }]} />
        </Field>
        <Field label={t("game.launchType")}>
          <Select value={launch.type} onChange={(v: LaunchType) => setLaunch({ type: v })} options={(["exe", "url", "shell"] as LaunchType[]).map((v) => ({ value: v, label: t(`game.launchTypes.${v}`) }))} className="w-60" align="right" />
        </Field>
        <Field label={t("game.target")} stacked>
          <div className="flex gap-2">
            <input value={launch.target} onChange={(e) => setLaunch({ target: e.target.value })} className="input flex-1" spellCheck={false} />
            {launch.type !== "url" && (
              <Button variant="secondary" onClick={async () => {
                const f = await pickFile({ filters: EXE_FILTERS });
                if (f) setLaunch({ target: f });
              }}>
                {t("common.browse")}
              </Button>
            )}
          </div>
        </Field>
        {launch.type === "exe" && (
          <>
            <Field label={t("game.args")} description={t("game.argsHint")}>
              <input value={launch.args ?? ""} onChange={(e) => setLaunch({ args: e.target.value })} className="input w-72" spellCheck={false} />
            </Field>
            <Field label={t("game.workingDir")}>
              <div className="flex gap-2">
                <input value={launch.workingDir ?? ""} onChange={(e) => setLaunch({ workingDir: e.target.value })} className="input w-56" spellCheck={false} />
                <Button variant="secondary" size="sm" onClick={async () => {
                  const d = await pickFolder();
                  if (d) setLaunch({ workingDir: d });
                }}>
                  …
                </Button>
              </div>
            </Field>
          </>
        )}
        {launch.type !== "url" && (
          <Field label={t("game.runAsAdmin")} description={t("game.runAsAdminDesc")}>
            <Toggle checked={!!launch.runAsAdmin} onChange={(v) => setLaunch({ runAsAdmin: v })} />
          </Field>
        )}
        <Field label={t("game.processNames")} description={t("game.processNamesDesc")}>
          <input value={(game.processNames ?? []).join(", ")} onChange={(e) => update(game.id, { processNames: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} className="input w-72" spellCheck={false} placeholder="game.exe, launcher.exe" />
        </Field>
      </Section>
      <Section
        title={t("game.images")}
        actions={
          <Button size="sm" variant="secondary" icon={<ImageDown className="h-3.5 w-3.5" />} onClick={async () => {
            const n = await useLibrary.getState().fetchImages([game], { force: true });
            toast({ kind: n ? "success" : "info", title: t("game.imagesLoaded") });
          }}>
            {t("game.autoImages")}
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3 py-4">
          <ImageSlot game={game} kind="cover" />
          <div className="flex flex-col gap-3">
            <ImageSlot game={game} kind="hero" />
            <div className="grid grid-cols-2 gap-3">
              <ImageSlot game={game} kind="logo" />
              <ImageSlot game={game} kind="icon" />
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

/** Spiel-Seite: Hintergrund aus dem Cover, Kennzahlen, Reiter */
export function GameDetail({ id, section }: { id: string; section?: string }) {
  const t = useT();
  const game = useLibrary((s) => s.games.find((g) => g.id === id));
  const stats = useLibrary((s) => s.stats.get(id));
  const running = useLibrary((s) => s.running.get(id));
  const launching = useLibrary((s) => s.launching.has(id));
  const update = useLibrary((s) => s.updateGame);
  const lastReport = useBoost((s) => s.reports.find((r) => r.gameId === id));
  const now = useNow(1000, !!running);
  const [tab, setTab] = useState<Tab>((section as Tab) || "overview");

  useEffect(() => {
    useUI.getState().setFocusGame(id);
    return () => useUI.getState().setFocusGame(null);
  }, [id]);

  if (!game) return <EmptyState icon={<Square className="h-7 w-7" />} title={t("game.notFound")} action={<Button variant="secondary" onClick={() => useUI.getState().navigate({ page: "games" })}>{t("common.back")}</Button>} />;

  const stop = async () => {
    if (await confirmDialog({ title: t("common.stop"), text: t("game.stopConfirm", { name: game.name }), danger: true, confirmLabel: t("common.stop") })) void useLibrary.getState().stop(game.id);
  };

  return (
    <div className="pb-24">
      <div className="relative h-[300px] overflow-hidden">
        <div className="absolute inset-0">
          <GameCover game={game} variant="hero" imgClassName="object-[50%_30%]" />
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--nv-bg)] via-[var(--nv-bg)]/40 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[var(--nv-bg)]/70 to-transparent" />
        </div>
        <div className="relative mx-auto flex h-full max-w-[1400px] items-end gap-6 px-8 pb-5">
          <motion.div className="h-[200px] w-[134px] shrink-0 overflow-hidden rounded-xl shadow-2xl ring-1 ring-white/10" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring.gravity}>
            <GameCover game={game} />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
              <span className="rounded-full bg-black/40 px-2.5 py-1 text-white/90 backdrop-blur">{game.kind === "app" ? t("common.app") : t(`source.${game.source}`)}</span>
              {game.serverGame && <span className="rounded-full bg-accent/20 px-2.5 py-1 text-accent">{t(`network.regions.games.${game.serverGame}`)}</span>}
              {lastReport && (
                <span className="rounded-full px-2.5 py-1" style={{ background: `color-mix(in oklab, ${gradeColor(lastReport.grade)} 25%, transparent)`, color: gradeColor(lastReport.grade) }}>
                  {t("grade.label")} {lastReport.grade}
                </span>
              )}
            </div>
            {game.images.logo ? <img src={imgSrc(game.images.logo)} alt={game.name} className="nv-logo mt-3 max-h-24 max-w-[420px] object-contain object-left" /> : <h1 className="mt-2 font-display text-4xl font-bold text-fg">{game.name}</h1>}
            <div className="mt-4 flex items-center gap-2">
              {running ? (
                <Button variant="danger-solid" size="lg" icon={<Square className="h-4 w-4" />} onClick={() => void stop()}>
                  {t("common.stop")} · {Math.floor((now - running.startedAt) / 1000 / 60)} min
                </Button>
              ) : (
                <>
                  <Button variant="primary" size="lg" icon={<Zap className="h-4 w-4" />} loading={launching} onClick={() => void useLibrary.getState().launch(game, { boost: game.kind === "game" })}>
                    {game.kind === "app" ? t("common.start") : t("games.boostAndPlay")}
                  </Button>
                  {game.kind === "game" && (
                    <Button variant="secondary" size="lg" icon={<Play className="h-4 w-4" />} onClick={() => void useLibrary.getState().launch(game, { boost: false })}>
                      {t("common.play")}
                    </Button>
                  )}
                </>
              )}
              <Button variant="glass" size="lg" onClick={() => update(game.id, { favorite: !game.favorite })} aria-label={t("game.favorite")} className={cn(game.favorite && "text-accent")}>
                <Heart className="h-4 w-4" fill={game.favorite ? "currentColor" : "none"} />
              </Button>
              <Button variant="glass" size="lg" onClick={(e) => useContextMenu.getState().open(e.clientX, e.clientY, gameMenuItems(game))} aria-label="Mehr">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1400px] px-8">
        <div className="grid grid-cols-5 gap-3">
          <Stat label={t("game.totalPlaytime")} value={stats ? formatDuration(stats.totalSeconds, { short: true }) : "0m"} />
          <Stat label={t("game.lastSession")} value={stats?.lastSessionSeconds ? formatDuration(stats.lastSessionSeconds, { short: true }) : "–"} />
          <Stat label={t("game.sessions")} value={String(stats?.sessions ?? 0)} />
          <Stat label={t("game.lastPlayed")} value={formatRelative(stats?.lastPlayedAt ?? undefined)} sub={stats?.firstPlayedAt ? t("game.firstPlayed", { date: formatDate(stats.firstPlayedAt) }) : t("game.added", { date: formatDate(game.addedAt) })} />
          <Stat label={t("reports.avgPing")} value={lastReport?.avgPing ? `${Math.round(lastReport.avgPing)} ms` : "–"} sub={lastReport ? lastReport.targetLabel : undefined} />
        </div>
        <Tabs value={tab} onChange={setTab} className="mt-6 mb-5" tabs={(["overview", "reports", "settings"] as Tab[]).map((v) => ({ value: v, label: t(`game.tabs.${v}`) }))} />
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
            {tab === "overview" && <Overview game={game} />}
            {tab === "reports" && <Reports game={game} />}
            {tab === "settings" && <SettingsTab game={game} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
