import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, EyeOff, FolderSearch, Heart, LayoutGrid, List, Plus, Search, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { filterGames, sortGames, type LibraryFilter, type SortKey } from "@/lib/search";
import type { Game } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useUI } from "@/store/ui";
import { GameGrid } from "@/components/GameGrid";
import { EmptyState } from "@/components/ui/EmptyState";
import { Chip } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Button } from "@shared/ui/Button";
import { sound } from "@shared/sound/engine";

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`pulsar-games-${key}`);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(`pulsar-games-${key}`, JSON.stringify(v));
  } catch {
    /* egal */
  }
}

/** Spieleliste: Suche, Filter, Sortierung, Kacheln oder Liste (virtualisiert) */
export function Games() {
  const t = useT();
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const f = useUI((s) => s.libraryFilter);
  const setFilter = useUI((s) => s.setFilter);
  const resetFilter = useUI((s) => s.resetFilter);
  const [sort, setSort] = useState<SortKey>(() => readPref("sort", "lastPlayed"));
  const [desc, setDesc] = useState(() => readPref("desc", true));
  const [view, setView] = useState<"grid" | "list">(() => readPref("view", "grid"));
  const [cardSize, setCardSize] = useState(() => readPref("card", 188));
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener("pulsar:focus-search", focus);
    return () => window.removeEventListener("pulsar:focus-search", focus);
  }, []);

  const list: Game[] = useMemo(() => sortGames(filterGames(games, f), sort, desc, stats, f.query), [games, f, sort, desc, stats]);
  const hiddenCount = games.filter((g) => g.hidden).length;
  const filtersActive = f.kind !== "all" || f.favoritesOnly || f.source !== "all" || f.showHidden || !!f.query;
  const sourceOptions: { value: LibraryFilter["source"]; label: string }[] = [{ value: "all", label: t("games.filterAll") }, ...(["steam", "epic", "gog", "startmenu", "folder", "manual"] as const).map((s) => ({ value: s, label: t(`source.${s}`) }))];

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-8 pt-3 pb-24">
      <div className="mx-auto max-w-[1400px]">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold text-fg">{t("games.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("games.count", { n: list.length })}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => useUI.getState().setManual(true)}>
              {t("games.add")}
            </Button>
            <Button variant="primary" icon={<FolderSearch className="h-4 w-4" />} onClick={() => useUI.getState().setScan(true)}>
              {t("games.scan")}
            </Button>
          </div>
        </div>

        <div className="glass sticky top-0 z-10 mt-4 rounded-xl p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted" />
              <input ref={searchRef} value={f.query} onChange={(e) => setFilter({ query: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setFilter({ query: "" })} placeholder={t("games.searchPlaceholder")} className="input h-10 w-full pl-10" />
              <AnimatePresence>
                {f.query && (
                  <motion.button initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} type="button" onClick={() => setFilter({ query: "" })} className="absolute top-1/2 right-3 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full bg-surface-3 text-muted hover:text-fg" aria-label="Suche leeren">
                    <X className="h-3.5 w-3.5" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
            <Select value={sort} onChange={(v) => (setSort(v), writePref("sort", v))} className="w-52" options={(["lastPlayed", "name", "playtime", "added"] as SortKey[]).map((k) => ({ value: k, label: `${t("games.sortBy")}: ${t(`games.sort.${k}`)}` }))} />
            <button type="button" onClick={() => (sound.play("click"), setDesc(!desc), writePref("desc", !desc))} className="grid h-10 w-10 place-items-center rounded-md border border-line bg-surface-2 text-muted transition hover:text-fg" title={desc ? "absteigend" : "aufsteigend"}>
              {desc ? <ArrowDownWideNarrow className="h-4 w-4" /> : <ArrowUpNarrowWide className="h-4 w-4" />}
            </button>
            <Segmented value={view} onChange={(v) => (setView(v), writePref("view", v))} options={[{ value: "grid", label: "", icon: <LayoutGrid className="h-4 w-4" /> }, { value: "list", label: "", icon: <List className="h-4 w-4" /> }]} />
            {view === "grid" && <input type="range" min={140} max={260} step={4} value={cardSize} onChange={(e) => (setCardSize(Number(e.target.value)), writePref("card", Number(e.target.value)))} className="range w-28" style={{ ["--fill" as string]: `${((cardSize - 140) / 120) * 100}%` }} title={t("games.cardSize")} aria-label={t("games.cardSize")} />}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Segmented size="sm" value={f.kind} onChange={(v) => setFilter({ kind: v })} options={[{ value: "all", label: t("games.filterAll") }, { value: "game", label: t("games.filterGames") }, { value: "app", label: t("games.filterApps") }]} />
            <Chip active={f.favoritesOnly} onClick={() => setFilter({ favoritesOnly: !f.favoritesOnly })}>
              <Heart className="h-3.5 w-3.5" fill={f.favoritesOnly ? "currentColor" : "none"} /> {t("games.filterFavorites")}
            </Chip>
            <Select<LibraryFilter["source"]> value={f.source} onChange={(v) => setFilter({ source: v })} options={sourceOptions} className="w-44" />
            {hiddenCount > 0 && (
              <Chip active={f.showHidden} onClick={() => setFilter({ showHidden: !f.showHidden })}>
                <EyeOff className="h-3.5 w-3.5" /> {t("games.showHidden")} ({hiddenCount})
              </Chip>
            )}
            {filtersActive && (
              <button type="button" onClick={() => resetFilter()} className="ml-1 text-[13px] font-medium text-accent hover:underline">
                {t("games.clearFilters")}
              </button>
            )}
          </div>
        </div>

        {list.length === 0 ? (
          games.length === 0 ? (
            <EmptyState icon={<FolderSearch className="h-7 w-7" />} title={t("games.empty")} text={t("games.emptyText")} action={<Button variant="primary" onClick={() => useUI.getState().setScan(true)}>{t("games.fillLibrary")}</Button>} />
          ) : (
            <EmptyState icon={<Search className="h-7 w-7" />} title={t("games.nothingFound")} action={<Button variant="secondary" onClick={() => resetFilter()}>{t("games.clearFilters")}</Button>} />
          )
        ) : (
          <div className="mt-6">
            <GameGrid games={list} cardWidth={cardSize} view={view} scrollRef={scrollRef} />
          </div>
        )}
      </div>
    </div>
  );
}
