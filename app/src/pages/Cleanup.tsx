import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { CheckCircle2, Copy, ImageOff, Loader2, RefreshCw, Trash2, Unlink, Wand2 } from "lucide-react";
import { api } from "@/lib/api";
import { findDuplicateGroups } from "@/lib/dedupe";
import { formatDuration } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { confirmDialog, toast, useUI } from "@/store/ui";
import { GameCover } from "@/components/GameCover";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@shared/ui/Button";
import { AnimatedCheck } from "@shared/ui/AnimatedCheck";
import { staggerContainer, staggerItem } from "@shared/design/motion";

function GameLine({ game, children }: { game: Game; children?: React.ReactNode }) {
  const stats = useLibrary((s) => s.stats.get(game.id));
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
      <div className="h-12 w-8 shrink-0 overflow-hidden rounded-md">
        <GameCover game={game} />
      </div>
      <button type="button" onClick={() => useUI.getState().navigate({ page: "game", id: game.id })} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-medium text-fg">{game.name}</div>
        <div className="truncate text-[11px] text-faint">{game.exePath ?? game.launch.target}</div>
      </button>
      <span className="text-[12px] text-muted tabular">{stats ? formatDuration(stats.totalSeconds, { short: true }) : "–"}</span>
      {children}
    </div>
  );
}

function Group({ title, desc, icon, children, action }: { title: string; desc: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <motion.section variants={staggerItem} className="glass rounded-xl p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="flex gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-2 text-accent">{icon}</span>
          <div>
            <h2 className="font-semibold text-fg">{title}</h2>
            <p className="text-[13px] text-muted">{desc}</p>
          </div>
        </div>
        {action}
      </div>
      <div className="flex max-h-[420px] flex-col overflow-y-auto">{children}</div>
    </motion.section>
  );
}

export function Cleanup() {
  const t = useT();
  const games = useLibrary((s) => s.games);
  const [broken, setBroken] = useState<Game[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setBroken(null);
    const checkable = games.filter((g) => g.launch.type !== "url" && (g.exePath || g.launch.target));
    const paths = checkable.map((g) => g.exePath || g.launch.target);
    api
      .pathsExist(paths)
      .then((ok) => setBroken(checkable.filter((_, i) => ok[i] === false)))
      .catch(() => setBroken([]));
  }, [games.length, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const dups = useMemo(() => findDuplicateGroups(games), [games]);
  const noCover = useMemo(() => games.filter((g) => g.kind === "game" && !g.images.cover), [games]);
  const allGood = broken !== null && broken.length === 0 && dups.length === 0 && noCover.length === 0;

  const remove = async (ids: string[]) => {
    await useLibrary.getState().removeGames(ids);
    toast({ kind: "success", title: t("game.removed", { name: `${ids.length}` }) });
  };

  return (
    <div className="mx-auto max-w-[1200px] px-8 pt-4 pb-28">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("cleanup.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("cleanup.subtitle")}</p>
        </div>
        <Button variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setTick((x) => x + 1)}>
          {t("cleanup.scan")}
        </Button>
      </div>

      {broken === null ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-muted">
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
          {t("cleanup.checking")}
        </div>
      ) : allGood ? (
        <div className="mt-10 flex flex-col items-center text-center">
          <AnimatedCheck size={96} />
          <h2 className="mt-6 font-display text-2xl font-bold text-fg">{t("cleanup.allGood")}</h2>
          <p className="mt-2 text-sm text-muted">{t("cleanup.allGoodText")}</p>
        </div>
      ) : (
        <motion.div variants={staggerContainer(0.08, 0.05)} initial="initial" animate="enter" className="mt-8 flex flex-col gap-5">
          {broken.length > 0 && (
            <Group
              title={`${t("cleanup.broken")} (${broken.length})`}
              desc={t("cleanup.brokenDesc")}
              icon={<Unlink className="h-5 w-5" />}
              action={
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={async () => (await confirmDialog({ title: t("cleanup.removeAll"), text: `${broken.length} × ${t("common.remove")}?`, danger: true, confirmLabel: t("cleanup.removeAll") })) && void remove(broken.map((g) => g.id))}
                >
                  {t("cleanup.removeAll")}
                </Button>
              }
            >
              {broken.map((g) => (
                <GameLine key={g.id} game={g}>
                  <button type="button" onClick={() => void remove([g.id])} className="text-faint hover:text-danger" aria-label={t("common.remove")}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </GameLine>
              ))}
            </Group>
          )}
          {dups.length > 0 && (
            <Group title={`${t("cleanup.duplicates")} (${dups.length})`} desc={t("cleanup.duplicatesDesc")} icon={<Copy className="h-5 w-5" />}>
              {dups.map((grp, gi) => (
                <div key={gi} className="mb-3 rounded-lg border border-line p-1">
                  {grp.map((g) => (
                    <GameLine key={g.id} game={g}>
                      <Button
                        size="sm"
                        variant="secondary"
                        title={t("cleanup.keepThisHint")}
                        onClick={async () => {
                          await useLibrary.getState().mergeGames(g.id, grp.filter((x) => x.id !== g.id).map((x) => x.id));
                          toast({ kind: "success", title: t("cleanup.merged"), text: t("cleanup.mergedText") });
                        }}
                      >
                        {t("cleanup.keepThis")}
                      </Button>
                    </GameLine>
                  ))}
                </div>
              ))}
            </Group>
          )}
          {noCover.length > 0 && (
            <Group
              title={`${t("cleanup.noCover")} (${noCover.length})`}
              desc={t("cleanup.noCoverDesc")}
              icon={<ImageOff className="h-5 w-5" />}
              action={
                <Button
                  size="sm"
                  variant="primary"
                  loading={fetching}
                  icon={<Wand2 className="h-4 w-4" />}
                  onClick={async () => {
                    setFetching(true);
                    const n = await useLibrary.getState().fetchImages(noCover, { quiet: true });
                    setFetching(false);
                    toast({ kind: n ? "success" : "info", title: `${n} / ${noCover.length}`, text: n ? t("game.imagesLoaded") : t("game.noApiKey") });
                  }}
                >
                  {t("cleanup.fetchAll")}
                </Button>
              }
            >
              {noCover.slice(0, 60).map((g) => (
                <GameLine key={g.id} game={g} />
              ))}
            </Group>
          )}
          {broken.length === 0 && dups.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" /> {t("cleanup.allGoodText")}
            </div>
          )}
        </motion.div>
      )}
      {games.length === 0 && <EmptyState icon={<Wand2 className="h-7 w-7" />} title={t("cleanup.allGood")} />}
    </div>
  );
}
