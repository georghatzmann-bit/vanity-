import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, EyeOff, FolderSearch, Heart, LayoutGrid, List, Plus, Search, SearchX, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { allTags, filterGames, sortGames } from "@/lib/search";
import type { Game, PlayStatus, SortKey } from "@/lib/types";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { GameGrid } from "@/components/GameGrid";
import { Chip } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Button } from "@shared/ui/Button";
import { sound } from "@shared/sound/engine";

export function Library() {
  const t = useT();
  const games = useLibrary((s) => s.games);
  const stats = useLibrary((s) => s.stats);
  const f = useUI((s) => s.libraryFilter);
  const setFilter = useUI((s) => s.setFilter);
  const resetFilter = useUI((s) => s.resetFilter);
  const { librarySort, librarySortDesc, libraryView, cardSize } = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(f.query);

  // Suche leicht verzögert anwenden (flüssiges Tippen auch bei großen Bibliotheken)
  useEffect(() => {
    const id = window.setTimeout(() => setFilter({ query }), 90);
    return () => window.clearTimeout(id);
  }, [query, setFilter]);

  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener("nova:focus-search", focus);
    return () => window.removeEventListener("nova:focus-search", focus);
  }, []);

  const tags = useMemo(() => allTags(games).slice(0, 10), [games]);
  const list: Game[] = useMemo(() => sortGames(filterGames(games, f), librarySort, librarySortDesc, stats, f.query), [games, f, librarySort, librarySortDesc, stats]);
  const hiddenCount = games.filter((g) => g.hidden).length;
  const filtersActive = f.kind !== "all" || f.favoritesOnly || f.status !== "all" || f.source !== "all" || !!f.tag || !!f.query || f.showHidden;

  const statusOptions: { value: PlayStatus | "all"; label: string }[] = [
    { value: "all", label: `${t("library.filterStatus")}: ${t("common.all")}` },
    ...(["want", "playing", "paused", "done", "none"] as PlayStatus[]).map((s) => ({ value: s, label: t(`status.${s}`) })),
  ];
  const sourceOptions: { value: Game["source"] | "all"; label: string }[] = [
    { value: "all", label: `${t("library.filterSource")}: ${t("common.all")}` },
    ...(["steam", "epic", "gog", "startmenu", "folder", "manual"] as const).map((s) => ({ value: s, label: t(`source.${s}`) })),
  ];

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1600px] px-8 pt-4 pb-28">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-bold text-fg">{t("library.title")}</h1>
            <p className="mt-1 text-sm text-muted">{t("library.count", { n: list.length })}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => useUI.getState().setManual(true)}>
              {t("library.addManual")}
            </Button>
            <Button variant="primary" icon={<FolderSearch className="h-4 w-4" />} onClick={() => useUI.getState().setScan(true)}>
              {t("library.scan")}
            </Button>
          </div>
        </div>

        {/* Suche + Werkzeuge */}
        <div className="sticky top-0 z-20 -mx-8 mt-6 px-8 pt-2 pb-4" style={{ background: "linear-gradient(to bottom, color-mix(in oklab, var(--nv-bg) 82%, transparent) 70%, transparent)" }}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[280px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                placeholder={t("library.searchPlaceholder")}
                className="input h-11 rounded-full pr-10 pl-11 text-[14px]"
                spellCheck={false}
              />
              <AnimatePresence>
                {query && (
                  <motion.button initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} type="button" onClick={() => setQuery("")} className="absolute top-1/2 right-3 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full bg-surface-3 text-muted hover:text-fg" aria-label="Suche leeren">
                    <X className="h-3.5 w-3.5" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
            <Select<SortKey>
              value={librarySort}
              onChange={(v) => update({ librarySort: v })}
              className="w-52"
              options={(["lastPlayed", "name", "playtime", "rating", "added"] as SortKey[]).map((k) => ({ value: k, label: `${t("library.sortBy")}: ${t(`sort.${k}`)}` }))}
            />
            <button
              type="button"
              onClick={() => {
                sound.play("click");
                update({ librarySortDesc: !librarySortDesc });
              }}
              className="grid h-10 w-10 place-items-center rounded-md border border-line bg-surface-2 text-muted transition hover:text-fg"
              title={librarySortDesc ? "absteigend" : "aufsteigend"}
            >
              {librarySortDesc ? <ArrowDownWideNarrow className="h-4 w-4" /> : <ArrowUpNarrowWide className="h-4 w-4" />}
            </button>
            <Segmented
              value={libraryView}
              onChange={(v) => update({ libraryView: v })}
              options={[
                { value: "grid", label: "", icon: <LayoutGrid className="h-4 w-4" /> },
                { value: "list", label: "", icon: <List className="h-4 w-4" /> },
              ]}
            />
            {libraryView === "grid" && (
              <input
                type="range"
                min={140}
                max={260}
                step={4}
                value={cardSize}
                onChange={(e) => update({ cardSize: Number(e.target.value) })}
                className="range w-28"
                style={{ ["--fill" as string]: `${((cardSize - 140) / 120) * 100}%` }}
                title={t("library.cardSize")}
                aria-label={t("library.cardSize")}
              />
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              value={f.kind}
              onChange={(v) => setFilter({ kind: v })}
              options={[
                { value: "all", label: t("library.filterAll") },
                { value: "game", label: t("library.filterGames") },
                { value: "app", label: t("library.filterApps") },
              ]}
            />
            <Chip active={f.favoritesOnly} onClick={() => setFilter({ favoritesOnly: !f.favoritesOnly })}>
              <Heart className="h-3.5 w-3.5" fill={f.favoritesOnly ? "currentColor" : "none"} /> {t("library.filterFavorites")}
            </Chip>
            <Select value={f.status} onChange={(v) => setFilter({ status: v })} options={statusOptions} className="w-48" />
            <Select value={f.source} onChange={(v) => setFilter({ source: v })} options={sourceOptions} className="w-44" />
            {tags.map((tag) => (
              <Chip key={tag} active={f.tag === tag} onClick={() => setFilter({ tag: f.tag === tag ? null : tag })}>
                #{tag}
              </Chip>
            ))}
            {hiddenCount > 0 && (
              <Chip active={f.showHidden} onClick={() => setFilter({ showHidden: !f.showHidden })}>
                <EyeOff className="h-3.5 w-3.5" /> {t("library.showHidden")} ({hiddenCount})
              </Chip>
            )}
            {filtersActive && (
              <button type="button" onClick={() => (resetFilter(), setQuery(""))} className="ml-1 text-[13px] font-medium text-accent hover:underline">
                {t("library.clearFilters")}
              </button>
            )}
          </div>
        </div>

        {list.length === 0 ? (
          games.length === 0 ? (
            <EmptyState
              icon={<FolderSearch className="h-7 w-7" />}
              title={t("home.emptyTitle")}
              text={t("home.emptyText")}
              action={
                <Button variant="primary" icon={<FolderSearch className="h-4 w-4" />} onClick={() => useUI.getState().setScan(true)}>
                  {t("home.emptyScan")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<SearchX className="h-7 w-7" />}
              title={t("library.noResults")}
              text={t("library.noResultsText")}
              action={
                <Button variant="secondary" onClick={() => (resetFilter(), setQuery(""))}>
                  {t("library.clearFilters")}
                </Button>
              }
            />
          )
        ) : (
          <div className="pt-2">
            <GameGrid games={list} cardWidth={cardSize} view={libraryView} scrollRef={scrollRef} />
          </div>
        )}
      </div>
    </div>
  );
}
